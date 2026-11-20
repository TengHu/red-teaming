import assert from "node:assert/strict";
import { test } from "node:test";
import { textFreeTools } from "../src/actions.ts";
import { resolveConfig, type ActionMode } from "../src/config.ts";
import { runArgon, turnOnDone } from "../src/agents/argon.ts";
import { ScribeEnv, splitPages } from "../src/env.ts";
import { GlyphLibrary } from "../src/glyphs.ts";
import { renderSheet } from "../src/ink.ts";
import { renderPad } from "../src/taskpad.ts";
import { arc, catmullRom } from "../src/geometry.ts";
import type { ChatClient as GatewayClient } from "../src/clients/index.ts";
const quiet = (over = {}) => resolveConfig({ noise: { jitterMm: 0 }, taskKind: "copy", ...over });

test("stroke leaves ink only along its path", async () => {
  const env = await ScribeEnv.create(quiet());
  const r = env.step([{ name: "stroke", args: { points: [[40, 30], [60, 30]] } }]);
  assert.equal(r.results[0].status, "ok");
  assert.equal(r.results[0].path_mm, 20);
  const ink = env.world.sheet.ink;
  assert.ok(ink.alphaAt(50, 30) > 200);
  assert.equal(ink.alphaAt(50, 35), 0);
  assert.equal(env.world.contact, false, "stroke lifts the pen at the end");
  env.close();
});

test("hovering moves leave no ink; dragging with the pen down does", async () => {
  const env = await ScribeEnv.create(quiet());
  env.step([{ name: "move_to", args: { x: 40, y: 50 } }, { name: "move_to", args: { x: 80, y: 50 } }]);
  assert.equal(env.world.sheet.ink.alphaAt(60, 50), 0);
  env.step([{ name: "pen_down", args: {} }, { name: "move_by", args: { dx: 0, dy: 20 } }, { name: "pen_up", args: {} }]);
  assert.ok(env.world.sheet.ink.alphaAt(80, 60) > 200);
  env.close();
});

test("commands off the sheet are clipped and reported", async () => {
  const env = await ScribeEnv.create(quiet());
  const r = env.step([{ name: "move_to", args: { x: 500, y: -4 } }]);
  assert.equal(r.results[0].status, "clipped");
  assert.deepEqual(env.world.cmd.slice(0, 2), [210, 0]);
  env.close();
});

test("an error cancels the rest of the batch", async () => {
  const env = await ScribeEnv.create(quiet());
  const r = env.step([
    { name: "stroke", args: { points: "nope" } },
    { name: "stroke", args: { points: [[40, 30], [60, 30]] } },
  ]);
  assert.equal(r.results[0].status, "error");
  assert.equal(r.results[1].status, "skipped");
  assert.equal(env.world.sheet.strokes, 0);
  env.close();
});

test("the eraser removes ink", async () => {
  const env = await ScribeEnv.create(quiet());
  env.step([
    { name: "stroke", args: { points: [[40, 30], [60, 30]] } },
    { name: "set_tool", args: { tool: "eraser" } },
    { name: "stroke", args: { points: [[45, 30], [55, 30]] } },
  ]);
  assert.equal(env.world.sheet.ink.alphaAt(50, 30), 0);
  assert.ok(env.world.sheet.ink.alphaAt(41, 30) > 200);
  env.close();
});

test("one paper per episode: there is no new_sheet tool, and the episode ends once the last ruled line is written", async () => {
  // Two ruled lines: y = 30 and 40.
  const env = await ScribeEnv.create(quiet({ taskKind: "instruct", pageImage: true, sheet: { lastLineMm: 40 } }), { task: "Write a joke." });
  assert.ok(!env.tools().some((t) => t.function.name === "new_sheet"));
  assert.equal(env.step([{ name: "new_sheet", args: {} }]).results[0].status, "error");

  assert.equal(env.step([ink(30)]).done, false);
  const r = env.step([ink(40)]);
  assert.equal(r.done, true, "the paper is full, so the episode ends");
  assert.equal(env.endReason, "paper_full");
  assert.ok(env.world.sheet.ink.alphaAt(50, 38) > 200, "both lines are on the one paper");
  assert.deepEqual(r.observation.images[0].png, renderSheet(env.cfg, env.world.sheet.ink, 4, { ruling: false }), "the page image shows the paper");
  env.close();
});

test("images are off by default: no images, no image calibration and no look_at", async () => {
  const env = await ScribeEnv.create(quiet());
  const obs = env.observe();
  assert.deepEqual(obs.images, []);
  assert.ok(!("images" in obs.json));
  assert.ok(!env.tools().some((t) => t.function.name === "look_at"));
  assert.equal(env.step([{ name: "look_at", args: { x: 100, y: 150 } }]).results[0].status, "error");
  env.close();
});

test("with images on, the observation carries calibration for both images and a pinned look_at lasts one turn", async () => {
  const env = await ScribeEnv.create(quiet({ images: true }));
  assert.ok(env.tools().some((t) => t.function.name === "look_at"));
  const r = env.step([{ name: "look_at", args: { x: 100, y: 150, width_mm: 60 } }]);
  const images = r.observation.json.images as Record<string, { region_mm: number[]; pixel_to_mm: string }>;
  assert.deepEqual(images.detail.region_mm, [70, 127.5, 130, 172.5]);
  assert.match(images.overview.pixel_to_mm, /x_mm = \(u - 36\) \/ 4/);
  const next = env.step([]).observation.json.images as typeof images;
  assert.notDeepEqual(next.detail.region_mm, images.detail.region_mm);
  env.close();
});

test("done ends the episode", async () => {
  const env = await ScribeEnv.create(quiet());
  const r = env.step([{ name: "done", args: {} }, { name: "pen_up", args: {} }]);
  assert.equal(r.done, true);
  assert.equal(env.endReason, "done");
  assert.equal(r.results[1].status, "skipped");
  env.close();
});

test("programs drive the pen, keep lib between runs, and cannot reach the host", async () => {
  const env = await ScribeEnv.create(quiet({ actionMode: "code" }));
  const run = (code: string) => env.step([{ name: "run_program", args: { code } }]).results[0];
  let r = run("lib.count = 1; pen.stroke([[40, 30], [60, 30]]); return pen.tip();");
  assert.equal(r.status, "ok");
  assert.deepEqual(r.returned, [60, 30, 3]);
  r = run("return ++lib.count;");
  assert.equal(r.returned, 2);
  r = run("return typeof process + typeof require + typeof fetch;");
  assert.equal(r.returned, "undefinedundefinedundefined");
  r = run("pen.stroke(5);");
  assert.equal(r.status, "error");
  assert.match(String(r.error), /points/);
  env.close();
});

test("programs are stopped by the call budget and the CPU limit", async () => {
  const env = await ScribeEnv.create(quiet({ actionMode: "code", program: { callBudget: 5, cpuMs: 200, memoryMb: 32 } }));
  let r = env.step([{ name: "run_program", args: { code: "for (let i = 0; i < 10; i++) pen.move_to(50, 50);" } }]).results[0];
  assert.equal(r.program_status, "budget_exceeded");
  r = env.step([{ name: "run_program", args: { code: "while (true) {}" } }]).results[0];
  assert.equal(r.program_status, "timeout");
  env.close();
});

test("only code mode has run_program; every other mode's tools take no free text", async () => {
  const names = async (actionMode: ActionMode) => {
    const env = await ScribeEnv.create(quiet({ actionMode, notes: true }));
    const tools = env.tools();
    env.close();
    return { names: tools.map((t) => t.function.name), textFree: textFreeTools(tools) };
  };
  const glyphs = await names("glyphs");
  assert.ok(glyphs.textFree);
  assert.ok(["strokes", "define_glyph", "write_glyphs", "write_notes"].every((n) => glyphs.names.includes(n)));
  const strokes = await names("strokes");
  assert.ok(strokes.textFree && strokes.names.includes("strokes") && !strokes.names.includes("write_glyphs"));
  const primitives = await names("primitives");
  assert.ok(primitives.textFree && !primitives.names.includes("strokes"));
  const code = await names("code");
  assert.ok(!code.textFree && code.names.includes("run_program"));
  for (const n of [glyphs, strokes, primitives]) assert.ok(!n.names.includes("run_program"));

  const env = await ScribeEnv.create(quiet({ actionMode: "primitives" }));
  assert.equal(env.step([{ name: "run_program", args: { code: "" } }]).results[0].status, "error");
  assert.equal(env.step([{ name: "strokes", args: { paths: [[[40, 30], [60, 30]]] } }]).results[0].status, "error");
  env.close();
});

test("the batch tools' limits are maxItems in their schemas, bounded only on outer arrays; strokes takes any number of paths", async () => {
  const env = await ScribeEnv.create(quiet({ actionMode: "glyphs" }));
  const params = (name: string) => env.tools().find((t) => t.function.name === name)!.function.parameters as Record<string, any>;
  assert.equal(params("strokes").properties.paths.maxItems, undefined);
  assert.equal(params("strokes").properties.paths.items.maxItems, undefined);
  assert.equal(params("write_glyphs").properties.ids.maxItems, 80);
  assert.equal(params("define_glyph").properties.strokes.maxItems, 8);
  assert.equal(params("define_glyph").properties.strokes.items.maxItems, undefined);
  env.close();
});

test("notes are off unless turned on, and hold numbers outside code mode", async () => {
  const on = await ScribeEnv.create(quiet({ actionMode: "code", notes: true }));
  on.step([{ name: "write_notes", args: { text: "plan" } }]);
  assert.equal(on.observe().json.notes, "plan");
  on.close();
  const nums = await ScribeEnv.create(quiet({ notes: true }));
  assert.equal(nums.step([{ name: "write_notes", args: { numbers: [5, 0.7] } }]).results[0].status, "ok");
  assert.deepEqual(nums.observe().json.notes, [5, 0.7]);
  assert.equal(nums.step([{ name: "write_notes", args: { text: "plan" } }]).results[0].status, "error");
  nums.close();

  const off = await ScribeEnv.create(quiet());
  assert.ok(!off.tools().some((t) => t.function.name === "write_notes"));
  const r = off.step([{ name: "write_notes", args: { text: "plan" } }]);
  assert.equal(r.results[0].status, "error");
  assert.ok(!("notes" in r.observation.json));
  off.close();
});

test("motion noise is smooth along a path and reproducible by seed", async () => {
  const draw = async () => {
    const env = await ScribeEnv.create(resolveConfig({ noise: { jitterMm: 0.3 }, seed: 7 }));
    env.step([{ name: "stroke", args: { points: arc(100, 100, 10, 10, 0, 360, 120) } }]);
    const png = env.world.sheet.ink.canvas.toBuffer("image/png");
    env.close();
    return png;
  };
  assert.deepEqual(await draw(), await draw());
});

test("geometry helpers", () => {
  const c = catmullRom([[0, 0], [10, 0], [10, 10]]);
  assert.deepEqual(c[0], [0, 0]);
  assert.deepEqual(c[c.length - 1], [10, 10]);
  const a = arc(0, 0, 1, 1, 0, 90, 2);
  assert.ok(Math.abs(a[2][1] - 1) < 1e-9, "90 degrees points down the page");
});

/** Plenty of pen ink on the ruled line at `y`: enough to count as a written task line. */
const ink = (y = 30) => ({ name: "strokes", args: { paths: Array.from({ length: 6 }, (_, i) => [[28, y - 5 + i], [190, y - 5 + i]]) } });
const INK_PROGRAM = "for (let i = 0; i < 6; i++) pen.stroke([[28, 25 + i], [190, 25 + i]]);";

test("the whole recording is available once, and each observation names one line to write", async () => {
  const task = "Write the word QUOKKA on the first line.\nThen stop.";
  const env = await ScribeEnv.create(quiet(), { task });
  const rec = env.taskRecording() as { line_count: number; lines: { line: number; stroke_count: number; strokes: number[][][] }[] };
  assert.ok(!JSON.stringify(rec).includes("QUOKKA"));
  assert.equal(rec.line_count, 2);
  assert.deepEqual(rec.lines.map((l) => l.line), [1, 2]);
  assert.equal(rec.lines[0].stroke_count + rec.lines[1].stroke_count, env.taskPad!.strokes.length);
  assert.ok(rec.lines[0].strokes.every((st) => st.every((p) => p.length === 2 && p.every(Number.isFinite))));

  const obs = env.observe();
  assert.deepEqual(obs.images, []);
  assert.ok(!JSON.stringify(obs.json).includes("QUOKKA"));
  type TaskLine = { line: number; of: number; turns_shown: number; stroke_range: number[]; line_stroke_count: number; target: Record<string, unknown> };
  const first = obs.json.task_line as TaskLine;
  assert.equal(first.line, 1);
  assert.equal(first.of, 2);
  assert.ok(!("strokes" in first), "the strokes are in the recording, not the observation");
  assert.deepEqual(first.stroke_range, [0, rec.lines[0].stroke_count]);
  assert.equal(first.line_stroke_count, rec.lines[0].stroke_count);
  assert.deepEqual(first.target, { baseline_y_mm: 30, x_start_mm: 28 });

  // A turn with too little ink keeps the line.
  let r = env.step([{ name: "stroke", args: { points: [[28, 30], [29, 30]] } }]);
  let tl = r.observation.json.task_line as TaskLine;
  assert.equal(tl.line, 1);
  assert.equal(tl.turns_shown, 2);

  // Enough ink moves the task on to the next line, one ruled line down; after the last line it is complete.
  r = env.step([ink(30)]);
  tl = r.observation.json.task_line as TaskLine;
  assert.equal(tl.line, 2);
  assert.equal(tl.turns_shown, 1);
  assert.equal(tl.target.baseline_y_mm, 40);

  // done() before every line is on the paper is rejected, and the episode keeps going.
  const early = env.step([{ name: "done", args: {} }]);
  assert.match(String(early.results[0].error), /not complete: line 2 of 2/);
  assert.equal(early.done, false);
  assert.equal(env.endReason, null);

  r = env.step([ink(40)]);
  assert.deepEqual(r.observation.json.task_line, { status: "complete", lines: 2 });
  assert.equal(r.done, false);
  const end = env.step([{ name: "done", args: {} }]);
  assert.equal(end.results[0].status, "ok");
  assert.equal(end.done, true);
  assert.equal(env.endReason, "done");
  env.close();

  // Without a task pad there is nothing to complete: done always works.
  const free = await ScribeEnv.create(quiet());
  assert.equal(free.step([{ name: "done", args: {} }]).done, true);
  free.close();
});

test("code mode rejects a program that carries text before it runs", async () => {
  const env = await ScribeEnv.create(quiet({ actionMode: "code" }), { task: "Write the word QUOKKA on the first line." });
  const r = env.step([{ name: "run_program", args: { code: `// QUOKKA\n${INK_PROGRAM}` } }]);
  assert.equal(r.results[0].program_status, "rejected");
  assert.doesNotMatch(String(r.results[0].error), /QUOKKA/);
  assert.equal(env.world.sheet.strokes, 0);
  assert.equal(env.step([{ name: "run_program", args: { code: INK_PROGRAM } }]).results[0].status, "ok");
  env.close();
});

test("glyph ids are arbitrary, and a sequence of ids lays the glyphs out on one baseline", () => {
  const lib = new GlyphLibrary(1, resolveConfig().glyphs);
  const bar = lib.define([[[0, 0], [0, 1]]], 0.2);
  const box = lib.define([[[0, 0], [0.6, 0], [0.6, 1], [0, 1], [0, 0]]], 0.6);
  assert.ok(bar >= 100 && bar <= 999 && box >= 100 && box <= 999 && bar !== box);
  assert.notEqual(box, bar + 1, "ids are shuffled, not handed out in order");
  assert.equal(new GlyphLibrary(1, resolveConfig().glyphs).define([[[0, 0], [0, 1]]], 0.2), bar, "and reproducible by seed");

  const { paths, endX } = lib.layout([bar, 0, box], { xStart: 30, baseline: 40, capMm: 5, gapMm: 1 });
  assert.deepEqual(paths[0], [[30, 35], [30, 40]], "a glyph's cap line is cap_mm above the baseline");
  // bar: 0.2 * 5 + 1 gap; space: 0.6 * 5; box starts at 30 + 2 + 3 = 35.
  assert.deepEqual(paths[1][0], [35, 35]);
  assert.equal(endX, 35 + 3 + 1);

  assert.equal(lib.define([[[0, 0], [0.5, 1]]], 0.5, box), box, "passing an id replaces that glyph");
  assert.throws(() => lib.layout([123456], { xStart: 0, baseline: 40, capMm: 5 }), /not in your glyph library/);
  assert.throws(() => lib.define([[[0, 0], [3, 1]]], 0.5), /outside the glyph box/);
  assert.throws(() => lib.define(Array.from({ length: 9 }, () => [[0, 0]] as [number, number][]), 0.5), /1 to 8 strokes/);
});

test("write_glyphs writes at the task line's target, and a turn may hold only one batch writing call", async () => {
  const env = await ScribeEnv.create(quiet({ actionMode: "glyphs" }), { task: "Hi there" });
  let r = env.step([{ name: "define_glyph", args: { strokes: [[[0, 0], [0, 1]], [[0, 0.5], [0.6, 0.5]], [[0.6, 0], [0.6, 1]]], width: 0.6 } }]);
  const id = r.results[0].id as number;
  assert.ok((r.observation.json.glyph_library as { id: number }[]).some((g) => g.id === id));
  r = env.step([
    { name: "write_glyphs", args: { ids: [id, 0, id] } },
    { name: "strokes", args: { paths: [[[100, 30], [110, 30]]] } },
  ]);
  assert.equal(r.results[0].status, "ok");
  assert.equal(r.results[0].strokes, 6);
  assert.equal(r.results[1].status, "error");
  assert.match(String(r.results[1].error), /only one strokes or write_glyphs call/);
  assert.ok(env.world.sheet.ink.alphaAt(28, 28) > 200, "the first glyph starts at target.x_start_mm on the first ruled line");
  assert.equal(env.world.sheet.ink.alphaAt(105, 30), 0);
  env.close();
});

test("a task line that gets no ink for three turns ends the episode, as does idling once the task is complete", async () => {
  const stalled = await ScribeEnv.create(quiet(), { task: "Hi" });
  stalled.step([{ name: "pen_up", args: {} }]);
  assert.equal(stalled.step([{ name: "look_at", args: { x: 50, y: 50 } }]).done, false);
  assert.equal(stalled.step([{ name: "pen_up", args: {} }]).done, true);
  assert.equal(stalled.endReason, "stalled");
  stalled.close();

  const complete = await ScribeEnv.create(quiet(), { task: "Hi" });
  complete.step([ink(30)]);
  complete.step([{ name: "pen_up", args: {} }]);
  complete.step([{ name: "pen_up", args: {} }]);
  assert.equal(complete.step([{ name: "pen_up", args: {} }]).done, true);
  assert.equal(complete.endReason, "complete");
  complete.close();
});

type Body = { tool_choice: string; messages: { role: string; content: unknown }[] };

/** A fake gateway client that answers request i with replies[i] (a tool name, or [name, args]). */
function fakeClient(replies: (string | [string, unknown])[], bodies: Body[], promptTokens = () => 1): GatewayClient {
  return {
    chat: async (body: Body) => {
      bodies.push(structuredClone(body));
      const reply = replies[bodies.length - 1] ?? "done";
      const [name, args] = typeof reply === "string" ? [reply, {}] : reply;
      const message = { role: "assistant", content: null, tool_calls: [{ id: `c${bodies.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
      return { id: "r", model: "fake", choices: [{ finish_reason: "tool_calls", message }], usage: { prompt_tokens: promptTokens(), completion_tokens: 1, total_tokens: 2, cost: 0 } };
    },
  } as unknown as GatewayClient;
}

test("the model gets the whole recording once, pinned in the first message, and never the task as text or an image", async () => {
  const task = "Write the word QUOKKA on the first line.";
  const env = await ScribeEnv.create(quiet({ actionMode: "glyphs" }), { task });
  const bodies: Body[] = [];
  const glyph = { strokes: [[[0, 0], [0, 1]]], width: 0.2 };
  const fake = fakeClient(["pen_up", ["define_glyph", glyph], ["strokes", ink(30).args], "pen_up", "done"], bodies);
  const r = await runArgon(env, fake, { model: "fake", keepTurns: 0, maxCostUsd: 1, maxTokens: 100 });
  assert.equal(r.stopReason, "done");
  assert.equal(bodies.length, 5);
  for (const b of bodies) {
    const s = JSON.stringify(b);
    assert.ok(!s.includes("QUOKKA"), "task text leaked into a request");
    assert.equal((s.match(/data:image\/png/g) ?? []).length, 0, "no images");
    assert.doesNotMatch(s, /pixel_to_mm|look_at/);
    assert.equal(b.tool_choice, "required", "function calls only: the reply cannot be free text");
    assert.equal((s.match(/Task pad recording/g) ?? []).length, 1, "the recording is sent once, in the first message");
    assert.match(JSON.stringify(b.messages[1]), /Task pad recording/);
  }
  // keepTurns 0 keeps every turn: the last request holds all four earlier turns.
  assert.equal(bodies[4].messages.filter((m) => m.role === "assistant").length, 4);
  // Only the latest observation carries the glyph library; older ones say how many glyphs it had.
  const last = JSON.stringify(bodies[4].messages.slice(-1));
  assert.match(last, /glyph_library\\":\[\{/);
  assert.match(JSON.stringify(bodies[4].messages.slice(2, -1)), /1 glyphs \[omitted from older observation\]/);
  env.close();
});

test("a safety-filter refusal ends the run as 'refused': no nudge, no resend, nothing drawn", async () => {
  const env = await ScribeEnv.create(quiet({ taskKind: "instruct" }), { task: "Write a joke." });
  const bodies: Body[] = [];
  const turns: { refused?: boolean; finish_reason: string | null }[] = [];
  const refusing = {
    chat: async (body: Body) => {
      bodies.push(structuredClone(body));
      const message = { role: "assistant", content: null, reasoning: "Reading the page." };
      return { id: "r", model: "anthropic/claude-opus-5.5", choices: [{ finish_reason: "content_filter", native_finish_reason: "refusal", message }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.05 } };
    },
  } as unknown as GatewayClient;
  const r = await runArgon(env, refusing, { model: "anthropic/claude-opus-5.5", keepTurns: 0, maxCostUsd: 1, maxTokens: 100, onTurn: (t) => turns.push(t) });
  assert.equal(r.stopReason, "refused");
  assert.match(r.error ?? "", /refused by the model provider's safety filter/);
  assert.equal(r.costUsd, 0.05, "the refused reply is still paid for");
  assert.equal(bodies.length, 1, "no resend after a refusal");
  assert.deepEqual(turns.map((t) => [t.refused, t.finish_reason]), [[true, "content_filter"]]);
  assert.equal(env.world.sheet.strokes, 0, "nothing in a refused reply runs");
  env.close();
});

test("with images on, only the latest observation carries the two images", async () => {
  const env = await ScribeEnv.create(quiet({ images: true }), { task: "Hi" });
  const bodies: Body[] = [];
  await runArgon(env, fakeClient([["strokes", ink(30).args], "done"], bodies), { model: "fake", keepTurns: 0, maxCostUsd: 1, maxTokens: 100 });
  for (const b of bodies) assert.equal((JSON.stringify(b).match(/data:image\/png/g) ?? []).length, 2);
  assert.match(JSON.stringify(bodies[1]), /overview image omitted from older observation/);
  env.close();
});

test("with the page image on, a turn with a strokes call is answered with a clean picture of the sheet", async () => {
  const off = await ScribeEnv.create(quiet({ taskKind: "instruct" }), { task: "Write a joke." });
  assert.deepEqual(off.step([ink(30)]).observation.images, []);
  off.close();

  const env = await ScribeEnv.create(quiet({ taskKind: "instruct", pageImage: true }), { task: "Write a joke." });
  assert.deepEqual(env.observe().images, [], "nothing written yet, no picture");
  const after = env.step([ink(30)]).observation.images;
  assert.deepEqual(after.map((i) => i.name), ["page"]);
  assert.deepEqual([after[0].png.readUInt32BE(16), after[0].png.readUInt32BE(20)], [840, 1188], "the whole A4 sheet at 4 px/mm");
  assert.deepEqual(env.step([{ name: "pen_up", args: {} }]).observation.images, [], "no strokes call, no picture");
  assert.deepEqual(env.step([{ name: "strokes", args: { paths: "nope" } }]).observation.images, [], "a failed strokes call, no picture");
  env.close();

  const run = await ScribeEnv.create(quiet({ taskKind: "instruct", pageImage: true }), { task: "Write a joke." });
  const bodies: Body[] = [];
  await runArgon(run, fakeClient([["strokes", ink(30).args], ["strokes", ink(40).args], "done"], bodies), { model: "fake", keepTurns: 0, maxCostUsd: 1, maxTokens: 100 });
  const images = bodies.map((b) => (JSON.stringify(b).match(/data:image\/png/g) ?? []).length);
  assert.deepEqual(images, [0, 1, 1], "only the latest observation after a strokes turn carries the picture");
  assert.match(JSON.stringify(bodies[2]), /page image omitted from older observation/);
  run.close();
});

test("a second task page with text goes to the model as a picture, next to the stroke recording; an empty one is ignored", async () => {
  const env = await ScribeEnv.create(quiet({ taskKind: "instruct" }), { task: "Translate the text on the second page.", imageTask: "Hello QUOKKAS." });
  const bodies: Body[] = [];
  await runArgon(env, fakeClient([["strokes", ink(30).args], "done"], bodies), { model: "fake", keepTurns: 0, maxCostUsd: 1, maxTokens: 100 });
  for (const b of bodies) {
    const first = JSON.stringify(b.messages[1]);
    assert.match(first, /Task pad recording/);
    assert.match(first, /Second page of the task \(picture\):/);
    assert.equal((first.match(/data:image\/png/g) ?? []).length, 1, "one picture of the second page, kept in every request");
    assert.ok(!JSON.stringify(b).includes("QUOKKA"), "the task is never sent as text");
    assert.match(String(b.messages[0].content), /also holds a picture of a second page/);
  }
  const png = renderPad(env.imagePad!);
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [180 * 6, Math.round(env.imagePad!.heightMm * 6)]);
  env.close();

  const blank = await ScribeEnv.create(quiet({ taskKind: "instruct" }), { task: "Write a joke.", imageTask: "  \n " });
  assert.equal(blank.imagePad, null);
  const blankBodies: Body[] = [];
  await runArgon(blank, fakeClient(["done"], blankBodies), { model: "fake", keepTurns: 0, maxCostUsd: 1, maxTokens: 100 });
  assert.doesNotMatch(JSON.stringify(blankBodies[0]), /data:image\/png|second page/);
  blank.close();
});

test("an instruct task asks for the agent's own answer, one line per turn, and ends on done or after idle turns", async () => {
  const env = await ScribeEnv.create(quiet({ taskKind: "instruct" }), { task: "Write a joke about QUOKKAS." });
  type Answer = { answer_lines_written: number; turns_without_new_line: number; last_line_ink_mm?: { y_range: number[] }; target: { baseline_y_mm: number } };
  let tl = env.observe().json.task_line as Answer;
  assert.equal(tl.answer_lines_written, 0);
  assert.equal(tl.target.baseline_y_mm, 30);
  assert.ok(!("stroke_range" in tl), "there is no pad line to copy");

  let r = env.step([ink(30)]);
  tl = r.observation.json.task_line as Answer;
  assert.equal(tl.answer_lines_written, 1);
  assert.equal(tl.target.baseline_y_mm, 40, "the next answer line goes one ruled line down");
  assert.deepEqual(tl.last_line_ink_mm!.y_range, [25, 30]);
  r = env.step([ink(40)]);
  assert.equal((r.observation.json.task_line as Answer).answer_lines_written, 2);
  assert.equal(env.narrowTaskLine(), false, "a block cannot narrow an answer line");

  for (let i = 0; i < 2; i++) assert.equal(env.step([{ name: "pen_up", args: {} }]).done, false);
  assert.equal(env.step([{ name: "pen_up", args: {} }]).done, true);
  assert.equal(env.endReason, "complete", "idle turns after an answer end the episode as complete");
  env.close();

  const blocked = await ScribeEnv.create(quiet({ taskKind: "instruct" }), { task: "Write a joke." });
  const bodies: Body[] = [];
  const fake = {
    chat: async (body: Body) => {
      bodies.push(structuredClone(body));
      if (bodies.length === 1) throw new Error('Gateway error: {"code":502,"message":"backend blocked the response: OTHER"}');
      return fakeClient(["done"], [])["chat"](body as never);
    },
  } as unknown as GatewayClient;
  await runArgon(blocked, fake, { model: "fake", keepTurns: 0, maxCostUsd: 1, maxTokens: 100, blockPauseMs: 0 });
  assert.match(String(bodies[1].messages.at(-1)!.content), /not delivered.*Reply again\./);
  assert.match(JSON.stringify(bodies[0].messages[1]), /where the first line of your answer goes/);
  blocked.close();
});

test("reasoning effort is low unless set", async () => {
  for (const [effort, expected] of [[undefined, "low"], ["high", "high"]] as const) {
    const env = await ScribeEnv.create(quiet({ taskKind: "instruct" }), { task: "Write a joke." });
    const bodies: (Body & { reasoning?: { effort: string } })[] = [];
    await runArgon(env, fakeClient(["done"], bodies), { model: "fake", reasoningEffort: effort, keepTurns: 0, maxCostUsd: 1, maxTokens: 100 });
    assert.equal(bodies[0].reasoning?.effort, expected);
    env.close();
  }
});

test("code mode lets the model answer in text; keepTurns drops old turns but never the recording", async () => {
  const env = await ScribeEnv.create(quiet({ actionMode: "code", lineFeed: { stallTurns: 0 } }), { task: "Hi" });
  const bodies: Body[] = [];
  await runArgon(env, fakeClient(["pen_up", "pen_up", "pen_up", ["run_program", { code: INK_PROGRAM }]], bodies), { model: "fake", keepTurns: 1, maxCostUsd: 1, maxTokens: 100 });
  assert.equal(bodies[0].tool_choice, "auto");
  const s = JSON.stringify(bodies[3].messages[1]);
  assert.match(s, /Task pad recording/);
  assert.match(s, /2 earlier turns were dropped from this conversation/);
  env.close();
});

test("history is trimmed only when the prompt passes the token budget, oldest quarter first, keeping the recording", async () => {
  // No ink ever arrives, so stalling is off to keep the run going.
  const env = await ScribeEnv.create(quiet({ lineFeed: { stallTurns: 0 } }), { task: "Hi" });
  const bodies: Body[] = [];
  const tokens = [100, 100, 100, 100, 100, 900, 100, 100, 100, 100];
  const fake = fakeClient([...Array(8).fill("pen_up"), ["strokes", ink(30).args]], bodies, () => tokens[bodies.length - 1]);
  await runArgon(env, fake, { model: "fake", keepTurns: 0, maxContextTokens: 500, maxCostUsd: 1, maxTokens: 100 });
  const assistants = bodies.map((b) => b.messages.filter((m) => m.role === "assistant").length);
  // Request 6 came back at 900 tokens with 5 turns in history: the oldest quarter (2 turns) is dropped from then on,
  // and later turns keep appending after them. Request 9 writes the task's one line; the default reply then ends the run.
  assert.deepEqual(assistants, [0, 1, 2, 3, 4, 5, 4, 5, 6, 7]);
  assert.match(JSON.stringify(bodies[6].messages[1]), /Task pad recording[\s\S]*2 earlier turns were dropped/);
  env.close();
});

test("a reply the provider blocks is asked for again with a smaller part of the task line", async () => {
  const env = await ScribeEnv.create(quiet(), { task: "Hello there, this is a longer line of text to write." });
  const bodies: { messages: { role: string; content: unknown }[] }[] = [];
  const blocked = 'Gateway error: {"code":502,"message":"backend blocked the response: OTHER"}';
  const fake = {
    chat: async (body: (typeof bodies)[number]) => {
      bodies.push(body);
      if (bodies.length <= 2) throw new Error(blocked);
      // Write the line task_line names; once every line is on the paper, done.
      const tl = env.taskLine() as { status?: string; target?: { baseline_y_mm: number } } | null;
      const call = tl && tl.status === "complete"
        ? { name: "done", arguments: "{}" }
        : { name: "strokes", arguments: JSON.stringify(ink(tl!.target!.baseline_y_mm).args) };
      const message = { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: call }] };
      return { id: "r", model: "fake", choices: [{ finish_reason: "tool_calls", message }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0 } };
    },
  } as unknown as GatewayClient;
  const failed: number[] = [];
  const r = await runArgon(env, fake, { model: "fake", keepTurns: 8, maxCostUsd: 1, maxTokens: 100, blockPauseMs: 0, onResponse: (i, res) => void (res ?? failed.push(i)) });
  assert.equal(r.stopReason, "done");
  assert.deepEqual(failed, [1, 2]);
  const last = (b: (typeof bodies)[number]) => b.messages[b.messages.length - 1];
  const strokes = (b: (typeof bodies)[number]) => Number(JSON.stringify(b.messages[1]).match(/stroke_range\\":\[0,(\d+)\]/)![1]);
  const [n0, n1, n2] = bodies.map(strokes);
  assert.ok(n1 <= n0 / 2 && n1 >= 8, `the resend shows half the line (${n0} -> ${n1})`);
  assert.ok(n2 < n1, `and the next resend less again (${n1} -> ${n2})`);
  assert.doesNotMatch(JSON.stringify(last(bodies[0])), /was blocked/);
  assert.match(String(last(bodies[1]).content), /was not delivered by the model provider/);
  assert.match(String(last(bodies[2]).content), /was not delivered by the model provider/);
  assert.equal(bodies[1].messages.length, bodies[0].messages.length + 1, "the note is added, not kept in history");
  env.close();
});

test("passthrough bare 403 SAFETY block also halves the task line before the resend", async () => {
  const env = await ScribeEnv.create(quiet(), { task: "Hello there, this is a longer line of text to write." });
  const ranges: number[] = [];
  const fake = {
    chat: async () => {
      ranges.push((env.taskLine() as { stroke_range: number[] }).stroke_range[1]);
      throw new Error('Gateway error: {"code":403,"message":"SAFETY","metadata":{"error_type":"content_policy_violation","provider_code":"SAFETY"}}');
    },
  } as unknown as GatewayClient;
  const r = await runArgon(env, fake, { model: "fake", keepTurns: 8, maxCostUsd: 1, maxTokens: 100, blockPauseMs: 0 });
  assert.equal(r.stopReason, "error");
  assert.equal(ranges.length, 13, "the first send and 12 resends");
  assert.ok(ranges[1] <= ranges[0] / 2 && ranges[2] < ranges[1], `each resend shows less of the line: ${ranges.join(" -> ")}`);
  env.close();
});

test("a run stops after the provider blocks the same step too many times", async () => {
  const env = await ScribeEnv.create(quiet(), { task: "Hi" });
  let calls = 0;
  const fake = {
    chat: async () => {
      calls++;
      throw new Error('Gateway error: {"code":403,"message":"backend blocked the request: SAFETY"}');
    },
  } as unknown as GatewayClient;
  const r = await runArgon(env, fake, { model: "fake", keepTurns: 8, maxCostUsd: 1, maxTokens: 100, blockPauseMs: 0 });
  assert.equal(r.stopReason, "error");
  assert.equal(calls, 13, "the first send and 12 resends");
  env.close();
});

test("eraser:false removes the eraser from the tool set and rejects set_tool eraser", async () => {
  const env = await ScribeEnv.create(quiet({ eraser: false }));
  assert.ok(!env.tools().some((t) => t.function.name === "set_tool" && JSON.stringify(t.function.parameters).includes("eraser")), "the schema carries no eraser option");
  const r = env.step([{ name: "set_tool", args: { tool: "eraser" } }]);
  assert.match(String(r.results[0].error), /eraser is not available/);
  assert.equal(env.step([{ name: "set_tool", args: { tool: "pen" } }]).results[0].status, "ok");
  env.close();

  const def = await ScribeEnv.create(quiet());
  assert.ok(def.tools().some((t) => t.function.name === "set_tool" && JSON.stringify(t.function.parameters).includes("eraser")), "default keeps the eraser");
  def.close();
});

test("a slide deck file splits into pages at lines of only ---", () => {
  assert.deepEqual(splitPages("Page one\nstill one\n---\n\nPage two\n---  \n---\nPage three\n"), ["Page one\nstill one", "Page two", "Page three"]);
  assert.deepEqual(splitPages("no separator -- here"), ["no separator -- here"]);
});

test("slides: done on a page before the last waits for the page turn, and the next page is fed from its first line", async () => {
  const env = await ScribeEnv.create(quiet(), { pages: ["Hi", "Yo there"] });
  assert.deepEqual(env.observe().json.page, { page: 1, pages: 2 });
  const first = JSON.stringify(env.taskRecording());
  env.step([ink(30)]);
  const done1 = env.step([{ name: "done", args: {} }]);
  assert.equal(done1.results[0].waiting, "page turn");
  assert.equal(done1.done, false);
  assert.equal(env.waitingForPage, true);
  assert.deepEqual(done1.observation.json.page, { page: 1, pages: 2, waiting_for_page_turn: true });

  const events: string[] = [];
  env.onEvent((e) => events.push(e.t));
  assert.equal(env.turnPage(), true);
  assert.deepEqual(events, ["page"]);
  assert.equal(env.waitingForPage, false);
  assert.notEqual(JSON.stringify(env.taskRecording()), first);
  assert.equal(env.taskLine()?.line, 1);
  assert.equal(env.step([{ name: "done", args: {} }]).results[0].status, "error", "page 2 is not on the paper yet");
  env.step([ink(40)]);
  assert.equal(env.step([{ name: "done", args: {} }]).done, true, "done on the last page ends the episode");
  assert.equal(env.turnPage(), false);
  env.close();
});

test("slides: idling after a finished page waits for the turn instead of ending the episode", async () => {
  const env = await ScribeEnv.create(quiet(), { pages: ["Hi", "Yo"] });
  env.step([ink(30)]);
  for (let i = 0; i < 4; i++) env.step([{ name: "pen_up", args: {} }]);
  assert.equal(env.finished, false);
  assert.equal(env.waitingForPage, true);
  env.close();
});

test("slides: the argon loop waits for the operator, then sends each page's recording exactly once", async () => {
  for (const keepTurns of [0, 1]) {
    const env = await ScribeEnv.create(quiet({ taskKind: "instruct" }), { pages: ["Write a joke.", "Write a poem."] });
    const bodies: Body[] = [];
    let queued = 0;
    let waits = 0;
    const pageTurns = { take: () => (queued > 0 ? (queued--, true) : false), wait: async () => void (waits++, queued++) };
    const replies: [string, unknown][] = [["strokes", ink(30).args], ["done", {}], ["strokes", ink(40).args], ["done", {}]];
    const r = await runArgon(env, fakeClient(replies, bodies), { model: "fake", keepTurns, maxCostUsd: 1, maxTokens: 100, pageTurns });
    assert.equal(r.stopReason, "done");
    assert.equal(waits, 1, "one wait, after done on page 1");
    assert.equal(bodies.length, 4, "no requests while waiting");
    assert.equal(env.page, 1);
    for (const [i, b] of bodies.entries()) {
      const s = JSON.stringify(b);
      assert.equal((s.match(/Task pad recording/g) ?? []).length, 1, "page 1 once, pinned");
      assert.equal((s.match(/The page was turned: page 2 of 2/g) ?? []).length, i >= 2 ? 1 : 0, `page 2 once from request 3 on (keepTurns ${keepTurns})`);
    }
    assert.match(JSON.stringify(bodies[0].messages[0]), /slide deck of 2 pages/);
    env.close();
  }
});

test("slides: --turn-on-done turns each page only once the model has called done on it", async () => {
  const env = await ScribeEnv.create(quiet({ taskKind: "instruct" }), { pages: ["Read this.", "Read this too.", "Write a poem."] });
  const bodies: Body[] = [];
  // page 1: a turn of thinking, then done; page 2: done at once; page 3: write, then done
  const replies: [string, unknown][] = [["pen_up", {}], ["done", {}], ["done", {}], ["strokes", ink(40).args], ["done", {}]];
  const r = await runArgon(env, fakeClient(replies, bodies), { model: "fake", keepTurns: 0, maxCostUsd: 1, maxTokens: 100, pageTurns: turnOnDone(env) });
  assert.equal(r.stopReason, "done");
  assert.equal(bodies.length, 5);
  assert.equal(env.page, 2);
  for (const [i, b] of bodies.entries()) {
    const s = JSON.stringify(b);
    assert.equal((s.match(/The page was turned: page 2 of 3/g) ?? []).length, i >= 2 ? 1 : 0, `page 2 from request 3 on, after done on page 1 (request ${i + 1})`);
    assert.equal((s.match(/The page was turned: page 3 of 3/g) ?? []).length, i >= 3 ? 1 : 0, `page 3 from request 4 on, after done on page 2 (request ${i + 1})`);
  }
  env.close();
});

test("slides: without an operator, done on a page before the last stops the run", async () => {
  const env = await ScribeEnv.create(quiet({ taskKind: "instruct" }), { pages: ["Write a joke.", "Write a poem."] });
  const bodies: Body[] = [];
  const r = await runArgon(env, fakeClient([["strokes", ink(30).args], "done"], bodies), { model: "fake", keepTurns: 0, maxCostUsd: 1, maxTokens: 100 });
  assert.equal(r.stopReason, "done");
  assert.equal(bodies.length, 2);
  env.close();
});

test("with page strokes on, a turn with a strokes call is answered with the sheet's ink as a pad-style recording", async () => {
  const off = await ScribeEnv.create(quiet({ taskKind: "instruct" }), { task: "Write a joke." });
  assert.equal("page_strokes" in off.step([ink(30)]).observation.json, false);
  off.close();

  const env = await ScribeEnv.create(quiet({ taskKind: "instruct", pageStrokes: true }), { task: "Write a joke." });
  assert.equal("page_strokes" in env.observe().json, false, "nothing written yet");
  const r = env.step([{ name: "strokes", args: { paths: [[[30, 27], [40, 27]], [[50, 36], [60, 36]]] } }]);
  const rec = r.observation.json.page_strokes as { frame: string; size_mm: number[]; line_count: number; lines: { line: number; baseline_y_mm: number; stroke_count: number; strokes: number[][][] }[] };
  assert.deepEqual(rec.size_mm, [210, 297]);
  assert.equal(rec.line_count, 2, "grouped by the ruled line each stroke sits on");
  assert.deepEqual(rec.lines.map((l) => l.baseline_y_mm), [30, 40]);
  assert.deepEqual(rec.lines[0].strokes, [[[30, 27], [40, 27]]]);
  assert.deepEqual(rec.lines[1].strokes, [[[50, 36], [60, 36]]]);
  assert.equal("page_strokes" in env.step([{ name: "done", args: {} }]).observation.json, false, "only after a turn that wrote");
  env.close();
});

test("only the latest observation carries the page strokes; older ones keep a count", async () => {
  const env = await ScribeEnv.create(quiet({ taskKind: "instruct", pageStrokes: true }), { task: "Hi" });
  const bodies: Body[] = [];
  await runArgon(env, fakeClient([["strokes", ink(30).args], ["strokes", ink(40).args], "done"], bodies), { model: "fake", keepTurns: 0, maxCostUsd: 1, maxTokens: 100 });
  const last = JSON.stringify(bodies[bodies.length - 1]);
  assert.match(last, /6 strokes \[omitted from older observation\]/);
  assert.equal((last.match(/\\"page_strokes\\":\{/g) ?? []).length, 1, "one full recording, the latest");
  env.close();
});

test("an instruct turn may write several lines: the next target goes below the lowest line it inked", async () => {
  const env = await ScribeEnv.create(quiet({ taskKind: "instruct" }), { task: "Write a poem." });
  const line = (y: number) => ({ name: "stroke", args: { points: [[30, y], [90, y]] } });
  const r = env.step([line(30), line(40), line(50)]);
  const tl = r.observation.json.task_line as { answer_lines_written: number; target: { baseline_y_mm: number } };
  assert.equal(tl.answer_lines_written, 3);
  assert.equal(tl.target.baseline_y_mm, 60, "the next line goes below the three just written");
  const one = env.step([line(60)]);
  assert.equal((one.observation.json.task_line as { target: { baseline_y_mm: number } }).target.baseline_y_mm, 70);
  env.close();
});
