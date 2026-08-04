/**
 * ClaimStore — Synthadoc-style claim provenance, in state.db.
 * Round-trips losslessly (the scaffold serialized the chain to prose then
 * regex-parsed it back). Provenance + chain stored as JSON.
 */
import { genId, nowISO, json, tokenize } from './util.mjs';

const STATUSES = new Set(['active', 'verified', 'contradicted', 'superseded', 'archived']);

export class ClaimStore {
  constructor(db) { this.db = db; }

  add({ content, type = 'fact', source = {}, provenance = {}, metadata = {} }) {
    const id = genId('claim', content.slice(0, 50) + (source.path || ''));
    const ts = nowISO();
    const prov = {
      extractedAt: provenance.extractedAt || ts,
      extractor: provenance.extractor || 'unknown',
      confidence: provenance.confidence ?? 0.5,
      chain: provenance.chain || [{ step: 'ingest', source: source.path || 'unknown', timestamp: ts }],
    };
    // MOSAIC-style write-path relation (arXiv 2607.16211): compare the incoming claim against
    // live neighbors BEFORE it lands, so conflicts are visible at write time instead of being
    // discovered by a later audit or a contradictory query answer. Tag only — never mutate the
    // neighbor: contradictions and supersede candidates are judgment calls, and the flag is
    // what queues them for one. The relation rides in metadata.writeRelation.
    const relation = this.relate(content);
    const meta = relation.relation === 'novel' ? metadata : { ...metadata, writeRelation: relation };
    this.db.prepare(`
      INSERT INTO claims(id,content,type,source,provenance,status,metadata,created_at,updated_at)
      VALUES(?,?,?,?,?, 'active', ?,?,?)
    `).run(id, content, type, JSON.stringify(source), JSON.stringify(prov), JSON.stringify(meta), ts, ts);
    if (relation.relation === 'contradictory') this.db.logOp?.('claim-write-conflict', { id, neighbor: relation.neighborId, shared: relation.shared });
    return this.get(id);
  }

  /**
   * Deterministic write-path relation of a candidate claim to its live neighbors.
   * Neighbor = live claim sharing ≥ minShared significant tokens (the same locality rule
   * findContradictions uses). Verdicts, checked in order:
   *  - contradictory: exactly one side negated (same rule as the audit-time finder)
   *  - corroborating: near-identical token sets (high Jaccard) with same polarity
   *  - superseding-candidate: strong overlap, same polarity, but materially different content
   *  - additive: shares locality but low similarity — likely a new fact about known things
   *  - novel: no neighbor at all
   * Returns { relation, neighborId?, shared?, similarity? } for the strongest neighbor.
   */
  relate(content, { minShared = 3, scanLimit = 500 } = {}) {
    const NEGW = new Set(['not', 'no', 'never', 'none', 'cannot', 'cant', 'isnt', 'arent', 'wont', 'dont', 'false', 'incorrect', 'deprecated', 'removed', 'without', 'disabled', 'fails', 'failed']);
    const cand = new Set(tokenize(content));
    const candNeg = [...cand].some((t) => NEGW.has(t));
    const candSig = new Set([...cand].filter((t) => !NEGW.has(t)));
    let best = null;
    // Bounded, deterministic neighbor scan: the most recent `scanLimit` live claims (stable
    // created_at DESC, id DESC order — same-millisecond bulk inserts must not flip the winner).
    // Unbounded getAll() made every claims.add O(N) and bulk ingest O(N^2) (~11ms/1k claims).
    const neighbors = this.db.prepare(
      "SELECT * FROM claims WHERE status IN ('active','verified') ORDER BY created_at DESC, id DESC LIMIT ?",
    ).all(scanLimit).map((r) => this.#h(r));
    for (const c of neighbors) {
      const nb = new Set(tokenize(c.content));
      const nbSig = new Set([...nb].filter((t) => !NEGW.has(t)));
      let shared = 0; for (const t of candSig) if (nbSig.has(t)) shared++;
      if (shared < minShared) continue;
      const union = new Set([...candSig, ...nbSig]).size;
      const sim = union ? shared / union : 0;
      if (!best || shared > best.shared) {
        const nbNeg = [...nb].some((t) => NEGW.has(t));
        let relation;
        if (candNeg !== nbNeg) relation = 'contradictory';
        else if (sim >= 0.8) relation = 'corroborating';
        else if (sim >= 0.4) relation = 'superseding-candidate';
        else relation = 'additive';
        best = { relation, neighborId: c.id, shared, similarity: Number(sim.toFixed(3)) };
      }
    }
    return best || { relation: 'novel' };
  }

  get(id) { const r = this.db.prepare('SELECT * FROM claims WHERE id=?').get(id); return r ? this.#h(r) : null; }
  getAll() { return this.db.prepare('SELECT * FROM claims ORDER BY created_at DESC').all().map((r) => this.#h(r)); }

  updateStatus(id, status) {
    if (!STATUSES.has(status)) throw new Error(`bad status: ${status}`);
    this.db.prepare('UPDATE claims SET status=?, updated_at=? WHERE id=?').run(status, nowISO(), id);
  }

  search(query, { types = [], statuses = [], limit = 50 } = {}) {
    const qt = tokenize(query);
    return this.getAll()
      .filter((c) => (!types.length || types.includes(c.type)) && (!statuses.length || statuses.includes(c.status)))
      .map((c) => ({ c, score: this.#score(c, qt) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.c);
  }

  stats() {
    const all = this.getAll();
    const byType = {}, byStatus = {};
    for (const c of all) { byType[c.type] = (byType[c.type] || 0) + 1; byStatus[c.status] = (byStatus[c.status] || 0) + 1; }
    return { total: all.length, byType, byStatus };
  }

  /** P6: supersede an old claim with a new one (knowledge-point update). The old claim is marked
   *  `superseded` and cross-linked; the new claim records what it `supersedes`. Atomic. */
  supersede(oldId, next = {}) {
    const old = this.get(oldId);
    if (!old) return { success: false, message: `not found: ${oldId}` };
    return this.db.tx(() => {
      // Mark the old claim superseded FIRST so the write-path relate() inside add() no longer
      // sees it as a live neighbor — otherwise every legitimate negation-style supersede tagged
      // its own replacement 'contradictory' against the claim it was correcting.
      this.db.prepare('UPDATE claims SET status=?, updated_at=? WHERE id=?').run('superseded', nowISO(), oldId);
      const created = this.add({ content: next.content, type: next.type || old.type, source: next.source || old.source, provenance: next.provenance || {}, metadata: { ...(next.metadata || {}), supersedes: oldId } });
      this.db.prepare('UPDATE claims SET metadata=?, updated_at=? WHERE id=?')
        .run(JSON.stringify({ ...old.metadata, superseded_by: created.id }), nowISO(), oldId);
      return { success: true, superseded: oldId, current: created.id };
    });
  }

  /** P6: deterministic contradiction finder (no LLM). Two live claims contradict when they share
   *  ≥ minShared significant tokens but exactly ONE carries a negation marker. Heuristic but stable —
   *  flags candidates for review; does not auto-mutate status. */
  findContradictions({ minShared = 3 } = {}) {
    const NEG = new Set(['not', 'no', 'never', 'none', 'cannot', 'cant', 'isnt', 'arent', 'wont', 'dont', 'false', 'incorrect', 'deprecated', 'removed', 'without', 'disabled', 'fails', 'failed']);
    const live = this.getAll().filter((c) => c.status === 'active' || c.status === 'verified')
      .map((c) => ({ c, set: new Set(tokenize(c.content)) }));
    const pairs = [];
    for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
      const a = live[i], b = live[j];
      if ([...a.set].some((t) => NEG.has(t)) === [...b.set].some((t) => NEG.has(t))) continue; // need exactly one negated
      let shared = 0; for (const t of a.set) if (!NEG.has(t) && b.set.has(t)) shared++;
      if (shared >= minShared) pairs.push({ a: a.c.id, b: b.c.id, shared, contentA: a.c.content, contentB: b.c.content });
    }
    return pairs;
  }

  /** P6: the current (freshest, non-superseded/contradicted/archived) claim(s) matching a query —
   *  "retrieve the right current claim after updates". */
  current(query, opts = {}) {
    return this.search(query, { ...opts, statuses: [] })
      .filter((c) => c.status === 'active' || c.status === 'verified')
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  }

  #score(c, qt) {
    const hay = (c.content + ' ' + (c.source?.path || '')).toLowerCase();
    let s = 0;
    for (const t of qt) if (hay.includes(t)) s++;
    return s;
  }

  #h(r) { return { ...r, source: json(r.source, {}), provenance: json(r.provenance, {}), metadata: json(r.metadata, {}) }; }
}
