import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
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
  { key: "wechat", label: "WeChat", hint: "QR ignition" },
  { key: "routes", label: "Routes", hint: "routing matrix" },
  { key: "agents", label: "Agents", hint: "MCP fabric" },
  { key: "trace", label: "Trace", hint: "signal memory" },
  { key: "settings", label: "Settings", hint: "local core" },
];

type RouteCardStyle = CSSProperties & Record<"--route-signal" | "--route-delay", string>;

function SignalField() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvasElement = canvasRef.current;
    if (!canvasElement) return undefined;

    const canvasContext = canvasElement.getContext("2d");
    if (!canvasContext) return undefined;
    const canvas: HTMLCanvasElement = canvasElement;
    const context: CanvasRenderingContext2D = canvasContext;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const pointer = { x: 0, y: 0, active: false };
    let animationFrame = 0;
    let width = 0;
    let height = 0;
    let dpr = 1;

    const particles = Array.from({ length: 150 }, (_, index) => {
      const seed = (index * 9301 + 49297) % 233280;
      const seedAlt = (index * 233 + 719) % 997;
      return {
        baseX: (seed % 1000) / 1000,
        baseY: (seedAlt % 1000) / 1000,
        phase: index * 0.61,
        radius: 0.45 + ((seedAlt % 9) / 12),
        drift: 8 + (seed % 24),
        speed: 0.00016 + (seedAlt % 7) * 0.000035,
        depth: 0.45 + ((seed % 31) / 42),
        channel: index % 6,
      };
    });

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, Math.floor(rect.width));
      height = Math.max(1, Math.floor(rect.height));
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function draw(timestamp: number) {
      context.clearRect(0, 0, width, height);
      context.globalCompositeOperation = "source-over";

      const centerX = width * 0.69;
      const centerY = height * 0.46;
      const pulse = 0.5 + Math.sin(timestamp * 0.0011) * 0.5;

      context.save();
      context.translate(centerX, centerY);
      context.rotate(timestamp * 0.000025);
      for (let ring = 0; ring < 4; ring += 1) {
        const radius = Math.min(width, height) * (0.13 + ring * 0.06) + pulse * 4;
        context.beginPath();
        context.ellipse(0, 0, radius * 1.38, radius, 0, 0, Math.PI * 2);
        context.strokeStyle = `rgba(144, 171, 166, ${0.07 - ring * 0.01})`;
        context.lineWidth = 1;
        context.stroke();
      }
      context.restore();

      context.globalCompositeOperation = "lighter";

      for (let index = 0; index < particles.length; index += 1) {
        const particle = particles[index];
        const orbitX =
          Math.sin(timestamp * particle.speed + particle.phase) * particle.drift;
        const orbitY =
          Math.cos(timestamp * particle.speed * 1.5 + particle.phase) * particle.drift;
        let x = particle.baseX * width + orbitX;
        let y = particle.baseY * height + orbitY;

        if (pointer.active) {
          const dx = pointer.x - x;
          const dy = pointer.y - y;
          const distance = Math.hypot(dx, dy);
          const field = Math.max(0, 1 - distance / 260);
          const spin = field * field * (46 + particle.depth * 16);
          x -= (dy / Math.max(distance, 1)) * spin;
          y += (dx / Math.max(distance, 1)) * spin;
        }

        context.beginPath();
        context.arc(x, y, particle.radius, 0, Math.PI * 2);
        context.fillStyle =
          particle.channel === 0
            ? "rgba(173, 255, 209, 0.76)"
            : particle.channel === 3
              ? "rgba(255, 174, 94, 0.34)"
              : "rgba(167, 185, 184, 0.3)";
        context.shadowColor =
          particle.channel === 0
            ? "rgba(141, 255, 210, 0.42)"
            : "rgba(164, 186, 184, 0.14)";
        context.shadowBlur = particle.channel === 0 ? 8 : 3;
        context.fill();

        if (index % 11 === 0) {
          context.beginPath();
          context.moveTo(x, y);
          context.lineTo(
            x + Math.sin(timestamp * 0.0003 + particle.phase) * 34,
            y + Math.cos(timestamp * 0.00024 + particle.phase) * 18,
          );
          context.strokeStyle = "rgba(150, 178, 174, 0.075)";
          context.lineWidth = 1;
          context.stroke();
        }
      }

      context.globalCompositeOperation = "source-over";
      context.shadowBlur = 0;
      if (!reducedMotion.matches) {
        animationFrame = window.requestAnimationFrame(draw);
      }
    }

    function handlePointerMove(event: globalThis.PointerEvent) {
      pointer.active = true;
      pointer.x = event.clientX;
      pointer.y = event.clientY;
    }

    function handlePointerLeave() {
      pointer.active = false;
    }

    resize();
    draw(0);
    if (!reducedMotion.matches) {
      animationFrame = window.requestAnimationFrame(draw);
    }

    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerleave", handlePointerLeave);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerleave", handlePointerLeave);
    };
  }, []);

  return <canvas className="signal-field" ref={canvasRef} aria-hidden="true" />;
}

function AmbientField() {
  return (
    <div className="ambient-field" aria-hidden="true">
      <SignalField />
      <div className="brushed-noise" />
      <div className="metal-orbit metal-orbit-a">
        <span />
        <span />
        <span />
      </div>
      <div className="metal-orbit metal-orbit-b">
        <span />
        <span />
      </div>
      <div className="scan-dust" />
    </div>
  );
}

function SignalBars(props: { active: boolean }) {
  return (
    <span className={props.active ? "signal-bars is-active" : "signal-bars"} aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}

function StatusPill(props: { active: boolean; label: string }) {
  return (
    <span className={props.active ? "pill pill-good" : "pill pill-muted"}>
      <span className="dot" aria-hidden="true" />
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
  const runtimeState = profile.running ? "runtime monitor active" : "runtime monitor idle";

  return (
    <main className="page-grid two-columns">
      <section className="panel hero-panel">
        <div className="hero-panel-main">
          <div>
            <div className="section-title">
              <p>WeChat ignition bay</p>
              <StatusPill
                active={profile.connected}
                label={profile.connected ? "Connected" : "Disconnected"}
              />
            </div>
            <h1>{profile.name}</h1>
            <p className="large-copy">
              Local-first bridge for WeChat routing, login custody, and daemon health.
            </p>
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
          </div>
          <div className="profile-module">
            <div className={profile.connected ? "status-reactor online" : "status-reactor"} aria-hidden="true">
              <span className="reactor-ring ring-outer" />
              <span className="reactor-ring ring-inner" />
              <span className="reactor-core">{profile.connected ? "ON" : "ID"}</span>
              <span className="reactor-scan" />
            </div>
            <div className="micro-console">
              <span>{runtimeState}</span>
              <SignalBars active={profile.running} />
            </div>
          </div>
        </div>
        <p className="muted">
          The desktop app talks to the local router daemon, which owns QR login
          and starts the runtime monitor after confirmation.
        </p>
      </section>

      <section className="panel qr-panel">
        <div className="section-title">
          <p>QR capture chamber</p>
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
  const signalStrength = Math.max(
    14,
    Math.min(100, Math.abs(props.route.priority) / 10 + props.route.stats.messagesToday * 6),
  );
  const routeStyle: RouteCardStyle = {
    "--route-signal": `${signalStrength}%`,
    "--route-delay": `${Math.abs(props.route.priority) % 9}s`,
  };

  return (
    <button
      className={[
        "route-card",
        props.route.enabled ? "is-enabled" : "is-disabled",
        props.selected ? "selected" : "",
      ].join(" ")}
      style={routeStyle}
      onClick={props.onClick}
      aria-pressed={props.selected}
    >
      <span className="route-card-field" aria-hidden="true" />
      <span className="route-card-signal" aria-hidden="true" />
      <div className="route-card-head">
        <h3>{props.route.name}</h3>
        <StatusPill
          active={props.route.enabled}
          label={props.route.enabled ? "Enabled" : "Disabled"}
        />
      </div>
      <p>{props.route.description}</p>
      <div className="route-card-meta">
        <span>{props.route.connectorId}</span>
        <span>priority {props.route.priority}</span>
        <SignalBars active={props.route.enabled} />
      </div>
      <div className="tag-row">
        {props.route.matchText.map((tag) => (
          <span className="tag" key={tag}>{tag}</span>
        ))}
      </div>
    </button>
  );
}

function RoutesStage(props: {
  routes: RouteSummary[];
  traces: TraceEvent[];
  onOpenTrace: () => void;
}) {
  const enabledRoutes = props.routes.filter((route) => route.enabled).length;
  const liveRoutes = props.routes.filter((route) => route.stats.messagesToday > 0).length;

  return (
    <section className="command-stage">
      <div className="stage-copy">
        <p className="stage-kicker">Routing matrix</p>
        <h1>Route signal desk</h1>
        <p>
          Every incoming WeChat message lands here first: classified, matched, and routed into
          local agents without leaving the machine.
        </p>
        <div className="stage-actions">
          <button className="primary-button">New Route</button>
          <button className="secondary-button" onClick={props.onOpenTrace}>Open Trace</button>
        </div>
      </div>
      <div className="stage-telemetry" aria-label="Route telemetry">
        <div>
          <span>routes</span>
          <strong>{props.routes.length}</strong>
        </div>
        <div>
          <span>armed</span>
          <strong>{enabledRoutes}</strong>
        </div>
        <div>
          <span>live</span>
          <strong>{liveRoutes}</strong>
        </div>
        <div>
          <span>trace</span>
          <strong>{props.traces.length}</strong>
        </div>
      </div>
      <div className="route-orb" aria-hidden="true">
        <span className="orb-ring orb-ring-a" />
        <span className="orb-ring orb-ring-b" />
        <span className="orb-ring orb-ring-c" />
        {props.routes.slice(0, 6).map((route, index) => (
          <span
            className={route.enabled ? "orb-node is-enabled" : "orb-node"}
            style={{ "--node-index": String(index) } as CSSProperties}
            key={route.id}
          />
        ))}
        <span className="orb-core">
          <strong>{enabledRoutes}</strong>
          <small>armed</small>
        </span>
      </div>
    </section>
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
  onOpenTrace: () => void;
}) {
  const selected = props.routes.find((route) => route.id === props.selectedRouteId) ?? null;
  const isMainAssistant = selected?.id === "main-assistant-default";

  if (!selected) {
    return (
      <main className="page">
        <RoutesStage
          routes={props.routes}
          traces={props.traces}
          onOpenTrace={props.onOpenTrace}
        />
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
          <button className="secondary-button" onClick={props.onOpenTrace}>Open Trace</button>
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
          <p className="eyebrow">Connector fabric</p>
          <h1>Agents / MCP</h1>
        </div>
        <button className="secondary-button">Add Connector</button>
      </section>
      <section className="list-panel">
        {props.agents.map((agent, index) => (
          <article className="row-card" key={agent.id}>
            <span className="agent-orb" style={{ "--node-index": String(index) } as CSSProperties} />
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
          <p className="eyebrow">Signal recorder</p>
          <h1>Memory / Logs / Message Trace</h1>
        </div>
        <button className="secondary-button">Refresh</button>
      </section>
      <section className="trace-list">
        {props.traces.length ? (
          props.traces.map((trace) => (
            <article className="trace-row" key={trace.id}>
              <span className={`level level-${trace.level}`}>{trace.level}</span>
              <div>
                <strong>{trace.source}</strong>
                <p>{trace.message}</p>
                {trace.routeId ? <small>route: {trace.routeId}</small> : null}
              </div>
              <time>{trace.time}</time>
            </article>
          ))
        ) : (
          <EmptyState title="Trace buffer idle" body="Messages will appear here after the router receives traffic." />
        )}
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
        <div className="brand-mark" aria-hidden="true">
          <span className="brand-halo" />
          <span>w2a</span>
        </div>
        <div>
          <strong>wechat2all</strong>
          <span>local signal router</span>
        </div>
      </div>
      <div className="sidebar-status" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <nav>
        {pages.map((page, index) => (
          <button
            key={page.key}
            className={props.active === page.key ? "nav-item active" : "nav-item"}
            onClick={() => props.onChange(page.key)}
          >
            <span className="nav-index">{String(index + 1).padStart(2, "0")}</span>
            <strong>{page.label}</strong>
            <span>{page.hint}</span>
            <span className="nav-light" aria-hidden="true" />
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

  function handleShellPointerMove(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    event.currentTarget.style.setProperty("--pointer-x", `${Math.round(x * 100)}%`);
    event.currentTarget.style.setProperty("--pointer-y", `${Math.round(y * 100)}%`);
    event.currentTarget.style.setProperty("--tilt-x", `${(0.5 - y) * 8}deg`);
    event.currentTarget.style.setProperty("--tilt-y", `${(x - 0.5) * 10}deg`);
  }

  function handleShellPointerLeave(event: PointerEvent<HTMLDivElement>) {
    event.currentTarget.style.setProperty("--pointer-x", "72%");
    event.currentTarget.style.setProperty("--pointer-y", "18%");
    event.currentTarget.style.setProperty("--tilt-x", "0deg");
    event.currentTarget.style.setProperty("--tilt-y", "0deg");
  }

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
      <div className="app-shell empty-shell">
        <AmbientField />
        <EmptyState title="Dashboard failed to load" body={error} />
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="app-shell empty-shell">
        <AmbientField />
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
          dark: "#0b1012",
          light: "#f4f8f6",
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
    <div
      className="app-shell"
      onPointerMove={handleShellPointerMove}
      onPointerLeave={handleShellPointerLeave}
    >
      <AmbientField />
      <Sidebar active={activePage} onChange={setActivePage} />
      <section className="content-shell">
        <header className="topbar">
          <div>
            <span className="topbar-kicker">Gateway console</span>
            <strong>Local WeChat command surface</strong>
          </div>
          <div className="topbar-wave" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </div>
          <div className="topbar-status">
            <StatusPill
              active={snapshot.profile.running}
              label={snapshot.profile.running ? "Runtime live" : "Runtime idle"}
            />
            <span>{snapshot.routes.length} routes</span>
            <span>{snapshot.traces.length} trace lines</span>
          </div>
        </header>
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
            onOpenTrace={() => setActivePage("trace")}
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
