import { readFileSync } from "node:fs";
import { createCanvas } from "@napi-rs/canvas";
import { createRequire } from "node:module";
import type { EnvConfig } from "./config.ts";
import { round, type Vec2 } from "./geometry.ts";
import { display, wrapText, type Unit } from "./padtext.ts";
import { unicodeGlyph } from "./unicode-glyph.ts";

/**
 * The task, handwritten by a person on a task pad: a digitizer tablet beside the desk.
 * The agent never gets the task as text: it gets this recording of pen strokes, and optionally a picture of a second handwritten page.
 */
export interface TaskPad {
  text: string;
  widthMm: number;
  heightMm: number;
  /** Placement on the desk in the page frame, for the 3D viewer: on the blank-sheet stack, left of the sheet. */
  xMm: number;
  yMm: number;
  /** Pen-down paths in pad millimetres, in writing order. */
  strokes: Vec2[][];
  /** The written lines, top to bottom, each as a range of `strokes`. */
  lines: PadLine[];
  /** Present when the page holds several deck sections (separated by a line "--"): which pad lines each section takes. */
  parts?: { section: number; lines: [number, number] }[];
}

/** One deck section to draw on a pad page. */
export interface PadPart {
  cfg: EnvConfig;
  text: string;
  section?: number;
}

/** One written line of the pad: `strokes[from, to)`. A blank line (paragraph break) has from === to. */
export interface PadLine {
  /** The y the line's letters sit on. */
  baselineMm: number;
  from: number;
  to: number;
  /** Where each of the line's words starts in `strokes`; empty for a blank line. */
  words: number[];
}

/** Hershey "Sans 1-stroke" (futural) from the hersheytext package: single-stroke printable ASCII. */
interface HersheyGlyph {
  d: string;
  /** Half the advance width; glyph x runs from 0 to 2 * o. */
  o: number;
}

export const PAD = { widthMm: 180, marginMm: 8, capMm: 5, lineMm: 10, minHeightMm: 60 };
const CAP_TOP = 1;
const BASELINE = 22;
const SPACE_UNITS = 12;
// The hersheytext conversion places these glyphs 3 units above the baseline.
const BASELINE_FIX: Record<string, number> = { ".": 3, ",": 3, ":": 3, ";": 3 };

let fontCache: Record<string, { chars: HersheyGlyph[] }> | null = null;
function glyphs(font = "futural"): HersheyGlyph[] {
  const file = createRequire(import.meta.url).resolve("hersheytext/hersheytext.json");
  fontCache ??= JSON.parse(readFileSync(file, "utf8")) as Record<string, { chars: HersheyGlyph[] }>;
  return fontCache[font].chars;
}

/** True for a single printable-ASCII character, the slots the Hershey font covers. */
const hersheySlot = (ch: string) => ch.length === 1 && ch >= "!" && ch <= "~";

/** One character's strokes in font units (y down, cap line at 1, baseline at 22) and its advance. Anything outside
 *  the Hershey font's ASCII (a hanzi, kana, Cyrillic, ...) comes from src/unicode-glyph.ts. */
function glyph(ch: string): { strokes: Vec2[][]; advance: number } {
  if (ch === " ") return { strokes: [], advance: SPACE_UNITS };
  if (hersheySlot(ch)) {
    const g = glyphs()[ch.charCodeAt(0) - 33];
    if (g) return { strokes: hersheyStrokes(g.d, BASELINE_FIX[ch] ?? 0), advance: 2 * g.o };
  }
  const q = glyphs()["?".charCodeAt(0) - 33];
  return unicodeGlyph(ch) ?? { strokes: hersheyStrokes(q.d, 0), advance: 2 * q.o };
}

function hersheyStrokes(d: string, dy: number): Vec2[][] {
  return d
    .split("M")
    .filter((s) => s.trim())
    .map((seg) => (seg.match(/-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?/g) ?? []).map((p) => {
      const [x, y] = p.split(",").map(Number);
      return [x, y + dy] as Vec2;
    }));
}

/** Width of a line of text in font units, as the pad's hand draws it. */
const widthOf = (text: string) => [...text].reduce((w, ch) => w + glyph(ch).advance, 0);
const USABLE_UNITS = (PAD.widthMm - 2 * PAD.marginMm) / (PAD.capMm / (BASELINE - CAP_TOP));

/** The pad's lines as words: word-wrapped to the pad width, keeping the writer's own line breaks. */
export function padUnits(text: string): Unit[][] {
  return wrapText(text, USABLE_UNITS, widthOf);
}

/** The text of every pad line, top to bottom (a paragraph break is an empty line). */
export function padLineTexts(text: string): string[] {
  return padUnits(text).map(lineText);
}

/** What a line of words shows on the pad. */
function lineText(line: Unit[]): string {
  return line.map(display).join(" ");
}

/** Pad line `i` as written in the printed hand: its strokes, and how many of them each word has. */
function padLine(units: Unit[], i: number): { strokes: Vec2[][]; wordStrokes: number[] } {
  const baseline = PAD.marginMm + PAD.capMm + i * PAD.lineMm;
  const s = PAD.capMm / (BASELINE - CAP_TOP);
  const strokes: Vec2[][] = [];
  const wordStrokes: number[] = [];
  let x = PAD.marginMm;
  units.forEach((u, k) => {
    if (k) x += SPACE_UNITS * s;
    wordStrokes.push(0);
    for (const ch of display(u)) {
      const g = glyph(ch);
      for (const st of g.strokes) {
        strokes.push(st.map(([gx, gy]) => [round(x + gx * s, 1), round(baseline + (gy - BASELINE) * s, 1)] as Vec2));
        wordStrokes[wordStrokes.length - 1]++;
      }
      x += g.advance * s;
    }
  });
  return { strokes, wordStrokes };
}

/** One word of the pad: its pad line (0-based, blank lines counted), its text, and its strokes `pad.strokes[from, to)`. */
export interface PadWord {
  line: number;
  text: string;
  from: number;
  to: number;
}

/** Every word of the pad `makeTaskPad(cfg, text)` builds, with the strokes it takes up, in writing order. */
export function padWords(cfg: EnvConfig, text: string): PadWord[] {
  const pad = makeTaskPad(cfg, text);
  const out: PadWord[] = [];
  padUnits(text).forEach((line, i) => {
    const { words, to } = pad.lines[i];
    line.forEach((u, k) => out.push({ line: i, text: display(u), from: words[k] ?? to, to: words[k + 1] ?? to }));
  });
  return out;
}

/** Lay the text out like a person writing on lined paper, and record every pen-down path. */
export function makeTaskPad(cfg: EnvConfig, text: string): TaskPad {
  return makeTaskPadParts([{ cfg, text }]);
}

/**
 * A pad page made of deck sections, drawn one under another, each starting on a new line. One part: exactly
 * makeTaskPad(cfg, text).
 */
export function makeTaskPadParts(parts: PadPart[]): TaskPad {
  const strokes: Vec2[][] = [];
  const padLines: PadLine[] = [];
  const partInfo: NonNullable<TaskPad["parts"]> = [];
  let i = 0;
  for (const part of parts) {
    const first = i;
    for (const line of padUnits(part.text)) {
      const from = strokes.length;
      const built = padLine(line, i);
      strokes.push(...built.strokes);
      const words: number[] = [];
      let at = from;
      for (const n of built.wordStrokes) {
        words.push(at);
        at += n;
      }
      padLines.push({ baselineMm: PAD.marginMm + PAD.capMm + i * PAD.lineMm, from, to: strokes.length, words });
      i++;
    }
    partInfo.push({ section: part.section ?? partInfo.length + 1, lines: [first, i] });
  }
  const heightMm = Math.max(PAD.minHeightMm, 2 * PAD.marginMm + PAD.capMm + (i - 1) * PAD.lineMm + 4);
  return {
    text: parts.map((p) => p.text).join("\n"),
    widthMm: PAD.widthMm,
    heightMm: round(heightMm, 1),
    xMm: -(parts[0].cfg.sheet.widthMm / 2 + 50) - PAD.widthMm / 2,
    yMm: 18,
    strokes,
    lines: padLines,
    ...(parts.length > 1 ? { parts: partInfo } : {}),
  };
}

/** A picture of the task pad: the handwriting in dark ink on white, as a person would see the tablet. */
export function renderPad(pad: TaskPad, pxPerMm = 6): Buffer {
  const canvas = createCanvas(Math.round(pad.widthMm * pxPerMm), Math.round(pad.heightMm * pxPerMm));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#111111";
  ctx.lineWidth = 0.4 * pxPerMm;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const st of pad.strokes) {
    ctx.beginPath();
    st.forEach(([x, y], i) => (i ? ctx.lineTo(x * pxPerMm, y * pxPerMm) : ctx.moveTo(x * pxPerMm, y * pxPerMm)));
    if (st.length === 1) ctx.lineTo(st[0][0] * pxPerMm + 0.1, st[0][1] * pxPerMm);
    ctx.stroke();
  }
  return canvas.toBuffer("image/png");
}

/** The whole pen recording, with nothing but geometry in it (saved with each run for the viewer). */
export function padRecording(pad: TaskPad): Record<string, unknown> {
  return {
    frame: "pad mm: origin at the top-left corner of the pad, +x right, +y down",
    size_mm: [pad.widthMm, pad.heightMm],
    stroke_count: pad.strokes.length,
    strokes: pad.strokes,
  };
}
