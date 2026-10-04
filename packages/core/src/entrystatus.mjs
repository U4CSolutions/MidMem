/**
 * Entry lifecycle reads, operator feedback and forget-by-source for capture systems
 * (INTEGRATION-MODES §6, amended 2026-10-04: items 6b, 6c and 7).
 *
 * - `entryStatus` is a pure READ: it never calls recordRetrieval (reading an entry's lifecycle view is
 *   not a recall, so it neither renews a lease nor bumps retrieval_count/last_accessed_at), never runs
 *   maintenance and writes nothing — not even a log row.
 * - `feedbackIfActive` is the CLI `feedback` verb: the agents' feedback loop, refused (as a JSON result,
 *   not an error) for an unknown or non-active entry so a capture system can mark its row dead.
 * - `forgetSource` soft-forgets every entry a library source produced (active AND superseded history)
 *   through the governed `forget` (#41 cascade) and unlinks the source from other entries'
 *   `provenance.alsoSources`. Idempotent: a second call matches nothing.
 * Node built-ins only; deterministic.
 */
import { json, nowISO } from './util.mjs';
import { verifyPromotion } from './transitions.mjs';

/** Entry ids, library ids and doc ids accepted by the verbs (bounded, no separators or whitespace). */
export const ENTRY_STATUS_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** The trust nudges `TieredMemory.recordFeedback` applies (memory.mjs). Reported in `thresholds.feedback`
 *  so a capture system never hard-codes them; the smoke test asserts the two agree. */
export const FEEDBACK_TRUST_DELTAS = Object.freeze({ helpful: 0.05, unhelpful: -0.1 });
export const ENTRY_STATUS_MAX_LIMIT = 5000;
const MAX_CLAIM_ITEMS = 10;
const MAX_CONCEPTS = 32;

const clip = (v, n) => String(v ?? '').slice(0, n);
const round3 = (n) => Number((n ?? 0).toFixed(3));
const checkId = (v, what) => {
  if (typeof v !== 'string' || !ENTRY_STATUS_ID_RE.test(v)) throw new Error(`bad ${what}: ${clip(v, 40)}`);
  return v;
};
const checkInt = (v, what, min, max) => {
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${what} must be an integer ${min}..${max}`);
  return v;
};

/** Promotion thresholds + feedback deltas, read from this store's own config (never hard-coded downstream). */
export function promotionThresholds(o) {
  const m = o.cfg.maintenance || {};
  return {
    factPromote: m.factPromote ?? null,
    wisdomPromote: m.wisdomPromote ?? null,
    promoteMinGrounding: o.cfg.transitions?.promoteMinGrounding ?? null,
    feedback: { helpfulTrustDelta: FEEDBACK_TRUST_DELTAS.helpful, unhelpfulTrustDelta: FEEDBACK_TRUST_DELTAS.unhelpful, distrustBelow: m.distrustBelow ?? 0 },
  };
}

/** Where an entry stands against the usage-earned promotion rule `maintain()` applies
 *  (memory.autoPromoteCandidates + the write-time grounding pre-filter). Same keys in every case. */
function promotionOf(o, e) {
  const names = o.memory.tierNames;
  const i = names.indexOf(e.tier);
  const next = i >= 0 ? names[i + 1] || null : null;
  const tc = o.memory.tier(e.tier);
  const m = o.cfg.maintenance || {};
  const g = verifyPromotion(e, o.cfg.transitions);
  const groundingGate = { pass: g.pass, summaryScore: g.summaryScore ?? null, gate: g.gate ?? null };
  const base = { next, rule: null, eligible: false, blockers: [], progress: null, groundingGate, runsIn: 'maintain' };
  if (e.status !== 'active') return { ...base, blockers: ['not-active'] };
  if (!next || !tc?.autoPromote) return { ...base, next: null, blockers: ['top-tier'], permanent: !tc?.ttl };
  if (e.mem_function === 'working') return { ...base, blockers: ['working-function'] };
  const curated = !!o.memory.tier(next)?.curatedOnly;
  const rule = (curated ? m.wisdomPromote : m.factPromote) || {};
  const trust = e.trust_score ?? 0;
  const progress = {
    retrievals: { have: e.retrieval_count, need: rule.minRetrievals },
    trust: { have: round3(trust), need: rule.minTrust },
    ...(curated ? { helpful: { have: e.helpful_count, need: rule.minHelpful } } : {}),
  };
  const blockers = [];
  if (curated) {
    if (e.retrieval_count < rule.minRetrievals) blockers.push('needs-retrievals');
    if (trust < rule.minTrust) blockers.push('needs-trust');
    if (e.helpful_count < rule.minHelpful) blockers.push('needs-helpful');
  } else if (!(e.retrieval_count >= rule.minRetrievals || trust >= rule.minTrust)) blockers.push('needs-retrievals-or-trust');
  if (o.cfg.transitions?.enabled !== false && !g.pass) blockers.push('grounding-below-floor');
  return { ...base, rule: curated ? 'all' : 'any', eligible: blockers.length === 0, blockers, progress };
}

/** Claims the entry's ingest produced (exact on the sourceId written at ingest, #41). */
function claimsOf(o, e) {
  if (!e.source_id) return [];
  return o.db.prepare("SELECT id, content, status FROM claims WHERE json_valid(source) AND json_extract(source, '$.sourceId') = ? ORDER BY created_at, rowid").all(e.source_id);
}

/** The lifecycle view of one hydrated entry (bounded strings; no recall side effects). */
function view(o, e, withClaims) {
  const p = e.provenance || {};
  const cl = claimsOf(o, e);
  return {
    id: e.id, tier: e.tier, type: e.type, status: e.status, scope: e.scope, project: e.project ?? null,
    authority: p.authority ?? null, memFunction: e.mem_function ?? null, category: p.category ?? null,
    createdAt: e.created_at, updatedAt: e.updated_at, expiresAt: e.expires_at ?? null,
    trustScore: round3(e.trust_score), retrievalCount: e.retrieval_count, helpfulCount: e.helpful_count,
    lastAccessedAt: e.last_accessed_at ?? null,
    summary: clip(e.content, 600),
    concepts: (Array.isArray(e.concepts) ? e.concepts : []).slice(0, MAX_CONCEPTS).map((c) => ({
      name: clip(c?.name, 120), type: c?.type ?? 'concept', confidence: c?.confidence ?? null, groundingScore: c?.groundingScore ?? null,
    })),
    source: p.source ? { libraryId: p.source.libraryId ?? null, docId: p.source.docId ?? null, canonicalUri: p.source.canonicalUri ?? null } : null,
    alsoSources: (Array.isArray(p.alsoSources) ? p.alsoSources : []).map((a) => ({ libraryId: a?.source?.libraryId ?? null, docId: a?.source?.docId ?? null })),
    liftedFrom: p.liftedFrom ?? null,
    grounding: { summaryScore: p.grounding?.summaryScore ?? null },
    claims: {
      active: cl.filter((c) => c.status === 'active' || c.status === 'verified').length, total: cl.length,
      ...(withClaims ? { items: cl.slice(0, MAX_CLAIM_ITEMS).map((c) => ({ id: c.id, content: clip(c.content, 500), status: c.status })) } : {}),
    },
    promotion: promotionOf(o, e),
  };
}

/** Active entries that hold a library source as a linked duplicate (`provenance.alsoSources`). */
function linkHolders(o, libraryId) {
  return o.db.prepare("SELECT id, provenance FROM entries WHERE status='active' AND provenance LIKE '%alsoSources%' ORDER BY updated_at DESC, id").all()
    .map((r) => ({ id: r.id, prov: json(r.provenance, {}) || {} }))
    .map((r) => ({ id: r.id, prov: r.prov, docs: (Array.isArray(r.prov.alsoSources) ? r.prov.alsoSources : []).filter((a) => a?.source?.libraryId === libraryId).map((a) => a.source.docId) }))
    .filter((r) => r.docs.length);
}

/**
 * entries({ ids?, libraryId?, docIds?, claims?, limit?, offset? }) — INTEGRATION-MODES §6 item 7.
 * Positional entry ids, or a library (optionally narrowed to doc ids). Per doc id: the head entry (the
 * active one if any, else the most recently updated), `history` (how many entries that source produced)
 * and `linkedTo` (the live entry that holds this source's identical text as a linked duplicate, used
 * when the source has no active entry of its own). Paged by doc id (sorted) with limit/offset.
 */
export function entryStatus(o, { ids = [], libraryId = null, docIds = [], claims = false, limit = 500, offset = 0 } = {}) {
  if (!Array.isArray(ids) || !Array.isArray(docIds)) throw new Error('ids and docIds must be arrays');
  for (const id of ids) checkId(id, 'entry id');
  for (const d of docIds) checkId(d, 'doc id');
  if (libraryId !== null && libraryId !== undefined) checkId(libraryId, 'library id');
  checkInt(limit, 'limit', 1, ENTRY_STATUS_MAX_LIMIT);
  checkInt(offset, 'offset', 0, Number.MAX_SAFE_INTEGER);
  if (docIds.length > ENTRY_STATUS_MAX_LIMIT) throw new Error(`at most ${ENTRY_STATUS_MAX_LIMIT} doc ids`);
  if (ids.length && (libraryId || docIds.length)) throw new Error('entries takes entry ids OR --library [--doc-ids], not both');
  if (docIds.length && !libraryId) throw new Error('--doc-ids needs --library');
  const withClaims = !!claims;
  const out = { entries: [], missing: [], total: 0, thresholds: promotionThresholds(o) };
  const ownCount = o.db.prepare(`SELECT COUNT(*) c FROM entries WHERE json_valid(provenance)
    AND json_extract(provenance,'$.source.libraryId') = ? AND json_extract(provenance,'$.source.docId') = ?`);

  if (ids.length) {
    for (const id of [...new Set(ids)]) {
      const e = o.recall(id); // memory.get — a plain row read, never recordRetrieval
      if (!e) { out.missing.push(id); continue; }
      const src = e.provenance?.source;
      const history = src?.libraryId && src?.docId ? ownCount.get(src.libraryId, src.docId).c : 1;
      out.entries.push({ docId: src?.docId ?? null, history, linkedTo: null, ...view(o, e, withClaims) });
    }
    out.total = out.entries.length;
    return out;
  }
  if (!libraryId) throw new Error('entries needs entry ids, or --library <id> [--doc-ids a,b]');

  const wanted = docIds.length ? new Set(docIds) : null;
  const rows = o.db.prepare(`SELECT id, status, json_extract(provenance,'$.source.docId') doc FROM entries
    WHERE json_valid(provenance) AND json_extract(provenance,'$.source.libraryId') = ? ORDER BY updated_at DESC, id`).all(libraryId);
  const head = new Map(); const hist = new Map();
  for (const r of rows) {
    if (typeof r.doc !== 'string' || (wanted && !wanted.has(r.doc))) continue;
    hist.set(r.doc, (hist.get(r.doc) || 0) + 1);
    const cur = head.get(r.doc);
    if (!cur || (cur.status !== 'active' && r.status === 'active')) head.set(r.doc, r);
  }
  const linked = new Map();
  for (const h of linkHolders(o, libraryId)) {
    for (const d of h.docs) if (typeof d === 'string' && (!wanted || wanted.has(d)) && !linked.has(d)) linked.set(d, h.id);
  }
  const docs = [...new Set([...head.keys(), ...[...linked.keys()].filter((d) => head.get(d)?.status !== 'active')])].sort();
  out.total = docs.length;
  for (const d of docs.slice(offset, offset + limit)) {
    const own = head.get(d);
    if (own?.status === 'active' || !linked.has(d)) out.entries.push({ docId: d, history: hist.get(d) || 0, linkedTo: null, ...view(o, o.recall(own.id), withClaims) });
    else out.entries.push({ docId: d, history: hist.get(d) || 0, linkedTo: linked.get(d), ...view(o, o.recall(linked.get(d)), withClaims) });
  }
  if (wanted) out.missing = [...wanted].filter((d) => !head.has(d) && !linked.has(d));
  return out;
}

/** CLI `feedback <entryId> [--unhelpful]` (§6 item 6b): the agents' feedback loop for one ACTIVE entry.
 *  Unknown / non-active → a JSON refusal (`reason`), never an error, so the caller can stop retrying. */
export function feedbackIfActive(o, id, { helpful = true } = {}) {
  if (typeof id !== 'string' || !id) throw new Error('feedback needs <entryId>');
  checkId(id, 'entry id');
  const e = o.recall(id);
  if (!e) return { success: false, reason: 'not-found', id };
  if (e.status !== 'active') return { success: false, reason: 'not-active', id, status: e.status };
  return o.feedback(id, helpful !== false);
}

/** forgetSource({ libraryId, docId, dryRun }) — operator-initiated forget of one library source (§6 item 6c). */
export async function forgetSource(o, { libraryId, docId, dryRun = false } = {}) {
  if (!libraryId || !docId) throw new Error('forget-source needs --library <id> and --doc-id <docId>');
  checkId(libraryId, 'library id');
  checkId(docId, 'doc id');
  const rows = o.db.prepare(`SELECT id, provenance FROM entries WHERE status != 'deleted' AND json_valid(provenance)
    AND json_extract(provenance,'$.source.libraryId') = ? AND json_extract(provenance,'$.source.docId') = ? ORDER BY created_at, id`).all(libraryId, docId);
  // Other sources whose identical text these entries hold: the caller re-ingests them so they keep a live
  // entry. `sharedWith` names only this library's doc ids (the caller reads them as its own); sources of
  // other libraries that lose their entry too are reported apart as `sharedWithOther` [{libraryId, docId}].
  const sharedWith = new Set(); const other = new Map();
  for (const r of rows) {
    const also = json(r.provenance, {})?.alsoSources;
    for (const a of Array.isArray(also) ? also : []) {
      const s = a?.source;
      if (typeof s?.docId !== 'string' || (s.libraryId === libraryId && s.docId === docId)) continue;
      const lib = typeof s.libraryId === 'string' ? s.libraryId : null;
      if (lib === libraryId) sharedWith.add(s.docId);
      else other.set(`${lib ?? ''}\u0000${s.docId}`, { libraryId: lib, docId: s.docId });
    }
  }
  const sharedWithOther = [...other.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
  // Every non-deleted entry that links this source, not only active ones: M4 counts a link on any
  // non-deleted holder (an archived one included) as standing, so a link left on a superseded or expired
  // holder would make the next re-ingest of the same text 'unchanged' with no live entry. Deleted holders
  // stand for nothing and keep their provenance as an audit tombstone. Exact json_each match.
  const holders = o.db.prepare(`SELECT id, provenance FROM entries WHERE status != 'deleted' AND provenance LIKE '%alsoSources%' AND json_valid(provenance)
    AND EXISTS (SELECT 1 FROM json_each(provenance, '$.alsoSources') a WHERE a.type = 'object'
      AND json_extract(a.value, '$.source.libraryId') = ? AND json_extract(a.value, '$.source.docId') = ?) ORDER BY updated_at DESC, id`)
    .all(libraryId, docId).map((r) => ({ id: r.id, prov: json(r.provenance, {}) || {} })).filter((h) => Array.isArray(h.prov.alsoSources));
  const res = { success: true, libraryId, docId, matched: rows.length, forgotten: 0, unlinked: 0, sharedWith: [...sharedWith].sort(), sharedWithOther, cascade: { claimsArchived: 0, conceptsFlagged: 0 }, dryRun: !!dryRun };
  if (dryRun) { res.unlinked = holders.length; return res; }
  for (const r of rows) {
    const f = await o.forget(r.id, { soft: true }); // governed; #41 cascade archives claims, flags orphaned concepts
    if (f.success) { res.forgotten++; res.cascade.claimsArchived += f.cascade?.claimsArchived || 0; res.cascade.conceptsFlagged += f.cascade?.conceptsFlagged || 0; }
  }
  o.db.tx(() => {
    const upd = o.db.prepare('UPDATE entries SET provenance=? WHERE id=?');
    for (const h of holders) {
      const p = h.prov;
      p.alsoSources = p.alsoSources.filter((a) => !(a?.source?.libraryId === libraryId && a?.source?.docId === docId));
      upd.run(JSON.stringify(p), h.id); // metadata-only, like the link itself: updated_at untouched
      res.unlinked++;
    }
  });
  o.db.logOp('forget-source', { libraryId, docId, matched: res.matched, forgotten: res.forgotten, unlinked: res.unlinked, sharedWith: res.sharedWith.length, sharedWithOther: sharedWithOther.length, cascade: res.cascade, at: nowISO() });
  return res;
}
