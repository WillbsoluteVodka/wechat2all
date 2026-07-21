import {
  defineRoutePackageV1,
  type RuntimeAction,
} from "../src/index.js";

export const routePackage = defineRoutePackageV1({
  protocol: "weconnect.route",
  protocolVersion: 1,
  manifest: {
    protocol: "weconnect.route",
    protocolVersion: 1,
    id: "community-echo",
    packageName: "@example/weconnect-route-echo",
    displayName: "Community Echo",
    version: "1.0.0",
    description: "Minimal third-party WeConnect route example.",
    license: "MIT",
    engines: { weconnect: ">=0.1.0", node: ">=20" },
    capabilities: ["text-input", "text-output"],
    permissions: [],
  },
  create(context) {
    return {
      id: "community-echo",
      connectorId: "community-echo-connector",
      connector: {
        id: "community-echo-connector",
        name: "Community Echo",
        handleMessage(message): RuntimeAction[] {
          return [{
            type: "send_text",
            conversationId: message.conversationId,
            contextToken: message.replyToken?.contextToken,
            text: `echo: ${message.text ?? ""}`,
          }];
        },
      },
      route: {
        id: "community-echo",
        profileId: context.profileId,
        connectorId: "community-echo-connector",
        priority: 500,
        terminal: true,
        match: { textCommands: ["/echo"] },
      },
      dashboard: {
        agent: {
          name: "Community Echo",
          kind: "Community route",
          status: "ready",
          description: "SDK protocol v1 example.",
        },
        management: {
          commands: [{ rule: "/echo <text>", description: "Echo text back to WeChat" }],
        },
      },
    };
  },
});

export default routePackage;
