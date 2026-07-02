import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type JsonRecord = Record<string, unknown>;

interface ProbeOptions {
  codexHome: string;
  json: boolean;
  limit: number;
}

interface CodexChat {
  id: string;
  title: string;
  projectPath: string | null;
  projectName: string;
  source: string | null;
  threadSource: string | null;
  sourceKind: string | null;
  sourceDetail: string | null;
  hostId: string | null;
  modelProvider: string | null;
  model: string | null;
  gitBranch: string | null;
  archived: boolean | null;
  createdAt: string | null;
  updatedAt: string | null;
  recencyAt: string | null;
  preview: string | null;
  firstUserMessage: string | null;
  sources: string[];
}

interface CodexProject {
  id: string;
  name: string;
  path: string | null;
  chatCount: number;
  activeChatCount: number;
  archivedChatCount: number;
  latestActivityAt: string | null;
  chats: CodexChat[];
}

interface CodexGuiCatalog {
  generatedAt: string;
  codexHome: string;
  sources: {
    stateDb: string;
    catalogDb: string;
    sessionIndex: string;
  };
  diagnostics: string[];
  projects: CodexProject[];
  chats: CodexChat[];
}

function parseArgs(argv: string[]): ProbeOptions {
  const options: ProbeOptions = {
    codexHome: process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
    json: false,
    limit: 40,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--codex-home") {
      const value = argv[index + 1];
      if (!value) throw new Error("--codex-home requires a path");
      options.codexHome = expandHome(value);
      index += 1;
      continue;
    }
    if (arg === "--limit") {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value < 1) {
        throw new Error("--limit requires a positive number");
      }
      options.limit = value;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printHelp(): void {
  console.log([
    "Usage: pnpm codex-gui-probe [--json] [--limit <n>] [--codex-home <path>]",
    "",
    "Reads local Codex GUI/catalog state from ~/.codex and prints projects + chats.",
    "This is a read-only probe; it does not call Codex and does not modify files.",
  ].join("\n"));
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function sqliteJson<T extends JsonRecord>(dbPath: string, sql: string, diagnostics: string[]): T[] {
  if (!fs.existsSync(dbPath)) {
    diagnostics.push(`missing sqlite db: ${dbPath}`);
    return [];
  }

  const result = spawnSync("sqlite3", ["-readonly", "-json", dbPath, sql], {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) {
    diagnostics.push(`sqlite3 failed for ${dbPath}: ${result.error.message}`);
    return [];
  }
  if (result.status !== 0) {
    diagnostics.push(`sqlite3 failed for ${dbPath}: ${result.stderr.trim()}`);
    return [];
  }

  const text = result.stdout.trim();
  if (!text) return [];
  try {
    return JSON.parse(text) as T[];
  } catch (error) {
    diagnostics.push(`failed to parse sqlite json from ${dbPath}: ${String(error)}`);
    return [];
  }
}

function readSessionIndex(filePath: string, diagnostics: string[]): JsonRecord[] {
  if (!fs.existsSync(filePath)) {
    diagnostics.push(`missing session index: ${filePath}`);
    return [];
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JsonRecord);
  } catch (error) {
    diagnostics.push(`failed to read session index: ${String(error)}`);
    return [];
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asBool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return null;
}

function msToIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value).toISOString();
}

function secondsToIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000).toISOString();
}

function projectName(projectPath: string | null): string {
  if (!projectPath) return "(unknown project)";
  const name = path.basename(projectPath);
  return name || projectPath;
}

function emptyChat(id: string): CodexChat {
  return {
    id,
    title: id,
    projectPath: null,
    projectName: "(unknown project)",
    source: null,
    threadSource: null,
    sourceKind: null,
    sourceDetail: null,
    hostId: null,
    modelProvider: null,
    model: null,
    gitBranch: null,
    archived: null,
    createdAt: null,
    updatedAt: null,
    recencyAt: null,
    preview: null,
    firstUserMessage: null,
    sources: [],
  };
}

function mergeSource(chat: CodexChat, source: string): void {
  if (!chat.sources.includes(source)) chat.sources.push(source);
}

function setIfMissing<T extends keyof CodexChat>(
  chat: CodexChat,
  key: T,
  value: CodexChat[T],
): void {
  if (chat[key] === null || chat[key] === "" || chat[key] === chat.id) {
    chat[key] = value;
  }
}

function buildCatalog(options: ProbeOptions): CodexGuiCatalog {
  const codexHome = expandHome(options.codexHome);
  const stateDb = path.join(codexHome, "state_5.sqlite");
  const catalogDb = path.join(codexHome, "sqlite", "codex-dev.db");
  const sessionIndex = path.join(codexHome, "session_index.jsonl");
  const diagnostics: string[] = [];
  const byId = new Map<string, CodexChat>();

  const stateRows = sqliteJson(stateDb, [
    "select",
    "id,",
    "substr(title, 1, 500) as title,",
    "cwd,",
    "created_at_ms,",
    "updated_at_ms,",
    "recency_at_ms,",
    "archived,",
    "source,",
    "thread_source,",
    "model_provider,",
    "model,",
    "git_branch,",
    "substr(preview, 1, 500) as preview,",
    "substr(first_user_message, 1, 500) as first_user_message",
    "from threads",
    "order by recency_at_ms desc, updated_at_ms desc",
  ].join(" "), diagnostics);

  for (const row of stateRows) {
    const id = asString(row.id);
    if (!id) continue;
    const cwd = asString(row.cwd);
    const chat = byId.get(id) ?? emptyChat(id);
    chat.title = asString(row.title) ?? chat.title;
    chat.projectPath = cwd;
    chat.projectName = projectName(cwd);
    chat.source = asString(row.source);
    chat.threadSource = asString(row.thread_source);
    chat.modelProvider = asString(row.model_provider);
    chat.model = asString(row.model);
    chat.gitBranch = asString(row.git_branch);
    chat.archived = asBool(row.archived);
    chat.createdAt = msToIso(row.created_at_ms);
    chat.updatedAt = msToIso(row.updated_at_ms);
    chat.recencyAt = msToIso(row.recency_at_ms);
    chat.preview = asString(row.preview);
    chat.firstUserMessage = asString(row.first_user_message);
    mergeSource(chat, "state_5.sqlite:threads");
    byId.set(id, chat);
  }

  const catalogRows = sqliteJson(catalogDb, [
    "select",
    "host_id, thread_id, display_title, source_created_at, source_updated_at,",
    "cwd, source_kind, source_detail, model_provider, git_branch",
    "from local_thread_catalog",
    "where missing_candidate = 0",
    "order by source_updated_at desc, source_created_at desc",
  ].join(" "), diagnostics);

  for (const row of catalogRows) {
    const id = asString(row.thread_id);
    if (!id) continue;
    const cwd = asString(row.cwd);
    const chat = byId.get(id) ?? emptyChat(id);
    setIfMissing(chat, "title", asString(row.display_title) ?? chat.title);
    setIfMissing(chat, "projectPath", cwd);
    chat.projectName = projectName(chat.projectPath);
    setIfMissing(chat, "hostId", asString(row.host_id));
    setIfMissing(chat, "sourceKind", asString(row.source_kind));
    setIfMissing(chat, "sourceDetail", asString(row.source_detail));
    setIfMissing(chat, "modelProvider", asString(row.model_provider));
    setIfMissing(chat, "gitBranch", asString(row.git_branch));
    setIfMissing(chat, "createdAt", secondsToIso(row.source_created_at));
    setIfMissing(chat, "updatedAt", secondsToIso(row.source_updated_at));
    setIfMissing(chat, "recencyAt", secondsToIso(row.source_updated_at));
    mergeSource(chat, "codex-dev.db:local_thread_catalog");
    byId.set(id, chat);
  }

  for (const row of readSessionIndex(sessionIndex, diagnostics)) {
    const id = asString(row.id);
    if (!id) continue;
    const chat = byId.get(id) ?? emptyChat(id);
    setIfMissing(chat, "title", asString(row.thread_name) ?? chat.title);
    setIfMissing(chat, "updatedAt", asString(row.updated_at));
    setIfMissing(chat, "recencyAt", asString(row.updated_at));
    mergeSource(chat, "session_index.jsonl");
    byId.set(id, chat);
  }

  const chats = Array.from(byId.values()).sort((left, right) => {
    const rightTime = Date.parse(right.recencyAt ?? right.updatedAt ?? "");
    const leftTime = Date.parse(left.recencyAt ?? left.updatedAt ?? "");
    return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
  });

  const projectMap = new Map<string, CodexProject>();
  for (const chat of chats) {
    const id = chat.projectPath ?? "__unknown__";
    const project = projectMap.get(id) ?? {
      id,
      name: projectName(chat.projectPath),
      path: chat.projectPath,
      chatCount: 0,
      activeChatCount: 0,
      archivedChatCount: 0,
      latestActivityAt: null,
      chats: [],
    };
    project.chats.push(chat);
    project.chatCount += 1;
    if (chat.archived) {
      project.archivedChatCount += 1;
    } else {
      project.activeChatCount += 1;
    }
    if (!project.latestActivityAt || Date.parse(chat.recencyAt ?? "") > Date.parse(project.latestActivityAt)) {
      project.latestActivityAt = chat.recencyAt ?? chat.updatedAt;
    }
    projectMap.set(id, project);
  }

  const projects = Array.from(projectMap.values()).sort((left, right) => {
    const rightTime = Date.parse(right.latestActivityAt ?? "");
    const leftTime = Date.parse(left.latestActivityAt ?? "");
    return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
  });

  return {
    generatedAt: new Date().toISOString(),
    codexHome,
    sources: { stateDb, catalogDb, sessionIndex },
    diagnostics,
    projects,
    chats,
  };
}

function truncate(value: string | null, length: number): string {
  if (!value) return "";
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > length ? `${oneLine.slice(0, length - 1)}…` : oneLine;
}

function printSummary(catalog: CodexGuiCatalog, limit: number): void {
  console.log(`Codex GUI catalog probe`);
  console.log(`CODEX_HOME: ${catalog.codexHome}`);
  console.log(`Projects: ${catalog.projects.length}`);
  console.log(`Chats: ${catalog.chats.length}`);
  if (catalog.diagnostics.length > 0) {
    console.log(`Diagnostics: ${catalog.diagnostics.join(" | ")}`);
  }

  console.log("\nProjects");
  for (const project of catalog.projects.slice(0, limit)) {
    console.log([
      `- ${project.name}`,
      `active=${project.activeChatCount}`,
      `archived=${project.archivedChatCount}`,
      `latest=${project.latestActivityAt ?? "unknown"}`,
      project.path ? `path=${project.path}` : "path=unknown",
    ].join(" | "));
  }

  console.log(`\nChats (top ${Math.min(limit, catalog.chats.length)} by recency)`);
  for (const chat of catalog.chats.slice(0, limit)) {
    console.log([
      `- ${truncate(chat.title, 90)}`,
      `id=${chat.id}`,
      `project=${chat.projectName}`,
      `archived=${chat.archived ?? "unknown"}`,
      `latest=${chat.recencyAt ?? chat.updatedAt ?? "unknown"}`,
      `sources=${chat.sources.join(",")}`,
    ].join(" | "));
  }

  console.log("\nUse --json to print the full structured payload.");
}

const options = parseArgs(process.argv.slice(2));
const catalog = buildCatalog(options);

if (options.json) {
  console.log(JSON.stringify(catalog, null, 2));
} else {
  printSummary(catalog, options.limit);
}
