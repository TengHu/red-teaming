import assert from "node:assert/strict";
import { test } from "node:test";
import { applyToolDescriptions } from "../src/actions.ts";
import { resolveConfig } from "../src/config.ts";
import {
  pageTurnHeader,
  PROMPT_COMPONENTS,
  PROMPT_VARS,
  renderPrompt,
  startMessage,
  systemPrompt,
  type PromptOverrides,
} from "../src/prompt.ts";

const memory = { keepTurns: 0, maxContextTokens: 500_000 };
const cfg = resolveConfig({ agentPolicy: "File each page." });

test("every component name is unique and every placeholder is listed once", () => {
  assert.equal(new Set(PROMPT_COMPONENTS).size, PROMPT_COMPONENTS.length);
  assert.equal(new Set(PROMPT_VARS).size, PROMPT_VARS.length);
});

test("a component file replaces only that section", () => {
  const p = systemPrompt(cfg, memory, false, 1, { "system.intro": "You are a quill." });
  assert.match(p, /^You are a quill\./);
  assert.match(p, /BODY AND FRAME/);
  assert.match(p, /OPERATING POLICY\n- File each page\./);
  assert.doesNotMatch(p, /You control a pen-plotter robot at a desk/);
});

test("a component file may interpolate the documented placeholders", () => {
  const p = systemPrompt(cfg, memory, false, 1, {
    "system.intro": "Sheet {{sheet_width_mm}}x{{sheet_height_mm}}, policy: {{policy}}",
  });
  assert.match(p, /^Sheet 210x297, policy: File each page\./);
});

test("system.body can reuse the computed pen block and ruling", () => {
  const p = systemPrompt(resolveConfig({ pen: { level: 2 } }), memory, false, 1, {
    "system.body": "BODY\n{{pen_body}}\n{{ruling}}",
  });
  assert.match(p, /How the cams work/);
  assert.match(p, /The sheet is ruled/);
});

test("the whole system prompt can be replaced, and still gets the sections as placeholders", () => {
  const overrides: PromptOverrides = { system: "[{{task_kind}}]\n{{task_instructions}}\n{{hard_rules}}" };
  const p = systemPrompt(cfg, memory, false, 1, overrides);
  assert.match(p, /^\[instruct\]/);
  assert.match(p, /The pad holds a request/);
  assert.match(p, /Never put words anywhere in your reply/);
  assert.doesNotMatch(p, /BODY AND FRAME/);
});

test("a full system prompt passed as text is sent byte-for-byte", () => {
  const text = "You control a pen.\n\nEXACT TEXT\n- keep every byte";
  assert.equal(systemPrompt(cfg, memory, false, 1, { system: text }), text);
});

test("user-message components are overridable too", () => {
  const start = startMessage(cfg, false, { "user.start": "Go ({{task_kind}})." });
  assert.equal(start, "Go (instruct).");
  const turn = pageTurnHeader(2, 5, { "user.page_turn": "page {{page}}/{{page_count}}" });
  assert.equal(turn, "page 2/5");
});

test("an unknown placeholder is an error, not a silent empty string", () => {
  assert.throws(() => renderPrompt("hi {{nope}}", { intro: "" }, "test"), /unknown prompt placeholder \{\{nope\}\}/);
});

test("tool descriptions can be replaced without touching the schema", () => {
  const tools = [{ type: "function" as const, function: { name: "stroke", description: "old", parameters: { type: "object" } } }];
  const out = applyToolDescriptions(tools, { stroke: "new" });
  assert.equal(out[0].function.description, "new");
  assert.deepEqual(out[0].function.parameters, { type: "object" });
  assert.equal(tools[0].function.description, "old", "the input is not mutated");
  assert.throws(() => applyToolDescriptions(tools, { nope: "x" }), /unknown tool "nope"/);
});
