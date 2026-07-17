import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  UpochiConfigStore,
  UpochiConfigValidationError,
  UpochiProjectNotFoundError,
} from "../src/upochi-config.js";

async function createUpochiProject(parent: string, name = "UPochi-feature-ai-todo-calendar") {
  const projectPath = path.join(parent, name);
  await fs.mkdir(path.join(projectPath, "apps", "desktop", "src", "config"), {
    recursive: true,
  });
  await fs.writeFile(path.join(projectPath, "pyproject.toml"), "[project]\nname='upochi'\n");
  await fs.writeFile(path.join(projectPath, ".env.example"), [
    "# Upochi local-first configuration",
    "UNRELATED_SETTING=keep-me",
    "LLM_ENDPOINT=",
    "LLM_MODEL=",
    "LLM_API_KEY=",
    "LLM_TEMPERATURE=0.2",
    "",
  ].join("\n"));
  return projectPath;
}

test("Upochi config discovers a sibling project and reads the env template", async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-upochi-home-"));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  const desktopPath = path.join(homeDir, "Desktop");
  const cwd = path.join(desktopPath, "wechat2all", "packages", "router-daemon");
  await fs.mkdir(cwd, { recursive: true });
  const projectPath = await createUpochiProject(desktopPath);

  const config = await new UpochiConfigStore({ cwd, homeDir, env: {} }).snapshot();

  assert.equal(config.projectPath, projectPath);
  assert.equal(config.envPath, path.join(projectPath, ".env"));
  assert.equal(config.envExists, false);
  assert.equal(config.llm.model, null);
  assert.deepEqual(config.llm.apiKey, { configured: false, masked: null });
});

test("Upochi config creates a private .env and derives endpoint from model", async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-upochi-config-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const projectPath = await createUpochiProject(parent);
  const store = new UpochiConfigStore({
    env: { WECHAT2ALL_UPOCHI_PROJECT_DIR: projectPath },
    cwd: parent,
    homeDir: parent,
  });

  const result = await store.update({
    model: "deepseek-chat",
    apiKey: "sk-upochi-secret-1234",
  });

  const envPath = path.join(projectPath, ".env");
  const raw = await fs.readFile(envPath, "utf-8");
  assert.match(raw, /UNRELATED_SETTING=keep-me/);
  assert.match(raw, /LLM_ENDPOINT=https:\/\/api\.deepseek\.com\/v1/);
  assert.match(raw, /LLM_MODEL=deepseek-chat/);
  assert.match(raw, /LLM_API_KEY=sk-upochi-secret-1234/);
  assert.match(raw, /LLM_TEMPERATURE=0\.2/);
  assert.equal((await fs.stat(envPath)).mode & 0o077, 0);
  assert.equal(result.changed, true);
  assert.deepEqual(result.changedFields, ["LLM_ENDPOINT", "LLM_MODEL", "LLM_API_KEY"]);
  assert.equal(result.config.envExists, true);
  assert.equal(result.config.restartRequired, true);
  assert.deepEqual(result.config.llm.apiKey, {
    configured: true,
    masked: "sk-...1234",
  });
  assert.equal(JSON.stringify(result).includes("upochi-secret"), false);
});

test("blank key keeps the saved Upochi key and null clears it", async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-upochi-key-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const projectPath = await createUpochiProject(parent);
  await fs.writeFile(path.join(projectPath, ".env"), [
    "LLM_ENDPOINT=https://api.openai.com/v1",
    "LLM_MODEL=gpt-4.1-mini",
    "LLM_API_KEY=keep-this-key",
    "",
  ].join("\n"));
  const store = new UpochiConfigStore({
    env: { WECHAT2ALL_UPOCHI_PROJECT_DIR: projectPath },
    cwd: parent,
    homeDir: parent,
  });

  const unchanged = await store.update({ model: "gpt-4.1-mini", apiKey: "" });
  assert.equal(unchanged.changed, false);
  assert.match(await fs.readFile(path.join(projectPath, ".env"), "utf-8"), /keep-this-key/);

  const cleared = await store.update({ model: "gpt-4.1-mini", apiKey: null });
  assert.equal(cleared.changed, true);
  assert.deepEqual(cleared.config.llm.apiKey, { configured: false, masked: null });
  assert.match(await fs.readFile(path.join(projectPath, ".env"), "utf-8"), /LLM_API_KEY=\n/);
});

test("Upochi config rejects unsupported models, fields, and invalid override paths", async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-upochi-invalid-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const projectPath = await createUpochiProject(parent);
  const store = new UpochiConfigStore({
    env: { WECHAT2ALL_UPOCHI_PROJECT_DIR: projectPath },
    cwd: parent,
    homeDir: parent,
  });

  await assert.rejects(store.update({ model: "arbitrary-model" }), UpochiConfigValidationError);
  await assert.rejects(store.update({ endpoint: "https://attacker.example/v1" }), UpochiConfigValidationError);
  await assert.rejects(
    new UpochiConfigStore({
      env: { WECHAT2ALL_UPOCHI_PROJECT_DIR: path.join(parent, "missing") },
      cwd: parent,
      homeDir: parent,
    }).snapshot(),
    UpochiProjectNotFoundError,
  );
});
