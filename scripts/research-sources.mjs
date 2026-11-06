#!/usr/bin/env node
/**
 * research-sources — deterministic list of research ingestions the RESEARCH.md ledger has not
 * evaluated yet (the `midmem-research-tracker` skill's intake step).
 *
 * Reads the marker `<!-- research-tracker: evaluated-through=<ISO> -->` from RESEARCH.md and
 * lists every research-shaped source in state.db ingested after it: type `research`, or a path
 * that names a weekly memory report / digest / arXiv id. Each row carries the live entry id and
 * the write-time grounding numbers so the skill can triage drift BEFORE reading a summary
 * (DELEGATE-52: verify against the source's own record, not a model's recollection of it).
 *
 *   node scripts/research-sources.mjs            # table
 *   node scripts/research-sources.mjs --json     # machine-readable
 *   node scripts/research-sources.mjs --all      # ignore the marker (full history)
 *   node scripts/research-sources.mjs --include-gone   # also sources whose entry was superseded/forgotten
 *   node scripts/research-sources.mjs --include-sections   # also list each digest section on its own
 *   node scripts/research-sources.mjs --mark <ISO>   # advance the marker in RESEARCH.md
 *
 * Digest sections (`ingest --sections`, sources metadata `source.captureMethod: 'digest-section'`)
 * are parts of a digest, not sources to evaluate on their own: each is counted on its parent's line
 * (` · N sections`, JSON `sections: N`), matched by `metadata.digest.path` — a section a later digest
 * superseded counts for that later digest. `--include-sections` lists them too (JSON rows with `section`).
 */
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER = path.join(ROOT, 'RESEARCH.md');
const DB = process.env.MIDMEM_DB_PATH || process.env.OCMW_DB_PATH || path.join(ROOT, 'state.db');
const MARK_RE = /<!-- research-tracker: evaluated-through=([^\s]+) -->/;
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);

function readMarker() {
  try { return fs.readFileSync(LEDGER, 'utf8').match(MARK_RE)?.[1] || null; } catch { return null; }
}

if (flag('--mark')) {
  const iso = args[args.indexOf('--mark') + 1];
  if (!iso || Number.isNaN(Date.parse(iso))) { console.error('usage: --mark <ISO timestamp>'); process.exit(2); }
  let md = fs.readFileSync(LEDGER, 'utf8');
  md = MARK_RE.test(md) ? md.replace(MARK_RE, `<!-- research-tracker: evaluated-through=${iso} -->`) : `<!-- research-tracker: evaluated-through=${iso} -->\n${md}`;
  fs.writeFileSync(LEDGER, md);
  console.log(`marker → ${iso}`);
  process.exit(0);
}

const since = flag('--all') ? null : readMarker();
const db = new DatabaseSync(DB, { readOnly: true });
const rows = db.prepare(`
  SELECT s.id, s.path, s.type, s.title, s.ingested_at, s.metadata,
         e.id entry_id, e.scope, e.project, e.provenance
  FROM sources s LEFT JOIN entries e ON e.source_id = s.id AND e.status = 'active'
  WHERE (s.type = 'research'
     OR s.path LIKE '%llm-memory-re%' OR s.path LIKE '%llmwiki-weekly%' OR s.path LIKE '%weekly-memory-research%'
     OR s.path LIKE '%arxiv-%' OR s.path LIKE '%research-digest%'
     OR (json_valid(s.metadata) AND json_extract(s.metadata, '$.source.captureMethod') = 'digest-section'))
    AND (? IS NULL OR s.ingested_at > ?)
  ORDER BY s.ingested_at ASC
`).all(since, since);

// Live entries only by default (a superseded/forgotten source is history, not intake); one row
// per path (the latest ingest wins — re-ingests supersede earlier ones; a section's path is keyed
// by its citation, so the latest digest that carried the paper wins).
const latest = new Map();
for (const r of rows) latest.set(r.path, r);
const shape = (r) => {
  let g = null; try { g = JSON.parse(r.provenance || '{}').grounding || null; } catch {}
  return {
    ingested_at: r.ingested_at, type: r.type, path: r.path, title: r.title, source_id: r.id,
    entry_id: r.entry_id || null, live: !!r.entry_id, scope: r.scope || null, project: r.project || null,
    grounding: g ? { summaryScore: g.summaryScore, conceptsKept: g.conceptsKept, conceptsQuarantined: g.conceptsQuarantined, claimsKept: g.claimsKept, claimsQuarantined: g.claimsQuarantined } : null,
  };
};
const meta = (r) => { try { return JSON.parse(r.metadata || '{}') || {}; } catch { return {}; } };
const parents = [], sections = [];
for (const r of [...latest.values()].filter((x) => flag('--include-gone') || x.entry_id)) {
  const m = meta(r);
  (m.source?.captureMethod === 'digest-section' ? sections : parents).push({ r, m });
}
const sectionRow = ({ r, m }) => ({ ...shape(r), section: { parentPath: m.digest?.path ?? null, heading: m.digest?.heading ?? null, index: m.digest?.index ?? null, canonicalUri: m.source?.canonicalUri ?? null, docId: m.source?.docId ?? null } });
const byParent = new Map();
for (const s of sections) { const p = s.m.digest?.path; if (p) byParent.set(p, [...(byParent.get(p) || []), s]); }
const out = [];
for (const { r } of parents) {
  const kids = byParent.get(r.path) || [];
  out.push({ ...shape(r), sections: kids.length });
  if (flag('--include-sections')) for (const k of kids) out.push(sectionRow(k));
}
// Sections whose digest is not listed (evaluated before the marker, or gone) show only on request.
const listed = new Set(parents.map(({ r }) => r.path));
if (flag('--include-sections')) for (const s of sections) if (!listed.has(s.m.digest?.path)) out.push(sectionRow(s));

if (flag('--json')) { console.log(JSON.stringify({ db: DB, marker: since, count: out.length, sources: out }, null, 2)); process.exit(0); }
console.log(`marker: ${since || '(none — full history)'} · ${parents.length} unevaluated research source(s)${flag('--include-sections') ? ` + ${out.length - parents.length} section(s)` : ''} · db ${DB}`);
for (const r of out) {
  const g = r.grounding ? `ground ${r.grounding.summaryScore} · q${r.grounding.conceptsQuarantined + r.grounding.claimsQuarantined}` : 'no grounding record';
  if (r.section) { console.log(`${r.ingested_at.slice(0, 10)}    └ section ${r.live ? 'live' : 'gone'}  ${g.padEnd(22)} ${r.section.canonicalUri} (§${r.section.index} of ${r.section.parentPath})`); continue; }
  console.log(`${r.ingested_at.slice(0, 10)}  ${r.type.padEnd(8)} ${r.live ? 'live' : 'gone'}  ${g.padEnd(22)} ${r.path}${r.sections ? ` · ${r.sections} section${r.sections === 1 ? '' : 's'}` : ''}`);
}
