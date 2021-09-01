#!/usr/bin/env node

'use strict';

const packageManifest = require('../package.json');

const { getUpdateInfo, prepareUpdate } = require('../build/index');

const HELP = `
Usage: balena-release-update [options]

Options:

  --from-release   The source release ID or commit hash (required).
  --to-release     The target release ID or commit hash (required).

  --prepare     Trigger any pending image deltas between service images.
  --wait        Wait until the update is ready. Implies --prepare.
  --timeout N   The maximum time in seconds to wait. Implies --wait.

  --help, -h    Show this help text and exit.
  --version, -v Show program version and exit.

Example:

  $ balena-release-update --wait --from-release 900813 --to-release 900835
  {
    "originates_from__release": {
      "id": 900813,
      "commit": "84d3d8f43eddd81b1699552dd39338f8dbf8b11e"
    },
    "produces__release": {
      "id": 900835,
      "commit": "b2cf2db7fece36f10e6a7e815ab169fd30cab05f"
    },
    "is_produced_by__service_update": [
      {
        "service_name": "main",
        "status": "ready",
        "originates_from__image": {
          "id": 1115249,
          "is_stored_at__image_location": "registry2.balena-cloud.com/v2/053f8c64320e2aedc83c8cfc63ff95fa",
          "content_hash": "sha256:bc4f975c19a46102ac022508b954919ce8c64c65a83b25c0202cdb216e72451f",
          "image_size": 310905195
        },
        "produces__image": {
          "id": 1115290,
          "is_stored_at__image_location": "registry2.balena-cloud.com/v2/1210859f1a5d4d29653ed1db80d8c9d6",
          "content_hash": "sha256:fd67e1fcf25ecaf3a192627c54334ce50fa144000acadfdfdac0c1c0ed63e895",
          "image_size": 310954877,
          "is_produced_by__delta": {
            "id": 1510997,
            "version": 3,
            "is_stored_at__location": "registry2.balena-cloud.com/v2/1210859f1a5d4d29653ed1db80d8c9d6:delta-3c90dce25a5f9f2f",
            "size": 484575
          }
        }
      }
    ],
    "overall_status": "ready",
    "estimated_total_payload_size": 484575
  }
`;

function parseNumber(arg) {
	const num = parseInt(arg, 10);
	if (num == null || isNaN(num)) {
		return null;
	}
	if (num.toString() !== arg) {
		return null;
	}
	return num;
}

function parseRelease(arg) {
	const rel = parseNumber(arg);
	if (rel != null) {
		return rel; // we've been given an ID
	}
	if (/[a-zA-Z0-9]{6,32}/.test(arg)) {
		return arg; // we've been given a commit hash
	}
	return null;
}

function parseArgs() {
	const argv = process.argv.slice(2);

	if (argv.indexOf('--help') !== -1 || argv.indexOf('-h') !== -1) {
		console.log(HELP);
		process.exit(0);
	}
	if (argv.indexOf('--version') !== -1 || argv.indexOf('-v') !== -1) {
		console.log(packageManifest.version);
		process.exit(0);
	}

	const options = {
		prepare: false,
		wait: false,
		timeout: undefined,
	};

	let fromRelease;
	let toRelease;

	while (argv.length > 0) {
		const arg = argv.shift();
		switch (arg) {
			case '--timeout':
				const timeout = argv.shift();
				options.timeout = parseNumber(timeout);
				if (options.timeout == null) {
					throw new Error(`Invalid value for --timeout option: ${timeout}`);
				}
			// fallthrough
			case '--wait':
				options.wait = true;
			// fallthrough
			case '--prepare':
				options.prepare = true;
				break;
			case '--from-release':
				const rel1 = argv.shift();
				fromRelease = parseRelease(rel1);
				if (fromRelease == null) {
					throw new Error(`Invalid value for --from-release option: ${rel1}`);
				}
				break;
			case '--to-release':
				const rel2 = argv.shift();
				toRelease = parseRelease(rel2);
				if (toRelease == null) {
					throw new Error(`Invalid value for --to-release option: ${rel2}`);
				}
				break;
			default:
				throw new Error(`invalid option: ${arg}`);
		}
	}
	if (fromRelease == null || toRelease == null) {
		throw new Error('Must specify both a source and a target release');
	}

	return {
		fromRelease,
		toRelease,
		options,
	};
}

async function main() {
	const { fromRelease, toRelease, options } = parseArgs();
	const cmd = options.prepare ? prepareUpdate : getUpdateInfo;
	return await cmd(fromRelease, toRelease, options);
}

main()
	.then((res) => {
		console.log(JSON.stringify(res, null, 2));
		process.exit(0);
	})
	.catch((err) => {
		console.error(`ERROR: ${err.message || err}`);
		process.exit(1);
	});
