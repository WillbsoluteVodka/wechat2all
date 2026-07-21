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
values. A future community registry can inspect the JSON without executing
untrusted package code.

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
list exists so a future installer can show and approve capabilities before
installation. Until that installer/sandbox exists, only load packages you
trust.
