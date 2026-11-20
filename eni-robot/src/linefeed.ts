import type { EnvConfig } from "./config.ts";
import { pathLength, round, type Vec2 } from "./geometry.ts";
import type { PadLine, TaskPad } from "./taskpad.ts";

/** The part of the task pad the agent is shown now: a written line, or a run of strokes within one. */
export interface Piece {
  /** 0-based among the written (non-blank) lines, and how many there are. */
  line: number;
  lines: number;
  /** `pad.strokes[from, to)`, inside the written line `pad.strokes[lineFrom, lineTo)`. */
  from: number;
  to: number;
  lineFrom: number;
  lineTo: number;
  continuesLine: boolean;
  endsLine: boolean;
  padBaselineMm: number;
  /** How many turns this piece has been shown, counting this one. */
  turnsShown: number;
  /** Pen path length of the piece on the pad, mm. */
  inkMm: number;
}

export type TurnOutcome = "advanced" | "same" | "stalled";

/** Gap between consecutive strokes that marks a word space on the pad (a space is 2.9 mm plus side bearings). */
const WORD_GAP_MM = 2.5;
/** Pieces completed without a block before a narrowed cap is doubled again. */
const CLEAN_RUN = 3;

/**
 * Names the part of the task pad to write now: one written line at a time, so a reply is asked for one line only.
 * A piece advances when the turn put enough ink on the paper; a provider block halves it.
 */
export class LineFeeder {
  private readonly strokesAll: Vec2[][];
  private readonly lines: PadLine[];
  private readonly opts: EnvConfig["lineFeed"];
  private li = 0;
  private from = 0;
  private to = 0;
  /** Most strokes per piece; unlimited until a block narrows it. */
  private cap = Infinity;
  private cleanRun = 0;
  private stall = 0;
  private shown = 1;

  constructor(pad: TaskPad, opts: EnvConfig["lineFeed"]) {
    this.strokesAll = pad.strokes;
    this.opts = opts;
    this.lines = pad.lines.filter((l) => l.to > l.from);
    if (this.lines.length) {
      this.from = this.lines[0].from;
      this.to = this.cut(this.from, this.lines[0].to);
    }
  }

  get lineCount(): number {
    return this.lines.length;
  }

  get complete(): boolean {
    return this.li >= this.lines.length;
  }

  /** Most strokes a piece may hold now (Infinity until a block narrows it). */
  get capStrokes(): number {
    return this.cap;
  }

  get piece(): Piece | null {
    if (this.complete) return null;
    const line = this.lines[this.li];
    return {
      line: this.li,
      lines: this.lines.length,
      from: this.from,
      to: this.to,
      lineFrom: line.from,
      lineTo: line.to,
      continuesLine: this.from > line.from,
      endsLine: this.to === line.to,
      padBaselineMm: line.baselineMm,
      turnsShown: this.shown,
      inkMm: round(this.pieceInk(), 1),
    };
  }

  strokes(): Vec2[][] {
    return this.strokesAll.slice(this.from, this.to);
  }

  /** Call once per turn with the pen ink the turn added and whether every call succeeded. */
  afterTurn(inkAddedMm: number, ok: boolean): TurnOutcome {
    if (!this.complete) {
      const need = Math.max(this.opts.minInkMm, this.opts.inkFraction * this.pieceInk());
      if (ok && inkAddedMm >= need) {
        this.advance();
        return "advanced";
      }
      this.shown++;
    }
    this.stall++;
    return this.opts.stallTurns > 0 && this.stall >= this.opts.stallTurns ? "stalled" : "same";
  }

  /** Halve the current piece (at a word gap when there is one). False when it is already as small as allowed. */
  narrow(): boolean {
    if (this.complete) return false;
    const count = this.to - this.from;
    const cap = Math.max(this.opts.minPieceStrokes, Math.floor(count / 2));
    if (cap >= count) return false;
    this.cap = cap;
    this.to = this.cut(this.from, this.lines[this.li].to);
    this.shown = 1;
    this.stall = 0;
    this.cleanRun = 0;
    return true;
  }

  private advance(): void {
    this.stall = 0;
    this.shown = 1;
    if (this.to < this.lines[this.li].to) {
      this.from = this.to;
    } else {
      this.li++;
      if (this.complete) return;
      this.from = this.lines[this.li].from;
    }
    if (this.cap !== Infinity && ++this.cleanRun >= CLEAN_RUN) {
      this.cap *= 2;
      this.cleanRun = 0;
    }
    this.to = this.cut(this.from, this.lines[this.li].to);
  }

  /** Where a piece starting at `from` ends: the line's end, or under the cap the nearest word gap. */
  private cut(from: number, lineEnd: number): number {
    if (lineEnd - from <= this.cap) return lineEnd;
    const maxTo = from + this.cap;
    const minTo = from + Math.min(this.opts.minPieceStrokes, this.cap);
    let best = maxTo;
    let bestGap = -Infinity;
    for (let to = maxTo; to >= minTo; to--) {
      const gap = this.gapBefore(to);
      if (gap >= WORD_GAP_MM) return to;
      if (gap > bestGap) {
        bestGap = gap;
        best = to;
      }
    }
    return best;
  }

  private gapBefore(index: number): number {
    const prev = this.strokesAll[index - 1];
    const next = this.strokesAll[index];
    return Math.min(...next.map((p) => p[0])) - Math.max(...prev.map((p) => p[0]));
  }

  private pieceInk(): number {
    let mm = 0;
    for (let i = this.from; i < this.to; i++) mm += pathLength(this.strokesAll[i]);
    return mm;
  }
}
