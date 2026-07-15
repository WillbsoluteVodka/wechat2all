import { useMemo, type CSSProperties } from "react";

export type PixelIconKind = "wechat" | "wechatGray" | "codex";
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

export function PixelIcon(props: {
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

export function PixelText(props: { text: string; className?: string }) {
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

