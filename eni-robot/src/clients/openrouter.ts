/**
 * The OpenRouter backend: OpenAI-style chat completions through the gateway's /v1 endpoint, always streamed and
 * assembled into an ordinary chat completion, so a failed attempt still shows what the model had produced.
 * Reasoning goes back the way OpenRouter documents it: the assistant message's `reasoning_details`, unchanged.
 */
import { apiBase, DEFAULT_ATTEMPTS, openRouterModel, PROVIDER_SLUGS, streamAttempt, withRetries, type StreamAccumulator } from "./stream.ts";
import { blockError, isBlocked, type AttemptLog, type ChatClient, type ChatResponse, type ToolCallMsg } from "./types.ts";

/**
 * Google finish reasons that mean its filter stopped the reply. Through OpenRouter such a stop can arrive as a plain
 * stream error (AI Studio sends `{"code":500,"message":"Internal Server Error"}` with native_finish_reason "OTHER");
 * with one of these reasons the error is reported as the block it is, so it is not retried as a server error.
 */
const GOOGLE_BLOCK_REASONS = new Set(["OTHER", "SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "IMAGE_SAFETY"]);

export class OpenRouterClient implements ChatClient {
  readonly backend = "openrouter" as const;
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  chat(body: Record<string, unknown>, onAttempt?: (log: AttemptLog) => void, attempts = DEFAULT_ATTEMPTS): Promise<ChatResponse> {
    const url = `${apiBase()}/v1/chat/completions`;
    const headers = { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", "X-Title": "scribe-env" };
    // The old gateway's provider labels become OpenRouter slugs.
    const provider = body.provider as { order?: string[] } | undefined;
    const sent = {
      ...body,
      model: openRouterModel(String(body.model)),
      ...(provider?.order ? { provider: { ...provider, order: provider.order.map((p) => PROVIDER_SLUGS[p] ?? p) } } : {}),
      stream: true,
    };
    return withRetries((i) => streamAttempt({ url, headers, body: sent, attempt: i, acc: new OpenRouterAccumulator() }), onAttempt, attempts);
  }
}

interface ChunkDelta {
  content?: string | null;
  reasoning?: string | null;
  reasoning_details?: Record<string, unknown>[];
  tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
}

interface Chunk {
  id?: string;
  model?: string;
  provider?: string;
  service_tier?: string;
  error?: unknown;
  usage?: ChatResponse["usage"];
  choices?: { delta?: ChunkDelta; finish_reason?: string | null; native_finish_reason?: string | null }[];
}

/** Rebuilds a chat completion from streamed chunks; pieces of one tool call or reasoning item share an `index`. */
class OpenRouterAccumulator implements StreamAccumulator {
  id = "";
  model = "";
  provider: string | null = null;
  serviceTier: string | null = null;
  content = "";
  reasoning = "";
  details: Record<string, unknown>[] = [];
  toolCalls: ToolCallMsg[] = [];
  finishReason: string | null = null;
  nativeFinishReason: string | null = null;
  usage: ChatResponse["usage"];
  error: unknown = null;
  sawChoice = false;
  firstOutputAt: number | null = null;

  add(event: unknown): void {
    const chunk = event as Chunk;
    this.id ||= chunk.id ?? "";
    this.model ||= chunk.model ?? "";
    this.provider ??= chunk.provider ?? null;
    this.serviceTier = chunk.service_tier ?? this.serviceTier;
    if (chunk.usage) this.usage = chunk.usage;
    if (chunk.error) this.error = chunk.error;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    this.sawChoice = true;
    this.finishReason = choice.finish_reason ?? this.finishReason;
    this.nativeFinishReason = choice.native_finish_reason ?? this.nativeFinishReason;
    const d = choice.delta ?? {};
    if (d.content || d.reasoning || d.tool_calls?.length) this.firstOutputAt ??= Date.now();
    if (d.content) this.content += d.content;
    if (d.reasoning) this.reasoning += d.reasoning;
    for (const item of d.reasoning_details ?? []) this.addDetail(item);
    for (const tc of d.tool_calls ?? []) {
      const i = tc.index ?? this.toolCalls.length;
      const call = (this.toolCalls[i] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
      if (tc.id) call.id = tc.id;
      if (tc.function?.name) call.function.name += tc.function.name;
      if (tc.function?.arguments) call.function.arguments += tc.function.arguments;
    }
  }

  /** Text-like fields of a reasoning item continue across chunks; the rest (ids, formats) are set once. */
  private addDetail(item: Record<string, unknown>): void {
    const prev = item.index == null ? undefined : this.details.find((x) => x.index === item.index && x.type === item.type);
    if (!prev) {
      this.details.push({ ...item });
      return;
    }
    for (const [k, v] of Object.entries(item)) {
      if ((k === "text" || k === "summary" || k === "data") && typeof v === "string") prev[k] = String(prev[k] ?? "") + v;
      else if (v != null) prev[k] = v;
    }
  }

  endError(sawDone: boolean): string | undefined {
    // Upstream provider errors arrive inside the stream, after a 200.
    if (this.error) {
      const raw = `Gateway error: ${JSON.stringify(this.error).slice(0, 500)}`;
      return !isBlocked(raw) && this.nativeFinishReason && GOOGLE_BLOCK_REASONS.has(this.nativeFinishReason) ? blockError(this.nativeFinishReason) : raw;
    }
    if (!this.sawChoice) return "Gateway error: the stream carried no choices";
    if (!sawDone && !this.finishReason) return "Gateway error: the stream ended before the model finished";
    return undefined;
  }

  received(): AttemptLog["received"] {
    return { content_chars: this.content.length, reasoning_chars: this.reasoning.length, tool_call_chars: this.toolCalls.reduce((n, tc) => n + tc.function.arguments.length, 0) };
  }

  partial(): AttemptLog["partial"] {
    return this.content || this.reasoning || this.toolCalls.length ? { content: this.content, reasoning: this.reasoning, tool_calls: this.toolCalls.filter(Boolean) } : undefined;
  }

  response(): ChatResponse {
    const message: ChatResponse["choices"][number]["message"] = {
      role: "assistant",
      content: this.content || null,
      reasoning: this.reasoning || null,
      ...(this.toolCalls.length ? { tool_calls: this.toolCalls.filter(Boolean) } : {}),
      ...(this.details.length ? { reasoning_details: this.details } : {}),
    };
    return {
      id: this.id,
      model: this.model,
      ...(this.provider ? { provider: this.provider } : {}),
      ...(this.serviceTier ? { service_tier: this.serviceTier } : {}),
      choices: [{ finish_reason: this.finishReason, native_finish_reason: this.nativeFinishReason, message }],
      usage: this.usage,
    };
  }
}
