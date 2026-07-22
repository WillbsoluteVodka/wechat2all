import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertRouteManifestMatchesPackageV1,
  assertRouteManifestV1,
  instantiateRoutePackageV1,
  routePackageFromModuleExportsV1,
  type RouteManagedBinaryDependencyV1,
  type RouteLoggerV1,
  type RouteManifestV1,
  type RoutePackageModuleExportsV1,
} from "@wechat2all/route-sdk";

import {
  readCommunityInstalledRegistry,
  writeCommunityInstalledRegistry,
  type CommunityInstalledRegistry,
  type InstalledCommunityRoute,
} from "./community-registry.js";

const DEFAULT_MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_MANAGED_DEPENDENCY_BYTES = 100 * 1024 * 1024;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_DEPENDENCY_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_DEPENDENCY_VERIFY_TIMEOUT_MS = 5 * 60_000;
const OPERATION_HISTORY_LIMIT = 100;
const SAFE_ARCHIVE_NAME = /^[\x20-\x7e]+$/;
const MAX_ARCHIVE_MEMBERS = 10_000;
const MAX_ARCHIVE_PATH_BYTES = 512;
const MAX_DEPENDENCY_PROCESS_OUTPUT_BYTES = 64 * 1024;

export type CommunityArtifactType = "archive" | "directory";

export interface CommunityRequirement {
  name: string;
  description?: string;
  url?: string;
  required?: boolean;
}

export interface CommunityCatalogArtifact {
  type: CommunityArtifactType;
  url: string;
  sha256?: string;
  entrypoint?: string;
}

export interface CommunityCatalogRoute {
  id: string;
  packageName: string;
  displayName: string;
  version: string;
  description: string;
  manifest: RouteManifestV1;
  artifact: CommunityCatalogArtifact;
  requirements?: CommunityRequirement[];
  sourceCatalog: string;
}

export interface CommunityCatalogRouteView extends CommunityCatalogRoute {
  installedVersion: string | null;
  status: "available" | "installed" | "update-available";
}

export type CommunityOperationKind = "install" | "update" | "uninstall";
export type CommunityOperationStatus = "queued" | "running" | "succeeded" | "failed";

export interface CommunityOperation {
  id: string;
  kind: CommunityOperationKind;
  routeId: string;
  status: CommunityOperationStatus;
  progress: number;
  message?: string;
  error?: string;
  restartRequired: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CommunityMutationRequest {
  version?: string;
  acceptedPermissions?: string[];
}

export interface CommunityServiceOptions {
  rootDir?: string;
  registryPath?: string;
  catalogSources?: string[];
  hostVersion?: string;
  nodeVersion?: string;
  profileId?: string;
  routeStorageRoot?: string;
  logger?: RouteLoggerV1;
  fetch?: typeof globalThis.fetch;
  maxArtifactBytes?: number;
  maxManagedDependencyBytes?: number;
  downloadTimeoutMs?: number;
  dependencyDownloadTimeoutMs?: number;
  dependencyVerifyTimeoutMs?: number;
  /** Reloads only the route runtime after the registry changes. */
  onInstalledChanged?: () => void | Promise<void>;
}

export class CommunityServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CommunityServiceError";
  }
}

interface LoadedCatalogDocument {
  routes: CommunityCatalogRoute[];
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new CommunityServiceError(400, `Community catalog ${field} is missing or invalid.`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field);
}

function sha256Pattern(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function isHttps(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function hasUrlProtocol(value: string): boolean {
  try {
    return Boolean(new URL(value).protocol);
  } catch {
    return false;
  }
}

function isLocalSource(value: string): boolean {
  if (value.startsWith("file:")) return true;
  try {
    return !new URL(value).protocol;
  } catch {
    return true;
  }
}

function sourcePath(value: string): string {
  return value.startsWith("file:") ? fileURLToPath(value) : path.resolve(value);
}

function resolveArtifactUrl(value: string, catalogSource: string): string {
  if (hasUrlProtocol(value) || path.isAbsolute(value)) return value;
  if (isHttps(catalogSource)) return new URL(value, catalogSource).href;
  return path.resolve(path.dirname(sourcePath(catalogSource)), value);
}

function parseRequirement(value: unknown, index: number): CommunityRequirement {
  const entry = objectValue(value);
  if (!entry) {
    throw new CommunityServiceError(400, `Community catalog requirements[${index}] is invalid.`);
  }
  if (entry.required !== undefined && typeof entry.required !== "boolean") {
    throw new CommunityServiceError(
      400,
      `Community catalog requirements[${index}].required must be boolean.`,
    );
  }
  const url = optionalString(entry.url, `requirements[${index}].url`);
  if (url && !isHttps(url)) {
    throw new CommunityServiceError(
      400,
      `Community catalog requirements[${index}].url must use HTTPS.`,
    );
  }
  return {
    name: requiredString(entry.name, `requirements[${index}].name`),
    description: optionalString(entry.description, `requirements[${index}].description`),
    url,
    required: entry.required as boolean | undefined,
  };
}

function parseCatalogRoute(value: unknown, source: string): CommunityCatalogRoute {
  const entry = objectValue(value);
  if (!entry) throw new CommunityServiceError(400, "Community catalog route must be an object.");
  assertRouteManifestV1(entry.manifest);
  const id = requiredString(entry.id, "route.id");
  const packageName = requiredString(entry.packageName, "route.packageName");
  const version = requiredString(entry.version, "route.version");
  const displayName = requiredString(entry.displayName, "route.displayName");
  const description = requiredString(entry.description, "route.description");
  if (
    entry.manifest.id !== id
    || entry.manifest.packageName !== packageName
    || entry.manifest.version !== version
    || entry.manifest.displayName !== displayName
    || entry.manifest.description !== description
  ) {
    throw new CommunityServiceError(400, `Catalog metadata does not match manifest for ${id}.`);
  }
  const artifactValue = objectValue(entry.artifact);
  if (!artifactValue) {
    throw new CommunityServiceError(400, `Community catalog artifact is missing for ${id}.`);
  }
  const type = requiredString(artifactValue.type, `route ${id} artifact.type`);
  if (type !== "archive" && type !== "directory") {
    throw new CommunityServiceError(400, `Unsupported artifact type for ${id}: ${type}.`);
  }
  const rawArtifactUrl = requiredString(artifactValue.url, `route ${id} artifact.url`);
  const artifactUrl = resolveArtifactUrl(rawArtifactUrl, source);
  const remote = isHttps(artifactUrl);
  if (!remote && !isLocalSource(artifactUrl)) {
    throw new CommunityServiceError(400, `Artifact for ${id} must use HTTPS.`);
  }
  if (remote && type !== "archive") {
    throw new CommunityServiceError(400, `Remote artifact for ${id} must be an archive.`);
  }
  const sha256 = optionalString(artifactValue.sha256, `route ${id} artifact.sha256`);
  if (remote && !sha256) {
    throw new CommunityServiceError(400, `Remote artifact for ${id} requires SHA-256.`);
  }
  if (sha256 && !sha256Pattern(sha256)) {
    throw new CommunityServiceError(400, `Artifact SHA-256 for ${id} is invalid.`);
  }
  const requirements = entry.requirements === undefined
    ? undefined
    : Array.isArray(entry.requirements)
      ? entry.requirements.map(parseRequirement)
      : (() => {
          throw new CommunityServiceError(400, `Requirements for ${id} must be an array.`);
        })();
  return {
    id,
    packageName,
    displayName,
    version,
    description,
    manifest: entry.manifest,
    artifact: {
      type,
      url: artifactUrl,
      sha256,
      entrypoint: optionalString(artifactValue.entrypoint, `route ${id} artifact.entrypoint`),
    },
    requirements,
    sourceCatalog: source,
  };
}

function parseCatalogDocument(value: unknown, source: string): LoadedCatalogDocument {
  const document = objectValue(value);
  if (document?.schemaVersion !== 1 || !Array.isArray(document.routes)) {
    throw new CommunityServiceError(400, `Community catalog ${source} must use schemaVersion 1.`);
  }
  return { routes: document.routes.map((entry) => parseCatalogRoute(entry, source)) };
}

function normalizeVersion(value: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3])]
    : undefined;
}

function compareVersions(left: string, right: string): number {
  const a = normalizeVersion(left);
  const b = normalizeVersion(right);
  if (!a || !b) return left.localeCompare(right);
  for (let index = 0; index < 3; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

function versionSatisfiesComparator(version: string, comparator: string): boolean {
  const normalized = normalizeVersion(version);
  if (!normalized) return false;
  const match = /^(>=|<=|>|<|=|\^|~)?\s*(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/.exec(
    comparator.trim(),
  );
  if (!match) return false;
  const operator = match[1] ?? "=";
  const major = Number(match[2]);
  const minorWildcard = match[3] === undefined || match[3] === "x" || match[3] === "*";
  const patchWildcard = match[4] === undefined || match[4] === "x" || match[4] === "*";
  const minor = minorWildcard ? 0 : Number(match[3]);
  const patch = patchWildcard ? 0 : Number(match[4]);
  const target = `${major}.${minor}.${patch}`;
  const comparison = compareVersions(version, target);
  if (operator === ">=") return comparison >= 0;
  if (operator === "<=") return comparison <= 0;
  if (operator === ">") return comparison > 0;
  if (operator === "<") return comparison < 0;
  if (operator === "^") {
    const upper = major > 0
      ? `${major + 1}.0.0`
      : minor > 0
        ? `0.${minor + 1}.0`
        : `0.0.${patch + 1}`;
    return comparison >= 0 && compareVersions(version, upper) < 0;
  }
  if (operator === "~") {
    return comparison >= 0 && compareVersions(version, `${major}.${minor + 1}.0`) < 0;
  }
  if (minorWildcard) return normalized[0] === major;
  if (patchWildcard) return normalized[0] === major && normalized[1] === minor;
  return comparison === 0;
}

export function versionSatisfies(version: string, range: string): boolean {
  return range.split("||").some((alternative) => {
    const comparators = alternative.trim().split(/\s+/).filter(Boolean);
    return comparators.length > 0
      && comparators.every((comparator) => versionSatisfiesComparator(version, comparator));
  });
}

export function resolveCommunityRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  homedir = os.homedir(),
): string {
  if (env.WECHAT2ALL_COMMUNITY_ROOT?.trim()) {
    return path.resolve(env.WECHAT2ALL_COMMUNITY_ROOT.trim());
  }
  if (platform === "darwin") {
    return path.join(homedir, "Library", "Application Support", "WeConnect", "community");
  }
  if (platform === "win32" && env.LOCALAPPDATA) {
    return path.join(env.LOCALAPPDATA, "WeConnect", "community");
  }
  return path.join(env.XDG_DATA_HOME ?? path.join(homedir, ".local", "share"), "weconnect", "community");
}

export function parseCommunityCatalogSources(value: string | undefined): string[] {
  return [...new Set(
    (value ?? "")
      .split(/[\n,]/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => hasUrlProtocol(entry) ? entry : path.resolve(entry)),
  )];
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function sha256Directory(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(directory: string, prefix = ""): Promise<void> {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = path.posix.join(prefix, entry.name);
      const fullPath = path.join(directory, entry.name);
      const stats = await fs.promises.lstat(fullPath);
      if (stats.isSymbolicLink()) {
        throw new CommunityServiceError(400, `Route artifact cannot contain symbolic links: ${relative}.`);
      }
      if (stats.isDirectory()) {
        hash.update(`d\0${relative}\0`);
        await visit(fullPath, relative);
      } else if (stats.isFile()) {
        hash.update(`f\0${relative}\0${stats.size}\0`);
        const stream = fs.createReadStream(fullPath);
        for await (const chunk of stream) hash.update(chunk as Buffer);
      } else {
        throw new CommunityServiceError(400, `Unsupported file in route artifact: ${relative}.`);
      }
    }
  }
  await visit(root);
  return hash.digest("hex");
}

async function copyDirectorySecure(source: string, destination: string): Promise<void> {
  const stats = await fs.promises.lstat(source);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new CommunityServiceError(400, "Local Community artifact must be a real directory.");
  }
  await fs.promises.mkdir(destination, { recursive: true, mode: 0o700 });
  const entries = await fs.promises.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    const childStats = await fs.promises.lstat(from);
    if (childStats.isSymbolicLink()) {
      throw new CommunityServiceError(400, `Route artifact cannot contain symbolic links: ${entry.name}.`);
    }
    if (childStats.isDirectory()) {
      await copyDirectorySecure(from, to);
    } else if (childStats.isFile()) {
      await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL);
      await fs.promises.chmod(to, childStats.mode & 0o755);
    } else {
      throw new CommunityServiceError(400, `Unsupported file in route artifact: ${entry.name}.`);
    }
  }
}

function runTar(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
      } else {
        reject(new CommunityServiceError(
          400,
          `Could not extract route archive: ${Buffer.concat(stderr).toString("utf8").trim() || `tar exited ${code}`}`,
        ));
      }
    });
  });
}

function validateArchiveMembers(listing: string): void {
  const names = listing.split(/\r?\n/).filter(Boolean);
  if (names.length > MAX_ARCHIVE_MEMBERS) {
    throw new CommunityServiceError(413, "Route archive contains too many files.");
  }
  for (const rawName of names) {
    const name = rawName.replace(/^\.\//, "");
    if (!name && rawName === "./") continue;
    if (
      !SAFE_ARCHIVE_NAME.test(name)
      || Buffer.byteLength(name) > MAX_ARCHIVE_PATH_BYTES
      || path.posix.isAbsolute(name)
      || name.split("/").some((part) => part === "..")
    ) {
      throw new CommunityServiceError(400, `Unsafe path in route archive: ${rawName}.`);
    }
  }
}

function validateArchiveTypesAndSize(listing: string, maxUnpackedBytes: number): void {
  let totalSize = 0;
  for (const line of listing.split(/\r?\n/).filter(Boolean)) {
    const type = line[0];
    if (type !== "-" && type !== "d") {
      throw new CommunityServiceError(
        400,
        "Route archive may contain only regular files and directories (links/devices are rejected).",
      );
    }
    if (type === "d") continue;
    const fields = line.trim().split(/\s+/);
    const dateIndex = fields.findIndex((field) =>
      /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/.test(field)
      || /^\d{4}-\d{2}-\d{2}$/.test(field)
    );
    if (dateIndex <= 0) {
      throw new CommunityServiceError(400, "Could not validate route archive file sizes.");
    }
    const sizeField = fields.slice(0, dateIndex).reverse().find((field) => /^\d+$/.test(field));
    if (!sizeField) {
      throw new CommunityServiceError(400, "Could not validate route archive file sizes.");
    }
    totalSize += Number(sizeField);
    if (!Number.isSafeInteger(totalSize) || totalSize > maxUnpackedBytes) {
      throw new CommunityServiceError(413, "Expanded route archive exceeds the size limit.");
    }
  }
}

async function assertSecureTree(root: string): Promise<void> {
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    const stats = await fs.promises.lstat(fullPath);
    if (stats.isSymbolicLink()) {
      throw new CommunityServiceError(400, `Route artifact cannot contain symbolic links: ${entry.name}.`);
    }
    if (stats.isDirectory()) await assertSecureTree(fullPath);
    else if (!stats.isFile()) {
      throw new CommunityServiceError(400, `Unsupported file in route artifact: ${entry.name}.`);
    }
  }
}

async function extractArchiveSecure(
  archivePath: string,
  destination: string,
  maxUnpackedBytes: number,
): Promise<void> {
  const listing = await runTar(["-tzf", archivePath]);
  validateArchiveMembers(listing);
  const verboseListing = await runTar(["-tvzf", archivePath]);
  validateArchiveTypesAndSize(verboseListing, maxUnpackedBytes);
  await fs.promises.mkdir(destination, { recursive: true, mode: 0o700 });
  await runTar(["-xzf", archivePath, "--no-same-owner", "--no-same-permissions", "-C", destination]);
  await assertSecureTree(destination);
}

async function findPackageRoot(extractedRoot: string): Promise<string> {
  if (fs.existsSync(path.join(extractedRoot, "weconnect.route.json"))) return extractedRoot;
  const children = await fs.promises.readdir(extractedRoot, { withFileTypes: true });
  const candidates = children.filter((entry) =>
    entry.isDirectory() && fs.existsSync(path.join(extractedRoot, entry.name, "weconnect.route.json"))
  );
  if (candidates.length !== 1) {
    throw new CommunityServiceError(
      400,
      "Route artifact must contain weconnect.route.json at its root or in one top-level directory.",
    );
  }
  return path.join(extractedRoot, candidates[0]!.name);
}

async function packageMetadata(packageRoot: string): Promise<{
  manifestPath: string;
  entrypoint: string;
}> {
  const packageJsonPath = path.join(packageRoot, "package.json");
  const fallback = {
    manifestPath: path.join(packageRoot, "weconnect.route.json"),
    entrypoint: "dist/index.mjs",
  };
  if (!fs.existsSync(packageJsonPath)) return fallback;
  const parsed = objectValue(await readJsonFile(packageJsonPath));
  const weconnect = objectValue(parsed?.weconnect);
  const routeManifest = typeof weconnect?.routeManifest === "string"
    ? weconnect.routeManifest
    : "weconnect.route.json";
  const configuredEntrypoint = typeof weconnect?.routeEntrypoint === "string"
    ? weconnect.routeEntrypoint
    : ".";
  let entrypoint = configuredEntrypoint;
  if (entrypoint === ".") {
    const exportsValue = parsed?.exports;
    const rootExport = objectValue(exportsValue)?.["."] ?? exportsValue;
    const importExport = objectValue(rootExport)?.import;
    entrypoint = typeof rootExport === "string"
      ? rootExport
      : typeof importExport === "string"
        ? importExport
        : typeof parsed?.main === "string"
          ? parsed.main
          : fallback.entrypoint;
  }
  return {
    manifestPath: resolvePackageEntrypoint(packageRoot, routeManifest),
    entrypoint,
  };
}

function resolvePackageEntrypoint(packageRoot: string, value = "dist/index.mjs"): string {
  const resolvedRoot = path.resolve(packageRoot);
  const resolved = path.resolve(packageRoot, value);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new CommunityServiceError(400, "Route artifact entrypoint escapes its package directory.");
  }
  return resolved;
}

async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.promises.readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    throw new CommunityServiceError(
      400,
      `Could not read ${path.basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

interface BoundedProcessResult {
  stdout: string;
  stderr: string;
}

function dependencyProcessEnv(executable: string): NodeJS.ProcessEnv {
  const safeKeys = [
    "HOME",
    "USERPROFILE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
  ] as const;
  const env: NodeJS.ProcessEnv = {};
  for (const key of safeKeys) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const executableDir = path.isAbsolute(executable) ? path.dirname(executable) : undefined;
  env.PATH = [...new Set([
    executableDir,
    path.dirname(process.execPath),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    ...(process.env.PATH ?? "").split(path.delimiter),
  ].filter((entry): entry is string => Boolean(entry)))].join(path.delimiter);
  return env;
}

function isMuslLinux(): boolean {
  if (process.platform !== "linux") return false;
  if (fs.existsSync("/etc/alpine-release")) return true;
  try {
    const report = process.report?.getReport() as {
      header?: { glibcVersionRuntime?: unknown };
    } | undefined;
    const header = report?.header;
    return header !== undefined && header.glibcVersionRuntime === undefined;
  } catch {
    return false;
  }
}

function managedDependencyPlatform(): string {
  if (process.platform === "linux" && isMuslLinux()) {
    return `linux-musl-${process.arch}`;
  }
  return `${process.platform}-${process.arch}`;
}

function runBoundedProcess(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    label: string;
  },
): Promise<BoundedProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const append = (current: string, chunk: Buffer): string => {
      const used = Buffer.byteLength(current);
      if (used >= MAX_DEPENDENCY_PROCESS_OUTPUT_BYTES) return current;
      return current + chunk.subarray(0, MAX_DEPENDENCY_PROCESS_OUTPUT_BYTES - used).toString("utf8");
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    };
    const timer = setTimeout(() => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      finish(new CommunityServiceError(504, `${options.label} timed out.`));
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.once("error", (error) => {
      finish(new CommunityServiceError(500, `Could not start ${options.label}: ${error.message}`));
    });
    child.once("close", (code) => {
      if (code === 0) finish();
      else {
        finish(new CommunityServiceError(
          500,
          `${options.label} failed (${code ?? "unknown"}): ${stderr.trim() || stdout.trim() || "no output"}`,
        ));
      }
    });
  });
}

function managedDependencyExecutable(
  packageRoot: string,
  dependency: RouteManagedBinaryDependencyV1,
): string {
  const name = process.platform === "win32"
    ? `${dependency.executable}.exe`
    : dependency.executable;
  return path.join(packageRoot, ".weconnect-tools", "bin", name);
}

export class CommunityService {
  readonly rootDir: string;
  readonly registryPath: string;
  private readonly packagesRoot: string;
  private readonly stagingRoot: string;
  private readonly catalogSources: string[];
  private readonly hostVersion: string;
  private readonly nodeVersion: string;
  private readonly profileId: string;
  private readonly routeStorageRoot: string;
  private readonly logger?: RouteLoggerV1;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly maxArtifactBytes: number;
  private readonly maxManagedDependencyBytes: number;
  private readonly downloadTimeoutMs: number;
  private readonly dependencyDownloadTimeoutMs: number;
  private readonly dependencyVerifyTimeoutMs: number;
  private readonly onInstalledChanged?: () => void | Promise<void>;
  private readonly operations = new Map<string, CommunityOperation>();
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: CommunityServiceOptions = {}) {
    this.rootDir = path.resolve(options.rootDir ?? resolveCommunityRoot());
    this.registryPath = path.resolve(
      options.registryPath ?? path.join(this.rootDir, "installed-routes.json"),
    );
    this.packagesRoot = path.join(this.rootDir, "routes");
    this.stagingRoot = path.join(this.rootDir, ".staging");
    this.catalogSources = options.catalogSources ?? [];
    this.hostVersion = options.hostVersion ?? "0.1.0";
    this.nodeVersion = options.nodeVersion ?? process.versions.node;
    this.profileId = options.profileId ?? "default";
    this.routeStorageRoot = path.resolve(
      options.routeStorageRoot ?? path.join(this.rootDir, "route-data"),
    );
    this.logger = options.logger;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    this.maxManagedDependencyBytes = options.maxManagedDependencyBytes
      ?? DEFAULT_MAX_MANAGED_DEPENDENCY_BYTES;
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
    this.dependencyDownloadTimeoutMs = options.dependencyDownloadTimeoutMs
      ?? DEFAULT_DEPENDENCY_DOWNLOAD_TIMEOUT_MS;
    this.dependencyVerifyTimeoutMs = options.dependencyVerifyTimeoutMs
      ?? DEFAULT_DEPENDENCY_VERIFY_TIMEOUT_MS;
    this.onInstalledChanged = options.onInstalledChanged;
  }

  private readRegistry(): CommunityInstalledRegistry {
    return readCommunityInstalledRegistry(this.registryPath, this.packagesRoot);
  }

  private managedInstallDir(routeId: string, version: string): string {
    return path.join(this.packagesRoot, routeId, version);
  }

  private async removeManagedInstallDir(
    installDir: string,
    routeId: string,
    version: string,
  ): Promise<void> {
    const expected = path.resolve(this.managedInstallDir(routeId, version));
    if (path.resolve(installDir) !== expected) {
      throw new CommunityServiceError(
        500,
        `Refusing to remove unmanaged Community path for ${routeId}@${version}.`,
      );
    }
    await fs.promises.rm(expected, { recursive: true, force: true });
  }

  private async loadCatalogSource(source: string): Promise<LoadedCatalogDocument> {
    if (isHttps(source)) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.downloadTimeoutMs);
      try {
        const response = await this.fetchImpl(source, {
          signal: controller.signal,
          headers: { accept: "application/json" },
        });
        if (!response.ok) {
          throw new CommunityServiceError(502, `Community catalog ${source} returned ${response.status}.`);
        }
        if (!isHttps(response.url || source)) {
          throw new CommunityServiceError(400, "Community catalog redirected away from HTTPS.");
        }
        return parseCatalogDocument(await response.json(), source);
      } finally {
        clearTimeout(timeout);
      }
    }
    if (!isLocalSource(source)) {
      throw new CommunityServiceError(400, `Community catalog must use HTTPS: ${source}.`);
    }
    return parseCatalogDocument(await readJsonFile(sourcePath(source)), source);
  }

  async catalog(): Promise<CommunityCatalogRouteView[]> {
    const installed = this.readRegistry();
    const byId = new Map<string, CommunityCatalogRoute>();
    for (const source of this.catalogSources) {
      try {
        const document = await this.loadCatalogSource(source);
        for (const route of document.routes) {
          const previous = byId.get(route.id);
          if (!previous || compareVersions(route.version, previous.version) > 0) {
            byId.set(route.id, route);
          }
        }
      } catch (error) {
        this.logger?.error("Could not load Community catalog.", {
          source,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return [...byId.values()]
      .sort((left, right) => left.displayName.localeCompare(right.displayName))
      .map((route) => {
        const current = installed.packages.find((item) => item.id === route.id);
        return {
          ...route,
          installedVersion: current?.version ?? null,
          status: !current
            ? "available"
            : compareVersions(route.version, current.version) > 0
              ? "update-available"
              : "installed",
        };
      });
  }

  installed(): InstalledCommunityRoute[] {
    return this.readRegistry().packages;
  }

  getOperation(id: string): CommunityOperation | undefined {
    const operation = this.operations.get(id);
    return operation ? { ...operation } : undefined;
  }

  startOperation(
    kind: CommunityOperationKind,
    routeId: string,
    request: CommunityMutationRequest = {},
  ): CommunityOperation {
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(routeId)) {
      throw new CommunityServiceError(400, "Community route id is invalid.");
    }
    const now = new Date().toISOString();
    const operation: CommunityOperation = {
      id: randomUUID(),
      kind,
      routeId,
      status: "queued",
      progress: 0,
      restartRequired: true,
      createdAt: now,
      updatedAt: now,
    };
    this.operations.set(operation.id, operation);
    this.pruneOperations();
    this.mutationQueue = this.mutationQueue
      .then(() => this.runOperation(operation, request))
      .catch(() => {
        // runOperation records all failures so the queue remains usable.
      });
    return { ...operation };
  }

  private pruneOperations(): void {
    if (this.operations.size <= OPERATION_HISTORY_LIMIT) return;
    const completed = [...this.operations.values()]
      .filter((operation) => operation.status === "succeeded" || operation.status === "failed")
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    for (const operation of completed.slice(0, this.operations.size - OPERATION_HISTORY_LIMIT)) {
      this.operations.delete(operation.id);
    }
  }

  private updateOperation(
    operation: CommunityOperation,
    patch: Partial<Pick<CommunityOperation, "status" | "progress" | "message" | "error" | "restartRequired">>,
  ): void {
    Object.assign(operation, patch, { updatedAt: new Date().toISOString() });
  }

  private async runOperation(
    operation: CommunityOperation,
    request: CommunityMutationRequest,
  ): Promise<void> {
    this.updateOperation(operation, { status: "running", progress: 5, message: "Preparing" });
    try {
      if (operation.kind === "uninstall") {
        await this.uninstall(operation);
      } else {
        await this.installOrUpdate(operation, request);
      }
      this.updateOperation(operation, {
        status: "succeeded",
        progress: 100,
        message: operation.kind === "uninstall" ? "Uninstalled" : "Installed",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.updateOperation(operation, {
        status: "failed",
        progress: Math.min(operation.progress, 99),
        message: "Failed",
        error: message,
      });
      this.logger?.error("Community route operation failed.", {
        operationId: operation.id,
        kind: operation.kind,
        routeId: operation.routeId,
        error: message,
      });
    }
  }

  private async catalogRoute(routeId: string, version?: string): Promise<CommunityCatalogRoute> {
    const routes = await this.catalog();
    const route = routes.find((entry) =>
      entry.id === routeId && (version === undefined || entry.version === version)
    );
    if (!route) {
      throw new CommunityServiceError(
        404,
        version
          ? `Community route ${routeId}@${version} is not in the configured catalog.`
          : `Community route ${routeId} is not in the configured catalog.`,
      );
    }
    return route;
  }

  private assertPermissionsAccepted(
    route: CommunityCatalogRoute,
    acceptedPermissions: string[] | undefined,
  ): void {
    const accepted = new Set(acceptedPermissions ?? []);
    const missing = route.manifest.permissions
      .filter((permission) => !permission.optional && !accepted.has(permission.name))
      .map((permission) => permission.name);
    if (missing.length) {
      throw new CommunityServiceError(
        400,
        `Install requires permission confirmation: ${missing.join(", ")}.`,
      );
    }
  }

  private assertCompatible(route: CommunityCatalogRoute): void {
    if (!versionSatisfies(this.hostVersion, route.manifest.engines.weconnect)) {
      throw new CommunityServiceError(
        400,
        `${route.displayName} requires WeConnect ${route.manifest.engines.weconnect}; current version is ${this.hostVersion}.`,
      );
    }
    if (
      route.manifest.engines.node
      && !versionSatisfies(this.nodeVersion, route.manifest.engines.node)
    ) {
      throw new CommunityServiceError(
        400,
        `${route.displayName} requires Node ${route.manifest.engines.node}; current version is ${this.nodeVersion}.`,
      );
    }
  }

  private async downloadHttpsFile(
    url: string,
    destination: string,
    maxBytes: number,
    timeoutMs: number,
    label: string,
  ): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: "application/gzip, application/octet-stream" },
      });
      if (!response.ok || !response.body) {
        throw new CommunityServiceError(502, `${label} download returned ${response.status}.`);
      }
      if (!isHttps(response.url || url)) {
        throw new CommunityServiceError(400, `${label} redirected away from HTTPS.`);
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new CommunityServiceError(413, `${label} exceeds the download size limit.`);
      }
      let size = 0;
      const limiter = new Transform({
        transform: (chunk: Buffer | Uint8Array, _encoding, callback) => {
          const buffer = Buffer.from(chunk);
          size += buffer.byteLength;
          if (size > maxBytes) {
            callback(new CommunityServiceError(413, `${label} exceeds the download size limit.`));
            return;
          }
          callback(null, buffer);
        },
      });
      const file = fs.createWriteStream(destination, { flags: "wx", mode: 0o600 });
      await pipeline(
        Readable.fromWeb(response.body as never),
        limiter,
        file,
      );
    } catch (error) {
      if (controller.signal.aborted) {
        throw new CommunityServiceError(504, `${label} download timed out.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private downloadArtifact(url: string, destination: string): Promise<void> {
    return this.downloadHttpsFile(
      url,
      destination,
      this.maxArtifactBytes,
      this.downloadTimeoutMs,
      "Route artifact",
    );
  }

  private async stageArtifact(
    route: CommunityCatalogRoute,
    operation: CommunityOperation,
    operationRoot: string,
  ): Promise<string> {
    const unpackedRoot = path.join(operationRoot, "unpacked");
    if (route.artifact.type === "directory") {
      const localPath = sourcePath(route.artifact.url);
      if (route.artifact.sha256) {
        const actual = await sha256Directory(localPath);
        if (actual !== route.artifact.sha256.toLowerCase()) {
          throw new CommunityServiceError(400, "Route directory SHA-256 does not match catalog.");
        }
      }
      this.updateOperation(operation, { progress: 35, message: "Copying" });
      await copyDirectorySecure(localPath, unpackedRoot);
      return findPackageRoot(unpackedRoot);
    }

    const archivePath = path.join(operationRoot, "route.tar.gz");
    this.updateOperation(operation, { progress: 20, message: "Downloading" });
    if (isHttps(route.artifact.url)) {
      await this.downloadArtifact(route.artifact.url, archivePath);
    } else {
      await fs.promises.copyFile(sourcePath(route.artifact.url), archivePath, fs.constants.COPYFILE_EXCL);
    }
    if (route.artifact.sha256) {
      const actual = await sha256File(archivePath);
      if (actual !== route.artifact.sha256.toLowerCase()) {
        throw new CommunityServiceError(400, "Route archive SHA-256 does not match catalog.");
      }
    }
    this.updateOperation(operation, { progress: 40, message: "Extracting" });
    await extractArchiveSecure(archivePath, unpackedRoot, this.maxArtifactBytes);
    return findPackageRoot(unpackedRoot);
  }

  private async validatePackage(
    route: CommunityCatalogRoute,
    packageRoot: string,
    validationStorageDir: string,
    operation: CommunityOperation,
  ): Promise<{ entrypoint: string }> {
    const metadata = await packageMetadata(packageRoot);
    const staticManifest = await readJsonFile(metadata.manifestPath);
    assertRouteManifestV1(staticManifest);
    if (
      staticManifest.id !== route.id
      || staticManifest.packageName !== route.packageName
      || staticManifest.version !== route.version
    ) {
      throw new CommunityServiceError(400, "Downloaded route manifest does not match catalog.");
    }
    // Compare every field (especially permissions) before importing executable
    // route code. The import is the trust boundary, not a metadata probe.
    assertRouteManifestMatchesPackageV1(route.manifest, {
      protocol: "weconnect.route",
      protocolVersion: 1,
      manifest: staticManifest,
      create() {
        throw new Error("Static manifest comparison must not execute a route factory.");
      },
    });
    const entrypoint = resolvePackageEntrypoint(
      packageRoot,
      route.artifact.entrypoint ?? metadata.entrypoint,
    );
    const entrypointStats = await fs.promises.lstat(entrypoint).catch(() => undefined);
    if (!entrypointStats?.isFile() || entrypointStats.isSymbolicLink()) {
      throw new CommunityServiceError(400, "Downloaded route entrypoint is missing or invalid.");
    }
    await this.installManagedDependencies(route, packageRoot, operation);
    this.updateOperation(operation, { progress: 70, message: "Validating route" });
    const exports = (await import(
      `${pathToFileURL(entrypoint).href}?install=${randomUUID()}`
    )) as unknown as RoutePackageModuleExportsV1;
    const routePackage = routePackageFromModuleExportsV1(exports);
    assertRouteManifestMatchesPackageV1(staticManifest, routePackage);
    assertRouteManifestMatchesPackageV1(route.manifest, routePackage);
    await fs.promises.mkdir(validationStorageDir, { recursive: true, mode: 0o700 });
    instantiateRoutePackageV1(routePackage, {
      profileId: this.profileId,
      env: process.env,
      storageDir: validationStorageDir,
      logger: this.logger ?? {
        debug() {}, info() {}, warn() {}, error() {},
      },
    });
    return { entrypoint };
  }

  private async installManagedDependencies(
    route: CommunityCatalogRoute,
    packageRoot: string,
    operation: CommunityOperation,
  ): Promise<void> {
    const dependencies = route.manifest.managedDependencies ?? [];
    if (dependencies.length === 0) return;
    const platform = managedDependencyPlatform();
    for (const dependency of dependencies) {
      const artifact = dependency.artifacts[platform as keyof typeof dependency.artifacts];
      if (!artifact) {
        throw new CommunityServiceError(
          400,
          `${dependency.displayName} ${dependency.version} does not support ${platform}.`,
        );
      }
      const executable = managedDependencyExecutable(packageRoot, dependency);
      await fs.promises.mkdir(path.dirname(executable), { recursive: true, mode: 0o700 });
      const failures: string[] = [];
      let downloaded = false;
      for (const [index, url] of artifact.urls.entries()) {
        await fs.promises.rm(executable, { force: true });
        this.updateOperation(operation, {
          progress: 60,
          message: `Downloading private dependency: ${dependency.displayName} ${dependency.version} (source ${index + 1}/${artifact.urls.length})`,
        });
        try {
          await this.downloadHttpsFile(
            url,
            executable,
            this.maxManagedDependencyBytes,
            this.dependencyDownloadTimeoutMs,
            `${dependency.displayName} ${dependency.version}`,
          );
          const digest = await sha256File(executable);
          if (digest !== artifact.sha256.toLowerCase()) {
            throw new CommunityServiceError(400, "SHA-256 mismatch");
          }
          downloaded = true;
          break;
        } catch (error) {
          failures.push(`source ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
          await fs.promises.rm(executable, { force: true });
        }
      }
      if (!downloaded) {
        throw new CommunityServiceError(
          502,
          `Could not download a verified ${dependency.displayName} binary (${failures.join("; ")}).`,
        );
      }
      await fs.promises.chmod(executable, 0o755);
      this.updateOperation(operation, {
        progress: 65,
        message: `Verifying private dependency: ${dependency.displayName} ${dependency.version}`,
      });
      const version = await runBoundedProcess(executable, ["--version"], {
        cwd: packageRoot,
        env: dependencyProcessEnv(executable),
        timeoutMs: this.dependencyVerifyTimeoutMs,
        label: `verifying ${dependency.displayName}`,
      });
      const detected = /(?:^|[^0-9A-Za-z])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=$|[^0-9A-Za-z])/.exec(
        `${version.stdout}\n${version.stderr}`,
      )?.[1];
      if (detected !== dependency.version) {
        throw new CommunityServiceError(
          500,
          `Managed dependency ${dependency.displayName} reported ${detected ?? "an unknown version"}; expected ${dependency.version}.`,
        );
      }
      const digestAfterProbe = await sha256File(executable);
      if (digestAfterProbe !== artifact.sha256.toLowerCase()) {
        throw new CommunityServiceError(
          400,
          `${dependency.displayName} changed itself during verification; installation was rolled back.`,
        );
      }
    }
  }

  private async activateWithRollback(
    previous: CommunityInstalledRegistry,
    next: CommunityInstalledRegistry,
    operation: CommunityOperation,
  ): Promise<void> {
    writeCommunityInstalledRegistry(this.registryPath, next);
    if (!this.onInstalledChanged) {
      this.updateOperation(operation, { restartRequired: true, progress: 90, message: "Restart required" });
      return;
    }
    try {
      this.updateOperation(operation, { progress: 90, message: "Activating" });
      await this.onInstalledChanged();
      this.updateOperation(operation, { restartRequired: false });
    } catch (error) {
      writeCommunityInstalledRegistry(this.registryPath, previous);
      let rollbackFailure: string | undefined;
      try {
        await this.onInstalledChanged();
      } catch (rollbackError) {
        rollbackFailure = rollbackError instanceof Error
          ? rollbackError.message
          : String(rollbackError);
        this.logger?.error("Community route activation rollback failed.", {
          error: rollbackFailure,
        });
      }
      if (rollbackFailure) {
        this.updateOperation(operation, { restartRequired: true });
        throw new CommunityServiceError(
          500,
          `Could not activate Community route. The registry was restored, but the live runtime ` +
            `could not be rolled back; restart WeConnect. Activation error: ${
              error instanceof Error ? error.message : String(error)
            }. Rollback error: ${rollbackFailure}`,
        );
      }
      throw new CommunityServiceError(
        500,
        `Could not activate Community route; previous installation was restored: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async installOrUpdate(
    operation: CommunityOperation,
    request: CommunityMutationRequest,
  ): Promise<void> {
    const route = await this.catalogRoute(operation.routeId, request.version);
    this.assertPermissionsAccepted(route, request.acceptedPermissions);
    this.assertCompatible(route);
    const previous = this.readRegistry();
    const current = previous.packages.find((item) => item.id === route.id);
    if (operation.kind === "install" && current) {
      throw new CommunityServiceError(409, `${route.displayName} is already installed.`);
    }
    if (operation.kind === "update" && !current) {
      throw new CommunityServiceError(409, `${route.displayName} is not installed.`);
    }
    if (operation.kind === "update" && current?.version === route.version) {
      throw new CommunityServiceError(409, `${route.displayName} is already at ${route.version}.`);
    }
    if (
      operation.kind === "update"
      && current
      && compareVersions(route.version, current.version) < 0
    ) {
      throw new CommunityServiceError(
        409,
        `${route.displayName} ${route.version} is older than installed version ${current.version}.`,
      );
    }

    const operationRoot = path.join(this.stagingRoot, operation.id);
    await fs.promises.mkdir(operationRoot, { recursive: true, mode: 0o700 });
    let targetDir: string | undefined;
    try {
      const packageRoot = await this.stageArtifact(route, operation, operationRoot);
      this.updateOperation(operation, { progress: 60, message: "Verifying" });
      const { entrypoint } = await this.validatePackage(
        route,
        packageRoot,
        path.join(operationRoot, "validation-storage"),
        operation,
      );
      const relativeEntrypoint = path.relative(packageRoot, entrypoint);
      targetDir = this.managedInstallDir(route.id, route.version);
      if (fs.existsSync(targetDir)) {
        await this.removeManagedInstallDir(targetDir, route.id, route.version);
      }
      await fs.promises.mkdir(path.dirname(targetDir), { recursive: true, mode: 0o700 });
      await fs.promises.rename(packageRoot, targetDir);
      const installed: InstalledCommunityRoute = {
        id: route.id,
        packageName: route.packageName,
        version: route.version,
        displayName: route.displayName,
        manifest: route.manifest,
        installDir: targetDir,
        entrypoint: path.join(targetDir, relativeEntrypoint),
        installedAt: new Date().toISOString(),
        sourceCatalog: route.sourceCatalog,
      };
      const next: CommunityInstalledRegistry = {
        schemaVersion: 1,
        packages: [
          ...previous.packages.filter((item) => item.id !== route.id),
          installed,
        ],
      };
      this.updateOperation(operation, { progress: 80, message: "Installing" });
      await this.activateWithRollback(previous, next, operation);
      if (current && current.installDir !== targetDir) {
        await this.removeManagedInstallDir(
          current.installDir,
          current.id,
          current.version,
        ).catch(() => {});
      }
    } catch (error) {
      if (targetDir && !this.readRegistry().packages.some(
        (item) => item.installDir === targetDir,
      )) {
        await this.removeManagedInstallDir(
          targetDir,
          route.id,
          route.version,
        ).catch(() => {});
      }
      throw error;
    } finally {
      await fs.promises.rm(operationRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async uninstall(operation: CommunityOperation): Promise<void> {
    const previous = this.readRegistry();
    const current = previous.packages.find((item) => item.id === operation.routeId);
    if (!current) {
      throw new CommunityServiceError(404, `Community route ${operation.routeId} is not installed.`);
    }
    const next: CommunityInstalledRegistry = {
      schemaVersion: 1,
      packages: previous.packages.filter((item) => item.id !== operation.routeId),
    };
    this.updateOperation(operation, { progress: 70, message: "Removing" });
    await this.activateWithRollback(previous, next, operation);
    await this.removeManagedInstallDir(current.installDir, current.id, current.version);
  }
}
