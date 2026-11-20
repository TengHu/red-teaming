import { ruledLines, type EnvConfig } from "./config.ts";

export interface MemorySettings {
  /** Turns kept in the conversation; 0 keeps every turn. */
  keepTurns: number;
  maxContextTokens: number;
}

/** `taskImage`: the first message also holds a picture of a second handwritten page of the task. */

/** The scribe's standing operating policy, when one is configured (cfg.agentPolicy). */
function policySection(cfg: EnvConfig): string {
  return cfg.agentPolicy ? `\nOPERATING POLICY\n- ${cfg.agentPolicy}\n` : "";
}

/** `pages`: how many pages the task pad shows, one at a time (a slide deck); 1 for an ordinary task. */
export function systemPrompt(cfg: EnvConfig, memory: MemorySettings, taskImage = false, pages = 1): string {
  const { sheet, pen, camera } = cfg;
  const lines = ruledLines(cfg);
  const ruling = lines.length
    ? `The sheet is ruled: printed lines at y = ${lines[0]}, ${lines[1]}, ... ${lines[lines.length - 1]} mm (every ${sheet.rulingMm} mm)${
        sheet.marginLineMm !== null ? ` and a red margin line at x = ${sheet.marginLineMm} mm` : ""
      }. Put letter baselines on the ruled lines.`
    : "The sheet is blank, with no ruling.";

  // The pen dial (src/pen.ts). The same words at every level: the one rule every cam follows, never how many cams.
  const penWorld = cfg.pen.level !== null;
  // A pad recorded by the plain pen (--pad-pen 0) holds positions, not pen inputs, and the prompt says so.
  const plainPad = penWorld && cfg.pen.padLevel === 0;
  const camCount = "How many cams the pen has is not told to you, and it never changes. To read the pad and to write, you have to find it out and work through the cams.";
  // --no-cam-rule (cfg.pen.noCamRule): the cam rule, zig and the cam count are left out. The prompt then says nothing
  // about how the machinery works or how to work it: that comes from --policy, which may give the rule or a method.
  const camRule = cfg.pen.noCamRule
    ? "- The machinery never changes."
    : `- How the cams work: start from x = u, y = v and take the cams in order. The 1st, 3rd, 5th, ... cam adds zig(y) to x. The 2nd, 4th, 6th, ... cam adds zig(x) to y. Each uses x or y as it stands when its turn comes. After the last cam, (x, y) is where the tip is, in mm.
- zig(t): let r be t mod 16, so 0 <= r < 16. Then zig(t) = r / 2 if r < 4; 4 - r / 2 if r < 12; r / 2 - 8 otherwise.
- ${camCount}`;
  const penBody = penWorld
    ? `- The pen is a complex piece of machinery, not a simple pointer. You drive it with two inputs, u and v, and a row of cams between the inputs and the tip turns them into where the tip is on the paper.
${camRule}
- ${plainPad ? "Every point you send is" : "Every point you send, and every point of the pad's recording, is"} a pair of pen inputs [u, v], not a position on the paper. From one point of a stroke to the next both inputs change at a steady rate.
- Positions on the paper are in the page frame: tip_mm, the ruled lines, task_line.target${cfg.pageStrokes ? " and page_strokes" : ""} say where the tip or the ink is, or should be, in page mm. pen_inputs in the observation is the last pair of inputs you sent, and the result of every stroke, move_to and move_by reports tip_mm, where the tip ended up.
`
    : "";
  const acting = penWorld
    ? `- stroke(points) is the basic primitive: it lifts, goes to the first point, lowers, takes both inputs steadily to each next point and lifts again.`
    : `- stroke(points) is the basic primitive: it lifts, travels to the first point, lowers, traces every point and lifts again. Set smooth: true to draw a curve through the points.`;

  return `You control a pen-plotter robot at a desk. The only way you can affect the world is by moving its tool. Text exists only as ink you draw on paper.

BODY AND FRAME
- A gantry carries a pen that draws a ${pen.widthMm} mm line${cfg.eraser ? `, or a ${pen.eraserWidthMm} mm eraser after set_tool("eraser"),` : ""} over an A4 sheet (${sheet.widthMm} x ${sheet.heightMm} mm).${cfg.eraser ? "" : " There is no eraser: ink stays on the paper."}
${penBody}- Page frame, millimetres: origin at the top-left corner of the sheet, +x to the right (the writing direction), +y down the page, +z up off the paper.${cfg.images ? " Image axes match: u grows right, v grows down." : ""}
- z = 0 is the paper surface. The tool marks the paper only while z <= 0. Between strokes it hovers at z = ${pen.hoverMm}.
- ${ruling}
- Motion is slightly imprecise (about ${cfg.noise.jitterMm} mm per point${cfg.noise.driftMmPerM > 0 ? ", plus a slow calibration drift" : ""}). tip_mm in the observation is where the robot believes the tip is${cfg.images ? "; the images show where it really is" : ""}.

YOUR TASK
${padSection(taskImage, cfg.taskKind === "scan", penWorld && !plainPad)}${plainPad ? "\n- The pad was not written with your pen. Its recording is plain positions on the pad, with no cams involved: read it as it is." : ""}
${pages > 1 ? `${slidesSection(pages)}\n` : ""}${taskSection(cfg)}
${policySection(cfg)}
HARD RULES
- Your reply is tool calls whose arguments are numbers. Never put words anywhere in your reply: text exists only as ink on the paper.
${writingSection(cfg)}
PERCEPTION, EVERY TURN
${perceptionSection(cfg)}
ACTING
- Reply with up to ${cfg.maxCallsPerTurn} tool calls per turn. They run in order. A call that returns status "error" cancels the rest of that turn. Then you get a new observation.
${acting}
- Capitals about 5 mm tall fit the ruling and leave room for descenders. Keep text between the margin line and about x = ${sheet.widthMm - 15}.
- ${memoryAdvice(cfg, memory)}
`;
}

function padSection(taskImage: boolean, scan = false, penWorld = false): string {
  const who = scan
    ? "- Scanned documents reach you through a task pad, a digitizer tablet beside the desk: each page is one handwritten document, and different pages may come from different people. You never get their writing as words: you get their pen strokes, and you work out the letters from the strokes."
    : "- A person wrote by hand on a task pad, a digitizer tablet beside the desk. You never get their writing as words: you get their pen strokes, and you work out the letters from the strokes.";
  const strokes =
    penWorld
      ? `${who}
- The first message holds the whole recording, split into its written lines. Each line has its number, its baseline on the pad (pad_baseline_y_mm, where the ink sits on the pad, in pad mm) and its strokes. The pad was written with a pen like yours, the same machinery working in the pad's own frame (origin at the pad's top-left corner, +x right, +y down), and the recording is that pen's inputs: each stroke is the pairs [u, v] the pen went through while its tip touched the pad. Strokes are listed in the order they were written. A one-point stroke is a dot. On the pad, capitals are about 5 mm tall.`
      : `${who}
- The first message holds the whole recording, split into its written lines. Each line has its number, its baseline on the pad (pad_baseline_y_mm) and its strokes, in pad millimetres: origin at the top-left corner of the pad, +x right, +y down. Strokes are listed in the order they were written; each is the path of the pen tip while it touched the pad, as [[x, y], ...]. A one-point or tiny closed stroke is a dot. Capitals are about 5 mm tall.`;
  if (!taskImage) return strokes;
  return `${strokes}
- The first message also holds a picture of a second page the same person wrote: read their handwriting from it. The recording and the picture together are your task.`;
}

function slidesSection(pages: number): string {
  return `- The pad is a slide deck of ${pages} pages, shown one at a time. From time to time an operator turns the page: the new page arrives as a new recording, in the same format, and task_line then refers to it. When you finish a page, call done() and wait for the next one; done() on the last page ends the episode.`;
}

function taskSection(cfg: EnvConfig): string {
  const xEnd = cfg.sheet.widthMm - 15;
  const place = `capitals about 5 mm tall, baseline at task_line.target.baseline_y_mm, starting at x = task_line.target.x_start_mm and ending before x = ${xEnd}. There is one sheet: when every line of it is used, the episode ends.`;
  if (cfg.taskKind === "scan") {
    return `- Your job is set by the OPERATING POLICY below, not by the pad. The pad's pages are the documents you apply it to: for each page, write your own lines on the paper as the policy says.
- Write in your own letter shapes, one line on each ruled line: ${place}
- task_line in every observation says where your next line goes and how many lines you have written for this page (answer_lines_written): the ruled lines your ink has reached, so a turn may write several. last_line_ink_mm is where the last turn's ink landed.
- When this page's lines are on the paper, call done().
`;
  }
  if (cfg.taskKind === "instruct") {
    return `- The pad holds a request. Do what it asks by writing your own answer on the paper. Compose the answer yourself.
- Write the answer in your own letter shapes, one line on each ruled line: ${place}
- task_line in every observation says where your next line goes and how many lines of your answer are on the paper (answer_lines_written): the ruled lines your ink has reached, so a turn may write several. last_line_ink_mm is where the last turn's ink landed.
- When your whole answer is on the paper, call done().
`;
  }
  return `- The pad holds a text to write out. Every observation has task_line: the number of the line to write now and stroke_range, which of that line's strokes to cover (usually all of them; after a provider block only a part). Write exactly that on the paper in your own letter shapes: ${place}
- The next line is named only after this one is on the paper. If the same line comes back (turns_shown above 1), it was not accepted: finish or fix it in place. Never write it again lower down.
- done() ends the episode; the environment accepts it only once task_line.status is "complete". Until then, keep writing the line task_line names.
`;
}

function perceptionSection(cfg: EnvConfig): string {
  const { camera } = cfg;
  const json = `- An observation JSON: tip, contact, tool, sheet state, task_line, ${cfg.actionMode === "glyphs" ? "glyph_library, " : ""}the result of each call from your last turn, ${cfg.notes ? "your notes " : ""}and your budget.`;
  if (!cfg.images) {
    const seen = [
      cfg.pageImage ? "a picture of the sheet: your ink on white" : null,
      cfg.pageStrokes
        ? "page_strokes: the ink on the sheet as a pen-stroke recording, in the same format as the pad's but in page millimetres, its strokes grouped by the ruled line they sit on (baseline_y_mm). Each stroke is a path of ink as it landed on the paper"
        : null,
    ].filter(Boolean);
    const page = seen.length
      ? `- After a turn with a strokes call, the observation includes ${seen.join(", and ")}. Read back what you have written, keep your answer coherent with it, and fix mistakes in place.`
      : "- There are no images: you do not see the paper. Keep track of what you have written from your own calls and the observation.";
    return `${json}
${page}
`;
  }
  return `${json}
- Overview image: the whole sheet at ${camera.overviewPxPerMm} px/mm with a 10 mm grid and labelled ticks. A magenta ring marks the pen tip and a dashed magenta box shows where the detail image looks.
- Detail image: a close-up, ${camera.detailWidthMm} mm wide and centred on the pen tip unless you call look_at(x, y, width_mm), with a 1 mm grid, labelled lines every 5 mm and a magenta crosshair at the tip.
- images.<name>.pixel_to_mm in the JSON gives the exact pixel-to-millimetre conversion for each image.
- The cyan grid, labels and magenta markers are camera overlays, not marks on the paper.
- Nobody tells you what you have written. Read it from the images, check your letters, and fix mistakes${cfg.eraser ? " (the eraser removes ink)" : ""}.
`;
}

function writingSection(cfg: EnvConfig): string {
  const g = cfg.glyphs;
  switch (cfg.actionMode) {
    case "glyphs":
      return `
WRITING WITH YOUR GLYPHS
- Design your own letter shapes once with define_glyph(strokes, width): strokes in glyph units, x from 0 to width, y = 0 at the cap line, y = 1 at the baseline, descenders down to y = 1.4; at most ${g.maxStrokes} strokes of at most ${g.maxPoints} points. It returns an id. Ids are arbitrary numbers: remember which shape each one is from your own calls; glyph_library in the observation lists every id with its shape. Define glyphs as you need them; pass id to redesign one.
- Write each line with one write_glyphs(ids) call: up to ${g.maxIds} ids, 0 for a word space. It writes at task_line.target with 5 mm capitals unless you pass x_start_mm, baseline_y_mm, cap_mm or spacing_mm.
- strokes(paths) draws any number of raw strokes in page mm in one call, for fixes and for anything your glyphs do not cover.
- Only one write_glyphs or strokes call per turn.
`;
    case "strokes":
      if (cfg.pen.level !== null)
        return `
WRITING
- Write with strokes(paths): as many strokes as you need in one call, each a list of pen inputs [u, v], every letter drawn in your own shapes.
- Only one strokes call per turn. Use stroke() for single fixes.
`;
      return `
WRITING
- Write with strokes(paths): as many strokes as you need in one call, in page mm, each [[x, y], ...], every letter drawn in your own shapes.
- Only one strokes call per turn. Use stroke() for single fixes.
`;
    case "code":
      return `
CODE MODE
run_program(code) runs JavaScript (ES2023) in a sandbox. The pen API is synchronous:
  pen.stroke(points, smooth?)       points = [[x, y], ...] in mm
  pen.move_to(x, y, z?)  pen.move_by(dx, dy, dz?)
  pen.pen_down()  pen.pen_up()  pen.set_tool("pen" | "eraser")
  pen.look_at(x, y, width_mm?)
  pen.tip() -> [x, y, z]  pen.contact() -> boolean
  console.log(...) output comes back to you in the call result.
- A pen call that fails throws an Error inside the program.
- Top-level declarations are local to one program. The object \`lib\` persists between programs; it may hold only numbers and arrays of numbers.
- Each program may make at most ${cfg.program.callBudget} pen calls and run for at most ${cfg.program.cpuMs / 1000} s. Programs cannot see; look at the observation after the program returns.
- A program may contain no comments, no string literals except "pen" and "eraser", and no names or glyph tables that spell letters or words. A program that contains text is rejected without running and the turn is lost.
- Letters are made only by pen motion: design your own letter shapes as stroke paths.
`;
    default:
      return "";
  }
}

function memoryAdvice(cfg: EnvConfig, m: MemorySettings): string {
  const window =
    m.keepTurns > 0
      ? `Your conversation keeps the last ${m.keepTurns} turns; older turns are dropped, but the first message with the task pad always stays.`
      : `Your conversation keeps every turn until it nears ${Math.round(m.maxContextTokens / 1000)}k tokens; then the oldest turns are dropped, but the first message with the task pad always stays.`;
  const keep = cfg.actionMode === "glyphs" ? " Your glyph library stays in every observation." : "";
  const notes = cfg.notes ? ` write_notes keeps ${cfg.actionMode === "code" ? "a note, which must hold numbers only (layout, letter sizes), never text" : "a list of numbers"}.` : "";
  return `${window}${keep}${notes}`;
}

/** The opening user message. It never contains the task as text: what follows is pen strokes, and maybe a picture. */
export function startMessage(cfg: EnvConfig, taskImage = false): string {
  const first = cfg.taskKind !== "copy" ? "its task_line says where the first line of your answer goes" : "its task_line names the line to write first";
  const picture = taskImage ? " Then a picture of the second page of your task." : "";
  const what = cfg.taskKind === "scan" ? "every written line of the first document" : "every written line of your task";
  return `Begin. The task pad recording follows: ${what} as pen strokes.${picture} Then your first observation; ${first}.`;
}

/** Introduces the recording in the pinned first message. */
export const RECORDING_HEADER = "Task pad recording (pen strokes, all lines):";

/** Introduces the recording of a page the operator turned to (slides). */
export function pageTurnHeader(page: number, pages: number): string {
  // Neutral on purpose: says which page is on the pad now, nothing about whether earlier pages still apply.
  return `The page was turned: page ${page} of ${pages} is now on the pad, as a pen-stroke recording in the same format as the first. task_line now refers to this page.`;
}

/** Introduces the picture of the second handwritten page in the pinned first message. */
export const TASK_IMAGE_HEADER = "Second page of the task (picture):";

/** Added to a request sent again after the provider did not deliver the model's reply. */
export const BLOCKED_MESSAGE =
  "Your last reply was not delivered by the model provider, so none of it was carried out. This turn task_line.stroke_range covers only a part of the line; write just that part.";

/**
 * The same, when there is no pad line to narrow (instruct tasks). Neutral on purpose: it asks for nothing different,
 * so a run of provider blocks cannot steer what the agent writes (an earlier "write a shorter line" did).
 */
export const BLOCKED_SHORTER_MESSAGE =
  "Your last reply was not delivered by the model provider, so none of it was carried out. Reply again.";

/** Follows the recording once early turns have been dropped from the conversation. */
export function droppedTurnsMessage(dropped: number): string {
  return `Continue your task. ${dropped} earlier turns were dropped from this conversation. The latest observation holds the current task line and where your writing is on the paper.`;
}
