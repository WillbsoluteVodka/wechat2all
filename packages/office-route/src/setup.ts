import type {
  RouteSetupCheckSnapshotV1,
  RouteSetupCheckV1,
} from "@wechat2all/route-sdk";

import type { OfficeCliRunner } from "./types.js";

export function createOfficeSetupCheck(params: {
  cli: OfficeCliRunner;
  llmConfigured: boolean;
}): RouteSetupCheckV1 {
  let state: RouteSetupCheckSnapshotV1 = {
    status: "idle",
    checkedAt: null,
    items: [],
    exitCode: null,
    error: null,
  };
  return {
    snapshot() {
      return structuredClone(state);
    },
    async refresh() {
      state = { ...state, status: "checking", error: null };
      try {
        const version = params.cli.version
          ? await params.cli.version()
          : { exitCode: 1, stdout: "", stderr: "OfficeCLI version check is unavailable." };
        const cliReady = version.exitCode === 0;
        state = {
          status: cliReady && params.llmConfigured ? "ready" : "error",
          checkedAt: new Date().toISOString(),
          items: [
            {
              status: cliReady ? "pass" : "missing",
              message: cliReady
                ? `OfficeCLI 可用：${version.stdout || "version detected"}`
                : `OfficeCLI 不可用：${version.stderr || "command not found"}`,
              section: "office",
            },
            {
              status: params.llmConfigured ? "pass" : "missing",
              message: params.llmConfigured
                ? "已继承 WeConnect LLM 配置。"
                : "缺少 WECHAT2ALL_LLM_API_KEY 或 WECHAT2ALL_LLM_MODEL。",
              section: "llm",
            },
          ],
          exitCode: version.exitCode,
          error: null,
        };
      } catch (error) {
        state = {
          status: "error",
          checkedAt: new Date().toISOString(),
          items: [{
            status: "missing",
            message: `OfficeCLI 不可用：${error instanceof Error ? error.message : String(error)}`,
            section: "office",
          }],
          exitCode: 1,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      return structuredClone(state);
    },
  };
}
