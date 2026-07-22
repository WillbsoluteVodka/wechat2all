import { useCallback, useEffect, useMemo, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

import {
  getCommunityCatalog,
  getCommunityInstalled,
  getCommunityOperation,
  getRouteSetupCheck,
  installCommunityRoute,
  refreshRouteSetupCheck,
  uninstallCommunityRoute,
  updateCommunityRoute,
} from "../api";
import type {
  CommunityCatalogRoute,
  CommunityInstalledRoute,
  CommunityOperation,
  CommunityOperationKind,
  RouteSetupCheckResponse,
} from "../types";
import { PixelText } from "../ui/PixelArt";

interface CommunityCard {
  id: string;
  catalog?: CommunityCatalogRoute;
  installed?: CommunityInstalledRoute;
}

interface PendingConfirmation {
  routeId: string;
  kind: CommunityOperationKind;
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

function operationLabel(operation: CommunityOperation) {
  const action = operation.kind === "install"
    ? "Installing"
    : operation.kind === "update"
      ? "Updating"
      : "Uninstalling";
  if (operation.status === "queued") return `${action} · queued`;
  if (operation.status === "running") return `${action} · ${Math.round(operation.progress)}%`;
  if (operation.status === "succeeded") return `${operation.kind} succeeded`;
  return `${operation.kind} failed`;
}

export function CommunityPage() {
  const [catalog, setCatalog] = useState<CommunityCatalogRoute[]>([]);
  const [installed, setInstalled] = useState<CommunityInstalledRoute[]>([]);
  const [operations, setOperations] = useState<Record<string, CommunityOperation>>({});
  const [setupChecks, setSetupChecks] = useState<Record<string, RouteSetupCheckResponse["check"]>>({});
  const [setupRefreshingId, setSetupRefreshingId] = useState<string | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);
  const [requestErrors, setRequestErrors] = useState<Record<
    string,
    { kind: CommunityOperationKind; message: string }
  >>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const [nextCatalog, nextInstalled] = await Promise.all([
        getCommunityCatalog(),
        getCommunityInstalled(),
      ]);
      const setupEntries = await Promise.all(nextInstalled.routes
        .filter((route) => route.manifest.capabilities.includes("setup-check"))
        .map(async (route) => {
          try {
            return [route.id, (await getRouteSetupCheck(route.id)).check] as const;
          } catch {
            return null;
          }
        }));
      setCatalog(nextCatalog.routes);
      setInstalled(nextInstalled.routes);
      setSetupChecks(Object.fromEntries(setupEntries.filter((entry) => entry !== null)));
      const installedIds = new Set(nextInstalled.routes.map((route) => route.id));
      const catalogById = new Map(nextCatalog.routes.map((route) => [route.id, route]));
      setOperations((current) => Object.fromEntries(Object.entries(current).map(([routeId, operation]) => {
        if (operation.message !== "Operation status was lost") return [routeId, operation];
        const reachedDesiredState = operation.kind === "uninstall"
          ? !installedIds.has(routeId)
          : operation.kind === "install"
            ? installedIds.has(routeId)
            : installedIds.has(routeId) && catalogById.get(routeId)?.status === "installed";
        return [routeId, reachedDesiredState
          ? {
              ...operation,
              status: "succeeded" as const,
              progress: 100,
              message: operation.kind === "uninstall" ? "Uninstalled" : "Installed",
              error: undefined,
              updatedAt: new Date().toISOString(),
            }
          : operation];
      })));
      setError(null);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  const activeOperationIds = Object.values(operations)
    .filter((operation) => operation.status === "queued" || operation.status === "running")
    .map((operation) => operation.id)
    .sort()
    .join("\0");

  useEffect(() => {
    const operationIds = activeOperationIds ? activeOperationIds.split("\0") : [];
    if (!operationIds.length) return undefined;

    let cancelled = false;
    let requestInFlight = false;
    const poll = async () => {
      if (requestInFlight) return;
      requestInFlight = true;
      try {
        const responses = await Promise.allSettled(
          operationIds.map((id) => getCommunityOperation(id)),
        );
        if (cancelled) return;
        const nextOperations = responses.flatMap((response) =>
          response.status === "fulfilled" ? [response.value.operation] : []
        );
        const lostOperations = responses.flatMap((response, index) => {
          if (response.status === "fulfilled") return [];
          const message = errorMessage(response.reason);
          return /(?:404|not found|unknown community operation)/i.test(message)
            ? [{ id: operationIds[index]!, message }]
            : [];
        });
        setOperations((current) => ({
          ...current,
          ...Object.fromEntries(nextOperations.map((operation) => [operation.routeId, operation])),
          ...Object.fromEntries(lostOperations.flatMap(({ id, message }) => {
            const previous = Object.values(current).find((operation) => operation.id === id);
            return previous
              ? [[previous.routeId, {
                  ...previous,
                  status: "failed" as const,
                  message: "Operation status was lost",
                  error: `${message} Refresh the catalog and retry if needed.`,
                  updatedAt: new Date().toISOString(),
                }]]
              : [];
          })),
        }));
        if (nextOperations.some(
          (operation) => operation.status === "succeeded" || operation.status === "failed",
        ) || lostOperations.length) {
          await refresh();
        }
        const transientFailure = responses.find((response) =>
          response.status === "rejected"
          && !/(?:404|not found|unknown community operation)/i.test(errorMessage(response.reason))
        );
        if (transientFailure?.status === "rejected") {
          setError(errorMessage(transientFailure.reason));
        }
      } catch (reason) {
        if (!cancelled) setError(errorMessage(reason));
      } finally {
        requestInFlight = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeOperationIds, refresh]);

  const cards = useMemo(() => {
    const byId = new Map<string, CommunityCard>();
    for (const route of catalog) byId.set(route.id, { id: route.id, catalog: route });
    for (const route of installed) {
      const current = byId.get(route.id);
      byId.set(route.id, { id: route.id, catalog: current?.catalog, installed: route });
    }
    return Array.from(byId.values()).sort((left, right) => {
      const leftName = left.catalog?.displayName ?? left.installed?.displayName ?? left.id;
      const rightName = right.catalog?.displayName ?? right.installed?.displayName ?? right.id;
      return leftName.localeCompare(rightName);
    });
  }, [catalog, installed]);
  const installedCount = cards.filter((card) => card.installed).length;

  async function beginOperation(
    kind: CommunityOperationKind,
    card: CommunityCard,
    confirmed = false,
  ) {
    const route = card.catalog;
    const requiredPermissions = route?.manifest.permissions
      .filter((permission) => !permission.optional)
      .map((permission) => permission.name) ?? [];

    const needsConfirmation = kind === "uninstall"
      || ((kind === "install" || kind === "update") && requiredPermissions.length > 0);
    if (needsConfirmation && !confirmed) {
      setPendingConfirmation({ routeId: card.id, kind });
      return;
    }
    setPendingConfirmation(null);

    setRequestErrors((current) => {
      const next = { ...current };
      delete next[card.id];
      return next;
    });
    setError(null);
    try {
      const payload = {
        version: route?.version,
        acceptedPermissions: requiredPermissions,
      };
      const response = kind === "install"
        ? await installCommunityRoute(card.id, payload)
        : kind === "update"
          ? await updateCommunityRoute(card.id, payload)
          : await uninstallCommunityRoute(card.id);
      setOperations((current) => ({ ...current, [card.id]: response.operation }));
      if (response.operation.status === "succeeded") await refresh();
    } catch (reason) {
      setRequestErrors((current) => ({
        ...current,
        [card.id]: { kind, message: errorMessage(reason) },
      }));
    }
  }

  async function recheckSetup(routeId: string) {
    setSetupRefreshingId(routeId);
    setError(null);
    try {
      const response = await refreshRouteSetupCheck(routeId);
      setSetupChecks((current) => ({ ...current, [routeId]: response.check }));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSetupRefreshingId(null);
    }
  }

  async function openRequirement(url: string) {
    setError(null);
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") {
        throw new Error("Community requirement links must use HTTPS.");
      }
      if (isTauri()) {
        await openUrl(parsed.href);
      } else {
        window.open(parsed.href, "_blank", "noopener,noreferrer");
      }
    } catch (reason) {
      setError(`Could not open requirement download: ${errorMessage(reason)}`);
    }
  }

  return (
    <main className="page community-page">
      <header className="community-hero">
        <div className="community-hero-copy">
          <p className="home-kicker">ROUTE MARKETPLACE</p>
          <h1>
            <PixelText text="Community" className="community-title-pixel" />
          </h1>
          <p>Install independent routes without changing the WeConnect application.</p>
        </div>
        <div className="community-hero-side">
          <div className="community-catalog-stats" aria-label="Community catalog summary">
            <div>
              <span>CATALOG ROUTES</span>
              <strong>{loading ? "--" : String(cards.length).padStart(2, "0")}</strong>
            </div>
            <div>
              <span>INSTALLED</span>
              <strong>{loading ? "--" : String(installedCount).padStart(2, "0")}</strong>
            </div>
          </div>
          <button
            className="secondary-button community-refresh"
            type="button"
            disabled={loading}
            onClick={() => void refresh(true)}
          >
            {loading ? "SYNCING..." : "REFRESH CATALOG"}
          </button>
        </div>
      </header>

      {error ? (
        <section className="community-system-message is-error" role="alert">
          <span aria-hidden="true">[!]</span>
          <div>
            <strong>COMMUNITY IS UNAVAILABLE</strong>
            <p>{error}</p>
          </div>
          <button className="secondary-button" type="button" onClick={() => void refresh(true)}>
            RETRY
          </button>
        </section>
      ) : null}

      {loading ? (
        <section className="community-system-message is-loading" aria-live="polite">
          <span aria-hidden="true">[~]</span>
          <div>
            <strong>READING COMMUNITY CATALOG</strong>
            <p>Scanning available route packages and local installations...</p>
          </div>
        </section>
      ) : error && cards.length === 0 ? null : cards.length === 0 ? (
        <section className="community-system-message is-empty">
          <span aria-hidden="true">[ ]</span>
          <div>
            <strong>NO ROUTES AVAILABLE</strong>
            <p>The configured Community catalog does not contain any routes yet.</p>
          </div>
        </section>
      ) : (
        <section className="community-grid" aria-label="Community routes">
          {cards.map((card) => {
            const route = card.catalog;
            const manifest = route?.manifest ?? card.installed?.manifest;
            if (!manifest) return null;
            const operation = operations[card.id];
            const requestError = requestErrors[card.id];
            const busy = operation?.status === "queued" || operation?.status === "running";
            const failedOperation = operation?.status === "failed" ? operation : null;
            const retryKind = failedOperation?.kind ?? requestError?.kind;
            const installedVersion = card.installed?.version ?? route?.installedVersion;
            const updateAvailable = route?.status === "update-available";
            const setupCheck = setupChecks[card.id];
            const confirmation = pendingConfirmation?.routeId === card.id
              ? pendingConfirmation
              : null;
            const requiredPermissions = manifest.permissions
              .filter((permission) => !permission.optional)
              .map((permission) => permission.name);
            const statusLabel = busy && operation
              ? operationLabel(operation)
              : failedOperation || requestError
                ? "Failed"
                : updateAvailable
                  ? "Update available"
                  : card.installed
                    ? setupCheck?.status === "ready"
                      ? "Ready"
                      : setupCheck?.status === "error"
                        ? "Needs setup"
                        : setupCheck?.status === "checking"
                          ? "Checking setup"
                          : "Installed"
                    : "Available";
            const statusTone = busy || setupCheck?.status === "checking"
              ? "is-checking"
              : failedOperation || requestError
                ? "is-error"
                : updateAvailable || setupCheck?.status === "error"
                  ? "is-warning"
                  : card.installed && setupCheck?.status !== "ready"
                    ? "is-muted"
                    : "is-ready";

            return (
              <article className="panel community-card" key={card.id}>
                <div className="community-card-heading">
                  <div>
                    <p className="home-kicker">{manifest.packageName}</p>
                    <h2>
                      <PixelText text={manifest.displayName} className="community-route-title" />
                    </h2>
                  </div>
                  <strong className={`community-status ${statusTone}`}>
                    <i aria-hidden="true" />
                    {statusLabel}
                  </strong>
                </div>

                <p>{route?.description ?? manifest.description}</p>
                {card.installed && setupCheck ? (
                  <p className="community-setup-message">
                    {setupCheck.items[0]?.message
                      ?? (setupCheck.status === "ready" ? "Setup check passed." : "Setup check is pending.")}
                  </p>
                ) : null}
                <dl className="community-meta">
                  <div><dt>Latest</dt><dd>{route?.version ?? manifest.version}</dd></div>
                  <div><dt>Installed</dt><dd>{installedVersion ?? "—"}</dd></div>
                  <div><dt>Author</dt><dd>{manifest.author?.name ?? "Unknown"}</dd></div>
                </dl>

                <div className="community-details">
                  <section>
                    <h3>Permissions</h3>
                    {manifest.permissions.length ? (
                      <ul>
                        {manifest.permissions.map((permission) => (
                          <li key={permission.name}>
                            <span>
                              <strong>{permission.name}</strong>
                              {permission.optional ? " (optional)" : ""}: {permission.reason}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : <p>No additional permissions.</p>}
                  </section>
                  <section>
                    <h3>Requirements</h3>
                    <ul>
                      <li><span>WeConnect {manifest.engines.weconnect}</span></li>
                      {manifest.engines.node ? (
                        <li><span>Node {manifest.engines.node}</span></li>
                      ) : null}
                      {manifest.managedDependencies?.map((dependency) => (
                        <li key={`${dependency.id}@${dependency.version}`}>
                          <span>
                            <strong>{dependency.displayName} {dependency.version}</strong>
                            {": downloaded and checksum-verified inside this route; removed with it"}
                          </span>
                        </li>
                      ))}
                      {route?.requirements?.map((requirement) => (
                        <li key={requirement.name}>
                          <span>
                            <strong>{requirement.name}</strong>
                            {requirement.required === false ? " (optional)" : ""}
                            {requirement.description ? `: ${requirement.description}` : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                </div>

                {operation ? (
                  <div className="community-operation" aria-live="polite">
                    {(operation.status === "queued" || operation.status === "running") ? (
                      <progress max={100} value={Math.max(0, Math.min(100, operation.progress))} />
                    ) : null}
                    <strong>{operationLabel(operation)}</strong>
                    {operation.message ? <span>{operation.message}</span> : null}
                    {operation.error ? <span className="community-operation-error">{operation.error}</span> : null}
                    {operation.restartRequired ? <span>Router daemon restart required.</span> : null}
                  </div>
                ) : null}
                {requestError ? (
                  <p className="community-operation-error" role="alert">{requestError.message}</p>
                ) : null}
                {confirmation ? (
                  <div className="community-operation" role="group" aria-label="Confirm Community action">
                    <strong>
                      {confirmation.kind === "uninstall"
                        ? `Confirm uninstalling ${manifest.displayName}`
                        : `Confirm ${confirmation.kind} for ${manifest.displayName}`}
                    </strong>
                    {confirmation.kind !== "uninstall" && requiredPermissions.length ? (
                      <span>Permissions: {requiredPermissions.join(", ")}</span>
                    ) : null}
                    {confirmation.kind !== "uninstall" && manifest.managedDependencies?.length ? (
                      <span>
                        Private dependencies: {manifest.managedDependencies.map((dependency) =>
                          `${dependency.displayName} ${dependency.version} (verified private binary)`
                        ).join(", ")}
                      </span>
                    ) : null}
                    <div className="button-row">
                      <button
                        className="primary-button"
                        type="button"
                        onClick={() => void beginOperation(confirmation.kind, card, true)}
                      >
                        CONFIRM
                      </button>
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => setPendingConfirmation(null)}
                      >
                        CANCEL
                      </button>
                    </div>
                  </div>
                ) : null}

                <div className="button-row community-actions">
                  {route?.requirements?.filter((requirement) => requirement.url).map((requirement) => (
                    <button
                      className="secondary-button"
                      type="button"
                      key={`${requirement.name}-${requirement.url}`}
                      disabled={busy || Boolean(confirmation)}
                      onClick={() => void openRequirement(requirement.url!)}
                    >
                      DOWNLOAD {requirement.name.toUpperCase()}
                    </button>
                  ))}
                  {!card.installed ? (
                    <button
                      className="primary-button"
                      type="button"
                      disabled={busy || !route || Boolean(confirmation)}
                      onClick={() => void beginOperation("install", card)}
                    >
                      INSTALL
                    </button>
                  ) : null}
                  {card.installed && updateAvailable ? (
                    <button
                      className="primary-button"
                      type="button"
                      disabled={busy || !route || Boolean(confirmation)}
                      onClick={() => void beginOperation("update", card)}
                    >
                      UPDATE
                    </button>
                  ) : null}
                  {card.installed ? (
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={busy || Boolean(confirmation)}
                      onClick={() => void beginOperation("uninstall", card)}
                    >
                      UNINSTALL
                    </button>
                  ) : null}
                  {card.installed && manifest.capabilities.includes("setup-check") ? (
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={busy || Boolean(confirmation) || setupRefreshingId === card.id}
                      onClick={() => void recheckSetup(card.id)}
                    >
                      {setupRefreshingId === card.id ? "CHECKING..." : "RECHECK SETUP"}
                    </button>
                  ) : null}
                  {retryKind ? (
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={busy || Boolean(confirmation)
                        || ((retryKind === "install" || retryKind === "update") && !route)}
                      onClick={() => void beginOperation(retryKind, card)}
                    >
                      RETRY
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })}
        </section>
      )}
    </main>
  );
}
