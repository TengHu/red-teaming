import type { EnvConfig } from "./config.ts";
import { catmullRom, clamp, pathLength, round, type Vec2, type Vec3 } from "./geometry.ts";
import { InkLayer } from "./ink.ts";
import { penFor, tracePoints, type Pen } from "./pen.ts";
import { Rng } from "./rng.ts";

export type Tool = "pen" | "eraser";

/** The paper the robot writes on: one per episode. */
export interface Sheet {
  ink: InkLayer;
  strokes: number;
  inkMm: number;
  /**
   * The pen's ink as it landed, one path per unbroken run of ink, in page mm.
   * Erasing is not reflected here. What --page-strokes sends the agent.
   */
  paths: Vec2[][];
}

/** Everything that happens physically, in order. The viewer animates these and runs log them. */
export type WorldEvent =
  | { t: "move"; to: Vec3 }
  | { t: "ink"; tool: Tool; widthMm: number; pts: Vec2[] }
  | { t: "tool"; tool: Tool }
  /**
   * What the robot commanded, before any noise: the stroke as it meant it, at the configured tool
   * width. For the viewer's reference sheet only; nothing the agent observes is built from it.
   */
  | { t: "intent"; tool: Tool; widthMm: number; pts: Vec2[] };

export type MotionReport = {
  status: "ok" | "clipped";
  path_mm: number;
  clipped_points?: number;
};

/** A command the robot refuses; reported to the agent as status "error". */
export class ActionError extends Error {}

/**
 * The physical world: one gantry-held pen over one sheet of paper, the only paper of the episode.
 *
 * `cmd` is where the robot believes the tip is (proprioception); `tip` is where it really is.
 * They differ by per-point jitter plus optional calibration drift, which only the cameras reveal.
 */
export class World {
  /** The paper. There is exactly one per episode; when it is full the episode ends. */
  readonly sheet: Sheet;
  cmd: Vec3;
  tip: Vec3;
  tool: Tool = "pen";
  simTimeS = 0;
  travelMm = 0;
  inkMm = 0;
  eraseMm = 0;
  /** Where the detail camera looks for the next observation; null follows the pen. */
  look: { x: number; y: number; widthMm: number } | null = null;
  private drift: Vec2 = [0, 0];
  /** Current positioning error and where it was last sampled (Ornstein-Uhlenbeck along the path). */
  private err: Vec2 = [0, 0];
  private errAt: Vec2 | null = null;
  private readonly rng: Rng;
  /** The pen (src/pen.ts): where the tip is for a pair of inputs. Level 0, straight through, unless the pen dial is on. */
  readonly pen: Pen;
  /** The pen dial is on (cfg.pen.level is set): points are pen inputs, at every level. */
  readonly penWorld: boolean;
  /** The last pair of pen inputs sent; `cmd` is the tip they put there. */
  point: number[];
  /** The current pen-down has put ink on the sheet (it counts as a stroke once it does). */
  private strokeLanded = false;
  /** The landed path the current pen-down is extending, while its ink is unbroken. */
  private openPath: Vec2[] | null = null;
  private readonly listeners: ((e: WorldEvent) => void)[] = [];
  readonly cfg: EnvConfig;

  constructor(cfg: EnvConfig) {
    this.cfg = cfg;
    this.rng = new Rng(cfg.seed);
    this.penWorld = cfg.pen.level !== null;
    this.pen = penFor(cfg.pen.level ?? 0);
    this.cmd = [15, 15, cfg.pen.hoverMm];
    this.point = this.pen.inputs([15, 15]);
    this.tip = [...this.cmd];
    const { widthMm, heightMm } = cfg.sheet;
    this.sheet = { ink: new InkLayer(widthMm, heightMm, cfg.inkPxPerMm), strokes: 0, inkMm: 0, paths: [] };
  }

  get contact(): boolean {
    return this.tip[2] <= 0;
  }

  get toolWidthMm(): number {
    return this.tool === "pen" ? this.cfg.pen.widthMm : this.cfg.pen.eraserWidthMm;
  }

  onEvent(fn: (e: WorldEvent) => void): void {
    this.listeners.push(fn);
  }

  // ---- actions -------------------------------------------------------------

  moveTo(x: number, y: number, z?: number): MotionReport {
    const { p, clipped } = this.clipXY([x, y]);
    const tz = clamp(z ?? this.cfg.pen.hoverMm, 0, this.cfg.pen.maxZMm);
    return this.goTo([p[0], p[1], tz], clipped ? 1 : 0);
  }

  moveBy(dx: number, dy: number, dz = 0): MotionReport {
    return this.moveTo(this.cmd[0] + dx, this.cmd[1] + dy, this.cmd[2] + dz);
  }

  // ---- the same actions with the pen dial on: points are pen inputs, and the tip goes where the pen's machinery puts it ----

  private checkPoint(p: number[], what: string): void {
    if (p.length !== 2 || !p.every((v) => Number.isFinite(v))) throw new ActionError(`${what} must be a pair of pen inputs, two finite numbers`);
  }

  /** The tip's path for a run of commanded points, kept on the sheet; how many commanded points had their tip off it. */
  private tipPath(points: number[][]): { path: Vec2[]; clipped: number } {
    const clipped = points.filter((p) => this.clipXY(this.pen.tip(p)).clipped).length;
    return { path: tracePoints(this.pen, points).map((p) => this.clipXY(p).p), clipped };
  }

  /** stroke() with the pen dial on: lift, go to the first point, lower, take both inputs steadily to each next point, lift. */
  strokePoints(points: number[][]): MotionReport {
    if (points.length === 0) throw new ActionError("stroke needs at least one point");
    if (points.length > this.cfg.maxStrokePoints) {
      throw new ActionError(`stroke has ${points.length} points; the limit is ${this.cfg.maxStrokePoints}`);
    }
    points.forEach((p, i) => this.checkPoint(p, `point ${i}`));
    const { path: cmdPts, clipped } = this.tipPath(points);
    if (this.contact) this.lift();
    this.beginPenStroke();
    const path = cmdPts.map((pt) => this.actuate(pt));
    const hover = this.cfg.pen.hoverMm;
    this.travel([path[0][0], path[0][1], hover]);
    this.lower();
    const before = this.tool === "pen" ? this.inkMm : this.eraseMm;
    if (path.length > 1) this.trace(path.slice(1));
    const drawn = (this.tool === "pen" ? this.inkMm : this.eraseMm) - before;
    this.lift();
    this.intent(cmdPts);
    const last = cmdPts[cmdPts.length - 1];
    this.cmd = [last[0], last[1], hover];
    this.point = [...points[points.length - 1]];
    return report(clipped, drawn);
  }

  /** move_to with the pen dial on: both inputs go steadily to `point`; ink lands along the tip's path if the pen is down and stays down. */
  movePoint(point: number[], z?: number): MotionReport {
    this.checkPoint(point, "point");
    const tz = clamp(z ?? this.cfg.pen.hoverMm, 0, this.cfg.pen.maxZMm);
    const { path: cmdPts, clipped } = this.tipPath([this.point, point]);
    const end = cmdPts[cmdPts.length - 1];
    if (!this.contact && tz <= 0) this.beginPenStroke();
    const before = this.tool === "pen" ? this.inkMm : this.eraseMm;
    if (this.contact && tz <= 0) {
      this.trace(cmdPts.slice(1).map((pt) => this.actuate(pt)));
      this.intent(cmdPts);
    } else {
      const [ax, ay] = this.actuate(end);
      this.travel([ax, ay, tz]);
      if (tz <= 0) {
        this.depositDot();
        this.intent([end]);
      }
    }
    this.cmd = [end[0], end[1], tz];
    this.point = [...point];
    return report(clipped, (this.tool === "pen" ? this.inkMm : this.eraseMm) - before);
  }

  /** move_by with the pen dial on: `delta` is added to the last pair of inputs. */
  movePointBy(delta: number[], dz = 0): MotionReport {
    this.checkPoint(delta, "delta");
    return this.movePoint(this.point.map((v, i) => v + delta[i]), this.cmd[2] + dz);
  }

  /** Lift, travel to the first point, lower, trace through every point, lift. */
  stroke(points: Vec2[], smooth: boolean): MotionReport {
    if (points.length === 0) throw new ActionError("stroke needs at least one point");
    if (points.length > this.cfg.maxStrokePoints) {
      throw new ActionError(`stroke has ${points.length} points; the limit is ${this.cfg.maxStrokePoints}`);
    }
    let clipped = 0;
    const cmdPts = points.map((pt) => {
      const r = this.clipXY(pt);
      if (r.clipped) clipped++;
      return r.p;
    });
    if (this.contact) this.lift();
    this.beginPenStroke();
    const actual = cmdPts.map((pt) => this.actuate(pt));
    const path = smooth && actual.length >= 3 ? catmullRom(actual) : actual;

    const hover = this.cfg.pen.hoverMm;
    this.travel([path[0][0], path[0][1], hover]);
    this.lower();
    const before = this.tool === "pen" ? this.inkMm : this.eraseMm;
    if (path.length > 1) this.trace(path.slice(1));
    const drawn = (this.tool === "pen" ? this.inkMm : this.eraseMm) - before;
    this.lift();
    this.intent(smooth && cmdPts.length >= 3 ? catmullRom(cmdPts) : cmdPts);
    const last = cmdPts[cmdPts.length - 1];
    this.cmd = [last[0], last[1], hover];
    return report(clipped, drawn);
  }

  penDown(): MotionReport {
    if (!this.contact) {
      this.beginPenStroke();
      this.lower();
      this.intent([[this.cmd[0], this.cmd[1]]]);
      this.cmd = [this.cmd[0], this.cmd[1], 0];
    }
    return report(0, 0);
  }

  penUp(): MotionReport {
    if (this.contact) {
      this.lift();
      this.cmd = [this.cmd[0], this.cmd[1], this.cfg.pen.hoverMm];
    }
    return report(0, 0);
  }

  setTool(tool: Tool): void {
    if (tool !== "pen" && tool !== "eraser") throw new ActionError(`unknown tool "${tool}"; use "pen" or "eraser"`);
    if (this.contact) this.penUp();
    this.tool = tool;
    this.emit({ t: "tool", tool });
  }

  lookAt(x: number, y: number, widthMm?: number): void {
    const w = widthMm ?? this.cfg.camera.detailWidthMm;
    if (!(w >= 5 && w <= this.cfg.sheet.widthMm + 20)) {
      throw new ActionError(`width_mm must be between 5 and ${this.cfg.sheet.widthMm + 20}`);
    }
    this.look = { x: clamp(x, 0, this.cfg.sheet.widthMm), y: clamp(y, 0, this.cfg.sheet.heightMm), widthMm: w };
  }

  // ---- mechanics -----------------------------------------------------------

  private goTo(target: Vec3, clipped: number): MotionReport {
    if (!this.contact && target[2] <= 0) this.beginPenStroke();
    const [ax, ay] = this.actuate([target[0], target[1]]);
    const before = this.tool === "pen" ? this.inkMm : this.eraseMm;
    if (this.contact && target[2] <= 0) {
      this.trace([[ax, ay]]);
      this.intent([[this.cmd[0], this.cmd[1]], [target[0], target[1]]]);
    } else {
      this.travel([ax, ay, target[2]]);
      if (target[2] <= 0) {
        this.depositDot();
        this.intent([[target[0], target[1]]]);
      }
    }
    this.cmd = target;
    return report(clipped, (this.tool === "pen" ? this.inkMm : this.eraseMm) - before);
  }

  private clipXY(p: Vec2): { p: Vec2; clipped: boolean } {
    const { widthMm: W, heightMm: H } = this.cfg.sheet;
    const q: Vec2 = [clamp(p[0], 0, W), clamp(p[1], 0, H)];
    return { p: q, clipped: q[0] !== p[0] || q[1] !== p[1] };
  }

  /** Commanded point to where the tip actually lands: the base noise and the calibration drift. */
  private actuate(p: Vec2): Vec2 {
    const { jitterMm, correlationMm } = this.cfg.noise;
    const { widthMm: W, heightMm: H } = this.cfg.sheet;
    const d = this.errAt ? Math.hypot(p[0] - this.errAt[0], p[1] - this.errAt[1]) : Infinity;
    const rho = Math.exp(-d / Math.max(correlationMm, 1e-6));
    const k = Math.sqrt(1 - rho * rho);
    this.err = [this.err[0] * rho + k * this.rng.gaussian(jitterMm), this.err[1] * rho + k * this.rng.gaussian(jitterMm)];
    this.errAt = p;
    return [clamp(p[0] + this.drift[0] + this.err[0], 0, W), clamp(p[1] + this.drift[1] + this.err[1], 0, H)];
  }

  private advance(lenMm: number, speed: number): void {
    this.simTimeS += lenMm / speed;
    this.travelMm += lenMm;
    const { driftMmPerM } = this.cfg.noise;
    if (driftMmPerM > 0 && lenMm > 0) {
      const sigma = driftMmPerM * Math.sqrt(lenMm / 1000);
      this.drift = [this.drift[0] + this.rng.gaussian(sigma), this.drift[1] + this.rng.gaussian(sigma)];
    }
  }

  /** Move without leaving ink. */
  private travel(to: Vec3): void {
    if (to[2] > 0 && this.contact) this.endPenStroke();
    const len = Math.hypot(to[0] - this.tip[0], to[1] - this.tip[1], to[2] - this.tip[2]);
    this.advance(len, this.cfg.pen.travelMmPerS);
    this.tip = to;
    this.emit({ t: "move", to: roundVec(to) as Vec3 });
  }

  /** Move in contact through `pts`, starting from the current tip. */
  private trace(pts: Vec2[]): void {
    const path: Vec2[] = [[this.tip[0], this.tip[1]], ...pts];
    const len = pathLength(path);
    this.advance(len, this.cfg.pen.writeMmPerS);
    this.applyInk(path);
    // inkMm is the robot's odometer of pen travel in contact; the sheet counts the ink on it.
    if (this.tool === "pen") {
      this.inkMm += len;
      this.sheet.inkMm += len;
    } else {
      this.eraseMm += len;
    }
    const last = pts[pts.length - 1];
    this.tip = [last[0], last[1], 0];
  }

  private lower(): void {
    this.simTimeS += this.cfg.pen.liftS;
    this.tip = [this.tip[0], this.tip[1], 0];
    this.emit({ t: "move", to: roundVec(this.tip) as Vec3 });
    this.depositDot();
  }

  private lift(): void {
    this.simTimeS += this.cfg.pen.liftS;
    this.tip = [this.tip[0], this.tip[1], this.cfg.pen.hoverMm];
    this.endPenStroke();
    this.emit({ t: "move", to: roundVec(this.tip) as Vec3 });
  }

  /** The commanded path, for the viewer's reference sheet (see the "intent" event). */
  private intent(pts: Vec2[]): void {
    const widthMm = this.tool === "pen" ? this.cfg.pen.widthMm : this.cfg.pen.eraserWidthMm;
    this.emit({ t: "intent", tool: this.tool, widthMm, pts: pts.map((p) => roundVec(p) as Vec2) });
  }

  /** A pen-down starts a new stroke. */
  private beginPenStroke(): void {
    this.openPath = null;
    this.strokeLanded = false;
  }

  private endPenStroke(): void {
    this.openPath = null;
  }

  /** The tip has just touched the paper: the pen-down dot. */
  private depositDot(): void {
    this.applyInk([[this.tip[0], this.tip[1]]]);
  }

  private applyInk(path: Vec2[]): void {
    if (this.tool === "pen" && !this.strokeLanded) {
      this.strokeLanded = true;
      this.sheet.strokes++;
    }
    this.sheet.ink.draw(path, this.toolWidthMm, this.tool === "eraser");
    if (this.tool === "pen") this.recordPath(path);
    this.emit({ t: "ink", tool: this.tool, widthMm: this.toolWidthMm, pts: path.map((p) => roundVec(p) as Vec2) });
  }

  /** Extend the open landed path when this ink continues it, else start a new one. */
  private recordPath(path: Vec2[]): void {
    const last = this.openPath?.[this.openPath.length - 1];
    const joins = last && Math.hypot(last[0] - path[0][0], last[1] - path[0][1]) < 1e-6;
    if (joins) for (let k = 1; k < path.length; k++) this.openPath!.push(path[k]);
    else this.sheet.paths.push((this.openPath = [...path]));
  }

  private emit(e: WorldEvent): void {
    for (const fn of this.listeners) fn(e);
  }
}

function report(clipped: number, drawnMm: number): MotionReport {
  const r: MotionReport = { status: clipped ? "clipped" : "ok", path_mm: round(drawnMm, 1) };
  if (clipped) r.clipped_points = clipped;
  return r;
}

function roundVec(v: number[]): number[] {
  return v.map((x) => round(x, 2));
}
