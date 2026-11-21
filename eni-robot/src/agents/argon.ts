import type { CallResult, Observation, ScribeEnv, ToolCall } from "../env.ts";
import { isBlocked, type AttemptLog, type ChatClient, type ChatMessage, type ChatResponse, type ContentPart, type ToolCallMsg } from "../clients/index.ts";
import {
  blockedMessage,
  blockedShorterMessage,
  droppedTurnsMessage,
  imageLabel,
  imageOmittedLabel,
  noToolCallsMessage,
  observationPrefix,
  pageTurnHeader,
  recordingHeader,
  startMessage,
  systemPrompt,
  taskImageHeader,
  type PromptOverrides,
} from "../prompt.ts";
import { applyToolDescriptions, type ToolSchema } from "../actions.ts";
import { renderPad } from "../taskpad.ts";

/**
 * Whether the model accepts a forced tool choice ("required"). Claude Opus 5.5, Sonnet 5.5, Fable 5.1/5.2 and
 * Mythos 5.1 (and later ones in those lines) answer it with a 400 ("tool_choice: type "tool" and "any" are not
 * supported for this model").
 */
export function allowsForcedToolChoice(model: string): boolean {
  return !/^anthropic\/claude-(opus-5\.5|sonnet-5\.5|fable-5\.[12]|mythos-5\.1)/.test(model);
}

/**
 * Whether the model provider's safety filter stopped the reply. Anthropic reports it as stop_reason "refusal", which
 * OpenRouter passes on as native_finish_reason "refusal" (finish_reason "content_filter") in an ordinary 200 reply.
 */
export function isRefusal(choice: { native_finish_reason?: string | null }): boolean {
  return choice.native_finish_reason === "refusal";
}

function refusalMessage(request: number, choice: { finish_reason: string | null; native_finish_reason?: string | null }): string {
  return `request ${request} refused by the model provider's safety filter (finish_reason ${choice.finish_reason}, native ${choice.native_finish_reason}); the reply was not used`;
}

export const REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface ArgonOptions {
  model: string;
  /** Default low. */
  reasoningEffort?: ReasoningEffort;
  /** Turns kept in the conversation; older ones are dropped. 0 keeps every turn. */
  keepTurns: number;
  /** When a request's prompt passes this many tokens, the oldest quarter of the kept turns is dropped (default 500k). */
  maxContextTokens?: number;
  maxCostUsd: number;
  maxTokens: number;
  /** gateway provider slugs to use, in order, with no fallback to others. */
  providers?: string[];
  /** Pause before a blocked request is sent again with a smaller task line (default 10 s). */
  blockPauseMs?: number;
  onTurn?: (log: TurnLog) => void;
  /** The exact request body about to be sent, numbered from 1. */
  onRequest?: (index: number, body: Record<string, unknown>) => void;
  /** The raw response for request `index`, or null and an error message if it failed. */
  onResponse?: (index: number, response: ChatResponse | null, error?: string) => void;
  /** Each try at request `index`, including failed ones that were retried. */
  onAttempt?: (index: number, attempt: AttemptLog) => void;
  /** Runs after every turn's calls, before the next request: e.g. reading the sheet for the pay-to-hide check. */
  afterStep?: () => Promise<void>;
  /** Slides: the operator's page turns. take() uses up one queued turn; wait() resolves once one is queued. */
  pageTurns?: PageTurns;
  /** Prompt components loaded from files; each replaces the default text sent to the model. */
  prompts?: PromptOverrides;
  /** Tool descriptions loaded from a file: tool name -> description. The schemas stay as they are. */
  toolDescriptions?: Record<string, string> | null;
  /** A complete tool set loaded from a file; replaces the environment's own. */
  tools?: ToolSchema[];
}

export interface PageTurns {
  take(): boolean;
  wait(): Promise<void>;
}

/** Page turns with no operator: the next page goes on the pad as soon as the model has finished the current one
 * (`done()`, or idling once the page is written), never before. */
export function turnOnDone(env: { waitingForPage: boolean }): PageTurns {
  return { take: () => env.waitingForPage, wait: () => Promise.resolve() };
}

export interface TurnLog {
  turn: number;
  /** Which request/response pair (from onRequest/onResponse) produced this turn. */
  request_index: number;
  text: string | null;
  reasoning: string | null;
  calls: { name: string; args: unknown }[];
  results: CallResult[];
  finish_reason: string | null;
  /** The model provider's safety filter stopped this reply (Anthropic's stop_reason "refusal"); the run ends here. */
  refused?: boolean;
  /** The gateway provider label that served the request, e.g. "gateway-primary". */
  provider: string | null;
  usage: ChatResponse["usage"] | null;
  cost_usd: number;
  total_cost_usd: number;
  elapsed_s: number;
}

export interface ArgonResult {
  stopReason: "done" | "stalled" | "max_turns" | "max_cost" | "idle" | "token_cap" | "refused" | "error";
  turns: number;
  costUsd: number;
  error?: string;
}

interface Turn {
  /** Absent on a page turn, which is only a user message. */
  assistant?: ChatMessage;
  replies: ChatMessage[];
  obs: Observation | null;
  obsTurn: number;
  /** Slides: the recording of a page the operator turned to. Never dropped, so each page is sent exactly once. */
  page?: true;
}

const MAX_IDLE_TURNS = 3;
/**
 * Sends a request again, each time with a smaller task line, before the run stops.
 * Resends cost nothing and typically complete on a later attempt (measured 2026-10-30 on
 * instruct tasks), so this limit is generous.
 */
const MAX_BLOCKED_RESENDS = 12;
const DEFAULT_BLOCK_PAUSE_MS = 10_000;
const DEFAULT_MAX_CONTEXT_TOKENS = 500_000;
const OMITTED = "[omitted from older observation]";

/**
 * Drives the environment with a model over the gateway, in the code-as-policies style:
 * each turn the model sees the observation JSON plus the overview and detail images, and answers
 * with a batch of tool calls. The task reaches the model only as pen strokes: the whole recording, pinned in
 * the first message, while each observation names the one line to write now.
 */
export async function runArgon(env: ScribeEnv, client: ChatClient, opts: ArgonOptions): Promise<ArgonResult> {
  if (!env.taskPad) throw new Error("runArgon needs an environment with a task pad (ScribeEnv.create(cfg, { task }))");
  const maxContextTokens = opts.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
  const taskImage = env.imagePad !== null;
  const prompts = opts.prompts ?? {};
  const tools = applyToolDescriptions(opts.tools ?? env.tools(), opts.toolDescriptions);
  const system: ChatMessage = { role: "system", content: systemPrompt(env.cfg, { keepTurns: opts.keepTurns, maxContextTokens }, taskImage, Math.max(1, env.pages.length), prompts) };
  const pinned: ContentPart[] = [
    { type: "text", text: startMessage(env.cfg, taskImage, prompts) },
    { type: "text", text: `${recordingHeader(prompts)}\n${JSON.stringify(env.taskRecording())}` },
  ];
  if (env.imagePad) {
    pinned.push({ type: "text", text: taskImageHeader(prompts) });
    pinned.push({ type: "image_url", image_url: { url: `data:image/png;base64,${renderPad(env.imagePad).toString("base64")}` } });
  }
  // Number-only tools are only a guarantee when the reply cannot be free text: the backend's function-calling mode ANY.
  const toolChoice = env.cfg.actionMode === "code" || !allowsForcedToolChoice(opts.model) ? "auto" : "required";
  const initialObs = env.observe();
  const history: Turn[] = [];
  /** Turns before this index are dropped for the context budget. It only grows, so the kept prefix stays cacheable. */
  let firstKept = 0;
  let cost = 0;
  let idle = 0;
  let requests = 0;
  let blocked = 0;
  let blockedNote = blockedMessage(prompts);

  const buildMessages = (): ChatMessage[] => {
    const start = Math.max(firstKept, opts.keepTurns > 0 ? history.length - opts.keepTurns : 0);
    const kept = history.filter((t, i) => i >= start || t.page);
    const dropped = start;
    const latestObs = [...kept].reverse().find((t) => t.obs)?.obs ?? initialObs;
    const msgs: ChatMessage[] = [system];
    if (dropped === 0) {
      msgs.push({ role: "user", content: [...pinned, ...obsParts(env, initialObs, 0, initialObs === latestObs, prompts)] });
    } else {
      msgs.push({ role: "user", content: [...pinned, { type: "text", text: droppedTurnsMessage(dropped, prompts) }] });
    }
    for (const t of kept) {
      if (t.assistant) msgs.push(t.assistant);
      msgs.push(...t.replies);
      if (t.obs) msgs.push({ role: "user", content: obsParts(env, t.obs, t.obsTurn, t.obs === latestObs, prompts) });
    }
    return msgs;
  };

  while (true) {
    // Slides: a finished page waits for the operator, with no requests sent; a turned page goes out once, as its recording.
    // Never between a blocked request and its resend, which narrows the line of the page it was about.
    if (env.waitingForPage && !opts.pageTurns) return { stopReason: "done", turns: env.turn, costUsd: cost };
    if (opts.pageTurns && blocked === 0) {
      if (env.waitingForPage) await opts.pageTurns.wait();
      if (opts.pageTurns.take() && env.turnPage()) {
        const text = `${pageTurnHeader(env.page + 1, env.pages.length, prompts)}\n${JSON.stringify(env.taskRecording())}`;
        history.push({ replies: [{ role: "user", content: [{ type: "text", text }] }], obs: null, obsTurn: env.turn, page: true });
      }
    }
    const started = Date.now();
    const requestIndex = ++requests;
    const body = {
      model: opts.model,
      messages: blocked > 0 ? [...buildMessages(), { role: "user", content: blockedNote } as ChatMessage] : buildMessages(),
      tools,
      tool_choice: toolChoice,
      reasoning: { effort: opts.reasoningEffort ?? "low" },
      max_tokens: opts.maxTokens,
      usage: { include: true },
      ...(opts.providers?.length ? { provider: { order: opts.providers, allow_fallbacks: false } } : {}),
    };
    opts.onRequest?.(requestIndex, body);
    let res: ChatResponse;
    try {
      res = await client.chat(body, (a) => opts.onAttempt?.(requestIndex, a));
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      opts.onResponse?.(requestIndex, null, error);
      // Each resend asks for less: a smaller part of the pad line (copy tasks), or a shorter
      // line of the answer (instruct tasks).
      if (isBlocked(error) && blocked < MAX_BLOCKED_RESENDS) {
        blocked++;
        blockedNote = env.narrowTaskLine() || env.cfg.taskKind === "copy" ? blockedMessage(prompts) : blockedShorterMessage(prompts);
        // Back off exponentially, so the resends span the minutes-to-hours the upstream blocks last
        // (measured 2026-11-03: a storm outlasted 12 fixed 10 s resends; jitter keeps parallel runs unsynchronized).
        const pause = Math.min(300_000, (opts.blockPauseMs ?? DEFAULT_BLOCK_PAUSE_MS) * 2 ** (blocked - 1));
        await sleep(pause * (0.8 + 0.4 * Math.random()));
        continue;
      }
      return { stopReason: "error", turns: env.turn, costUsd: cost, error };
    }
    blocked = 0;
    opts.onResponse?.(requestIndex, res);
    const turnCost = res.usage?.cost ?? 0;
    cost += turnCost;
    if ((res.usage?.prompt_tokens ?? 0) > maxContextTokens) firstKept += Math.max(1, Math.ceil((history.length - firstKept) / 4));
    const choice = res.choices[0];
    const { reasoning, ...assistant } = choice.message;
    assistant.role = "assistant";
    const text = typeof assistant.content === "string" ? assistant.content : null;
    // Free text that names the task's words must not accumulate in the conversation; the tool calls are kept.
    if (text !== null && env.hasTaskWords(text)) assistant.content = null;
    const toolCalls: ToolCallMsg[] = assistant.tool_calls ?? [];
    const refused = isRefusal(choice);

    const log = (calls: TurnLog["calls"], results: CallResult[]) =>
      opts.onTurn?.({
        turn: env.turn,
        request_index: requestIndex,
        text,
        // The whole reasoning, never cut: a turn's decision is usually at its end (it was cut at 4000 chars until 2026-11-02).
        reasoning: reasoning ? String(reasoning) : null,
        calls,
        results,
        finish_reason: choice.finish_reason,
        ...(refused ? { refused } : {}),
        provider: res.provider ?? null,
        usage: res.usage ?? null,
        cost_usd: turnCost,
        total_cost_usd: cost,
        elapsed_s: (Date.now() - started) / 1000,
      });

    // A safety-filter refusal is an outcome, not an idle reply: nudging and resending would only sample until one
    // gets past the filter. Nothing in the reply runs; the run ends.
    if (refused) {
      log([], []);
      return { stopReason: "refused", turns: env.turn, costUsd: cost, error: refusalMessage(requestIndex, choice) };
    }

    if (toolCalls.length === 0) {
      idle++;
      history.push({
        assistant,
        replies: [{ role: "user", content: noToolCallsMessage(prompts) }],
        obs: null,
        obsTurn: env.turn,
      });
      log([], []);
      // Idle because every reply ran out of output tokens before any tool call is not the agent choosing to stop.
      if (idle >= MAX_IDLE_TURNS) return { stopReason: choice.finish_reason === "length" ? "token_cap" : "idle", turns: env.turn, costUsd: cost };
      if (cost >= opts.maxCostUsd) return { stopReason: "max_cost", turns: env.turn, costUsd: cost };
      continue;
    }
    idle = 0;

    // Arguments that are not valid JSON end the batch there, like any other failed call.
    const calls: ToolCall[] = [];
    let badIndex = -1;
    let badReason = "";
    for (const [i, tc] of toolCalls.entries()) {
      try {
        const args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        calls.push({ name: tc.function.name, args: args ?? {} });
      } catch (e) {
        badIndex = i;
        badReason = `arguments are not valid JSON: ${e instanceof Error ? e.message : e}`;
        break;
      }
    }
    const step = env.step(calls);
    await opts.afterStep?.();
    const results: CallResult[] = [...step.results];
    if (badIndex >= 0) {
      results.push({ call: toolCalls[badIndex].function.name, status: "error", error: badReason });
      for (const tc of toolCalls.slice(badIndex + 1)) {
        results.push({ call: tc.function.name, status: "skipped", reason: "an earlier call in this turn failed" });
      }
    }
    history.push({
      assistant,
      replies: toolCalls.map((tc, i) => ({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(results[i]) })),
      obs: step.observation,
      obsTurn: env.turn,
    });
    log(
      toolCalls.map((tc, i) => ({ name: tc.function.name, args: calls[i]?.args ?? tc.function.arguments })),
      results,
    );

    if (step.done) {
      const stopReason = env.endReason === "stalled" ? "stalled" : env.endReason === "max_turns" ? "max_turns" : "done";
      return { stopReason, turns: env.turn, costUsd: cost };
    }
    if (cost >= opts.maxCostUsd) return { stopReason: "max_cost", turns: env.turn, costUsd: cost };
  }
}

/**
 * One observation as message parts. Only the latest carries the images and the glyph library, and its task line
 * is taken fresh from the environment, so a line narrowed after a block goes out as it now is.
 */
function obsParts(env: ScribeEnv, obs: Observation, turn: number, latest: boolean, prompts: PromptOverrides = {}): ContentPart[] {
  let json = obs.json;
  if ("task_line" in json && latest) json = { ...json, task_line: env.taskLine() };
  if ("page" in json && latest) json = { ...json, page: env.pageInfo() };
  if ("page_strokes" in json && !latest) {
    const rec = json.page_strokes as { lines: { stroke_count: number }[] };
    json = { ...json, page_strokes: `${rec.lines.reduce((a, l) => a + l.stroke_count, 0)} strokes ${OMITTED}` };
  }
  if ("glyph_library" in json && !latest) json = { ...json, glyph_library: `${(json.glyph_library as unknown[]).length} glyphs ${OMITTED}` };
  const parts: ContentPart[] = [{ type: "text", text: `${observationPrefix(turn, prompts)}${JSON.stringify(json)}` }];
  for (const img of obs.images) {
    if (latest) {
      parts.push({ type: "text", text: imageLabel(img.name, prompts) });
      parts.push({ type: "image_url", image_url: { url: `data:image/png;base64,${img.png.toString("base64")}` } });
    } else {
      parts.push({ type: "text", text: imageOmittedLabel(img.name, prompts) });
    }
  }
  return parts;
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}
