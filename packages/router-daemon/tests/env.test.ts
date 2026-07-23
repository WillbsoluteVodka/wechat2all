import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadEnvFile,
  loadLocalEnv,
  persistentLocalEnvPath,
  resolveLocalEnvPath,
} from "../src/env.js";
import { LlmHealthService } from "../src/llm-health.js";
import { LocalConfigStore } from "../src/local-config.js";

test("the selected local config file overrides stale inherited values", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "weconnect-env-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, ".env.local");
  await fs.writeFile(
    filePath,
    [
      "WECHAT2ALL_LLM_PROVIDER=openai-compatible",
      "WECHAT2ALL_LLM_API_KEY=sk-saved",
      "WECHAT2ALL_LLM_MODEL=deepseek-chat",
      "",
    ].join("\n"),
  );
  const env: NodeJS.ProcessEnv = {
    WECHAT2ALL_ENV_FILE: filePath,
    WECHAT2ALL_LLM_PROVIDER: "mock",
    WECHAT2ALL_LLM_API_KEY: "",
  };

  assert.equal(loadLocalEnv(undefined, env), filePath);
  assert.equal(env.WECHAT2ALL_LLM_PROVIDER, "openai-compatible");
  assert.equal(env.WECHAT2ALL_LLM_API_KEY, "sk-saved");
  assert.equal(env.WECHAT2ALL_LLM_MODEL, "deepseek-chat");
});

test("loadEnvFile preserves inherited values unless override is requested", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "weconnect-env-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, ".env.local");
  await fs.writeFile(filePath, "EXAMPLE_VALUE=from-file\n");
  const env: NodeJS.ProcessEnv = { EXAMPLE_VALUE: "from-process" };

  assert.equal(loadEnvFile(filePath, undefined, { env }), true);
  assert.equal(env.EXAMPLE_VALUE, "from-process");
  assert.equal(loadEnvFile(filePath, undefined, { env, override: true }), true);
  assert.equal(env.EXAMPLE_VALUE, "from-file");
});

test("explicit and packaged config paths are deterministic", () => {
  assert.equal(
    resolveLocalEnvPath({ WECHAT2ALL_ENV_FILE: "./custom.env" }),
    path.resolve("./custom.env"),
  );
  assert.equal(
    persistentLocalEnvPath({}, "darwin", "/Users/example"),
    "/Users/example/Library/Application Support/WeConnect/config/.env.local",
  );
});

test("Config save survives a daemon restart and becomes usable", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "weconnect-config-restart-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, ".env.local");
  const store = new LocalConfigStore({ filePath, env: {} });

  await store.update({
    llm: {
      provider: "openai-compatible",
      apiKey: "sk-saved-on-first-run",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com/v1",
    },
  });

  const restartedEnv: NodeJS.ProcessEnv = {
    WECHAT2ALL_ENV_FILE: filePath,
    WECHAT2ALL_LLM_PROVIDER: "mock",
    WECHAT2ALL_LLM_API_KEY: "",
  };
  loadLocalEnv(undefined, restartedEnv);
  const health = new LlmHealthService({
    env: restartedEnv,
    createProvider: () => ({
      id: "restart-test",
      async generate() {
        return { text: "OK" };
      },
    }),
  });

  const result = await health.check();
  assert.equal(result.status, "ready");
  assert.equal(result.configured, true);
  assert.equal(result.usable, true);
  assert.equal(result.provider, "openai-compatible");
  assert.equal(result.model, "deepseek-chat");
});
