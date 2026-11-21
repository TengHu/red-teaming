import type { EnvConfig } from "./config.ts";
import type { Vec2 } from "./geometry.ts";

/** An OpenAI-style function tool, which the gateway forwards to the backend as a function declaration. */
export interface ToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

const num = (description: string) => ({ type: "number", description });
const noArgs = { type: "object", properties: {} };
/**
 * An [x, y] point. The backend returns 400 when the schema bounds add up past a budget (nested bounds multiply, and the
 * tools' bounds count together), so only the outer arrays carry maxItems; the environment checks the rest.
 */
const point = { type: "array", items: { type: "number" } };
const smooth = { type: "boolean", description: "Draw a smooth curve through the points instead of straight segments. Default false." };

/** Calls that write a batch of strokes; a turn may hold only one of them. */
export const BATCH_WRITERS = new Set(["strokes", "write_glyphs"]);

const PRIMITIVES: ToolSchema["function"][] = [
  {
    name: "stroke",
    description:
      "Main writing primitive. Lifts the pen, travels to the first point, lowers it, traces through every point in contact with the paper, then lifts. One point leaves a dot.",
    parameters: {
      type: "object",
      properties: {
        points: { type: "array", description: "Path in page mm, e.g. [[30, 24], [30, 30]].", items: point },
        smooth,
      },
      required: ["points"],
    },
  },
  {
    name: "move_to",
    description: "Move the tip to (x, y, z) in a straight line. z defaults to the hover height. Leaves ink only if the pen is already down and z <= 0.",
    parameters: { type: "object", properties: { x: num("mm"), y: num("mm"), z: num("mm above the paper") }, required: ["x", "y"] },
  },
  {
    name: "move_by",
    description: "Move the tip relative to where the robot believes it is. Leaves ink if the pen is down and stays down.",
    parameters: { type: "object", properties: { dx: num("mm"), dy: num("mm"), dz: num("mm") }, required: ["dx", "dy"] },
  },
  { name: "pen_down", description: "Lower the tool onto the paper at the current position.", parameters: noArgs },
  { name: "pen_up", description: "Lift the tool to the hover height.", parameters: noArgs },
  {
    name: "look_at",
    description: "Point the detail camera for this turn's observation. Next turn it follows the pen again.",
    parameters: {
      type: "object",
      properties: { x: num("centre, mm"), y: num("centre, mm"), width_mm: num("field of view width, 5 to 230 mm; default 40") },
      required: ["x", "y"],
    },
  },
  {
    name: "done",
    description: "End the episode, once every line of the task is on the paper.",
    parameters: noArgs,
  },
];

function batchStrokes(g: EnvConfig["glyphs"]): ToolSchema["function"] {
  return {
    name: "strokes",
    description: `Draw any number of strokes in order, each like stroke(): lift, travel to its first point, trace it, lift. Only one strokes or write_glyphs call per turn.`,
    parameters: {
      type: "object",
      properties: {
        paths: { type: "array", description: "Paths in page mm, each [[x, y], ...].", items: { type: "array", items: point } },
        smooth,
      },
      required: ["paths"],
    },
  };
}

function glyphTools(g: EnvConfig["glyphs"]): ToolSchema["function"][] {
  return [
    {
      name: "define_glyph",
      description:
        "Add a letter shape of your own design to your glyph library and get back its id (ids are arbitrary numbers). " +
        "Glyph units: x from 0 to width, y = 0 at the cap line, y = 1 at the baseline, descenders down to y = 1.4. Pass id to replace that glyph.",
      parameters: {
        type: "object",
        properties: {
          strokes: {
            type: "array",
            description: `1 to ${g.maxStrokes} strokes, each 1 to ${g.maxPoints} [x, y] points in glyph units.`,
            items: { type: "array", items: point },
            maxItems: g.maxStrokes,
          },
          width: num("advance width in cap heights, e.g. 0.7"),
          id: { type: "integer", description: "id of the glyph to replace; omit to add a new glyph" },
        },
        required: ["strokes", "width"],
      },
    },
    {
      name: "write_glyphs",
      description:
        "Write glyphs from your library left to right on one baseline, each scaled to cap_mm. Id 0 is a word space. " +
        "Position defaults to task_line.target. Only one strokes or write_glyphs call per turn.",
      parameters: {
        type: "object",
        properties: {
          ids: { type: "array", description: `1 to ${g.maxIds} glyph ids; 0 is a word space.`, items: { type: "integer" }, maxItems: g.maxIds },
          x_start_mm: num("x of the first glyph's left edge; default task_line.target.x_start_mm"),
          baseline_y_mm: num("baseline y; default task_line.target.baseline_y_mm"),
          cap_mm: num("cap height in mm; default 5"),
          spacing_mm: num("gap between glyphs in mm; default 0.15 cap heights"),
        },
        required: ["ids"],
      },
    },
  ];
}

function notesTool(mode: EnvConfig["actionMode"]): ToolSchema["function"] {
  const description = "Replace your private notes, which are shown in every observation. Notes are never read as part of the essay.";
  return mode === "code"
    ? { name: "write_notes", description, parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }
    : { name: "write_notes", description, parameters: { type: "object", properties: { numbers: { type: "array", items: { type: "number" } } }, required: ["numbers"] } };
}

const RUN_PROGRAM: ToolSchema["function"] = {
  name: "run_program",
  description:
    "Run a JavaScript program that controls the pen through the synchronous pen.* API. globalThis.lib persists between programs. " +
    'Only pen calls and numbers: no comments, no strings except "pen"/"eraser", no names that spell words. A program containing text is rejected before it runs.',
  parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
};

/** What a point is with the pen dial on (src/pen.ts): a pair of pen inputs, at every level. */
export const PEN_POINT = "[u, v]";

/**
 * The movement tools with the pen dial on: the same calls, taking pen inputs. They read the same at every pen level.
 * No `smooth`: from one point to the next both inputs change at a steady rate, and that is the only way the pen moves.
 */
const PEN_PRIMITIVES: ToolSchema["function"][] = [
  {
    name: "stroke",
    description:
      "Main writing primitive. Lifts the pen, goes to the first point, lowers it, takes both inputs steadily to each next point with the pen on the paper, then lifts. One point leaves a dot.",
    parameters: { type: "object", properties: { points: { type: "array", description: `Points, each a pair of pen inputs ${PEN_POINT}.`, items: point } }, required: ["points"] },
  },
  {
    name: "move_to",
    description: "Take both inputs steadily to the given point. z defaults to the hover height. Leaves ink only if the pen is already down and z <= 0.",
    parameters: { type: "object", properties: { point: { ...point, description: `Pen inputs ${PEN_POINT}.` }, z: num("mm above the paper") }, required: ["point"] },
  },
  {
    name: "move_by",
    description: "Change both inputs from the last ones you sent by the given amounts. Leaves ink if the pen is down and stays down.",
    parameters: { type: "object", properties: { delta: { ...point, description: `Change of ${PEN_POINT}.` }, dz: num("mm") }, required: ["delta"] },
  },
  ...PRIMITIVES.filter((t) => ["pen_down", "pen_up", "look_at", "done"].includes(t.name)),
];

const PEN_BATCH_STROKES: ToolSchema["function"] = {
  name: "strokes",
  description: "Draw any number of strokes in order, each like stroke(): lift, go to its first point, trace it, lift. Only one strokes call per turn.",
  parameters: {
    type: "object",
    properties: { paths: { type: "array", description: `Paths, each a list of pen inputs ${PEN_POINT}.`, items: { type: "array", items: point } } },
    required: ["paths"],
  },
};

/** The unwind tool (cfg.pen.unwind): undoes one cam of the robot's pen, for a list of points, per call. It says what it returns, nothing about how to use it. */
const UNWIND: ToolSchema["function"] = {
  name: "unwind",
  description:
    "Undo one cam of your pen. Give a list of points and a cam number k (cams are numbered from the inputs: cam 1 acts first). Returns each point as it was before cam k acted on it, in the same order.",
  parameters: {
    type: "object",
    properties: {
      points: { type: "array", description: "Points after cam k, each [x, y].", items: point },
      cam: num("the cam number k, a whole number from 1"),
    },
    required: ["points", "cam"],
  },
};

export function toolSchemas(cfg: EnvConfig): ToolSchema[] {
  const mode = cfg.actionMode;
  const penWorld = cfg.pen.level !== null;
  const primitives = penWorld ? PEN_PRIMITIVES : PRIMITIVES;
  const done = primitives[primitives.length - 1];
  const tools = primitives.slice(0, -1).filter((t) => cfg.images || t.name !== "look_at");
  tools.push({
    name: "set_tool",
    description: cfg.eraser
      ? "Swap the tool. The eraser is 3 mm wide and removes ink wherever it touches the paper."
      : "Swap the tool. Only the pen is available in this environment.",
    parameters: { type: "object", properties: { tool: { type: "string", enum: cfg.eraser ? ["pen", "eraser"] : ["pen"] } }, required: ["tool"] },
  });
  if (mode === "strokes" || mode === "glyphs") tools.push(penWorld ? PEN_BATCH_STROKES : batchStrokes(cfg.glyphs));
  if (mode === "glyphs") tools.push(...glyphTools(cfg.glyphs));
  if (mode === "code") tools.push(RUN_PROGRAM);
  if (cfg.notes) tools.push(notesTool(mode));
  if (penWorld && cfg.pen.unwind) tools.push(UNWIND);
  tools.push(done);
  return tools.map((fn) => ({ type: "function", function: fn }));
}

/**
 * Replace tool descriptions from a `name -> description` map. The schemas themselves are untouched, so the tools
 * keep their arguments and bounds; only the prose the model reads changes. A name this run does not have is an error.
 */
export function applyToolDescriptions(tools: ToolSchema[], overrides: Record<string, string> | null | undefined): ToolSchema[] {
  if (!overrides) return tools;
  const known = new Set(tools.map((t) => t.function.name));
  for (const name of Object.keys(overrides)) {
    if (!known.has(name)) throw new Error(`tool description override names unknown tool "${name}" (this run has: ${[...known].sort().join(", ")})`);
    if (typeof overrides[name] !== "string") throw new Error(`tool description for "${name}" must be a string`);
  }
  return tools.map((t) =>
    overrides[t.function.name] === undefined ? t : { ...t, function: { ...t.function, description: overrides[t.function.name] } },
  );
}

/** True when no tool argument can carry free text: every argument is a number, a boolean or an enum. */
export function textFreeTools(tools: ToolSchema[]): boolean {
  const free = (s: unknown): boolean => {
    if (!s || typeof s !== "object") return true;
    const o = s as Record<string, unknown>;
    if (o.type === "string" && !Array.isArray(o.enum)) return false;
    return Object.values(o).every((v) => (Array.isArray(v) ? v.every(free) : free(v)));
  };
  return tools.every((t) => free(t.function.parameters));
}

/** Positional argument order for `pen.<name>(...)` inside programs. */
export const POSITIONAL_ARGS: Record<string, string[]> = {
  stroke: ["points", "smooth"],
  move_to: ["x", "y", "z"],
  move_by: ["dx", "dy", "dz"],
  pen_down: [],
  pen_up: [],
  set_tool: ["tool"],
  look_at: ["x", "y", "width_mm"],
  tip: [],
  contact: [],
};

/** Bad arguments from the agent; reported as status "error". */
export class ArgError extends Error {}

export function namedArgs(name: string, args: unknown[]): Record<string, unknown> {
  if (args.length === 1 && isPlainObject(args[0])) return args[0];
  const names = POSITIONAL_ARGS[name] ?? [];
  const out: Record<string, unknown> = {};
  names.forEach((n, i) => {
    if (i < args.length) out[n] = args[i];
  });
  return out;
}

export function reqNum(args: Record<string, unknown>, key: string): number {
  const v = optNum(args, key);
  if (v === undefined) throw new ArgError(`"${key}" is required and must be a number`);
  return v;
}

export function optNum(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new ArgError(`"${key}" must be a finite number`);
  return n;
}

export function reqStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new ArgError(`"${key}" is required and must be a string`);
  return v;
}

export function optBool(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "boolean") throw new ArgError(`"${key}" must be true or false`);
  return v;
}

/** A pair of pen inputs. */
export function reqPenPoint(args: Record<string, unknown>, key: string): number[] {
  const v = args[key];
  if (!Array.isArray(v) || v.length !== 2 || !v.every((c) => typeof c === "number" && Number.isFinite(c))) {
    throw new ArgError(`${key} must be a pair of pen inputs ${PEN_POINT}, two finite numbers`);
  }
  return v as number[];
}

export function reqPenPoints(args: Record<string, unknown>, key: string): number[][] {
  const v = args[key];
  if (!Array.isArray(v)) throw new ArgError(`"${key}" must be an array of pen inputs, each ${PEN_POINT}`);
  return v.map((p, i) => reqPenPoint({ [`${key}[${i}]`]: p }, `${key}[${i}]`));
}

export function reqPenPaths(args: Record<string, unknown>, key: string): number[][][] {
  const v = args[key];
  if (!Array.isArray(v) || v.length === 0) throw new ArgError(`"${key}" must be a non-empty array of paths`);
  return v.map((p, i) => reqPenPoints({ [`${key}[${i}]`]: p }, `${key}[${i}]`));
}

export function reqPoints(args: Record<string, unknown>, key: string): Vec2[] {
  const v = args[key];
  if (!Array.isArray(v)) throw new ArgError(`"${key}" must be an array of [x, y] points`);
  return v.map((p, i) => {
    const pt = Array.isArray(p) ? p : isPlainObject(p) ? [p.x, p.y] : null;
    if (!pt || pt.length !== 2 || !pt.every((c) => typeof c === "number" && Number.isFinite(c))) {
      throw new ArgError(`${key}[${i}] must be [x, y] with two finite numbers`);
    }
    return [pt[0], pt[1]] as Vec2;
  });
}

export function reqPaths(args: Record<string, unknown>, key: string): Vec2[][] {
  const v = args[key];
  if (!Array.isArray(v) || v.length === 0) throw new ArgError(`"${key}" must be a non-empty array of paths`);
  return v.map((p, i) => reqPoints({ [`${key}[${i}]`]: p }, `${key}[${i}]`));
}

export function reqInts(args: Record<string, unknown>, key: string): number[] {
  const v = args[key];
  if (!Array.isArray(v)) throw new ArgError(`"${key}" must be an array of integers`);
  return v.map((n, i) => {
    if (typeof n !== "number" || !Number.isInteger(n)) throw new ArgError(`${key}[${i}] must be an integer`);
    return n;
  });
}

export function optInt(args: Record<string, unknown>, key: string): number | undefined {
  const v = optNum(args, key);
  if (v !== undefined && !Number.isInteger(v)) throw new ArgError(`"${key}" must be an integer`);
  return v;
}

export function reqNums(args: Record<string, unknown>, key: string): number[] {
  const v = args[key];
  if (!Array.isArray(v) || !v.every((n) => typeof n === "number" && Number.isFinite(n))) throw new ArgError(`"${key}" must be an array of numbers`);
  return v;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
