import type {
  RouteDashboardContributionV1,
  RuntimeRoute,
} from "@wechat2all/route-sdk";

export const CODEX_ROUTE_ID = "codex";
export const CODEX_CONNECTOR_ID = "codex-bridge";

export const CODEX_DASHBOARD: RouteDashboardContributionV1 = {
  agent: {
    name: "Codex Bridge",
    kind: "GUI + app-server bridge",
    status: "ready",
    description: "独立的 Codex GUI route package。",
  },
  management: {
    setupCheck: true,
    configControls: [
      {
        configKey: "codex",
        field: "delivery",
        label: "MODE",
        values: [
          {
            value: "gui-automation",
            label: "GUI AUTOMATION",
            title: "Drive Codex Desktop first, then fall back to app-server",
          },
          {
            value: "app-server",
            label: "APP SERVER",
            title: "Use the local Codex app-server directly",
          },
        ],
      },
    ],
    manualPermissions: [
      {
        title: "ACCESSIBILITY",
        items: [
          "System Settings → Privacy & Security → Accessibility",
          "开启 ChatGPT",
          "开启 Codex Computer Use（如果列表中存在）",
          "开启实际启动 WeConnect 的 Terminal、iTerm 或 Codex",
          "如果系统单独列出 osascript，也开启 osascript",
        ],
      },
      {
        title: "AUTOMATION",
        items: [
          "System Settings → Privacy & Security → Automation",
          "在实际启动 WeConnect 的宿主下面，允许控制 System Events",
          "允许该宿主控制 ChatGPT/Codex",
          "如果系统单独列出 osascript，允许它控制 System Events 和 ChatGPT/Codex",
        ],
      },
      {
        title: "SCREEN & SYSTEM AUDIO RECORDING",
        items: [
          "System Settings → Privacy & Security → Screen & System Audio Recording",
          "使用进阶 GUI inspection 时开启 ChatGPT / Codex Computer Use",
        ],
      },
    ],
    commands: [
      { rule: "/status", description: "查询 Codex 当前状态" },
      { rule: "/recover", description: "释放卡住的任务并重建 Codex bridge" },
      { rule: "/token", description: "查询 Codex usage 剩余额度" },
      { rule: "/ls", description: "查看可绑定的 Codex chats" },
      { rule: "/bind <序号>", description: "绑定 /ls 里对应编号的 Codex chat，也支持完整 thread id" },
      { rule: "/current", description: "查看当前绑定" },
      { rule: "/new", description: "在当前项目创建并绑定新的 Codex chat" },
      { rule: "/mode final|silent|stream", description: "设置微信返回模式" },
      { rule: "/alarm <HH:mm>", description: "设置 24 小时制 Codex chat 提醒" },
      { rule: "/cache", description: "查看本地附件 cache 的路径、文件数和大小" },
      { rule: "/cache clear", description: "清理当前 profile 的附件 cache" },
      { rule: "任意普通文本", description: "发送到已绑定的 Codex chat" },
      { rule: "/cd ..", description: "回到主 Router" },
    ],
  },
};

export function createCodexRouteDefinition(profileId: string): RuntimeRoute {
  return {
    id: CODEX_ROUTE_ID,
    profileId,
    connectorId: CODEX_CONNECTOR_ID,
    priority: 900,
    terminal: true,
    match: {
      kind: "text",
      textCommands: [],
    },
    metadata: {
      assistantName: "codex",
      systemPrompt: "Codex bridge：本地 Codex 连接能力，通过大助手 /cd codex 进入。",
      description:
        "Codex bridge：通过大助手 /cd codex 进入。默认直接驱动 Codex GUI；" +
        "GUI 操作失败时自动 fallback 到本地 app-server。",
      builtIn: true,
    },
  };
}
