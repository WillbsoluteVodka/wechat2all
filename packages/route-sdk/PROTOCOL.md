# WeConnect Route Protocol v1

## Package contract

A route package exports a named `routePackage` (a default export may mirror it):

```ts
import { defineRoutePackageV1 } from "@wechat2all/route-sdk";

export const routePackage = defineRoutePackageV1({
  protocol: "weconnect.route",
  protocolVersion: 1,
  manifest,
  create(context) {
    return { id, connectorId, connector, route };
  },
});

export default routePackage;
```

`create()` is deliberately synchronous in v1. Expensive or asynchronous work
belongs in `lifecycle.start()`. The host calls the factory once per profile and
assigns the package a private `storageDir`.

## Static manifest

Published packages must include `weconnect.route.json`, validated by
`schemas/route-manifest.v1.schema.json`, and point to it from `package.json`:

```json
{
  "weconnect": {
    "routeManifest": "./weconnect.route.json",
    "routeEntrypoint": "."
  }
}
```

The JSON manifest and exported `routePackage.manifest` must contain the same
values. The Community registry inspects the JSON without executing untrusted
package code.

## Managed binary dependencies

A route that needs a standalone tool can declare `managedDependencies`. Each
entry pins an exact version and immutable HTTPS artifact with a SHA-256 for each
supported OS/CPU. It must also declare a non-optional `dependency:install`
permission. Example:

```json
{
  "permissions": [{
    "name": "dependency:install",
    "reason": "Install the private document CLI."
  }],
  "managedDependencies": [{
    "type": "binary",
    "id": "document-cli",
    "displayName": "Document CLI",
    "version": "1.2.3",
    "executable": "document-cli",
    "artifacts": {
      "darwin-arm64": {
        "urls": [
          "https://mirror.example.com/v1.2.3/document-cli-mac-arm64",
          "https://example.com/releases/v1.2.3/document-cli-mac-arm64"
        ],
        "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
    }
  }]
}
```

Community downloads the matching binary into the staged route, verifies its
hash and exact `--version`, and only then imports and activates the route. A
failed download, verification, or activation rolls the whole installation back.
Managed tools are not global and disappear when the route is uninstalled;
persistent route `storageDir` data remains separate.

Allowed platform keys are `darwin-arm64`, `darwin-x64`, `linux-arm64`,
`linux-x64`, `linux-musl-arm64`, `linux-musl-x64`, `win32-arm64`, and
`win32-x64`. `executable` is extensionless; the host appends `.exe` on Windows.
Every source in `urls` must serve identical bytes matching `sha256`; sources are
tried in order. The executable must support `--version` and print the exact
declared semver (a leading `v` is accepted).

## Required runtime module

The factory returns exactly one route and one connector:

- `id` must equal `manifest.id`;
- `connectorId` must equal `connector.id`;
- `route.id` and `route.connectorId` must match the module;
- `route.profileId`, when supplied, must match the host context;
- connector handlers return only standard `RuntimeAction[]` values.

Optional contributions are `config`, `setupCheck`, `dashboard`, `backend`, and
`lifecycle`. The host owns HTTP endpoints and UI rendering for these features;
route packages never patch the daemon or Desktop application directly.

The host calls `lifecycle.start()` only after the profile and HTTP server are
ready, and calls `lifecycle.stop()` during graceful shutdown. A rejected or
failing startup hook is logged without taking down other running routes.
The host may also call `lifecycle.stop()` on a validation-only instance whose
`start()` hook never ran. Route shutdown hooks must therefore be idempotent and
safe both before startup and after partial startup.

## Loading a local third-party route

Install or link the npm package into the WeConnect workspace, then list its
specifier in `.env.local`:

```text
WECHAT2ALL_ROUTE_PACKAGES=@alice/weconnect-route-calendar,@bob/weconnect-route-home
```

Absolute paths and `file:` URLs are also accepted for local development. Every
package is validated as protocol v1 before its connector or lifecycle hook is
registered. Duplicate route, connector, or config ids fail startup with a
specific protocol error.

The local host exposes the resulting manifest inventory at `GET /route-packages`.
This is the same metadata a future community installer can use for capability
and permission approval.

An invalid or crashing third-party package is rejected and logged without
preventing WeConnect or already validated routes from starting. Built-in package
validation remains strict so a broken application build fails visibly.

## Trust boundary

Protocol validation prevents accidental shape/version conflicts; it is not a
sandbox. A route package is executable Node.js code. The manifest permission
list lets Community show and approve capabilities before installation. Only
install reviewed packages from catalogs you trust.
