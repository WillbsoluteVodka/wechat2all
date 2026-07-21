export type CodexDeliveryMode = "app-server" | "gui-automation";

export interface CodexRouteConfigSnapshot {
  delivery: CodexDeliveryMode;
}

export interface CodexRouteConfigExtension extends RouteConfigExtensionV1 {
  key: "codex";
  fields: { delivery: "WECHAT2ALL_CODEX_DELIVERY" };
  parsePatch(value: unknown): { delivery?: string | null };
  snapshot(env: Record<string, string | undefined>): CodexRouteConfigSnapshot;
}

function configObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("codex must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

export const codexRouteConfigExtension: CodexRouteConfigExtension = {
  key: "codex",
  fields: { delivery: "WECHAT2ALL_CODEX_DELIVERY" },
  parsePatch(value) {
    const config = configObject(value);
    const unknown = Object.keys(config).filter((key) => key !== "delivery");
    if (unknown.length) {
      throw new Error(`codex contains unsupported field(s): ${unknown.join(", ")}.`);
    }
    const delivery = config.delivery;
    if (delivery === undefined) return {};
    if (delivery === null || delivery === "") return { delivery: null };
    if (delivery === "app-server" || delivery === "gui-automation") {
      return { delivery };
    }
    throw new Error("codex.delivery must be one of: app-server, gui-automation; or null.");
  },
  snapshot(env) {
    return {
      delivery: env.WECHAT2ALL_CODEX_DELIVERY === "app-server"
        ? "app-server"
        : "gui-automation",
    };
  },
};
import type { RouteConfigExtensionV1 } from "@wechat2all/route-sdk";
