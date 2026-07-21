import path from "node:path";

import type { LLMMessage } from "@wechat2all/runtime";

import type {
  OfficeCliRunResult,
  OfficePlan,
  OfficeRouteConfig,
} from "./types.js";

const ALLOWED_COMMANDS = new Set([
  "add",
  "add-part",
  "batch",
  "close",
  "copy",
  "create",
  "dump",
  "get",
  "help",
  "merge",
  "move",
  "open",
  "query",
  "raw",
  "raw-set",
  "remove",
  "save",
  "set",
  "swap",
  "validate",
  "view",
]);

const SYSTEM_PROMPT = `You are the planning brain of a WeChat Office document route.
You operate OfficeCLI, a CLI for .docx, .xlsx and .pptx files. You do not have a shell.

Return exactly one JSON object and no markdown:
{"commands":[{"args":["create","report.docx"]}],"done":false,"message":"optional short progress","files":[]}

Rules:
- args excludes the executable name; each item is one literal argv item.
- Work only with relative paths in the current private workspace. Never use absolute paths or '..'.
- Use --json whenever supported so observations are structured.
- Use OfficeCLI help when syntax or properties are uncertain; never guess repeatedly.
- Prefer L1 view, then L2 DOM commands, and raw XML only as a last resort.
- You may issue several independent commands in one response, in execution order.
- After command observations, fix errors and continue until the user's request is complete.
- Before delivery, validate the document and close/save resident files.
- When complete, set done=true, commands=[], and list every deliverable Office file in files.
- files may contain only .docx, .xlsx, or .pptx files in the workspace.
- Keep message concise and in the user's language.
- Never call install, mcp, config, watch, or any external process.`;

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1];
  const candidate = fenced ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error("LLM did not return a JSON object.");
  }
}

function safeRelativePath(value: string): boolean {
  if (!value || value.includes("\0") || value.includes("..")) return false;
  if (path.isAbsolute(value)) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(value);
}

function isOfficeElementPath(value: string, index: number, previous: string | undefined): boolean {
  const selectorPosition = index === 2
    || previous === "--to"
    || previous === "--from"
    || previous === "--before"
    || previous === "--after"
    || previous === "--path";
  return selectorPosition
    && (value === "/" || /^\/[a-zA-Z@*][^\0]*$/.test(value))
    && !/\.(docx|xlsx|pptx|json|png|jpe?g|gif|svg|csv)(?:$|[?#])/i.test(value);
}

function possiblePathValue(value: string): string {
  const equals = value.indexOf("=");
  if (equals > 0 && /^[\w.-]+$/.test(value.slice(0, equals).replace(/^--/, ""))) {
    return value.slice(equals + 1);
  }
  return value;
}

function validateArgs(args: unknown, maxArgs = 128): string[] {
  if (!Array.isArray(args) || args.length === 0 || args.length > maxArgs) {
    throw new Error("Each OfficeCLI command needs a non-empty args array.");
  }
  const values = args.map((item) => {
    if (typeof item !== "string" || item.length > 8_192 || item.includes("\0")) {
      throw new Error("OfficeCLI arguments must be bounded strings.");
    }
    return item;
  });
  const verb = values[0]?.toLowerCase();
  if (!verb || !ALLOWED_COMMANDS.has(verb)) {
    throw new Error(`OfficeCLI command is not allowed: ${values[0] ?? "(missing)"}.`);
  }
  for (let index = 1; index < values.length; index += 1) {
    const value = values[index] as string;
    const candidate = possiblePathValue(value);
    if (
      (candidate.includes("/") || candidate.includes("\\") || /\.(docx|xlsx|pptx|json|png|jpe?g|gif|svg|csv)$/i.test(candidate))
      && !value.startsWith("/")
      && !safeRelativePath(candidate)
    ) {
      throw new Error(`Unsafe OfficeCLI path argument: ${value}.`);
    }
    if (
      (path.isAbsolute(candidate) && !isOfficeElementPath(value, index, values[index - 1]))
      || candidate.includes("../")
      || candidate.includes("..\\")
    ) {
      throw new Error(`Unsafe OfficeCLI path argument: ${value}.`);
    }
  }
  return values;
}

export function parseOfficePlan(text: string, maxCommands: number): OfficePlan {
  const value = extractJson(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("LLM plan must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  const rawCommands = record.commands ?? [];
  if (!Array.isArray(rawCommands) || rawCommands.length > maxCommands) {
    throw new Error(`LLM plan may contain at most ${maxCommands} commands.`);
  }
  const commands = rawCommands.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Invalid OfficeCLI command object.");
    }
    return { args: validateArgs((item as Record<string, unknown>).args) };
  });
  const files = record.files === undefined
    ? undefined
    : Array.isArray(record.files)
    ? record.files.map((file) => {
        if (
          typeof file !== "string"
          || !safeRelativePath(file)
          || !/\.(docx|xlsx|pptx)$/i.test(file)
        ) {
          throw new Error(`Invalid Office deliverable path: ${String(file)}.`);
        }
        return file;
      })
    : (() => { throw new Error("files must be an array."); })();
  const done = record.done === true;
  if (done && commands.length > 0) {
    throw new Error("A completed plan cannot contain more commands.");
  }
  return {
    commands,
    done,
    message: typeof record.message === "string" ? record.message.slice(0, 2_000) : undefined,
    files,
  };
}

function observation(args: string[], result: OfficeCliRunResult, maxChars: number): string {
  return JSON.stringify({
    command: args,
    exitCode: result.exitCode,
    stdout: result.stdout.slice(0, maxChars),
    stderr: result.stderr.slice(0, maxChars),
  });
}

export interface RunOfficeAgentRequest {
  userText: string;
  workspace: string;
  availableFiles: string[];
  config: OfficeRouteConfig;
  onProgress?: (message: string) => Promise<void> | void;
}

export async function runOfficeAgent(
  request: RunOfficeAgentRequest,
): Promise<{ message: string; files: string[] }> {
  const messages: LLMMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        `User request: ${request.userText || "Process the attached Office files."}`,
        `Files currently available: ${JSON.stringify(request.availableFiles)}`,
      ].join("\n"),
    },
  ];

  for (let turn = 1; turn <= request.config.maxTurns; turn += 1) {
    const response = await request.config.llm.generate(messages, {
      temperature: 0.1,
    });
    let plan: OfficePlan;
    try {
      plan = parseOfficePlan(response.text, request.config.maxCommandsPerTurn);
    } catch (error) {
      messages.push({ role: "assistant", content: response.text });
      messages.push({
        role: "user",
        content: `Your response was invalid: ${error instanceof Error ? error.message : String(error)} Return only a corrected JSON object.`,
      });
      continue;
    }
    messages.push({ role: "assistant", content: JSON.stringify(plan) });

    if (plan.message && !plan.done) await request.onProgress?.(plan.message);
    if (plan.done) {
      return {
        message: plan.message?.trim() || "Office 文档已处理完成。",
        files: plan.files ?? [],
      };
    }
    if (plan.commands.length === 0) {
      messages.push({
        role: "user",
        content: "No commands were supplied and the task is not done. Issue commands or finish the task.",
      });
      continue;
    }

    const results: string[] = [];
    for (const command of plan.commands) {
      const result = await request.config.cli.run({
        args: command.args,
        cwd: request.workspace,
        timeoutMs: request.config.commandTimeoutMs,
      });
      results.push(observation(command.args, result, request.config.maxOutputChars));
    }
    messages.push({
      role: "user",
      content: `OfficeCLI observations:\n${results.join("\n")}`,
    });
  }

  throw new Error(`Office agent exceeded its ${request.config.maxTurns}-turn limit.`);
}
