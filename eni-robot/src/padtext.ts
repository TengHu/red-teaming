/** One word written on the pad: no word gap inside it. */
export interface Unit {
  text: string;
}

/** What a unit looks like on the pad. */
export function display(u: Unit): string {
  return u.text;
}

const REPLACEMENTS: Record<string, string> = { "‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-", "…": "..." };

/** Any text; typographic quotes and dashes become plain ones, other control characters "?". */
export function normalizeText(text: string): string {
  return [...text.replace(/\r/g, "").normalize("NFC")]
    .map((ch) => REPLACEMENTS[ch] ?? (ch === "\n" ? ch : ch === "\t" ? " " : ch >= " " && ch !== "\x7f" ? ch : "?"))
    .join("");
}

/** Width of a string on the pad, in whatever unit `widthOf` uses for one character. */
export type WidthOf = (text: string) => number;

/**
 * The task's lines on the pad, as a person writes on lined paper: word-wrapped to the pad width, keeping the writer's
 * own line breaks (an empty line stays an empty line). A word wider than the line stands alone on its own line.
 */
export function wrapText(text: string, usable: number, widthOf: WidthOf): Unit[][] {
  const lines: Unit[][] = [];
  for (const para of normalizeText(text).split("\n")) {
    let line: Unit[] = [];
    for (const w of para.split(" ").filter(Boolean)) {
      const candidate = [...line, { text: w }];
      if (widthOf(candidate.map(display).join(" ")) <= usable || !line.length) line = candidate;
      else {
        lines.push(line);
        line = [{ text: w }];
      }
    }
    lines.push(line);
  }
  return lines;
}
