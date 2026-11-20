/**
 * What every backend client shares: one streamed attempt (fetch, idle and total timeouts, server-sent-event lines,
 * an attempt log with whatever arrived before a failure) and the retry loop around it. A client only supplies its
 * endpoint, its request body and an accumulator that understands its own stream events.
 */
import { isBlocked, type AttemptLog, type ChatResponse } from "./types.ts";

/**
 * Wait before a retry of a failed attempt: doubling each time, never more than maxMs. Twelve attempts ride out about
 * seven minutes of provider server errors (HTTP 500 bursts on one provider used to end episodes after four).
 */
export const RETRY_WAIT = { errorMs: 2000, maxMs: 60_000 };
export const DEFAULT_ATTEMPTS = 12;

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
// A long think can send nothing for minutes; the idle limit matches the old whole-request limit, so no request
// that used to finish is cut off, while the total limit gives long streamed replies room to finish.
const IDLE_TIMEOUT_MS = 300_000;
const TOTAL_TIMEOUT_MS = 900_000;

/**
 * OpenRouter's base URL (no trailing /v1). Requests go straight to OpenRouter; the local gateway that used to sit in
 * between is gone. GATEWAY_ENDPOINT in the repo's .env can still point somewhere else.
 */
export function apiBase(): string {
  return (process.env.GATEWAY_ENDPOINT ?? "https://openrouter.ai/api/v1").replace(/\/v1\/?$/, "");
}

/** The model id as given with --model: OpenRouter takes it unchanged. */
export function openRouterModel(model: string): string {
  return model;
}

/** Google's own Gemini API takes the bare id: an OpenRouter-style "google/" prefix is dropped. */
export function nativeModel(model: string): string {
  return model.replace(/^google\//, "");
}

/** The old gateway's provider labels, still accepted by --provider, and the OpenRouter slugs they stand for. */
export const PROVIDER_SLUGS: Record<string, string> = { "gateway-primary": "google-vertex", "gateway-secondary": "google-ai-studio" };

/** Rebuilds one reply from a backend's stream events. */
export interface StreamAccumulator {
  /** One parsed `data:` event. */
  add(event: unknown): void;
  /** After the stream ends: why the reply is not usable, if it is not. `sawDone`: the stream sent `[DONE]`. */
  endError(sawDone: boolean): string | undefined;
  readonly provider: string | null;
  readonly firstOutputAt: number | null;
  readonly finishReason: string | null;
  readonly nativeFinishReason: string | null;
  received(): AttemptLog["received"];
  /** What had arrived, for the log of a failed attempt; undefined when nothing had. */
  partial(): AttemptLog["partial"];
  response(): ChatResponse;
}

export interface AttemptResult {
  response: ChatResponse | null;
  log: AttemptLog;
  retryable: boolean;
}

/** One streamed POST. Server errors before or inside the stream become the attempt's error; blocks are not retryable. */
export async function streamAttempt(opts: { url: string; headers: Record<string, string>; body: unknown; attempt: number; acc: StreamAccumulator }): Promise<AttemptResult> {
  const { acc } = opts;
  const t0 = Date.now();
  const since = (t: number | null) => (t === null ? null : (t - t0) / 1000);
  let status: number | null = null;
  let firstByte: number | null = null;
  let done = false;
  let error: string | undefined;
  let retryable = true;

  const ctrl = new AbortController();
  let idle = setTimeout(() => ctrl.abort(new Error(`no data for ${IDLE_TIMEOUT_MS / 1000} s`)), IDLE_TIMEOUT_MS);
  const total = setTimeout(() => ctrl.abort(new Error(`still unfinished after ${TOTAL_TIMEOUT_MS / 1000} s`)), TOTAL_TIMEOUT_MS);
  const touch = () => {
    firstByte ??= Date.now();
    clearTimeout(idle);
    idle = setTimeout(() => ctrl.abort(new Error(`no data for ${IDLE_TIMEOUT_MS / 1000} s`)), IDLE_TIMEOUT_MS);
  };

  try {
    const res = await fetch(opts.url, { method: "POST", headers: opts.headers, body: JSON.stringify(opts.body), signal: ctrl.signal });
    status = res.status;
    if (!res.ok || !res.body) {
      const text = await res.text();
      touch();
      error = `Gateway ${res.status}: ${text.slice(0, 500)}`;
      retryable = RETRYABLE.has(res.status);
    } else {
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        touch();
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          // Blank lines separate events; lines starting with ":" are keep-alive comments.
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") done = true;
          else acc.add(JSON.parse(data));
        }
      }
      error = acc.endError(done);
    }
  } catch (e) {
    error = ctrl.signal.aborted ? `request aborted: ${(ctrl.signal.reason as Error).message}` : e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(idle);
    clearTimeout(total);
  }
  if (isBlocked(error)) retryable = false;

  const log: AttemptLog = {
    attempt: opts.attempt,
    started: new Date(t0).toISOString(),
    status,
    provider: acc.provider,
    first_byte_s: since(firstByte),
    first_output_s: since(acc.firstOutputAt),
    duration_s: since(Date.now())!,
    ok: !error,
    ...(error ? { error } : {}),
    finish_reason: acc.finishReason,
    native_finish_reason: acc.nativeFinishReason,
    received: acc.received(),
  };
  if (error) {
    const partial = acc.partial();
    if (partial) log.partial = partial;
    return { response: null, log, retryable };
  }
  return { response: acc.response(), log, retryable };
}

/** Tries `attempt(i)` up to `attempts` times, waiting between retryable failures; reports every try. */
export async function withRetries(attempt: (i: number) => Promise<AttemptResult>, onAttempt: ((log: AttemptLog) => void) | undefined, attempts: number): Promise<ChatResponse> {
  let lastErr = new Error("no attempts made");
  for (let i = 1; i <= attempts; i++) {
    const { response, log, retryable } = await attempt(i);
    const wait = !response && retryable && i < attempts ? Math.min(RETRY_WAIT.errorMs * 2 ** (i - 1), RETRY_WAIT.maxMs) : 0;
    if (wait) log.retry_in_s = wait / 1000;
    onAttempt?.(log);
    if (response) return response;
    lastErr = new Error(log.error);
    if (!wait) break;
    await new Promise((r) => setTimeout(r, wait));
  }
  throw lastErr;
}
