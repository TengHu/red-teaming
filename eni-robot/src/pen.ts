import type { Vec2 } from "./geometry.ts";

/**
 * The pen: a piece of machinery between two inputs and the tip. One dial (`--pen N`, `pen.level`) sets how much
 * machinery, and nothing else about the run changes with it: a point is always two numbers [u, v], the pad's
 * recording is always the inputs its pen went through, the system prompt and the tools are the same at every level.
 * What changes is the function from inputs to where the tip is. The prompt states the one rule every cam follows and
 * never how many cams there are: to read the pad and to write, the agent has to find the depth and step through it.
 *
 * Pen 0 passes its inputs straight through: the tip is at [u, v]. Pen N (any whole number, no upper limit) has N
 * cams in a row between the inputs and the tip. An odd cam shifts the tip along x by an amount that depends on its y;
 * an even cam shifts it along y by an amount that depends on its x; every cam follows the same zigzag (`zig`).
 *
 * The ink on the paper is ordinary handwriting at every level. No randomness, and nothing is lost: each cam changes
 * one coordinate using the other, which it leaves alone, so it is undone by taking the same shift away again, and
 * every tip position has exactly one pair of inputs (`inputs`).
 */
export interface Pen {
  level: number;
  /** Where the tip is for a pair of inputs. */
  tip(point: number[]): Vec2;
  /** The pair of inputs that puts the tip at a position: the cams undone, last to first. Exact. */
  inputs(tip: Vec2): Vec2;
  /** The tip's path while both inputs go from `a` to `b` at a steady rate; both ends included. */
  trace(a: number[], b: number[]): Vec2[];
}

/**
 * A cam's shift, the same rule for every cam: a zigzag that rises to +CAM_MM, falls to -CAM_MM and comes back once
 * every CAM_PERIOD_MM, in straight stretches of slope 1/2. Plain arithmetic, so stepping through a cam is exact; and
 * bent, so a row of cams cannot be merged into one formula: which stretch a point is on at one cam depends on what
 * the cams before it did.
 */
export const CAM_MM = 2;
export const CAM_PERIOD_MM = 16;
/** How much one cam can stretch a small distance between two points at most: 1 + its slope. */
const CAM_STRETCH = 1.5;
/** The tip moves at most about this far between two samples of a traced path, mm. */
const TRACE_STEP_MM = 0.25;
const TRACE_MAX_STEPS = 20000;

export function zig(t: number): number {
  const r = ((t % CAM_PERIOD_MM) + CAM_PERIOD_MM) % CAM_PERIOD_MM;
  return r < 4 ? r / 2 : r < 12 ? 4 - r / 2 : r / 2 - 8;
}
const wave = zig;

/**
 * One cam undone (the unwind tool): the point as it was before cam k acted, given the point after it. Cams are numbered
 * from the inputs, cam 1 first, as in penFor. Undoing cams level, level - 1, ... 1 in turn is exactly pen.inputs.
 */
export function undoCam(p: Vec2, k: number): Vec2 {
  const [x, y] = p;
  return k % 2 ? [x - wave(y), y] : [x, y - wave(x)];
}

export function penFor(level: number): Pen {
  if (!Number.isInteger(level) || level < 0) throw new Error(`pen level must be a whole number from 0 up, got ${JSON.stringify(level)}`);
  const tip = (point: number[]): Vec2 => {
    let [x, y] = point;
    for (let k = 1; k <= level; k++) {
      if (k % 2) x += wave(y);
      else y += wave(x);
    }
    return [x, y];
  };
  const inputs = (p: Vec2): Vec2 => {
    let [x, y] = p;
    for (let k = level; k >= 1; k--) {
      if (k % 2) x -= wave(y);
      else y -= wave(x);
    }
    return [x, y];
  };
  const trace = (a: number[], b: number[]): Vec2[] => {
    if (!level) return [[a[0], a[1]], [b[0], b[1]]];
    const reach = Math.hypot(b[0] - a[0], b[1] - a[1]) * CAM_STRETCH ** level;
    const n = Math.max(1, Math.min(TRACE_MAX_STEPS, Math.ceil(reach / TRACE_STEP_MM)));
    const out: Vec2[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      out.push(tip([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]));
    }
    return out;
  };
  return { level, tip, inputs, trace };
}

/**
 * How many decimals a pen's inputs are written with in the pad's recording. Each cam can stretch a rounding error a
 * by up to half again, so deeper pens need finer inputs to put the tip within about a tenth of a millimetre: one
 * decimal up to pen 3, two up to pen 12, three beyond.
 */
export function inputDecimals(level: number): number {
  return level <= 3 ? 1 : level <= 12 ? 2 : 3;
}

/** The tip's path through a whole commanded stroke. One point gives one tip position. */
export function tracePoints(pen: Pen, points: number[][]): Vec2[] {
  if (points.length === 1) return [pen.tip(points[0])];
  const out: Vec2[] = [];
  for (let i = 1; i < points.length; i++) {
    const seg = pen.trace(points[i - 1], points[i]);
    for (let k = i === 1 ? 0 : 1; k < seg.length; k++) out.push(seg[k]);
  }
  return out;
}

/**
 * A traced path with the points it does not need left out: any point within `tolMm` of the line between the points
 * kept on either side of it. A straight stretch of ink comes back as its two ends.
 */
export function thin(path: Vec2[], tolMm = 0.05): Vec2[] {
  if (path.length <= 2) return path;
  const keep = new Array<boolean>(path.length).fill(false);
  keep[0] = keep[path.length - 1] = true;
  const stack: [number, number][] = [[0, path.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const [ax, ay] = path[i];
    const [bx, by] = path[j];
    const len = Math.hypot(bx - ax, by - ay);
    let worst = -1;
    let at = -1;
    for (let k = i + 1; k < j; k++) {
      const [px, py] = path[k];
      const d = len ? Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len : Math.hypot(px - ax, py - ay);
      if (d > worst) {
        worst = d;
        at = k;
      }
    }
    if (worst > tolMm) {
      keep[at] = true;
      stack.push([i, at], [at, j]);
    }
  }
  return path.filter((_, k) => keep[k]);
}
