/**
 * ClaimStore — Synthadoc-style claim provenance, in state.db.
 * Round-trips losslessly (the scaffold serialized the chain to prose then
 * regex-parsed it back). Provenance + chain stored as JSON.
 */
import { randomUUID } from 'node:crypto';
import { genId, nowISO, json, tokenize } from './util.mjs';

const STATUSES = new Set(['active', 'verified', 'contradicted', 'superseded', 'archived', 'deferred']);

/** Negation markers: the polarity signal shared by the write-path relate(), the audit-time
 *  findContradictions() and reclassifyWriteConflicts() — one set, so the three stay one rule. */
const NEGATION_WORDS = new Set(['not', 'no', 'never', 'none', 'cannot', 'cant', 'isnt', 'arent', 'wont', 'dont', 'false', 'incorrect', 'deprecated', 'removed', 'without', 'disabled', 'fails', 'failed']);

/** Default containment floor for the `contradictory` verdict (MIDMEM_CLAIM_CONTRADICTION_MIN_CONTAINMENT).
 *  Measured 2026-10-05: every one of the 68 live-store claims tagged contradictory was a false
 *  positive — long prose fragments that shared ≥ 3 tokens and happened to carry one negation word,
 *  token containment ≤ 0.636 — while every intended contradiction fixture sits at ≥ 0.667. */
const CONTRADICTION_MIN_CONTAINMENT = 0.6;

/** Polarity split of a claim's tokens: whether it carries a negation marker, and its significant
 *  (non-negation) token set. Same tokenisation everywhere a pair's polarity is judged. */
function polarity(content) {
  const toks = new Set(tokenize(content || ''));
  return { neg: [...toks].some((t) => NEGATION_WORDS.has(t)), sig: new Set([...toks].filter((t) => !NEGATION_WORDS.has(t))) };
}

/** Token containment of a pair: shared significant tokens / the SMALLER side's significant token
 *  count. Unlike Jaccard it is not diluted when one side is a short claim inside a long paragraph,
 *  and it separates a claim-and-its-negation (≈ 1) from two prose fragments that merely touch the
 *  same locality (low). */
function containmentOf(aSig, bSig) {
  let shared = 0; for (const t of aSig) if (bSig.has(t)) shared++;
  const denom = Math.min(aSig.size, bSig.size);
  return { shared, containment: denom ? shared / denom : 0 };
}

export class ClaimStore {
  constructor(db, cfg = {}) { this.db = db; this.cfg = cfg; }

  /** The configured containment floor for `contradictory` (claims.contradictionMinContainment);
   *  a missing or non-numeric value falls back to the default rather than disabling the floor. */
  #containmentFloor() {
    const f = this.cfg?.claims?.contradictionMinContainment;
    return typeof f === 'number' && Number.isFinite(f) ? f : CONTRADICTION_MIN_CONTAINMENT;
  }

  add({ content, type = 'fact', source = {}, provenance = {}, metadata = {}, defer = false }) {
    // The id's hash part must not repeat within one millisecond: two claims that share their first
    // 50 characters (common in news text: "The company said that ...") used to get the SAME id when
    // written in one clock tick, and the INSERT then failed the ingest with
    // 'UNIQUE constraint failed: claims.id'. The full content plus a random nonce keeps the id's
    // format (claim-<base36 ms>-<12 hex>) and makes a collision negligible. Ids were never stable
    // across runs (they carry the clock), so nothing depends on the old seed.
    const id = genId('claim', `${content}\u0000${source.path || ''}\u0000${randomUUID()}`);
    const ts = nowISO();
    const prov = {
      extractedAt: provenance.extractedAt || ts,
      extractor: provenance.extractor || 'unknown',
      confidence: provenance.confidence ?? 0.5,
      // Origin authority survives extraction (roadmap #10) — dropping it here would BE the
      // provenance-laundering the field exists to prevent.
      ...(provenance.authority ? { authority: provenance.authority } : {}),
      ...(provenance.grounding != null ? { grounding: provenance.grounding } : {}),
      chain: provenance.chain || [{ step: 'ingest', source: source.path || 'unknown', timestamp: ts }],
    };
    // MOSAIC-style write-path relation (arXiv 2607.16211): compare the incoming claim against
    // live neighbors BEFORE it lands, so conflicts are visible at write time instead of being
    // discovered by a later audit or a contradictory query answer. Tag only — never mutate the
    // neighbor: contradictions and supersede candidates are judgment calls, and the flag is
    // what queues them for one. The relation rides in metadata.writeRelation.
    const relation = this.relate(content);
    const meta = relation.relation === 'novel' ? metadata : { ...metadata, writeRelation: relation };
    // TARL deferred ledger (arXiv 2608.03699): a claim that contradicts a live neighbor is not
    // forced into keep-or-quarantine — it lands `deferred` (pending judgment) instead of `active`.
    // Deferred claims are invisible to current()/relate() neighbors until resolved, so uncertain
    // evidence is preserved without being promoted into durable truth. Judgment resolves via
    // resolveDeferred; nothing here auto-resolves.
    const deferIt = defer || (relation.relation === 'contradictory' && this.cfg?.claims?.deferContradictory !== false);
    const status = deferIt ? 'deferred' : 'active';
    // PGMem validity window (roadmap #14): every claim records when it was first observed;
    // corroboration/contradiction updates the window below.
    const meta2 = { ...(deferIt ? { ...meta, deferredAt: ts, deferReason: defer ? 'explicit' : 'write-contradiction' } : meta), firstObserved: ts, lastObserved: ts };
    this.db.prepare(`
      INSERT INTO claims(id,content,type,source,provenance,status,metadata,created_at,updated_at)
      VALUES(?,?,?,?,?, ?, ?,?,?)
    `).run(id, content, type, JSON.stringify(source), JSON.stringify(prov), status, JSON.stringify(meta2), ts, ts);
    if (relation.relation === 'contradictory') this.db.logOp?.('claim-write-conflict', { id, neighbor: relation.neighborId, shared: relation.shared, deferred: deferIt });
    // PGMem evidence edges on the NEIGHBOR — pure observation bookkeeping, never a judgment:
    // corroboration extends the neighbor's validity window (lastObserved + supportCount);
    // contradiction records the challenger's id (bounded). Status is never touched here —
    // the "never mutate the neighbor" rule applies to relations/status, not to counters.
    if (relation.neighborId) {
      const nb = this.get(relation.neighborId);
      if (nb) {
        if (relation.relation === 'corroborating') {
          this.db.prepare('UPDATE claims SET metadata=? WHERE id=?').run(JSON.stringify({
            ...nb.metadata, lastObserved: ts, supportCount: (nb.metadata.supportCount || 0) + 1,
          }), nb.id);
        } else if (relation.relation === 'contradictory') {
          const refs = [...new Set([...(nb.metadata.contradictedBy || []), id])].slice(-5);
          this.db.prepare('UPDATE claims SET metadata=? WHERE id=?').run(JSON.stringify({
            ...nb.metadata, contradictedBy: refs,
          }), nb.id);
        }
      }
    }
    return this.get(id);
  }

  /** PGMem (roadmap #14): a claim's validity window, derived from its own metadata. */
  validity(id) {
    const c = this.get(id);
    if (!c) return null;
    return {
      id: c.id,
      status: c.status,
      firstObserved: c.metadata.firstObserved || c.created_at,
      lastObserved: c.metadata.lastObserved || c.updated_at,
      supportCount: c.metadata.supportCount || 0,
      contradictedBy: c.metadata.contradictedBy || [],
      currentlyValid: (c.status === 'active' || c.status === 'verified') && !(c.metadata.contradictedBy || []).length,
    };
  }

  /** TARL: park a live claim pending judgment (status → deferred). */
  defer(id, reason = 'manual') {
    const c = this.get(id);
    if (!c) return { success: false, message: `not found: ${id}` };
    if (c.status !== 'active' && c.status !== 'verified') return { success: false, message: `cannot defer from status '${c.status}'` };
    this.db.prepare('UPDATE claims SET status=?, metadata=?, updated_at=? WHERE id=?')
      .run('deferred', JSON.stringify({ ...c.metadata, deferredAt: nowISO(), deferReason: reason }), nowISO(), id);
    return { success: true, id, status: 'deferred' };
  }

  /** TARL: resolve a deferred claim by judgment — accept (→ active) or reject (→ archived).
   *  The resolution is recorded in metadata; the claim row is never deleted (ledger history).
   *  Accepting a claim the write path tagged `contradictory` IS the judgment that tag queued: the
   *  tag becomes `additive` (+ `metadata.judged`) and the claim leaves the neighbour's
   *  `contradictedBy` — the same bookkeeping reclassifyWriteConflicts does — so lint stops
   *  reporting a decided pair as a pending write conflict (2026-10-06). Reject keeps the tag: the
   *  row is archived and the tag is its history. */
  resolveDeferred(id, action) {
    if (action !== 'accept' && action !== 'reject') return { success: false, message: `action must be accept|reject, got '${action}'` };
    const c = this.get(id);
    if (!c) return { success: false, message: `not found: ${id}` };
    if (c.status !== 'deferred') return { success: false, message: `not deferred: '${c.status}'` };
    const status = action === 'accept' ? 'active' : 'archived';
    const at = nowISO();
    const wr = c.metadata.writeRelation;
    const judged = action === 'accept' && wr?.relation === 'contradictory';
    const meta = {
      ...c.metadata, deferredResolution: { action, at },
      ...(judged ? { writeRelation: { ...wr, relation: 'additive' }, judged: { action: 'accept', at, from: 'contradictory' } } : {}),
    };
    this.db.tx(() => {
      this.db.prepare('UPDATE claims SET status=?, metadata=?, updated_at=? WHERE id=?').run(status, JSON.stringify(meta), at, id);
      const nb = judged && wr.neighborId ? this.get(wr.neighborId) : null;
      if (nb && Array.isArray(nb.metadata.contradictedBy) && nb.metadata.contradictedBy.includes(id)) {
        const { contradictedBy, ...rest } = nb.metadata;
        const left = contradictedBy.filter((x) => x !== id);
        this.db.prepare('UPDATE claims SET metadata=? WHERE id=?').run(JSON.stringify(left.length ? { ...rest, contradictedBy: left } : rest), nb.id);
      }
    });
    return { success: true, id, status, ...(judged ? { judged: true } : {}) };
  }

  /** The pending ledger: deferred claims, oldest first (review queue order). */
  deferred() {
    return this.db.prepare("SELECT * FROM claims WHERE status='deferred' ORDER BY updated_at ASC, id ASC")
      .all().map((r) => this.#h(r));
  }

  /**
   * Deterministic write-path relation of a candidate claim to its live neighbors.
   * Neighbor = live claim sharing ≥ minShared significant tokens (the same locality rule
   * findContradictions uses). Verdicts, checked in order:
   *  - contradictory: exactly one side negated AND token containment ≥ the floor
   *    (claims.contradictionMinContainment, default 0.6) — same rule as the audit-time finder.
   *    A differing-polarity pair below the floor is two fragments that touch the same locality,
   *    not a claim and its negation; it falls through to the same-polarity ladder below.
   *  - corroborating: near-identical token sets (high Jaccard) with same polarity
   *  - superseding-candidate: strong overlap, same polarity, but materially different content
   *  - additive: shares locality but low similarity — likely a new fact about known things
   *  - novel: no neighbor at all
   * Returns { relation, neighborId?, shared?, similarity?, containment? } for the strongest neighbor.
   */
  relate(content, { minShared = 3, scanLimit = 500 } = {}) {
    const floor = this.#containmentFloor();
    const { neg: candNeg, sig: candSig } = polarity(content);
    let best = null;
    // Bounded, deterministic neighbor scan: the most recent `scanLimit` live claims (stable
    // created_at DESC, id DESC order — same-millisecond bulk inserts must not flip the winner).
    // Unbounded getAll() made every claims.add O(N) and bulk ingest O(N^2) (~11ms/1k claims).
    const neighbors = this.db.prepare(
      "SELECT * FROM claims WHERE status IN ('active','verified') ORDER BY created_at DESC, id DESC LIMIT ?",
    ).all(scanLimit).map((r) => this.#h(r));
    for (const c of neighbors) {
      const { neg: nbNeg, sig: nbSig } = polarity(c.content);
      const { shared, containment } = containmentOf(candSig, nbSig);
      if (shared < minShared) continue;
      const union = new Set([...candSig, ...nbSig]).size;
      const sim = union ? shared / union : 0;
      if (!best || shared > best.shared) {
        let relation;
        // The floor compares the unrounded value; the stored figure is rounded like similarity.
        if (candNeg !== nbNeg && containment >= floor) relation = 'contradictory';
        else if (sim >= 0.8) relation = 'corroborating';
        else if (sim >= 0.4) relation = 'superseding-candidate';
        else relation = 'additive';
        best = { relation, neighborId: c.id, shared, similarity: Number(sim.toFixed(3)), containment: Number(containment.toFixed(3)) };
      }
    }
    return best || { relation: 'novel' };
  }

  /**
   * Re-judge the write-time `contradictory` tags against the containment floor (deterministic;
   * the repair for tags written before the floor existed, or under a lower one). For every
   * deferred/active/verified claim tagged contradictory, containment is recomputed against the
   * RECORDED neighbor with relate()'s tokenisation and negation set. Below the floor — or the
   * neighbor row is gone — the tag becomes `additive` (+ `metadata.reclassified`), a claim the
   * write path itself deferred (`deferReason: 'write-contradiction'`) is released to `active`
   * (`releasedAt`; `deferredAt` stays as history), and its id leaves the neighbor's
   * `contradictedBy`. At or above the floor nothing changes. A claim deferred by judgment (explicit
   * add({defer}), or defer() with any reason) is never touched — only the write path's own
   * verdicts are re-judged. `updated_at` is left alone: the knowledge did not change, so
   * current-claim ordering must not move. One transaction; dryRun computes the same report and writes nothing.
   */
  reclassifyWriteConflicts({ floor = this.#containmentFloor(), dryRun = false } = {}) {
    const rows = this.db.prepare(`SELECT * FROM claims WHERE status IN ('deferred','active','verified')
      AND json_valid(metadata) AND json_extract(metadata, '$.writeRelation.relation') = 'contradictory'
      ORDER BY created_at ASC, id ASC`).all().map((r) => this.#h(r));
    const at = nowISO();
    const out = { scanned: rows.length, reclassified: 0, released: 0, kept: 0, judgmentDeferred: 0, floor, dryRun: !!dryRun, sample: [] };
    const plan = [];
    for (const c of rows) {
      if (c.status === 'deferred' && c.metadata.deferReason !== 'write-contradiction') { out.judgmentDeferred++; continue; }
      const wr = c.metadata.writeRelation || {};
      const nb = wr.neighborId ? this.get(wr.neighborId) : null;
      const containment = nb ? containmentOf(polarity(c.content).sig, polarity(nb.content).sig).containment : null;
      if (nb && containment >= floor) { out.kept++; continue; }
      const reason = nb ? 'below-containment-floor' : 'neighbor-missing';
      const rounded = containment === null ? null : Number(containment.toFixed(3));
      const release = c.status === 'deferred'; // judgment-deferred rows were skipped above
      plan.push({ c, neighborId: wr.neighborId || null, rounded, reason, release });
      out.reclassified++;
      if (release) out.released++;
      if (out.sample.length < 10) out.sample.push({ id: c.id, neighborId: wr.neighborId || null, containment: rounded, reason, status: release ? 'deferred→active' : c.status });
    }
    if (dryRun || !plan.length) return out;
    const upd = this.db.prepare('UPDATE claims SET status=?, metadata=? WHERE id=?');
    const updMeta = this.db.prepare('UPDATE claims SET metadata=? WHERE id=?');
    this.db.tx(() => {
      for (const { c: planned, neighborId, rounded, reason, release } of plan) {
        // Fresh read inside the tx: a claim can itself be the neighbor of an earlier plan item, whose
        // contradictedBy edit must not be overwritten by this row's pre-transaction snapshot.
        const c = this.get(planned.id);
        const meta = {
          ...c.metadata,
          writeRelation: { ...c.metadata.writeRelation, relation: 'additive', containment: rounded },
          reclassified: { from: 'contradictory', at, floor, containment: rounded, reason },
          ...(release ? { releasedAt: at } : {}),
        };
        upd.run(release ? 'active' : c.status, JSON.stringify(meta), c.id);
        // Re-read the neighbor each time: several reclassified claims may share one neighbor.
        const nb = neighborId ? this.get(neighborId) : null;
        if (nb && Array.isArray(nb.metadata.contradictedBy) && nb.metadata.contradictedBy.includes(c.id)) {
          const { contradictedBy, ...rest } = nb.metadata;
          const left = contradictedBy.filter((id) => id !== c.id);
          updMeta.run(JSON.stringify(left.length ? { ...rest, contradictedBy: left } : rest), nb.id);
        }
      }
    });
    return out;
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
   *  ≥ minShared significant tokens, exactly ONE carries a negation marker, and their token
   *  containment reaches the same floor relate() applies at write time (one rule, two call sites).
   *  Heuristic but stable — flags candidates for review; does not auto-mutate status. */
  findContradictions({ minShared = 3 } = {}) {
    const floor = this.#containmentFloor();
    const live = this.getAll().filter((c) => c.status === 'active' || c.status === 'verified')
      .map((c) => ({ c, ...polarity(c.content) }));
    const pairs = [];
    for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
      const a = live[i], b = live[j];
      if (a.neg === b.neg) continue; // need exactly one negated
      const { shared, containment } = containmentOf(a.sig, b.sig);
      if (shared >= minShared && containment >= floor) pairs.push({ a: a.c.id, b: b.c.id, shared, containment: Number(containment.toFixed(3)), contentA: a.c.content, contentB: b.c.content });
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
