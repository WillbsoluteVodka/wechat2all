import fs from "node:fs/promises";
import path from "node:path";

interface LockFile {
  pid?: number;
  createdAt?: number;
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function readLock(filePath: string): Promise<LockFile | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as LockFile;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class WatcherLock {
  readonly filePath: string;
  private staleAfterMs: number;
  private acquired = false;

  constructor(filePath: string, opts: { staleAfterMs?: number } = {}) {
    this.filePath = filePath;
    this.staleAfterMs = opts.staleAfterMs ?? 10 * 60 * 1000;
  }

  async acquire(): Promise<void> {
    await ensureDir(path.dirname(this.filePath));
    try {
      await fs.writeFile(
        this.filePath,
        JSON.stringify({ pid: process.pid, createdAt: Date.now() }, null, 2),
        { encoding: "utf-8", flag: "wx" },
      );
      this.acquired = true;
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    const existing = await readLock(this.filePath);
    const pid = existing?.pid;
    const createdAt = existing?.createdAt ?? 0;
    const stale = Date.now() - createdAt > this.staleAfterMs;
    if (pid && processIsAlive(pid) && !stale) {
      throw new Error(`Codex watcher already appears to be running (pid ${pid}).`);
    }

    await fs.rm(this.filePath, { force: true });
    await this.acquire();
  }

  async release(): Promise<void> {
    if (!this.acquired) return;
    this.acquired = false;
    await fs.rm(this.filePath, { force: true });
  }
}
