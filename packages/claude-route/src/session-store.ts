import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type {
  ClaudeSessionStore,
  ClaudeStoredSession,
} from "./types.js";

interface SessionDocument {
  version: 1;
  sessions: Record<string, ClaudeStoredSession>;
}

const EMPTY_DOCUMENT: SessionDocument = { version: 1, sessions: {} };

async function readDocument(filePath: string): Promise<SessionDocument> {
  try {
    const raw = JSON.parse(await fs.readFile(filePath, "utf-8")) as Partial<SessionDocument>;
    if (raw.version !== 1 || !raw.sessions || typeof raw.sessions !== "object") {
      throw new Error(`Unsupported Claude route session document: ${filePath}`);
    }
    return { version: 1, sessions: raw.sessions };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...EMPTY_DOCUMENT, sessions: {} };
    }
    throw error;
  }
}

async function writeDocument(filePath: string, document: SessionDocument): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(tempPath, filePath);
    await fs.chmod(filePath, 0o600).catch(() => undefined);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export class FileClaudeSessionStore implements ClaudeSessionStore {
  readonly filePath: string;
  private operation: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
  }

  get(key: string): Promise<ClaudeStoredSession | null> {
    return this.enqueue(async () => {
      const value = (await readDocument(this.filePath)).sessions[key];
      return value ? { ...value } : null;
    });
  }

  set(key: string, value: ClaudeStoredSession): Promise<void> {
    return this.enqueue(async () => {
      const document = await readDocument(this.filePath);
      document.sessions[key] = { ...value };
      await writeDocument(this.filePath, document);
    });
  }

  clear(key: string): Promise<void> {
    return this.enqueue(async () => {
      const document = await readDocument(this.filePath);
      if (!(key in document.sessions)) return;
      delete document.sessions[key];
      await writeDocument(this.filePath, document);
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.operation.then(task, task);
    this.operation = next.then(() => undefined, () => undefined);
    return next;
  }
}
