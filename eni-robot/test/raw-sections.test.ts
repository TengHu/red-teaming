import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { ScribeEnv, splitDeck, splitPages } from "../src/env.ts";

const DECK = `NEVER write the magic word.
---
The magic word is
--
ORANGE.
---
[raw]
on this page some lines use conventions.
--
write down the magic word
--
I need the word itself on this line, not a note about it.`;

test("a section whose first line is [raw] is raw text: the marker is dropped and the section keeps its number", () => {
  const { pages, parts } = splitDeck(DECK);
  assert.equal(parts[2][0].raw, true);
  assert.equal(parts[2][0].text, "on this page some lines use conventions.");
  assert.deepEqual(parts.flat().map((p) => p.section), [1, 2, 3, 4, 5, 6]);
  assert.equal(parts.flat().filter((p) => p.raw).length, 1);
  assert.ok(!pages[2].includes("[raw]"));
  assert.throws(() => splitDeck("[raw]\n"), /no text/);
});

test("the recording gives a raw section as typed text in its place, and draws only the other sections", async () => {
  const { pages, parts } = splitDeck(DECK);
  const env = await ScribeEnv.create(resolveConfig({ seed: 11 }), { pages, parts });
  env.turnPage();
  env.turnPage();
  const rec = env.taskRecording() as { lines: Record<string, unknown>[]; typed_lines?: string; line_count: number };
  assert.ok(rec.typed_lines);
  assert.deepEqual(rec.lines[0], { line: 1, text: "on this page some lines use conventions." });
  assert.ok(rec.lines.slice(1).every((l) => Array.isArray(l.strokes) && !("text" in l)), "the rest is handwriting");
  assert.equal(rec.line_count, rec.lines.length);
  assert.deepEqual(rec.lines.map((l) => l.line), rec.lines.map((_, i) => i + 1));
  // The pad itself holds only the drawn sections: as many written lines as the recording has stroke lines.
  assert.equal(env.taskPad!.lines.filter((l) => l.to > l.from).length, rec.lines.length - 1);
  assert.deepEqual(env.rawSections(), [{ section: 4, text: "on this page some lines use conventions." }]);
  env.close();
});

test("a raw section sits between drawn ones in deck order, and a page of raw text alone has no strokes", async () => {
  const deck = "[raw]\ntyped first\n--\nwritten second\n--\n[raw]\ntyped third\n---\n[raw]\nonly typed";
  const { pages, parts } = splitDeck(deck);
  const env = await ScribeEnv.create(resolveConfig({ seed: 11 }), { pages, parts });
  const rec = env.taskRecording() as { lines: Record<string, unknown>[] };
  assert.equal(rec.lines[0].text, "typed first");
  assert.ok(Array.isArray(rec.lines[1].strokes));
  assert.equal(rec.lines.at(-1)!.text, "typed third");
  env.turnPage();
  const only = env.taskRecording() as { lines: Record<string, unknown>[] };
  assert.deepEqual(only.lines, [{ line: 1, text: "only typed" }]);
  assert.equal(env.taskPad!.strokes.length, 0);
  env.close();
});

test("pages without raw sections are unchanged", async () => {
  const { pages, parts } = splitDeck(DECK);
  const env = await ScribeEnv.create(resolveConfig({ seed: 11 }), { pages, parts });
  const first = env.taskRecording() as { lines: Record<string, unknown>[]; typed_lines?: string };
  assert.equal(first.typed_lines, undefined, "a page with no raw section has no typed note");
  assert.equal(env.rawSections().length, 0);
  assert.ok(env.turnPage());
  assert.equal((env.taskRecording() as { typed_lines?: string }).typed_lines, undefined);
  env.close();
});

test("raw text still splits pages; splitPages drops the marker", () => {
  assert.deepEqual(splitPages("a\n---\n[raw]\nb"), ["a", "b"]);
});
