#!/usr/bin/env node

'use strict';

const packageManifest = require('../package.json');

const { getUpdateInfo, prepareUpdate } = require('../build/index');

const HELP = `
Usage: balena-release-update [options]

Options:

  --from-release ID   The source release ID (number; required).
  --to-release ID     The target release ID (number; required).

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

	let fromReleaseId;
	let toReleaseId;

	while (argv.length > 0) {
		const arg = argv.shift();
		switch (arg) {
			case '--timeout':
				options.timeout = parseInt(argv.shift(), 10);
			case '--wait':
				options.wait = true;
			case '--prepare':
				options.prepare = true;
				break;
			case '--from-release':
				fromReleaseId = parseInt(argv.shift(), 10);
				break;
			case '--to-release':
				toReleaseId = parseInt(argv.shift(), 10);
				break;
			default:
				throw new Error(`invalid option: ${arg}`);
		}
	}
	if (fromReleaseId == null || toReleaseId == null) {
		throw new Error('Must specify both a source and a target release');
	}
	if (isNaN(fromReleaseId) || isNaN(toReleaseId)) {
		throw new Error('Either or both release IDs are invalid');
	}

	return {
		fromReleaseId,
		toReleaseId,
		options,
	};
}

async function main() {
	const { fromReleaseId, toReleaseId, options } = parseArgs();
	const cmd = options.prepare ? prepareUpdate : getUpdateInfo;
	return await cmd(fromReleaseId, toReleaseId, options);
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
