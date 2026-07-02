import type {
  AgentMemoryAppendTurnParams,
  AgentMemoryHit,
  AgentMemoryProvider,
  AgentMemorySearchParams,
} from "./types.js";

export interface Mem0PlatformMemory {
  id?: string;
  memory?: string;
  text?: string;
  content?: string;
  score?: number;
  metadata?: Record<string, unknown> | null;
}

export type Mem0Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface Mem0AgentMemoryProviderOptions {
  id?: string;
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: Mem0Fetch;
}

const DEFAULT_MEM0_BASE_URL = "https://api.mem0.ai";
const DEFAULT_MEM0_TIMEOUT_MS = 15_000;

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function scopeUserId(scope: AgentMemorySearchParams["scope"]): string {
  return `${scope.profileId}:${scope.senderId}`;
}

function searchFilters(scope: AgentMemorySearchParams["scope"]): Record<string, string> {
  return {
    user_id: scopeUserId(scope),
    agent_id: scope.routeId,
    run_id: scope.conversationId,
  };
}

function metadata(scope: AgentMemorySearchParams["scope"]): Record<string, string> {
  return {
    profileId: scope.profileId,
    routeId: scope.routeId,
    connectorId: scope.connectorId,
    conversationId: scope.conversationId,
    senderId: scope.senderId,
  };
}

function responseItems(raw: unknown): Mem0PlatformMemory[] {
  if (Array.isArray(raw)) return raw as Mem0PlatformMemory[];
  if (!raw || typeof raw !== "object") return [];
  const data = raw as {
    results?: unknown;
    memories?: unknown;
    data?: unknown;
  };
  if (Array.isArray(data.results)) return data.results as Mem0PlatformMemory[];
  if (Array.isArray(data.memories)) return data.memories as Mem0PlatformMemory[];
  if (Array.isArray(data.data)) return data.data as Mem0PlatformMemory[];
  return [];
}

function memoryContent(item: Mem0PlatformMemory): string | undefined {
  return item.memory ?? item.text ?? item.content;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function readResponseBody(resp: Response): Promise<unknown> {
  const text = await resp.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function errorSummary(body: unknown): string {
  if (typeof body === "string") return body;
  const obj = asObject(body);
  if (!obj) return "empty response body";
  const detail = obj.detail ?? obj.message ?? obj.error ?? obj.code;
  if (typeof detail === "string") return detail;
  return JSON.stringify(obj);
}

function createMem0RestClient(opts: Mem0AgentMemoryProviderOptions) {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("Mem0 memory provider requires a global fetch implementation.");
  }

  const baseUrl = trimTrailingSlash(opts.baseUrl ?? DEFAULT_MEM0_BASE_URL);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_MEM0_TIMEOUT_MS;
  let userIdPromise: Promise<string | undefined> | undefined;

  async function request(
    path: string,
    init: Omit<RequestInit, "headers" | "signal"> & { body?: string },
    userId?: string,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let resp: Response;
    try {
      resp = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Token ${opts.apiKey}`,
          "Content-Type": "application/json",
          ...(userId ? { "Mem0-User-ID": userId } : {}),
        },
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Mem0 request timed out after ${timeoutMs}ms: ${path}`);
      }
      throw new Error(`Mem0 request failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timeout);
    }

    const body = await readResponseBody(resp);
    if (!resp.ok) {
      throw new Error(
        `Mem0 request failed (${resp.status} ${resp.statusText}) for ${path}: ${errorSummary(body)}`,
      );
    }
    return body;
  }

  async function getMem0UserId(): Promise<string | undefined> {
    userIdPromise ??= request("/v1/ping/", { method: "GET" }).then((body) => {
      const obj = asObject(body);
      if (!obj) throw new Error("Mem0 ping returned an invalid response.");
      if (obj.status !== "ok") {
        throw new Error(`Mem0 ping failed: ${errorSummary(body)}`);
      }
      return stringValue(obj.user_email) ?? stringValue(obj.userEmail);
    });
    return userIdPromise;
  }

  return {
    async add(
      messages: Array<{ role: "user" | "assistant"; content: string }>,
      options: {
        userId: string;
        agentId: string;
        runId: string;
        metadata?: Record<string, unknown>;
      },
    ): Promise<unknown> {
      const mem0UserId = await getMem0UserId();
      return request("/v3/memories/add/", {
        method: "POST",
        body: JSON.stringify({
          messages,
          user_id: options.userId,
          agent_id: options.agentId,
          run_id: options.runId,
          metadata: options.metadata,
        }),
      }, mem0UserId);
    },
    async search(
      query: string,
      options: {
        filters: Record<string, string>;
        topK: number;
      },
    ): Promise<unknown> {
      const mem0UserId = await getMem0UserId();
      return request("/v3/memories/search/", {
        method: "POST",
        body: JSON.stringify({
          query,
          output_format: "v1.1",
          filters: options.filters,
          top_k: options.topK,
        }),
      }, mem0UserId);
    },
  };
}

export function createMem0AgentMemoryProvider(
  opts: Mem0AgentMemoryProviderOptions,
): AgentMemoryProvider {
  const client = createMem0RestClient(opts);

  return {
    id: opts.id ?? "mem0-agent-memory",
    async appendTurn(params: AgentMemoryAppendTurnParams): Promise<void> {
      const messages = [params.input, params.output]
        .filter((message): message is NonNullable<typeof message> => Boolean(message))
        .filter((message) => message.role === "user" || message.role === "assistant")
        .map((message) => ({
          role: message.role as "user" | "assistant",
          content: message.content,
        }));
      if (messages.length === 0) return;

      await client.add(messages, {
        userId: scopeUserId(params.scope),
        agentId: params.scope.routeId,
        runId: params.scope.conversationId,
        metadata: {
          ...metadata(params.scope),
          ...params.metadata,
        },
      });
    },
    async search(params: AgentMemorySearchParams): Promise<AgentMemoryHit[]> {
      if (!params.query.trim()) return [];
      const raw = await client.search(params.query, {
        filters: searchFilters(params.scope),
        topK: params.limit ?? 10,
      });
      const hits: AgentMemoryHit[] = [];
      for (const item of responseItems(raw)) {
        const content = memoryContent(item);
        if (!content) continue;
        hits.push({
          id: item.id,
          content,
          score: item.score,
          metadata: item.metadata ?? undefined,
        });
      }
      return hits;
    },
  };
}
