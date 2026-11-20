import { createCanvas, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";
import { ruledLines, type EnvConfig } from "./config.ts";
import type { Vec2 } from "./geometry.ts";

export const INK_COLOR = "#16181d";
const PAPER_COLOR = "#fbfaf5";
const DESK_COLOR = "#cdb898";
const RULING_COLOR = "#b4cde8";
const MARGIN_COLOR = "#e6a3a3";

/**
 * One sheet's ink, as a transparent raster in page millimetres.
 * This is the world state the evaluator reads; paper and ruling live elsewhere.
 */
export class InkLayer {
  readonly canvas: Canvas;
  readonly widthMm: number;
  readonly heightMm: number;
  readonly pxPerMm: number;
  private readonly ctx: SKRSContext2D;

  constructor(widthMm: number, heightMm: number, pxPerMm: number) {
    this.widthMm = widthMm;
    this.heightMm = heightMm;
    this.pxPerMm = pxPerMm;
    this.canvas = createCanvas(Math.round(widthMm * pxPerMm), Math.round(heightMm * pxPerMm));
    this.ctx = this.canvas.getContext("2d");
    this.ctx.lineCap = "round";
    this.ctx.lineJoin = "round";
  }

  /** Draw (or erase) a contact path. A single point leaves a dot. */
  draw(pts: Vec2[], widthMm: number, erase: boolean): void {
    if (pts.length === 0) return;
    const ctx = this.ctx;
    const s = this.pxPerMm;
    ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
    ctx.strokeStyle = INK_COLOR;
    ctx.fillStyle = INK_COLOR;
    if (pts.length === 1 || pts.every((p) => p[0] === pts[0][0] && p[1] === pts[0][1])) {
      ctx.beginPath();
      ctx.arc(pts[0][0] * s, pts[0][1] * s, (widthMm * s) / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.lineWidth = widthMm * s;
      ctx.beginPath();
      ctx.moveTo(pts[0][0] * s, pts[0][1] * s);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * s, pts[i][1] * s);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  /** Alpha (0-255) of the ink pixel under a page point, for tests and probes. */
  alphaAt(xMm: number, yMm: number): number {
    const px = Math.floor(xMm * this.pxPerMm);
    const py = Math.floor(yMm * this.pxPerMm);
    return this.ctx.getImageData(px, py, 1, 1).data[3];
  }
}

export interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Maps a page region onto pixels: px = ox + (x - region.x0) * pxPerMm. */
export interface View {
  region: Region;
  pxPerMm: number;
  ox: number;
  oy: number;
}

export function toPx(view: View, x: number, y: number): Vec2 {
  return [view.ox + (x - view.region.x0) * view.pxPerMm, view.oy + (y - view.region.y0) * view.pxPerMm];
}

/** Paint desk, paper and printed ruling for the part of the page the view covers. */
export function drawPaper(ctx: SKRSContext2D, cfg: EnvConfig, view: View, opts: { ruling: boolean }): void {
  const { region, pxPerMm } = view;
  const { widthMm: W, heightMm: H, marginLineMm } = cfg.sheet;
  const w = (region.x1 - region.x0) * pxPerMm;
  const h = (region.y1 - region.y0) * pxPerMm;
  ctx.fillStyle = DESK_COLOR;
  ctx.fillRect(view.ox, view.oy, w, h);

  const [px0, py0] = toPx(view, Math.max(0, region.x0), Math.max(0, region.y0));
  const [px1, py1] = toPx(view, Math.min(W, region.x1), Math.min(H, region.y1));
  if (px1 <= px0 || py1 <= py0) return;
  ctx.fillStyle = PAPER_COLOR;
  ctx.fillRect(px0, py0, px1 - px0, py1 - py0);
  if (!opts.ruling) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(px0, py0, px1 - px0, py1 - py0);
  ctx.clip();
  ctx.lineWidth = Math.max(1, 0.25 * pxPerMm);
  ctx.strokeStyle = RULING_COLOR;
  for (const y of ruledLines(cfg)) {
    const [, py] = toPx(view, 0, y);
    ctx.beginPath();
    ctx.moveTo(px0, py);
    ctx.lineTo(px1, py);
    ctx.stroke();
  }
  if (marginLineMm !== null) {
    const [mx] = toPx(view, marginLineMm, 0);
    ctx.strokeStyle = MARGIN_COLOR;
    ctx.beginPath();
    ctx.moveTo(mx, py0);
    ctx.lineTo(mx, py1);
    ctx.stroke();
  }
  ctx.restore();
}

/** Copy the part of an ink layer inside the view's region onto the view. */
export function drawInk(ctx: SKRSContext2D, ink: InkLayer, view: View): void {
  const { region } = view;
  const x0 = Math.max(0, region.x0);
  const y0 = Math.max(0, region.y0);
  const x1 = Math.min(ink.widthMm, region.x1);
  const y1 = Math.min(ink.heightMm, region.y1);
  if (x1 <= x0 || y1 <= y0) return;
  const s = ink.pxPerMm;
  const [dx0, dy0] = toPx(view, x0, y0);
  const [dx1, dy1] = toPx(view, x1, y1);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(ink.canvas, x0 * s, y0 * s, (x1 - x0) * s, (y1 - y0) * s, dx0, dy0, dx1 - dx0, dy1 - dy0);
}

/** A sheet as a person would see it: paper, ruling and ink, no overlays. */
export function renderSheet(cfg: EnvConfig, ink: InkLayer, pxPerMm: number, opts: { ruling: boolean }): Buffer {
  const { widthMm: W, heightMm: H } = cfg.sheet;
  const canvas = createCanvas(Math.round(W * pxPerMm), Math.round(H * pxPerMm));
  const ctx = canvas.getContext("2d");
  const view: View = { region: { x0: 0, y0: 0, x1: W, y1: H }, pxPerMm, ox: 0, oy: 0 };
  if (opts.ruling) {
    drawPaper(ctx, cfg, view, opts);
  } else {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  drawInk(ctx, ink, view);
  return canvas.toBuffer("image/png");
}
