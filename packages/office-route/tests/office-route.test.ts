import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  LLMProvider,
  RuntimeHandlerContext,
  RuntimeMessage,
} from "@wechat2all/runtime";

import { parseOfficePlan, runOfficeAgent } from "../src/agent.js";
import { createOfficeRouteConnector } from "../src/connector.js";
import { OFFICE_ROUTE_MANIFEST } from "../src/package.js";
import type { OfficeCliRunner, OfficeRouteConfig } from "../src/types.js";

function sequenceLlm(responses: string[]): LLMProvider {
  let index = 0;
  return {
    id: "test-llm",
    async generate() {
      const text = responses[index++];
      if (!text) throw new Error("Unexpected extra LLM turn.");
      return { text };
    },
  };
}

function config(params: {
  storageDir: string;
  llm: LLMProvider;
  cli: OfficeCliRunner;
}): OfficeRouteConfig {
  return {
    ...params,
    llmConfigured: true,
    maxTurns: 4,
    maxCommandsPerTurn: 4,
    commandTimeoutMs: 1_000,
    maxMediaBytes: 10 * 1024 * 1024,
    maxOutputChars: 4_000,
  };
}

test("manifest declares an independent LLM + OfficeCLI route", () => {
  assert.equal(OFFICE_ROUTE_MANIFEST.id, "office");
  assert.match(OFFICE_ROUTE_MANIFEST.description, /OfficeCLI/);
  assert.ok(OFFICE_ROUTE_MANIFEST.permissions.some((item) => item.name === "process:spawn"));
  assert.ok(!OFFICE_ROUTE_MANIFEST.description.toLowerCase().includes("codex"));
});

test("plan parser allows Office element paths and rejects filesystem escape", () => {
  const plan = parseOfficePlan(JSON.stringify({
    commands: [{ args: ["add", "deck.pptx", "/slide[1]", "--type", "shape"] }],
    done: false,
  }), 2);
  assert.deepEqual(plan.commands[0]?.args.slice(0, 3), ["add", "deck.pptx", "/slide[1]"]);

  assert.throws(() => parseOfficePlan(JSON.stringify({
    commands: [{ args: ["create", "../../outside.docx"] }],
    done: false,
  }), 2), /Unsafe OfficeCLI path/);
  assert.throws(() => parseOfficePlan(JSON.stringify({
    commands: [{ args: ["install"] }],
    done: false,
  }), 2), /not allowed/);
  assert.throws(() => parseOfficePlan(JSON.stringify({
    commands: [{ args: ["add", "deck.pptx", "/slide[1]", "--prop", "image=/etc/passwd"] }],
    done: false,
  }), 2), /Unsafe OfficeCLI path/);
});

test("office agent iterates LLM plans through OfficeCLI observations", async () => {
  const calls: string[][] = [];
  const cli: OfficeCliRunner = {
    async run(request) {
      calls.push(request.args);
      return { exitCode: 0, stdout: '{"success":true}', stderr: "" };
    },
  };
  const result = await runOfficeAgent({
    userText: "做一个季度汇报",
    workspace: "/tmp/office-agent-test",
    availableFiles: [],
    config: config({
      storageDir: "/tmp/office-agent-test",
      cli,
      llm: sequenceLlm([
        '{"commands":[{"args":["create","report.pptx"]}],"done":false}',
        '{"commands":[],"done":true,"message":"做好了","files":["report.pptx"]}',
      ]),
    }),
  });
  assert.deepEqual(calls, [["create", "report.pptx"]]);
  assert.deepEqual(result, { message: "做好了", files: ["report.pptx"] });
});

test("connector runs WeChat text -> LLM -> OfficeCLI -> send_media", async (t) => {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat2all-office-route-"));
  t.after(() => fs.rm(storageDir, { recursive: true, force: true }));
  const cliCalls: string[][] = [];
  const cli: OfficeCliRunner = {
    async run(request) {
      cliCalls.push(request.args);
      if (request.args[0] === "create") {
        await fs.writeFile(path.join(request.cwd, "report.docx"), "fake-docx");
      }
      return { exitCode: 0, stdout: '{"success":true}', stderr: "" };
    },
    async version() {
      return { exitCode: 0, stdout: "1.0.0", stderr: "" };
    },
  };
  const connector = createOfficeRouteConnector({
    id: "office-route",
    config: config({
      storageDir,
      cli,
      llm: sequenceLlm([
        '{"commands":[{"args":["create","report.docx"]}],"done":false,"message":"正在创建"}',
        '{"commands":[],"done":true,"message":"文档已完成","files":["report.docx"]}',
      ]),
    }),
  });
  const message = {
    id: "m-1",
    profileId: "p-1",
    conversationId: "c-1",
    senderId: "u-1",
    kind: "text",
    text: "做一份 Word 报告",
    attachments: [],
  } as unknown as RuntimeMessage;
  const progress: unknown[] = [];
  const context = {
    profileId: "p-1",
    connectorId: "office-route",
    route: { id: "office", connectorId: "office-route" },
    routes: {
      clearConversationRoute() { return true; },
      addRoute() {},
      upsertRoute() {},
      removeRoute() { return false; },
      listRoutes() { return []; },
      setConversationRoute() {},
      getConversationRoute() { return undefined; },
    },
    dispatchActions(actions: unknown[]) {
      progress.push(...actions);
      return Promise.resolve([]);
    },
  } as unknown as RuntimeHandlerContext;

  const actions = await connector.handleMessage(message, context);
  assert.deepEqual(cliCalls, [["create", "report.docx"]]);
  assert.equal(progress.length, 1);
  assert.equal(actions.length, 2, JSON.stringify(actions));
  assert.equal(actions[0]?.type, "send_text");
  assert.equal(actions[1]?.type, "send_media");
  if (actions[1]?.type === "send_media") {
    assert.equal(path.basename(actions[1].filePath), "report.docx");
  }
});
