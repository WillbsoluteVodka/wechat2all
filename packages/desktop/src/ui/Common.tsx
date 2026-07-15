import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

import type { TraceEvent } from "../types";

export function StatusPill(props: { active: boolean; label: string }) {
  return (
    <span className={props.active ? "pill pill-good" : "pill pill-muted"}>
      <span className="dot" aria-hidden="true" />
      {props.label}
    </span>
  );
}

export function EmptyState(props: { title: string; body: string }) {
  return (
    <section className="empty-state">
      <h3>{props.title}</h3>
      <p>{props.body}</p>
    </section>
  );
}

function PixelScrollbar(props: {
  targetRef: RefObject<HTMLDivElement | null>;
  refreshKey: number;
}) {
  const thumbSize = 18;
  const dragState = useRef<{ pointerY: number; scrollTop: number } | null>(null);
  const [metrics, setMetrics] = useState({
    clientHeight: 0,
    scrollHeight: 0,
    scrollTop: 0,
  });

  const updateMetrics = useCallback(() => {
    const target = props.targetRef.current;
    if (!target) return;
    setMetrics({
      clientHeight: target.clientHeight,
      scrollHeight: target.scrollHeight,
      scrollTop: target.scrollTop,
    });
  }, [props.targetRef]);

  useLayoutEffect(() => {
    const target = props.targetRef.current;
    if (!target) return undefined;

    updateMetrics();
    target.addEventListener("scroll", updateMetrics, { passive: true });
    const resizeObserver = new ResizeObserver(updateMetrics);
    resizeObserver.observe(target);

    return () => {
      target.removeEventListener("scroll", updateMetrics);
      resizeObserver.disconnect();
    };
  }, [props.refreshKey, props.targetRef, updateMetrics]);

  const maxScroll = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
  const travel = Math.max(0, metrics.clientHeight - thumbSize);
  const thumbTop = maxScroll > 0 ? (metrics.scrollTop / maxScroll) * travel : 0;

  if (maxScroll <= 0) return null;

  const scrollToPointer = (clientY: number, track: HTMLSpanElement) => {
    const target = props.targetRef.current;
    if (!target) return;
    const rect = track.getBoundingClientRect();
    const nextTop = Math.max(0, Math.min(travel, clientY - rect.top - thumbSize / 2));
    target.scrollTop = travel > 0 ? (nextTop / travel) * maxScroll : 0;
  };

  return (
    <span
      className="pixel-scrollbar-track"
      aria-hidden="true"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          scrollToPointer(event.clientY, event.currentTarget);
        }
      }}
    >
      <span
        className="pixel-scrollbar-thumb"
        style={{ transform: `translateY(${thumbTop}px)` }}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          dragState.current = {
            pointerY: event.clientY,
            scrollTop: props.targetRef.current?.scrollTop ?? 0,
          };
        }}
        onPointerMove={(event) => {
          const target = props.targetRef.current;
          const drag = dragState.current;
          if (!target || !drag || travel <= 0) return;
          target.scrollTop =
            drag.scrollTop + ((event.clientY - drag.pointerY) / travel) * maxScroll;
        }}
        onPointerUp={(event) => {
          dragState.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          dragState.current = null;
        }}
      />
    </span>
  );
}

function formatTerminalTime(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value.slice(0, 8);
  }

  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

export function TerminalLog(props: {
  traces: TraceEvent[];
  className?: string;
  homeVariant?: boolean;
}) {
  const className = ["terminal-panel", props.className].filter(Boolean).join(" ");
  const terminalBodyRef = useRef<HTMLDivElement>(null);
  const bodyContent = props.traces.length ? (
    props.traces.map((trace) => (
      <div className="terminal-line" key={trace.id}>
        {props.homeVariant ? (
          <time className="terminal-entry-time">
            [{formatTerminalTime(trace.time)}]:
          </time>
        ) : null}
        <span className="terminal-message">
          {!props.homeVariant && trace.routeId ? `[${trace.routeId}] ` : ""}
          {trace.message}
        </span>
      </div>
    ))
  ) : (
    <div className="terminal-empty">waiting for router-daemon output...</div>
  );

  return (
    <section className={className}>
      {props.homeVariant ? (
        <h2 className="home-kicker home-terminal-title">TERMINAL LOG</h2>
      ) : (
        <div className="terminal-header">
          <div>
            <span className="terminal-dot red" />
            <span className="terminal-dot yellow" />
            <span className="terminal-dot green" />
          </div>
          <strong>terminal log</strong>
          <small>{props.traces.length} lines</small>
        </div>
      )}
      {props.homeVariant ? (
        <div className="home-terminal-body-shell">
          <div className="terminal-body" ref={terminalBodyRef}>{bodyContent}</div>
          <PixelScrollbar targetRef={terminalBodyRef} refreshKey={props.traces.length} />
        </div>
      ) : (
        <div className="terminal-body">{bodyContent}</div>
      )}
    </section>
  );
}
