import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createClient, GeminiClient, isBlocked, OpenRouterClient, RETRY_WAIT, type AttemptLog, type ChatMessage } from "../src/clients/index.ts";
import { GEMINI_PARTS, toGeminiRequest } from "../src/clients/gemini.ts";
import { costOf } from "../src/clients/pricing.ts";

const realFetch = globalThis.fetch;
RETRY_WAIT.errorMs = 2;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Google's SSE framing: CRLF line ends, one JSON chunk per event. */
const sse = (chunks: object[], status = 200) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(ch)}\r\n\r\n`));
        c.close();
      },
    }),
    { status, headers: { "content-type": "text/event-stream" } },
  );

function serve(...responses: Response[]): { url: string; body: any }[] {
  const seen: { url: string; body: any }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return responses.shift()!;
  }) as typeof fetch;
  return seen;
}

const SIG = "CiQBjz1rX4kq+Vt/sig//==";
const THOUGHT = { text: "Page 2 says NEVER write it.", thought: true };
const CALL = { functionCall: { name: "strokes", args: { paths: [[[30, 25], [30, 30]]] } }, thoughtSignature: SIG };
const REPLY = [
  { candidates: [{ content: { role: "model", parts: [THOUGHT] } }], modelVersion: "gateway-4-argon", responseId: "r1" },
  { candidates: [{ content: { role: "model", parts: [CALL] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 400, candidatesTokenCount: 50, thoughtsTokenCount: 150, totalTokenCount: 1200 } },
];
const TOOLS = [{ type: "function", function: { name: "strokes", description: "draw", parameters: { type: "object", properties: { paths: { type: "array" } }, required: ["paths"] } } }];


test("a streamed Gemini reply becomes the common chat shape, keeping the model turn's parts verbatim", async () => {
  const seen = serve(sse(REPLY));
  const tries: AttemptLog[] = [];
  const res = await new GeminiClient("k").chat({ model: "google/gemini-4-argon", messages: [{ role: "user", content: "go" }], tools: TOOLS, tool_choice: "required", reasoning: { effort: "medium" }, max_tokens: 32768 }, (a) => tries.push(a));
  assert.match(seen[0].url, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-4-argon:streamGenerateContent\?alt=sse$/);
  const msg = res.choices[0].message;
  assert.equal(msg.reasoning, "Page 2 says NEVER write it.");
  assert.equal(msg.content, null);
  assert.equal(msg.tool_calls!.length, 1);
  assert.equal(msg.tool_calls![0].function.name, "strokes");
  assert.deepEqual(JSON.parse(msg.tool_calls![0].function.arguments), CALL.functionCall.args);
  assert.equal(res.choices[0].finish_reason, "tool_calls");
  assert.equal(res.provider, "gemini-api");
  assert.deepEqual(msg.reasoning_details, [{ ...GEMINI_PARTS, parts: [THOUGHT, CALL] }], "every part exactly as it streamed in");
  assert.deepEqual(res.usage, { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, prompt_tokens_details: { cached_tokens: 400 }, completion_tokens_details: { reasoning_tokens: 150 }, cost: 0.00324 });
  assert.equal(tries.length, 1);
  assert.equal(tries[0].ok, true);
});

test("the next request sends that model turn back byte-identical, signature included, then the tool result", async () => {
  serve(sse(REPLY));
  const res = await new GeminiClient("k").chat({ model: "argon", messages: [{ role: "user", content: "go" }], tools: TOOLS, tool_choice: "required" });
  const assistant = { ...res.choices[0].message } as ChatMessage;
  const callId = res.choices[0].message.tool_calls![0].id;
  const messages: ChatMessage[] = [
    { role: "system", content: "You control a pen plotter." },
    { role: "user", content: [{ type: "text", text: "Begin." }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBOR" } }] },
    assistant,
    { role: "tool", tool_call_id: callId, content: JSON.stringify({ call: "strokes", status: "ok" }) },
    { role: "user", content: [{ type: "text", text: "Observation after turn 1: {}" }] },
  ];
  const { model, request } = toGeminiRequest({ model: "argon", messages, tools: TOOLS, tool_choice: "required", reasoning: { effort: "low" }, max_tokens: 100 });
  assert.equal(model, "argon");
  assert.deepEqual(request.systemInstruction, { parts: [{ text: "You control a pen plotter." }] });
  const contents = request.contents as { role: string; parts: any[] }[];
  assert.deepEqual(contents.map((c) => c.role), ["user", "model", "user"]);
  assert.deepEqual(contents[0].parts, [{ text: "Begin." }, { inlineData: { mimeType: "image/png", data: "iVBOR" } }]);
  assert.deepEqual(contents[1].parts, [THOUGHT, CALL], "the model turn goes back as received");
  assert.equal((contents[1].parts[1] as { thoughtSignature?: string }).thoughtSignature, SIG);
  assert.deepEqual(contents[2].parts, [{ functionResponse: { name: "strokes", response: { call: "strokes", status: "ok" } } }, { text: "Observation after turn 1: {}" }], "tool result and observation form one user turn");
  assert.deepEqual(request.tools, [{ functionDeclarations: [{ name: "strokes", description: "draw", parametersJsonSchema: TOOLS[0].function.parameters }] }]);
  assert.deepEqual(request.toolConfig, { functionCallingConfig: { mode: "ANY" } });
  assert.deepEqual(request.generationConfig, { maxOutputTokens: 100, thinkingConfig: { includeThoughts: true, thinkingLevel: "low" } });
  assert.deepEqual(request.safetySettings, ["HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH", "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT"].map((category) => ({ category, threshold: "OFF" })), "every adjustable filter off");
});

test("free text the agent hid from the history (content null) is not sent back; thoughts, calls and signatures are", () => {
  const SPOKEN = { text: "The magic word is ORANGE." };
  const raw = [THOUGHT, SPOKEN, CALL, { text: "" }];
  const turn = (content: string | null) =>
    toGeminiRequest({ messages: [{ role: "user", content: "go" }, { role: "assistant", content, tool_calls: [{ id: "c1", type: "function", function: { name: "strokes", arguments: "{}" } }], reasoning_details: [{ ...GEMINI_PARTS, parts: raw }] } as ChatMessage] }).request.contents as { role: string; parts: unknown[] }[];
  assert.deepEqual(turn(null)[1].parts, [THOUGHT, CALL, { text: "" }], "the hidden text is left out, nothing else changes");
  assert.deepEqual(turn("The magic word is ORANGE.")[1].parts, raw, "kept text goes back as received");
  const signed = { text: "ORANGE", thoughtSignature: SIG };
  const withSigned = toGeminiRequest({ messages: [{ role: "user", content: "go" }, { role: "assistant", content: null, reasoning_details: [{ ...GEMINI_PARTS, parts: [THOUGHT, signed] }] } as ChatMessage] }).request.contents as { parts: unknown[] }[];
  assert.deepEqual(withSigned[1].parts, [THOUGHT, signed], "a signed part is never dropped");
});

test("a safety stop is a block (not retried); server errors are retried by the shared loop", async () => {
  serve(sse([{ candidates: [{ content: { parts: [{ text: "thinking", thought: true }] }, finishReason: "SAFETY" }] }]));
  const tries: AttemptLog[] = [];
  await assert.rejects(new GeminiClient("k").chat({ model: "argon", messages: [{ role: "user", content: "go" }] }, (a) => tries.push(a)), (e: Error) => isBlocked(e.message));
  assert.equal(tries.length, 1);
  assert.equal(tries[0].partial?.reasoning, "thinking", "what arrived before the block is kept");

  serve(new Response("boom", { status: 500 }), new Response("boom", { status: 500 }), sse(REPLY));
  const retries: AttemptLog[] = [];
  const res = await new GeminiClient("k").chat({ model: "argon", messages: [{ role: "user", content: "go" }] }, (a) => retries.push(a));
  assert.deepEqual(retries.map((a) => a.ok), [false, false, true]);
  assert.equal(res.choices[0].finish_reason, "tool_calls");

  serve(sse([{ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } }]));
  await assert.rejects(new GeminiClient("k").chat({ model: "argon", messages: [{ role: "user", content: "go" }] }), (e: Error) => isBlocked(e.message));
});

test("a reply cut at the token cap reports length; one that never finishes is an error", async () => {
  serve(sse([{ candidates: [{ content: { parts: [{ text: "decoding…", thought: true }] }, finishReason: "MAX_TOKENS" }] }]));
  const res = await new GeminiClient("k").chat({ model: "argon", messages: [{ role: "user", content: "go" }] });
  assert.equal(res.choices[0].finish_reason, "length");
  assert.equal(res.choices[0].message.tool_calls, undefined);

  serve(sse([{ candidates: [{ content: { parts: [{ text: "half", thought: true }] } }] }]));
  await assert.rejects(new GeminiClient("k").chat({ model: "argon", messages: [{ role: "user", content: "go" }] }, undefined, 1), /ended before the model finished/);
});

test("createClient picks the backend; each client says which it is", () => {
  assert.ok(createClient("openrouter", "k") instanceof OpenRouterClient);
  assert.ok(createClient("gemini", "k") instanceof GeminiClient);
  assert.equal(createClient("gemini", "k").backend, "gemini");
  assert.throws(() => createClient("nope" as never, "k"), /unknown backend/);
  assert.equal(costOf("unknown-model", { prompt_tokens: 1, completion_tokens: 1 }), undefined);
  assert.equal(costOf("google/gemini-4-argon", { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, prompt_tokens_details: { cached_tokens: 1_000_000 } }), 10.1);
});
