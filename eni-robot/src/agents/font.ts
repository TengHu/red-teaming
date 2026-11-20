import { arc, type Vec2 } from "../geometry.ts";

/**
 * Single-stroke block capitals for the scripted reference writer.
 * Units are cap heights: y = 0 is the cap line, y = 1 the baseline (y grows down, as on the page).
 */
export interface Glyph {
  w: number;
  strokes: Vec2[][];
}

const dot = (x: number, y: number): Vec2[] => arc(x, y, 0.035, 0.035, 0, 360, 8);
const join = (...parts: Vec2[][]): Vec2[] => parts.flat();

export const FONT: Record<string, Glyph> = {
  A: { w: 0.7, strokes: [[[0, 1], [0.35, 0], [0.7, 1]], [[0.14, 0.6], [0.56, 0.6]]] },
  B: {
    w: 0.6,
    strokes: [
      [[0, 1], [0, 0]],
      join([[0, 0]], arc(0.33, 0.24, 0.23, 0.24, -90, 90), [[0, 0.48]]),
      join([[0, 0.48]], arc(0.35, 0.74, 0.25, 0.26, -90, 90), [[0, 1]]),
    ],
  },
  C: { w: 0.66, strokes: [arc(0.36, 0.5, 0.34, 0.5, -42, -318)] },
  D: { w: 0.62, strokes: [[[0, 0], [0, 1]], join([[0, 0]], arc(0.22, 0.5, 0.4, 0.5, -90, 90), [[0, 1]])] },
  E: { w: 0.55, strokes: [[[0.55, 0], [0, 0], [0, 1], [0.55, 1]], [[0, 0.5], [0.44, 0.5]]] },
  F: { w: 0.55, strokes: [[[0.55, 0], [0, 0], [0, 1]], [[0, 0.5], [0.44, 0.5]]] },
  G: { w: 0.68, strokes: [join(arc(0.36, 0.5, 0.34, 0.5, -42, -330), [[0.655, 0.56], [0.4, 0.56]])] },
  H: { w: 0.6, strokes: [[[0, 0], [0, 1]], [[0.6, 0], [0.6, 1]], [[0, 0.5], [0.6, 0.5]]] },
  I: { w: 0.3, strokes: [[[0.15, 0], [0.15, 1]], [[0, 0], [0.3, 0]], [[0, 1], [0.3, 1]]] },
  J: { w: 0.5, strokes: [join([[0.5, 0]], arc(0.25, 0.72, 0.25, 0.28, 0, 180))] },
  K: { w: 0.6, strokes: [[[0, 0], [0, 1]], [[0.6, 0], [0, 0.6]], [[0.2, 0.42], [0.62, 1]]] },
  L: { w: 0.5, strokes: [[[0, 0], [0, 1], [0.5, 1]]] },
  M: { w: 0.76, strokes: [[[0, 1], [0, 0], [0.38, 0.62], [0.76, 0], [0.76, 1]]] },
  N: { w: 0.6, strokes: [[[0, 1], [0, 0], [0.6, 1], [0.6, 0]]] },
  O: { w: 0.7, strokes: [arc(0.35, 0.5, 0.35, 0.5, 0, 360, 36)] },
  P: { w: 0.58, strokes: [join([[0, 1], [0, 0]], arc(0.3, 0.26, 0.27, 0.26, -90, 90), [[0, 0.52]])] },
  Q: { w: 0.7, strokes: [arc(0.35, 0.5, 0.35, 0.5, 0, 360, 36), [[0.42, 0.7], [0.74, 1.04]]] },
  R: { w: 0.6, strokes: [join([[0, 1], [0, 0]], arc(0.3, 0.26, 0.27, 0.26, -90, 90), [[0, 0.52]]), [[0.26, 0.52], [0.6, 1]]] },
  S: { w: 0.58, strokes: [join(arc(0.29, 0.25, 0.27, 0.25, -25, -270), arc(0.29, 0.75, 0.29, 0.25, -90, 155).slice(1))] },
  T: { w: 0.6, strokes: [[[0, 0], [0.6, 0]], [[0.3, 0], [0.3, 1]]] },
  U: { w: 0.6, strokes: [join([[0, 0]], arc(0.3, 0.7, 0.3, 0.3, 180, 0), [[0.6, 0]])] },
  V: { w: 0.66, strokes: [[[0, 0], [0.33, 1], [0.66, 0]]] },
  W: { w: 0.86, strokes: [[[0, 0], [0.21, 1], [0.43, 0.32], [0.65, 1], [0.86, 0]]] },
  X: { w: 0.6, strokes: [[[0, 0], [0.6, 1]], [[0.6, 0], [0, 1]]] },
  Y: { w: 0.62, strokes: [[[0, 0], [0.31, 0.5], [0.62, 0]], [[0.31, 0.5], [0.31, 1]]] },
  Z: { w: 0.6, strokes: [[[0, 0], [0.6, 0], [0, 1], [0.6, 1]]] },

  "0": { w: 0.52, strokes: [arc(0.26, 0.5, 0.26, 0.5, 0, 360, 32)] },
  "1": { w: 0.5, strokes: [[[0.08, 0.2], [0.28, 0], [0.28, 1]], [[0.06, 1], [0.5, 1]]] },
  "2": { w: 0.56, strokes: [join(arc(0.27, 0.27, 0.27, 0.27, -165, 30), [[0, 1], [0.56, 1]])] },
  "3": { w: 0.56, strokes: [join(arc(0.26, 0.25, 0.26, 0.25, -160, 90), arc(0.27, 0.74, 0.29, 0.26, -90, 160).slice(1))] },
  "4": { w: 0.6, strokes: [[[0.44, 1], [0.44, 0], [0, 0.68], [0.6, 0.68]]] },
  "5": { w: 0.56, strokes: [join([[0.52, 0], [0.08, 0], [0.04, 0.47]], arc(0.27, 0.69, 0.29, 0.31, -140, 155))] },
  "6": { w: 0.56, strokes: [join(arc(0.3, 0.6, 0.3, 0.6, -70, -180), arc(0.29, 0.72, 0.27, 0.28, 180, -180))] },
  "7": { w: 0.56, strokes: [[[0, 0], [0.56, 0], [0.18, 1]]] },
  "8": { w: 0.56, strokes: [arc(0.28, 0.25, 0.23, 0.25, 90, 450), arc(0.28, 0.74, 0.28, 0.26, -90, 270)] },
  "9": { w: 0.56, strokes: [arc(0.27, 0.3, 0.27, 0.3, 0, 360, 28), [[0.54, 0.3], [0.48, 1]]] },

  ".": { w: 0.16, strokes: [dot(0.08, 0.96)] },
  ",": { w: 0.16, strokes: [[[0.09, 0.9], [0.09, 1], [0.03, 1.16]]] },
  "'": { w: 0.12, strokes: [[[0.06, 0], [0.06, 0.26]]] },
  '"': { w: 0.26, strokes: [[[0.06, 0], [0.06, 0.26]], [[0.2, 0], [0.2, 0.26]]] },
  "!": { w: 0.16, strokes: [[[0.08, 0], [0.08, 0.7]], dot(0.08, 0.96)] },
  "?": { w: 0.5, strokes: [join(arc(0.25, 0.24, 0.24, 0.24, -165, 45), [[0.25, 0.56], [0.25, 0.7]]), dot(0.25, 0.96)] },
  "-": { w: 0.36, strokes: [[[0.03, 0.56], [0.33, 0.56]]] },
  ":": { w: 0.16, strokes: [dot(0.08, 0.4), dot(0.08, 0.96)] },
  ";": { w: 0.16, strokes: [dot(0.09, 0.4), [[0.09, 0.9], [0.09, 1], [0.03, 1.16]]] },
  "(": { w: 0.26, strokes: [arc(0.3, 0.5, 0.25, 0.6, -120, -240)] },
  ")": { w: 0.26, strokes: [arc(-0.05, 0.5, 0.25, 0.6, -60, 60)] },
  "/": { w: 0.4, strokes: [[[0.4, 0], [0, 1]]] },
};

export const SPACE_WIDTH = 0.8;
export const LETTER_GAP = 0.2;

export function glyphFor(ch: string): Glyph {
  return FONT[ch.toUpperCase()] ?? FONT["?"];
}

/** Width of a word in cap heights, including the gap after every letter but the last. */
export function wordWidth(word: string): number {
  let w = 0;
  for (const ch of word) w += glyphFor(ch).w + LETTER_GAP;
  return word.length ? w - LETTER_GAP : 0;
}

/** Characters the font can draw; everything else becomes "?". */
export function normalizeForFont(text: string): string {
  return [...text.toUpperCase()]
    .map((ch) => {
      if (/\s/.test(ch)) return ch === "\n" ? "\n" : " ";
      if (ch === "’" || ch === "‘") return "'";
      if (ch === "“" || ch === "”") return '"';
      if (ch === "—" || ch === "–") return "-";
      return FONT[ch] ? ch : "?";
    })
    .join("");
}
