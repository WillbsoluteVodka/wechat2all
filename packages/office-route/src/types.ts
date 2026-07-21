import type { LLMProvider } from "@wechat2all/runtime";

export interface OfficeCliRunRequest {
  args: string[];
  cwd: string;
  timeoutMs: number;
}

export interface OfficeCliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface OfficeCliRunner {
  run(request: OfficeCliRunRequest): Promise<OfficeCliRunResult>;
  version?(): Promise<OfficeCliRunResult>;
}

export interface OfficeRouteConfig {
  storageDir: string;
  llm: LLMProvider;
  cli: OfficeCliRunner;
  llmConfigured: boolean;
  maxTurns: number;
  maxCommandsPerTurn: number;
  commandTimeoutMs: number;
  maxMediaBytes: number;
  maxOutputChars: number;
}

export interface OfficePlanCommand {
  args: string[];
}

export interface OfficePlan {
  commands: OfficePlanCommand[];
  done: boolean;
  message?: string;
  files?: string[];
}
