import type { CSSProperties } from "react";

import type { DashboardSnapshot, LlmHealthResponse, QrLoginResponse } from "../types";
import { TerminalLog } from "../ui/Common";
import { displayRouteName } from "../ui/constants";
import { HomeIntroCopy } from "../ui/HomeIntroCopy";
import { PixelIcon, PixelText } from "../ui/PixelArt";
import { QrGlitch } from "../ui/QrGlitch";

function HomeQrPanel(props: {
  qr: QrLoginResponse | null;
  qrImage: string | null;
  qrError: string | null;
}) {
  return (
    <section className="home-qr-glitch-panel" aria-label="WeChat QR login">
      {props.qrImage ? (
        <QrGlitch source={props.qrImage} className="home-qr-glitch" />
      ) : (
        <div className="terminal-empty">
          {props.qrError ? "QR request failed" : props.qr ? "preparing QR code..." : "requesting QR login..."}
        </div>
      )}
      {props.qrError ? <p className="error-copy">{props.qrError}</p> : null}
    </section>
  );
}

export function HomePage(props: {
  data: DashboardSnapshot;
  llmHealth: LlmHealthResponse | null;
  qr: QrLoginResponse | null;
  qrImage: string | null;
  qrError: string | null;
  onOpenRoutes: () => void;
}) {
  const enabledRoutes = props.data.routes.filter((route) => route.enabled).length;
  const visibleRoutes = props.data.routes.slice(0, 4);

  return (
    <main className="home-page">
      <section className="home-field" aria-label="WeConnect home">
        <div className="home-title-block">
          <div className="home-brand-lockup">
            <PixelIcon
              kind={props.data.profile.connected ? "wechat" : "wechatGray"}
              className="home-pixel-icon"
              animateEyes
            />
            <div className="home-brand-copy">
              <h1>
                <PixelText text="WeConnect" className="home-title-pixel" />
              </h1>
              <p className="home-kicker">LOCAL SIGNAL ROUTER</p>
            </div>
          </div>
          <div className="home-intro">
            <HomeIntroCopy />
            <pre className="home-ascii-map" aria-label="WeConnect routing structure">
{`WeConnect助手
|-- route: codex
|-- route: sales
|-- route: calendar
|-- route: custom ...`}
            </pre>
          </div>
        </div>

        <div
          className="home-readout-column home-terminal-column"
          aria-label={props.data.profile.connected ? "Terminal log" : "WeChat QR login"}
        >
          {props.data.profile.connected ? (
            <TerminalLog
              traces={props.data.traces}
              className="home-terminal-log"
              homeVariant
            />
          ) : (
            <HomeQrPanel qr={props.qr} qrImage={props.qrImage} qrError={props.qrError} />
          )}
        </div>

        <div className="home-route-lanes" aria-label="Route signal lanes">
          <div className="lane-heading">
            <h2 className="home-kicker home-terminal-title">ROUTE LANES</h2>
            <strong>{enabledRoutes} armed</strong>
          </div>
          {visibleRoutes.map((route, index) => {
            const signalStrength = Math.max(
              16,
              Math.min(100, Math.abs(route.priority) / 10 + route.stats.messagesToday * 6),
            );
            const llmConfigured =
              route.connectorId === "main-assistant"
              && props.llmHealth?.llm.status === "ready"
              && props.llmHealth.llm.usable;
            return (
              <button
                className={route.enabled ? "signal-lane is-enabled" : "signal-lane"}
                key={route.id}
                onClick={props.onOpenRoutes}
                style={
                  {
                    "--lane-index": String(index),
                    "--lane-signal": `${signalStrength}%`,
                  } as CSSProperties
                }
              >
                <span className="lane-pulse" aria-hidden="true" />
                <strong>{displayRouteName(route)}</strong>
                <span>{route.connectorId}</span>
                <span
                  className={llmConfigured
                    ? "lane-config-status is-configured"
                    : "lane-config-status is-not-configured"}
                >
                  <i aria-hidden="true" />
                  {llmConfigured ? "CONFIGURED" : "NOT CONFIGURED"}
                </span>
                <small>{route.stats.messagesToday} HITS</small>
              </button>
            );
          })}
        </div>
      </section>
    </main>
  );
}
