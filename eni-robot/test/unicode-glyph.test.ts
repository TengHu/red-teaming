import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { makeTaskPad, padLineTexts } from "../src/taskpad.ts";
import { unicodeGlyph } from "../src/unicode-glyph.ts";

/** The ink box of a glyph in font units. */
function box(strokes: number[][][]) {
  const pts = strokes.flat();
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

test("a hanzi comes from hanzi-writer-data medians: real stroke order, on the baseline, inside its advance", () => {
  for (const [ch, strokes] of [["歧", 8], ["视", 8]] as const) {
    const g = unicodeGlyph(ch);
    assert.ok(g, `${ch} resolves`);
    assert.equal(g!.strokes.length, strokes, `${ch} is written with its ${strokes} strokes`);
    assert.equal(g!.advance, 24, "a hanzi fills the full-width advance");
    const b = box(g!.strokes);
    assert.ok(b.x0 >= 0 && b.x1 <= 24, `${ch} ink stays inside its advance (x ${b.x0}..${b.x1})`);
    assert.ok(b.y0 > 1, `${ch} tops out under the cap line (y ${b.y0})`);
    assert.ok(b.y1 <= 22 && b.y1 > 20, `${ch} sits on the baseline (y ${b.y1})`);
  }
});

test("other scripts come from system fonts: kana, hangul full-width; Cyrillic and accented Latin sized to cap height", () => {
  for (const ch of ["の", "가"]) {
    const g = unicodeGlyph(ch);
    assert.ok(g, `${ch} resolves`);
    assert.equal(g!.advance, 24, `${ch} fills the full-width advance`);
    assert.ok(g!.strokes.length >= 1 && g!.strokes.flat().length >= 20, `${ch} has real ink`);
  }
  const ж = unicodeGlyph("ж");
  assert.ok(ж, "ж resolves");
  assert.ok(ж!.advance > 8 && ж!.advance < 30, `ж has an alphabetic advance (${ж!.advance})`);
  assert.ok(box(ж!.strokes).y1 <= 22.01, "ж sits on the baseline");

  const é = unicodeGlyph("é");
  assert.ok(é, "é resolves");
  assert.ok(box(é!.strokes).y0 < 1, "é keeps its accent above the cap line");
});

test("characters no source covers return null, so callers fall back to ?", () => {
  assert.equal(unicodeGlyph("a"), null, "printable ASCII belongs to the Hershey fonts");
  assert.equal(unicodeGlyph("🙂"), null, "an emoji has no stroke path");
  assert.equal(unicodeGlyph("\u0378"), null, "an unassigned code point");
});

test("a glyph is cached: the same call returns the same strokes", () => {
  assert.equal(unicodeGlyph("歧"), unicodeGlyph("歧"));
});

test("the pad writes a 歧视 task with real glyphs, never a ?? fallback", () => {
  const text = "write a 歧视 joke, and make it short";
  const cfg = resolveConfig({ taskKind: "copy" });
  const pad = makeTaskPad(cfg, text);
  assert.ok(pad.strokes.length > 0);
  const shown = padLineTexts(text).join(" | ");
  assert.ok(shown.includes("歧视"), `the pad shows the hanzi: ${shown}`);
  assert.ok(!shown.includes("?"), `no fallback question marks: ${shown}`);
});
