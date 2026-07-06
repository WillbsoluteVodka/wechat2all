import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
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

function StartupGate(props: { onEnter: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const canvasElement = canvas;
    const gl = canvasElement.getContext("webgl", {
      antialias: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: true,
    });
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    if (!gl) {
      return undefined;
    }
    const glContext = gl;

    const vertexShaderSource = `
      attribute vec2 position;

      void main() {
        gl_Position = vec4(position, 0.0, 1.0);
      }
    `;

    const fragmentShaderSource = `
      #define TWO_PI 6.2831853072
      #define PI 3.14159265359

      precision highp float;
      uniform vec2 resolution;
      uniform float time;

      void main(void) {
        vec2 uv = (gl_FragCoord.xy * 2.0 - resolution.xy) / min(resolution.x, resolution.y);
        float t = time * 0.05;
        float lineWidth = 0.002;

        vec3 energy = vec3(0.0);
        for (int j = 0; j < 3; j++) {
          for (int i = 0; i < 5; i++) {
            energy[j] += lineWidth * float(i * i) / abs(
              fract(t - 0.01 * float(j) + float(i) * 0.01) * 5.0
              - length(uv)
              + mod(uv.x + uv.y, 0.2)
            );
          }
        }

        float glow = max(max(energy.r, energy.g), energy.b);
        float edge = smoothstep(0.025, 0.55, glow);
        float hotEdge = smoothstep(0.68, 2.05, glow);
        float intensity = smoothstep(0.0, 0.78, glow);
        float metalBand = smoothstep(0.02, 0.34, energy.r + energy.b);
        vec3 channels = 1.0 - exp(-energy * vec3(0.95, 1.45, 1.08));
        vec3 channelEdges = smoothstep(vec3(0.008), vec3(0.58), energy);
        vec3 softChannels = smoothstep(vec3(0.002), vec3(0.28), energy);

        vec3 black = vec3(0.0);
        vec3 graphite = vec3(0.035, 0.039, 0.038);
        vec3 brushedSilver = vec3(0.52, 0.54, 0.53);
        vec3 chromeWhite = vec3(0.88, 0.89, 0.86);
        vec3 metallicGreen = vec3(0.1098, 0.8314, 0.3373);
        vec3 coldSilver = vec3(0.73, 0.86, 0.78);
        vec3 paleGreenWhite = vec3(0.82, 1.0, 0.88);

        vec3 metal = graphite * edge * 0.18;
        metal += brushedSilver * channelEdges.r * 0.82;
        metal += metallicGreen * channelEdges.g * 0.96;
        metal += coldSilver * channelEdges.b * 0.74;
        metal += paleGreenWhite * channelEdges.b * channelEdges.g * 0.46;
        metal += vec3(0.045, 0.09, 0.055) * metalBand;
        vec3 softHaze = brushedSilver * softChannels.r * 0.16;
        softHaze += metallicGreen * softChannels.g * 0.17;
        softHaze += coldSilver * softChannels.b * 0.14;
        softHaze *= 1.0 - hotEdge * 0.38;

        float greenHint = smoothstep(0.18, 1.35, energy.g)
          * smoothstep(0.25, 1.3, glow)
          * (0.11 + hotEdge * 0.08);
        float whiteCore = smoothstep(0.55, 1.65, channels.r + channels.g + channels.b);
        vec3 finalColor = vec3(0.004, 0.014, 0.008);
        finalColor += metal * (0.12 + intensity * 0.68);
        finalColor += softHaze;
        finalColor += metallicGreen * greenHint;
        finalColor = mix(finalColor, chromeWhite, whiteCore * 0.14 + hotEdge * 0.08);
        finalColor *= 0.7 + hotEdge * 0.1;
        finalColor = clamp(finalColor, black, vec3(1.0));

        gl_FragColor = vec4(finalColor, 1.0);
      }
    `;

    function createShader(type: number, source: string) {
      const shader = glContext.createShader(type);
      if (!shader) return null;
      glContext.shaderSource(shader, source);
      glContext.compileShader(shader);

      if (!glContext.getShaderParameter(shader, glContext.COMPILE_STATUS)) {
        console.error(glContext.getShaderInfoLog(shader));
        glContext.deleteShader(shader);
        return null;
      }

      return shader;
    }

    const vertexShader = createShader(glContext.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = createShader(glContext.FRAGMENT_SHADER, fragmentShaderSource);
    const program = glContext.createProgram();

    if (!vertexShader || !fragmentShader || !program) {
      return undefined;
    }

    glContext.attachShader(program, vertexShader);
    glContext.attachShader(program, fragmentShader);
    glContext.linkProgram(program);

    if (!glContext.getProgramParameter(program, glContext.LINK_STATUS)) {
      console.error(glContext.getProgramInfoLog(program));
      glContext.deleteProgram(program);
      glContext.deleteShader(vertexShader);
      glContext.deleteShader(fragmentShader);
      return undefined;
    }

    const positionLocation = glContext.getAttribLocation(program, "position");
    const resolutionLocation = glContext.getUniformLocation(program, "resolution");
    const timeLocation = glContext.getUniformLocation(program, "time");
    const positionBuffer = glContext.createBuffer();
    let animationId = 0;
    let width = 1;
    let height = 1;

    glContext.bindBuffer(glContext.ARRAY_BUFFER, positionBuffer);
    glContext.bufferData(
      glContext.ARRAY_BUFFER,
      new Float32Array([
        -1, -1,
        1, -1,
        -1, 1,
        -1, 1,
        1, -1,
        1, 1,
      ]),
      glContext.STATIC_DRAW,
    );

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvasElement.getBoundingClientRect();
      width = Math.max(1, Math.floor(rect.width * dpr));
      height = Math.max(1, Math.floor(rect.height * dpr));
      canvasElement.width = width;
      canvasElement.height = height;
      glContext.viewport(0, 0, width, height);
    }

    function render(shaderTime: number) {
      glContext.useProgram(program);
      glContext.bindBuffer(glContext.ARRAY_BUFFER, positionBuffer);
      glContext.enableVertexAttribArray(positionLocation);
      glContext.vertexAttribPointer(positionLocation, 2, glContext.FLOAT, false, 0, 0);
      glContext.uniform2f(resolutionLocation, width, height);
      glContext.uniform1f(timeLocation, shaderTime);
      glContext.drawArrays(glContext.TRIANGLES, 0, 6);
    }

    const startedAt = performance.now();
    const shaderSecondsPerSecond = 1.5;

    function scheduleFrame(callback: (now: number) => void) {
      if (typeof window.requestAnimationFrame === "function") {
        return window.requestAnimationFrame(callback);
      }

      return window.setTimeout(() => {
        callback(performance.now());
      }, 1000 / 60);
    }

    function cancelScheduledFrame(id: number) {
      if (typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(id);
        return;
      }

      window.clearTimeout(id);
    }

    function animate(now = performance.now()) {
      animationId = scheduleFrame(animate);
      const shaderTime = 1.0 + ((now - startedAt) / 1000) * shaderSecondsPerSecond;
      render(shaderTime);
    }

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvasElement);
    window.addEventListener("resize", resize);

    resize();
    if (reduceMotion.matches) {
      render(1.0);
    } else {
      animate();
    }

    return () => {
      cancelScheduledFrame(animationId);
      resizeObserver.disconnect();
      window.removeEventListener("resize", resize);
      glContext.deleteBuffer(positionBuffer);
      glContext.deleteProgram(program);
      glContext.deleteShader(vertexShader);
      glContext.deleteShader(fragmentShader);
    };
  }, []);

  function handleGateKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    props.onEnter();
  }

  return (
    <div
      className="startup-gate"
      role="button"
      tabIndex={0}
      onClick={props.onEnter}
      onKeyDown={handleGateKeyDown}
      aria-label="Enter WeConnect dashboard"
    >
      <canvas className="startup-gate-canvas" ref={canvasRef} aria-hidden="true" />
      <WindowDragRegion />
      <span className="startup-gate-copy" aria-hidden="true">
        <span className="startup-gate-title">WeConnect</span>
      </span>
    </div>
  );
}

function WindowDragRegion() {
  return (
    <span
      className="window-drag-region"
      data-tauri-drag-region="true"
      aria-hidden="true"
      onClick={(event) => event.stopPropagation()}
    />
  );
}

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
  const [startupDismissed, setStartupDismissed] = useState(false);
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

  const startupGate = startupDismissed ? null : (
    <StartupGate onEnter={() => setStartupDismissed(true)} />
  );

  if (error) {
    return (
      <>
        <div className="app-shell empty-shell">
          <WindowDragRegion />
          <AmbientField />
          <EmptyState title="Dashboard failed to load" body={error} />
        </div>
        {startupGate}
      </>
    );
  }

  if (!snapshot) {
    return (
      <>
        <div className="app-shell empty-shell">
          <WindowDragRegion />
          <AmbientField />
          <EmptyState title="Loading wechat2all" body="Preparing the local dashboard." />
        </div>
        {startupGate}
      </>
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
    <>
      <div
        className="app-shell"
        onPointerMove={handleShellPointerMove}
        onPointerLeave={handleShellPointerLeave}
      >
        <WindowDragRegion />
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
      {startupGate}
    </>
  );
}
