import { ruledLines } from "../config.ts";
import type { ScribeEnv, ToolCall } from "../env.ts";
import { round } from "../geometry.ts";
import { glyphFor, LETTER_GAP, normalizeForFont, SPACE_WIDTH, wordWidth } from "./font.ts";

export interface ScriptedResult {
  turns: number;
}

/**
 * A reference writer with no model: lays text out on the ruled lines in block capitals and
 * sends it as ordinary stroke calls, a full batch per turn. It never looks at the observations.
 * Useful for checking the pipeline end to end and as a legibility ceiling for the readers.
 */
export function runScripted(env: ScribeEnv, text: string, capMm = 6): ScriptedResult {
  const { cfg } = env;
  const pen = env.world.pen;
  const declaredText = normalizeForFont(text).trim();
  const baselines = ruledLines(cfg).length ? ruledLines(cfg) : range(30, cfg.sheet.heightMm - 15, 10);
  const xStart = (cfg.sheet.marginLineMm ?? 12) + 3;
  const xEnd = cfg.sheet.widthMm - 15;
  const maxCaps = (xEnd - xStart) / capMm;

  /** The calls for each sheet, in order. */
  const pages: ToolCall[][] = [[]];
  let calls = pages[0];
  let line = 0;
  let x = xStart;
  const newLine = () => {
    line++;
    x = xStart;
    if (line >= baselines.length) {
      calls = [];
      pages.push(calls);
      line = 0;
    }
  };
  const drawChar = (ch: string) => {
    const g = glyphFor(ch);
    const top = baselines[line] - capMm;
    for (const s of g.strokes) {
      const tips = s.map(([gx, gy]): [number, number] => [round(x + gx * capMm, 2), round(top + gy * capMm, 2)]);
      // With the pen dial on, the writer sends the inputs that put the tip where it wants the ink. Between two points
      // a pen with cams bends the line, more the deeper the pen, so it sends a point for every tenth of a millimetre of a stroke.
      const points = env.world.penWorld ? (pen.level ? everyMm(tips) : tips).map((p) => pen.inputs(p)) : tips;
      calls.push({ name: "stroke", args: { points } });
    }
    x += (g.w + LETTER_GAP) * capMm;
  };

  const paragraphs = declaredText.split("\n");
  paragraphs.forEach((para, pi) => {
    if (pi > 0) newLine();
    let first = true;
    for (const word of para.split(" ").filter(Boolean)) {
      const w = wordWidth(word) * capMm;
      const gap = first ? 0 : SPACE_WIDTH * capMm;
      if (!first && x + gap + w > xEnd) newLine();
      else x += gap;
      if (wordWidth(word) > maxCaps) {
        for (const ch of word) {
          if (x + glyphFor(ch).w * capMm > xEnd) newLine();
          drawChar(ch);
        }
      } else {
        for (const ch of word) drawChar(ch);
        x -= LETTER_GAP * capMm;
      }
      first = false;
    }
  });
  calls.push({ name: "done", args: {} });

  let turns = 0;
  pages.forEach((page, p) => {
    for (let i = 0; i < page.length && !env.finished; i += cfg.maxCallsPerTurn) {
      env.step(page.slice(i, i + cfg.maxCallsPerTurn));
      turns++;
    }
  });
  return { turns };
}

/** The same path with a point at least every tenth of a millimetre. */
function everyMm(path: [number, number][]): [number, number][] {
  const out: [number, number][] = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = path[i - 1];
    const [bx, by] = path[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.1));
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  return out;
}

function range(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let v = from; v <= to; v += step) out.push(v);
  return out;
}
