import assert from "node:assert/strict";
import { test } from "node:test";
import { textFreeTools, toolSchemas } from "../src/actions.ts";
import { runScripted } from "../src/agents/scripted.ts";
import { resolveConfig } from "../src/config.ts";
import { ScribeEnv } from "../src/env.ts";
import type { Vec2 } from "../src/geometry.ts";
import { CAM_MM, inputDecimals, penFor, thin, tracePoints, zig } from "../src/pen.ts";
import { systemPrompt } from "../src/prompt.ts";
import { World } from "../src/world.ts";

const quiet = { noise: { jitterMm: 0, correlationMm: 3, driftMmPerM: 0 } };
const far = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const memory = { keepTurns: 0, maxContextTokens: 500000 };
const TEXT = "write down the magic word";
const pen = (level: number | null) => ({ pen: { level } });
const toSegment = (q: Vec2, a: Vec2, b: Vec2) => {
  const len2 = far(a, b) ** 2;
  const t = len2 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * (b[0] - a[0]) + (q[1] - a[1]) * (b[1] - a[1])) / len2)) : 0;
  return far(q, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
};
const toPath = (q: Vec2, path: Vec2[]) => (path.length === 1 ? far(q, path[0]) : Math.min(...path.slice(1).map((b, k) => toSegment(q, path[k], b))));

test("without the pen dial the robot is the plain one: nothing it is sent or offered mentions pen inputs", async () => {
  assert.equal(resolveConfig().pen.level, null);
  const cfg = resolveConfig({ taskKind: "instruct" });
  for (const text of [systemPrompt(cfg, memory), JSON.stringify(toolSchemas(cfg))]) assert.doesNotMatch(text, /pen inputs|machinery|\[u, v\]/);
  const env = await ScribeEnv.create(resolveConfig({ ...quiet }), { task: TEXT });
  const rec = env.taskRecording() as { frame: string; lines: { strokes: number[][][] }[] };
  assert.doesNotMatch(rec.frame, /inputs/);
  assert.deepEqual(rec.lines[0].strokes, env.taskPad!.strokes.slice(env.taskPad!.lines[0].from, env.taskPad!.lines[0].to), "the recording is the pad's ink");
  assert.ok(!("pen_inputs" in env.observe().json));
  assert.throws(() => resolveConfig({ pen: { padLevel: 0 } }), /needs pen.level/);
});

test("the pen is a function from two inputs to the tip: N cams deep, exactly undone, no randomness, any whole number", () => {
  assert.deepEqual(penFor(0).tip([30, 24]), [30, 24], "pen 0 passes its inputs straight through");
  assert.deepEqual(penFor(0).inputs([30, 24]), [30, 24]);
  // the zigzag: up to +2, down to -2 and back, every 16 mm, in straight stretches
  assert.deepEqual([0, 2, 4, 8, 12, 14, 16, 22, -2].map(zig), [0, 1, CAM_MM, 0, -CAM_MM, -1, 0, 1, -1]);
  // pen 1: one cam shifts the tip along x by the zigzag of its y, and leaves y alone
  assert.deepEqual(penFor(1).tip([30, 4]), [32, 4]);
  // pen 2: a second cam then shifts it along y by the zigzag of its new x
  assert.deepEqual(penFor(2).tip([10, 6]), [11, 4.5]);
  assert.deepEqual(penFor(2).inputs([11, 4.5]), [10, 6]);
  let last = 0;
  for (const n of [1, 2, 5, 8, 20, 64]) {
    const p = penFor(n);
    let moved = 0;
    for (const tip of [[30, 24], [9, 8], [187.3, 251.9], [0, 0], [104.2, 77.7]] as Vec2[]) {
      const inputs = p.inputs(tip);
      assert.equal(inputs.length, 2, "always two inputs");
      assert.ok(far(p.tip(inputs), tip) < 1e-9, `pen ${n}: the inputs for ${tip} put the tip at ${p.tip(inputs)}`);
      assert.ok(far(p.inputs(p.tip(tip)), tip) < 1e-9, "and the other way round");
      assert.deepEqual(p.tip(inputs), p.tip(inputs));
      moved += far(inputs, tip);
    }
    assert.ok(moved > last, `pen ${n}: deeper pens put their inputs further from the ink`);
    last = moved;
  }
  assert.throws(() => penFor(1.5), /whole number/);
  assert.throws(() => resolveConfig({ pen: { level: -1 } }), /whole number/);
  assert.throws(() => resolveConfig({ pen: { level: 2 }, actionMode: "glyphs" }), /strokes or primitives/);
});

test("the agent's side is the same at every pen level: the same prompt and tools, which never say how the pen works", () => {
  const prompts = [0, 1, 4, 16].map((n) => systemPrompt(resolveConfig({ ...pen(n), pageStrokes: true }), memory));
  const tools = [0, 1, 4, 16].map((n) => JSON.stringify(toolSchemas(resolveConfig(pen(n)))));
  for (const p of prompts) assert.equal(p, prompts[0]);
  for (const t of tools) assert.equal(t, tools[0]);
  assert.match(prompts[0], /complex piece of machinery/);
  assert.match(prompts[0], /pair of pen inputs \[u, v\], not a position on the paper/);
  assert.match(prompts[0], /zig\(t\): let r be t mod 16/, "the one rule every cam follows");
  assert.match(prompts[0], /How many cams the pen has is not told/);
  assert.doesNotMatch(prompts[0], /smooth/);
  // a pad recorded by the plain pen: the prompt says its recording is positions, in the same words at every pen level
  const plain = [1, 4, 16].map((n) => systemPrompt(resolveConfig({ pen: { level: n, padLevel: 0 }, pageStrokes: true }), memory));
  for (const p of plain) assert.equal(p, plain[0]);
  assert.match(plain[0], /The pad was not written with your pen\. Its recording is plain positions/);
  assert.doesNotMatch(plain[0], /every point of the pad's recording, is a pair of pen inputs/);
  const schemas = toolSchemas(resolveConfig(pen(4)));
  assert.ok(textFreeTools(schemas), "no tool argument can carry text");
  assert.deepEqual(schemas.map((t) => t.function.name), ["stroke", "move_to", "move_by", "pen_down", "pen_up", "set_tool", "strokes", "done"]);
});

test("input goes through the pen: the recording is the pen's inputs, the same size at every level, and it replays as the pad's ink", async () => {
  const sizes: number[] = [];
  for (const level of [0, 1, 4, 8, 16]) {
    const env = await ScribeEnv.create(resolveConfig({ ...quiet, ...pen(level), pageStrokes: true }), { task: TEXT });
    const pad = env.taskPad!;
    const p = env.world.pen;
    const rec = env.taskRecording() as { frame: string; lines: { stroke_count: number; strokes: number[][][] }[] };
    assert.match(rec.frame, /pen inputs \[u, v\]/);
    const strokes = rec.lines.flatMap((l) => l.strokes);
    assert.equal(strokes.length, pad.strokes.length, "the same strokes");
    strokes.forEach((st, i) => {
      assert.equal(st.length, pad.strokes[i].length, "the same points per stroke");
      st.forEach((c, j) => {
        assert.equal(c.length, 2, "two numbers a point");
        assert.ok(far(p.tip(c), pad.strokes[i][j]) < 0.11, `pen ${level}: the inputs as written put the tip ${far(p.tip(c), pad.strokes[i][j])} mm from the pad's ink`);
      });
      // The recording holds the pad's own points and no more. Between two of them a cam pen bends the line, so the
      // ink is only promised at the points.
    });
    if (level > 0) assert.notDeepEqual(strokes, pad.strokes, "the inputs are not the ink");
    else assert.deepEqual(strokes, pad.strokes, "pen 0's inputs are the ink");
    sizes.push(JSON.stringify(rec).length);
    // the pad's pen can be set apart from the robot's
    const plainPad = await ScribeEnv.create(resolveConfig({ ...quiet, pen: { level, padLevel: 0 } }), { task: TEXT });
    assert.deepEqual((plainPad.taskRecording() as typeof rec).lines.flatMap((l) => l.strokes), pad.strokes);
    assert.doesNotMatch((plainPad.taskRecording() as typeof rec).frame, /inputs/, "and its frame says positions");
  }
  assert.ok(Math.max(...sizes) < 1.6 * Math.min(...sizes), `the recording is about the same size at every level: ${sizes}`);
  assert.deepEqual([0, 3, 4, 12, 13].map(inputDecimals), [1, 1, 2, 2, 3]);
});

test("output goes through the pen: ink lands where the tip goes, and sending the right inputs writes the plain pen's stroke", async () => {
  const corners: Vec2[] = [[60, 80], [70, 80], [70, 90], [60, 95]];
  // a point every twentieth of a millimetre: between two points a pen with cams bends the line, by less the closer they are
  const path: Vec2[] = corners.slice(1).flatMap((b, k) => Array.from({ length: 120 }, (_, i): Vec2 => [corners[k][0] + ((b[0] - corners[k][0]) * (i + 1)) / 120, corners[k][1] + ((b[1] - corners[k][1]) * (i + 1)) / 120]));
  path.unshift(corners[0]);
  for (const level of [0, 2, 4]) {
    const world = new World(resolveConfig({ ...quiet, ...pen(level) }));
    assert.ok(world.penWorld);
    const p = world.pen;
    // the inputs taken for positions: with any cam in the way the ink lands somewhere else
    const naive = new World(resolveConfig({ ...quiet, ...pen(level) }));
    naive.strokePoints(path);
    const off = Math.max(...naive.sheet.paths.flat().map((q) => toPath(q, path)));
    if (level) assert.ok(off > 1, `pen ${level}: positions sent as inputs land ${off} mm off`);
    else assert.ok(off < 1e-9);
    // the right inputs: the plain pen's ink
    const r = world.strokePoints(path.map((q) => p.inputs(q)));
    assert.equal(r.status, "ok");
    for (const q of world.sheet.paths.flat()) assert.ok(toPath(q, corners) < 0.1, `pen ${level}: the ink left the stroke`);
    assert.ok(Math.abs(r.path_mm - 31.2) < 0.2);
    assert.ok(far([world.cmd[0], world.cmd[1]], [60, 95]) < 1e-9, "tip_mm is where the tip is");
    assert.deepEqual(world.point, p.inputs([60, 95]), "the last inputs are kept");
    // move_to with the pen down inks along the tip's path; move_by adds to the last inputs
    world.movePoint(p.inputs([60, 100]), 0);
    assert.ok(far([world.cmd[0], world.cmd[1]], [60, 100]) < 1e-9);
    const before = [...world.point];
    world.movePointBy([2, -1], 0);
    assert.deepEqual(world.point, [before[0] + 2, before[1] - 1]);
    assert.ok(far([world.cmd[0], world.cmd[1]], p.tip(world.point)) < 1e-9);
    assert.throws(() => world.strokePoints([[60, 80, 1]]), /pair of pen inputs/);
  }
  // through the environment: pen_inputs and tip_mm in the observation, page_strokes in page mm, bad points refused
  const env = await ScribeEnv.create(resolveConfig({ ...quiet, ...pen(5), pageStrokes: true }), { task: TEXT });
  const p = env.world.pen;
  env.step([{ name: "strokes", args: { paths: [path.map((q) => p.inputs(q))] } }]);
  const obs = env.observe().json as { pen_inputs: number[]; tip_mm: number[]; page_strokes: { lines: { strokes: Vec2[][] }[] } };
  assert.ok(far(obs.pen_inputs, p.inputs([60, 95])) < 0.01);
  assert.ok(far(obs.tip_mm, [60, 95]) < 0.01);
  const landed = obs.page_strokes.lines.flatMap((l) => l.strokes);
  assert.equal(landed.length, 1);
  assert.ok(far(landed[0][0], [60, 80]) < 0.11 && far(landed[0][landed[0].length - 1], [60, 95]) < 0.11, "page_strokes is where the ink is");
  assert.ok(landed[0].length <= 12, "and a straight stretch of ink comes back as few points");
  // every movement's result says where the tip ended up, so several probes fit in one turn
  const probes = env.step([{ name: "move_to", args: { point: [40, 50] } }, { name: "move_by", args: { delta: [10, 0] } }]).results as { status: string; tip_mm: number[] }[];
  assert.ok(far(probes[0].tip_mm, p.tip([40, 50])) < 0.01 && far(probes[1].tip_mm, p.tip([50, 50])) < 0.01);
  const bad = env.step([{ name: "stroke", args: { points: [[30, 30, 0]] } }]).results[0] as { status: string; error: string };
  assert.equal(bad.status, "error");
  assert.match(bad.error, /pair of pen inputs \[u, v\]/);
});

test("the scripted writer writes through whichever pen is set, and leaves the plain robot's ink", async () => {
  const ink = async (level: number | null) => {
    const env = await ScribeEnv.create(resolveConfig({ ...quiet, taskKind: "copy", lineFeed: { stallTurns: 0 }, ...pen(level) }), { task: "hello pen" });
    runScripted(env, "hello pen");
    return env.world.sheet.paths;
  };
  const [plain, straight, deep] = [await ink(null), await ink(0), await ink(6)];
  assert.ok(plain.length > 10);
  assert.deepEqual(straight.map((p) => thin(p)), plain.map((p) => thin(p)), "pen 0 is the plain robot's ink exactly");
  assert.equal(deep.length, plain.length);
  deep.forEach((st, i) => {
    for (const q of st) assert.ok(toPath(q, plain[i]) < 0.2, "pen 6 leaves the plain robot's ink");
    assert.ok(far(st[0], plain[i][0]) < 1e-9 && far(st[st.length - 1], plain[i][plain[i].length - 1]) < 1e-9, "and exactly at the points it was sent");
  });
});

test("unwind: undoing every cam, last to first, gives the inputs; the tool exists only with the option; one call undoes one cam for a list of points", async () => {
  const { undoCam } = await import("../src/pen.ts");
  for (const level of [0, 1, 2, 5, 8]) {
    const pen = penFor(level);
    for (const p of [[40, 30], [101.3, 77.7], [15, 15]] as Vec2[]) {
      let q: Vec2 = p;
      for (let k = level; k >= 1; k--) q = undoCam(q, k);
      assert.deepEqual(q, pen.inputs(p));
    }
  }
  const names = (unwind: boolean) => toolSchemas(resolveConfig({ actionMode: "strokes", pen: { level: 4, unwind } as never })).map((t) => t.function.name);
  assert.ok(names(true).includes("unwind"));
  assert.ok(!names(false).includes("unwind"));
  assert.ok(textFreeTools(toolSchemas(resolveConfig({ actionMode: "strokes", pen: { level: 4, unwind: true } as never }))));
  // the system prompt is the same with and without the tool
  const prompt = (unwind: boolean) => systemPrompt(resolveConfig({ actionMode: "strokes", pen: { level: 4, unwind } as never }), { keepTurns: 0, maxContextTokens: 500_000 });
  assert.equal(prompt(true), prompt(false));
  const env = await ScribeEnv.create(resolveConfig({ actionMode: "strokes", taskKind: "instruct", noise: { jitterMm: 0 } as never, pen: { level: 2, unwind: true } as never }), { task: "Hi" });
  const target: Vec2 = [60, 50];
  const other: Vec2 = [61.5, 50.25];
  const r = env.step([{ name: "unwind", args: { points: [target, other], cam: 2 } }, { name: "unwind", args: { points: [[0, 0]], cam: 3 } }]);
  const first = r.results[0] as { status: string; points: number[][] };
  assert.equal(first.status, "ok");
  assert.deepEqual(first.points, [target, other].map((p) => undoCam(p, 2).map((v: number) => Math.round(v * 1000) / 1000)));
  assert.match(String((r.results[1] as { error?: string }).error), /no cam 3/);
  env.close();
});
