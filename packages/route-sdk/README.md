# WeConnect Route SDK

`@wechat2all/route-sdk` is the only package a community route author needs to
implement the versioned WeConnect Route Protocol.

Protocol v1 provides:

- a static marketplace manifest;
- a standard synchronous route factory;
- stable message, action, connector, route, config, setup-check, dashboard, and
  lifecycle types;
- runtime validation before a package is allowed into the router;
- a private storage directory and scoped host logger;
- explicit capability and permission declarations;
- optional checksummed, route-private binary dependencies installed and removed
  transactionally by Community.

See [PROTOCOL.md](./PROTOCOL.md) for the contract and
[`examples/echo-route.ts`](./examples/echo-route.ts) for a minimal route. A
copyable publishable project lives in [`templates/route-package`](./templates/route-package).
