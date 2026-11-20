/**
 * The model-client contract. The agent builds requests and reads replies in one shape, the OpenAI-style chat
 * completion (what the run logs, the viewer and the probes already read); each backend client translates to and from
 * its own wire format. Swapping backends never changes the agent or the logs.
 */

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ToolCallMsg {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * An assistant message carries the backend's reasoning record in `reasoning_details`, which the agent sends back
 * unchanged on later turns: OpenRouter's items as received, or (Gemini API) the model turn's raw parts, so thought
 * signatures go back exactly as the backend gave them.
 */
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCallMsg[]; reasoning_details?: unknown[]; [k: string]: unknown }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** USD, when known. */
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

export interface ChatResponse {
  id: string;
  model: string;
  provider?: string;
  service_tier?: string;
  choices: {
    finish_reason: string | null;
    native_finish_reason?: string | null;
    message: Extract<ChatMessage, { role: "assistant" }> & { reasoning?: string | null };
  }[];
  usage?: ChatUsage;
}

/** One try at a request: who served it, how long it took, and what had arrived when it ended. */
export interface AttemptLog {
  attempt: number;
  started: string;
  /** HTTP status, or null if no response arrived. */
  status: number | null;
  provider: string | null;
  /** Seconds until the first byte of the response, and until the first text, reasoning or tool-call output. */
  first_byte_s: number | null;
  first_output_s: number | null;
  duration_s: number;
  ok: boolean;
  error?: string;
  finish_reason: string | null;
  native_finish_reason: string | null;
  received: { content_chars: number; reasoning_chars: number; tool_call_chars: number };
  /** Failed attempts only: everything that streamed in before the failure. */
  partial?: { content: string; reasoning: string; tool_calls: ToolCallMsg[] };
  /** Seconds the client waits before trying again, if it will. */
  retry_in_s?: number;
}

/** The backends a run can use. */
export const BACKENDS = ["openrouter", "gemini"] as const;
export type Backend = (typeof BACKENDS)[number];

/** A model backend: sends one chat request (retrying transport failures) and returns the reply in the common shape. */
export interface ChatClient {
  readonly backend: Backend;
  /**
   * `body` is an OpenAI-style chat request (model, messages, tools, tool_choice, reasoning, max_tokens, and for
   * OpenRouter a provider pin). Each try is reported to `onAttempt`. Throws with the last error when no try succeeds.
   */
  chat(body: Record<string, unknown>, onAttempt?: (log: AttemptLog) => void, attempts?: number): Promise<ChatResponse>;
}

/**
 * The backend's safety blocks, in the one wording every client reports them in. OpenRouter passes them through
 * inside the stream after a 200:
 * - `{"code":502,"message":"backend blocked the response: OTHER"}`;
 * - `{"code":403,"message":"backend blocked the request: SAFETY","metadata":{"error_type":"content_policy_violation",...}}`;
 * - the same with a bare `"message":"SAFETY"`.
 * The Gemini client reports its own blocks in the third form. A block is not retried by a client: the same request is
 * blocked again, so the agent decides what to send next.
 */
export const isBlocked = (error: string | undefined): boolean =>
  /(gemini |gateway )?blocked the (response|request)|"error_type":"content_policy_violation"/i.test(error ?? "");

/** The block error the Gemini client reports, in the form isBlocked recognizes. */
export function blockError(reason: string): string {
  return `Gateway error: ${JSON.stringify({ code: 403, message: reason, metadata: { error_type: "content_policy_violation", provider_code: reason } })}`;
}
