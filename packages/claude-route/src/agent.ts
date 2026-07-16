import fs from "node:fs/promises";
import path from "node:path";

import {
  createSdkMcpServer,
  query,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type {
  ClaudeAgentAvailability,
  ClaudeAgentRunRequest,
  ClaudeAgentRunResult,
  ClaudeAgentRunner,
  ClaudeRouteOutputFile,
} from "./types.js";

interface RunCollector {
  outputs: ClaudeRouteOutputFile[];
  resetSessionRequested: boolean;
}

type UnknownMessage = Record<string, unknown>;

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function errorText(message: UnknownMessage): string | undefined {
  const errors = message.errors;
  if (Array.isArray(errors)) {
    const values = errors
      .map((value) => typeof value === "string" ? value : JSON.stringify(value))
      .filter(Boolean);
    if (values.length) return values.join("; ");
  }
  return stringValue(message.error);
}

async function resolveWorkspaceFile(workdir: string, rawPath: string): Promise<string> {
  const workspace = await fs.realpath(workdir);
  const candidate = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(workspace, rawPath);
  const resolved = await fs.realpath(candidate);
  const relative = path.relative(workspace, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${rawPath} is outside the configured Claude workspace.`);
  }
  if (!(await fs.stat(resolved)).isFile()) {
    throw new Error(`${rawPath} is not a regular file.`);
  }
  return resolved;
}

function createRouteMcpServer(
  request: ClaudeAgentRunRequest,
  collector: RunCollector,
) {
  const status = tool(
    "status",
    "Report this wechat2all Claude route's current model, language, workspace, and session policy.",
    {},
    async () => textResult([
      `model: ${request.config.model ?? "default"}`,
      `language: ${request.config.language}`,
      `workspace: ${request.config.workdir ?? "not configured"}`,
      `session window: ${Math.round(request.config.sessionWindowMs / 60_000)} minutes`,
    ].join("\n")),
  );

  const resetSession = tool(
    "reset_session",
    "Forget this route's current conversation after this run so the user's next message starts fresh.",
    {},
    async () => {
      collector.resetSessionRequested = true;
      return textResult("The current route session will be cleared after this run.");
    },
  );

  const outputSchema = {
    path: z.string().min(1).describe("File path relative to the configured workspace"),
    caption: z.string().optional().describe("Optional caption sent with the file"),
  };

  const collectOutput = async (
    kind: ClaudeRouteOutputFile["kind"],
    rawPath: string,
    caption?: string,
  ) => {
    if (!request.config.workdir) {
      return textResult("error: Claude workspace is not configured");
    }
    try {
      const filePath = await resolveWorkspaceFile(request.config.workdir, rawPath);
      if (!collector.outputs.some((item) =>
        item.kind === kind && item.filePath === filePath
      )) {
        collector.outputs.push({ kind, filePath, caption });
      }
      return textResult(`queued ${path.basename(filePath)} for WeChat delivery`);
    } catch (error) {
      return textResult(`error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const sendFile = tool(
    "send_file",
    "Send a regular file from the configured workspace back to the user through WeChat.",
    outputSchema,
    async ({ path: filePath, caption }) => collectOutput("file", filePath, caption),
  );

  const sendImage = tool(
    "send_image",
    "Send an image from the configured workspace back to the user through WeChat as inline media.",
    outputSchema,
    async ({ path: filePath, caption }) => collectOutput("image", filePath, caption),
  );

  return createSdkMcpServer({
    name: "claude_route",
    version: "1.0.0",
    tools: [status, resetSession, sendFile, sendImage],
  });
}

function gitTools(): string[] {
  return [
    "Bash(git status:*)",
    "Bash(git diff:*)",
    "Bash(git log:*)",
    "Bash(git add:*)",
    "Bash(git commit:*)",
    "Bash(git push:*)",
    "Bash(git pull:*)",
  ];
}

async function workspaceGitTools(workdir: string): Promise<string[]> {
  try {
    return (await fs.stat(path.join(workdir, ".git"))).isDirectory()
      ? gitTools()
      : [];
  } catch {
    return [];
  }
}

export class ClaudeAgentSdkRunner implements ClaudeAgentRunner {
  constructor(private readonly config: ClaudeAgentRunRequest["config"]) {}

  async availability(): Promise<ClaudeAgentAvailability> {
    if (!this.config.workdir) {
      return { available: false, reason: "WECHAT2ALL_CLAUDE_WORKDIR is not configured." };
    }
    try {
      if (!(await fs.stat(this.config.workdir)).isDirectory()) {
        return { available: false, reason: `Claude workspace is not a directory: ${this.config.workdir}` };
      }
    } catch {
      return { available: false, reason: `Claude workspace does not exist: ${this.config.workdir}` };
    }
    if (!this.config.apiKeyConfigured && !this.config.allowCliAuth) {
      return {
        available: false,
        reason: "ANTHROPIC_API_KEY is not configured. CLI-account auth is disabled by default.",
      };
    }
    return { available: true };
  }

  async run(request: ClaudeAgentRunRequest): Promise<ClaudeAgentRunResult> {
    const availability = await this.availability();
    if (!availability.available) {
      throw new Error(availability.reason ?? "Claude Agent SDK route is unavailable.");
    }
    const workdir = request.config.workdir as string;
    const collector: RunCollector = { outputs: [], resetSessionRequested: false };
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), request.config.timeoutMs);
    timeout.unref?.();

    let text: string | undefined;
    let sessionId = request.resumeSessionId;
    let costUsd: number | undefined;
    let turns: number | undefined;
    let resultError: string | undefined;
    const additionalDirectories = [...new Set([
      path.dirname(request.config.promptFile),
    ])];
    const allowedTools = [
      "Read",
      "Write",
      "Edit",
      "Grep",
      "Glob",
      "WebFetch",
      "WebSearch",
      "mcp__claude_route__status",
      "mcp__claude_route__reset_session",
      "mcp__claude_route__send_file",
      "mcp__claude_route__send_image",
      ...await workspaceGitTools(workdir),
    ];

    try {
      const stream = query({
        prompt: request.prompt,
        options: {
          abortController,
          cwd: workdir,
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: request.systemPrompt,
          },
          settingSources: ["project"],
          allowedTools,
          mcpServers: {
            claude_route: createRouteMcpServer(request, collector),
          },
          permissionMode: "acceptEdits",
          additionalDirectories,
          maxTurns: request.config.maxTurns,
          maxBudgetUsd: request.config.maxBudgetUsd,
          env: {
            ...process.env,
            CLAUDE_AGENT_SDK_CLIENT_APP: "wechat2all-claude-route",
          },
          ...(request.config.model ? { model: request.config.model } : {}),
          ...(request.resumeSessionId ? { resume: request.resumeSessionId } : {}),
          ...(request.config.claudeExecutable
            ? { pathToClaudeCodeExecutable: request.config.claudeExecutable }
            : {}),
        },
      });

      for await (const sdkMessage of stream) {
        const message = sdkMessage as unknown as UnknownMessage;
        if (message.type === "system" && message.subtype === "init") {
          sessionId = stringValue(message.session_id) ?? sessionId;
        }
        if (message.type !== "result") continue;
        sessionId = stringValue(message.session_id) ?? sessionId;
        text = stringValue(message.result) ?? text;
        costUsd = numberValue(message.total_cost_usd) ?? costUsd;
        turns = numberValue(message.num_turns) ?? turns;
        if (message.subtype !== "success") {
          resultError = errorText(message) ?? `Claude run ended with ${String(message.subtype)}.`;
        }
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        throw new Error(`Claude run timed out after ${request.config.timeoutMs}ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (resultError && !text && collector.outputs.length === 0) {
      throw new Error(resultError);
    }
    return {
      text,
      sessionId,
      costUsd,
      turns,
      outputs: collector.outputs,
      resetSessionRequested: collector.resetSessionRequested,
    };
  }
}
