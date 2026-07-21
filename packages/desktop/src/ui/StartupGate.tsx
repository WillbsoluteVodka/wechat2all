import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";

import { WindowDragRegion } from "./AppChrome";
import { PixelIcon, PixelText, type PixelIconKind } from "./PixelArt";

const PIXEL_REVEAL_MS = 2200;
const STARTUP_PIXEL_SIZE = 7;
const STARTUP_ICONS: PixelIconKind[] = ["wechat", "openai", "crab"];

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function easeInOutCubic(value: number) {
  const x = clamp01(value);
  return x < 0.5 ? 4 * x * x * x : 1 - ((-2 * x + 2) ** 3) / 2;
}

function PixelRevealCanvas(props: {
  origin: { x: number; y: number } | null;
  duration?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const duration = props.duration ?? PIXEL_REVEAL_MS;

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const origin = props.origin;
    if (!canvas || !origin) return undefined;

    const context = canvas.getContext("2d");
    if (!context) return undefined;

    const canvasElement = canvas;
    const canvasContext = context;
    const originPoint = origin;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const effectiveDuration = reducedMotion ? 80 : duration;
    let frameId = 0;
    let width = 1;
    let height = 1;
    let dpr = 1;

    function seed(x: number, y: number) {
      const value = Math.sin(x * 27.13 + y * 61.71) * 43758.5453;
      return value - Math.floor(value);
    }

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, window.innerWidth);
      height = Math.max(1, window.innerHeight);
      canvasElement.width = Math.floor(width * dpr);
      canvasElement.height = Math.floor(height * dpr);
      canvasContext.setTransform(dpr, 0, 0, dpr, 0, 0);
      canvasContext.imageSmoothingEnabled = false;
    }

    const startedAt = performance.now();

    function draw(now = performance.now()) {
      const block = STARTUP_PIXEL_SIZE;
      const progress = clamp01((now - startedAt) / effectiveDuration);
      const originCellX = Math.floor(originPoint.x / block);
      const originCellY = Math.floor(originPoint.y / block);
      const cellsX = Math.ceil(width / block) + 2;
      const cellsY = Math.ceil(height / block) + 2;
      const maxRing = Math.max(
        originCellX + 2,
        originCellY + 2,
        cellsX - originCellX + 2,
        cellsY - originCellY + 2,
      );
      const ringStep = 4;
      const revealRing =
        Math.floor((easeInOutCubic(progress) * maxRing) / ringStep) * ringStep;
      canvasContext.clearRect(0, 0, width, height);
      canvasContext.fillStyle = "#000";

      for (let cellY = -1; cellY <= cellsY; cellY += 1) {
        for (let cellX = -1; cellX <= cellsX; cellX += 1) {
          const x = cellX * block;
          const y = cellY * block;
          const squareRing = Math.max(
            Math.abs(cellX - originCellX),
            Math.abs(cellY - originCellY),
          );
          const stagger = Math.floor(seed(cellX, cellY) * 3);
          const collapseRing = squareRing + stagger;
          const crumbleEdge =
            collapseRing >= revealRing - ringStep
            && collapseRing <= revealRing + ringStep
            && seed(cellX + 17, cellY + 31) > 0.62;
          const frontierPixel =
            collapseRing > revealRing && collapseRing <= revealRing + 2;
          const delayedCrumblePixel =
            crumbleEdge && collapseRing <= revealRing;

          if (collapseRing > revealRing || crumbleEdge) {
            if (frontierPixel || delayedCrumblePixel) {
              const greenSeed = seed(cellX + 101, cellY + 203);
              canvasContext.fillStyle =
                greenSeed > 0.72
                  ? "#60ff8b"
                  : greenSeed > 0.28
                    ? "#18c950"
                    : "#086528";
            } else {
              canvasContext.fillStyle = "#000";
            }
            canvasContext.fillRect(x, y, block, block);
          }
        }
      }

      if (progress < 1) {
        frameId = window.requestAnimationFrame(draw);
      }
    }

    resize();
    draw(startedAt);
    window.addEventListener("resize", resize);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("resize", resize);
    };
  }, [duration, props.origin]);

  return <canvas className="pixel-reveal-canvas" ref={canvasRef} aria-hidden="true" />;
}

export function PixelStartupGate(props: { onEnter: () => void; onDockStart: () => void }) {
  const onEnterRef = useRef(props.onEnter);
  const onDockStartRef = useRef(props.onDockStart);
  const timerRef = useRef<number | null>(null);
  const [phase, setPhase] = useState<"idle" | "revealing">("idle");
  const [iconKind, setIconKind] = useState<PixelIconKind>("wechat");
  const [revealOrigin, setRevealOrigin] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    onEnterRef.current = props.onEnter;
  }, [props.onEnter]);

  useEffect(() => {
    onDockStartRef.current = props.onDockStart;
  }, [props.onDockStart]);

  useEffect(() => {
    if (phase !== "idle") return undefined;
    const timer = window.setInterval(() => {
      setIconKind((current) => {
        const currentIndex = STARTUP_ICONS.indexOf(current);
        return STARTUP_ICONS[(currentIndex + 1) % STARTUP_ICONS.length];
      });
    }, 1450);

    return () => window.clearInterval(timer);
  }, [phase]);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  function beginReveal(x: number, y: number) {
    if (phase !== "idle") return;
    setRevealOrigin({ x, y });
    setPhase("revealing");
    onDockStartRef.current();

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    timerRef.current = window.setTimeout(() => {
      onEnterRef.current();
    }, reducedMotion ? 120 : PIXEL_REVEAL_MS + 120);
  }

  function handleClick(event: MouseEvent<HTMLDivElement>) {
    beginReveal(event.clientX, event.clientY);
  }

  function handleGateKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    beginReveal(window.innerWidth / 2, window.innerHeight / 2);
  }

  return (
    <div
      className={phase === "revealing" ? "startup-gate pixel-startup is-revealing" : "startup-gate pixel-startup"}
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleGateKeyDown}
      aria-label="Enter WeConnect dashboard"
    >
      <WindowDragRegion />
      <div className="pixel-startup-core">
        <PixelIcon kind={iconKind} className="startup-pixel-icon" />
        <PixelText text="Click To Begin" className="pixel-startup-caption" />
      </div>
      {phase === "revealing" ? (
        <PixelRevealCanvas origin={revealOrigin} />
      ) : null}
    </div>
  );
}
