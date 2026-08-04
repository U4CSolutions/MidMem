/**
 * Revision export — the knowledge product gets git history (roadmap 2026-08 #7;
 * Ground Truth First 2607.21962 + Git-memory 2607.14390). state.db stays canonical
 * and gitignored; this writes a DETERMINISTIC snapshot of the knowledge tables
 * (entries, claims, nodes, edges, sources — no vectors, no volatile log/audit) as
 * JSONL with stable row ordering and stable key order, so an unchanged store exports
 * byte-identical output and `git diff` on the snapshot shows exactly what knowledge
 * changed between commits. Committing the snapshot is the operator's/cron's choice —
 * the export itself never touches git.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const TABLES = {
  entries: 'SELECT * FROM entries ORDER BY id',
  claims: 'SELECT * FROM claims ORDER BY id',
  nodes: 'SELECT * FROM nodes ORDER BY id',
  edges: 'SELECT * FROM edges ORDER BY id',
  sources: 'SELECT * FROM sources ORDER BY id',
};

/** Usage/lease counters change on every read — they are telemetry, not knowledge, and would
 *  swamp the snapshot diff with counter bumps. rowid is physical storage detail. */
const VOLATILE = new Set(['trust_score', 'retrieval_count', 'helpful_count', 'last_accessed_at', 'expires_at', 'rowid']);

/** Recursive sorted-key stringify — replacer-array JSON.stringify would silently DROP nested
 *  keys absent from the top-level list; this sorts at every level instead. */
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

export function exportKnowledge(db, cfg = {}) {
  const file = cfg.export?.path;
  if (!file) throw new Error('export path not configured (cfg.export.path / MIDMEM_EXPORT_PATH)');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [];
  const counts = {};
  for (const [table, sql] of Object.entries(TABLES)) {
    const rows = db.prepare(sql).all();
    counts[table] = rows.length;
    for (const r of rows) {
      for (const k of VOLATILE) delete r[k];
      lines.push(stableStringify({ _table: table, ...r }));
    }
  }
  // Single trailing newline; no timestamps in the body — the git commit carries "when".
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return { file, rows: lines.length, counts };
}
