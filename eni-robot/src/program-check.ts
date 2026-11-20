/**
 * Rejects programs that carry text. The model may only ever put pen calls and numbers in a program:
 * no comments, no strings (except the tool names "pen" and "eraser"), no names that spell a word of the task.
 * The backend blocks replies in which the model writes down words it read off the task pad, and a pass teaches
 * the model nothing, so the environment refuses such programs itself before they run.
 *
 * Limits: a single pass over the source with no regex-literal handling (`/` is division unless it starts a
 * comment), and numeric glyph tables or encodings of letters pass; the prompt's rules cover those.
 */
import { PEN_METHODS } from "./sandbox.ts";

const KEYWORDS =
  "for let const var if else return while do break continue function new this true false null undefined typeof instanceof in of switch case default try catch finally throw class async await yield void delete with import export extends super static get set";
const API =
  "pen lib console log info warn error Math floor ceil round abs sin cos tan atan atan2 sqrt cbrt pow min max hypot sign trunc exp PI random Array from fill length push pop shift unshift map forEach reduce filter slice splice concat join flat flatMap includes indexOf lastIndexOf reverse sort some every find findIndex findLast keys values entries isArray Object assign freeze Number String Boolean JSON stringify parse isFinite isNaN isInteger Infinity NaN globalThis arguments Set Map add has size Symbol iterator Promise then apply call bind toFixed at points smooth tool";
const ALLOW = new Set([...KEYWORDS.split(" "), ...API.split(" "), ...PEN_METHODS]);
/** Ways to build text out of numbers. */
const DENY = new Set(["fromCharCode", "fromCodePoint", "eval", "Function", "atob", "btoa", "escape", "unescape", "encodeURI", "encodeURIComponent", "decodeURI", "decodeURIComponent"]);
const COORDS = new Set(["x", "y", "z"]);
const ALLOWED_STRINGS = new Set(["pen", "eraser"]);

/** The words of the task a program must not spell: lowercase letter runs of three or more letters. */
export function taskWords(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => w.length >= 3));
}

/** True when free text contains a word of the task. */
export function hasTaskWords(text: string, words: Set<string>): boolean {
  return (text.toLowerCase().match(/[a-z]+/g) ?? []).some((w) => w.length >= 3 && words.has(w));
}

/** null when the program is clean; otherwise what it contains (never the offending text itself). */
export function checkProgram(code: string, words: Set<string>): string | null {
  const n = code.length;
  let line = 1;
  let i = 0;
  const isIdentStart = (c: string) => /[A-Za-z_$]/.test(c);
  const isIdent = (c: string) => /[A-Za-z0-9_$]/.test(c);
  const nonSpaceBefore = (k: number) => {
    while (k > 0 && /\s/.test(code[k - 1])) k--;
    return k > 0 ? code[k - 1] : "";
  };
  const nonSpaceAt = (k: number) => {
    while (k < n && /\s/.test(code[k])) k++;
    return k < n ? code[k] : "";
  };

  while (i < n) {
    const ch = code[i];
    if (ch === "\n") {
      line++;
      i++;
      continue;
    }
    if (ch === "/" && (code[i + 1] === "/" || code[i + 1] === "*")) return `a comment at line ${line}`;
    if (ch === "`") return `a template literal at line ${line}`;
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let text = "";
      while (j < n && code[j] !== ch) {
        if (code[j] === "\n") return `an unterminated string at line ${line}`;
        if (code[j] === "\\") j++;
        text += code[j] ?? "";
        j++;
      }
      if (j >= n) return `an unterminated string at line ${line}`;
      if (!ALLOWED_STRINGS.has(text)) return `a string literal at line ${line} (only "pen" and "eraser" are allowed)`;
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < n && (isIdent(code[j]) || (code[j] === "." && /[0-9]/.test(code[j + 1] ?? "")))) j++;
      i = j;
      continue;
    }
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < n && isIdent(code[j])) j++;
      const ident = code.slice(i, j);
      if (DENY.has(ident)) return `a text-building function at line ${line}`;
      if (ident.length === 1 && !COORDS.has(ident.toLowerCase()) && (nonSpaceBefore(i) === "." || nonSpaceAt(j) === ":")) {
        return `a letter name at line ${line}`;
      }
      if (!ALLOW.has(ident)) {
        for (const w of subWords(ident)) {
          if (w.length >= 3 && words.has(w) && !ALLOW.has(w)) return `a name at line ${line} that spells a word of the task`;
        }
      }
      i = j;
      continue;
    }
    i++;
  }
  return null;
}

/** The whole identifier plus its parts: split on _ $ digits and lower-to-upper boundaries, lowercased. */
function subWords(ident: string): string[] {
  const parts = ident
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  return [ident.toLowerCase(), ...parts];
}
