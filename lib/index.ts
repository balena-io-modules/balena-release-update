import * as sdk from 'balena-sdk';

export enum UpdateStatus {
	pending,
	preparing,
	ready,
}

export type UpdateStatusDescription = keyof typeof UpdateStatus;

const statusNameByIndex: UpdateStatusDescription[] = [
	'pending',
	'preparing',
	'ready',
];

const statusIndexByName = {
	pending: 0,
	preparing: 1,
	ready: 2,
};

export interface ReleaseUpdate {
	originates_from__release: {
		id: number;
		commit: string;
	};

	produces__release: {
		id: number;
		commit: string;
	};

	is_produced_by__service_update: ServiceUpdate[];

	overall_status: UpdateStatusDescription;

	// only set when `overall_status is 'ready'`
	estimated_total_payload_size?: number;
}

export interface ServiceUpdate {
	service_name: string;

	status: UpdateStatusDescription;

	// `undefined` if this service is new in the target release
	originates_from__image?: {
		id: number;
		is_stored_at__image_location: string;
		content_hash: string;
		image_size: number;
	};

	produces__image: {
		id: number;
		is_stored_at__image_location: string;
		content_hash: string;
		image_size: number;

		// `undefined` if no delta exists between the two images
		is_produced_by__delta?: {
			id: number;
			version: number; // 2 or 3
			is_stored_at__location: string;
			size: number;
		};
	};
}

export interface GetUpdateInfoOptions {
	/**
	 * Can be used to pass an existing SDK instance
	 */
	client?: sdk.BalenaSDK;
}

/**
 * - describes the update path from release A to B.
 * - only meaningful for devices with balenaOS >= 2.47.1 because it assumes deltas v3
 *
 * @param fromReleaseId
 * @param toReleaseId
 * @param options An optional bag of configuration options. See `GetUpdateInfoOptions`
 *                for help on individual attributes.
 */
export async function getUpdateInfo(
	fromRelease: number | string,
	toRelease: number | string,
	options?: GetUpdateInfoOptions,
): Promise<ReleaseUpdate> {
	const client = options?.client || sdk.fromSharedOptions();
	const [sourceRelease, targetRelease] = await Promise.all([
		client.models.release.getWithImageDetails(fromRelease, {
			release: { $filter: { status: 'success' } },
		}),
		client.models.release.getWithImageDetails(toRelease, {
			release: { $filter: { status: 'success' } },
		}),
	]);

	// sdk types seem to be somewhat wonky
	const app1 = sourceRelease.belongs_to__application as any;
	const app2 = targetRelease.belongs_to__application as any;
	if (app1.__id !== app2.__id) {
		throw new Error(
			'Source and target release must be from the same application',
		);
	}

	const serviceUpdates = await resolveServiceUpdates(
		client,
		sourceRelease,
		targetRelease,
	);

	const status =
		statusNameByIndex[
			serviceUpdates
				.map((s) => statusIndexByName[s.status])
				.reduce(
					(minStatus, serviceStatus) => Math.min(minStatus, serviceStatus),
					2,
				)
		];

	const size =
		status !== 'ready'
			? undefined
			: serviceUpdates.reduce(
					(total, su) =>
						su.produces__image.is_produced_by__delta != null
							? total + su.produces__image.is_produced_by__delta.size
							: total + su.produces__image.image_size,
					0,
			  );

	return {
		originates_from__release: {
			id: sourceRelease.id,
			commit: sourceRelease.commit,
		},

		produces__release: {
			id: targetRelease.id,
			commit: targetRelease.commit,
		},

		is_produced_by__service_update: serviceUpdates,

		overall_status: status,

		estimated_total_payload_size: size,
	};
}

export interface PrepareUpdateOptions extends GetUpdateInfoOptions {
	/**
	 * Whether to wait for the update to become ready.
	 * Otherwise returns the current state of the update.
	 *
	 * Default is `false`.
	 */
	wait?: boolean;

	/**
	 * The maximum time in seconds to wait for the update to
	 * become ready, if the `wait` option was set to `true`.
	 *
	 * Be generous, updates take some time to get prepared.
	 * Timeouts less than about 20-30 seconds are pointless
	 * because the poll interval is around 20 seconds and the
	 * query itself takes a few seconds on its own, so within
	 * 30 seconds it'll probably only poll once.
	 *
	 * Default is no timeout. If set, implies `wait: true`.
	 */
	timeout?: number;
}

export async function prepareUpdate(
	fromRelease: number | string,
	toRelease: number | string,
	options?: PrepareUpdateOptions,
): Promise<ReleaseUpdate> {
	const client = options?.client || sdk.fromSharedOptions();
	options = { ...options, client };

	const waitUntil =
		options.timeout == null ? undefined : Date.now() + options.timeout * 1000;
	const shouldWait =
		options.wait === true || (options.wait !== false && waitUntil != null);

	const update = await getUpdateInfo(fromRelease, toRelease, options);
	if (update.overall_status === 'ready') {
		return update;
	}

	debug('Preparing update...');

	// request deltas for pending service updates
	await Promise.all(
		update.is_produced_by__service_update.map(async (su) => {
			if (su.status === 'pending' && su.originates_from__image != null) {
				debug(
					`Triggering delta between images ${su.originates_from__image.id} and ${su.produces__image.id}`,
				);
				await requestImageDelta(
					client,
					3,
					su.originates_from__image.id,
					su.produces__image.id,
				);
			}
		}),
	);

	if (!shouldWait) {
		return update;
	}

	debug('Waiting for update to become ready...');
	return await waitForReadiness(
		client,
		update.originates_from__release.id,
		update.produces__release.id,
		waitUntil,
	);
}

// - Internal stuff

async function waitForReadiness(
	client: sdk.BalenaSDK,
	fromReleaseId: number,
	toReleaseId: number,
	untilDate?: number,
): Promise<ReleaseUpdate> {
	if (untilDate == null) {
		// if no timeout is set, set one way out in the future (24 hours)
		// so we don't have to do if/else.
		untilDate = Date.now() + 1000 * 60 * 60 * 24;
	}
	return await withTimeout(
		untilDate - Date.now(),
		pollForReadiness(client, fromReleaseId, toReleaseId),
	);
}

async function pollForReadiness(
	client: sdk.BalenaSDK,
	fromReleaseId: number,
	toReleaseId: number,
): Promise<ReleaseUpdate> {
	do {
		await delay(1000 * 20); // wait 20 seconds between polls

		const update = await getUpdateInfo(fromReleaseId, toReleaseId, { client });
		if (update.overall_status === 'ready') {
			return update;
		}
		debug('The update is not ready yet; will repoll in 20 seconds...');
	} while (true);
}

interface Delta {
	id: number;
	status: string;

	// only access these if `status is 'success'`.
	// they're otherwise undefined.
	version: number;
	is_stored_at__location: string;
	size: number;

	// these are only declared in order to satisfy the sdk types when querying.
	// they're always undefined.
	originates_from__image?: sdk.OptionalNavigationResource<sdk.Image>;
	produces__image?: sdk.NavigationResource<sdk.Image>;
	update_timestamp?: Date;
}

function toNumber(s: string | number): number {
	return parseInt((s || 0).toString(), 10);
}

async function resolveServiceUpdates(
	client: sdk.BalenaSDK,
	sourceRelease: sdk.ReleaseWithImageDetails,
	targetRelease: sdk.ReleaseWithImageDetails,
): Promise<ServiceUpdate[]> {
	const sourceImagesByServiceName = Object.fromEntries(
		sourceRelease.images.map(({ service_name, id }) => [service_name, id]),
	);
	const targetImagesByServiceName = Object.fromEntries(
		targetRelease.images.map(({ service_name, id }) => [service_name, id]),
	);

	return Promise.all(
		Object.keys(targetImagesByServiceName).map(async (serviceName) => {
			const sourceImageId = sourceImagesByServiceName[serviceName];
			const targetImageId = targetImagesByServiceName[serviceName];

			const [sourceImage, targetImage, deltaImage] = await Promise.all([
				sourceImageId == null
					? undefined
					: await getImage(client, sourceImageId),
				await getImage(client, targetImageId),
				await getImageDelta(client, 3, sourceImageId, targetImageId),
			]);

			let delta = deltaImage;
			let status: UpdateStatusDescription;
			if (sourceImage == null) {
				status = 'ready'; // we'll never produce a delta from scratch
			} else {
				switch (delta?.status) {
					case 'success':
						status = 'ready';
						break;
					case 'running':
						status = 'preparing';
						delta = undefined;
						break;
					default:
						status = 'pending';
						break;
				}
			}

			return {
				service_name: serviceName,

				status,

				originates_from__image: sourceImage && {
					id: sourceImage.id,
					is_stored_at__image_location:
						sourceImage.is_stored_at__image_location,
					// successfully built images are guaranteed to have a content hash and size
					content_hash: sourceImage.content_hash!,
					image_size: toNumber(sourceImage.image_size || 0),
				},

				produces__image: {
					id: targetImage.id,
					is_stored_at__image_location:
						targetImage.is_stored_at__image_location,
					content_hash: targetImage.content_hash!,
					image_size: toNumber(targetImage.image_size || 0),

					is_produced_by__delta: delta && {
						id: delta.id,
						version: delta.version,
						is_stored_at__location: delta.is_stored_at__location,
						size: toNumber(delta.size),
					},
				},
			};
		}),
	);
}

async function getImage(client: sdk.BalenaSDK, id: number): Promise<sdk.Image> {
	return client.models.image.get(id, {
		$select: [
			'id',
			'is_stored_at__image_location',
			'content_hash',
			'image_size',
		],
		$filter: { status: 'success' },
	});
}

async function getImageDelta(
	client: sdk.BalenaSDK,
	version: number,
	src: number | undefined,
	dest: number,
): Promise<Delta | undefined> {
	if (src == null) {
		return undefined; // we do not generate deltas "from scratch"
	}
	// look for a successful or a running delta. at any given time, there
	// can be at most one of each, and only one or the other
	const [delta] = await client.pine.get<Delta>({
		resource: 'delta',
		options: {
			$top: 1, // see above why that works
			$orderby: 'id desc',
			$select: ['id', 'status', 'version', 'is_stored_at__location', 'size'],
			$filter: {
				version,
				originates_from__image: src,
				produces__image: dest,
				$or: [
					{ status: 'success' },
					{
						status: 'running',
						update_timestamp: {
							// deltas are considered stale after 5 minutes without an update,
							// but the server makes sure to keep the row updated far more
							// frequently.
							//
							// there may be clock skew however between the host this script
							// runs on and the server, so try to be somewhat conservative and
							// allow for a few minutes of skew forwards or backwards.
							$gt: new Date(Date.now() - 1000 * 60 * 3), // 3 minutes
						},
					},
				],
			},
		},
	});
	return delta;
}

async function requestImageDelta(
	client: sdk.BalenaSDK,
	version: number,
	src: number,
	dest: number,
): Promise<boolean> {
	const endpoint = await client.settings.get('deltaUrl');
	const qs = `src=${src}&dest=${dest}`;
	const path = `/api/v${version}/delta?${qs}`;

	try {
		const res = await client.request.send({
			url: path,
			baseUrl: endpoint,
			sendToken: true,
		});
		// v3 deltas respond with 200 and the delta image name in the body,
		// v2 respond with a redirect to S3
		return res.statusCode === 200 || res.statusCode === 302;
	} catch (err) {
		if (err.statusCode === 504) {
			// the delta is being computed
			return false;
		}
		throw err;
	}
}

function debug(...data: any[]) {
	console.error('[DEBUG]', ...data);
}

async function delay(timeoutMs: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

async function withTimeout<T>(
	timeoutMs: number,
	perform: Promise<T>,
): Promise<T> {
	return new Promise((resolve, reject) => {
		const handle = setTimeout(() => reject(new Error('timeout')), timeoutMs);
		perform.then((res) => {
			clearTimeout(handle);
			resolve(res);
		});
	});
}
