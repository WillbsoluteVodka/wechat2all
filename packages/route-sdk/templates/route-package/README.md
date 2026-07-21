# WeConnect community route template

Rename the package, route id, connector id, and manifest fields, then run
`pnpm build`. During local development add the built entrypoint to the host's
`WECHAT2ALL_ROUTE_PACKAGES` setting.

Keep `weconnect.route.json` and the exported `manifest` identical. Declare every
required permission with a human-readable reason before publishing.
