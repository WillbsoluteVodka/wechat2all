import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const children = [];
const ownedChildren = new Set();
const daemonUrl =
  process.env.WECHAT2ALL_ROUTER_DAEMON_URL ?? "http://127.0.0.1:39787";
const requestedCodexBackend = process.env.WECHAT2ALL_CODEX_BACKEND ?? "file";

function mergeNoProxy(value) {
  const current = value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
  for (const host of ["127.0.0.1", "localhost", "::1"]) {
    if (!current.includes(host)) current.push(host);
  }
  return current.join(",");
}

function run(name, args) {
  const child = spawn("pnpm", args, {
    cwd: repoRoot,
    stdio: "inherit",
    detached: true,
    env: {
      ...process.env,
      WECHAT2ALL_ROUTER_DAEMON_URL: daemonUrl,
      NO_PROXY: mergeNoProxy(process.env.NO_PROXY),
      no_proxy: mergeNoProxy(process.env.no_proxy),
    },
  });
  children.push(child);
  ownedChildren.add(child);
  child.on("exit", (code, signal) => {
    ownedChildren.delete(child);
    if (shuttingDown) return;
    if (code !== 0) {
      console.error(`[desktop-dev] ${name} exited with code ${code ?? signal}`);
      shutdown(code ?? 1);
    }
  });
}

async function readJson(url, timeoutMs = 1000) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  }
}

async function existingDaemon() {
  const baseUrl = daemonUrl.replace(/\/$/, "");
  const health = await readJson(`${baseUrl}/health`);
  if (!health?.ok) return undefined;

  const snapshot = await readJson(`${baseUrl}/snapshot`);
  return {
    health,
    codexBackend:
      snapshot?.settings?.codexBackend ??
      health.codexBackend,
  };
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of ownedChildren) {
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
    } catch {
      if (!child.killed) child.kill("SIGTERM");
    }
  }
  setTimeout(() => {
    for (const child of ownedChildren) {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // The process group already exited.
      }
    }
  }, 1500).unref();
  setTimeout(() => process.exit(code), 250);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function waitForHealth(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  const url = `${daemonUrl.replace(/\/$/, "")}/health`;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return;
    } catch {
      // Keep waiting while the daemon boots.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  throw new Error(`router-daemon did not become healthy at ${url}`);
}

async function main() {
  const daemon = await existingDaemon();
  if (daemon) {
    if (daemon.codexBackend && daemon.codexBackend !== requestedCodexBackend) {
      throw new Error(
        `router-daemon is already running at ${daemonUrl} with codex backend ` +
          `${daemon.codexBackend}, but this desktop session requested ${requestedCodexBackend}. ` +
          "Stop the existing daemon first, or start with the same WECHAT2ALL_CODEX_BACKEND.",
      );
    }
    console.log(`[desktop-dev] Reusing existing router-daemon at ${daemonUrl}`);
  } else {
    run("router-daemon", ["--filter", "@wechat2all/router-daemon", "dev"]);
  }
  await waitForHealth();
  run("tauri", ["--filter", "@wechat2all/desktop", "dev:app"]);
}

main().catch((error) => {
  console.error(`[desktop-dev] ${error.message}`);
  shutdown(1);
});
