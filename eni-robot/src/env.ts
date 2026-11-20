import {
  ArgError,
  BATCH_WRITERS,
  namedArgs,
  optBool,
  optInt,
  optNum,
  reqInts,
  reqNum,
  reqNums,
  reqPaths,
  reqPenPaths,
  reqPenPoint,
  reqPenPoints,
  reqPoints,
  reqStr,
  toolSchemas,
  type ToolSchema,
} from "./actions.ts";
import { describeImage, detailRegion, renderDetail, renderOverview } from "./camera.ts";
import { ruledLines, type EnvConfig } from "./config.ts";
import { round, type Vec2 } from "./geometry.ts";
import { GlyphLibrary } from "./glyphs.ts";
import { renderSheet } from "./ink.ts";
import { LineFeeder } from "./linefeed.ts";
import { checkProgram, hasTaskWords, taskWords } from "./program-check.ts";
import { ProgramSandbox } from "./sandbox.ts";
import { makeTaskPad, makeTaskPadParts, type TaskPad } from "./taskpad.ts";
import { inputDecimals, penFor, thin, undoCam } from "./pen.ts";
import { ActionError, World, type WorldEvent } from "./world.ts";

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface CallResult {
  call: string;
  status: "ok" | "clipped" | "error" | "skipped";
  [key: string]: unknown;
}

export interface Observation {
  json: Record<string, unknown>;
  images: { name: string; png: Buffer }[];
}

export interface StepResult {
  results: CallResult[];
  observation: Observation;
  done: boolean;
  /** True when the episode ended because the turn budget ran out. */
  truncated: boolean;
}

/**
 * Why an episode ended: the agent called done; every task line was accepted and the agent then idled;
 * a task line got no ink for too many turns; the turn budget ran out.
 */
export type EndReason = "done" | "complete" | "stalled" | "max_turns" | "paper_full";

export type EnvEvent =
  | WorldEvent
  | { t: "turn"; turn: number; results: CallResult[] }
  | { t: "obs"; turn: number; images: { name: string; png: string }[] }
  | { t: "page"; turn: number; page: number; pages: number; taskPad: PadInfo };

/** Where a task pad lies on the desk and what is on it, for the viewer and the run log. */
export interface PadInfo {
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
  strokes: Vec2[][];
}

interface Bbox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const FRAME =
  "page frame, mm: origin at the top-left corner of the sheet, +x right, +y down the page, +z up off the paper; z = 0 is the paper surface";
const PAD_FRAME = "pad mm: origin at the top-left corner of the pad, +x right, +y down";
/** The pad's frame with the pen dial on: its recording is pen inputs, whatever the level. */
/** Where the robot believes the tip is on the paper, [x, y] in page mm. */
const tipOf = (w: World): number[] => [round(w.cmd[0], 2), round(w.cmd[1], 2)];
const PEN_PAD_FRAME = "pen inputs [u, v] of the pad's pen; the pad itself is size_mm, origin at its top-left corner, +x right, +y down";
const DEFAULT_CAP_MM = 5;
/** Resolution of the page image: an A4 sheet comes out 840 x 1188 px, 5 mm capitals about 20 px tall. */
const PAGE_PX_PER_MM = 4;
/** Space between the stroke pad and the image pad on the desk, bezels included. */
const IMAGE_PAD_GAP_MM = 30;
/** Line layout on blank (unruled) paper. */
const BLANK_FIRST_MM = 30;
const BLANK_PITCH_MM = 10;

/** One section of a slide deck, numbered 1, 2, 3... in deck order across all pages. */
export interface DeckPart {
  section: number;
  text: string;
  /** A raw section: given to the agent as typed text in the page's recording, never drawn as pen strokes. */
  raw?: true;
}

/** A deck section whose first line is exactly this is raw: typed text, not handwriting (the marker line is dropped). */
export const RAW_MARKER = "[raw]";

/**
 * A slide deck. A line of only "---" starts a new pad page (the operator turns the page); a line of only "--" starts a
 * new section on the same pad page, drawn below the one above and shown with it. `pages` is each pad page's text
 * (its sections joined by line breaks); `parts` its sections. A deck with no "--" has one section per page, numbered
 * like the pages. A section whose first line is "[raw]" is raw (see DeckPart.raw); it keeps its section number.
 */
export function splitDeck(text: string): { pages: string[]; parts: DeckPart[][] } {
  const parts: DeckPart[][] = [];
  let n = 0;
  for (const page of text.split(/^---[ \t]*$/m)) {
    const sections = page
      .split(/^--[ \t]*$/m)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((t): DeckPart => {
        const [first, ...rest] = t.split("\n");
        if (first.trim() !== RAW_MARKER) return { section: ++n, text: t };
        const body = rest.join("\n").trim();
        if (!body) throw new Error(`deck section ${n + 1} is marked ${RAW_MARKER} but has no text`);
        return { section: ++n, text: body, raw: true };
      });
    if (sections.length) parts.push(sections);
  }
  return { pages: parts.map((ps) => ps.map((p) => p.text).join("\n")), parts };
}

/** The pages of a slide deck (see splitDeck): each pad page's text. */
export function splitPages(text: string): string[] {
  return splitDeck(text).pages;
}

/** Where the current task line goes on the paper. */
export interface Target {
  baseline_y_mm: number;
  x_start_mm: number;
}

/**
 * The environment the agent acts in: a turn is a batch of tool calls, answered by one observation.
 * Agents (Argon, the scripted writer) drive it through `observe()` and `step()`.
 * The task is handwriting on a task pad: the agent gets the whole pen recording once (`taskRecording()`),
 * and each observation's task_line says where the one line to write this turn goes: the next pad line to copy
 * (copy tasks), or the next line of the agent's own answer (instruct tasks).
 */
export class ScribeEnv {
  readonly world: World;
  turn = 0;
  /** Text in code mode; numbers in every other mode, whose tools carry no text. */
  notes: string | number[] = "";
  /** The agent's own font (glyphs mode only). */
  glyphs: GlyphLibrary | null = null;
  finished = false;
  endReason: EndReason | null = null;
  /** The task, handwritten on a task pad. The agent gets it only as pen strokes, one line at a time. */
  taskPad: TaskPad | null = null;
  /** A second handwritten page of the task, given to the agent as a picture. Null when there is none. */
  imagePad: TaskPad | null = null;
  private feeder: LineFeeder | null = null;
  /** Slides: the text of every page, and the 0-based page on the pad now. One page when the task is not a deck. */
  pages: string[] = [];
  /** Slides: each page's deck sections (one per page unless the deck uses "--"). */
  pageParts: DeckPart[][] = [];
  page = 0;
  /** Slides: the agent finished a page that is not the last; it waits for the operator to turn the page. */
  waitingForPage = false;
  /** Instruct tasks: lines of the answer written so far, and turns in a row that added none. */
  private answer: { lines: number; stall: number } | null = null;
  private words = new Set<string>();
  /** Task lines accepted on the paper; the next line goes on the ruled line below them. */
  private linesOnPaper = 0;
  /** Pen ink laid down in the current turn, and by the turn that last completed a piece of the task. */
  private turnInk: Bbox | null = null;
  private lastPieceInk: Bbox | null = null;
  private lastResults: CallResult[] = [];
  /** strokes / write_glyphs calls made this turn; only one is allowed. */
  private batchCalls = 0;
  /** The last turn made a strokes or write_glyphs call that went through. */
  private lastTurnWrote = false;
  private sandbox: ProgramSandbox | null = null;
  private readonly listeners: ((e: EnvEvent) => void)[] = [];
  readonly cfg: EnvConfig;

  private constructor(cfg: EnvConfig) {
    this.cfg = cfg;
    this.world = new World(cfg);
    this.world.onEvent((e) => {
      this.track(e);
      this.emit(e);
    });
  }

  /**
   * `task` is sent as a pen-stroke recording; `imageTask`, when it has text, as a picture of a second handwritten page.
   * `pages` makes the task a slide deck: page 1 is the task, and `turnPage()` puts the next one on the pad.
   */
  static async create(cfg: EnvConfig, opts: { task?: string; imageTask?: string; pages?: string[]; parts?: DeckPart[][] } = {}): Promise<ScribeEnv> {
    const env = new ScribeEnv(cfg);
    if (opts.pages?.length) {
      env.pages = opts.pages;
      env.pageParts = opts.parts ?? opts.pages.map((text, i) => [{ section: i + 1, text }]);
      opts = { ...opts, task: opts.pages[0] };
    }
    if (opts.task !== undefined) {
      env.taskPad = env.pages.length ? env.padForPage(0) : makeTaskPad(cfg, opts.task);
      if (cfg.taskKind === "copy") env.feeder = new LineFeeder(env.taskPad, cfg.lineFeed);
      else env.answer = { lines: 0, stall: 0 };
      env.words = taskWords(opts.task);
    }
    if (opts.imageTask?.trim()) {
      env.imagePad = makeTaskPad(cfg, opts.imageTask.trim());
      // On the desk it lies below the stroke pad, on the same side.
      if (env.taskPad) env.imagePad.yMm = env.taskPad.yMm + env.taskPad.heightMm + IMAGE_PAD_GAP_MM;
      for (const w of taskWords(opts.imageTask)) env.words.add(w);
    }
    if (cfg.actionMode === "code") {
      env.sandbox = await ProgramSandbox.create((name, args) => env.programCall(name, args), cfg.program);
    } else {
      env.notes = [];
    }
    if (cfg.actionMode === "glyphs") env.glyphs = new GlyphLibrary(cfg.seed, cfg.glyphs);
    return env;
  }

  onEvent(fn: (e: EnvEvent) => void): void {
    this.listeners.push(fn);
  }

  tools(): ToolSchema[] {
    return toolSchemas(this.cfg);
  }

  step(calls: ToolCall[]): StepResult {
    if (this.finished) throw new Error("episode already finished");
    this.turn++;
    const inkBefore = this.world.inkMm;
    this.turnInk = null;
    this.batchCalls = 0;
    const results: CallResult[] = [];
    let skipReason: string | null = null;
    calls.forEach((c, i) => {
      if (!skipReason && i >= this.cfg.maxCallsPerTurn) skipReason = `over the limit of ${this.cfg.maxCallsPerTurn} calls per turn`;
      if (skipReason) {
        results.push({ call: c.name, status: "skipped", reason: skipReason });
        return;
      }
      const r = this.execute(c.name, c.args);
      results.push(r);
      if (r.status === "error") skipReason = "an earlier call in this turn failed";
      if (this.finished) skipReason = "the episode is finished";
    });
    if (this.feeder && !this.finished) {
      const piece = this.feeder.piece;
      const ok = results.every((r) => r.status !== "error");
      const outcome = this.feeder.afterTurn(this.world.inkMm - inkBefore, ok);
      if (outcome === "advanced") {
        this.lastPieceInk = this.turnInk;
        if (piece?.endsLine) this.linesOnPaper++;
      } else if (outcome === "stalled") {
        if (this.feeder.complete && this.morePages) this.waitingForPage = true;
        else {
          this.finished = true;
          this.endReason = this.feeder.complete ? "complete" : "stalled";
        }
      }
    }
    if (this.answer && !this.finished) {
      const ok = results.every((r) => r.status !== "error");
      if (ok && this.world.inkMm - inkBefore >= this.cfg.lineFeed.minInkMm) {
        // A turn may write several lines: the next target goes below the lowest ruled line this turn inked.
        const reached = this.linesReached(this.turnInk);
        const added = Math.max(1, reached - this.linesOnPaper);
        this.answer.lines += added;
        this.answer.stall = 0;
        this.linesOnPaper += added;
        this.lastPieceInk = this.turnInk;
      } else if (this.cfg.lineFeed.stallTurns > 0 && ++this.answer.stall >= this.cfg.lineFeed.stallTurns) {
        if (this.answer.lines > 0 && this.morePages) this.waitingForPage = true;
        else {
          this.finished = true;
          this.endReason = this.answer.lines > 0 ? "complete" : "stalled";
        }
      }
    }
    this.lastTurnWrote = results.some((r) => BATCH_WRITERS.has(r.call) && r.status !== "error" && r.status !== "skipped");
    // One paper per episode: when every line is used, the episode ends.
    if (!this.finished && this.sheetFull()) {
      this.finished = true;
      this.endReason = "paper_full";
    }
    const truncated = !this.finished && this.turn >= this.cfg.maxTurns;
    if (truncated) {
      this.finished = true;
      this.endReason = "max_turns";
    }
    this.lastResults = results;
    this.emit({ t: "turn", turn: this.turn, results });
    return { results, observation: this.observe(), done: this.finished, truncated };
  }

  /**
   * What the agent perceives now. The camera images are always rendered (for the viewer and the run log) but are
   * part of the observation only when cfg.images is on. A pinned look_at applies to this observation only.
   */
  observe(): Observation {
    const w = this.world;
    const region = detailRegion(w);
    const detail = renderDetail(w, region);
    const overview = renderOverview(w, region);
    w.look = null;
    const lines = ruledLines(this.cfg);
    const sheet = w.sheet;
    const json: Record<string, unknown> = {
      turn: this.turn,
      sim_time_s: round(w.simTimeS, 1),
      frame: FRAME,
      tool: w.tool,
      tip_mm: w.cmd.map((v) => round(v, 2)),
      ...(w.penWorld ? { pen_inputs: w.point.map((v) => round(v, 2) + 0) } : {}),
      contact: w.contact,
      sheet: {
        size_mm: [this.cfg.sheet.widthMm, this.cfg.sheet.heightMm],
        ruled_lines_y_mm: lines.length ? { first: lines[0], pitch: this.cfg.sheet.rulingMm, last: lines[lines.length - 1] } : null,
        margin_line_x_mm: this.cfg.sheet.marginLineMm,
        strokes: sheet.strokes,
        ink_mm: round(sheet.inkMm, 0),
      },
      last_turn: this.lastResults,
      ...(this.taskPad ? { task_line: this.taskLine() } : {}),
      ...(this.pages.length > 1 ? { page: this.pageInfo() } : {}),
      ...(this.glyphs ? { glyph_library: this.glyphs.list() } : {}),
      ...(this.cfg.images ? { images: {} } : {}),
      ...(this.cfg.notes ? { notes: this.notes } : {}),
      budget: {
        turn: this.turn,
        max_turns: this.cfg.maxTurns,
        max_calls_per_turn: this.cfg.maxCallsPerTurn,
        mode: this.cfg.actionMode,
      },
    };
    const images = [overview, detail];
    if (this.cfg.images) json.images = Object.fromEntries(images.map((i) => [i.name, describeImage(i)]));
    this.emit({ t: "obs", turn: this.turn, images: images.map((i) => ({ name: i.name, png: i.png.toString("base64") })) });
    if (this.cfg.pageStrokes && this.lastTurnWrote) json.page_strokes = this.pageRecording(sheet);
    const sent: Observation["images"] = this.cfg.images ? [...images] : [];
    if (this.cfg.pageImage && this.lastTurnWrote) {
      sent.push({ name: "page", png: renderSheet(this.cfg, sheet.ink, PAGE_PX_PER_MM, { ruling: false }) });
    }
    return { json, images: sent };
  }

  /**
   * The sheet's landed ink as a pen-stroke recording, in the task pad's format: strokes grouped into the ruled line
   * they sit on, each the path of real ink in page mm. Built from what landed, so the motion noise shows in it.
   */
  pageRecording(sheet: World["sheet"]): Record<string, unknown> {
    const ruled = ruledLines(this.cfg);
    const r1 = (v: number) => Math.round(v * 10) / 10;
    // A letter's points average about half a cap above its baseline; a descender's a little below it.
    const lineOf = (st: Vec2[]) => {
      if (!ruled.length) return null;
      const meanY = st.reduce((a, p) => a + p[1], 0) / st.length;
      return ruled.find((b) => b >= meanY - 3) ?? ruled[ruled.length - 1];
    };
    const groups = new Map<number | null, Vec2[][]>();
    // With the pen dial on, ink is traced as finely sampled curves: points a path does not need are left out, so a
    // straight stretch comes back as its two ends.
    const thinned = this.world.penWorld;
    for (const landed of sheet.paths) {
      const path = thinned ? thin(landed) : landed;
      const st: Vec2[] = [];
      for (const [x, y] of path) {
        const p: Vec2 = [r1(x), r1(y)];
        const last = st[st.length - 1];
        if (!last || last[0] !== p[0] || last[1] !== p[1]) st.push(p);
      }
      const key = lineOf(st);
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(st);
    }
    const keys = [...groups.keys()].sort((a, b) => (a ?? 0) - (b ?? 0));
    return {
      frame: FRAME,
      size_mm: [this.cfg.sheet.widthMm, this.cfg.sheet.heightMm],
      line_count: keys.length,
      lines: keys.map((k, i) => ({ line: i + 1, baseline_y_mm: k, stroke_count: groups.get(k)!.length, strokes: groups.get(k) })),
    };
  }

  /** Slides: which page is on the pad, counted from 1, and whether the agent is waiting for the next. */
  pageInfo(): Record<string, unknown> {
    return { page: this.page + 1, pages: this.pages.length, ...(this.waitingForPage ? { waiting_for_page_turn: true } : {}) };
  }

  /** Slides: page i's pad, its sections drawn one under another. */
  private padForPage(i: number): TaskPad {
    // Raw sections are typed text in the recording (taskRecording), not handwriting: the pad draws the others only.
    const parts = this.pageParts[i].filter((p) => !p.raw);
    if (!parts.length) return makeTaskPad(this.cfg, "");
    if (parts.length === 1) return makeTaskPad(this.cfg, parts[0].text);
    return makeTaskPadParts(parts.map((p) => ({ cfg: this.cfg, text: p.text, section: p.section })));
  }

  private get morePages(): boolean {
    return this.page + 1 < this.pages.length;
  }

  /**
   * Slides: put the next page on the pad, handwritten like the first. Its lines are fed from line 1 (copy tasks), or
   * the answer count starts again (instruct tasks); the paper, the glyph library and the target line carry on.
   * False on the last page.
   */
  turnPage(): boolean {
    if (!this.morePages) return false;
    const text = this.pages[++this.page];
    this.taskPad = this.padForPage(this.page);
    if (this.cfg.taskKind === "copy") this.feeder = new LineFeeder(this.taskPad, this.cfg.lineFeed);
    else this.answer = { lines: 0, stall: 0 };
    for (const w of taskWords(text)) this.words.add(w);
    this.waitingForPage = false;
    const { xMm, yMm, widthMm, heightMm, strokes } = this.taskPad;
    this.emit({ t: "page", turn: this.turn, page: this.page + 1, pages: this.pages.length, taskPad: { xMm, yMm, widthMm, heightMm, strokes } });
    return true;
  }

  /**
   * The whole task pad as pen strokes, split into its written lines (numbered as in task_line). Given to the
   * agent once, at the start; it holds nothing but geometry.
   */
  taskRecording(): Record<string, unknown> | null {
    if (!this.taskPad) return null;
    const pad = this.taskPad;
    // With the pen dial on, the pad was written with a pen like the robot's and the recording is that pen's inputs:
    // for each point of the pad's ink, the pair of inputs that puts the tip there (src/pen.ts), in the pad's frame.
    const world = this.world;
    const padLevel = this.cfg.pen.padLevel;
    const pen = padLevel === null || padLevel === world.pen.level ? world.pen : penFor(padLevel);
    const digits = inputDecimals(pen.level);
    const own = (st: Vec2[]): number[][] => (world.penWorld ? st.map((p) => pen.inputs(p).map((v) => round(v, digits) + 0)) : st);
    const strokeLine = (l: TaskPad["lines"][number]) => ({
      pad_baseline_y_mm: l.baselineMm,
      stroke_count: l.to - l.from,
      strokes: pad.strokes.slice(l.from, l.to).map(own),
    });
    const parts = this.pageParts[this.page] ?? [];
    let items: Record<string, unknown>[];
    if (!parts.some((p) => p.raw)) items = pad.lines.filter((l) => l.to > l.from).map(strokeLine);
    else {
      // The page's sections in deck order: a drawn section's written lines, a raw section's typed text in its place.
      const drawn = parts.filter((p) => !p.raw);
      items = [];
      let k = 0;
      for (const part of parts) {
        if (part.raw) {
          items.push({ text: part.text });
          continue;
        }
        const [from, to] = pad.parts?.[k]?.lines ?? (drawn.length === 1 ? [0, pad.lines.length] : [0, 0]);
        k++;
        for (const l of pad.lines.slice(from, to)) if (l.to > l.from) items.push(strokeLine(l));
      }
    }
    const typed = items.some((it) => "text" in it);
    return {
      frame: world.penWorld && padLevel !== 0 ? PEN_PAD_FRAME : PAD_FRAME,
      size_mm: [pad.widthMm, pad.heightMm],
      line_count: items.length,
      ...(typed ? { typed_lines: 'a line with "text" in place of strokes was typed on the pad, not handwritten' } : {}),
      lines: items.map((it, i) => ({ line: i + 1, ...it })),
    };
  }

  /** Slides: the raw (typed) sections of a page, 0-based; empty for a page with none. */
  rawSections(page = this.page): { section: number; text: string }[] {
    return (this.pageParts[page] ?? []).filter((p) => p.raw).map(({ section, text }) => ({ section, text }));
  }

  /**
   * What to write this turn and where it goes on the paper. Copy tasks: one written line of the recording (or a run
   * of its strokes after a block), and a status object once every line is accepted. Instruct tasks: the next line
   * of the agent's own answer. Null without a task pad.
   */
  taskLine(): Record<string, unknown> | null {
    if (this.answer) {
      return {
        answer_lines_written: this.answer.lines,
        turns_without_new_line: this.answer.stall,
        ...(this.lastPieceInk ? { last_line_ink_mm: inkBox(this.lastPieceInk) } : {}),
        target: this.target(),
      };
    }
    if (!this.feeder) return null;
    const piece = this.feeder.piece;
    if (!piece) return { status: "complete", lines: this.feeder.lineCount };
    const xs = this.feeder.strokes().flat().map((p) => p[0]);
    return {
      line: piece.line + 1,
      of: piece.lines,
      stroke_range: [piece.from - piece.lineFrom, piece.to - piece.lineFrom],
      line_stroke_count: piece.lineTo - piece.lineFrom,
      continues_line: piece.continuesLine,
      ends_line: piece.endsLine,
      turns_shown: piece.turnsShown,
      pad_baseline_y_mm: piece.padBaselineMm,
      x_range_mm: [round(Math.min(...xs), 1), round(Math.max(...xs), 1)],
      ...(this.lastPieceInk ? { last_line_ink_mm: inkBox(this.lastPieceInk) } : {}),
      target: this.target(),
    };
  }

  /** Where the current piece goes: the next ruled line, after the ink of the piece before when it continues a line. */
  private target(): Target {
    const ruled = ruledLines(this.cfg);
    const baseline = ruled.length ? ruled[Math.min(this.linesOnPaper, ruled.length - 1)] : BLANK_FIRST_MM + BLANK_PITCH_MM * this.linesOnPaper;
    const xMargin = (this.cfg.sheet.marginLineMm ?? 12) + 3;
    const continues = this.feeder?.piece?.continuesLine ?? false;
    const xStart = continues && this.lastPieceInk ? round(this.lastPieceInk.maxX + 3, 1) : xMargin;
    return { baseline_y_mm: baseline, x_start_mm: xStart };
  }

  /**
   * How many ruled lines are used once this ink is on the paper: every ruled line at or above the ink's lowest point,
   * allowing for descenders (up to 0.4 cap, about 2.5 mm, below a baseline). 0 with no ink or no ruling.
   */
  private linesReached(ink: Bbox | null): number {
    const ruled = ruledLines(this.cfg);
    if (!ink || !ruled.length) return 0;
    return ruled.filter((b) => b < ink.maxY + 2.6).length;
  }

  /** Every line of the paper is used: the episode ends. */
  private sheetFull(): boolean {
    const ruled = ruledLines(this.cfg);
    if (ruled.length) return this.linesOnPaper >= ruled.length;
    return BLANK_FIRST_MM + BLANK_PITCH_MM * this.linesOnPaper > this.cfg.sheet.heightMm - 15;
  }

  /** After the provider blocked a reply: show a smaller part of the current line next time. */
  narrowTaskLine(): boolean {
    return this.feeder?.narrow() ?? false;
  }

  /** True when free text from the agent contains a word of the task. */
  hasTaskWords(text: string): boolean {
    return hasTaskWords(text, this.words);
  }

  close(): void {
    this.sandbox?.dispose();
    this.sandbox = null;
  }

  private track(e: WorldEvent): void {
    if (e.t === "ink" && e.tool === "pen") {
      this.turnInk = extend(this.turnInk, e.pts);
    }
  }

  private execute(name: string, args: Record<string, unknown>): CallResult {
    try {
      return { call: name, ...this.dispatch(name, args ?? {}) };
    } catch (e) {
      if (e instanceof ActionError || e instanceof ArgError) return { call: name, status: "error", error: e.message };
      throw e;
    }
  }

  private dispatch(name: string, a: Record<string, unknown>): { status: CallResult["status"]; [key: string]: unknown } {
    const w = this.world;
    // With the pen dial on, every movement takes pen inputs and goes through the pen's machinery (src/pen.ts).
    if (w.penWorld) {
      switch (name) {
        // Each movement reports where the tip ended up, so the pen can be probed several times in one turn.
        case "stroke":
          return { ...w.strokePoints(reqPenPoints(a, "points")), tip_mm: tipOf(w) };
        case "move_to":
          return { ...w.movePoint(reqPenPoint(a, "point"), optNum(a, "z")), tip_mm: tipOf(w) };
        case "unwind": {
          if (!this.cfg.pen.unwind) throw new ArgError("unwind is not available in this environment");
          const k = reqNum(a, "cam");
          if (!Number.isInteger(k) || k < 1) throw new ArgError("cam must be a whole number from 1");
          if (k > w.pen.level) throw new ArgError(`your pen has no cam ${k}`);
          const pts = reqPenPoints(a, "points").map((q) => undoCam(q as Vec2, k));
          return { status: "ok", points: pts.map((p) => [round(p[0], 3) + 0, round(p[1], 3) + 0]) };
        }
        case "move_by":
          return { ...w.movePointBy(reqPenPoint(a, "delta"), optNum(a, "dz") ?? 0), tip_mm: tipOf(w) };
        case "strokes": {
          if (this.cfg.actionMode !== "strokes") throw new ArgError(`strokes is not available in ${this.cfg.actionMode} mode`);
          this.oneBatchPerTurn(name);
          const paths = reqPenPaths(a, "paths");
          let clipped = 0;
          let drawn = 0;
          for (const p of paths) {
            const r = w.strokePoints(p);
            clipped += r.clipped_points ?? 0;
            drawn += r.path_mm;
          }
          return { status: clipped ? "clipped" : "ok", strokes: paths.length, path_mm: round(drawn, 1), ...(clipped ? { clipped_points: clipped } : {}) };
        }
      }
    }
    switch (name) {
      case "stroke":
        return w.stroke(reqPoints(a, "points"), optBool(a, "smooth", false));
      case "move_to":
        return w.moveTo(reqNum(a, "x"), reqNum(a, "y"), optNum(a, "z"));
      case "move_by":
        return w.moveBy(optNum(a, "dx") ?? 0, optNum(a, "dy") ?? 0, optNum(a, "dz") ?? 0);
      case "pen_down":
        return w.penDown();
      case "pen_up":
        return w.penUp();
      case "look_at":
        if (!this.cfg.images) throw new ArgError("look_at aims the camera images, which are turned off in this environment");
        w.lookAt(reqNum(a, "x"), reqNum(a, "y"), optNum(a, "width_mm"));
        return { status: "ok" };
      case "set_tool":
        if (a.tool === "eraser" && !this.cfg.eraser) throw new ActionError("the eraser is not available in this environment");
        w.setTool(reqStr(a, "tool") as "pen" | "eraser");
        return { status: "ok" };
      case "strokes": {
        if (this.cfg.actionMode !== "strokes" && this.cfg.actionMode !== "glyphs") throw new ArgError(`strokes is not available in ${this.cfg.actionMode} mode`);
        this.oneBatchPerTurn(name);
        const paths = reqPaths(a, "paths");
        return this.drawPaths(paths, optBool(a, "smooth", false));
      }
      case "define_glyph": {
        if (!this.glyphs) throw new ArgError(`define_glyph is not available in ${this.cfg.actionMode} mode`);
        const id = this.glyphs.define(reqPaths(a, "strokes"), reqNum(a, "width"), optInt(a, "id"));
        return { status: "ok", id, glyphs: this.glyphs.glyphs.size };
      }
      case "write_glyphs": {
        if (!this.glyphs) throw new ArgError(`write_glyphs is not available in ${this.cfg.actionMode} mode`);
        this.oneBatchPerTurn(name);
        const ids = reqInts(a, "ids");
        const t = this.target();
        const { paths, endX } = this.glyphs.layout(ids, {
          xStart: optNum(a, "x_start_mm") ?? t.x_start_mm,
          baseline: optNum(a, "baseline_y_mm") ?? t.baseline_y_mm,
          capMm: optNum(a, "cap_mm") ?? DEFAULT_CAP_MM,
          gapMm: optNum(a, "spacing_mm"),
        });
        return { ...this.drawPaths(paths, false), glyphs: ids.length, end_x_mm: endX };
      }
      case "write_notes": {
        if (!this.cfg.notes) throw new ArgError("write_notes is turned off in this environment");
        const notes = this.cfg.actionMode === "code" ? reqStr(a, "text") : reqNums(a, "numbers");
        const size = typeof notes === "string" ? notes.length : JSON.stringify(notes).length;
        if (size > this.cfg.maxNotesChars) throw new ArgError(`notes are limited to ${this.cfg.maxNotesChars} characters`);
        this.notes = notes;
        return { status: "ok", chars: size };
      }
      case "run_program": {
        if (!this.sandbox) throw new ArgError("run_program is not available in primitives mode");
        const code = reqStr(a, "code");
        if (this.cfg.program.textCheck) {
          const found = checkProgram(code, this.words);
          if (found) {
            return {
              status: "error",
              program_status: "rejected",
              calls: 0,
              logs: [],
              error: `Program rejected before running: it contains ${found}. Write with pen calls and numbers only.`,
            };
          }
        }
        const r = this.sandbox.run(code);
        const { status, ...rest } = r;
        return status === "ok" ? { status: "ok", ...rest } : { status: "error", program_status: status, ...rest };
      }
      case "done": {
        // Copy tasks have an objective end: every pad line on the paper. Before that, done is rejected
        // (the episode keeps going), so a low-effort model cannot end the run after a few lines.
        const piece = this.feeder?.piece;
        if (piece) {
          throw new ArgError(
            `the task is not complete: line ${piece.line + 1} of ${piece.lines} is not on the paper yet; write the line task_line names, then call done()`,
          );
        }
        if (this.morePages) {
          this.waitingForPage = true;
          return { status: "ok", waiting: "page turn" };
        }
        this.finished = true;
        this.endReason = "done";
        return { status: "ok" };
      }
      default:
        throw new ArgError(`unknown call "${name}"`);
    }
  }

  private oneBatchPerTurn(name: string): void {
    if (BATCH_WRITERS.has(name) && this.batchCalls++ > 0) throw new ArgError("only one strokes or write_glyphs call is allowed per turn");
  }

  /** Draw paths one stroke at a time, as stroke() would, and report them as one call. */
  private drawPaths(paths: Vec2[][], smooth: boolean): { status: CallResult["status"]; [key: string]: unknown } {
    let clipped = 0;
    let drawn = 0;
    for (const p of paths) {
      const r = this.world.stroke(p, smooth);
      clipped += r.clipped_points ?? 0;
      drawn += r.path_mm;
    }
    return { status: clipped ? "clipped" : "ok", strokes: paths.length, path_mm: round(drawn, 1), ...(clipped ? { clipped_points: clipped } : {}) };
  }

  /** `pen.<name>(...)` from inside a program. Errors are thrown into the program. */
  private programCall(name: string, args: unknown[]): unknown {
    if (name === "tip") return this.world.cmd.map((v) => round(v, 2));
    if (name === "contact") return this.world.contact;
    const r = this.execute(name, namedArgs(name, args));
    if (r.status === "error") throw new Error(String(r.error));
    const { call: _call, ...rest } = r;
    return rest;
  }

  private emit(e: EnvEvent): void {
    for (const fn of this.listeners) fn(e);
  }
}

/** A line's ink extent in page mm. */
function inkBox(b: Bbox): { x_range: number[]; y_range: number[] } {
  return { x_range: [round(b.minX, 1), round(b.maxX, 1)], y_range: [round(b.minY, 1), round(b.maxY, 1)] };
}

function extend(box: Bbox | null, pts: Vec2[]): Bbox {
  const b = box ?? { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const [x, y] of pts) {
    if (x < b.minX) b.minX = x;
    if (x > b.maxX) b.maxX = x;
    if (y < b.minY) b.minY = y;
    if (y > b.maxY) b.maxY = y;
  }
  return b;
}
