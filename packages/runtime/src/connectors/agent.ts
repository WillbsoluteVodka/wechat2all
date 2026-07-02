import type {
  RuntimeAction,
  RuntimeConnector,
  RuntimeHandlerContext,
  RuntimeMessage,
} from "../types.js";

export interface RuntimeAgentRequest {
  message: RuntimeMessage;
  context: RuntimeHandlerContext;
}

export type RuntimeAgentResponse =
  | RuntimeAction[]
  | {
      text?: string;
      actions?: RuntimeAction[];
      metadata?: Record<string, unknown>;
    };

export interface RuntimeAgent {
  id: string;
  name?: string;
  handle(request: RuntimeAgentRequest): Promise<RuntimeAgentResponse>;
}

export interface AgentConnectorOptions {
  id: string;
  name?: string;
  agent: RuntimeAgent;
  fallbackText?: string | ((error: Error) => string);
  onError?: (
    error: Error,
    context: {
      message: RuntimeMessage;
      connectorId: string;
      agentId: string;
    },
  ) => void | Promise<void>;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function responseToActions(
  message: RuntimeMessage,
  response: RuntimeAgentResponse,
): RuntimeAction[] {
  if (Array.isArray(response)) return response;
  const actions = [...(response.actions ?? [])];
  if (response.text) {
    actions.unshift({
      type: "send_text",
      conversationId: message.conversationId,
      text: response.text,
    });
  }
  return actions;
}

function fallbackText(
  fallback: AgentConnectorOptions["fallbackText"],
  error: Error,
): string {
  if (typeof fallback === "function") return fallback(error);
  return fallback ?? `Agent failed: ${error.message}`;
}

export function createAgentConnector(opts: AgentConnectorOptions): RuntimeConnector {
  return {
    id: opts.id,
    name: opts.name ?? opts.agent.name ?? opts.agent.id,
    async handleMessage(message, context) {
      try {
        const response = await opts.agent.handle({ message, context });
        return responseToActions(message, response);
      } catch (err) {
        const error = toError(err);
        await opts.onError?.(error, {
          message,
          connectorId: opts.id,
          agentId: opts.agent.id,
        });
        return [{
          type: "send_text",
          conversationId: message.conversationId,
          text: fallbackText(opts.fallbackText, error),
        }];
      }
    },
  };
}
