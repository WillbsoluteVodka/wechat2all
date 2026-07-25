import type {
  RouteConfigControl,
  RouteConfigControlKind,
} from "./types";

export interface RouteSecretConfigStatus {
  configured: boolean;
  masked: string | null;
}

export interface RouteConfigDraftCommitResult {
  saved: boolean;
  draft: string;
}

export function routeConfigControlKind(
  control: RouteConfigControl,
): RouteConfigControlKind {
  if (control.kind) return control.kind;
  return Array.isArray(control.values) ? "select" : "text";
}

export function routeConfigTextValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

export function routeSecretConfigStatus(value: unknown): RouteSecretConfigStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { configured: false, masked: null };
  }
  const snapshot = value as Record<string, unknown>;
  return {
    configured: snapshot.configured === true,
    masked: typeof snapshot.masked === "string" ? snapshot.masked : null,
  };
}

export async function commitRouteConfigDraft(options: {
  currentDraft: string;
  savedDraft: string;
  commit: () => Promise<boolean>;
}): Promise<RouteConfigDraftCommitResult> {
  try {
    const saved = await options.commit();
    return {
      saved,
      draft: saved ? options.savedDraft : options.currentDraft,
    };
  } catch {
    return {
      saved: false,
      draft: options.currentDraft,
    };
  }
}
