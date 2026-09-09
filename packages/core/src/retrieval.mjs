/**
 * Hybrid retrieval — the core RAG path.
 *
 * Lanes: SQLite FTS5 (token lexical) ⊕ FTS5-trigram (substring lexical) ⊕ vector cosine
 * (semantic), fused by Reciprocal Rank Fusion. Then: trust boost (usage feedback), graph
 * ref-chain boost (entries sharing concepts with the top hits), and either top-k or a
 * token budget. Returns ranked, provenance-bearing results.
 *
 * (Ideas adapted from memory-os: trust scoring, two-pass ref-chain boost, token budget.)
 */
import { ftsMatchExpr, tokenize } from './util.mjs';
import { functionForType } from './workmemory.mjs';
import { conceptSeedsFromVector } from './concepts.mjs';
import { authorityRank, AUTHORITY_LEVELS } from './authority.mjs';
import { projectClause, matchesProject } from './projectaxis.mjs';

/** One FTS lane (token or trigram), scope/tier/project filtered. Returns ranked entry ids.
 *  Expired leases are filtered here too — decay holds even between maintenance sweeps. */
function ftsLane(db, table, expr, tiers, scoped, projects, limit = 200) {
  if (!expr) return [];
  const conds = ["e.status='active'", '(e.expires_at IS NULL OR e.expires_at > ?)', `e.tier IN (${tiers.map(() => '?').join(',')})`];
  const params = [expr, new Date().toISOString(), ...tiers];
  if (scoped) { conds.push(`e.scope IN (${scoped.map(() => '?').join(',')})`); params.push(...scoped); }
  const pc = projectClause('e.project', projects);
  if (pc) { conds.push(pc.sql); params.push(...pc.params); }
  return db.prepare(`
    SELECT e.id id FROM ${table} JOIN entries e ON e.rowid = ${table}.rowid
    WHERE ${table} MATCH ? AND ${conds.join(' AND ')}
    ORDER BY bm25(${table}) LIMIT ${limit}
  `).all(...params).map((r) => r.id);
}

/** Filter vector-store candidate ids against live entries (state.db is the metadata authority). */
function filterActiveIds(db, ids, tiers, scoped, projects) {
  if (!ids.length) return new Set();
  const conds = [`id IN (${ids.map(() => '?').join(',')})`, "status='active'", '(expires_at IS NULL OR expires_at > ?)', `tier IN (${tiers.map(() => '?').join(',')})`];
  const params = [...ids, new Date().toISOString(), ...tiers];
  if (scoped) { conds.push(`scope IN (${scoped.map(() => '?').join(',')})`); params.push(...scoped); }
  const pc = projectClause('project', projects);
  if (pc) { conds.push(pc.sql); params.push(...pc.params); }
  return new Set(db.prepare(`SELECT id FROM entries WHERE ${conds.join(' AND ')}`).all(...params).map((r) => r.id));
}

/**
 * @param {import('./db.mjs').StateDB} db
 * @param {import('./memory.mjs').TieredMemory} memory
 * @param {import('./embeddings.mjs').Embedder} embedder
 */
export async function hybridSearch(db, memory, embedder, query, opts = {}) {
  const { scopes = null, limit = 20, maxTokens = null, includeProvenance = true } = opts;
  const tiers = (opts.tiers && opts.tiers.length) ? opts.tiers : memory.tierNames;
  const cfg = memory.cfg;
  const k = cfg.rrfK;
  const w = cfg.fusionWeights;
  const scoped = scopes && scopes.length ? scopes : null;
  // Project axis (roadmap #18): a list means project + global; null means no partition filter.
  const projects = Array.isArray(opts.projects) && opts.projects.length ? opts.projects : null;
  const expr = ftsMatchExpr(query);

  // --- Lanes ---
  // lexicalOnly (roadmap #11): the cheap first pass of progressive retrieval skips the embed
  // call, the vector lane and concept routing entirely — FTS lanes + the deterministic boosts
  // are all it pays for. Everything downstream (filters, boosts, budget) behaves identically.
  const lexicalOnly = opts.lexicalOnly === true;
  const lanes = {
    fts: ftsLane(db, 'entries_fts', expr, tiers, scoped, projects),
    trigram: ftsLane(db, 'entries_fts_trigram', expr, tiers, scoped, projects),
    vector: [],
  };
  let qv = null;
  if (!lexicalOnly) {
    ({ vector: qv } = await embedder.embed(query));
    const vraw = await memory.vectorStore.search(qv, 400); // backend-ranked candidates (id+score)
    const vAllowed = filterActiveIds(db, vraw.map((r) => r.id), tiers, scoped, projects);
    lanes.vector = vraw.filter((r) => vAllowed.has(r.id)).slice(0, 200).map((r) => r.id);
  }

  // --- Reciprocal Rank Fusion ---
  const fused = new Map();
  const bump = (id, rank, lane) => {
    const e = fused.get(id) || { score: 0, ranks: {} };
    e.score += (w[lane] ?? 1) * (1 / (k + rank));
    e.ranks[lane] = rank + 1;
    fused.set(id, e);
  };
  for (const lane of ['fts', 'trigram', 'vector']) lanes[lane].forEach((id, i) => bump(id, i, lane));

  // --- P5 concept routing (fail-soft): seed entries linked to the query's nearest concept
  //     communities into the candidate pool, so global/relational hits surface even without a direct
  //     lexical/vector match. Reuses the query vector qv (no extra embed, no per-query LLM). ---
  let conceptSeeds = new Set();
  if (cfg.conceptRouting?.enabled !== false && !lexicalOnly) {
    try { conceptSeeds = conceptSeedsFromVector(db, qv, cfg); } catch { conceptSeeds = new Set(); }
    for (const id of conceptSeeds) if (!fused.has(id)) fused.set(id, { score: 0, ranks: { concept: true } });
  }

  // Hydrate candidates once.
  let cand = [...fused.entries()].map(([id, m]) => ({ id, score: m.score, ranks: m.ranks, entry: memory.get(id) })).filter((c) => c.entry);
  // Concept-routing seeds enter after the lane filters — re-apply the project rule (and the
  // scope/tier filters the lanes already enforced) so a seed can never leak across a partition.
  if (conceptSeeds.size) {
    const tierSet = new Set(tiers);
    cand = cand.filter((c) => !conceptSeeds.has(c.id) || c.ranks.fts || c.ranks.trigram || c.ranks.vector
      || (matchesProject(c.entry, projects) && tierSet.has(c.entry.tier) && (!scoped || scoped.includes(c.entry.scope)) && c.entry.status === 'active'));
  }

  // --- Function-axis filter (survey 2607.25380): restrict to the requested memory ROLE(s).
  //     Legacy rows (null mem_function) resolve through the same deterministic type map, so
  //     pre-migration data filters identically to new writes. ---
  if (opts.functions && opts.functions.length) {
    const want = new Set(opts.functions);
    cand = cand.filter((c) => want.has(c.entry.mem_function || functionForType(c.entry.type)));
  }

  // --- Source-authority filter + boost (roadmap #10): an action-risky caller passes
  //     minAuthority to exclude low-trust origins outright; otherwise authority nudges rank
  //     around the 'doc' baseline (small, additive, same magnitude family as trust/graph).
  //     Legacy entries without a label rank as 'doc'. ---
  if (opts.minAuthority && AUTHORITY_LEVELS[opts.minAuthority]) {
    const floor = AUTHORITY_LEVELS[opts.minAuthority];
    cand = cand.filter((c) => authorityRank(c.entry.provenance?.authority) >= floor);
  }
  if (cfg.authority?.enabled !== false) {
    const aw = cfg.authority?.boost ?? 0.002;
    for (const c of cand) {
      const rank = authorityRank(c.entry.provenance?.authority);
      if (rank !== AUTHORITY_LEVELS.doc) { c.score += aw * (rank - AUTHORITY_LEVELS.doc); c.ranks.authority = c.entry.provenance?.authority; }
    }
  }

  // --- Trust boost (usage feedback) ---
  for (const c of cand) c.score += cfg.trustWeight * ((c.entry.trust_score ?? 0.5) - 0.5);

  // --- Graph ref-chain boost: concepts of the current top hits lift entries that share them. ---
  const prelim = [...cand].sort((a, b) => b.score - a.score);
  const topConcepts = new Set();
  for (const c of prelim.slice(0, 5)) for (const k2 of (c.entry.concepts || [])) topConcepts.add(String(k2.name || '').toLowerCase());
  topConcepts.delete('');
  if (topConcepts.size) {
    for (const c of cand) {
      const shared = (c.entry.concepts || []).filter((k2) => topConcepts.has(String(k2.name || '').toLowerCase())).length;
      if (shared) { c.score += cfg.graphBoost * Math.min(shared, 3); c.ranks.graph = shared; }
    }
  }

  // --- P4 temporal/workflow boosts: recency + proven usefulness + work-event semantics.
  //     Small additive nudges (same magnitude as trust/graph). Dead-ends are demoted + flagged so
  //     they surface as warnings, not primary evidence. Deterministic from each entry's own fields. ---
  const wf = cfg.workflowBoost || {};
  if (wf.enabled !== false) {
    const now = Date.now();
    const halfLifeMs = (wf.recencyHalfLifeDays ?? 30) * 864e5;
    for (const c of cand) {
      const e = c.entry;
      const ts = Date.parse(e.last_accessed_at || e.updated_at || e.created_at || '') || 0;
      if (ts) { const rec = Math.max(0, 1 - (now - ts) / halfLifeMs); if (rec > 0) { c.score += (wf.recency ?? 0.004) * rec; c.ranks.recency = Number(rec.toFixed(2)); } }
      const rc = Math.min(e.retrieval_count ?? 0, 5);
      if (rc) c.score += (wf.usefulness ?? 0.002) * rc;
      if (e.type === 'correction') c.score += (wf.correction ?? 0.01);
      else if (e.type === 'decision') c.score += (wf.decision ?? 0.006);
      else if (e.type === 'dead_end') { c.score -= (wf.deadEndPenalty ?? 0.008); c.ranks.deadEndWarning = true; }
    }
  }

  // --- P5 concept boost: lift entries surfaced by concept routing (small, like graph boost). ---
  if (conceptSeeds.size) {
    const cb = cfg.conceptRouting?.boost ?? 0.005;
    for (const c of cand) if (conceptSeeds.has(c.id)) { c.score += cb; c.ranks.concept = true; }
  }

  cand.sort((a, b) => b.score - a.score);

  const preview = (e) => e.content.slice(0, 600) + (e.content.length > 600 ? '…' : '');

  // --- Token budget (surgical injection) or top-k ---
  let selected;
  if (maxTokens) {
    selected = [];
    let budget = maxTokens;
    for (const c of cand) {
      const cost = Math.ceil(preview(c.entry).length / 4);
      if (cost > budget) continue; // skip oversized, keep filling from the rest
      budget -= cost;
      selected.push(c);
      if (limit && selected.length >= limit) break;
    }
  } else {
    selected = cand.slice(0, limit);
  }

  return selected.map((c) => ({
    id: c.id,
    tier: c.entry.tier,
    type: c.entry.type,
    project: c.entry.project ?? null,
    content: preview(c.entry),
    score: Number(c.score.toFixed(6)),
    trust: c.entry.trust_score,
    authority: c.entry.provenance?.authority ?? null,
    rank: c.ranks,
    provenance: includeProvenance ? c.entry.provenance ?? null : undefined,
  }));
}

/** Deterministic evidence-sufficiency check (roadmap #11): the top hits must cover enough of the
 *  query's significant tokens. Coverage is measured over the best single result (a scattered
 *  half-match across many results is NOT sufficiency). */
export function evidenceSufficient(query, results, { minHits = 1, minCoverage = 0.6 } = {}) {
  const toks = [...new Set(tokenize(query))];
  if (!toks.length) return { sufficient: false, coverage: 0, hits: results.length, reason: 'no-significant-tokens' };
  if (results.length < minHits) return { sufficient: false, coverage: 0, hits: results.length, reason: 'too-few-hits' };
  let best = 0;
  for (const r of results.slice(0, 3)) {
    const hay = String(r.content || '').toLowerCase();
    const covered = toks.filter((t) => hay.includes(t)).length / toks.length;
    if (covered > best) best = covered;
  }
  const coverage = Number(best.toFixed(3));
  return { sufficient: coverage >= minCoverage, coverage, hits: results.length };
}

/**
 * Router-Mem progressive retrieval (roadmap #11, arXiv 2608.01285): a cheap lexical-only pass
 * first; expand to the full hybrid pipeline (embed + vector + concept routing) ONLY when the
 * deterministic sufficiency gate says the lexical evidence is not enough. opts.deep forces the
 * full pipeline. Every result set carries a `sufficiency` descriptor so callers can see which
 * stage answered and why.
 */
export async function progressiveSearch(db, memory, embedder, query, opts = {}) {
  const pc = memory.cfg.progressive || {};
  if (pc.enabled === false || opts.deep) {
    const results = await hybridSearch(db, memory, embedder, query, opts);
    return { results, sufficiency: { stage: 'full', gated: false, reason: opts.deep ? 'deep-requested' : 'progressive-disabled' } };
  }
  const lexical = await hybridSearch(db, memory, embedder, query, { ...opts, lexicalOnly: true });
  const verdict = evidenceSufficient(query, lexical, { minHits: pc.minHits ?? 1, minCoverage: pc.minCoverage ?? 0.6 });
  if (verdict.sufficient) return { results: lexical, sufficiency: { stage: 'lexical', gated: true, ...verdict } };
  const results = await hybridSearch(db, memory, embedder, query, opts);
  return { results, sufficiency: { stage: 'full', gated: true, expandedBecause: verdict } };
}
