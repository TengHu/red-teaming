/**
 * The Gemini API backend: Google's own streamGenerateContent, through the gateway's /native passthrough (which holds
 * the key). Requests and replies are translated to and from the common chat shape (src/clients/types.ts).
 *
 * Reasoning, the official way (Gemini API "thought signatures"): a model turn's parts (thought summaries, text,
 * function calls, each possibly carrying a `thoughtSignature`) are kept exactly as they streamed in, on the assistant
 * message's `reasoning_details`, and sent back verbatim as that model turn. Parts are never merged, rebuilt or
 * dropped, so every signature returns in the part it came with.
 */
import { randomUUID } from "node:crypto";
import { costOf } from "./pricing.ts";
import { DEFAULT_ATTEMPTS, nativeModel, streamAttempt, withRetries, type StreamAccumulator } from "./stream.ts";
import { blockError, type AttemptLog, type ChatClient, type ChatMessage, type ChatResponse, type ToolCallMsg } from "./types.ts";

/** The reasoning_details item that carries a model turn's raw parts. */
export const GEMINI_PARTS = { type: "gemini.parts", format: "google-gemini-native" } as const;
/** The provider label of replies from this backend. */
export const GEMINI_PROVIDER = "gemini-api";

/** A Gemini content part, as the API sends it; kept opaque except for the fields the translation reads. */
type Part = Record<string, unknown> & {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args?: unknown; id?: string };
};
interface Content {
  role: "user" | "model";
  parts: Part[];
}

/**
 * Every adjustable safety filter off (threshold OFF), sent on every request. OFF is already Google's default for
 * Gemini 2.5 and later; sending it makes the setting explicit and recorded. Google's built-in core-harm protections are
 * not adjustable and still apply (they surface as blocks, e.g. promptFeedback.blockReason "OTHER").
 */
export const SAFETY_SETTINGS = ["HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH", "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT"].map((category) => ({ category, threshold: "OFF" }));

/** Finish reasons that mean the backend's safety filter stopped the reply. */
const BLOCK_REASONS = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "IMAGE_SAFETY"]);

export class GeminiClient implements ChatClient {
  readonly backend = "gemini" as const;
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  chat(body: Record<string, unknown>, onAttempt?: (log: AttemptLog) => void, attempts = DEFAULT_ATTEMPTS): Promise<ChatResponse> {
    const { model, request } = toGeminiRequest(body);
    // Straight to Google's Gemini API, with the bare model id (src/clients/stream.ts).
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(nativeModel(model))}:streamGenerateContent?alt=sse`;
    const headers = { "x-goog-api-key": this.apiKey, "Content-Type": "application/json" };
    return withRetries((i) => streamAttempt({ url, headers, body: request, attempt: i, acc: new GeminiAccumulator(model) }), onAttempt, attempts);
  }
}

/** The common chat request as a Gemini generateContent request. Pure; exported for tests. */
export function toGeminiRequest(body: Record<string, unknown>): { model: string; request: Record<string, unknown> } {
  const messages = (body.messages ?? []) as ChatMessage[];
  const contents: Content[] = [];
  let systemInstruction: { parts: Part[] } | undefined;
  /** Tool call id -> the function call it answers (name, and the API's own id when it gave one). */
  const calls = new Map<string, { name: string; id?: string }>();

  // Consecutive user-side messages (tool results, observations, page turns) form one user turn. Model turns are never
  // merged: each is exactly one reply.
  const push = (role: Content["role"], parts: Part[]) => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    if (role === "user" && last?.role === "user") last.parts.push(...parts);
    else contents.push({ role, parts });
  };

  for (const m of messages) {
    if (m.role === "system") {
      systemInstruction = { parts: [{ text: m.content }] };
    } else if (m.role === "user") {
      push("user", userParts(m.content));
    } else if (m.role === "assistant") {
      const raw = (m.reasoning_details as { type?: string; parts?: Part[] }[] | undefined)?.find((d) => d?.type === GEMINI_PARTS.type)?.parts;
      const toolCalls = (m.tool_calls ?? []) as ToolCallMsg[];
      if (raw) {
        // The reply as the API sent it. Its k-th function call is the message's k-th tool call.
        const fcs = raw.filter((p) => p.functionCall);
        toolCalls.forEach((tc, k) => calls.set(tc.id, { name: tc.function.name, ...(fcs[k]?.functionCall?.id ? { id: fcs[k].functionCall!.id } : {}) }));
        // The agent keeps free text out of the history by clearing the message's content (argon.ts). The raw parts
        // still hold that text, so with no content a visible text part without a signature is left out (Google:
        // signatures on text parts are optional). Thoughts, function calls and every signed part go back as received.
        const hidden = !(typeof m.content === "string" && m.content);
        push("model", hidden ? raw.filter((p) => !(typeof p.text === "string" && p.text && !p.thought && !p.thoughtSignature)) : raw);
      } else {
        // A turn this backend did not produce (no signatures to return): rebuilt from the common shape.
        const parts: Part[] = [];
        if (typeof m.content === "string" && m.content) parts.push({ text: m.content });
        for (const tc of toolCalls) {
          calls.set(tc.id, { name: tc.function.name });
          parts.push({ functionCall: { name: tc.function.name, args: parseArgs(tc.function.arguments) } });
        }
        push("model", parts);
      }
    } else if (m.role === "tool") {
      const call = calls.get(m.tool_call_id);
      if (!call) throw new Error(`tool result for unknown call id ${m.tool_call_id}`);
      push("user", [{ functionResponse: { name: call.name, ...(call.id ? { id: call.id } : {}), response: responsePayload(m.content) } }]);
    }
  }

  const tools = (body.tools ?? []) as { type: string; function: { name: string; description?: string; parameters?: unknown } }[];
  const choice = body.tool_choice;
  const effort = (body.reasoning as { effort?: string } | undefined)?.effort;
  const request: Record<string, unknown> = {
    contents,
    ...(systemInstruction ? { systemInstruction } : {}),
    ...(tools.length
      ? {
          tools: [{ functionDeclarations: tools.map((t) => ({ name: t.function.name, ...(t.function.description ? { description: t.function.description } : {}), parametersJsonSchema: t.function.parameters ?? { type: "object", properties: {} } })) }],
          toolConfig: { functionCallingConfig: { mode: choice === "required" ? "ANY" : choice === "none" ? "NONE" : "AUTO" } },
        }
      : {}),
    safetySettings: SAFETY_SETTINGS,
    generationConfig: {
      ...(typeof body.max_tokens === "number" ? { maxOutputTokens: body.max_tokens } : {}),
      thinkingConfig: { includeThoughts: true, ...(effort ? { thinkingLevel: effort } : {}) },
    },
  };
  return { model: String(body.model ?? "argon"), request };
}

function userParts(content: ChatMessage["content"]): Part[] {
  if (typeof content === "string") return content ? [{ text: content }] : [];
  return (content ?? []).map((p) => {
    if (p.type === "text") return { text: p.text };
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(p.image_url.url);
    if (!m) throw new Error("the Gemini backend takes images only as data: URLs");
    return { inlineData: { mimeType: m[1], data: m[2] } };
  });
}

function parseArgs(text: string): unknown {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

/** A function response must be an object: the tool result as sent, or wrapped when it is not an object. */
function responsePayload(content: string): Record<string, unknown> {
  try {
    const v = JSON.parse(content);
    return v && typeof v === "object" && !Array.isArray(v) ? v : { result: v };
  } catch {
    return { result: content };
  }
}

interface Chunk {
  candidates?: { content?: { parts?: Part[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number; totalTokenCount?: number };
  promptFeedback?: { blockReason?: string };
  modelVersion?: string;
  responseId?: string;
  error?: unknown;
}

/** Collects a streamed generateContent reply. Every part is kept as it arrived, in order, unmerged. */
export class GeminiAccumulator implements StreamAccumulator {
  readonly provider = GEMINI_PROVIDER;
  firstOutputAt: number | null = null;
  finishReason: string | null = null;
  nativeFinishReason: string | null = null;
  private readonly parts: Part[] = [];
  private usageMeta: Chunk["usageMetadata"];
  private blockReason: string | null = null;
  private error: unknown = null;
  private sawCandidate = false;
  private id = "";
  private modelVersion = "";
  private readonly model: string;

  constructor(model: string) {
    this.model = model;
  }

  add(event: unknown): void {
    const chunk = event as Chunk;
    if (chunk.error) this.error = chunk.error;
    if (chunk.promptFeedback?.blockReason) this.blockReason = chunk.promptFeedback.blockReason;
    if (chunk.usageMetadata) this.usageMeta = chunk.usageMetadata;
    this.id ||= chunk.responseId ?? "";
    this.modelVersion ||= chunk.modelVersion ?? "";
    const cand = chunk.candidates?.[0];
    if (!cand) return;
    this.sawCandidate = true;
    for (const p of cand.content?.parts ?? []) {
      this.firstOutputAt ??= Date.now();
      this.parts.push(structuredClone(p));
    }
    if (cand.finishReason) this.nativeFinishReason = cand.finishReason;
    this.finishReason = this.nativeFinishReason === null ? null : mapFinish(this.nativeFinishReason, this.parts.some((p) => p.functionCall));
  }

  endError(): string | undefined {
    if (this.error) return `Gateway error: ${JSON.stringify(this.error).slice(0, 500)}`;
    if (this.blockReason) return blockError(this.blockReason);
    if (this.nativeFinishReason && BLOCK_REASONS.has(this.nativeFinishReason)) return blockError(this.nativeFinishReason);
    if (!this.sawCandidate) return "Gateway error: the stream carried no candidates";
    if (!this.nativeFinishReason) return "Gateway error: the stream ended before the model finished";
    if (!["STOP", "MAX_TOKENS"].includes(this.nativeFinishReason)) return `Gateway error: the reply ended with ${this.nativeFinishReason}`;
    return undefined;
  }

  private text(thought: boolean): string {
    return this.parts.filter((p) => typeof p.text === "string" && Boolean(p.thought) === thought).map((p) => p.text).join("");
  }

  private toolCalls(): ToolCallMsg[] {
    return this.parts.filter((p) => p.functionCall).map((p) => ({ id: p.functionCall!.id ?? `call_${randomUUID().slice(0, 8)}`, type: "function" as const, function: { name: p.functionCall!.name, arguments: JSON.stringify(p.functionCall!.args ?? {}) } }));
  }

  received(): AttemptLog["received"] {
    return { content_chars: this.text(false).length, reasoning_chars: this.text(true).length, tool_call_chars: this.parts.filter((p) => p.functionCall).reduce((n, p) => n + JSON.stringify(p.functionCall!.args ?? {}).length, 0) };
  }

  partial(): AttemptLog["partial"] {
    return this.parts.length ? { content: this.text(false), reasoning: this.text(true), tool_calls: this.toolCalls() } : undefined;
  }

  response(): ChatResponse {
    const toolCalls = this.toolCalls();
    const u = this.usageMeta;
    const usage = u
      ? {
          prompt_tokens: u.promptTokenCount ?? 0,
          completion_tokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
          total_tokens: u.totalTokenCount ?? (u.promptTokenCount ?? 0) + (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
          prompt_tokens_details: { cached_tokens: u.cachedContentTokenCount ?? 0 },
          completion_tokens_details: { reasoning_tokens: u.thoughtsTokenCount ?? 0 },
        }
      : undefined;
    const cost = usage ? costOf(this.model, usage) : undefined;
    return {
      id: this.id,
      model: this.modelVersion || this.model,
      provider: GEMINI_PROVIDER,
      choices: [
        {
          finish_reason: this.finishReason,
          native_finish_reason: this.nativeFinishReason,
          message: {
            role: "assistant",
            content: this.text(false) || null,
            reasoning: this.text(true) || null,
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
            reasoning_details: [{ ...GEMINI_PARTS, parts: this.parts }],
          },
        },
      ],
      ...(usage ? { usage: { ...usage, ...(cost !== undefined ? { cost } : {}) } } : {}),
    };
  }
}

function mapFinish(reason: string, hasCalls: boolean): string {
  if (reason === "MAX_TOKENS") return "length";
  if (reason === "STOP") return hasCalls ? "tool_calls" : "stop";
  return reason.toLowerCase();
}
