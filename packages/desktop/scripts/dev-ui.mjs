import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const host = "127.0.0.1";
const port = 5173;
const devUrl = `http://${host}:${port}`;
const probeTimeoutMs = 1200;

function abortAfter(ms) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout),
  };
}

async function probeExistingUi() {
  const timeout = abortAfter(probeTimeoutMs);
  try {
    const response = await fetch(devUrl, { signal: timeout.signal });
    const body = await response.text();
    if (!response.ok) {
      return { ok: false, reason: `HTTP ${response.status}` };
    }

    const isWechat2All =
      body.includes('name="wechat2all-desktop"') ||
      body.includes("<title>wechat2all</title>") ||
      (body.includes('id="root"') && body.includes("/src/main.tsx"));

    if (isWechat2All) return { ok: true };
    return { ok: false, reason: "the existing HTTP server is not wechat2all" };
  } catch (error) {
    return {
      ok: false,
      unavailable: true,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    timeout.clear();
  }
}

async function isPortOpen() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, probeTimeoutMs);

    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(true);
    });

    socket.once("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

function runVite() {
  const child = spawn("vite", ["--host", host], {
    cwd: packageRoot,
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

async function main() {
  const probe = await probeExistingUi();
  if (probe.ok) {
    console.log(`[desktop-dev-ui] Reusing existing wechat2all UI at ${devUrl}`);
    return;
  }

  if (await isPortOpen()) {
    console.error(`[desktop-dev-ui] ${devUrl} is already in use.`);
    console.error(`[desktop-dev-ui] Probe result: ${probe.reason}`);
    console.error(
      "[desktop-dev-ui] If this is stale, run: lsof -nP -iTCP:5173 -sTCP:LISTEN",
    );
    console.error("[desktop-dev-ui] Then stop that PID with: kill <PID>");
    process.exit(1);
  }

  runVite();
}

main().catch((error) => {
  console.error(`[desktop-dev-ui] ${error.message}`);
  process.exit(1);
});
