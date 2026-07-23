import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const hostDefault = "127.0.0.1";
const portDefault = 39787;
const probeTimeoutMs = 1200;

function stripEnvQuotes(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function loadEnvFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = stripEnvQuotes(trimmed.slice(index + 1).trim());
    process.env[key] = value;
  }
}

function loadLocalEnv() {
  const filePath = process.env.WECHAT2ALL_ENV_FILE
    ? path.resolve(process.env.WECHAT2ALL_ENV_FILE)
    : path.resolve(repoRoot, ".env.local");
  loadEnvFile(filePath);
  process.env.WECHAT2ALL_ENV_FILE = filePath;
}

function routerAddress() {
  const host = process.env.WECHAT2ALL_ROUTER_HOST ?? hostDefault;
  const rawPort = Number(process.env.WECHAT2ALL_ROUTER_PORT ?? portDefault);
  const port = Number.isFinite(rawPort) && rawPort > 0 ? rawPort : portDefault;
  return { host, port, url: `http://${host}:${port}` };
}

function abortAfter(ms) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout),
  };
}

async function fetchJson(url) {
  const timeout = abortAfter(probeTimeoutMs);
  try {
    const response = await fetch(url, { signal: timeout.signal });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  } finally {
    timeout.clear();
  }
}

async function probeDaemon(baseUrl) {
  const health = await fetchJson(`${baseUrl}/health`);
  if (!health?.ok) return undefined;
  return { health };
}

function runDaemon() {
  const child = spawn("tsx", ["watch", "--clear-screen=false", "src/index.ts"], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
  });

  const stop = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });
}

function runPnpm(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", args, {
      cwd: repoRoot,
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`pnpm ${args.join(" ")} exited with ${code ?? signal}`));
    });
  });
}

async function buildRuntimeDependencies() {
  console.log("[router-daemon-dev] Building workspace runtime dependencies...");
  await runPnpm([
    "--filter",
    "wechat2all",
    "--filter",
    "@wechat2all/route-sdk",
    "--filter",
    "@wechat2all/claude-route",
    "--filter",
    "@wechat2all/runtime",
    "build",
  ]);
}

async function main() {
  loadLocalEnv();
  await buildRuntimeDependencies();
  const { url } = routerAddress();
  const existing = await probeDaemon(url);

  if (existing) {
    console.log(`[router-daemon-dev] Reusing existing router-daemon at ${url}`);
    return;
  }

  runDaemon();
}

main().catch((error) => {
  console.error(`[router-daemon-dev] ${error.message}`);
  process.exit(1);
});
