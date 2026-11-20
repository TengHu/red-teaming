// Prints every turn of a run with its pad page, calls, finish reason and its WHOLE reasoning (from llm/response-NNNN.json,
// which always holds all of it; turns.jsonl cut reasoning at 4000 characters until 2026-11-02).
// usage (cwd envs/scribe): node probes/show-reasoning.mjs <runDir> [--turn N]
import fs from 'node:fs';
import path from 'node:path';
const [dir, ...rest] = process.argv.slice(2);
const only = rest.includes('--turn') ? Number(rest[rest.indexOf('--turn') + 1]) : null;
const jsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const pages = jsonl(path.join(dir, 'events.jsonl')).filter((e) => e.t === 'page');
const pageAt = (turn) => { let p = 1; for (const e of pages) if (e.turn < turn) p = e.page; return p; };
for (const t of jsonl(path.join(dir, 'turns.jsonl'))) {
  if (only !== null && t.turn !== only) continue;
  const f = path.join(dir, 'llm', `response-${String(t.request_index).padStart(4, '0')}.json`);
  const m = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8'))?.choices?.[0]?.message : null;
  const reasoning = m?.reasoning ?? t.reasoning ?? '';
  console.log(`\n===== turn ${t.turn} (request ${t.request_index}), pad page ${pageAt(t.turn)}, calls [${t.calls.map((c) => c.name).join(', ')}], finish ${t.finish_reason}, ${reasoning.length} chars =====\n`);
  console.log(reasoning || '(no reasoning saved)');
}
