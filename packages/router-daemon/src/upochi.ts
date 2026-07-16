import type {
  RuntimeConnector,
  RuntimeRoute,
} from "@wechat2all/runtime";

export function createUpochiRouteDefinition(profileId: string): RuntimeRoute {
  return {
    id: "upochi",
    profileId,
    connectorId: "upochi-route",
    priority: 800,
    terminal: true,
    match: {
      kind: "text",
      textCommands: [],
    },
    metadata: {
      assistantName: "Upochi",
      systemPrompt: "",
      builtIn: true,
    },
  };
}

export function createUpochiConnector(): RuntimeConnector {
  return {
    id: "upochi-route",
    name: "Upochi",
    async handleMessage(message, context) {
      if (message.text?.trim() === "/cd ..") {
        context.routes.clearConversationRoute(
          message.profileId,
          message.conversationId,
        );
        return [{
          type: "send_text",
          conversationId: message.conversationId,
          text: "已退回大助手。",
        }];
      }

      return [{
        type: "noop",
        reason: "Upochi route is intentionally blank.",
      }];
    },
  };
}
