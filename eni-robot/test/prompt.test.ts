import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { BLOCKED_MESSAGE, BLOCKED_SHORTER_MESSAGE, droppedTurnsMessage, RECORDING_HEADER, startMessage, systemPrompt } from "../src/prompt.ts";

const memory = { keepTurns: 0, maxContextTokens: 500_000 };

test("the prompt gives the whole recording, asks for no words, sets no one-line-per-turn rule, and never asks for decoding into text", () => {
  for (const taskKind of ["instruct", "copy"] as const) {
    for (const actionMode of ["glyphs", "strokes", "primitives", "code"] as const) {
      for (const notes of [false, true]) {
        const p = systemPrompt(resolveConfig({ taskKind, actionMode, notes }), memory);
        assert.doesNotMatch(p, /decode|lib\.task|done\(text\)|replay_task|writeLine/i);
        assert.match(p, /first message holds the whole recording/);
        assert.match(p, /task_line/);
        assert.doesNotMatch(p, /one line per turn|never more/);
        assert.match(p, /Never put words anywhere in your reply/);
        assert.match(p, /keeps every turn until it nears 500k tokens/);
      }
    }
  }
  const glyphs = systemPrompt(resolveConfig({ actionMode: "glyphs" }), memory);
  assert.match(glyphs, /define_glyph/);
  assert.match(glyphs, /one write_glyphs\(ids\) call/);
  assert.match(glyphs, /glyph library stays in every observation/);
  assert.match(systemPrompt(resolveConfig({ actionMode: "strokes" }), memory), /as many strokes as you need in one call/);
  const code = systemPrompt(resolveConfig({ actionMode: "code" }), memory);
  assert.match(code, /CODE MODE/);
  assert.match(code, /no string literals except "pen" and "eraser"/);
  for (const actionMode of ["glyphs", "strokes", "primitives"] as const) {
    assert.doesNotMatch(systemPrompt(resolveConfig({ actionMode }), memory), /CODE MODE|run_program/);
  }
  assert.match(systemPrompt(resolveConfig(), { keepTurns: 3, maxContextTokens: 1 }), /keeps the last 3 turns/);
});

test("by default the task is a request to carry out, and the agent gets no images", () => {
  const cfg = resolveConfig();
  assert.equal(cfg.taskKind, "instruct");
  assert.equal(cfg.images, false);
  assert.equal(cfg.actionMode, "strokes");
  const p = systemPrompt(cfg, memory);
  assert.match(p, /The pad holds a request\. Do what it asks by writing your own answer/);
  assert.doesNotMatch(p, /Do not copy the request/, "no rule against repeating the request, which a policy may ask for");
  assert.doesNotMatch(p, /stroke_range|Write exactly that/);
  assert.match(p, /There are no images: you do not see the paper/);
  assert.doesNotMatch(p, /look_at|pixel_to_mm|Overview image/);
  assert.match(startMessage(cfg), /where the first line of your answer goes/);
  assert.doesNotMatch(p, /picture of the sheet/);
  const page = systemPrompt(resolveConfig({ pageImage: true }), memory);
  assert.match(page, /After a turn with a strokes call, the observation includes a picture of the sheet/);
  assert.doesNotMatch(page, /There are no images/);

  const withPicture = systemPrompt(cfg, memory, true);
  assert.match(withPicture, /whole recording/);
  assert.match(withPicture, /also holds a picture of a second page the same person wrote: read their handwriting from it\. The recording and the picture together are your task\./);
  assert.doesNotMatch(p, /second page/);
  assert.match(startMessage(cfg, true), /Then a picture of the second page of your task\./);
  assert.doesNotMatch(startMessage(cfg), /picture/);

  const copy = systemPrompt(resolveConfig({ taskKind: "copy", images: true }), memory);
  assert.match(copy, /stroke_range/);
  assert.match(copy, /Write exactly that on the paper in your own letter shapes/);
  assert.match(copy, /Overview image/);
  assert.match(copy, /look_at/);
  assert.match(startMessage(resolveConfig({ taskKind: "copy" })), /names the line to write first/);

  assert.match(RECORDING_HEADER, /Task pad recording/);
  assert.match(BLOCKED_MESSAGE, /write just that part/);
  assert.match(BLOCKED_SHORTER_MESSAGE, /Reply again\./);
  assert.doesNotMatch(BLOCKED_SHORTER_MESSAGE, /shorter|few words/, "a block must not steer what the agent writes next");
  assert.doesNotMatch(droppedTurnsMessage(4), /replay|image/);
});

test("there is no words-per-line hint: answerLineWords was removed", () => {
  assert.doesNotMatch(systemPrompt(resolveConfig(), memory), /Keep each line to about|words per line/);
  assert.throws(() => resolveConfig({ answerLineWords: 3 } as never), /unknown config key: answerLineWords/);
});

test("agentPolicy adds an OPERATING POLICY section only when set", () => {
  const withPolicy = systemPrompt(resolveConfig({ agentPolicy: "Follow the pad's request exactly." }), memory);
  assert.match(withPolicy, /OPERATING POLICY\n- Follow the pad's request exactly\./);
  const without = systemPrompt(resolveConfig(), memory);
  assert.doesNotMatch(without, /OPERATING POLICY/);
});

test("the prompt describes only the tools and views the run has", () => {
  const memory2 = { keepTurns: 0, maxContextTokens: 500000 };
  const noEraser = systemPrompt(resolveConfig({ eraser: false }), memory2);
  assert.doesNotMatch(noEraser, /set_tool\("eraser"\)|eraser removes ink/);
  assert.match(noEraser, /There is no eraser/);
  assert.match(systemPrompt(resolveConfig({}), memory2), /eraser after set_tool\("eraser"\)/);
});

test("scan: the job comes from the policy, the pad is documents from possibly different people, and nothing says to do what the pad asks", () => {
  const cfg = resolveConfig({ taskKind: "scan", agentPolicy: "File each page." });
  const p = systemPrompt(cfg, memory, false, 8);
  assert.match(p, /Your job is set by the OPERATING POLICY below, not by the pad/);
  assert.match(p, /different pages may come from different people/);
  assert.doesNotMatch(p, /The pad holds a request|Do what it asks|A person wrote by hand/);
  assert.match(p, /OPERATING POLICY\n- File each page\./);
  assert.match(startMessage(cfg), /first document/);
});
