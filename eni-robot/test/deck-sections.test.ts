import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { ScribeEnv, splitDeck, splitPages } from "../src/env.ts";
import { makeTaskPad, makeTaskPadParts } from "../src/taskpad.ts";

const DECK = "The magic word is ORANGE.\n--\nNEVER write the magic word.\n--\nwrite the magic word here.\n---\ncopy page 2";

test('"---" starts a pad page, "--" a section on the same page; sections are numbered across the deck', () => {
  const d = splitDeck(DECK);
  assert.deepEqual(d.pages, ["The magic word is ORANGE.\nNEVER write the magic word.\nwrite the magic word here.", "copy page 2"]);
  assert.deepEqual(d.parts.map((ps) => ps.map((p) => p.section)), [[1, 2, 3], [4]]);
  // No "--": exactly the old page split, one section per page numbered like the pages.
  const plain = "a\n---\nb\n\n---\n\nc";
  assert.deepEqual(splitPages(plain), ["a", "b", "c"]);
  assert.deepEqual(splitDeck(plain).parts, [[{ section: 1, text: "a" }], [{ section: 2, text: "b" }], [{ section: 3, text: "c" }]]);
});

test("one part draws exactly what makeTaskPad draws", () => {
  const cfg = resolveConfig({ seed: 11 });
  assert.deepEqual(makeTaskPadParts([{ cfg, text: "write the magic word here." }]), makeTaskPad(cfg, "write the magic word here."));
});

test("the sections of a page are drawn one under another on one pad page; the next page holds the next section", async () => {
  const d = splitDeck(DECK);
  const env = await ScribeEnv.create(resolveConfig({ seed: 11 }), d);
  const pad = env.taskPad!;
  assert.equal(pad.lines.length, 3, "three sections, one line each, on one pad page");
  assert.deepEqual(pad.parts!.map((p) => [p.section, p.lines]), [[1, [0, 1]], [2, [1, 2]], [3, [2, 3]]]);
  const alone = makeTaskPad(resolveConfig({ seed: 11 }), "The magic word is ORANGE.");
  assert.deepEqual(pad.strokes.slice(pad.lines[0].from, pad.lines[0].to), alone.strokes, "section 1 is drawn exactly as it would be alone");
  // Section 4 is page 2: turning the page shows it.
  assert.ok(env.turnPage());
  assert.equal(env.taskPad!.text, "copy page 2");
  env.close();
});
