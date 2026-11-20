import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { LineFeeder } from "../src/linefeed.ts";
import { makeTaskPad } from "../src/taskpad.ts";

const cfg = resolveConfig();
const text = "Every autumn my neighbor rebuilds the low stone wall at the end of her garden.\n\nShe says the frost moves the stones.\nIt takes her a week.";
const pad = makeTaskPad(cfg, text);
const written = pad.lines.filter((l) => l.to > l.from);
const gapBefore = (i: number) => Math.min(...pad.strokes[i].map((p) => p[0])) - Math.max(...pad.strokes[i - 1].map((p) => p[0]));

test("pad lines partition the strokes in order, each inside its own band", () => {
  let next = 0;
  for (const l of pad.lines) {
    assert.equal(l.from, next);
    assert.ok(l.to >= l.from);
    for (const st of pad.strokes.slice(l.from, l.to)) {
      for (const [, y] of st) assert.ok(y >= l.baselineMm - 6.5 && y <= l.baselineMm + 2.5, `y ${y} on the line with baseline ${l.baselineMm}`);
    }
    next = l.to;
  }
  assert.equal(next, pad.strokes.length);
  assert.ok(pad.lines.some((l) => l.from === l.to), "a paragraph break is a blank line");
  assert.ok(written.length >= 4);
});

test("the feeder hands out one written line at a time and advances on enough ink", () => {
  const f = new LineFeeder(pad, cfg.lineFeed);
  assert.equal(f.lineCount, written.length);
  let p = f.piece!;
  assert.deepEqual(
    [p.line, p.lines, p.from, p.to, p.continuesLine, p.endsLine, p.turnsShown, p.padBaselineMm],
    [0, written.length, written[0].from, written[0].to, false, true, 1, written[0].baselineMm],
  );
  assert.equal(f.strokes().length, written[0].to - written[0].from);
  assert.ok(p.inkMm > 100);

  assert.equal(f.afterTurn(1000, false), "same", "a failed turn does not advance");
  assert.equal(f.piece!.turnsShown, 2);
  assert.equal(f.afterTurn(5, true), "same", "too little ink does not advance");
  assert.equal(f.afterTurn(1000, true), "advanced");
  p = f.piece!;
  assert.deepEqual([p.line, p.from, p.turnsShown], [1, written[1].from, 1]);

  for (let i = 1; i < written.length; i++) assert.equal(f.afterTurn(1000, true), "advanced");
  assert.equal(f.complete, true);
  assert.equal(f.piece, null);
  assert.equal(f.afterTurn(0, true), "same");
  assert.equal(f.afterTurn(0, true), "same");
  assert.equal(f.afterTurn(0, true), "stalled", "idling after completion ends the episode too");
});

test("three turns without ink stall the feeder, unless stalling is off", () => {
  const f = new LineFeeder(pad, cfg.lineFeed);
  assert.equal(f.afterTurn(0, true), "same");
  assert.equal(f.afterTurn(0, true), "same");
  assert.equal(f.afterTurn(0, true), "stalled");
  const g = new LineFeeder(pad, { ...cfg.lineFeed, stallTurns: 0 });
  for (let i = 0; i < 10; i++) assert.equal(g.afterTurn(0, true), "same");
});

test("a block halves the piece at a word gap, down to the minimum; the rest follows and the cap grows back", () => {
  const f = new LineFeeder(pad, cfg.lineFeed);
  const full = f.piece!;
  const count = full.to - full.from;
  assert.equal(f.capStrokes, Infinity);

  assert.equal(f.narrow(), true);
  let p = f.piece!;
  assert.equal(f.capStrokes, Math.floor(count / 2));
  assert.ok(p.to - p.from <= Math.floor(count / 2) && p.to - p.from >= cfg.lineFeed.minPieceStrokes);
  assert.equal(p.from, full.from);
  assert.equal(p.endsLine, false);
  assert.equal(p.turnsShown, 1);
  assert.ok(gapBefore(p.to) >= 2.5, `cut at a word space, gap ${gapBefore(p.to)} mm`);

  while (f.narrow()) {}
  p = f.piece!;
  assert.equal(f.capStrokes, cfg.lineFeed.minPieceStrokes);
  assert.equal(p.to - p.from, cfg.lineFeed.minPieceStrokes);

  assert.equal(f.afterTurn(1000, true), "advanced");
  p = f.piece!;
  assert.deepEqual([p.line, p.continuesLine, p.from], [0, true, full.from + cfg.lineFeed.minPieceStrokes]);
  assert.ok(p.to - p.from <= cfg.lineFeed.minPieceStrokes);
  assert.equal(f.afterTurn(1000, true), "advanced");
  assert.equal(f.afterTurn(1000, true), "advanced");
  assert.equal(f.capStrokes, 2 * cfg.lineFeed.minPieceStrokes, "three clean pieces double the cap");

  const small = new LineFeeder(makeTaskPad(cfg, "Hi"), cfg.lineFeed);
  assert.equal(small.narrow(), false, "a piece under the minimum cannot be narrowed");
});
