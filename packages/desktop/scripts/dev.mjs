import { execFile, spawn } from "node:child_process";
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
const restartExisting = process.env.WECHAT2ALL_DESKTOP_RESTART !== "0";
const uiDevUrl = process.env.WECHAT2ALL_DESKTOP_DEV_URL ?? "http://127.0.0.1:5173";

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
      WECHAT2ALL_ENABLE_DEV_SHUTDOWN: "1",
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

async function readText(url, timeoutMs = 1000) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return undefined;
    return await response.text();
  } catch {
    return undefined;
  }
}

async function postJson(url, timeoutMs = 1000) {
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function existingDaemon() {
  const baseUrl = daemonUrl.replace(/\/$/, "");
  const health = await readJson(`${baseUrl}/health`);
  if (!health?.ok) return undefined;

  return health;
}

function portFromUrl(value) {
  const url = new URL(value);
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

function execFileOutput(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 3000 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: stdout?.toString() ?? "",
        stderr: stderr?.toString() ?? "",
        error,
      });
    });
  });
}

async function pidsListeningOnPort(port) {
  const result = await execFileOutput("lsof", [
    "-nP",
    `-iTCP:${port}`,
    "-sTCP:LISTEN",
    "-t",
  ]);
  return result.stdout
    .split(/\s+/)
    .map((pid) => Number(pid))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

async function waitUntil(label, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  console.warn(`[desktop-dev] Timed out waiting for ${label}`);
  return false;
}

async function killPortListeners(port, label) {
  const pids = await pidsListeningOnPort(port);
  if (!pids.length) return;

  console.log(`[desktop-dev] Stopping stale ${label} on port ${port}: ${pids.join(", ")}`);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 800));

  for (const pid of pids) {
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

async function pidsByExactProcessName(name) {
  const result = await execFileOutput("pgrep", ["-x", name]);
  return result.stdout
    .split(/\s+/)
    .map((pid) => Number(pid))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

async function killPids(pids, label) {
  if (!pids.length) return;

  console.log(`[desktop-dev] Stopping stale ${label}: ${pids.join(", ")}`);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 800));

  for (const pid of pids) {
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

async function stopExistingDesktopShell() {
  await killPids(await pidsByExactProcessName("wechat2all"), "desktop app");
}

async function stopExistingDaemon() {
  const daemon = await existingDaemon();
  if (!daemon) return;

  const port = portFromUrl(daemonUrl);
  console.log(`[desktop-dev] Restarting router-daemon at ${daemonUrl}`);
  await postJson(`${daemonUrl.replace(/\/$/, "")}/dev/shutdown`);

  const stopped = await waitUntil(
    "router-daemon shutdown",
    async () => !(await existingDaemon()),
    3000,
  );
  if (stopped) return;

  await killPortListeners(port, "router-daemon");
  await waitUntil(
    "router-daemon port release",
    async () => !(await existingDaemon()),
    3000,
  );
}

async function isWechat2AllUiRunning() {
  const body = await readText(uiDevUrl);
  return Boolean(
    body &&
      (
        body.includes('name="wechat2all-desktop"') ||
        body.includes("<title>wechat2all</title>") ||
        (body.includes('id="root"') && body.includes("/src/main.tsx"))
      ),
  );
}

async function stopExistingUi() {
  if (!(await isWechat2AllUiRunning())) return;
  const port = portFromUrl(uiDevUrl);
  await killPortListeners(port, "desktop UI");
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
  if (restartExisting) {
    await stopExistingDesktopShell();
    await stopExistingDaemon();
    await stopExistingUi();
    run("router-daemon", ["--filter", "@wechat2all/router-daemon", "dev"]);
  } else {
    const daemon = await existingDaemon();
    if (daemon) {
      console.log(`[desktop-dev] Reusing existing router-daemon at ${daemonUrl}`);
    } else {
      run("router-daemon", ["--filter", "@wechat2all/router-daemon", "dev"]);
    }
  }
  await waitForHealth();
  run("tauri", ["--filter", "@wechat2all/desktop", "dev:app"]);
}

main().catch((error) => {
  console.error(`[desktop-dev] ${error.message}`);
  shutdown(1);
});
