import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";

import type { PageKey } from "../types";
import { pages } from "./constants";
import { PixelText } from "./PixelArt";

export function WindowDragRegion() {
  const startWindowDrag = (event: PointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0 || !("__TAURI_INTERNALS__" in window)) return;

    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().startDragging())
      .catch(() => undefined);
  };

  return (
    <span
      className="window-drag-region"
      data-tauri-drag-region="true"
      aria-hidden="true"
      onPointerDown={startWindowDrag}
      onClick={(event) => event.stopPropagation()}
    />
  );
}

export function PixelClickBurstLayer() {
  const [bursts, setBursts] = useState<Array<{ id: number; x: number; y: number }>>([]);
  const nextBurstId = useRef(0);
  const cleanupTimers = useRef<number[]>([]);

  useEffect(() => {
    const handlePointerDown = (event: globalThis.PointerEvent) => {
      if (event.button !== 0 || !event.isPrimary) return;

      const id = nextBurstId.current;
      nextBurstId.current += 1;
      setBursts((current) => [...current.slice(-5), { id, x: event.clientX, y: event.clientY }]);

      const timer = window.setTimeout(() => {
        setBursts((current) => current.filter((burst) => burst.id !== id));
      }, 340);
      cleanupTimers.current.push(timer);
    };

    window.addEventListener("pointerdown", handlePointerDown, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      cleanupTimers.current.forEach((timer) => window.clearTimeout(timer));
    };
  }, []);

  return (
    <div className="pixel-click-layer" aria-hidden="true">
      {bursts.map((burst) => (
        <span
          className="pixel-click-burst"
          key={burst.id}
          style={{ left: burst.x, top: burst.y }}
        >
          <span className="pixel-click-ring" />
          {Array.from({ length: 8 }, (_, index) => (
            <span
              className="pixel-click-particle"
              key={index}
              style={{ "--particle-angle": `${index * 45}deg` } as CSSProperties}
            />
          ))}
        </span>
      ))}
    </div>
  );
}

export function CoreConsole(props: {
  active: PageKey;
  onChange: (page: PageKey) => void;
}) {
  return (
    <section className="core-console" aria-label="WeConnect command field">
      <nav className="mode-orbit" aria-label="Primary views">
        {pages.map((page) => (
          <button
            key={page.key}
            className={props.active === page.key ? "mode-node active" : "mode-node"}
            onClick={() => props.onChange(page.key)}
          >
            <span className="mode-node-dot" aria-hidden="true" />
            <PixelText text={page.label} className="mode-label-pixel" />
          </button>
        ))}
      </nav>
    </section>
  );
}
