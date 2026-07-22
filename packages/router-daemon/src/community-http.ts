import type http from "node:http";

import {
  CommunityService,
  CommunityServiceError,
  type CommunityMutationRequest,
  type CommunityOperationKind,
} from "./community.js";

const MAX_BODY_BYTES = 32 * 1024;
const ALLOWED_BROWSER_ORIGINS = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

function sendJson(
  res: http.ServerResponse,
  status: number,
  data: unknown,
  browserOrigin = "http://localhost:5173",
): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": browserOrigin,
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(data));
}

function requestBrowserOrigin(req: http.IncomingMessage): string {
  const origin = req.headers.origin;
  if (!origin) return "http://localhost:5173";
  if (!ALLOWED_BROWSER_ORIGINS.has(origin)) {
    throw new CommunityServiceError(403, "Community API accepts browser requests only from WeConnect.");
  }
  return origin;
}

function requireJsonContentType(req: http.IncomingMessage): void {
  const contentType = req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new CommunityServiceError(
      415,
      "Community mutation requests require Content-Type: application/json.",
    );
  }
}

async function readMutationRequest(req: http.IncomingMessage): Promise<CommunityMutationRequest> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      throw new CommunityServiceError(413, "Community request body is too large.");
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new CommunityServiceError(400, "Community request body must contain valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CommunityServiceError(400, "Community request body must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== undefined && (typeof record.version !== "string" || !record.version.trim())) {
    throw new CommunityServiceError(400, "Community request version is invalid.");
  }
  if (
    record.acceptedPermissions !== undefined
    && (!Array.isArray(record.acceptedPermissions)
      || !record.acceptedPermissions.every((item) => typeof item === "string" && item.trim()))
  ) {
    throw new CommunityServiceError(400, "acceptedPermissions must be an array of permission names.");
  }
  return {
    version: record.version as string | undefined,
    acceptedPermissions: record.acceptedPermissions as string[] | undefined,
  };
}

function routeMutation(pathname: string): { routeId: string; kind: CommunityOperationKind } | undefined {
  const match = /^\/community\/routes\/([^/]+)\/(install|update)$/.exec(pathname);
  if (!match) return undefined;
  return {
    routeId: decodeURIComponent(match[1]!),
    kind: match[2] as CommunityOperationKind,
  };
}

function uninstallRouteId(pathname: string): string | undefined {
  const match = /^\/community\/routes\/([^/]+)$/.exec(pathname);
  return match ? decodeURIComponent(match[1]!) : undefined;
}

/**
 * Handles only `/community/*` requests. Errors are isolated and serialized here
 * so a bad catalog or package cannot crash the daemon's main request handler.
 */
export async function handleCommunityHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  service: CommunityService,
): Promise<boolean> {
  if (!url.pathname.startsWith("/community/")) return false;
  let browserOrigin = "http://localhost:5173";
  try {
    browserOrigin = requestBrowserOrigin(req);
    if (req.method === "GET" && url.pathname === "/community/catalog") {
      sendJson(res, 200, {
        ok: true,
        schemaVersion: 1,
        routes: await service.catalog(),
      }, browserOrigin);
      return true;
    }
    if (req.method === "GET" && url.pathname === "/community/installed") {
      sendJson(res, 200, {
        ok: true,
        schemaVersion: 1,
        routes: service.installed().map((route) => ({ ...route, status: "installed" })),
      }, browserOrigin);
      return true;
    }
    if (req.method === "GET" && url.pathname.startsWith("/community/operations/")) {
      const id = decodeURIComponent(url.pathname.slice("/community/operations/".length));
      const operation = service.getOperation(id);
      if (!operation) throw new CommunityServiceError(404, `Community operation ${id} was not found.`);
      sendJson(res, 200, { ok: true, operation }, browserOrigin);
      return true;
    }
    const mutation = routeMutation(url.pathname);
    if (req.method === "POST" && mutation) {
      requireJsonContentType(req);
      const operation = service.startOperation(
        mutation.kind,
        mutation.routeId,
        await readMutationRequest(req),
      );
      sendJson(res, 202, { ok: true, operation }, browserOrigin);
      return true;
    }
    const routeId = uninstallRouteId(url.pathname);
    if (req.method === "DELETE" && routeId) {
      const operation = service.startOperation("uninstall", routeId);
      sendJson(res, 202, { ok: true, operation }, browserOrigin);
      return true;
    }
    throw new CommunityServiceError(404, `Unknown Community route: ${req.method} ${url.pathname}`);
  } catch (error) {
    const status = error instanceof CommunityServiceError ? error.status : 500;
    sendJson(res, status, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }, browserOrigin);
    return true;
  }
}
