import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";

import {
  getDashboardSnapshot,
  getLoginStatus,
  requestQrLogin,
  saveSettings,
} from "./api";
import type {
  AgentSummary,
  DashboardSnapshot,
  LoginStatus,
  PageKey,
  QrLoginResponse,
  RouteSummary,
  SettingsSnapshot,
  TraceEvent,
} from "./types";

const pages: Array<{ key: PageKey; label: string; hint: string }> = [
  { key: "wechat", label: "WeChat", hint: "连接 / QR" },
  { key: "routes", label: "Routes", hint: "分发中心" },
  { key: "agents", label: "Agents", hint: "MCP / Agent" },
  { key: "trace", label: "Trace", hint: "Memory / Logs" },
  { key: "settings", label: "Settings", hint: "Keys / Autostart" },
];

function StatusPill(props: { active: boolean; label: string }) {
  return (
    <span className={props.active ? "pill pill-good" : "pill pill-muted"}>
      <span className="dot" />
      {props.label}
    </span>
  );
}

function EmptyState(props: { title: string; body: string }) {
  return (
    <section className="empty-state">
      <h3>{props.title}</h3>
      <p>{props.body}</p>
    </section>
  );
}

function WeChatPage(props: {
  data: DashboardSnapshot;
  qr: QrLoginResponse | null;
  loginStatus: LoginStatus | null;
  qrImage: string | null;
  qrError: string | null;
  onRequestQr: () => void;
}) {
  const { profile } = props.data;
  const status = props.loginStatus?.status ?? props.qr?.status;
  return (
    <main className="page-grid two-columns">
      <section className="panel hero-panel">
        <div className="section-title">
          <p>WeChat Profile</p>
          <StatusPill
            active={profile.connected}
            label={profile.connected ? "Connected" : "Disconnected"}
          />
        </div>
        <h1>{profile.name}</h1>
        <dl className="detail-grid">
          <div>
            <dt>Profile ID</dt>
            <dd>{profile.id}</dd>
          </div>
          <div>
            <dt>Account</dt>
            <dd>{profile.accountId ?? "Not logged in"}</dd>
          </div>
          <div>
            <dt>Runtime</dt>
            <dd>{profile.running ? "Running" : "Stopped"}</dd>
          </div>
          <div>
            <dt>Session</dt>
            <dd>{profile.sessionExpiresAt ?? "Unknown"}</dd>
          </div>
        </dl>
        <button className="primary-button" onClick={props.onRequestQr}>
          Request QR Login
        </button>
        <p className="muted">
          The desktop app talks to the local router daemon, which owns QR login
          and starts the runtime monitor after confirmation.
        </p>
      </section>

      <section className="panel qr-panel">
        <div className="section-title">
          <p>QR Login</p>
          <span className="pill pill-muted">Local only</span>
        </div>
        {props.qr ? (
          <>
            <div className="qr-box">
              {props.qrImage ? (
                <img src={props.qrImage} alt="WeChat login QR code" />
              ) : (
                <>
                  <span>QR</span>
                  <small>{props.qr.status}</small>
                </>
              )}
            </div>
            {props.qrError ? <p className="error-copy">{props.qrError}</p> : null}
            <code className="code-block">{props.qr.qrPayload}</code>
            <p className="muted">
              Status: {status ?? "unknown"} · Expires in {props.qr.expiresInSeconds}s
            </p>
            {props.loginStatus?.connected ? (
              <p className="success-copy">
                Logged in as {props.loginStatus.accountId ?? "WeChat bot"}. Runtime monitor is starting.
              </p>
            ) : null}
          </>
        ) : (
          <>
            {props.qrError ? <p className="error-copy">{props.qrError}</p> : null}
            <EmptyState
              title="No QR requested yet"
              body="Click the login button to ask the local router for a QR session."
            />
          </>
        )}
      </section>
    </main>
  );
}

function RouteCard(props: {
  route: RouteSummary;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={props.selected ? "route-card selected" : "route-card"}
      onClick={props.onClick}
    >
      <div className="route-card-head">
        <h3>{props.route.name}</h3>
        <StatusPill
          active={props.route.enabled}
          label={props.route.enabled ? "Enabled" : "Disabled"}
        />
      </div>
      <p>{props.route.description}</p>
      <div className="tag-row">
        {props.route.matchText.map((tag) => (
          <span className="tag" key={tag}>{tag}</span>
        ))}
      </div>
    </button>
  );
}

function TerminalLog(props: { traces: TraceEvent[] }) {
  return (
    <section className="terminal-panel">
      <div className="terminal-header">
        <div>
          <span className="terminal-dot red" />
          <span className="terminal-dot yellow" />
          <span className="terminal-dot green" />
        </div>
        <strong>terminal log</strong>
        <small>{props.traces.length} lines</small>
      </div>
      <div className="terminal-body">
        {props.traces.length ? (
          props.traces.map((trace) => (
            <div className="terminal-line" key={trace.id}>
              <span className="terminal-time">{trace.time}</span>
              <span className={`terminal-level terminal-level-${trace.level}`}>
                {trace.level}
              </span>
              <span className="terminal-source">{trace.source}</span>
              <span className="terminal-message">
                {trace.routeId ? `[${trace.routeId}] ` : ""}
                {trace.message}
              </span>
            </div>
          ))
        ) : (
          <div className="terminal-empty">waiting for router-daemon output...</div>
        )}
      </div>
    </section>
  );
}

function RoutesPage(props: {
  routes: RouteSummary[];
  traces: TraceEvent[];
  selectedRouteId: string | null;
  onSelect: (routeId: string | null) => void;
}) {
  const selected = props.routes.find((route) => route.id === props.selectedRouteId) ?? null;
  const isMainAssistant = selected?.id === "main-assistant-default";

  if (!selected) {
    return (
      <main className="page">
        <section className="page-header">
          <div>
            <p className="eyebrow">Router</p>
            <h1>Routes</h1>
          </div>
          <button className="secondary-button">New Route</button>
        </section>
        <section className="route-grid">
          {props.routes.map((route) => (
            <RouteCard
              key={route.id}
              route={route}
              selected={false}
              onClick={() => props.onSelect(route.id)}
            />
          ))}
        </section>
      </main>
    );
  }

  return (
    <main className="route-detail-layout">
      <aside className="route-list">
        <button className="back-button" onClick={() => props.onSelect(null)}>
          All routes
        </button>
        {props.routes.map((route) => (
          <button
            key={route.id}
            className={route.id === selected.id ? "route-list-item active" : "route-list-item"}
            onClick={() => props.onSelect(route.id)}
          >
            <strong>{route.name}</strong>
            <span>{route.connectorId}</span>
          </button>
        ))}
      </aside>
      <section className="panel route-detail">
        <div className="section-title">
          <p>{selected.id}</p>
          <StatusPill
            active={selected.enabled}
            label={selected.enabled ? "Enabled" : "Disabled"}
          />
        </div>
        <h1>{selected.name}</h1>
        <p className="large-copy">{selected.description}</p>
        <dl className="detail-grid">
          <div>
            <dt>Connector</dt>
            <dd>{selected.connectorId}</dd>
          </div>
          <div>
            <dt>Priority</dt>
            <dd>{selected.priority}</dd>
          </div>
          <div>
            <dt>Messages today</dt>
            <dd>{selected.stats.messagesToday}</dd>
          </div>
          <div>
            <dt>Last hit</dt>
            <dd>{selected.stats.lastHitAt ?? "Never"}</dd>
          </div>
        </dl>
        <h3>Match Rules</h3>
        <div className="tag-row">
          {selected.matchText.map((tag) => (
            <span className="tag tag-big" key={tag}>{tag}</span>
          ))}
        </div>
        <div className="button-row">
          <button className="primary-button">Edit Route</button>
          <button className="secondary-button">Open Trace</button>
        </div>
        {isMainAssistant ? (
          <>
            <h3>Terminal</h3>
            <TerminalLog traces={props.traces} />
          </>
        ) : null}
      </section>
    </main>
  );
}

function AgentsPage(props: { agents: AgentSummary[] }) {
  return (
    <main className="page">
      <section className="page-header">
        <div>
          <p className="eyebrow">Integrations</p>
          <h1>Agents / MCP</h1>
        </div>
        <button className="secondary-button">Add Connector</button>
      </section>
      <section className="list-panel">
        {props.agents.map((agent) => (
          <article className="row-card" key={agent.id}>
            <div>
              <h3>{agent.name}</h3>
              <p>{agent.description}</p>
            </div>
            <div className="row-meta">
              <span className="tag">{agent.kind}</span>
              <StatusPill active={agent.status === "ready"} label={agent.status} />
              <small>{agent.routeCount} routes</small>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}

function TracePage(props: { traces: TraceEvent[] }) {
  return (
    <main className="page">
      <section className="page-header">
        <div>
          <p className="eyebrow">Observability</p>
          <h1>Memory / Logs / Message Trace</h1>
        </div>
        <button className="secondary-button">Refresh</button>
      </section>
      <section className="trace-list">
        {props.traces.map((trace) => (
          <article className="trace-row" key={trace.id}>
            <span className={`level level-${trace.level}`}>{trace.level}</span>
            <div>
              <strong>{trace.source}</strong>
              <p>{trace.message}</p>
              {trace.routeId ? <small>route: {trace.routeId}</small> : null}
            </div>
            <time>{trace.time}</time>
          </article>
        ))}
      </section>
    </main>
  );
}

function SettingsPage(props: {
  settings: SettingsSnapshot;
  onSave: (settings: SettingsSnapshot) => Promise<void>;
}) {
  const [draft, setDraft] = useState(props.settings);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(props.settings);
  }, [props.settings]);

  async function submit() {
    await props.onSave(draft);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  }

  return (
    <main className="page narrow-page">
      <section className="page-header">
        <div>
          <p className="eyebrow">Local App</p>
          <h1>Settings</h1>
        </div>
        {saved ? <span className="pill pill-good">Saved</span> : null}
      </section>
      <section className="panel settings-form">
        <label>
          <span>LLM provider</span>
          <input
            value={draft.llmProvider}
            onChange={(event) =>
              setDraft({ ...draft, llmProvider: event.currentTarget.value })
            }
          />
        </label>
        <label>
          <span>Memory provider</span>
          <input
            value={draft.memoryProvider}
            onChange={(event) =>
              setDraft({ ...draft, memoryProvider: event.currentTarget.value })
            }
          />
        </label>
        <label>
          <span>Router endpoint</span>
          <input
            value={draft.routerEndpoint}
            onChange={(event) =>
              setDraft({ ...draft, routerEndpoint: event.currentTarget.value })
            }
          />
        </label>
        <label className="toggle-row">
          <span>
            <strong>Autostart</strong>
            <small>Start wechat2all when macOS logs in.</small>
          </span>
          <input
            type="checkbox"
            checked={draft.autostartEnabled}
            onChange={(event) =>
              setDraft({ ...draft, autostartEnabled: event.currentTarget.checked })
            }
          />
        </label>
        <button className="primary-button" onClick={() => void submit()}>
          Save Settings
        </button>
      </section>
    </main>
  );
}

function Sidebar(props: {
  active: PageKey;
  onChange: (page: PageKey) => void;
}) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">w2a</div>
        <div>
          <strong>wechat2all</strong>
          <span>local router</span>
        </div>
      </div>
      <nav>
        {pages.map((page) => (
          <button
            key={page.key}
            className={props.active === page.key ? "nav-item active" : "nav-item"}
            onClick={() => props.onChange(page.key)}
          >
            <strong>{page.label}</strong>
            <span>{page.hint}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}

export function App() {
  const [activePage, setActivePage] = useState<PageKey>("routes");
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [qr, setQr] = useState<QrLoginResponse | null>(null);
  const [loginStatus, setLoginStatus] = useState<LoginStatus | null>(null);
  const [qrImage, setQrImage] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getDashboardSnapshot()
      .then((data) => {
        if (!cancelled) setSnapshot(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedRouteStillExists = useMemo(
    () => snapshot?.routes.some((route) => route.id === selectedRouteId) ?? false,
    [snapshot, selectedRouteId],
  );

  useEffect(() => {
    if (selectedRouteId && !selectedRouteStillExists) {
      setSelectedRouteId(null);
    }
  }, [selectedRouteId, selectedRouteStillExists]);

  useEffect(() => {
    if (activePage !== "routes" && activePage !== "trace") return undefined;

    let cancelled = false;
    const refresh = async () => {
      try {
        const data = await getDashboardSnapshot();
        if (!cancelled) setSnapshot(data);
      } catch {
        // Keep the last good snapshot visible if the local daemon restarts.
      }
    };

    const timer = window.setInterval(() => void refresh(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activePage]);

  useEffect(() => {
    if (!snapshot || !qr) return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await getLoginStatus(snapshot.profile.id);
        if (cancelled) return;
        setLoginStatus(status);
        if (status.connected || status.status === "confirmed") {
          setSnapshot(await getDashboardSnapshot());
        }
        if (status.error) {
          setQrError(status.error);
        }
      } catch (err) {
        if (!cancelled) {
          setQrError(err instanceof Error ? err.message : String(err));
        }
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [snapshot?.profile.id, qr]);

  if (error) {
    return (
      <div className="app-shell">
        <EmptyState title="Dashboard failed to load" body={error} />
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="app-shell">
        <EmptyState title="Loading wechat2all" body="Preparing the local dashboard." />
      </div>
    );
  }

  async function onRequestQr() {
    if (!snapshot) return;
      setQrError(null);
      setQrImage(null);
      setLoginStatus(null);
      try {
      const response = await requestQrLogin(snapshot.profile.id);
      setQr(response);
      setQrImage(await QRCode.toDataURL(response.qrPayload, {
        width: 320,
        margin: 2,
        errorCorrectionLevel: "M",
        color: {
          dark: "#101713",
          light: "#ffffff",
        },
      }));
    } catch (err) {
      setQrError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onSaveSettings(settings: SettingsSnapshot) {
    const nextSettings = await saveSettings(settings);
    setSnapshot((current) =>
      current ? { ...current, settings: nextSettings } : current,
    );
  }

  return (
    <div className="app-shell">
      <Sidebar active={activePage} onChange={setActivePage} />
      <section className="content-shell">
        {activePage === "wechat" ? (
          <WeChatPage
            data={snapshot}
            qr={qr}
            loginStatus={loginStatus}
            qrImage={qrImage}
            qrError={qrError}
            onRequestQr={() => void onRequestQr()}
          />
        ) : null}
        {activePage === "routes" ? (
          <RoutesPage
            routes={snapshot.routes}
            traces={snapshot.traces}
            selectedRouteId={selectedRouteId}
            onSelect={setSelectedRouteId}
          />
        ) : null}
        {activePage === "agents" ? <AgentsPage agents={snapshot.agents} /> : null}
        {activePage === "trace" ? <TracePage traces={snapshot.traces} /> : null}
        {activePage === "settings" ? (
          <SettingsPage settings={snapshot.settings} onSave={onSaveSettings} />
        ) : null}
      </section>
    </div>
  );
}
