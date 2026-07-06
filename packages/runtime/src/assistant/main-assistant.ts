import type {
  AgentMemoryErrorHandler,
  AgentMemoryHit,
  AgentMemoryProvider,
  AgentMemoryScope,
  AgentMemorySearchParams,
} from "../agent-memory/types.js";
import { createNoopAgentMemoryProvider } from "../agent-memory/noop.js";
import type {
  LLMMessage,
  LLMProvider,
} from "../llm/types.js";
import type {
  MemoryMessage,
  RuntimeAction,
  RuntimeConnector,
  RuntimeHandlerContext,
  RuntimeMessage,
  RuntimeRoute,
} from "../types.js";

const DEFAULT_MAIN_ASSISTANT_PROMPT = [
  "你是 wechat2all 的“大助手”，运行在用户本地微信入口里。",
  "你是最高层级 router，可以进行普通闲聊，也可以告诉用户当前有哪些 routes。",
  "当用户询问有哪些 route、某个功能是否存在时，只描述 route 的名字和功能，不主动告诉用户内部触发命令。",
  "当用户没有明确选择 route 时，保持在 router 闲聊模式。",
  "当前固定 slash 命令只有：/help、/ls、/rename、/cd。",
  "保持回答简洁、具体、适合微信聊天窗口。",
].join("\n");

const DEFAULT_ROUTE_ASSISTANT_PROMPT = [
  "你是 wechat2all 中一个 route-specific assistant。",
  "你只负责当前 route 的功能。保持回答简洁、具体、适合微信聊天窗口。",
].join("\n");

export interface MainAssistantConnectorOptions {
  id?: string;
  name?: string;
  llm: LLMProvider;
  routeAssistantConnectorId?: string;
  systemPrompt?: string;
  memoryLimit?: number;
  dynamicRoutePriority?: number;
  agentMemory?: AgentMemoryProvider;
  memorySearchLimit?: number;
  onMemoryError?: AgentMemoryErrorHandler;
  llmTimeoutMs?: number;
  onLLMError?: (error: Error, context: {
    message: RuntimeMessage;
    route: RuntimeRoute;
    connectorId: string;
    providerId: string;
  }) => void | Promise<void>;
  onRoutesChanged?: (routes: RuntimeRoute[]) => void | Promise<void>;
}

export interface RouteAssistantConnectorOptions {
  id?: string;
  name?: string;
  llm: LLMProvider;
  systemPrompt?: string;
  memoryLimit?: number;
  agentMemory?: AgentMemoryProvider;
  memorySearchLimit?: number;
  onMemoryError?: AgentMemoryErrorHandler;
  llmTimeoutMs?: number;
  onLLMError?: (error: Error, context: {
    message: RuntimeMessage;
    route: RuntimeRoute;
    connectorId: string;
    providerId: string;
  }) => void | Promise<void>;
}

type AssistantCommand =
  | { type: "none" }
  | { type: "help" }
  | { type: "list" }
  | { type: "rename"; name?: string }
  | { type: "cd"; target?: string }
  | { type: "unknown"; raw: string };

function textContent(message: RuntimeMessage): string {
  if (message.text?.trim()) return message.text.trim();
  if (message.attachments.length > 0) {
    const kinds = message.attachments.map((attachment) => attachment.kind).join(", ");
    return `[${message.kind} message with ${message.attachments.length} attachment(s): ${kinds}]`;
  }
  return `[${message.kind} message]`;
}

function parseCommand(text: string | undefined): AssistantCommand {
  const value = text?.trim();
  if (!value) return { type: "none" };

  if (value === "/help") {
    return { type: "help" };
  }
  if (value === "/ls") {
    return { type: "list" };
  }
  if (value === "/rename") {
    return { type: "rename" };
  }
  const renameMatch = value.match(/^\/rename\s+(.+)$/);
  if (renameMatch) {
    return { type: "rename", name: renameMatch[1].trim() };
  }
  if (value === "/cd") {
    return { type: "cd" };
  }
  const cdMatch = value.match(/^\/cd\s+(.+)$/);
  if (cdMatch) {
    return { type: "cd", target: cdMatch[1].trim() };
  }

  if (
    /(有哪些|有什么|列出|查看|现在有|当前有).*(route|routes|路由)/i.test(value) ||
    /(route|routes|路由).*(有哪些|有什么|列表|清单|当前|现在)/i.test(value)
  ) {
    return { type: "list" };
  }

  if (value.startsWith("/")) {
    return { type: "unknown", raw: value };
  }

  return { type: "none" };
}

function routeNameFromId(profileId: string, id: string): string {
  const prefix = `assistant-route-${profileId}-`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

function cleanMainLine(line: string | undefined): string | undefined {
  if (line === undefined) return undefined;
  return line.replace(/\s+$/g, "");
}

function titleCaseAscii(value: string): string {
  return value.replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

function mainHeader(title: string): string {
  const normalized = title.trim();
  const okMatch = normalized.match(/^ok:\s*(.+)$/i);
  const errorMatch = normalized.match(/^error:\s*(.+)$/i);
  const rawLabel = okMatch?.[1] ?? errorMatch?.[1] ?? normalized;
  const display = errorMatch ? `Error: ${rawLabel}` : rawLabel;
  return `◆ 大助手 - ${titleCaseAscii(display)}`;
}

function mainPanel(title: string, lines: Array<string | undefined>): string {
  const body = lines
    .map(cleanMainLine)
    .filter((line): line is string => line !== undefined);
  return [
    mainHeader(title),
    "",
    ...body,
  ].join("\n");
}

function mainUsage(command: string, description?: string): string {
  return mainPanel("usage", [
    `- ${command}`,
    description ? `- ${description}` : undefined,
  ]);
}

function mainError(title: string, lines: Array<string | undefined>): string {
  return mainPanel(`error: ${title}`, lines);
}

function mainOk(title: string, lines: Array<string | undefined>): string {
  return mainPanel(`ok: ${title}`, lines);
}

function routeHelp(): string {
  return mainPanel("help", [
    "- /help 展示所有命令和功能",
    "- /ls 展示当前所有可用 routes",
    "- /rename <新名字> 重命名当前 route",
    "- /cd <route> 进入某个 route",
    "- /cd .. 从二级 route 返回大助手",
  ]);
}

function routeProfileMatches(profileId: string, route: RuntimeRoute): boolean {
  return route.profileId === undefined || route.profileId === profileId;
}

function isInternalRoute(route: RuntimeRoute): boolean {
  return route.id === "main-assistant-commands" ||
    route.metadata?.internal === true ||
    route.metadata?.hiddenFromMainAssistant === true;
}

function isVisibleRoute(profileId: string, route: RuntimeRoute): boolean {
  return routeProfileMatches(profileId, route) && !isInternalRoute(route);
}

function routeDisplayName(profileId: string, route: RuntimeRoute): string {
  const name = routeMetadataString(route, "assistantName");
  if (name) return name;
  if (route.id === "main-assistant-default") return "大助手";
  return routeNameFromId(profileId, route.id);
}

function routeKindLabel(route: RuntimeRoute): string {
  if (route.id === "main-assistant-default") return "默认";
  if (route.metadata?.builtIn === true) return "内置";
  if (route.metadata?.createdBy === "main-assistant") return "用户创建";
  return "系统";
}

function routeDescriptionText(route: RuntimeRoute): string {
  const description = routeMetadataString(route, "description") ??
    routeMetadataString(route, "systemPrompt");
  if (description) return description;
  if (route.id === "main-assistant-default") {
    return "普通对话、route 管理、创建下游功能";
  }
  return "Runtime route";
}

function routeSummaryLine(profileId: string, route: RuntimeRoute): string {
  return [
    `- ${routeDisplayName(profileId, route)}`,
    `  类型: ${routeKindLabel(route)}`,
    `  说明: ${routeDescriptionText(route)}`,
  ].join("\n");
}

function routeMatchesName(profileId: string, route: RuntimeRoute, name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return route.id.toLowerCase() === normalized ||
    routeDisplayName(profileId, route).toLowerCase() === normalized ||
    routeNameFromId(profileId, route.id).toLowerCase() === normalized;
}

function findVisibleRouteByName(
  profileId: string,
  routes: RuntimeRoute[],
  name: string,
): RuntimeRoute | undefined {
  return routes
    .filter((route) => isVisibleRoute(profileId, route))
    .find((route) => routeMatchesName(profileId, route, name));
}

function normalizeRouteName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name || name.startsWith("/")) return null;
  return name.slice(0, 32);
}

function memoryToLLMMessages(messages: MemoryMessage[]): LLMMessage[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role as "user" | "assistant",
      content: message.content,
    }));
}

async function buildLLMMessages(params: {
  context: RuntimeHandlerContext;
  message: RuntimeMessage;
  systemPrompt: string;
  memoryLimit: number;
  longTermContext?: string;
  routeContext?: string;
}): Promise<LLMMessage[]> {
  const recent = await params.context.memory.getRecentMessages(
    params.context.memoryScope,
    params.memoryLimit,
  );
  const systemParts = [params.systemPrompt];
  if (params.routeContext) {
    systemParts.push(`当前可用 routes（不要主动暴露内部触发命令）:\n${params.routeContext}`);
  }
  if (params.longTermContext) {
    systemParts.push(`长期记忆:\n${params.longTermContext}`);
  }

  const messages: LLMMessage[] = [
    { role: "system", content: systemParts.join("\n\n") },
    ...memoryToLLMMessages(recent),
  ];

  if (!params.message.text?.trim()) {
    messages.push({ role: "user", content: textContent(params.message) });
  }

  return messages;
}

function routeMetadataString(route: RuntimeRoute, key: string): string | undefined {
  const value = route.metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isAssistantRoute(route: RuntimeRoute): boolean {
  return route.metadata?.createdBy === "main-assistant";
}

function routesChanged(
  context: RuntimeHandlerContext,
  onRoutesChanged: MainAssistantConnectorOptions["onRoutesChanged"],
): Promise<void> | void {
  if (!onRoutesChanged) return undefined;
  return onRoutesChanged(context.routes.listRoutes());
}

function agentMemoryScope(
  message: RuntimeMessage,
  context: RuntimeHandlerContext,
): AgentMemoryScope {
  return {
    profileId: context.profileId,
    routeId: context.route.id,
    connectorId: context.connectorId,
    conversationId: message.conversationId,
    senderId: message.senderId,
  };
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function llmFailureText(error: Error, providerId: string): string {
  return mainError("llm unavailable", [
    "- 我现在连不上 LLM，所以这条消息暂时没法生成智能回复",
    `- provider: ${providerId}`,
    `- error: ${error.message}`,
    "- 你可以稍后重试，或先检查 WECHAT2ALL_LLM_BASE_URL / 网络代理 / API key",
  ]);
}

async function generateOrFallback(params: {
  llm: LLMProvider;
  messages: LLMMessage[];
  message: RuntimeMessage;
  context: RuntimeHandlerContext;
  timeoutMs?: number;
  onLLMError?: MainAssistantConnectorOptions["onLLMError"];
}): Promise<string> {
  try {
    const result = await params.llm.generate(params.messages, {
      timeoutMs: params.timeoutMs,
    });
    return result.text;
  } catch (err) {
    const error = toError(err);
    await params.onLLMError?.(error, {
      message: params.message,
      route: params.context.route,
      connectorId: params.context.connectorId,
      providerId: params.llm.id,
    });
    return llmFailureText(error, params.llm.id);
  }
}

function formatMemoryHits(hits: AgentMemoryHit[]): string | undefined {
  if (hits.length === 0) return undefined;
  return hits
    .map((hit, index) => `${index + 1}. ${hit.content}`)
    .join("\n");
}

async function searchAgentMemory(params: {
  provider: AgentMemoryProvider;
  search: AgentMemorySearchParams;
  onMemoryError?: AgentMemoryErrorHandler;
}): Promise<string | undefined> {
  try {
    return formatMemoryHits(await params.provider.search(params.search));
  } catch (err) {
    await params.onMemoryError?.(toError(err), {
      operation: "search",
      providerId: params.provider.id,
      scope: params.search.scope,
    });
    return undefined;
  }
}

async function rememberTurn(params: {
  provider: AgentMemoryProvider;
  message: RuntimeMessage;
  context: RuntimeHandlerContext;
  outputText: string;
  onMemoryError?: AgentMemoryErrorHandler;
}): Promise<void> {
  const content = textContent(params.message);
  if (!content.trim() && !params.outputText.trim()) return;
  const scope = agentMemoryScope(params.message, params.context);
  try {
    await params.provider.appendTurn({
      scope,
      input: {
        role: "user",
        content,
        createdAt: params.message.timestamp,
      },
      output: {
        role: "assistant",
        content: params.outputText,
        createdAt: Date.now(),
      },
      metadata: {
        platform: params.message.platform,
        messageId: params.message.id,
        routeId: params.context.route.id,
        connectorId: params.context.connectorId,
      },
    });
  } catch (err) {
    await params.onMemoryError?.(toError(err), {
      operation: "appendTurn",
      providerId: params.provider.id,
      scope,
    });
  }
}

function routeContext(profileId: string, routes: RuntimeRoute[]): string {
  const lines = routes
    .filter((route) => isVisibleRoute(profileId, route))
    .map((route) => routeSummaryLine(profileId, route));
  return lines.length > 0 ? lines.join("\n") : "- 当前没有可用 route";
}

export function createMainAssistantConnector(
  opts: MainAssistantConnectorOptions,
): RuntimeConnector {
  const id = opts.id ?? "main-assistant";
  const memoryLimit = opts.memoryLimit ?? 20;
  const memorySearchLimit = opts.memorySearchLimit ?? 5;
  const systemPrompt = opts.systemPrompt ?? DEFAULT_MAIN_ASSISTANT_PROMPT;
  const agentMemory = opts.agentMemory ?? createNoopAgentMemoryProvider();

  async function renameCurrentRoute(
    name: string | undefined,
    message: RuntimeMessage,
    context: RuntimeHandlerContext,
  ): Promise<RuntimeAction[]> {
    if (!name) {
      return [{
        type: "send_text",
        conversationId: message.conversationId,
        text: mainUsage("/rename <新名字>", "重命名当前 route"),
      }];
    }

    const normalized = normalizeRouteName(name);
    if (!normalized) {
      return [{
        type: "send_text",
        conversationId: message.conversationId,
        text: mainError("invalid route name", [
          "- 这个名字不太像 route 名字",
          "- 请使用普通文本，最多 32 个字符",
        ]),
      }];
    }

    const targetRouteId = context.route.id === "main-assistant-commands"
      ? "main-assistant-default"
      : context.route.id;
    const targetRoute = context.routes
      .listRoutes()
      .find((route) => route.id === targetRouteId);
    if (!targetRoute) {
      return [{
        type: "send_text",
        conversationId: message.conversationId,
        text: mainError("current route missing", [
          `- route: ${targetRouteId}`,
        ]),
      }];
    }

    context.routes.upsertRoute({
      ...targetRoute,
      metadata: {
        ...targetRoute.metadata,
        assistantName: normalized,
        renamedBy: "user",
        renamedAt: new Date().toISOString(),
      },
    });
    await routesChanged(context, opts.onRoutesChanged);

    return [{
      type: "send_text",
      conversationId: message.conversationId,
      text: mainOk("route renamed", [
        `- 已重命名为: ${normalized}`,
        `- name: ${normalized}`,
      ]),
    }];
  }

  function changeDirectory(
    target: string | undefined,
    message: RuntimeMessage,
    context: RuntimeHandlerContext,
  ): RuntimeAction[] {
    if (!target) {
      return [{
        type: "send_text",
        conversationId: message.conversationId,
        text: mainUsage("/cd <route>", "进入某个 route；返回上一级用 /cd .."),
      }];
    }

    if (target === "..") {
      context.routes.clearConversationRoute(message.profileId, message.conversationId);
      return [{
        type: "send_text",
        conversationId: message.conversationId,
        text: mainPanel("router", [
          "- 你已经在大助手",
        ]),
      }];
    }

    const route = findVisibleRouteByName(
      message.profileId,
      context.routes.listRoutes(),
      target,
    );
    if (!route) {
      return [{
        type: "send_text",
        conversationId: message.conversationId,
        text: mainError("route not found", [
          `- 没有找到 route: ${target}`,
          "- /ls 查看可用 routes",
        ]),
      }];
    }

    if (route.id === "main-assistant-default") {
      context.routes.clearConversationRoute(message.profileId, message.conversationId);
      return [{
        type: "send_text",
        conversationId: message.conversationId,
        text: mainPanel("router", [
          "- 你已经在大助手",
        ]),
      }];
    }

    context.routes.setConversationRoute(
      message.profileId,
      message.conversationId,
      route.id,
    );

    return [{
      type: "send_text",
      conversationId: message.conversationId,
      text: mainOk("route entered", [
        `- 已进入 route: ${routeDisplayName(message.profileId, route)}`,
        `- 说明: ${routeDescriptionText(route)}`,
        "- 当前对话会停留在这个 route 内",
        "- /cd .. 回到大助手",
      ]),
    }];
  }

  async function handleCommand(
    command: AssistantCommand,
    message: RuntimeMessage,
    context: RuntimeHandlerContext,
  ): Promise<RuntimeAction[] | null> {
    switch (command.type) {
      case "none":
        return null;
      case "help":
        return [{
          type: "send_text",
          conversationId: message.conversationId,
          text: routeHelp(),
        }];
      case "list": {
        const routes = context.routes
          .listRoutes()
          .filter((route) => isVisibleRoute(message.profileId, route));
        const text = routes.length === 0
          ? mainPanel("routes", ["- 当前没有可用 route"])
          : mainPanel("routes", routes
              .map((route) => routeSummaryLine(message.profileId, route))
              .flatMap((line, index) => index === 0 ? [line] : ["", line]));
        return [{ type: "send_text", conversationId: message.conversationId, text }];
      }
      case "rename": {
        return renameCurrentRoute(command.name, message, context);
      }
      case "cd": {
        return changeDirectory(command.target, message, context);
      }
      case "unknown":
        return [{ type: "noop", reason: `unknown main assistant command: ${command.raw}` }];
    }
  }

  return {
    id,
    name: opts.name ?? "大助手",
    async handleMessage(message, context) {
      const commandActions = await handleCommand(
        parseCommand(message.text),
        message,
        context,
      );
      if (commandActions) {
        const outputText = commandActions
          .filter((action) => action.type === "send_text")
          .map((action) => action.text)
          .join("\n");
        if (outputText) {
          await rememberTurn({
            provider: agentMemory,
            message,
            context,
            outputText,
            onMemoryError: opts.onMemoryError,
          });
        }
        return commandActions;
      }

      const scope = agentMemoryScope(message, context);
      const longTermContext = await searchAgentMemory({
        provider: agentMemory,
        search: {
          scope,
          query: textContent(message),
          limit: memorySearchLimit,
        },
        onMemoryError: opts.onMemoryError,
      });
      const llmMessages = await buildLLMMessages({
        context,
        message,
        systemPrompt,
        memoryLimit,
        longTermContext,
        routeContext: routeContext(message.profileId, context.routes.listRoutes()),
      });
      const text = await generateOrFallback({
        llm: opts.llm,
        messages: llmMessages,
        message,
        context,
        timeoutMs: opts.llmTimeoutMs,
        onLLMError: opts.onLLMError,
      });
      await rememberTurn({
        provider: agentMemory,
        message,
        context,
        outputText: text,
        onMemoryError: opts.onMemoryError,
      });
      return [{
        type: "send_text",
        conversationId: message.conversationId,
        text,
      }];
    },
  };
}

export function createRouteAssistantConnector(
  opts: RouteAssistantConnectorOptions,
): RuntimeConnector {
  const memoryLimit = opts.memoryLimit ?? 20;
  const memorySearchLimit = opts.memorySearchLimit ?? 5;
  const agentMemory = opts.agentMemory ?? createNoopAgentMemoryProvider();

  return {
    id: opts.id ?? "route-assistant",
    name: opts.name ?? "Route Assistant",
    async handleMessage(message, context) {
      if (message.text?.trim() === "/cd ..") {
        context.routes.clearConversationRoute(message.profileId, message.conversationId);
        return [{
          type: "send_text",
          conversationId: message.conversationId,
          text: mainOk("returned", [
            "- 已退回大助手",
            "- 普通聊天会由大助手接管",
            "- /ls 查看可用 routes",
          ]),
        }];
      }

      const assistantName =
        routeMetadataString(context.route, "assistantName") ?? context.route.id;
      const routePrompt =
        routeMetadataString(context.route, "systemPrompt") ??
        opts.systemPrompt ??
        DEFAULT_ROUTE_ASSISTANT_PROMPT;
      const systemPrompt = [
        routePrompt,
        "",
        `当前 route：${assistantName}`,
      ].join("\n");

      const scope = agentMemoryScope(message, context);
      const longTermContext = await searchAgentMemory({
        provider: agentMemory,
        search: {
          scope,
          query: textContent(message),
          limit: memorySearchLimit,
        },
        onMemoryError: opts.onMemoryError,
      });
      const llmMessages = await buildLLMMessages({
        context,
        message,
        systemPrompt,
        memoryLimit,
        longTermContext,
      });
      const text = await generateOrFallback({
        llm: opts.llm,
        messages: llmMessages,
        message,
        context,
        timeoutMs: opts.llmTimeoutMs,
        onLLMError: opts.onLLMError,
      });
      await rememberTurn({
        provider: agentMemory,
        message,
        context,
        outputText: text,
        onMemoryError: opts.onMemoryError,
      });
      return [{
        type: "send_text",
        conversationId: message.conversationId,
        text,
      }];
    },
  };
}
