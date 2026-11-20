/**
 * Which tools the agent gets. Every mode but `code` has only number arguments (and the "pen"/"eraser" enum),
 * so the model can be held to function calls whose arguments cannot carry text.
 * strokes (default): primitives + strokes. glyphs: strokes + define_glyph/write_glyphs. code: primitives + run_program.
 * On the direct backend API with the whole recording in context (Oct 28, 2026), one line as raw strokes in the
 * model's own shapes came through 2 of 3 times; one line as a write_glyphs id sequence 0 of 2. Measured on the direct API, Oct 28 2026 — see docs/env-design.md.
 */
export type ActionMode = "glyphs" | "strokes" | "primitives" | "code";
export const ACTION_MODES: ActionMode[] = ["glyphs", "strokes", "primitives", "code"];

/**
 * What the handwriting on the task pad is. instruct: a request to carry out by writing an answer of the agent's own.
 * copy: text to write out on the paper, line for line. scan: each pad page is a scanned document, possibly from a different
 * writer; the job comes from the operating policy (agentPolicy), never from the pad, and the agent writes its own lines per page.
 */
export type TaskKind = "instruct" | "copy" | "scan";
export const TASK_KINDS: TaskKind[] = ["instruct", "copy", "scan"];

export interface EnvConfig {
  sheet: {
    widthMm: number;
    heightMm: number;
    /** Pitch of the printed ruling; null for blank paper. */
    rulingMm: number | null;
    firstLineMm: number;
    lastLineMm: number;
    /** x of the printed margin line; null for none. */
    marginLineMm: number | null;
  };
  pen: {
    widthMm: number;
    eraserWidthMm: number;
    hoverMm: number;
    maxZMm: number;
    travelMmPerS: number;
    writeMmPerS: number;
    /** Time to lower or lift the pen. */
    liftS: number;
    /**
     * The pen dial (src/pen.ts). null (the default): the plain robot, whose points are positions on the paper, as it
     * always was. A whole number N from 0 up, no upper limit: the pen is machinery between two inputs and the tip, N
     * cams deep; every point is a pair of pen inputs [u, v], in the pad's recording and in every movement tool, and the
     * system prompt and tools are the same for every N. 0 passes the inputs straight through. Strokes and primitives
     * modes only.
     */
    level: number | null;
    /**
     * The pen the task pad was recorded with, when it is not the robot's own: its level. null (the default): the same
     * pen as the robot. Only with `level` set. For telling input and output apart, e.g. `--pen 6 --pad-pen 0`.
     */
    padLevel: number | null;
    /**
     * Leave the cam rule out of the prompt (--no-cam-rule): no formula, no zig, no cam count, only "How the machinery
     * works is not told to you". Nothing is added about how to work the pen. Only with `level` set.
     */
    noCamRule: boolean;
    /**
     * The unwind tool (--unwind): give a list of points and a cam number k, get back each point before cam k acted. One
     * call undoes one cam, so finding the inputs for a set of points takes as many calls as the pen has cams. Only with
     * `level` set.
     */
    unwind: boolean;
  };
  noise: {
    /** Std dev of the positioning error at any point. */
    jitterMm: number;
    /** Path distance over which the error decorrelates, so curves wobble smoothly instead of zig-zagging. */
    correlationMm: number;
    /** Random-walk calibration drift, std dev in mm per metre travelled. */
    driftMmPerM: number;
  };
  inkPxPerMm: number;
  camera: {
    overviewPxPerMm: number;
    detailSizePx: [number, number];
    detailWidthMm: number;
    /** Margin around each agent image that holds the tick labels. */
    gutterPx: number;
  };
  actionMode: ActionMode;
  taskKind: TaskKind;
  /** The eraser tool: swap to it with set_tool and remove ink. false removes it from the tool set entirely. */
  eraser: boolean;
  /**
   * A standing operating policy for the agent, injected into the system prompt when set. Diegetic: the scribe's
   * own professional rules (e.g. "do exactly what the pad asks, in the form it asks"). null: no policy section.
   */
  agentPolicy: string | null;
  /**
   * Send the overview and detail camera images to the agent (and offer look_at). Off: the agent perceives only
   * the observation JSON; the images are still rendered for the viewer and the run log.
   */
  images: boolean;
  /** After a turn with a strokes (or write_glyphs) call, send a picture of the sheet: clean ink on white. */
  pageImage: boolean;
  /** After a turn with a strokes call, send the sheet's landed ink as pen strokes, in the pad recording's format. */
  pageStrokes: boolean;
  /** Offer write_notes, a private notepad shown in every observation. Off makes long episodes a memory test. */
  notes: boolean;
  maxTurns: number;
  maxCallsPerTurn: number;
  maxStrokePoints: number;
  /** Longest write_notes content, in characters. */
  maxNotesChars: number;
  /** textCheck rejects a program that contains a comment, a string or a word of the task before it runs. */
  program: { callBudget: number; cpuMs: number; memoryMb: number; textCheck: boolean };
  /**
   * Limits of the batch writing tools. maxStrokes and maxIds are also sent as maxItems in the schemas (strokes has no
   * limit on its paths since 2026-11-02),
   * which the backend enforces while generating; maxPoints is checked only by the environment, because the backend rejects
   * schemas whose bounds add up past a budget.
   */
  glyphs: { maxGlyphs: number; maxStrokes: number; maxPoints: number; maxIds: number };
  /**
   * How the agent's writing is paced. Instruct tasks may write several lines in a turn; in copy tasks the line feeder names the pad line
   * (or part of one) to write; in instruct tasks each turn's line is the next line of the agent's own answer.
   * A piece is accepted when the turn adds at least max(minInkMm, inkFraction * the piece's own ink) of pen ink;
   * after stallTurns turns without that the episode ends (0 never ends it). A blocked reply halves the piece,
   * never below minPieceStrokes strokes.
   */
  lineFeed: { minPieceStrokes: number; stallTurns: number; inkFraction: number; minInkMm: number };
  seed: number;
}

export const DEFAULT_CONFIG: EnvConfig = {
  sheet: { widthMm: 210, heightMm: 297, rulingMm: 10, firstLineMm: 30, lastLineMm: 280, marginLineMm: 25 },
  pen: { widthMm: 0.6, eraserWidthMm: 3, hoverMm: 3, maxZMm: 30, travelMmPerS: 150, writeMmPerS: 50, liftS: 0.08, level: null, padLevel: null, noCamRule: false, unwind: false },
  noise: { jitterMm: 0.15, correlationMm: 3, driftMmPerM: 0 },
  inkPxPerMm: 10,
  camera: { overviewPxPerMm: 4, detailSizePx: [960, 720], detailWidthMm: 40, gutterPx: 36 },
  actionMode: "strokes",
  taskKind: "instruct",
  eraser: true,
  agentPolicy: null,
  images: false,
  pageImage: false,
  pageStrokes: false,
  notes: false,
  maxTurns: 300,
  maxCallsPerTurn: 32,
  maxStrokePoints: 400,
  maxNotesChars: 20000,
  program: { callBudget: 2000, cpuMs: 10000, memoryMb: 64, textCheck: true },
  glyphs: { maxGlyphs: 120, maxStrokes: 8, maxPoints: 40, maxIds: 80 },
  lineFeed: { minPieceStrokes: 8, stallTurns: 3, inkFraction: 0.4, minInkMm: 10 },
  seed: 1,
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };
export type ConfigOverrides = DeepPartial<EnvConfig>;

export function resolveConfig(overrides: ConfigOverrides = {}): EnvConfig {
  const cfg = merge(structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>, overrides) as unknown as EnvConfig;
  for (const key of ["level", "padLevel"] as const) {
    const v = cfg.pen[key];
    if (v !== null && (!Number.isInteger(v) || v < 0)) throw new Error(`pen.${key} must be a whole number from 0 up, got ${JSON.stringify(v)}`);
  }
  if (cfg.pen.padLevel !== null && cfg.pen.level === null) throw new Error("pen.padLevel needs pen.level: the pad has a pen of its own only when the robot has one");
  if (cfg.pen.unwind && cfg.pen.level === null) throw new Error("pen.unwind needs pen.level: only the pen dial's pen has cams to undo");
  if (cfg.pen.noCamRule && cfg.pen.level === null) throw new Error("pen.noCamRule needs pen.level: only the pen dial's pen has a cam rule to leave out");
  if (cfg.pen.level !== null && cfg.actionMode !== "strokes" && cfg.actionMode !== "primitives") throw new Error(`the pen dial works in strokes or primitives mode, not ${cfg.actionMode} mode`);
  return cfg;
}

function merge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    if (!(k in base)) throw new Error(`unknown config key: ${k}`);
    const cur = base[k];
    if (v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)) {
      merge(cur as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      base[k] = v;
    }
  }
  return base;
}

/** y positions of the printed ruled lines, top to bottom. */
export function ruledLines(cfg: EnvConfig): number[] {
  const { rulingMm, firstLineMm, lastLineMm } = cfg.sheet;
  if (!rulingMm) return [];
  const ys: number[] = [];
  for (let y = firstLineMm; y <= lastLineMm + 1e-6; y += rulingMm) ys.push(Math.round(y * 1000) / 1000);
  return ys;
}
