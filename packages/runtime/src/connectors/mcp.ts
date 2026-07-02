import type {
  RuntimeAction,
  RuntimeConnector,
  RuntimeHandlerContext,
  RuntimeMessage,
} from "../types.js";

export interface RuntimeMcpToolClient {
  callTool(name: string, args: unknown): Promise<unknown>;
}

export interface McpConnectorOptions {
  id: string;
  name?: string;
  client: RuntimeMcpToolClient;
  toolName: string;
  mapMessage?: (message: RuntimeMessage, context: RuntimeHandlerContext) => unknown;
  mapResult?: (
    result: unknown,
    message: RuntimeMessage,
    context: RuntimeHandlerContext,
  ) => RuntimeAction[] | Promise<RuntimeAction[]>;
  fallbackText?: string | ((error: Error) => string);
  onError?: (
    error: Error,
    context: {
      message: RuntimeMessage;
      connectorId: string;
      toolName: string;
    },
  ) => void | Promise<void>;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function defaultArgs(message: RuntimeMessage): unknown {
  return {
    id: message.id,
    profileId: message.profileId,
    conversationId: message.conversationId,
    senderId: message.senderId,
    kind: message.kind,
    text: message.text,
    attachments: message.attachments.map((attachment) => ({
      id: attachment.id,
      kind: attachment.kind,
      fileName: attachment.fileName,
      size: attachment.size,
      durationMs: attachment.durationMs,
      mimeType: attachment.mimeType,
    })),
  };
}

function isRuntimeAction(value: unknown): value is RuntimeAction {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string";
}

function defaultResultToActions(
  result: unknown,
  message: RuntimeMessage,
): RuntimeAction[] {
  if (typeof result === "string") {
    return [{
      type: "send_text",
      conversationId: message.conversationId,
      text: result,
    }];
  }
  if (Array.isArray(result) && result.every(isRuntimeAction)) {
    return result;
  }
  if (result && typeof result === "object") {
    const data = result as { text?: unknown; actions?: unknown };
    const actions = Array.isArray(data.actions) && data.actions.every(isRuntimeAction)
      ? [...data.actions]
      : [];
    if (typeof data.text === "string") {
      actions.unshift({
        type: "send_text",
        conversationId: message.conversationId,
        text: data.text,
      });
    }
    return actions;
  }
  return [{ type: "noop", reason: "mcp tool returned no actions" }];
}

function fallbackText(
  fallback: McpConnectorOptions["fallbackText"],
  error: Error,
): string {
  if (typeof fallback === "function") return fallback(error);
  return fallback ?? `MCP tool failed: ${error.message}`;
}

export function createMcpConnector(opts: McpConnectorOptions): RuntimeConnector {
  return {
    id: opts.id,
    name: opts.name ?? `MCP:${opts.toolName}`,
    async handleMessage(message, context) {
      try {
        const args = opts.mapMessage
          ? opts.mapMessage(message, context)
          : defaultArgs(message);
        const result = await opts.client.callTool(opts.toolName, args);
        return opts.mapResult
          ? opts.mapResult(result, message, context)
          : defaultResultToActions(result, message);
      } catch (err) {
        const error = toError(err);
        await opts.onError?.(error, {
          message,
          connectorId: opts.id,
          toolName: opts.toolName,
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
