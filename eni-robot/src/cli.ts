import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { REASONING_EFFORTS, runArgon, turnOnDone, type ArgonOptions, type PageTurns, type ReasoningEffort, type TurnLog } from "./agents/argon.ts";
import { runScripted } from "./agents/scripted.ts";
import { ACTION_MODES, resolveConfig, TASK_KINDS, type ActionMode, type ConfigOverrides, type EnvConfig, type TaskKind } from "./config.ts";
import { ScribeEnv, splitDeck, type EnvEvent } from "./env.ts";
import { PROMPT_COMPONENTS, PROMPT_VARS, systemPrompt, type PromptComponent, type PromptOverrides } from "./prompt.ts";
import { renderSheet } from "./ink.ts";
import { BACKENDS, createClient, type AttemptLog, type Backend } from "./clients/index.ts";
import { startViewer, type Viewer } from "./server.ts";
import { padRecording, type TaskPad } from "./taskpad.ts";
import type { ToolSchema } from "./actions.ts";

const PKG_ROOT = path.resolve(import.meta.dirname, "..");

const USAGE = `Usage: node src/cli.ts <command> [options]

Commands
  argon       Let a model (--model, required) write by hand
  scripted    Write text with the built-in reference writer (no model, no API key)
  view <dir>  Replay a saved run in the 3D viewer
  prompts     List every prompt component and placeholder (also --list-prompt-components)

Episode options
  --task "..." | --task-file f   argon: what is handwritten on the task pad; the model gets its whole pen recording once, then writes its answer
  --slides f                     argon: a slide deck instead of --task-file: pages separated by a line "---", shown one at a time;
                                 press Enter in this terminal to turn the page (the model calls done() on each page and waits).
  --turn-on-done                 slides: no operator: turn the page as soon as the model has finished the current one (done(),
                                 or idling once the page is written); Enter is ignored
                                 A line "--" starts a new section on the same page, drawn below the one above and shown with it.
                                 Sections are numbered 1, 2, 3... across the deck
                                 A section whose first line is "[raw]" reaches the model as text in the recording, not as strokes (instruct and scan tasks)
  --task-image-file f            argon: a second handwritten page, sent as a picture if the file has text (default tasks/task-image.txt; empty or missing: none)
  --task-kind instruct|copy|scan instruct (default): the pad holds a request, and the model writes its own answer; copy: the model writes out the pad's text;
                                 scan: each pad page is a scanned document, possibly from a different writer, and the job comes from --policy (required)
  --policy "TEXT"                a standing operating policy for the scribe, added to the system prompt (e.g. how to handle the pad's request)
  --policy-file f                read the operating policy from a file instead (same as --policy "$(cat f)")
  --system-prompt "TEXT"         replace the whole system prompt with the text itself (placeholders still render)
  --system-prompt-file f         replace the whole system prompt with the contents of a file (same as --system-prompt "$(cat f)")
  --task-prompt "TEXT"           replace just the YOUR TASK section with the text itself
  --task-prompt-file f           replace just the YOUR TASK section with the contents of a file
  --prompt NAME=PATH             replace any other component (repeatable), e.g. --prompt system.writing=writing.txt;
                                 run the prompts command for every component name and placeholder
  --print-system-prompt          print the system prompt these flags produce, then exit (no model call)
  --tool-descriptions f          JSON object of tool name -> description; the tool schemas stay exactly as they are
  --tools-file f                 JSON array of OpenAI-style tools; replaces the whole tool set sent to the model
  --list-prompt-components       print every prompt component and placeholder, then exit
  --no-eraser                    remove the eraser from the tool set (the agent cannot erase its own writing)
  --text "..." | --text-file f   scripted: the exact text to write
  --mode glyphs|strokes|primitives|code   action mode (default strokes); every mode but code has number-only tools
  --max-turns N                  turn budget (default 300)
  --pen N                        the pen dial: the pen is machinery between two inputs and the tip, N cams deep (0: straight through; any whole
                                 number, no upper limit). Every point, in the pad's recording and in every tool, is a pair of pen inputs [u, v];
                                 the prompt and tools are the same at every N and never say how the pen works. Without --pen: the plain robot
  --pad-pen N                    with --pen: the pen the pad was recorded with, when it is not the robot's own
  --no-cam-rule                  with --pen: leave the cam rule (formula, zig, cam count) out of the prompt. The prompt then says nothing
                                 about how the pen works or how to work it: put that in --policy (the rule, or a method)
  --unwind                       with --pen: add the unwind tool: give a list of points and a cam number k, get back each point before
                                 cam k acted. One call undoes one cam. The prompt says nothing about it; say how to use it in --policy
  --noise MM                     per-point motion jitter (default 0.15)
  --drift MM_PER_M               calibration drift (default 0)
  --seed N                       world random seed
  --config file.json             any EnvConfig overrides
  --view                         serve the live 3D viewer and keep it open afterwards
  --port N                       viewer port (default 4321)
  --runs-dir dir                 where runs are saved (default ./runs)
  --save-obs                     save every observation image (always on for argon)
  --page-image                   after a turn with a strokes call, send the model a picture of the sheet (clean ink on white)
  --page-strokes                 after a turn with a strokes call, send the sheet's landed ink as pen strokes, in the pad recording's format

Argon options
  --model ID                     argon: the model to run, required: an OpenRouter id (e.g. google/gemini-4-argon), or a Gemini API id with --backend gemini
  --effort low|medium|high           reasoning effort (default low)
  --keep-turns N                 turns of history kept (default 0: every turn, trimmed only by --max-context-tokens)
  --max-context-tokens N         when a prompt passes this, the oldest quarter of the kept turns is dropped (default 500000)
  --max-cost USD                 stop when spend reaches this (default: no cap)
  --max-tokens N                 output token cap per turn, thinking included; a backstop, since the tool schemas bound each reply (default 16384)
  --backend openrouter|gemini    which model API to use (default openrouter). gemini: Google's own
                                 Gemini API, with thought signatures returned exactly as received
  --provider SLUG[,SLUG]         openrouter only: pin these upstream provider slugs, in order

Scripted options
  --cap-mm MM                    capital height (default 6)
`;

/** The two common overrides have their own flags; anything else goes through --prompt NAME=PATH. */
const PROMPT_HELP = `Prompt files: --system-prompt-file f replaces the whole system prompt, --task-prompt-file f just the
YOUR TASK section. For any other component use --prompt NAME=PATH, e.g. --prompt system.writing=writing.txt.
Run the prompts command for every component name and placeholder.`;

const OPTIONS = {
  task: { type: "string" },
  "task-file": { type: "string" },
  slides: { type: "string" },
  text: { type: "string" },
  "text-file": { type: "string" },
  mode: { type: "string" },
  "task-kind": { type: "string" },
  policy: { type: "string" },
  "policy-file": { type: "string" },
  "system-prompt": { type: "string" },
  "system-prompt-file": { type: "string" },
  "task-prompt": { type: "string" },
  "task-prompt-file": { type: "string" },
  "print-system-prompt": { type: "boolean", default: false },
  prompt: { type: "string", multiple: true },
  "tool-descriptions": { type: "string" },
  "tools-file": { type: "string" },
  "list-prompt-components": { type: "boolean", default: false },
  "no-eraser": { type: "boolean", default: false },
  pen: { type: "string" },
  "pad-pen": { type: "string" },
  "no-cam-rule": { type: "boolean", default: false },
  unwind: { type: "boolean", default: false },
  "max-turns": { type: "string" },
  noise: { type: "string" },
  drift: { type: "string" },
  seed: { type: "string" },
  config: { type: "string" },
  view: { type: "boolean", default: false },
  port: { type: "string", default: "4321" },
  "runs-dir": { type: "string" },
  "save-obs": { type: "boolean", default: false },
  "page-image": { type: "boolean", default: false },
  "page-strokes": { type: "boolean", default: false },
  "turn-on-done": { type: "boolean", default: false },
  "task-image-file": { type: "string" },
  model: { type: "string" },
  effort: { type: "string", default: "low" },
  "keep-turns": { type: "string", default: "0" },
  "max-context-tokens": { type: "string", default: "500000" },
  "max-cost": { type: "string" },
  "max-tokens": { type: "string", default: "16384" },
  provider: { type: "string" },
  backend: { type: "string", default: "openrouter" },
  "cap-mm": { type: "string", default: "6" },
  help: { type: "boolean", short: "h", default: false },
} as const;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: OPTIONS,
  });
  if (command === "prompts" || command === "--list-prompt-components" || values["list-prompt-components"]) {
    console.log("Prompt components (--system-prompt, --task-prompt, --system-prompt-file, --task-prompt-file, or --prompt NAME=PATH):\n  " + PROMPT_COMPONENTS.join("\n  "));
    console.log("\nPlaceholders a prompt file may use:\n  " + PROMPT_VARS.join("\n  "));
    return;
  }
  if (values.help || !command || command === "--help" || command === "help") {
    console.log(`${USAGE}\n${PROMPT_HELP}`);
    return;
  }
  loadDotEnv();

  if (command === "view") {
    if (!positionals[0]) throw new Error("usage: view <runDir>");
    return replay(path.resolve(positionals[0]), Number(values.port));
  }
  if (command !== "argon" && command !== "scripted") {
    console.error(USAGE);
    process.exit(1);
  }

  // ---- configure -------------------------------------------------------------
  const overrides: ConfigOverrides = values.config ? JSON.parse(readFileSync(values.config, "utf8")) : {};
  if (values.mode) {
    if (!ACTION_MODES.includes(values.mode as ActionMode)) throw new Error(`--mode must be one of ${ACTION_MODES.join(", ")}`);
    overrides.actionMode = values.mode as ActionMode;
  }
  if (values["task-kind"]) {
    if (!TASK_KINDS.includes(values["task-kind"] as TaskKind)) throw new Error(`--task-kind must be one of ${TASK_KINDS.join(", ")}`);
    overrides.taskKind = values["task-kind"] as TaskKind;
    if (overrides.taskKind === "scan" && !values.policy && !values["policy-file"]) {
      throw new Error("--task-kind scan needs --policy or --policy-file: the job comes from the operating policy, never from the pad");
    }
  }
  if (values.policy && values["policy-file"]) throw new Error("use --policy or --policy-file, not both");
  if (values["policy-file"]) overrides.agentPolicy = readFileSync(path.resolve(values["policy-file"]), "utf8").trim();
  if (values.policy) overrides.agentPolicy = values.policy;
  if (values["no-eraser"]) overrides.eraser = false;
  if (values.pen !== undefined) overrides.pen = { ...overrides.pen, level: Number(values.pen) };
  if (values["pad-pen"] !== undefined) overrides.pen = { ...overrides.pen, padLevel: Number(values["pad-pen"]) };
  if (values["no-cam-rule"]) overrides.pen = { ...overrides.pen, noCamRule: true };
  if (values["unwind"]) overrides.pen = { ...overrides.pen, unwind: true };
  // Working a pen out takes turns that leave no ink (hovering moves to see where the tip goes), so those turns never end the episode.
  if (values.pen !== undefined) overrides.lineFeed = { ...overrides.lineFeed, stallTurns: 0 };
  // The scripted writer copies its text in whole batches of strokes, not one task line per turn, so the line feed never stalls it.
  if (command === "scripted") {
    overrides.taskKind = "copy";
    overrides.lineFeed = { ...overrides.lineFeed, stallTurns: 0 };
  }
  if (values["max-turns"]) overrides.maxTurns = Number(values["max-turns"]);
  if (values.seed) overrides.seed = Number(values.seed);
  if (values["page-image"]) overrides.pageImage = true;
  if (values["page-strokes"]) overrides.pageStrokes = true;
  if (values.noise || values.drift) {
    overrides.noise = { ...overrides.noise };
    if (values.noise) overrides.noise.jitterMm = Number(values.noise);
    if (values.drift) overrides.noise.driftMmPerM = Number(values.drift);
  }
  const cfg = resolveConfig(overrides);
  const { overrides: promptOverrides, files: promptFiles } = loadPromptOverrides(values as Record<string, unknown>);
  const toolDescriptions = loadToolDescriptions(values["tool-descriptions"]);
  const tools = loadTools(values["tools-file"]);

  if (values.slides && command !== "argon") throw new Error("--slides is for argon");
  if (values["turn-on-done"] && !values.slides) throw new Error("--turn-on-done needs --slides");
  if (values.slides && (values.task || values["task-file"] || values["task-image-file"])) throw new Error("--slides replaces --task, --task-file and --task-image-file");
  const deck = values.slides ? splitDeck(readFileSync(values.slides, "utf8")) : null;
  const pages = deck ? deck.pages : null;
  const sectionCount = deck ? deck.parts.flat().length : 0;
  if (pages && !pages.length) throw new Error(`${values.slides} has no pages`);
  const rawSections = new Set(deck ? deck.parts.flat().filter((p) => p.raw).map((p) => p.section) : []);
  // Copy tasks feed the pad's drawn rows one by one; a raw row has no strokes to copy.
  if (rawSections.size && cfg.taskKind === "copy") throw new Error("raw ([raw]) deck sections work in instruct and scan tasks, not copy");
  const imageFile = values["task-image-file"] ?? path.join(PKG_ROOT, "tasks", "task-image.txt");
  const imageTask = command === "argon" && !pages && existsSync(imageFile) ? readFileSync(imageFile, "utf8").trim() : "";
  // Print the exact system message for these flags and stop: no run directory, no request.
  if (values["print-system-prompt"]) {
    process.stdout.write(
      systemPrompt(
        cfg,
        { keepTurns: Number(values["keep-turns"]), maxContextTokens: Number(values["max-context-tokens"]) },
        Boolean(imageTask),
        Math.max(1, pages?.length ?? 1),
        promptOverrides,
      ),
    );
    return;
  }

  const backend = values.backend as Backend;
  if (!BACKENDS.includes(backend)) throw new Error(`--backend must be one of ${BACKENDS.join(", ")}`);
  if (values.provider && backend !== "openrouter") throw new Error("--provider pins an OpenRouter provider; it does not apply to --backend " + backend);
  // OpenRouter takes GATEWAY_API_KEY (the OpenRouter key); Google's Gemini API takes GEMINI_API_KEY. Both in the repo's .env.
  const keyName = backend === "gemini" ? "GEMINI_API_KEY" : "GATEWAY_API_KEY";
  const apiKey = process.env[keyName];
  const client = apiKey ? createClient(backend, apiKey) : null;
  if (command === "argon" && !values.model) throw new Error("argon needs --model <id>, e.g. --model google/gemini-4-argon");
  if (command === "argon" && !client) throw new Error(`${keyName} is not set (put it in the repo's .env)`);

  if (!REASONING_EFFORTS.includes(values.effort as ReasoningEffort)) throw new Error(`--effort must be one of ${REASONING_EFFORTS.join(", ")}`);
  const prompt = pages
    ? pages[0]
    : command === "argon"
      ? (values["task-file"] ? readFileSync(values["task-file"], "utf8") : values.task ?? "").trim()
      : (values["text-file"] ? readFileSync(values["text-file"], "utf8") : values.text ?? "").trim();
  if (!prompt && !imageTask) throw new Error(command === "argon" ? "the task is empty" : "scripted needs --text or --text-file");
  const runDir = makeRunDir(values["runs-dir"] ? path.resolve(values["runs-dir"]) : path.join(PKG_ROOT, "runs"), command);
  const title = command === "argon" ? `${values.model}${values.backend !== "openrouter" ? ` (${values.backend})` : ""} · effort ${values.effort} · ${cfg.taskKind} · ${cfg.actionMode} mode${cfg.notes ? " · notes" : ""}${cfg.images ? " · images" : ""}${cfg.pageImage ? " · page image" : ""}${cfg.pageStrokes ? " · page strokes" : ""}${cfg.pen.level !== null ? ` · pen ${cfg.pen.level}` : ""}${cfg.pen.padLevel !== null ? ` · pad pen ${cfg.pen.padLevel}` : ""}${cfg.agentPolicy ? " · policy" : ""}${imageTask ? " · task image" : ""}${pages ? ` · slides ${pages.length} pages${sectionCount > pages.length ? `, ${sectionCount} sections` : ""}` : ""}` : "scripted reference writer";
  // The task is handwritten: the model receives the task pad's pen strokes, plus a picture of the second page if there is one.
  const env = await ScribeEnv.create(cfg, pages ? { pages, parts: deck!.parts } : { task: prompt, imageTask });
  const taskText = pages ? pages.join("\n---\n") : imageTask ? `${prompt}\n\n[second page, sent as a picture]\n${imageTask}` : prompt;
  const pad = env.taskPad!;
  const padInfo = (p: TaskPad): TaskPadInfo => ({ xMm: p.xMm, yMm: p.yMm, widthMm: p.widthMm, heightMm: p.heightMm, strokes: p.strokes });
  const taskPad: TaskPadInfo = padInfo(pad);
  const imagePad = env.imagePad ? padInfo(env.imagePad) : null;
  writeJson(path.join(runDir, "task-pad.json"), { ...taskPad, ...(pad.parts ? { parts: pad.parts } : {}), lines: pad.lines, recording: padRecording(pad), ...(env.rawSections(0).length ? { typed: env.rawSections(0) } : {}), imagePad });
  const meta = {
    agent: command,
    title,
    task: prompt,
    task_image: imageTask || null,
    ...(pages ? { pages } : {}),
    ...(deck && sectionCount > pages!.length ? { sections: deck.parts } : {}),
    model: command === "argon" ? values.model : null,
    backend: command === "argon" ? backend : null,
    provider: command === "argon" ? values.provider ?? null : null,
    started: new Date().toISOString(),
    config: cfg,
    ...(Object.keys(promptFiles).length ? { prompt_files: promptFiles } : {}),
    ...(values["policy-file"] ? { policy_file: path.resolve(values["policy-file"]) } : {}),
    ...(values["tool-descriptions"] ? { tool_descriptions_file: path.resolve(values["tool-descriptions"]) } : {}),
    ...(values["tools-file"] ? { tools_file: path.resolve(values["tools-file"]) } : {}),
  };
  writeJson(path.join(runDir, "run.json"), meta);

  // ---- wire up logging and the viewer -----------------------------------------
  const saveObs = command === "argon" || values["save-obs"];
  let viewer: Viewer | null = null;
  if (values.view) {
    viewer = await startViewer({ port: Number(values.port), hello: hello(cfg, title, taskText, "running", taskPad, imagePad), runDir });
    console.log(`viewer: ${viewer.url}`);
  }
  const log = new EventLog(path.join(runDir, "events.jsonl"));
  const savedImages: SavedImages = new Map();
  const attempts = new Map<number, AttemptLog[]>();
  env.onEvent((e: EnvEvent) => {
    if (e.t === "obs") {
      viewer?.broadcast(e as unknown as Record<string, unknown>);
      if (!saveObs) return;
      const images = e.images.map((img) => {
        const file = `obs/turn-${String(e.turn).padStart(4, "0")}-${img.name}.png`;
        writeFile(path.join(runDir, file), Buffer.from(img.png, "base64"));
        savedImages.set(sha1(img.png), file);
        return { name: img.name, url: `/run/${file}` };
      });
      log.push({ t: "obs", turn: e.turn, images });
      return;
    }
    log.push(e as unknown as Record<string, unknown>);
    viewer?.broadcast(e as unknown as Record<string, unknown>);
    if (e.t === "turn") log.flush();
    if (e.t === "page") {
      const p = env.taskPad!;
      writeJson(path.join(runDir, `task-pad-page-${e.page}.json`), { ...padInfo(p), ...(p.parts ? { parts: p.parts } : {}), lines: p.lines, recording: padRecording(p), ...(env.rawSections().length ? { typed: env.rawSections() } : {}) });
      console.log(`page ${e.page} of ${e.pages} is on the pad`);
    }
  });

  const turnLogs: TurnLog[] = [];

  // ---- run ---------------------------------------------------------------------
  let stopReason: string;
  let costUsd: number | null = null;
  let errorMsg: string | undefined;
  const t0 = Date.now();
  if (command === "scripted") {
    const r = runScripted(env, prompt, Number(values["cap-mm"]));
    stopReason = env.endReason ?? "max_turns";
    console.log(`scripted writer: ${r.turns} turns`);
  } else {
    const auto = values["turn-on-done"];
    const pageTurns = pages && pages.length > 1 ? (auto ? { ...turnOnDone(env), close: () => {} } : operatorPageTurns(env)) : null;
    if (pageTurns) console.log(`slides: page 1 of ${pages!.length}; ${auto ? "the page turns when the model finishes it" : "press Enter to turn the page"}`);
    const opts: ArgonOptions = {
      ...(pageTurns ? { pageTurns } : {}),
      ...(Object.keys(promptOverrides).length ? { prompts: promptOverrides } : {}),
      ...(toolDescriptions ? { toolDescriptions } : {}),
      ...(tools ? { tools } : {}),
      model: values.model!,
      reasoningEffort: values.effort as ReasoningEffort,
      keepTurns: Number(values["keep-turns"]),
      maxContextTokens: Number(values["max-context-tokens"]),
      maxCostUsd: values["max-cost"] ? Number(values["max-cost"]) : Infinity,
      maxTokens: Number(values["max-tokens"]),
      providers: values.provider?.split(",").map((p) => p.trim()),
      onRequest: (i, body) => {
        console.log(`  request ${i} sent at ${new Date().toLocaleTimeString("en-GB")} (turn ${env.turn + 1})`);
        writeFile(llmFile(runDir, "request", i), stringifyWithSavedImages(body, runDir, savedImages));
      },
      onAttempt: (i, a) => {
        attempts.set(i, [...(attempts.get(i) ?? []), a]);
        const { partial, ...summary } = a;
        appendFileSync(path.join(runDir, "llm", "attempts.jsonl"), JSON.stringify({ request: i, ...summary }) + "\n");
        if (!a.ok) console.log(`  request ${i}, attempt ${a.attempt} failed after ${a.duration_s.toFixed(1)} s via ${a.provider ?? "unknown provider"}, ${received(a)}: ${a.error?.slice(0, 300)}${a.retry_in_s ? ` (trying again in ${a.retry_in_s} s)` : ""}`);
      },
      onResponse: (i, res, error) => {
        writeJson(llmFile(runDir, "response", i), { ...(res ?? { error }), attempts: attempts.get(i) ?? [] });
        if (res) return;
        // A failed request produces no turn, so announce it here for the viewer's side panel and Model I/O drawer.
        const ev = { t: "agent", turn: env.turn + 1, request: i, error, calls: [] };
        log.push(ev);
        viewer?.broadcast(ev);
      },
      onTurn: (t) => {
        turnLogs.push(t);
        appendFileSync(path.join(runDir, "turns.jsonl"), JSON.stringify(t) + "\n");
        const ev = {
          t: "agent",
          turn: t.turn,
          request: t.request_index,
          text: t.text,
          reasoning: t.reasoning,
          calls: t.calls.map((c) => c.name),
          ...(t.refused ? { refused: true } : {}),
          total_cost_usd: t.total_cost_usd,
        };
        log.push(ev);
        viewer?.broadcast(ev);
        const errors = t.results.filter((r) => r.status === "error").length;
        if (t.refused) console.log(`turn ${String(t.turn + 1).padStart(3)}  REFUSED by the model provider's safety filter (request ${t.request_index})  $${t.total_cost_usd.toFixed(3)}${t.provider ? `  [${t.provider}]` : ""}`);
        else console.log(
          `turn ${String(t.turn).padStart(3)}  ${t.calls.length} calls${errors ? ` (${errors} error)` : ""}  ` +
            `${t.elapsed_s.toFixed(1)} s  $${t.total_cost_usd.toFixed(3)}  ${summarize(t.calls.map((c) => c.name))}${t.provider ? `  [${t.provider}]` : ""}`,
        );
        if (env.waitingForPage) console.log(`page ${env.page + 1} is done; press Enter to turn the page`);
      },
    };
    const r = await runArgon(env, client!, opts).finally(() => pageTurns?.close());
    stopReason = r.stopReason;
    costUsd = r.costUsd;
    errorMsg = r.error;
    if (r.error) console.error(r.stopReason === "refused" ? `stopped: ${r.error}` : `stopped on error: ${r.error}`);
  }
  log.flush();
  env.close();
  const wallS = (Date.now() - t0) / 1000;
  console.log(`episode ended: ${stopReason} after ${env.turn} turns, ${wallS.toFixed(0)} s${costUsd !== null ? `, $${costUsd.toFixed(3)}` : ""}`);

  savePaper(env, runDir);
  writeJson(path.join(runDir, "run.json"), {
    ...meta,
    finished: new Date().toISOString(),
    stop_reason: stopReason,
    error: errorMsg,
    cost_usd: costUsd,
    wall_s: wallS,
  });
  console.log(`run saved to ${runDir}`);

  if (viewer) {
    viewer.broadcast({ t: "status", text: `finished: ${stopReason}`, error: errorMsg });
    console.log(`viewer still running at ${viewer.url} (Ctrl-C to quit)`);
  }
}

/** The operator's page turns: each Enter in the terminal queues one, up to the last page. */
function operatorPageTurns(env: ScribeEnv): PageTurns & { close(): void } {
  let queued = 0;
  let wake: (() => void) | null = null;
  const rl = createInterface({ input: process.stdin });
  rl.on("line", () => {
    const next = env.page + queued + 2;
    if (next > env.pages.length) return void console.log("already on the last page");
    queued++;
    console.log(env.waitingForPage ? `turning to page ${next}` : `page ${next} goes on the pad after this turn`);
    wake?.();
    wake = null;
  });
  return {
    take: () => (queued > 0 ? (queued--, true) : false),
    wait: () => (queued > 0 ? Promise.resolve() : new Promise<void>((r) => (wake = r))),
    close: () => rl.close(),
  };
}

/** Save the paper twice: as it looks on the desk (paper.png), and as clean ink on white (paper-ink.png). */
function savePaper(env: ScribeEnv, runDir: string): void {
  const sheet = env.world.sheet;
  if (sheet.strokes === 0) return;
  writeFile(path.join(runDir, "paper.png"), renderSheet(env.cfg, sheet.ink, 5, { ruling: true }));
  writeFile(path.join(runDir, "paper-ink.png"), renderSheet(env.cfg, sheet.ink, env.cfg.inkPxPerMm, { ruling: false }));
}

async function replay(runDir: string, port: number): Promise<void> {
  const meta = JSON.parse(readFileSync(path.join(runDir, "run.json"), "utf8"));
  const padFile = path.join(runDir, "task-pad.json");
  const taskPad = existsSync(padFile) ? (JSON.parse(readFileSync(padFile, "utf8")) as TaskPadInfo & { imagePad?: TaskPadInfo | null }) : null;
  const task = meta.task_image ? `${meta.task}\n\n[second page, sent as a picture]\n${meta.task_image}` : meta.pages ? meta.pages.join("\n---\n") : meta.task;
  const viewer = await startViewer({ port, hello: hello(meta.config, meta.title, task, "replay", taskPad, taskPad?.imagePad ?? null), runDir });
  const events = readFileSync(path.join(runDir, "events.jsonl"), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  for (const e of events) viewer.broadcast(e);
  // Runs recorded before failed requests were logged as events: recover a final failed request from its response file.
  const lastRequest = Math.max(0, ...events.filter((e) => e.t === "agent").map((e) => e.request ?? 0));
  const next = llmFile(runDir, "response", lastRequest + 1);
  if (meta.error && existsSync(next)) {
    const lastTurn = Math.max(0, ...events.filter((e) => e.t === "turn").map((e) => e.turn));
    viewer.broadcast({ t: "agent", turn: lastTurn + 1, request: lastRequest + 1, error: JSON.parse(readFileSync(next, "utf8")).error, calls: [] });
  }
  viewer.broadcast({ t: "status", text: `replay: ${meta.stop_reason ?? "unfinished"}`, error: meta.error });
  console.log(`replaying ${runDir} at ${viewer.url} (Ctrl-C to quit)`);
}

/**
 * Load prompt components: --system-prompt-file replaces the whole system prompt, --task-prompt-file
 * just the task section, and --prompt NAME=PATH (repeatable) any other component. --prompt is applied last.
 */
function loadPromptOverrides(values: Record<string, unknown>): {
  overrides: PromptOverrides;
  files: Partial<Record<PromptComponent, string>>;
} {
  const overrides: PromptOverrides = {};
  const files: Partial<Record<PromptComponent, string>> = {};
  const set = (name: string, file: string): void => {
    if (!(PROMPT_COMPONENTS as readonly string[]).includes(name)) {
      throw new Error(`unknown prompt component "${name}"; run the prompts command for the full list`);
    }
    const resolved = path.resolve(file);
    overrides[name as PromptComponent] = readFileSync(resolved, "utf8");
    files[name as PromptComponent] = resolved;
  };

  if (typeof values["system-prompt"] === "string" && typeof values["system-prompt-file"] === "string") {
    throw new Error("use --system-prompt or --system-prompt-file, not both");
  }
  if (typeof values["task-prompt"] === "string" && typeof values["task-prompt-file"] === "string") {
    throw new Error("use --task-prompt or --task-prompt-file, not both");
  }
  if (typeof values["system-prompt"] === "string") overrides.system = values["system-prompt"];
  if (typeof values["system-prompt-file"] === "string") set("system", values["system-prompt-file"]);
  if (typeof values["task-prompt"] === "string") overrides["system.task"] = values["task-prompt"];
  if (typeof values["task-prompt-file"] === "string") set("system.task", values["task-prompt-file"]);
  for (const spec of (values.prompt as string[] | undefined) ?? []) {
    const at = spec.indexOf("=");
    if (at < 0) throw new Error(`--prompt needs NAME=PATH, got "${spec}"`);
    set(spec.slice(0, at).trim(), spec.slice(at + 1).trim());
  }

  return { overrides, files };
}

/** A JSON object of tool name -> description. The schemas themselves are not touched. */
function loadToolDescriptions(file: string | undefined): Record<string, string> | null {
  if (!file) return null;
  const parsed: unknown = JSON.parse(readFileSync(path.resolve(file), "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--tool-descriptions needs a JSON object of tool name -> description");
  }
  for (const [name, description] of Object.entries(parsed)) {
    if (typeof description !== "string") throw new Error(`--tool-descriptions: "${name}" must map to a string`);
  }
  return parsed as Record<string, string>;
}

/**
 * A complete tool set from a JSON array of OpenAI-style tools. It replaces the environment's own tools, so the
 * names and arguments the model sees are entirely up to the file; the environment still checks every call it gets.
 */
function loadTools(file: string | undefined): ToolSchema[] | null {
  if (!file) return null;
  const parsed: unknown = JSON.parse(readFileSync(path.resolve(file), "utf8"));
  if (!Array.isArray(parsed)) throw new Error("--tools-file needs a JSON array of OpenAI-style tools");
  const seen = new Set<string>();
  parsed.forEach((tool, i) => {
    const t = tool as { type?: unknown; function?: { name?: unknown; description?: unknown; parameters?: unknown } };
    if (!t || typeof t !== "object" || t.type !== "function") throw new Error(`--tools-file: tool ${i} needs "type": "function"`);
    if (!t.function || typeof t.function.name !== "string" || !t.function.name) throw new Error(`--tools-file: tool ${i} needs function.name`);
    if (typeof t.function.description !== "string") throw new Error(`--tools-file: tool "${t.function.name}" needs function.description`);
    if (!t.function.parameters || typeof t.function.parameters !== "object") throw new Error(`--tools-file: tool "${t.function.name}" needs function.parameters`);
    if (seen.has(t.function.name)) throw new Error(`--tools-file: duplicate tool name "${t.function.name}"`);
    seen.add(t.function.name);
  });
  return parsed as ToolSchema[];
}

/** Where the viewer should lay a task pad on the desk, and the strokes written on it. */
interface TaskPadInfo {
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
  strokes: number[][][];
}

/** taskPad: the pad sent as a stroke recording. imagePad: the second page, sent as a picture (null if none). */
function hello(cfg: EnvConfig, title: string, task: string, status: string, taskPad: TaskPadInfo | null, imagePad: TaskPadInfo | null = null) {
  return { t: "hello", cfg, title, task, status, taskPad, imagePad };
}

class EventLog {
  private buf: string[] = [];
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
  }
  push(e: Record<string, unknown>): void {
    this.buf.push(JSON.stringify(e));
  }
  flush(): void {
    if (!this.buf.length) return;
    appendFileSync(this.file, this.buf.join("\n") + "\n");
    this.buf = [];
  }
}

function makeRunDir(root: string, agent: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const dir = path.join(root, `${stamp}-${agent}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** What a failed attempt had produced before it ended. */
function received(a: AttemptLog): string {
  const { content_chars: text, reasoning_chars: thinking, tool_call_chars: calls } = a.received;
  if (!text && !thinking && !calls) return a.first_byte_s === null ? "no response" : "no output yet";
  return `got ${thinking} chars of reasoning, ${text} of text, ${calls} of tool calls (first after ${a.first_output_s?.toFixed(1)} s)`;
}

function writeFile(file: string, data: string | Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
}

function writeJson(file: string, data: unknown): void {
  writeFile(file, JSON.stringify(data, null, 2) + "\n");
}

/** sha1 of a base64 PNG -> its path in the run directory. */
type SavedImages = Map<string, string>;
const DATA_PNG = "data:image/png;base64,";

function llmFile(runDir: string, kind: "request" | "response", index: number): string {
  return path.join(runDir, "llm", `${kind}-${String(index).padStart(4, "0")}.json`);
}

/**
 * The request body exactly as sent, except each base64 image becomes "saved:<path>" pointing at the
 * same PNG in the run directory. Images not saved yet (none, normally) are written to llm/ first.
 */
function stringifyWithSavedImages(body: unknown, runDir: string, saved: SavedImages): string {
  const json = JSON.stringify(
    body,
    (_key, v) => {
      if (typeof v !== "string" || !v.startsWith(DATA_PNG)) return v;
      const b64 = v.slice(DATA_PNG.length);
      const key = sha1(b64);
      let file = saved.get(key);
      if (!file) {
        file = `llm/img-${key.slice(0, 12)}.png`;
        writeFile(path.join(runDir, file), Buffer.from(b64, "base64"));
        saved.set(key, file);
      }
      return `saved:${file}`;
    },
    2,
  );
  return json + "\n";
}

function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

/** Load the first .env found walking up from the working directory, then from this package. */
function loadDotEnv(): void {
  for (const start of [process.cwd(), PKG_ROOT]) {
    for (let dir = start; ; dir = path.dirname(dir)) {
      const file = path.join(dir, ".env");
      if (existsSync(file)) return process.loadEnvFile(file);
      if (path.dirname(dir) === dir) break;
    }
  }
}

function summarize(names: string[]): string {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts].map(([k, v]) => (v > 1 ? `${k}×${v}` : k)).join(" ");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
