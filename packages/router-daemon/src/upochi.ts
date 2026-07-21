import type {
  RuntimeConnector,
  RuntimeMessage,
  RuntimeRoute,
} from "@wechat2all/runtime";

const DEFAULT_UPOCHI_API_PORT = "8765";
const UPOCHI_REQUEST_TIMEOUT_MS = 5_000;
const UPOCHI_HEALTH_TIMEOUT_MS = 1_500;
const UPOCHI_ADD_REQUEST_TIMEOUT_MS = 30_000;
const UPOCHI_TODO_SOURCE = "wechat2all-upochi-route";

interface UpochiTodo {
  id: string;
  title?: string;
  text?: string;
  completed?: boolean;
}

export interface UpochiClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

export interface UpochiHealthCheckOptions extends UpochiClientOptions {
  timeoutMs?: number;
}

export interface UpochiHealthSnapshot {
  status: "ready" | "not-running";
  running: boolean;
  baseUrl: string;
  checkedAt: string;
  latencyMs: number;
  error: string | null;
}

class UpochiApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "UpochiApiError";
  }
}

function resolveUpochiBaseUrl(opts: UpochiClientOptions): string {
  if (opts.baseUrl?.trim()) return opts.baseUrl.trim().replace(/\/+$/, "");
  const env = opts.env ?? process.env;
  const port = env.UPOCHI_API_PORT?.trim()
    || DEFAULT_UPOCHI_API_PORT;
  return `http://127.0.0.1:${port}`;
}

function sendText(message: RuntimeMessage, text: string) {
  return [{
    type: "send_text" as const,
    conversationId: message.conversationId,
    text,
  }];
}

function upochiBlock(title: string, lines: Array<string | undefined>): string {
  return [
    `\`\`\`${title.replace(/`/g, "'")}`,
    ...lines
      .filter((line): line is string => line !== undefined)
      .map((line) => line.replace(/```/g, "'''")),
    "```",
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new UpochiApiError("Upochi 返回了无法解析的数据。", response.status);
  }
}

function apiErrorMessage(payload: unknown, response: Response): string {
  if (isRecord(payload) && isRecord(payload.error)) {
    const message = payload.error.message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return `Upochi API 请求失败（HTTP ${response.status}）。`;
}

function parseTodo(value: unknown): UpochiTodo | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()) {
    return null;
  }
  return {
    id: value.id,
    title: typeof value.title === "string" ? value.title : undefined,
    text: typeof value.text === "string" ? value.text : undefined,
    completed: typeof value.completed === "boolean" ? value.completed : undefined,
  };
}

function todoTitle(todo: UpochiTodo): string {
  return todo.title?.trim() || todo.text?.trim() || "（未命名）";
}

function formatTodoLine(todo: UpochiTodo): string[] {
  return [
    `${todo.completed ? "[已完成]" : "[未完成]"} ${todoTitle(todo)}`,
    `id: ${todo.id}`,
  ];
}

function formatTodoList(todos: UpochiTodo[]): string {
  if (todos.length === 0) return upochiBlock("Upochi-Todos", ["现在没有 Todo。"]);
  return upochiBlock("Upochi-Todos", [
    `现在共有 ${todos.length} 个 Todo：`,
    "",
    ...todos.flatMap((todo, index) => [
      `${index + 1}. ${todo.completed ? "[已完成]" : "[未完成]"} ${todoTitle(todo)}`,
      `   id: ${todo.id}`,
      "",
    ]),
  ]).trimEnd();
}

function unwrapId(rawId: string): string {
  const trimmed = rawId.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function operationErrorText(error: unknown, baseUrl: string): string {
  if (error instanceof UpochiApiError && error.status === 404) {
    return upochiBlock("Upochi-Error", ["这个 Todo 已经不存在，可能已经被删除了。"]);
  }
  const detail = error instanceof Error ? error.message : String(error);
  return upochiBlock("Upochi-Error", [
    `Upochi 操作失败：${detail}`,
    "",
    "请确认 Upochi 已启动，并且本地 API 可以访问：",
    baseUrl,
  ]);
}

export function createUpochiRouteDefinition(profileId: string): RuntimeRoute {
  return {
    id: "upochi",
    profileId,
    connectorId: "upochi-route",
    priority: 800,
    terminal: true,
    match: {
      kind: "text",
      textCommands: ["/check", "/add", "/remove"],
    },
    metadata: {
      assistantName: "Upochi",
      systemPrompt: "",
      description:
        "连接本机 Upochi Todo。进入 route 后可使用 /check、/add 标题、/remove id。",
      builtIn: true,
    },
  };
}

export async function checkUpochiHealth(
  opts: UpochiHealthCheckOptions = {},
): Promise<UpochiHealthSnapshot> {
  const baseUrl = resolveUpochiBaseUrl(opts);
  const fetchImpl = opts.fetch ?? fetch;
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(`${baseUrl}/health`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? UPOCHI_HEALTH_TIMEOUT_MS),
    });
    const payload = await responseJson(response);
    if (!response.ok) {
      throw new UpochiApiError(apiErrorMessage(payload, response), response.status);
    }
    if (
      !isRecord(payload)
      || payload.status !== "ok"
      || payload.service !== "upochi-local-api"
    ) {
      throw new UpochiApiError("本地端口响应的不是 Upochi API。");
    }
    return {
      status: "ready",
      running: true,
      baseUrl,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      error: null,
    };
  } catch (error) {
    return {
      status: "not-running",
      running: false,
      baseUrl,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function createUpochiConnector(
  opts: UpochiClientOptions = {},
): RuntimeConnector {
  const baseUrl = resolveUpochiBaseUrl(opts);
  const fetchImpl = opts.fetch ?? fetch;

  async function request(
    path: string,
    init?: RequestInit,
    timeoutMs = UPOCHI_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...init?.headers,
      },
      signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
    });
    const payload = await responseJson(response);
    if (!response.ok) {
      throw new UpochiApiError(apiErrorMessage(payload, response), response.status);
    }
    return payload;
  }

  async function checkHealth(): Promise<void> {
    const payload = await request("/health");
    if (!isRecord(payload) || payload.status !== "ok") {
      throw new UpochiApiError("Upochi 健康检查未通过。");
    }
  }

  return {
    id: "upochi-route",
    name: "Upochi",
    async handleMessage(message, context) {
      const text = message.text?.trim() ?? "";
      if (text === "/cd ..") {
        context.routes.clearConversationRoute(
          message.profileId,
          message.conversationId,
        );
        return sendText(message, upochiBlock("Upochi-Returned", ["已退回大助手。"]));
      }

      if (text === "/check") {
        try {
          await checkHealth();
          const payload = await request("/v1/todos");
          if (!isRecord(payload) || !Array.isArray(payload.todos)) {
            throw new UpochiApiError("Upochi 返回的 Todo 列表格式不正确。");
          }
          const todos = payload.todos.map(parseTodo).filter(
            (todo): todo is UpochiTodo => todo !== null,
          );
          return sendText(message, formatTodoList(todos));
        } catch (error) {
          return sendText(message, operationErrorText(error, baseUrl));
        }
      }

      if (text === "/add" || text.startsWith("/add ")) {
        const title = text.slice("/add".length).trim();
        if (!title) {
          return sendText(message, upochiBlock("Upochi-Add", ["用法：/add Todo 标题"]));
        }
        try {
          await checkHealth();
          const payload = await request("/v1/todos", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title, source: UPOCHI_TODO_SOURCE }),
          }, UPOCHI_ADD_REQUEST_TIMEOUT_MS);
          const todo = isRecord(payload) ? parseTodo(payload.todo) : null;
          if (!todo) throw new UpochiApiError("Upochi 返回的新 Todo 格式不正确。");
          return sendText(message, upochiBlock("Upochi-Add", ["已新增 Todo：", ...formatTodoLine(todo)]));
        } catch (error) {
          return sendText(message, operationErrorText(error, baseUrl));
        }
      }

      if (text === "/remove" || text.startsWith("/remove ")) {
        const id = unwrapId(text.slice("/remove".length));
        if (!id) {
          return sendText(message, upochiBlock("Upochi-Remove", ["用法：/remove Todo 的 id"]));
        }
        try {
          await checkHealth();
          const payload = await request(`/v1/todos/${encodeURIComponent(id)}`, {
            method: "DELETE",
          });
          const todo = isRecord(payload) ? parseTodo(payload.todo) : null;
          return sendText(
            message,
            upochiBlock("Upochi-Remove", todo
              ? ["已删除 Todo：", ...formatTodoLine(todo)]
              : ["已删除 Todo。", `id: ${id}`]),
          );
        } catch (error) {
          return sendText(message, operationErrorText(error, baseUrl));
        }
      }

      return [{
        type: "noop",
        reason: "Upochi route only handles /check, /add, and /remove commands.",
      }];
    },
  };
}
