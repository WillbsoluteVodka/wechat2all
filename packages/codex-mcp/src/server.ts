import readline from "node:readline";

import {
  CodexBridgeStore,
  type CodexBridgeStatusState,
  type CodexBridgeThread,
} from "./bridge.js";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonValue;
}

type ToolHandler = (args: unknown) => Promise<unknown>;

interface ToolRegistration {
  definition: ToolDefinition;
  handle: ToolHandler;
}

const STATUS_STATES = new Set<CodexBridgeStatusState>([
  "idle",
  "working",
  "completed",
  "blocked",
  "unknown",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArg(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

function requiredStringArg(args: Record<string, unknown>, key: string): string {
  const value = stringArg(args, key);
  if (!value) throw new Error(`Missing required string argument: ${key}`);
  return value;
}

function numberArg(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boolArg(
  args: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

function objectArg(
  args: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = args[key];
  return isRecord(value) ? value : undefined;
}

function parseArgs(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error("Tool arguments must be an object.");
  return value;
}

function toolResult(value: unknown): JsonValue {
  return {
    content: [{
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    }],
  };
}

function errorResult(error: Error): JsonValue {
  return {
    isError: true,
    content: [{
      type: "text",
      text: error.message,
    }],
  };
}

function maybeTarget(value: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  const target: Record<string, string> = {};
  for (const key of ["profileId", "conversationId", "senderId", "contextToken"]) {
    const item = value[key];
    if (typeof item === "string" && item.trim()) target[key] = item.trim();
  }
  return Object.keys(target).length ? target : undefined;
}

function parseThreads(value: unknown): CodexBridgeThread[] {
  if (!Array.isArray(value)) throw new Error("threads must be an array.");
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`threads[${index}] must be an object.`);
    const id = requiredStringArg(item, "id");
    return {
      id,
      title: stringArg(item, "title"),
      project: stringArg(item, "project"),
      status: stringArg(item, "status"),
      updatedAt: numberArg(item, "updatedAt"),
    };
  });
}

function createTools(store: CodexBridgeStore): Map<string, ToolRegistration> {
  const tools: ToolRegistration[] = [
    {
      definition: {
        name: "update_codex_status",
        description: "Publish the current Codex status for the WeChat codex route.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            state: {
              type: "string",
              enum: ["idle", "working", "completed", "blocked", "unknown"],
            },
            summary: { type: "string" },
            currentThreadId: { type: "string" },
            currentProject: { type: "string" },
          },
          required: ["state"],
        },
      },
      async handle(value) {
        const args = parseArgs(value);
        const state = requiredStringArg(args, "state");
        if (!STATUS_STATES.has(state as CodexBridgeStatusState)) {
          throw new Error(`Invalid state: ${state}`);
        }
        return store.updateStatus({
          state: state as CodexBridgeStatusState,
          summary: stringArg(args, "summary"),
          currentThreadId: stringArg(args, "currentThreadId"),
          currentProject: stringArg(args, "currentProject"),
        });
      },
    },
    {
      definition: {
        name: "send_wechat_message",
        description: "Queue a text message to the active WeChat codex route target.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string" },
            level: {
              type: "string",
              enum: ["info", "success", "warn", "error"],
            },
            threadId: { type: "string" },
            projectId: { type: "string" },
            target: {
              type: "object",
              additionalProperties: false,
              properties: {
                profileId: { type: "string" },
                conversationId: { type: "string" },
                senderId: { type: "string" },
                contextToken: { type: "string" },
              },
            },
          },
          required: ["text"],
        },
      },
      async handle(value) {
        const args = parseArgs(value);
        return store.sendWechatMessage({
          text: requiredStringArg(args, "text"),
          level: stringArg(args, "level") as "info" | "success" | "warn" | "error" | undefined,
          threadId: stringArg(args, "threadId"),
          projectId: stringArg(args, "projectId"),
          target: maybeTarget(objectArg(args, "target")),
        });
      },
    },
    {
      definition: {
        name: "list_wechat_prompts",
        description: "List prompts sent from WeChat while the conversation is inside the codex route.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: { type: "number", minimum: 1, maximum: 100 },
            includeHandled: { type: "boolean" },
          },
        },
      },
      async handle(value) {
        const args = parseArgs(value);
        return store.listWechatPrompts({
          limit: numberArg(args, "limit"),
          includeHandled: boolArg(args, "includeHandled"),
        });
      },
    },
    {
      definition: {
        name: "mark_wechat_prompt_handled",
        description: "Mark a WeChat prompt id as handled so it no longer appears in the pending list.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
        },
      },
      async handle(value) {
        const args = parseArgs(value);
        return store.markWechatPromptHandled(requiredStringArg(args, "id"));
      },
    },
    {
      definition: {
        name: "sync_codex_threads",
        description: "Publish a Codex chat/project list for the WeChat codex route.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            threads: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  id: { type: "string" },
                  title: { type: "string" },
                  project: { type: "string" },
                  status: { type: "string" },
                  updatedAt: { type: "number" },
                },
                required: ["id"],
              },
            },
          },
          required: ["threads"],
        },
      },
      async handle(value) {
        const args = parseArgs(value);
        return store.syncThreads(parseThreads(args.threads));
      },
    },
    {
      definition: {
        name: "get_bridge_state",
        description: "Inspect the local codex route bridge state and active WeChat target.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      },
      async handle() {
        return store.getBridgeState();
      },
    },
  ];
  return new Map(tools.map((tool) => [tool.definition.name, tool]));
}

function hasId(request: JsonRpcRequest): boolean {
  return Object.prototype.hasOwnProperty.call(request, "id");
}

function writeResponse(id: JsonRpcRequest["id"], result: unknown): void {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id,
    result,
  })}\n`);
}

function writeError(
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
  data?: unknown,
): void {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code, message, data },
  })}\n`);
}

async function handleRequest(
  tools: Map<string, ToolRegistration>,
  request: JsonRpcRequest,
): Promise<void> {
  if (!request.method) {
    if (hasId(request)) writeError(request.id, -32600, "Invalid Request");
    return;
  }

  switch (request.method) {
    case "initialize": {
      if (!hasId(request)) return;
      const params = isRecord(request.params) ? request.params : {};
      const protocolVersion = typeof params.protocolVersion === "string"
        ? params.protocolVersion
        : "2024-11-05";
      writeResponse(request.id, {
        protocolVersion,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "wechat2all-codex-mcp",
          version: "0.1.0",
        },
      });
      return;
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      if (hasId(request)) writeResponse(request.id, {});
      return;
    case "tools/list":
      if (hasId(request)) {
        writeResponse(request.id, {
          tools: [...tools.values()].map((tool) => tool.definition),
        });
      }
      return;
    case "tools/call": {
      if (!hasId(request)) return;
      const params = isRecord(request.params) ? request.params : {};
      const name = typeof params.name === "string" ? params.name : "";
      const tool = tools.get(name);
      if (!tool) {
        writeResponse(request.id, errorResult(new Error(`Unknown tool: ${name}`)));
        return;
      }
      try {
        writeResponse(request.id, toolResult(await tool.handle(params.arguments)));
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        writeResponse(request.id, errorResult(error));
      }
      return;
    }
    case "resources/list":
      if (hasId(request)) writeResponse(request.id, { resources: [] });
      return;
    case "prompts/list":
      if (hasId(request)) writeResponse(request.id, { prompts: [] });
      return;
    default:
      if (hasId(request)) {
        writeError(request.id, -32601, `Method not found: ${request.method}`);
      }
  }
}

export async function runMcpServer(params: {
  store?: CodexBridgeStore;
} = {}): Promise<void> {
  const store = params.store ?? new CodexBridgeStore();
  const tools = createTools(store);
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });

  process.stderr.write(`[wechat2all-codex-mcp] bridgeDir=${store.baseDir}\n`);

  for await (const line of rl) {
    const raw = line.trim();
    if (!raw) continue;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(raw) as JsonRpcRequest;
    } catch (err) {
      writeError(null, -32700, "Parse error", err instanceof Error ? err.message : String(err));
      continue;
    }
    await handleRequest(tools, request);
  }
}
