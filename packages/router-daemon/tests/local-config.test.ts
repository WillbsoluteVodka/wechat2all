import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { RouteConfigExtensionV1 } from "@wechat2all/route-sdk";

import {
  LocalConfigStore,
  LocalConfigValidationError,
} from "../src/local-config.js";

const sampleRouteConfigExtension: RouteConfigExtensionV1 = {
  key: "sampleRoute",
  fields: { mode: "WECHAT2ALL_TEST_ROUTE_MODE" },
  parsePatch(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("sampleRoute must be a JSON object.");
    }
    const config = value as Record<string, unknown>;
    const unknown = Object.keys(config).filter((key) => key !== "mode");
    if (unknown.length > 0) {
      throw new Error(
        `sampleRoute contains unsupported field(s): ${unknown.join(", ")}.`,
      );
    }
    if (config.mode === undefined) return {};
    if (config.mode === null || config.mode === "") return { mode: null };
    if (config.mode === "direct" || config.mode === "proxy") {
      return { mode: config.mode };
    }
    throw new Error("sampleRoute.mode must be one of: direct, proxy; or null.");
  },
  snapshot(env) {
    return {
      mode: env.WECHAT2ALL_TEST_ROUTE_MODE === "proxy" ? "proxy" : "direct",
    };
  },
};

async function tempEnvPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-config-"));
  return path.join(dir, ".env.local");
}

function localConfigStore(filePath: string): LocalConfigStore {
  return new LocalConfigStore({
    filePath,
    env: {},
    extensions: [sampleRouteConfigExtension],
  });
}

test("core config store has no route schema until its extension is installed", async () => {
  const store = new LocalConfigStore({ filePath: await tempEnvPath(), env: {} });

  assert.equal("sampleRoute" in await store.snapshot(), false);
  await assert.rejects(
    store.update({ sampleRoute: { mode: "direct" } }),
    /unsupported field/,
  );
});

test("config snapshot masks secrets instead of returning API keys", async () => {
  const filePath = await tempEnvPath();
  await fs.writeFile(filePath, [
    "WECHAT2ALL_LLM_PROVIDER=openai-compatible",
    "WECHAT2ALL_LLM_API_KEY=sk-example-secret-1234",
    "WECHAT2ALL_LLM_MODEL=deepseek-chat",
    "WECHAT2ALL_MEM0_API_KEY=m0-example-secret-5678",
    "ANTHROPIC_API_KEY=sk-ant-example-secret-9012",
    "WECHAT2ALL_CLAUDE_WORKDIR=/Users/example/Notes",
    "",
  ].join("\n"));
  const store = localConfigStore(filePath);

  const snapshot = await store.snapshot();

  assert.deepEqual(snapshot.llm.apiKey, {
    configured: true,
    masked: "sk-...1234",
  });
  assert.deepEqual(snapshot.memory.apiKey, {
    configured: true,
    masked: "m0-...5678",
  });
  assert.deepEqual(snapshot.claude.apiKey, {
    configured: true,
    masked: "sk-...9012",
  });
  assert.equal(snapshot.claude.workdir, "/Users/example/Notes");
  assert.equal(JSON.stringify(snapshot).includes("example-secret"), false);
  assert.equal(snapshot.runtimeApplied, true);
  assert.equal(snapshot.restartRequired, false);
  assert.equal(
    (snapshot.sampleRoute as { mode: string }).mode,
    "direct",
  );
});

test("config update preserves unrelated env content and writes a private file", async () => {
  const filePath = await tempEnvPath();
  await fs.writeFile(filePath, [
    "# user-owned setting",
    "UNRELATED_SETTING=keep-me",
    "WECHAT2ALL_LLM_API_KEY=old-key",
    "WECHAT2ALL_MEM0_API_KEY=remove-me",
    "",
  ].join("\n"));
  const store = localConfigStore(filePath);

  const result = await store.update({
    llm: {
      provider: "openai-compatible",
      apiKey: "sk-new-secret-9999",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com/v1/",
      maxTokens: "1200",
    },
    memory: {
      provider: "local",
      apiKey: null,
    },
    sampleRoute: {
      mode: "proxy",
    },
    claude: {
      apiKey: "sk-ant-new-secret-2468",
      workdir: "/Users/example/Claude Vault",
      model: "claude-sonnet-4-5",
      language: "zh",
      sessionWindowMinutes: 20,
      maxTurns: 30,
      maxBudgetUsd: 2.5,
      allowCliAuth: false,
    },
  });

  const raw = await fs.readFile(filePath, "utf-8");
  assert.match(raw, /# user-owned setting/);
  assert.match(raw, /UNRELATED_SETTING=keep-me/);
  assert.match(raw, /WECHAT2ALL_LLM_API_KEY=sk-new-secret-9999/);
  assert.match(raw, /WECHAT2ALL_LLM_BASE_URL=https:\/\/api\.deepseek\.com\/v1/);
  assert.doesNotMatch(raw, /remove-me|WECHAT2ALL_MEM0_API_KEY/);
  assert.match(raw, /ANTHROPIC_API_KEY=sk-ant-new-secret-2468/);
  assert.match(raw, /WECHAT2ALL_CLAUDE_WORKDIR=\/Users\/example\/Claude Vault/);
  assert.match(raw, /WECHAT2ALL_CLAUDE_SESSION_WINDOW_MINUTES=20/);
  assert.match(raw, /WECHAT2ALL_TEST_ROUTE_MODE=proxy/);
  assert.equal((await fs.stat(filePath)).mode & 0o077, 0);
  assert.equal(result.changed, true);
  assert.equal(result.config.restartRequired, true);
  assert.equal(result.config.runtimeApplied, false);
  assert.deepEqual(result.config.llm.apiKey, {
    configured: true,
    masked: "sk-...9999",
  });
  assert.deepEqual(result.config.claude.apiKey, {
    configured: true,
    masked: "sk-...2468",
  });
  assert.equal(result.config.claude.allowCliAuth, false);
  assert.equal(
    (result.config.sampleRoute as { mode: string }).mode,
    "proxy",
  );
});

test("omitted config fields remain unchanged and a no-op update needs no restart", async () => {
  const filePath = await tempEnvPath();
  await fs.writeFile(filePath, [
    "WECHAT2ALL_LLM_API_KEY=keep-this-secret",
    "WECHAT2ALL_LLM_MODEL=deepseek-chat",
    "",
  ].join("\n"));
  const store = localConfigStore(filePath);

  const result = await store.update({
    llm: {
      apiKey: "",
      model: "deepseek-chat",
    },
  });

  assert.equal(result.changed, false);
  assert.deepEqual(result.changedFields, []);
  assert.equal(result.config.restartRequired, false);
  assert.match(await fs.readFile(filePath, "utf-8"), /keep-this-secret/);
});

test("replacing route extensions preserves pending restart state", async () => {
  const filePath = await tempEnvPath();
  const store = localConfigStore(filePath);
  await store.update({ llm: { model: "changed-after-start" } });

  await store.replaceExtensions([]);
  const snapshot = await store.snapshot();

  assert.equal(snapshot.restartRequired, true);
  assert.equal(snapshot.runtimeApplied, false);
  assert.equal("sampleRoute" in snapshot, false);
});

test("config validation rejects arbitrary env fields and unsafe values", async () => {
  const store = localConfigStore(await tempEnvPath());

  await assert.rejects(
    store.update({ llm: { apiKey: "secret\nINJECTED=value" } }),
    LocalConfigValidationError,
  );
  await assert.rejects(
    store.update({ llm: { arbitraryEnvName: "value" } }),
    /unsupported field/,
  );
  await assert.rejects(
    store.update({ memory: { baseUrl: "file:///tmp/mem0" } }),
    /http or https/,
  );
  await assert.rejects(
    store.update({ claude: { language: "fr" } }),
    /must be one of/,
  );
  await assert.rejects(
    store.update({ claude: { allowCliAuth: "sometimes" } }),
    /must be a boolean/,
  );
});
