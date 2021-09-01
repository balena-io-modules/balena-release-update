# balena-release-update

[![npm](https://img.shields.io/npm/v/@balena/release-update.svg?style=flat-square)](https://npmjs.com/package/@balena/release-update)
[![npm license](https://img.shields.io/npm/l/@balena/release-update.svg?style=flat-square)](https://npmjs.com/package/@balena/release-update)

Tiny library and simple command line script to prepare and get information
about the transition between two [balenaCloud] application releases.

> **NOTE**: this library is highly EXPERIMENTAL as it relies on implementation
details of the balenaCloud platform that may change at any time. The exposed
API is also subject to change, though these changes will be communicated with
appropriate version bumps, as per [Semantic Versioning]. All that said, you
are very welcome to use this library in non-critical applications and we
appreciate your feedback.

[Semantic Versioning]: https://semver.org


## Overview

Devices on [balenaCloud] run *releases*, which is a term used to describe a
set of artifacts and their runtime configuration. When you build and deploy a
new release, all devices that belong to the application begin a process to
transition to the new release by downloading the new artifacts and applying
the new runtime configuration. When that transition ends, the device is said
to be on the new release. In other words, each release describes a target state
and devices strive to reach it. You can think of releases a device has been on
as discrete points on a timeline and the transition from one to the other as
an edge that connects the two.

Each transition may involve intermediate artifacts that, like releases, must
be built before it can begin to take place. We tentatively call this transition
and the artifacts a *release update*. A release update is *pending* when it
hasn't been asked to begin building its artifacts, and *ready* when all of its
artifacts have been built, at which point the transition can begin. While the
release update is being built, it is said to be in the *preparing* state.

Currently, the only type of such an intermediate artifact is *[image deltas]*.
An image delta is the binary difference between two Docker images, called the
*source* and *destination* image. Deltas are themselves ordinary images that
can be applied on top of the source image to produce a third one that is
bit-identical to the destination image. The computation of a delta is between
the raw image data, thus changes to lower image layers do not cause unnecessary
data to be included into the payload, resulting in significant network-bandwidth
savings compared to pulling regular images in order to update.

Devices use deltas instead of regular image pulls to update to a new release,
when configured for doing so. Devices that run balenaOS after v2.47.1 are
configured to use deltas by default. When such a device begins its update
process, it'll first ask for deltas between the images it has locally and the
images specified by the new release for each respective service. Deltas,
however, may take significant time to produce – it is primarily a function of
the size of the images involved – therefore delaying the transition. Deltas
are unique among any given image pair, thus it is enough for a delta to be
generated once – the same set of deltas can then be downloaded by every device
that updates between the same two releases.

`balena-release-update` is able to provide information about these transitions
and a way to fully prepare a release update before your fleet updates to a new
release, which in combination with [release pinning] can significantly reduce
the time required for a device to transition from the old to the new release.
Given any two releases of the same application, it computes a description of
the transition and can trigger a build of all required artifacts, including
image deltas, and it can optionally wait until the release update becomes ready
or a configurable timeout is exceeded before returning. The returned information
includes details about which artifacts will be removed, which will be downloaded
and which will merely be updated, as well as information about deltas. It also
provides a (pessimistic) estimate of the total payload size, which is useful
for fleet owners that run devices in network-constrained environments.

[image deltas]: https://www.balena.io/docs/learn/deploy/delta/
[release pinning]: https://www.balena.io/docs/learn/deploy/release-strategy/release-policy/#pin-application-to-a-release


## Getting started

`balena-release-update` provides both a command line script and a library that
you can use in your NodeJS project.


### Authenticating with balenaCloud

Regardless of which way you go, you first need to authenticate with balenaCloud.
`balena-release-update` currently just reuses your existing [balena CLI] session.
In order to authenticate, make sure you have the CLI installed and run:

```sh
$ balena whoami
```

If that doesn't show your username, then just run the following command and
follow the instructions to login:

```sh
$ balena login
```


[balena CLI]: https://github.com/balena-io/balena-cli


### Using the command line interface

If you only care about the command line script, then it might be preferrable
to install it globally with:

```sh
$ npm install --global '@balena/release-update'
```

There's only one command:

```
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
```


### Using it as a library

To install the package and add it as a dependency to your project, run the
following:

```sh
$ npm install --save '@balena/release-update'
```

Then import the module in your project:

```ts
import { getUpdateInfo, prepareUpdate } from '@balena/release-update';
```


#### Getting information about a release update

```ts
const updateInfo = await getUpdateInfo(900813, 900835);
console.log(updateInfo);
```

prints:

```json
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
```

#### Preparing a release update

You can optionally wait until the release update becomes ready:

```ts
const updateInfo = await prepareUpdate(900813, 900835, {
  wait: true
});
```

Or until a timeout is exceeded:

```ts
const updateInfo = await prepareUpdate(900813, 900835, {
  timeout: 60
});
```


## License

The project is licensed under the [Apache 2.0 License](https://www.apache.org/licenses/LICENSE-2.0).
A copy is also available in the LICENSE file in this repository.

[balenaCloud]: https://www.balena.io/
