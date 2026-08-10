/**
 * Expected-query probes (roadmap #15, arXiv 2608.00962 "PMMC").
 *
 * PMMC's shift: move part of memory reasoning from query time to consolidation time —
 * predict likely future queries and verify their evidence paths BEFORE they're needed.
 * Here, deterministically: each recently-active entry compiles to a probe query (its
 * grounded concept names, else its leading significant tokens); the probe set persists
 * in meta (the precompiled evaluation memory) and each probe is verified by running the
 * cheap lexical retrieval path and requiring the compiling entry to surface in top-k.
 * A miss means a real future query shaped like this would NOT find its evidence —
 * report-only, surfaced beside the WiCER projection probes it extends.
 */
import { hybridSearch } from './retrieval.mjs';
import { tokenize } from './util.mjs';

/** Deterministic probe query for one entry: concept names first, else leading content tokens. */
export function probeQueryFor(entry) {
  const concepts = (entry.concepts || []).map((c) => String(c.name || '').trim()).filter(Boolean).slice(0, 3);
  if (concepts.length) return concepts.join(' ');
  return [...new Set(tokenize(entry.content))].slice(0, 6).join(' ');
}

/** Compile the probe set (consolidation-time), persist it in meta, then verify each probe
 *  over the lexical retrieval path. Report-only. */
export async function runExpectedQueryProbes(o, { sampleSize = 12, topK = 5 } = {}) {
  const entries = o.memory.listActive()
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
    .slice(0, sampleSize);
  const probes = entries.map((e) => ({ entryId: e.id, query: probeQueryFor(e) })).filter((p) => p.query);
  o.db.prepare("INSERT INTO meta(key,value) VALUES('expected_query_probes',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(JSON.stringify({ compiledAt: new Date().toISOString(), probes }));

  const misses = [];
  for (const p of probes) {
    const results = await hybridSearch(o.db, o.memory, o.embedder, p.query, { limit: topK, lexicalOnly: true, scopes: null });
    if (!results.some((r) => r.id === p.entryId)) misses.push(p);
  }
  return { pass: misses.length === 0, sampled: probes.length, hits: probes.length - misses.length, misses: misses.slice(0, 10) };
}
