import assert from "node:assert/strict";
import { test } from "node:test";
import { checkProgram, hasTaskWords, taskWords } from "../src/program-check.ts";

const words = taskWords("The quick brown fox jumps over the lazy dog, for a while.");

test("task words are the letter runs of three or more letters", () => {
  assert.deepEqual([...words].sort(), ["brown", "dog", "for", "fox", "jumps", "lazy", "over", "quick", "the", "while"]);
  assert.equal(hasTaskWords("I will write the next line now.", words), true);
  assert.equal(hasTaskWords("Writing line 3 at y = 50.", words), false);
});

test("programs made of pen calls and numbers pass", () => {
  const ok = [
    "pen.stroke([[28, 30], [40, 30]]);",
    "for (let i = 0; i < 3; i++) pen.stroke([[28 + i * 5, 25], [28 + i * 5, 30]]);",
    "const pts = [[1, 2], [3, 4]].map(([x, y]) => [x + 10, y * 2]); pen.stroke(pts, true);",
    "lib.shapes = [1, 2, 3]; lib.scale = Math.round(1.5 * 2);",
    'pen.set_tool("eraser"); pen.stroke([[28, 30], [40, 30]]); pen.set_tool("pen");',
    "for (const p of lib.shapes) pen.move_to(p, 1e2, 0.5);",
    "console.log(pen.tip(), 0x1f);",
    "const o = { x: 1, y: 2, z: 3 }; pen.move_to(o.x, o.y);",
    "let total = 0; const baseline = 30; const dx = 4; total += dx;",
  ];
  for (const code of ok) assert.equal(checkProgram(code, words), null, code);
  assert.equal(checkProgram("for (let i = 0; i < 2; i++) pen.pen_up();", taskWords("for the fox")), null, "a keyword that is also a task word");
});

test("programs that carry text are rejected, without echoing it", () => {
  const bad: [string, RegExp][] = [
    ["// the fox\npen.pen_up();", /a comment at line 1/],
    ["pen.pen_up();\n/* x */", /a comment at line 2/],
    ["const s = 'abc';", /a string literal at line 1/],
    ['pen.set_tool("Pen");', /a string literal/],
    ["const s = `abc`;", /a template literal/],
    ['const s = "abc', /an unterminated string/],
    ["const quick = 1;", /a name at line 1 that spells a word of the task/],
    ["lib.brownFox = 2;", /spells a word of the task/],
    ["let lazy_dog = 0;", /spells a word of the task/],
    ["pen.pen_up();\nlet q = String.fromCharCode(72);", /a text-building function at line 2/],
    ["lib.g.A = [[0, 0], [1, 1]];", /a letter name/],
    ["lib.g = { A: [[0, 0]], b: [[1, 1]] };", /a letter name/],
  ];
  for (const [code, why] of bad) {
    const found = checkProgram(code, words);
    assert.ok(found, `should reject: ${code}`);
    assert.match(found, why);
    for (const w of ["quick", "brown", "fox", "lazy", "dog", "abc", "Pen"]) assert.ok(!found.includes(w), `the reason repeats "${w}"`);
  }
});
