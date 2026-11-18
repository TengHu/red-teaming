#!/usr/bin/env node
/**
 * Self-contained Scribe-compatible Hershey stroke encoder (plain pad, no dials).
 * Matches encoding-load-bend-reasoning/envs/scribe-eni taskpad makeTaskPad with
 * zero hand/text/medium modules, plus the line-split taskRecording shape.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const PAD = { widthMm: 180, marginMm: 8, capMm: 5, lineMm: 10, minHeightMm: 60 };
const CAP_TOP = 1;
const BASELINE = 22;
const SPACE_UNITS = 12;
const BASELINE_FIX = { ".": 3, ",": 3, ":": 3, ";": 3 };
const REPLACEMENTS = { "‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-", "…": "..." };
const FRAME = "pad mm: origin at the top-left corner of the pad, +x right, +y down";
const TYPED_NOTE = 'a line with "text" in place of strokes was typed on the pad, not handwritten';

const require = createRequire(import.meta.url);
const fontFile = require.resolve("hersheytext/hersheytext.json");
const fonts = JSON.parse(readFileSync(fontFile, "utf8"));
const glyphs = fonts.futural.chars;

function round(v, digits = 1) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function normalizeText(text) {
  return [...text.replace(/\r/g, "").normalize("NFC")]
    .map((ch) => REPLACEMENTS[ch] ?? (ch === "\n" ? ch : ch === "\t" ? " " : ch >= " " && ch !== "\x7f" ? ch : "?"))
    .join("");
}

function hersheyStrokes(d, dy) {
  return d
    .split("M")
    .filter((s) => s.trim())
    .map((seg) =>
      (seg.match(/-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?/g) ?? []).map((p) => {
        const [x, y] = p.split(",").map(Number);
        return [x, y + dy];
      }),
    );
}

function glyph(ch) {
  if (ch === " ") return { strokes: [], advance: SPACE_UNITS };
  const dy = BASELINE_FIX[ch] ?? 0;
  if (ch.length === 1 && ch >= "!" && ch <= "~") {
    const g = glyphs[ch.charCodeAt(0) - 33];
    if (g) return { strokes: hersheyStrokes(g.d, dy), advance: 2 * g.o };
  }
  const q = glyphs["?".charCodeAt(0) - 33];
  return { strokes: hersheyStrokes(q.d, 0), advance: 2 * q.o };
}

const widthOf = (text) => [...text].reduce((w, ch) => w + glyph(ch).advance, 0);
const USABLE_UNITS = (PAD.widthMm - 2 * PAD.marginMm) / (PAD.capMm / (BASELINE - CAP_TOP));

function parseParagraphs(text) {
  return normalizeText(text).split("\n").map((para) =>
    para
      .split(" ")
      .filter(Boolean)
      .map((word) => ({ text: word })),
  );
}

function wrapUnits(paragraphs, usable) {
  const lines = [];
  for (const para of paragraphs) {
    let line = [];
    for (const u of para) {
      const candidate = [...line, u];
      if (widthOf(candidate.map((x) => x.text).join(" ")) <= usable || !line.length) line = candidate;
      else {
        lines.push(line);
        line = [u];
      }
    }
    lines.push(line);
  }
  return lines;
}

function lineStrokes(units, lineIndex) {
  const baseline = PAD.marginMm + PAD.capMm + lineIndex * PAD.lineMm;
  const s = PAD.capMm / (BASELINE - CAP_TOP);
  const strokes = [];
  let x = PAD.marginMm;
  units.forEach((u, k) => {
    if (k) x += SPACE_UNITS * s;
    for (const ch of u.text) {
      const g = glyph(ch);
      for (const st of g.strokes) {
        strokes.push(st.map(([gx, gy]) => [round(x + gx * s, 1), round(baseline + (gy - BASELINE) * s, 1)]));
      }
      x += g.advance * s;
    }
  });
  return { baselineMm: baseline, strokes };
}

function encodeStrokes(text) {
  const wrapped = wrapUnits(parseParagraphs(text), USABLE_UNITS);
  const lines = [];
  for (let i = 0; i < wrapped.length; i++) {
    if (!wrapped[i].length) continue;
    const { baselineMm, strokes } = lineStrokes(wrapped[i], i);
    lines.push({
      line: lines.length + 1,
      pad_baseline_y_mm: baselineMm,
      stroke_count: strokes.length,
      strokes,
    });
  }
  const heightMm = Math.max(PAD.minHeightMm, 2 * PAD.marginMm + PAD.capMm + (wrapped.length - 1) * PAD.lineMm + 4);
  return {
    frame: FRAME,
    size_mm: [PAD.widthMm, heightMm],
    line_count: lines.length,
    lines,
  };
}

function encodeRequest(taskText, typedLines = []) {
  const recording = encodeStrokes(taskText);
  const typed = typedLines.map((t) => t.trimEnd()).filter(Boolean);
  if (typed.length) {
    recording.typed_lines = TYPED_NOTE;
    for (const text of typed) {
      recording.lines.push({ line: recording.lines.length + 1, text });
    }
    recording.line_count = recording.lines.length;
  }
  return recording;
}

const task = readFileSync(0, "utf8");
const typedArg = process.argv[2] ?? "";
const typedLines = typedArg ? typedArg.split("\n") : [];
process.stdout.write(JSON.stringify(encodeRequest(task, typedLines)));
