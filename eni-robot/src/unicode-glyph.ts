import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as fontkit from "fontkit";
import type { Vec2 } from "./geometry.ts";

/**
 * Strokes for characters outside the Hershey fonts' printable ASCII, in the same font units (y down, cap line 1,
 * baseline 22). Two sources, in order:
 *
 * - `hanzi-writer-data`: real stroke-order pen strokes (stroke medians) for CJK ideographs, so a hanzi on the pad
 *   is written the way a hand writes it, not traced from an outline.
 * - A system TrueType font via fontkit: glyph outlines flattened to polylines, for every other script (kana,
 *   hangul, Cyrillic, Hebrew, Thai, accented Latin, ...).
 *
 * Full-width glyphs are sized like a hand's own characters: ink about a cap height tall and wide, on the pad's
 * baseline. `unicodeGlyph` returns null for a character no source covers; callers fall back to the "?" glyph.
 */

export interface UnicodeGlyph {
  strokes: Vec2[][];
  advance: number;
}

// Hershey font-unit conventions (taskpad.ts, hand.ts).
const BASELINE = 22;
const CAP_UNITS = BASELINE - 1; // cap line y=1 to baseline y=22
/** Advance of a full-width glyph (a hanzi), in font units: a touch wider than the cap height. */
const CJK_ADVANCE = 24;

/** Code points whose glyphs fill a full em square: CJK, kana, hangul and their punctuation. */
function fullWidth(cp: number): boolean {
  return (
    (cp >= 0x2e80 && cp <= 0x312f) || // radicals, kangxi radicals, CJK punctuation, kana, bopomofo
    (cp >= 0x3190 && cp <= 0x31ef) || // kanbun, kana and CJK strokes supplements
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK unified ideographs extension A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified ideographs
    (cp >= 0xac00 && cp <= 0xd7af) || // hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xff00 && cp <= 0xffef) || // fullwidth and halfwidth forms
    cp >= 0x20000 // CJK extensions B and beyond
  );
}

// --- hanzi-writer-data: stroke medians in a 1024-unit em box, y down, origin top-left ---

const HANZI_EM = 1024;
/** The medians' y-up coordinate: the baseline sits at 0 and the ink tops out around 0.84 em. */
const HANZI_K = CAP_UNITS / (0.84 * HANZI_EM);

let hanziDir: string | null | undefined;

function hanziFile(ch: string): string | null {
  hanziDir ??= (() => {
    try {
      return dirname(createRequire(import.meta.url).resolve("hanzi-writer-data/index.js"));
    } catch {
      return null;
    }
  })();
  if (!hanziDir) return null;
  const file = join(hanziDir, `${ch}.json`);
  return existsSync(file) ? file : null;
}

const mix = (a: number, b: number, s: number) => a + (b - a) * s;

function hanziGlyph(ch: string): UnicodeGlyph | null {
  const file = hanziFile(ch);
  if (!file) return null;
  let data: { medians: number[][][] };
  try {
    data = JSON.parse(readFileSync(file, "utf8")) as { medians: number[][][] };
  } catch {
    return null;
  }
  if (!Array.isArray(data.medians)) return null;
  // The medians are pen centerlines, one polyline per stroke, in stroke order: y up, baseline 0, em 1024.
  const kx = CJK_ADVANCE / HANZI_EM;
  const strokes = data.medians
    .filter((m) => m.length >= 2)
    .map((m) => m.map(([x, y]) => [x * kx, BASELINE - y * HANZI_K] as Vec2));
  return strokes.length ? { strokes, advance: CJK_ADVANCE } : null;
}

// --- system fonts via fontkit: glyph outlines flattened to polylines ---

/** Candidate fonts, most preferred first; `SCRIBE_PAD_FONTS` (colon-separated) takes precedence. */
const FONT_FILES = [
  ...(process.env.SCRIBE_PAD_FONTS ? process.env.SCRIBE_PAD_FONTS.split(":").filter(Boolean) : []),
  "/System/Library/Fonts/Hiragino Sans GB.ttc",
  "/System/Library/Fonts/Supplemental/Songti.ttc",
  "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
  "/Library/Fonts/Arial Unicode.ttf",
  "/System/Library/Fonts/AppleSDGothicNeo.ttc",
  "/System/Library/Fonts/GeezaPro.ttc",
  "/System/Library/Fonts/Thonburi.ttc",
  "/System/Library/Fonts/Devanagari Sangam MN.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "C:/Windows/Fonts/msyh.ttc",
  "C:/Windows/Fonts/arialuni.ttf",
];

interface FontkitFont {
  unitsPerEm: number;
  capHeight?: number;
  glyphForCodePoint(cp: number): { id: number; advanceWidth: number; path: { commands: { command: string; args: number[] }[] } | null };
}

let systemFonts: FontkitFont[] | undefined;

function loadSystemFonts(): FontkitFont[] {
  systemFonts ??= FONT_FILES.flatMap((file) => {
    try {
      const f = fontkit.openSync(file) as FontkitFont & { fonts?: FontkitFont[] };
      return f.fonts ?? [f];
    } catch {
      return [];
    }
  });
  return systemFonts;
}

/** A font glyph's outline as polylines, curves flattened, in font units with y flipped to point down. */
function outlineOf(g: { path: { commands: { command: string; args: number[] }[] } | null }): Vec2[][] {
  const strokes: Vec2[][] = [];
  let cur: Vec2[] = [];
  const push = () => {
    if (cur.length > 1) strokes.push(cur);
    cur = [];
  };
  for (const c of g.path?.commands ?? []) {
    const a = c.args;
    if (c.command === "moveTo" || c.command === "move") {
      push();
      cur = [[a[0], a[1]]];
    } else if (c.command === "lineTo" || c.command === "line") {
      cur.push([a[0], a[1]]);
    } else if (c.command === "quadraticCurveTo" || c.command === "quadratic") {
      const p0 = cur.at(-1) ?? [0, 0];
      for (let k = 1; k <= 8; k++) {
        const s = k / 8;
        cur.push([mix(mix(p0[0], a[0], s), mix(a[0], a[2], s), s), mix(mix(p0[1], a[1], s), mix(a[1], a[3], s), s)]);
      }
    } else if (c.command === "bezierCurveTo" || c.command === "curve") {
      const p0 = cur.at(-1) ?? [0, 0];
      for (let k = 1; k <= 10; k++) {
        const s = k / 10;
        const x1 = mix(p0[0], a[0], s), x2 = mix(a[0], a[2], s), x3 = mix(a[2], a[4], s);
        const y1 = mix(p0[1], a[1], s), y2 = mix(a[1], a[3], s), y3 = mix(a[3], a[5], s);
        cur.push([mix(mix(x1, x2, s), mix(x2, x3, s), s), mix(mix(y1, y2, s), mix(y2, y3, s), s)]);
      }
    } else if (c.command === "closePath" || c.command === "close") {
      if (cur.length) cur.push([...cur[0]]);
      push();
    }
  }
  push();
  return strokes;
}

function fontGlyphOf(font: FontkitFont, ch: string): UnicodeGlyph | null {
  const cp = ch.codePointAt(0)!;
  const g = font.glyphForCodePoint(cp);
  if (!g || g.id === 0 || !g.path?.commands.length) return null;
  const U = font.unitsPerEm;
  const fw = fullWidth(cp);
  // Full-width glyphs sit on the baseline like the hanzi medians do; alphabetic glyphs hang from it by cap height.
  const k = fw ? CAP_UNITS / (0.84 * U) : CAP_UNITS / (font.capHeight || 0.7 * U);
  const yOf = (y: number) => BASELINE - y * k;
  const strokes = outlineOf(g).map((st) => st.map(([x, y]) => [x * k, yOf(y)] as Vec2));
  if (!strokes.length) return null;
  let advance = g.advanceWidth * k;
  if (fw) {
    // Centre the ink in the full-width advance.
    const xs = strokes.flat().map(([x]) => x);
    const dx = (CJK_ADVANCE - (Math.max(...xs) - Math.min(...xs))) / 2 - Math.min(...xs);
    for (const st of strokes) for (const p of st) p[0] += dx;
    advance = CJK_ADVANCE;
  }
  return { strokes, advance };
}

function outlineGlyph(ch: string): UnicodeGlyph | null {
  for (const font of loadSystemFonts()) {
    const g = fontGlyphOf(font, ch);
    if (g) return g;
  }
  return null;
}

const cache = new Map<string, UnicodeGlyph | null>();

/** Strokes and advance for a non-ASCII character, or null when no source covers it. */
export function unicodeGlyph(ch: string): UnicodeGlyph | null {
  const cp = ch.codePointAt(0)!;
  if (cp >= 0x21 && cp <= 0x7e) return null; // the Hershey fonts own printable ASCII
  let g = cache.get(ch);
  if (g === undefined) {
    g = cp >= 0x3400 && cp <= 0x9fff ? (hanziGlyph(ch) ?? outlineGlyph(ch)) : outlineGlyph(ch);
    cache.set(ch, g);
  }
  return g;
}
