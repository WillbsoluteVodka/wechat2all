import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import QRCode from "qrcode";
import * as THREE from "three";

import {
  getDashboardSnapshot,
  getLoginStatus,
  requestQrLogin,
  saveSettings,
  unlinkWechatSession,
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
  { key: "home", label: "Home", hint: "anomaly field" },
  { key: "config", label: "Config", hint: "QR + local settings" },
  { key: "routes", label: "Routes", hint: "routing matrix" },
  { key: "agents", label: "Agents", hint: "MCP fabric" },
  { key: "trace", label: "Trace", hint: "signal memory" },
];

type StartupPhase = "idle" | "forming" | "docking";
type GenerativeArtMode = "mark";

const STARTUP_TITLE = "WeConnect";
const STARTUP_FORM_MS = 2200;
const STARTUP_DOCK_MS = 1080;
const PIXEL_REVEAL_MS = 2200;
const STARTUP_PIXEL_SIZE = 7;
const MAIN_ASSISTANT_DISPLAY_NAME = "WeConnect助手";
const HOME_INTRO_COPY = [
  {
    lang: "en",
    text: "WeConnect sits in front of the local WeChat runtime, catches each incoming message, and routes it to the right local assistant without leaving this machine.",
  },
  {
    lang: "zh-CN",
    text: "WeConnect 在本地微信运行时前方接收每条消息，并把它路由到合适的本地助手，全程不离开这台机器。",
  },
];

type PixelIconKind = "wechat" | "wechatGray" | "codex";
type PixelTone =
  | "off"
  | "wechat"
  | "wechatDark"
  | "wechatLight"
  | "wechatGray"
  | "wechatGrayDark"
  | "wechatGrayLight"
  | "wechatGrayWhite"
  | "codexFrame"
  | "codexTile"
  | "codexPurple"
  | "codexPurpleLight"
  | "codexBlue"
  | "codexBlueLight"
  | "codexBlueDark"
  | "white";

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function easeOutCubic(value: number) {
  const x = clamp01(value);
  return 1 - (1 - x) ** 3;
}

function easeInOutCubic(value: number) {
  const x = clamp01(value);
  return x < 0.5 ? 4 * x * x * x : 1 - ((-2 * x + 2) ** 3) / 2;
}

function lerp(start: number, end: number, amount: number) {
  return start + (end - start) * amount;
}

function displayRouteName(route: Pick<RouteSummary, "id" | "name">) {
  return route.id === "main-assistant-default" || route.name === "大助手"
    ? MAIN_ASSISTANT_DISPLAY_NAME
    : route.name;
}

function describeMatchRule(rule: string) {
  const descriptions: Record<string, string> = {
    fallback: "Handles messages that do not match another route.",
    "/help": "Shows the available commands and route actions.",
    "/ls": "Lists the routes available to the current assistant.",
    "/rename": "Renames the current route.",
    "/cd": "Switches the conversation to another route.",
    "/sales": "Sends the message to the sales route.",
  };

  if (descriptions[rule]) return descriptions[rule];
  if (rule.startsWith("/")) return `Runs the ${rule} route command.`;
  return `Matches messages containing “${rule}”.`;
}

interface RouteRuleDetail {
  rule: string;
  description: string;
}

const WECONNECT_ROUTE_RULES: RouteRuleDetail[] = [
  { rule: "/help", description: "展示所有命令和功能" },
  { rule: "/ls", description: "展示当前所有可用 routes" },
  { rule: "/rename <新名字>", description: "重命名当前 route" },
  { rule: "/cd <route>", description: "进入某个 route" },
  { rule: "/cd ..", description: "从二级 route 返回大助手" },
];

const CODEX_ROUTE_RULES: RouteRuleDetail[] = [
  { rule: "/status", description: "查询 Codex 当前状态" },
  { rule: "/token", description: "查询 Codex usage 剩余额度" },
  { rule: "/ls", description: "查看可绑定的 Codex chats" },
  {
    rule: "/bind <序号>",
    description: "绑定 /ls 里对应编号的 Codex chat，也支持完整 thread id",
  },
  { rule: "/current", description: "查看当前绑定" },
  {
    rule: "/mode final|silent|stream",
    description: "设置微信返回模式，当前：final",
  },
  {
    rule: "/autoopen 1|0",
    description: "设置启动 wechat2all 时是否自动打开 Codex GUI",
  },
  {
    rule: "/alarm <HH:mm>",
    description: "设置 24 小时制时间，到点向绑定的 Codex chat 发送 dummy 你好",
  },
  { rule: "/cache", description: "查看本地附件 cache 的路径、文件数和大小" },
  { rule: "/cache clear", description: "清理当前 profile 的附件 cache" },
  { rule: "任意普通文本", description: "发送到已绑定的 Codex chat" },
  { rule: "/cd ..", description: "回到主 Router" },
];

function routeRuleDetails(route: RouteSummary): RouteRuleDetail[] {
  if (route.id === "main-assistant-default" || route.name === "大助手") {
    return WECONNECT_ROUTE_RULES;
  }
  if (route.id === "codex" || route.connectorId.includes("codex")) {
    return CODEX_ROUTE_RULES;
  }
  return route.matchText.map((rule) => ({ rule, description: describeMatchRule(rule) }));
}

function displayAgentName(agent: Pick<AgentSummary, "id" | "name">) {
  return agent.id === "main-assistant" || agent.name === "大助手"
    ? MAIN_ASSISTANT_DISPLAY_NAME
    : agent.name;
}

function setPixel(
  pixels: PixelTone[],
  x: number,
  y: number,
  tone: Exclude<PixelTone, "off">,
) {
  if (x < 0 || x > 23 || y < 0 || y > 23) return;
  pixels[y * 24 + x] = tone;
}

function fillPixelEllipse(
  pixels: PixelTone[],
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  tone: Exclude<PixelTone, "off">,
  edgeTone: Exclude<PixelTone, "off">,
) {
  for (let y = 0; y < 24; y += 1) {
    for (let x = 0; x < 24; x += 1) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      const distance = dx * dx + dy * dy;
      if (distance <= 1) {
        setPixel(pixels, x, y, distance > 0.68 ? edgeTone : tone);
      }
    }
  }
}

function buildWechatPixels(
  variant: "green" | "gray" = "green",
  eyeFrame: "open" | "look" | "closed" = "open",
) {
  const pixels: PixelTone[] = Array.from({ length: 24 * 24 }, () => "off");
  const bodyTone = variant === "gray" ? "wechatGray" : "wechat";
  const edgeTone = variant === "gray" ? "wechatGrayDark" : "wechatDark";
  const lightTone = variant === "gray" ? "wechatGrayLight" : "wechatLight";
  const highlightTone = variant === "gray" ? "wechatGrayWhite" : "white";

  fillPixelEllipse(pixels, 9.2, 9.8, 7.8, 6.2, bodyTone, edgeTone);
  fillPixelEllipse(pixels, 15.2, 14.2, 7.1, 5.5, lightTone, edgeTone);

  [
    [5, 15], [4, 16], [3, 17], [4, 17], [5, 16],
    [17, 18], [18, 19], [19, 20], [18, 20], [17, 19],
  ].forEach(([x, y]) => setPixel(pixels, x, y, edgeTone));

  const eyePixels = eyeFrame === "look"
    ? [
        [7, 9], [8, 9], [12, 9], [13, 9],
        [14, 13], [15, 13], [19, 13], [20, 13],
      ]
    : [
        [6, 9], [7, 9], [11, 9], [12, 9],
        [13, 13], [14, 13], [18, 13], [19, 13],
      ];

  if (eyeFrame !== "closed") {
    eyePixels.forEach(([x, y]) => setPixel(pixels, x, y, highlightTone));
  }

  return pixels;
}

function buildCodexPixels() {
  const pixels: PixelTone[] = Array.from({ length: 24 * 24 }, () => "off");

  const left = 1;
  const top = 1;
  const right = 22;
  const bottom = 22;
  const radius = 4;

  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const cornerX = x < left + radius ? left + radius : x > right - radius ? right - radius : x;
      const cornerY = y < top + radius ? top + radius : y > bottom - radius ? bottom - radius : y;
      const inside = Math.hypot(x - cornerX, y - cornerY) <= radius;
      if (!inside) continue;
      const isEdge = x <= left + 1 || x >= right - 1 || y <= top + 1 || y >= bottom - 1;
      setPixel(pixels, x, y, isEdge ? "codexFrame" : "codexTile");
    }
  }

  const paintBlob = (cx: number, cy: number, rx: number, ry: number) => {
    for (let y = 0; y < 24; y += 1) {
      for (let x = 0; x < 24; x += 1) {
        const dx = (x + 0.5 - cx) / rx;
        const dy = (y + 0.5 - cy) / ry;
        const distance = dx * dx + dy * dy;
        if (distance > 1) continue;

        const vertical = (y - 5) / 14;
        const edge = distance > 0.72;
        let tone: Exclude<PixelTone, "off"> = "codexBlue";
        if (vertical < 0.2) tone = "codexPurpleLight";
        else if (vertical < 0.42) tone = "codexPurple";
        else if (vertical > 0.78) tone = "codexBlueDark";
        else if (x > 14 && y < 14) tone = "codexBlueLight";

        setPixel(pixels, x, y, edge && tone !== "codexPurpleLight" ? "codexBlueDark" : tone);
      }
    }
  };

  paintBlob(11.5, 8.8, 6.8, 4.5);
  paintBlob(8.4, 12.3, 5.8, 6.1);
  paintBlob(15.2, 12.2, 6.6, 6.1);
  paintBlob(12.1, 15.8, 7.6, 4.9);

  [
    [7, 9], [8, 10], [9, 11], [8, 12], [7, 13],
    [8, 9], [9, 10], [10, 11], [9, 12], [8, 13],
    [13, 14], [14, 14], [15, 14], [16, 14],
  ].forEach(([x, y]) => setPixel(pixels, x, y, "white"));

  return pixels;
}

function buildPixelIcon(kind: PixelIconKind) {
  if (kind === "wechat") return buildWechatPixels();
  if (kind === "wechatGray") return buildWechatPixels("gray");
  return buildCodexPixels();
}

function PixelIcon(props: {
  kind: PixelIconKind;
  className?: string;
  animateEyes?: boolean;
}) {
  const pixels = useMemo(() => buildPixelIcon(props.kind), [props.kind]);
  const className = ["pixel-icon", `pixel-icon-${props.kind}`, props.className]
    .filter(Boolean)
    .join(" ");

  if (props.animateEyes && (props.kind === "wechat" || props.kind === "wechatGray")) {
    const variant = props.kind === "wechatGray" ? "gray" : "green";
    const frames = [
      buildWechatPixels(variant, "open"),
      buildWechatPixels(variant, "look"),
      buildWechatPixels(variant, "closed"),
    ];
    const animationClassName = [
      "pixel-icon-animation",
      `pixel-icon-${props.kind}`,
      props.className,
    ].filter(Boolean).join(" ");

    return (
      <span className={animationClassName} aria-hidden="true">
        {frames.map((frame, frameIndex) => (
          <span
            className={`pixel-icon pixel-icon-frame wechat-eye-frame-${frameIndex + 1}`}
            key={frameIndex}
          >
            {frame.map((tone, index) => (
              <span
                key={index}
                className={tone === "off" ? undefined : `tone-${tone}`}
              />
            ))}
          </span>
        ))}
      </span>
    );
  }

  return (
    <span className={className} aria-hidden="true">
      {pixels.map((tone, index) => (
        <span
          // The icon is a fixed 24x24 pixel matrix, so an index key is stable.
          key={index}
          className={tone === "off" ? undefined : `tone-${tone}`}
        />
      ))}
    </span>
  );
}

const PIXEL_TEXT_GLYPHS: Record<string, string[]> = {
  " ": [
    "000",
    "000",
    "000",
    "000",
    "000",
    "000",
    "000",
  ],
  "-": [
    "00000",
    "00000",
    "00000",
    "11111",
    "00000",
    "00000",
    "00000",
  ],
  ".": [
    "000",
    "000",
    "000",
    "000",
    "000",
    "000",
    "010",
  ],
  ":": [
    "000",
    "010",
    "010",
    "000",
    "010",
    "010",
    "000",
  ],
  "|": [
    "010",
    "010",
    "010",
    "010",
    "010",
    "010",
    "010",
  ],
  A: [
    "01110",
    "10001",
    "10001",
    "11111",
    "10001",
    "10001",
    "10001",
  ],
  B: [
    "11110",
    "10001",
    "10001",
    "11110",
    "10001",
    "10001",
    "11110",
  ],
  C: [
    "01110",
    "10001",
    "10000",
    "10000",
    "10000",
      "10001",
      "01110",
  ],
  D: [
    "11110",
    "10001",
    "10001",
    "10001",
    "10001",
    "10001",
    "11110",
  ],
  E: [
    "11111",
    "10000",
    "10000",
    "11110",
    "10000",
      "10000",
      "11111",
  ],
  F: [
    "11111",
    "10000",
    "10000",
    "11110",
    "10000",
    "10000",
    "10000",
  ],
  G: [
    "01110",
    "10001",
    "10000",
    "10111",
    "10001",
      "10001",
      "01110",
  ],
  H: [
    "10001",
    "10001",
    "10001",
    "11111",
    "10001",
    "10001",
    "10001",
  ],
  I: [
    "11111",
    "00100",
    "00100",
    "00100",
    "00100",
      "00100",
      "11111",
  ],
  J: [
    "00111",
    "00010",
    "00010",
    "00010",
    "10010",
    "10010",
    "01100",
  ],
  K: [
    "10001",
    "10010",
    "10100",
    "11000",
    "10100",
    "10010",
    "10001",
  ],
  L: [
    "10000",
    "10000",
    "10000",
    "10000",
    "10000",
      "10000",
      "11111",
  ],
  M: [
    "10001",
    "11011",
    "10101",
    "10101",
    "10001",
    "10001",
    "10001",
  ],
  N: [
    "10001",
    "11001",
    "10101",
    "10011",
    "10001",
    "10001",
    "10001",
  ],
  O: [
    "01110",
    "10001",
    "10001",
    "10001",
    "10001",
      "10001",
      "01110",
  ],
  P: [
    "11110",
    "10001",
    "10001",
    "11110",
    "10000",
    "10000",
    "10000",
  ],
  R: [
    "11110",
    "10001",
    "10001",
    "11110",
    "10100",
    "10010",
    "10001",
  ],
  S: [
    "01111",
    "10000",
    "10000",
    "01110",
    "00001",
    "00001",
    "11110",
  ],
  T: [
    "11111",
    "00100",
    "00100",
    "00100",
    "00100",
    "00100",
    "00100",
  ],
  U: [
    "10001",
    "10001",
    "10001",
    "10001",
    "10001",
    "10001",
    "01110",
  ],
  V: [
    "10001",
    "10001",
    "10001",
    "10001",
    "10001",
    "01010",
    "00100",
  ],
  W: [
    "10001",
    "10001",
    "10001",
    "10101",
    "10101",
    "11011",
    "10001",
  ],
  X: [
    "10001",
    "01010",
    "00100",
    "00100",
    "00100",
    "01010",
    "10001",
  ],
  Y: [
    "10001",
    "01010",
    "00100",
    "00100",
    "00100",
    "00100",
    "00100",
  ],
  助: [
    "1110100",
    "0010100",
    "1110111",
    "1010101",
    "1110101",
    "1010101",
    "1010111",
  ],
  手: [
    "0011100",
    "0001000",
    "1111111",
    "0001000",
    "0111110",
    "0001000",
    "0011000",
  ],
};

function PixelText(props: { text: string; className?: string }) {
  const lines = useMemo(
    () =>
      props.text
        .toUpperCase()
        .split("\n")
        .map((line) =>
          line.split("").map((character) => {
            const rows = PIXEL_TEXT_GLYPHS[character] ?? PIXEL_TEXT_GLYPHS[" "];
            return {
              character,
              rows,
              width: rows[0]?.length ?? 5,
            };
          }),
        ),
    [props.text],
  );
  const className = ["pixel-text", props.className].filter(Boolean).join(" ");

  return (
    <span className={className} role="img" aria-label={props.text}>
      {lines.map((line, lineIndex) => (
        <span className="pixel-text-line" key={lineIndex} aria-hidden="true">
          {line.map((glyph, glyphIndex) => (
            <span
              className={glyph.character === " " ? "pixel-glyph is-space" : "pixel-glyph"}
              key={`${glyph.character}-${lineIndex}-${glyphIndex}`}
              style={{ "--glyph-width": String(glyph.width) } as CSSProperties}
            >
              {glyph.rows.flatMap((row, rowIndex) =>
                row.split("").map((pixel, columnIndex) => (
                  <span
                    className={pixel === "1" ? "pixel-dot is-on" : "pixel-dot"}
                    key={`${rowIndex}-${columnIndex}`}
                  />
                )),
              )}
            </span>
          ))}
        </span>
      ))}
    </span>
  );
}

const CONSTRUCTION_BARRIER_WIDTH = 32;
const CONSTRUCTION_BARRIER_HEIGHT = 20;

function createConstructionBarrierFrame(lift: number, stripeShift: number) {
  const grid = Array.from({ length: CONSTRUCTION_BARRIER_HEIGHT }, () =>
    Array(CONSTRUCTION_BARRIER_WIDTH).fill("0"),
  );
  const paint = (x: number, y: number, tone: string) => {
    const liftedY = y + lift;
    if (
      x >= 0 &&
      x < CONSTRUCTION_BARRIER_WIDTH &&
      liftedY >= 0 &&
      liftedY < CONSTRUCTION_BARRIER_HEIGHT
    ) {
      grid[liftedY][x] = tone;
    }
  };

  [7, 24].forEach((center) => {
    for (let y = 1; y < 19; y += 1) {
      const spread = Math.floor((y - 1) / 4);
      [-spread, spread].forEach((offset) => {
        paint(center + offset - 1, y, "D");
        paint(center + offset, y, "S");
        paint(center + offset + 1, y, "D");
      });
    }
  });

  [3, 11].forEach((barY) => {
    for (let y = 0; y < 5; y += 1) {
      for (let x = 1; x < 31; x += 1) {
        if (y === 0 || y === 4 || x === 1 || x === 30) {
          paint(x, barY + y, "S");
        } else {
          const stripe = Math.floor((x + y * 2 + stripeShift) / 5) % 2;
          paint(x, barY + y, stripe === 0 ? "O" : "W");
        }
      }
    }
  });

  return grid.map((row) => row.join(""));
}

const CONSTRUCTION_BARRIER_FRAMES = [
  createConstructionBarrierFrame(0, 0),
  createConstructionBarrierFrame(-1, 1),
  createConstructionBarrierFrame(0, 0),
];

const CONSTRUCTION_PIXEL_TONES: Record<string, string> = {
  D: "dark",
  O: "orange",
  S: "silver",
  W: "white",
};

function ConstructionBarrier() {
  return (
    <div className="construction-barrier" aria-hidden="true">
      {CONSTRUCTION_BARRIER_FRAMES.map((frame, frameIndex) => (
        <span
          className={`construction-frame construction-frame-${frameIndex + 1}`}
          key={frameIndex}
          style={{ "--barrier-width": String(frame[0].length) } as CSSProperties}
        >
          {frame.flatMap((row, rowIndex) =>
            row.split("").map((pixel, columnIndex) => (
              <span
                className={
                  pixel === "0"
                    ? "construction-pixel"
                    : `construction-pixel tone-${CONSTRUCTION_PIXEL_TONES[pixel]}`
                }
                key={`${rowIndex}-${columnIndex}`}
              />
            )),
          )}
        </span>
      ))}
    </div>
  );
}

function ConstructionPage() {
  return (
    <main className="page construction-page">
      <section className="construction-state" aria-label="Consturction Site">
        <ConstructionBarrier />
        <PixelText text="Consturction Site" className="construction-label" />
      </section>
    </main>
  );
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

function PixelStartupGate(props: { onEnter: () => void; onDockStart: () => void }) {
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
      setIconKind((current) => (current === "wechat" ? "codex" : "wechat"));
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

function HomeIntroCopy() {
  const [step, setStep] = useState(0);
  const copy = HOME_INTRO_COPY[step % HOME_INTRO_COPY.length] ?? HOME_INTRO_COPY[0]!;
  const className = step === 0 ? "home-intro-copy" : "home-intro-copy is-glitching";

  useEffect(() => {
    const timer = window.setInterval(() => {
      setStep((current) => current + 1);
    }, 4200);

    return () => window.clearInterval(timer);
  }, []);

  return (
    <p
      className={className}
      data-text={copy.text}
      key={`${copy.lang}-${step}`}
      lang={copy.lang}
    >
      {copy.text}
    </p>
  );
}

function GenerativeArtScene(props: { className?: string; mode?: GenerativeArtMode }) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const mode = props.mode ?? "mark";

  useEffect(() => {
    const currentMount = mountRef.current;
    if (!currentMount) return undefined;
    const mount = currentMount;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 1000);
    camera.position.z = 3.22;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    mount.appendChild(renderer.domElement);

    const geometry = new THREE.IcosahedronGeometry(1.18, 42);
    const material = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        pointLightPosition: { value: new THREE.Vector3(0, 0, 5) },
        color: { value: new THREE.Color(0xd9dfdb) },
        accentColor: { value: new THREE.Color(0x1cd456) },
        opacity: { value: 0.8 },
      },
      vertexShader: `
        uniform float time;
        varying vec3 vNormal;
        varying vec3 vPosition;

        vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
        vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
        vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
        vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

        float snoise(vec3 v) {
          const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
          const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
          vec3 i = floor(v + dot(v, C.yyy));
          vec3 x0 = v - i + dot(i, C.xxx);
          vec3 g = step(x0.yzx, x0.xyz);
          vec3 l = 1.0 - g;
          vec3 i1 = min(g.xyz, l.zxy);
          vec3 i2 = max(g.xyz, l.zxy);
          vec3 x1 = x0 - i1 + C.xxx;
          vec3 x2 = x0 - i2 + C.yyy;
          vec3 x3 = x0 - D.yyy;
          i = mod289(i);
          vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
            + i.y + vec4(0.0, i1.y, i2.y, 1.0))
            + i.x + vec4(0.0, i1.x, i2.x, 1.0));
          float n_ = 0.142857142857;
          vec3 ns = n_ * D.wyz - D.xzx;
          vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
          vec4 x_ = floor(j * ns.z);
          vec4 y_ = floor(j - 7.0 * x_);
          vec4 x = x_ * ns.x + ns.yyyy;
          vec4 y = y_ * ns.x + ns.yyyy;
          vec4 h = 1.0 - abs(x) - abs(y);
          vec4 b0 = vec4(x.xy, y.xy);
          vec4 b1 = vec4(x.zw, y.zw);
          vec4 s0 = floor(b0) * 2.0 + 1.0;
          vec4 s1 = floor(b1) * 2.0 + 1.0;
          vec4 sh = -step(h, vec4(0.0));
          vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
          vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
          vec3 p0 = vec3(a0.xy, h.x);
          vec3 p1 = vec3(a0.zw, h.y);
          vec3 p2 = vec3(a1.xy, h.z);
          vec3 p3 = vec3(a1.zw, h.w);
          vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
          p0 *= norm.x;
          p1 *= norm.y;
          p2 *= norm.z;
          p3 *= norm.w;
          vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
          m = m * m;
          return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
        }

        void main() {
          float displacement = snoise(position * 2.0 + time * 0.5) * 0.22;
          vec3 newPosition = position + normal * displacement;
          vec4 worldPosition = modelMatrix * vec4(newPosition, 1.0);
          vNormal = normalize(mat3(modelMatrix) * normal);
          vPosition = worldPosition.xyz;
          gl_Position = projectionMatrix * viewMatrix * worldPosition;
        }
      `,
      fragmentShader: `
        uniform vec3 color;
        uniform vec3 accentColor;
        uniform vec3 pointLightPosition;
        uniform float opacity;
        varying vec3 vNormal;
        varying vec3 vPosition;

        void main() {
          vec3 normal = normalize(vNormal);
          vec3 viewDir = normalize(cameraPosition - vPosition);
          vec3 lightDir = normalize(pointLightPosition - vPosition);
          float diffuse = max(dot(normal, lightDir), 0.0);
          float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 2.0);
          vec3 finalColor = color * (0.18 + diffuse * 0.74);
          finalColor += color * fresnel * 0.28;
          finalColor += accentColor * fresnel * 0.18;
          gl_FragColor = vec4(finalColor, opacity);
        }
      `,
      transparent: true,
      wireframe: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.z = -0.12;
    scene.add(mesh);

    const pointLight = new THREE.PointLight(0xffffff, 1.2, 100);
    pointLight.position.set(0, 0, 5);
    scene.add(pointLight);

    function resize() {
      const width = Math.max(1, mount.clientWidth);
      const height = Math.max(1, mount.clientHeight);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    }

    function handlePointerMove(event: globalThis.PointerEvent) {
      const rect = mount.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1;
      const y = -(((event.clientY - rect.top) / Math.max(rect.height, 1)) * 2 - 1);
      const vector = new THREE.Vector3(x, y, 0.5).unproject(camera);
      const direction = vector.sub(camera.position).normalize();
      const distance = -camera.position.z / direction.z;
      const position = camera.position.clone().add(direction.multiplyScalar(distance));
      pointLight.position.copy(position);
      material.uniforms.pointLightPosition.value.copy(position);
    }

    let frameId = 0;
    function animate(timestamp = 0) {
      const seconds = timestamp * 0.001;
      material.uniforms.time.value = seconds;
      const pulse = Math.sin(seconds * 1.5) * 0.035;
      mesh.rotation.y = seconds * 0.22;
      mesh.rotation.x = Math.sin(seconds * 0.55) * 0.16;
      mesh.scale.setScalar(1.02 + pulse);
      renderer.render(scene, camera);

      if (!reducedMotion.matches) {
        frameId = window.requestAnimationFrame(animate);
      }
    }

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(mount);
    window.addEventListener("pointermove", handlePointerMove);
    resize();
    animate(0);

    return () => {
      window.cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      window.removeEventListener("pointermove", handlePointerMove);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement);
      }
    };
  }, [mode]);

  return (
    <div
      ref={mountRef}
      className={props.className ? `generative-art-scene ${props.className}` : "generative-art-scene"}
      aria-hidden="true"
    />
  );
}

interface StartupParticle {
  startX: number;
  startY: number;
  burstX: number;
  burstY: number;
  targetX: number;
  targetY: number;
  size: number;
  phase: number;
  alpha: number;
}

function StartupParticleTransition({
  active,
  text,
}: {
  active: boolean;
  text: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!active) return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const context = canvas.getContext("2d");
    if (!context) {
      return undefined;
    }
    const particleCanvas = canvas;
    const particleContext = context;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const particles: StartupParticle[] = [];
    let width = 1;
    let height = 1;
    let dpr = 1;
    let frameId = 0;

    function seed(index: number) {
      const value = Math.sin(index * 12.9898 + 78.233) * 43758.5453;
      return value - Math.floor(value);
    }

    function buildParticles() {
      particles.length = 0;
      const offscreen = document.createElement("canvas");
      offscreen.width = width;
      offscreen.height = height;
      const offscreenContext = offscreen.getContext("2d");
      if (!offscreenContext) return;

      const fontSize = Math.max(62, Math.min(132, width * 0.095));
      offscreenContext.clearRect(0, 0, width, height);
      offscreenContext.fillStyle = "#fff";
      offscreenContext.textAlign = "center";
      offscreenContext.textBaseline = "middle";
      offscreenContext.font = `520 ${fontSize}px Inter, -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif`;
      offscreenContext.fillText(text, width * 0.5, height * 0.5);

      const pixels = offscreenContext.getImageData(0, 0, width, height).data;
      const step = Math.max(4, Math.floor(Math.min(width, height) / 185));
      const sampled: Array<{ x: number; y: number }> = [];

      for (let y = 0; y < height; y += step) {
        for (let x = 0; x < width; x += step) {
          const alpha = pixels[(y * width + x) * 4 + 3];
          if (alpha > 70 && seed(x * 0.7 + y * 1.3) > 0.12) {
            sampled.push({ x, y });
          }
        }
      }

      const maxParticles = 1400;
      const stride = Math.max(1, Math.ceil(sampled.length / maxParticles));
      const centerX = width * 0.5;
      const centerY = height * 0.5;
      const objectRadius = Math.min(width, height) * 0.24;

      for (let sourceIndex = 0; sourceIndex < sampled.length; sourceIndex += stride) {
        const point = sampled[sourceIndex];
        const index = particles.length;
        const angle = index * 2.399963 + seed(index) * 0.28;
        const radius = objectRadius * Math.sqrt(seed(index + 12)) * (0.72 + seed(index + 4) * 0.48);
        const wave = Math.sin(angle * 3.0 + seed(index + 8) * 6.0) * objectRadius * 0.09;
        const targetX = centerX + Math.cos(angle) * (radius + wave) * 1.2;
        const targetY = centerY + Math.sin(angle) * (radius + wave) * 0.9;
        const dx = point.x - centerX;
        const dy = point.y - centerY;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const blast = 170 + seed(index + 2) * 260;
        const spin = (seed(index + 6) - 0.5) * 220;

        particles.push({
          startX: point.x,
          startY: point.y,
          burstX: point.x + (dx / distance) * blast - (dy / distance) * spin,
          burstY: point.y + (dy / distance) * blast + (dx / distance) * spin,
          targetX,
          targetY,
          size: 0.75 + seed(index + 9) * 1.8,
          phase: seed(index + 16) * Math.PI * 2,
          alpha: 0.42 + seed(index + 20) * 0.58,
        });
      }
    }

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = particleCanvas.getBoundingClientRect();
      width = Math.max(1, Math.floor(rect.width));
      height = Math.max(1, Math.floor(rect.height));
      particleCanvas.width = Math.floor(width * dpr);
      particleCanvas.height = Math.floor(height * dpr);
      particleContext.setTransform(dpr, 0, 0, dpr, 0, 0);
      buildParticles();
    }

    const startedAt = performance.now();
    function draw(now: number) {
      const elapsed = now - startedAt;
      const progress = clamp01(elapsed / STARTUP_FORM_MS);
      const explode = easeOutCubic(progress / 0.32);
      const reform = easeInOutCubic((progress - 0.28) / 0.48);
      const fade = 1 - easeInOutCubic((progress - 0.7) / 0.22);

      particleContext.clearRect(0, 0, width, height);
      particleContext.globalCompositeOperation = "lighter";

      for (const particle of particles) {
        const fromX = lerp(particle.startX, particle.burstX, explode);
        const fromY = lerp(particle.startY, particle.burstY, explode);
        const orbit = Math.sin(progress * Math.PI * 6 + particle.phase) * 12 * (1 - reform);
        const x = lerp(fromX, particle.targetX, reform) + Math.cos(particle.phase) * orbit;
        const y = lerp(fromY, particle.targetY, reform) + Math.sin(particle.phase) * orbit;
        const alpha = particle.alpha * Math.max(0, fade);

        particleContext.beginPath();
        particleContext.arc(x, y, particle.size * (1 + reform * 0.32), 0, Math.PI * 2);
        particleContext.fillStyle =
          seed(particle.phase) > 0.82
            ? `rgba(28, 212, 86, ${alpha * 0.72})`
            : `rgba(236, 242, 239, ${alpha})`;
        particleContext.shadowColor = "rgba(210, 245, 226, 0.35)";
        particleContext.shadowBlur = 8 * alpha;
        particleContext.fill();
      }

      particleContext.globalCompositeOperation = "source-over";
      particleContext.shadowBlur = 0;

      if (progress >= 1) {
        return;
      }

      frameId = window.requestAnimationFrame(draw);
    }

    resize();
    if (reducedMotion.matches) {
      draw(startedAt + STARTUP_FORM_MS);
    } else {
      frameId = window.requestAnimationFrame(draw);
    }

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(particleCanvas);

    return () => {
      window.cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
    };
  }, [active, text]);

  if (!active) return null;
  return <canvas className="startup-particles" ref={canvasRef} aria-hidden="true" />;
}

function StartupGate(props: { onEnter: () => void; onDockStart: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const onEnterRef = useRef(props.onEnter);
  const onDockStartRef = useRef(props.onDockStart);
  const sequenceTimersRef = useRef<number[]>([]);
  const [phase, setPhase] = useState<StartupPhase>("idle");

  useEffect(() => {
    onEnterRef.current = props.onEnter;
  }, [props.onEnter]);

  useEffect(() => {
    onDockStartRef.current = props.onDockStart;
  }, [props.onDockStart]);

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

  const clearSequenceTimers = useCallback(() => {
    for (const timer of sequenceTimersRef.current) {
      window.clearTimeout(timer);
    }
    sequenceTimersRef.current = [];
  }, []);

  useEffect(() => clearSequenceTimers, [clearSequenceTimers]);

  function beginTransition() {
    if (phase !== "idle") return;
    clearSequenceTimers();
    setPhase("forming");

    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const formMs = prefersReducedMotion ? 180 : STARTUP_FORM_MS;
    const dockMs = prefersReducedMotion ? 220 : STARTUP_DOCK_MS;

    const dockTimer = window.setTimeout(() => {
      setPhase("docking");
      onDockStartRef.current();
    }, formMs);
    const enterTimer = window.setTimeout(() => {
      onEnterRef.current();
    }, formMs + dockMs);

    sequenceTimersRef.current = [dockTimer, enterTimer];
  }

  function handleGateKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    beginTransition();
  }

  const showTransitionObject = phase !== "idle";
  const showParticles = phase === "forming";
  const gateClassName = [
    "startup-gate",
    phase === "forming" ? "is-forming" : "",
    phase === "docking" ? "is-docking" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={gateClassName}
      role="button"
      tabIndex={0}
      onClick={beginTransition}
      onKeyDown={handleGateKeyDown}
      aria-label="Enter WeConnect dashboard"
    >
      <canvas className="startup-gate-canvas" ref={canvasRef} aria-hidden="true" />
      <WindowDragRegion />
      <StartupParticleTransition
        active={showParticles}
        text={STARTUP_TITLE}
      />
      {showTransitionObject ? (
        <div className="startup-object-stage">
          <GenerativeArtScene mode="mark" />
        </div>
      ) : null}
      <span className="startup-gate-copy" aria-hidden="true">
        <span className="startup-gate-title">{STARTUP_TITLE}</span>
      </span>
    </div>
  );
}

function WindowDragRegion() {
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

function PixelClickBurstLayer() {
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
  const commands = props.route.matchText.filter((tag) => tag.startsWith("/"));

  return (
    <button
      className={[
        "route-card",
        props.route.enabled ? "is-enabled" : "is-disabled",
        props.selected ? "selected" : "",
      ].join(" ")}
      onClick={props.onClick}
      aria-pressed={props.selected}
    >
      <div className="route-card-head">
        <h3>
          <PixelText text={displayRouteName(props.route)} className="route-title-pixel" />
        </h3>
      </div>
      <StatusPill
        active={props.route.enabled}
        label={props.route.enabled ? "Enabled" : "Disabled"}
      />
      <p>{props.route.description}</p>
      {commands.length ? <div className="tag-row route-command-tags">
        {commands.map((tag) => (
          <span className="tag" key={tag}>{tag}</span>
        ))}
      </div> : null}
    </button>
  );
}

function RoutesStage() {
  return (
    <section className="command-stage routes-construction-stage" aria-label="Routes under construction">
      <div className="routes-construction-content">
        <ConstructionBarrier />
        <PixelText text="Construction Site" className="construction-label" />
      </div>
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
          target.scrollTop = drag.scrollTop + ((event.clientY - drag.pointerY) / travel) * maxScroll;
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

function TerminalLog(props: {
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

function HomeQrLoginPanel(props: {
  qr: QrLoginResponse | null;
  loginStatus: LoginStatus | null;
  qrImage: string | null;
  qrError: string | null;
}) {
  const status = props.loginStatus?.status ?? props.qr?.status ?? "requesting";

  return (
    <section className="terminal-panel home-qr-login">
      <div className="terminal-header">
        <div>
          <span className="terminal-dot red" />
          <span className="terminal-dot yellow" />
          <span className="terminal-dot green" />
        </div>
        <strong>wechat qr</strong>
        <small>{status}</small>
      </div>
      <div className="home-qr-body">
        {props.qr ? (
          <>
            <div className="qr-box home-qr-box">
              {props.qrImage ? (
                <img src={props.qrImage} alt="WeChat login QR code" />
              ) : (
                <>
                  <span>QR</span>
                  <small>{props.qr.status}</small>
                </>
              )}
            </div>
            <p className="muted">
              Scan with WeChat · Expires in {props.qr.expiresInSeconds}s
            </p>
          </>
        ) : (
          <div className="terminal-empty">
            {props.qrError ? "QR request failed" : "requesting QR login..."}
          </div>
        )}
        {props.qrError ? <p className="error-copy">{props.qrError}</p> : null}
      </div>
    </section>
  );
}

function RoutesPage(props: {
  routes: RouteSummary[];
  selectedRouteId: string | null;
  onSelect: (routeId: string | null) => void;
}) {
  const selected = props.routes.find((route) => route.id === props.selectedRouteId) ?? null;

  if (!selected) {
    return (
      <main className="page">
        <RoutesStage />
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

  const matchRules = routeRuleDetails(selected);
  const configChecklist = [
    { label: "Route enabled", value: selected.enabled, detail: selected.enabled ? "ON" : "OFF" },
    {
      label: "Connector assigned",
      value: Boolean(selected.connectorId),
      detail: selected.connectorId || "NOT SET",
    },
    {
      label: "Priority configured",
      value: Number.isFinite(selected.priority),
      detail: String(selected.priority),
    },
    {
      label: "Match rules configured",
      value: matchRules.length > 0,
      detail: `${matchRules.length} RULES`,
    },
  ];

  return (
    <main className="route-detail-page">
      <section className="panel route-detail route-detail-single">
        <button className="primary-button route-detail-back" onClick={() => props.onSelect(null)}>
          Back to All Routes
        </button>
        <header className="route-detail-heading">
          <h1>
            <PixelText text={displayRouteName(selected)} className="route-detail-title-pixel" />
          </h1>
          <p>{selected.description}</p>
        </header>

        <section className="route-detail-section">
          <h2 className="home-kicker">MATCH RULES</h2>
          <ol className="route-match-rule-list">
            {matchRules.map((item, index) => (
              <li key={`${item.rule}-${index}`}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <code>{item.rule}</code>
                <small>{item.description}</small>
              </li>
            ))}
          </ol>
        </section>

        <section className="route-detail-section">
          <h2 className="home-kicker">CONFIG CHECKLIST</h2>
          <ul className="route-config-checklist">
            {configChecklist.map((item) => (
              <li key={item.label} className={item.value ? "is-complete" : "is-incomplete"}>
                <span className="route-config-check" aria-hidden="true">
                  {item.value ? "[x]" : "[ ]"}
                </span>
                <strong>{item.label}</strong>
                <small>{item.detail}</small>
              </li>
            ))}
          </ul>
        </section>
      </section>
    </main>
  );
}

function AgentsPage() {
  return <ConstructionPage />;
}

function TracePage() {
  return <ConstructionPage />;
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

function ConfigPage(props: {
  data: DashboardSnapshot;
  qr: QrLoginResponse | null;
  loginStatus: LoginStatus | null;
  qrImage: string | null;
  qrError: string | null;
  onRequestQr: () => void;
  onUnlink: () => void;
  onSave: (settings: SettingsSnapshot) => Promise<void>;
}) {
  const [draft, setDraft] = useState(props.data.settings);
  const [saved, setSaved] = useState(false);
  const [greenQrImage, setGreenQrImage] = useState<string | null>(null);
  const profile = props.data.profile;
  const visibleQrError = props.qrError?.includes("QR code expired 3 times")
    ? null
    : props.qrError;

  useEffect(() => {
    setDraft(props.data.settings);
  }, [props.data.settings]);

  useEffect(() => {
    if (!props.qrImage) {
      setGreenQrImage(null);
      return;
    }

    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return;

      context.imageSmoothingEnabled = false;
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      for (let index = 0; index < pixels.data.length; index += 4) {
        const alpha = pixels.data[index + 3] ?? 0;
        const luminance =
          (pixels.data[index] ?? 0) * 0.2126 +
          (pixels.data[index + 1] ?? 0) * 0.7152 +
          (pixels.data[index + 2] ?? 0) * 0.0722;
        const isQrPixel = alpha > 0 && luminance < 128;
        pixels.data[index] = isQrPixel ? 28 : 0;
        pixels.data[index + 1] = isQrPixel ? 212 : 0;
        pixels.data[index + 2] = isQrPixel ? 86 : 0;
        pixels.data[index + 3] = 255;
      }
      context.putImageData(pixels, 0, 0);
      if (!cancelled) setGreenQrImage(canvas.toDataURL("image/png"));
    };
    image.src = props.qrImage;

    return () => {
      cancelled = true;
    };
  }, [props.qrImage]);

  async function submit() {
    await props.onSave(draft);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  }

  return (
    <main className="page-grid two-columns config-page">
      <section className="panel qr-panel config-qr-panel">
        <div className="section-title">
          <p className="home-kicker config-panel-title">WECHAT QR</p>
          <StatusPill
            active={profile.connected}
            label={profile.connected ? "Connected" : "Disconnected"}
          />
        </div>
        <div className="config-qr-stage">
          {props.qr ? (
            <>
              {props.qrImage ? (
                <span className="config-qr-frame">
                  <img
                    className="config-qr-image config-qr-image-normal"
                    src={props.qrImage}
                    alt="WeChat login QR code"
                  />
                  <img
                    className="config-qr-image config-qr-image-inverted"
                    src={props.qrImage}
                    alt=""
                    aria-hidden="true"
                  />
                  <img
                    className="config-qr-image config-qr-image-green"
                    src={greenQrImage ?? props.qrImage}
                    alt=""
                    aria-hidden="true"
                  />
                  <img
                    className="config-qr-image config-qr-image-glitch config-qr-glitch-normal"
                    src={props.qrImage}
                    alt=""
                    aria-hidden="true"
                  />
                  <img
                    className="config-qr-image config-qr-image-glitch config-qr-glitch-inverted"
                    src={props.qrImage}
                    alt=""
                    aria-hidden="true"
                  />
                  <img
                    className="config-qr-image config-qr-image-glitch config-qr-glitch-green"
                    src={greenQrImage ?? props.qrImage}
                    alt=""
                    aria-hidden="true"
                  />
                </span>
              ) : null}
              {visibleQrError ? <p className="error-copy">{visibleQrError}</p> : null}
            </>
          ) : (
            <>
              {visibleQrError ? <p className="error-copy">{visibleQrError}</p> : null}
              <EmptyState
                title="No QR requested yet"
                body="Click the login button to ask the local router for a QR session."
              />
            </>
          )}
        </div>
        <div className="button-row qr-action-row">
          <button className="primary-button" onClick={props.onRequestQr}>
            Request New QR
          </button>
          <button
            className="secondary-button unlink-button"
            disabled={!profile.connected && !props.loginStatus?.connected}
            onClick={props.onUnlink}
          >
            Disconnect
          </button>
        </div>
      </section>

      <section className="panel settings-form config-settings-panel">
        <div className="section-title">
          <p className="home-kicker config-panel-title">LOCAL SETTINGS</p>
          {saved ? <span className="pill pill-good">Saved</span> : null}
        </div>
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

function HomePage(props: {
  data: DashboardSnapshot;
  qr: QrLoginResponse | null;
  loginStatus: LoginStatus | null;
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
            <HomeQrLoginPanel
              qr={props.qr}
              loginStatus={props.loginStatus}
              qrImage={props.qrImage}
              qrError={props.qrError}
            />
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
                <small>{route.stats.messagesToday} HITS</small>
              </button>
            );
          })}
        </div>
      </section>
    </main>
  );
}

function CoreConsole(props: {
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

export function App() {
  const [startupDismissed, setStartupDismissed] = useState(false);
  const [startupOverlayVisible, setStartupOverlayVisible] = useState(true);
  const [activePage, setActivePage] = useState<PageKey>("home");
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [qr, setQr] = useState<QrLoginResponse | null>(null);
  const [loginStatus, setLoginStatus] = useState<LoginStatus | null>(null);
  const [qrImage, setQrImage] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const autoQrProfileRef = useRef<string | null>(null);

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
    if (startupOverlayVisible) return undefined;
    if (activePage !== "home" && activePage !== "routes" && activePage !== "trace") {
      return undefined;
    }

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
  }, [activePage, startupOverlayVisible]);

  useEffect(() => {
    if (!snapshot || !qr) return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await getLoginStatus(snapshot.profile.id);
        if (cancelled) return;
        setLoginStatus(status);
        if (status.status === "confirmed") {
          setQr(null);
          setQrImage(null);
          autoQrProfileRef.current = null;
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

  const requestQr = useCallback(async () => {
    const profileId = snapshot?.profile.id;
    if (!profileId) return;
    setQrError(null);
    setQrImage(null);
    setLoginStatus(null);
    try {
      const response = await requestQrLogin(profileId);
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
  }, [snapshot?.profile.id]);

  useEffect(() => {
    if (startupOverlayVisible || activePage !== "home" || !snapshot) return;
    if (snapshot.profile.connected || qr || qrError) return;
    if (autoQrProfileRef.current === snapshot.profile.id) return;
    autoQrProfileRef.current = snapshot.profile.id;
    void requestQr();
  }, [
    activePage,
    qr,
    qrError,
    requestQr,
    snapshot,
    startupOverlayVisible,
  ]);

  const completeStartup = useCallback(() => {
    setStartupDismissed(true);
    setStartupOverlayVisible(false);
  }, []);

  const beginStartupDocking = useCallback(() => {
    setStartupDismissed(true);
  }, []);

  const startupGate = startupOverlayVisible ? (
    <PixelStartupGate onEnter={completeStartup} onDockStart={beginStartupDocking} />
  ) : null;

  if (error) {
    return (
      <>
        <div className="app-shell empty-shell">
          <WindowDragRegion />
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
          <EmptyState title="Loading wechat2all" body="Preparing the local dashboard." />
        </div>
        {startupGate}
      </>
    );
  }

  async function onSaveSettings(settings: SettingsSnapshot) {
    const nextSettings = await saveSettings(settings);
    setSnapshot((current) =>
      current ? { ...current, settings: nextSettings } : current,
    );
  }

  async function onUnlinkWechat() {
    if (!snapshot) return;
    setQrError(null);
    try {
      await unlinkWechatSession(snapshot.profile.id);
      setQr(null);
      setQrImage(null);
      setLoginStatus(null);
      autoQrProfileRef.current = null;
      setSnapshot(await getDashboardSnapshot());
      setActivePage("home");
      setStartupDismissed(false);
      setStartupOverlayVisible(true);
    } catch (err) {
      setQrError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <>
      <div
        className={[
          "app-shell",
          startupDismissed ? "is-startup-dismissed" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onPointerMove={handleShellPointerMove}
        onPointerLeave={handleShellPointerLeave}
      >
        <WindowDragRegion />
        <CoreConsole
          active={activePage}
          onChange={setActivePage}
        />
        <section className="content-shell field-content">
          {activePage === "home" ? (
            <HomePage
              data={snapshot}
              qr={qr}
              loginStatus={loginStatus}
              qrImage={qrImage}
              qrError={qrError}
              onOpenRoutes={() => setActivePage("routes")}
            />
          ) : null}
          {activePage === "config" ? (
            <ConfigPage
              data={snapshot}
              qr={qr}
              loginStatus={loginStatus}
              qrImage={qrImage}
              qrError={qrError}
              onRequestQr={() => void requestQr()}
              onUnlink={() => void onUnlinkWechat()}
              onSave={onSaveSettings}
            />
          ) : null}
          {activePage === "routes" ? (
            <RoutesPage
              routes={snapshot.routes}
              selectedRouteId={selectedRouteId}
              onSelect={setSelectedRouteId}
            />
          ) : null}
        </section>
        {activePage === "agents" ? <AgentsPage /> : null}
        {activePage === "trace" ? <TracePage /> : null}
      </div>
      {startupGate}
      <PixelClickBurstLayer />
    </>
  );
}
