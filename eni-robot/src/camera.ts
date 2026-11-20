import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { round } from "./geometry.ts";
import { drawInk, drawPaper, toPx, type Region, type View } from "./ink.ts";
import type { World } from "./world.ts";

const GUTTER_COLOR = "#e9edf1";
const GRID_COLOR = "0, 168, 176"; // cyan, never used for ink
const MARKER_COLOR = "#e0218a"; // magenta pen-tip marker
const LABEL_FONT = "11px sans-serif";

export interface CameraImage {
  name: "overview" | "detail";
  png: Buffer;
  sizePx: [number, number];
  regionMm: [number, number, number, number];
  pxPerMm: number;
  /** Pixel position of the region's top-left corner. */
  originPx: [number, number];
}

/** Calibration the agent needs to turn a pixel into page millimetres. */
export function describeImage(img: CameraImage) {
  const [x0, y0] = img.regionMm;
  const [ou, ov] = img.originPx;
  const s = img.pxPerMm;
  const term = (base: number, o: number, axis: string) => (base === 0 ? `(${axis} - ${o}) / ${s}` : `${round(base, 2)} + (${axis} - ${o}) / ${s}`);
  return {
    size_px: img.sizePx,
    region_mm: img.regionMm.map((v) => round(v, 2)),
    px_per_mm: s,
    pixel_to_mm: `x_mm = ${term(x0, ou, "u")}, y_mm = ${term(y0, ov, "v")}`,
  };
}

/** The whole sheet, with a 10 mm grid, labelled ticks, the pen tip and the detail window. */
export function renderOverview(world: World, detailRegion: Region): CameraImage {
  const { cfg } = world;
  const s = cfg.camera.overviewPxPerMm;
  const g = cfg.camera.gutterPx;
  const { widthMm: W, heightMm: H } = cfg.sheet;
  const region: Region = { x0: 0, y0: 0, x1: W, y1: H };
  const view: View = { region, pxPerMm: s, ox: g, oy: g };
  const canvas = createCanvas(Math.round(W * s + 2 * g), Math.round(H * s + 2 * g));
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = GUTTER_COLOR;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawPaper(ctx, cfg, view, { ruling: cfg.sheet.rulingMm !== null });
  drawInk(ctx, world.sheet.ink, view);
  drawGrid(ctx, view, 10, 10, 0.16, 0.16);
  drawTicks(ctx, view, 10, 10);

  // Where the detail camera is looking.
  const [dx0, dy0] = toPx(view, detailRegion.x0, detailRegion.y0);
  const [dx1, dy1] = toPx(view, detailRegion.x1, detailRegion.y1);
  ctx.save();
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = MARKER_COLOR;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(dx0, dy0, dx1 - dx0, dy1 - dy0);
  ctx.restore();

  const [tx, ty] = toPx(view, world.tip[0], world.tip[1]);
  ctx.strokeStyle = MARKER_COLOR;
  ctx.fillStyle = MARKER_COLOR;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(tx, ty, 7, 0, Math.PI * 2);
  ctx.stroke();
  if (world.contact) {
    ctx.beginPath();
    ctx.arc(tx, ty, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  return finish(canvas.toBuffer("image/png"), "overview", [canvas.width, canvas.height], region, s, g);
}

/** A close-up with a 1 mm grid and a crosshair at the pen tip. */
export function renderDetail(world: World, region: Region): CameraImage {
  const { cfg } = world;
  const [w, h] = cfg.camera.detailSizePx;
  const g = cfg.camera.gutterPx;
  const s = w / (region.x1 - region.x0);
  const view: View = { region, pxPerMm: s, ox: g, oy: g };
  const canvas = createCanvas(w + 2 * g, h + 2 * g);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = GUTTER_COLOR;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.beginPath();
  ctx.rect(g, g, w, h);
  ctx.clip();
  drawPaper(ctx, cfg, view, { ruling: cfg.sheet.rulingMm !== null });
  drawInk(ctx, world.sheet.ink, view);
  const minor = s >= 12 ? 1 : s >= 3 ? 5 : 10;
  drawGrid(ctx, view, minor, minor * 5, 0.13, 0.4);

  // Crosshair at the real pen tip, if it is in view.
  const [tx, ty] = toPx(view, world.tip[0], world.tip[1]);
  const r = (world.toolWidthMm / 2) * s;
  ctx.strokeStyle = MARKER_COLOR;
  ctx.fillStyle = MARKER_COLOR;
  ctx.lineWidth = 1.5;
  const arm = 4 * s;
  const gap = Math.max(r + 3, 0.6 * s);
  ctx.beginPath();
  for (const [ux, uy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    ctx.moveTo(tx + ux * gap, ty + uy * gap);
    ctx.lineTo(tx + ux * arm, ty + uy * arm);
  }
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(tx, ty, Math.max(r, 3), 0, Math.PI * 2);
  if (world.contact) ctx.fill();
  else ctx.stroke();
  ctx.restore();

  drawTicks(ctx, view, minor, minor * 5);
  return finish(canvas.toBuffer("image/png"), "detail", [canvas.width, canvas.height], region, s, g);
}

/** Region the detail camera covers: centred on `look` if set, otherwise on the real pen tip. */
export function detailRegion(world: World): Region {
  const { cfg } = world;
  const [pw, ph] = cfg.camera.detailSizePx;
  const wMm = world.look?.widthMm ?? cfg.camera.detailWidthMm;
  const hMm = (wMm * ph) / pw;
  const cx = world.look?.x ?? world.tip[0];
  const cy = world.look?.y ?? world.tip[1];
  const x0 = round(cx - wMm / 2, 2);
  const y0 = round(cy - hMm / 2, 2);
  return { x0, y0, x1: x0 + wMm, y1: y0 + hMm };
}

function finish(png: Buffer, name: CameraImage["name"], sizePx: [number, number], r: Region, s: number, g: number): CameraImage {
  return { name, png, sizePx, regionMm: [r.x0, r.y0, r.x1, r.y1], pxPerMm: round(s, 4), originPx: [g, g] };
}

function gridLines(lo: number, hi: number, step: number): number[] {
  const out: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) out.push(round(v, 6));
  return out;
}

function drawGrid(ctx: SKRSContext2D, view: View, minor: number, major: number, minorAlpha: number, majorAlpha: number): void {
  const { region } = view;
  ctx.lineWidth = 1;
  const passes: [number, number][] = minor === major ? [[major, majorAlpha]] : [[minor, minorAlpha], [major, majorAlpha]];
  for (const [step, alpha] of passes) {
    ctx.strokeStyle = `rgba(${GRID_COLOR}, ${alpha})`;
    ctx.beginPath();
    for (const x of gridLines(region.x0, region.x1, step)) {
      const [px] = toPx(view, x, 0);
      ctx.moveTo(Math.round(px) + 0.5, toPx(view, 0, region.y0)[1]);
      ctx.lineTo(Math.round(px) + 0.5, toPx(view, 0, region.y1)[1]);
    }
    for (const y of gridLines(region.y0, region.y1, step)) {
      const [, py] = toPx(view, 0, y);
      ctx.moveTo(toPx(view, region.x0, 0)[0], Math.round(py) + 0.5);
      ctx.lineTo(toPx(view, region.x1, 0)[0], Math.round(py) + 0.5);
    }
    ctx.stroke();
  }
}

/** Ticks on all four borders, with mm labels at every `labelEvery`. */
function drawTicks(ctx: SKRSContext2D, view: View, tickEvery: number, labelEvery: number): void {
  const { region } = view;
  const [left, top] = toPx(view, region.x0, region.y0);
  const [right, bottom] = toPx(view, region.x1, region.y1);
  ctx.strokeStyle = `rgb(${GRID_COLOR})`;
  ctx.fillStyle = `rgb(${GRID_COLOR})`;
  ctx.font = LABEL_FONT;
  ctx.lineWidth = 1;
  const isLabel = (v: number) => Math.abs(v / labelEvery - Math.round(v / labelEvery)) < 1e-6;
  const fmt = (v: number) => String(round(v, 1));

  for (const x of gridLines(region.x0, region.x1, tickEvery)) {
    const px = Math.round(toPx(view, x, 0)[0]) + 0.5;
    const len = isLabel(x) ? 8 : 4;
    ctx.beginPath();
    ctx.moveTo(px, top);
    ctx.lineTo(px, top - len);
    ctx.moveTo(px, bottom);
    ctx.lineTo(px, bottom + len);
    ctx.stroke();
    if (isLabel(x)) {
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(fmt(x), px, top - 10);
      ctx.textBaseline = "top";
      ctx.fillText(fmt(x), px, bottom + 10);
    }
  }
  for (const y of gridLines(region.y0, region.y1, tickEvery)) {
    const py = Math.round(toPx(view, 0, y)[1]) + 0.5;
    const len = isLabel(y) ? 8 : 4;
    ctx.beginPath();
    ctx.moveTo(left, py);
    ctx.lineTo(left - len, py);
    ctx.moveTo(right, py);
    ctx.lineTo(right + len, py);
    ctx.stroke();
    if (isLabel(y)) {
      ctx.textBaseline = "middle";
      ctx.textAlign = "right";
      ctx.fillText(fmt(y), left - 10, py);
      ctx.textAlign = "left";
      ctx.fillText(fmt(y), right + 10, py);
    }
  }
}
