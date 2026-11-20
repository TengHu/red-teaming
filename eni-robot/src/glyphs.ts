import { ArgError } from "./actions.ts";
import type { EnvConfig } from "./config.ts";
import { round, type Vec2 } from "./geometry.ts";
import { Rng } from "./rng.ts";

/** A letter shape the agent designed, in glyph units: x from 0 to `width`, y = 0 at the cap line, y = 1 at the baseline. */
export interface Glyph {
  id: number;
  width: number;
  strokes: Vec2[][];
}

/** The id that writes a word space instead of a glyph. */
export const SPACE_ID = 0;
/** Word space and the default gap between glyphs, in cap heights. */
const SPACE_WIDTH = 0.6;
const LETTER_GAP = 0.15;
/** Glyph points may stray this far outside [0, width] x [0, 1]; the bottom allows descenders. */
const SLACK = 0.5;
const DESCENDER = 1.4;

/**
 * The agent's own font. define_glyph stores a shape and returns an id; write_glyphs lays a sequence of ids out
 * on the page. Ids come from a seeded shuffle of 3-digit integers, so they say nothing about which letter a glyph is.
 */
export class GlyphLibrary {
  readonly glyphs = new Map<number, Glyph>();
  private readonly pool: number[];
  private readonly limits: EnvConfig["glyphs"];

  constructor(seed: number, limits: EnvConfig["glyphs"]) {
    this.limits = limits;
    const rng = new Rng(seed ^ 0x9e3779b9);
    this.pool = Array.from({ length: 900 }, (_, i) => 100 + i);
    for (let i = this.pool.length - 1; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      [this.pool[i], this.pool[j]] = [this.pool[j], this.pool[i]];
    }
  }

  /** Store a glyph; returns its id. With `id`, replaces that glyph. */
  define(strokes: Vec2[][], width: number, id?: number): number {
    if (!(width > 0 && width <= 3)) throw new ArgError(`"width" must be above 0 and at most 3 cap heights`);
    if (strokes.length === 0 || strokes.length > this.limits.maxStrokes) throw new ArgError(`a glyph needs 1 to ${this.limits.maxStrokes} strokes`);
    for (const [i, s] of strokes.entries()) {
      if (s.length === 0 || s.length > this.limits.maxPoints) throw new ArgError(`strokes[${i}] needs 1 to ${this.limits.maxPoints} points`);
      for (const [x, y] of s) {
        if (x < -SLACK || x > width + SLACK || y < -SLACK || y > DESCENDER) {
          throw new ArgError(`strokes[${i}] has a point outside the glyph box (x 0 to width, y 0 to 1, descenders to ${DESCENDER})`);
        }
      }
    }
    const shape = { width: round(width, 3), strokes: strokes.map((s) => s.map(([x, y]) => [round(x, 3), round(y, 3)] as Vec2)) };
    if (id !== undefined) {
      if (!this.glyphs.has(id)) throw new ArgError(`no glyph with id ${id}`);
      this.glyphs.set(id, { id, ...shape });
      return id;
    }
    if (this.glyphs.size >= this.limits.maxGlyphs) throw new ArgError(`the library is full (${this.limits.maxGlyphs} glyphs); replace one by passing its id`);
    const newId = this.pool[this.glyphs.size];
    this.glyphs.set(newId, { id: newId, ...shape });
    return newId;
  }

  /** Page-mm paths for a sequence of ids, starting at `xStart` on `baseline`; `endX` is where the next glyph would go. */
  layout(ids: number[], at: { xStart: number; baseline: number; capMm: number; gapMm?: number }): { paths: Vec2[][]; endX: number } {
    if (ids.length === 0 || ids.length > this.limits.maxIds) throw new ArgError(`"ids" needs 1 to ${this.limits.maxIds} ids`);
    if (!(at.capMm >= 1 && at.capMm <= 20)) throw new ArgError(`"cap_mm" must be from 1 to 20`);
    const gap = at.gapMm ?? LETTER_GAP * at.capMm;
    const top = at.baseline - at.capMm;
    const paths: Vec2[][] = [];
    let x = at.xStart;
    for (const [i, id] of ids.entries()) {
      if (id === SPACE_ID) {
        x += SPACE_WIDTH * at.capMm;
        continue;
      }
      const g = this.glyphs.get(id);
      if (!g) throw new ArgError(`ids[${i}] is ${id}, which is not in your glyph library`);
      for (const s of g.strokes) paths.push(s.map(([gx, gy]) => [round(x + gx * at.capMm, 2), round(top + gy * at.capMm, 2)]));
      x += g.width * at.capMm + gap;
    }
    return { paths, endX: round(x, 1) };
  }

  list(): Glyph[] {
    return [...this.glyphs.values()];
  }
}
