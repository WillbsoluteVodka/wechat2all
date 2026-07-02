import fs from "node:fs/promises";
import path from "node:path";

import type {
  AgentMemoryAppendTurnParams,
  AgentMemoryHit,
  AgentMemoryProvider,
  AgentMemorySearchParams,
} from "./types.js";

export interface LocalJsonlAgentMemoryProviderOptions {
  id?: string;
  baseDir: string;
  maxSearchRows?: number;
}

interface LocalJsonlRecord {
  id: string;
  type: "turn";
  createdAt: number;
  scope: AgentMemoryAppendTurnParams["scope"];
  input: AgentMemoryAppendTurnParams["input"];
  output?: AgentMemoryAppendTurnParams["output"];
  metadata?: Record<string, unknown>;
}

function safeSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_.-]+/g, "-") || "unknown";
}

function recordPath(baseDir: string, profileId: string): string {
  return path.join(baseDir, safeSegment(profileId), "turns.jsonl");
}

function tokenize(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}_/-]+/u)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2),
    ),
  ];
}

function scoreRecord(record: LocalJsonlRecord, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const text = `${record.input.content}\n${record.output?.content ?? ""}`.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (text.includes(token)) score += 1;
  }
  if (record.output?.content) score += 0.1;
  return score;
}

function recordToHit(record: LocalJsonlRecord, score: number): AgentMemoryHit {
  const parts = [`User: ${record.input.content}`];
  if (record.output?.content) {
    parts.push(`Assistant: ${record.output.content}`);
  }
  return {
    id: record.id,
    content: parts.join("\n"),
    score,
    metadata: {
      ...record.metadata,
      provider: "local-jsonl",
      createdAt: record.createdAt,
      routeId: record.scope.routeId,
      connectorId: record.scope.connectorId,
      conversationId: record.scope.conversationId,
      senderId: record.scope.senderId,
    },
  };
}

async function readRecords(filePath: string): Promise<LocalJsonlRecord[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return [];
  }
  const records: LocalJsonlRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as LocalJsonlRecord);
    } catch {
      // Ignore a malformed line instead of losing the whole local memory file.
    }
  }
  return records;
}

export function createLocalJsonlAgentMemoryProvider(
  opts: LocalJsonlAgentMemoryProviderOptions,
): AgentMemoryProvider {
  const maxSearchRows = opts.maxSearchRows ?? 2_000;

  return {
    id: opts.id ?? "local-jsonl-agent-memory",
    async appendTurn(params: AgentMemoryAppendTurnParams): Promise<void> {
      const filePath = recordPath(opts.baseDir, params.scope.profileId);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const record: LocalJsonlRecord = {
        id: `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        type: "turn",
        createdAt: Date.now(),
        scope: params.scope,
        input: params.input,
        output: params.output,
        metadata: params.metadata,
      };
      await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf-8");
    },
    async search(params: AgentMemorySearchParams): Promise<AgentMemoryHit[]> {
      const filePath = recordPath(opts.baseDir, params.scope.profileId);
      const records = (await readRecords(filePath))
        .filter((record) =>
          record.scope.senderId === params.scope.senderId &&
          (
            record.scope.routeId === params.scope.routeId ||
            record.scope.routeId === "main-assistant-default"
          ),
        )
        .slice(-maxSearchRows);
      const queryTokens = tokenize(params.query);
      return records
        .map((record) => ({ record, score: scoreRecord(record, queryTokens) }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, params.limit ?? 10)
        .map(({ record, score }) => recordToHit(record, score));
    },
  };
}
