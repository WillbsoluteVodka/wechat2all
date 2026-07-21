import {
  defineRoutePackageV1,
  type RouteManifestV1,
} from "@wechat2all/route-sdk";

const manifest = {
  protocol: "weconnect.route",
  protocolVersion: 1,
  id: "example",
  packageName: "@your-name/weconnect-route-example",
  displayName: "Example",
  version: "1.0.0",
  description: "Example WeConnect community route.",
  license: "MIT",
  engines: { weconnect: ">=0.1.0 <2", node: ">=20" },
  capabilities: ["text-input", "text-output"],
  permissions: [],
} satisfies RouteManifestV1;

export const routePackage = defineRoutePackageV1({
  protocol: "weconnect.route",
  protocolVersion: 1,
  manifest,
  create(context) {
    const connectorId = "example-connector";
    return {
      id: manifest.id,
      connectorId,
      connector: {
        id: connectorId,
        async handleMessage(message) {
          return [{
            type: "send_text",
            conversationId: message.conversationId,
            text: `Example route received: ${message.text ?? ""}`,
          }];
        },
      },
      route: {
        id: manifest.id,
        profileId: context.profileId,
        connectorId,
        priority: 500,
        terminal: true,
        match: { kind: "text", textCommands: [] },
        metadata: {
          assistantName: manifest.displayName,
          description: manifest.description,
        },
      },
      dashboard: {
        agent: {
          name: manifest.displayName,
          kind: "Community route",
          status: "ready",
          description: manifest.description,
        },
        management: {
          commands: [{ rule: "/cd example", description: "进入 Example route" }],
        },
      },
    };
  },
});

export default routePackage;
