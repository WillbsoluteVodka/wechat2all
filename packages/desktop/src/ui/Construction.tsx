import type { CSSProperties } from "react";

import { PixelText } from "./PixelArt";

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

export function ConstructionBarrier() {
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

export function ConstructionPage() {
  return (
    <main className="page construction-page">
      <section className="construction-state" aria-label="Consturction Site">
        <ConstructionBarrier />
        <PixelText text="Consturction Site" className="construction-label" />
      </section>
    </main>
  );
}

