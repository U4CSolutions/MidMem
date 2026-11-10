/**
 * Entry lifecycle reads, operator feedback and forget-by-source for capture systems
 * (INTEGRATION-MODES §6, amended 2026-10-04: items 6b, 6c and 7).
 *
 * - `entryStatus` is a pure READ: it never calls recordRetrieval (reading an entry's lifecycle view is
 *   not a recall, so it neither renews a lease nor bumps retrieval_count/last_accessed_at), never runs
 *   maintenance and writes nothing — not even a log row.
 * - `feedbackIfActive` is the CLI `feedback` verb: the agents' feedback loop, refused (as a JSON result,
 *   not an error) for an unknown or non-active entry so a capture system can mark its row dead. With
 *   `favorite` (2026-10-21, schema 6) it sets or clears the operator's favorite instead — one helpful vote
 *   that the unfavorite takes back (TieredMemory.setFavorite).
 * - `forgetSource` soft-forgets every entry a library source produced (active AND superseded history)
 *   through the governed `forget` (#41 cascade) and unlinks the source from other entries'
 *   `provenance.alsoSources`. Idempotent: a second call matches nothing.
 * - The operator-approval checks (2026-11-10, §6 6e): `approvalBlockers` is the one list of checks that
 *   `approve-wisdom` applies and that every `entries` row reports as `approval.blockedBy` — read-only.
 * Node built-ins only; deterministic.
 */
import { json, nowISO } from './util.mjs';
import { verifyPromotion } from './transitions.mjs';
import { entryInstructionLikeness } from './recallpolicy.mjs';
import { normalizeAuthority } from './authority.mjs';

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

/** Promotion thresholds + feedback deltas, read from this store's own config (never hard-coded downstream).
 *  `operatorApproval: true` (2026-11-10) tells a capture system this MidMem has `approve-wisdom` /
 *  `revoke-wisdom` and the `approval` key on every row (the capability check, as `favorite` was for favorites). */
export function promotionThresholds(o) {
  const m = o.cfg.maintenance || {};
  return {
    factPromote: m.factPromote ?? null,
    wisdomPromote: m.wisdomPromote ?? null,
    promoteMinGrounding: o.cfg.transitions?.promoteMinGrounding ?? null,
    feedback: { helpfulTrustDelta: FEEDBACK_TRUST_DELTAS.helpful, unhelpfulTrustDelta: FEEDBACK_TRUST_DELTAS.unhelpful, distrustBelow: m.distrustBelow ?? 0 },
    operatorApproval: true,
  };
}

/** Operator-approved wisdom (2026-11-10, INTEGRATION-MODES §6 6e). `approve-wisdom`'s denial codes, in the order
 *  the checks run (the first that applies is the answer); `revoke-wisdom`'s likewise. Fixed: a capture system
 *  keys its UI on them. A repeat of a write that already holds by this road is no denial but
 *  `{ success: true, changed: false }` (checked after not-active). */
export const APPROVAL_DENIALS = Object.freeze(['not-found', 'not-active', 'already-wisdom', 'not-memory-tier', 'lifecycle', 'fallback-extraction', 'grounding-below-floor', 'instruction-like', 'governance', 'transition-verifier']);
export const REVOKE_DENIALS = Object.freeze(['not-found', 'not-active', 'not-wisdom', 'not-operator-approved', 'governance']);
/** Bounds on the operator's note and the calling system's name (`--note`, `--via`). */
export const APPROVAL_NOTE_MAX = 500;
export const APPROVAL_VIA_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,39}$/;

/** The two tiers an approval moves between: the first curated-only tier (`wisdom`) and the tier directly
 *  below it (`memory`) — never fact → wisdom. Null when the configured tiers have no such pair. */
export function approvalTiers(o) {
  const names = o.memory.tierNames;
  const i = names.findIndex((t) => o.memory.tier(t)?.curatedOnly);
  return i > 0 ? { from: names[i - 1], to: names[i] } : null;
}

/** The live approval record of an entry: `provenance.approval` written by an operator approval, not revoked, and the
 *  entry still in the tier it approved (an older verb, `promote <id> memory`, can move any wisdom entry down; the
 *  record then describes history, not the entry's standing). */
export function liveApproval(e) {
  const a = e?.provenance?.approval;
  return a && typeof a === 'object' && a.by === 'operator-approval' && !a.revokedAt && !a.endedAt && a.to === e.tier ? a : null;
}

/** The record of a revoke that still stands (2026-11-10): the latest approval was revoked by revoke-wisdom, the entry
 *  is back in the tier the approval came from, and no other road has moved it since (`endedAt` unset). A repeated
 *  revoke-wisdom answers `changed: false` on it. */
export function revokedApproval(e) {
  const a = e?.provenance?.approval;
  return a && typeof a === 'object' && a.by === 'operator-approval' && a.revokedAt && !a.endedAt && a.from === e.tier ? a : null;
}

/** Not model-extracted (2026-11-10, D1): an INGESTED entry (it has a source row) whose provenance.extraction is not
 *  the model's — the deterministic fallback, or no record at all (ingested before 2026-10-07; reextract selects
 *  those too). Its summary, concepts and claims are frozen heuristics, and wisdom is never re-extracted: reextract
 *  it first. A direct write (remember, record_work) has no extraction and is not caught here. */
export const fallbackExtracted = (e) => !!e?.source_id && e?.provenance?.extraction?.mode !== 'lmstudio';

/** An active row: status active AND its lease not run out (an expired lease is dead before the sweep runs). */
export const isLiveEntry = (e) => e?.status === 'active' && !(e.expires_at && e.expires_at <= nowISO());

/** The governed context of an approval: the card's {toTier, operatorApproved, curated:false, memFunction} + fromTier. */
export function approvalContext(o, e) {
  const t = approvalTiers(o);
  return { id: e.id, fromTier: e.tier, toTier: t?.to ?? null, operatorApproved: true, curated: false, memFunction: e.mem_function || null };
}

/**
 * Every check `approve-wisdom` applies before its governed write, in order — the earned path's own checks
 * (maintain(): an active row in the tier below wisdom, never a `working` entry, the write-time grounding floor of
 * the transition verifier) with the usage evidence (retrievals, trust, helpful votes) left out, plus the #40
 * instruction-likeness screen and (D1, 2026-11-10) model extraction: a fallback-extracted capture is never approved
 * into a tier that is never re-extracted. `governance: true` also evaluates the policy set (pure: no audit row) — the
 * `entries` read; approveWisdom lets governed() decide and audit instead. Returns the applicable codes
 * (APPROVAL_DENIALS order); empty = eligible. Never writes.
 */
export function approvalBlockers(o, e, { governance = false } = {}) {
  if (!e) return ['not-found'];
  const out = [];
  const t = approvalTiers(o);
  if (!isLiveEntry(e)) out.push('not-active');
  if (t && e.tier === t.to) out.push('already-wisdom');
  else if (!t || e.tier !== t.from) out.push('not-memory-tier');
  if (e.mem_function === 'working') out.push('lifecycle');
  if (fallbackExtracted(e)) out.push('fallback-extraction');
  if (o.cfg.transitions?.enabled !== false && !verifyPromotion(e, o.cfg.transitions).pass) out.push('grounding-below-floor');
  if (entryInstructionLikeness(e).flag) out.push('instruction-like');
  // The policies re-check the tier pair and the lifecycle class; report governance only for what they add.
  const tierOrClass = out.some((c) => c === 'already-wisdom' || c === 'not-memory-tier' || c === 'lifecycle');
  if (governance && !tierOrClass && !o.gov.evaluator.evaluate('approve-wisdom', approvalContext(o, e)).allow) out.push('governance');
  return out;
}

/** Why a wisdom (curated-only tier) entry is wisdom, where the store can tell: 'operator-approved' (a live approval
 *  record), 'curated' (operator authority — only a curated write sets it); null otherwise — an entry earned in
 *  maintain and one promoted by a caller with `--curated` leave no per-entry record that tells them apart. */
function wisdomByOf(o, e) {
  if (!o.memory.tier(e.tier)?.curatedOnly) return null;
  if (liveApproval(e)) return 'operator-approved';
  if (normalizeAuthority(e.provenance?.authority) === 'operator') return 'curated';
  return null;
}

/** The `approval` key of an entries row (2026-11-10): eligible / blockedBy (approvalBlockers, governance included),
 *  the live approval's time and calling system, and whether revoke-wisdom would take it (revocable). */
function approvalOf(o, e) {
  const blockedBy = approvalBlockers(o, e, { governance: true });
  const a = liveApproval(e);
  const t = approvalTiers(o);
  return { eligible: blockedBy.length === 0, blockedBy, approvedAt: a?.at ?? null, via: a?.via ?? null, revocable: !!a && !!t && e.tier === t.to && isLiveEntry(e) };
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
    // Schema 6: the operator's favorite — a live flag, so an archived / deleted row is no favorite — and whether a
    // favorite's one helpful vote is inside helpfulCount (vote history, kept on every row).
    favorite: e.status === 'active' && e.favorite === 1, favoriteHelpful: e.favorite_helpful === 1,
    lastAccessedAt: e.last_accessed_at ?? null,
    summary: clip(e.content, 600),
    concepts: (Array.isArray(e.concepts) ? e.concepts : []).slice(0, MAX_CONCEPTS).map((c) => ({
      name: clip(c?.name, 120), type: c?.type ?? 'concept', confidence: c?.confidence ?? null, groundingScore: c?.groundingScore ?? null,
    })),
    source: p.source ? { libraryId: p.source.libraryId ?? null, docId: p.source.docId ?? null, canonicalUri: p.source.canonicalUri ?? null } : null,
    alsoSources: (Array.isArray(p.alsoSources) ? p.alsoSources : []).map((a) => ({ libraryId: a?.source?.libraryId ?? null, docId: a?.source?.docId ?? null })),
    liftedFrom: p.liftedFrom ?? null,
    grounding: { summaryScore: p.grounding?.summaryScore ?? null },
    // Which extractor produced summary/concepts/claims ({ mode, model, at }); null for a legacy entry.
    extraction: p.extraction && typeof p.extraction === 'object' ? { mode: p.extraction.mode ?? null, model: p.extraction.model ?? null, at: p.extraction.at ?? null } : null,
    claims: {
      active: cl.filter((c) => c.status === 'active' || c.status === 'verified').length, total: cl.length,
      ...(withClaims ? { items: cl.slice(0, MAX_CLAIM_ITEMS).map((c) => ({ id: c.id, content: clip(c.content, 500), status: c.status })) } : {}),
    },
    // wisdomBy (2026-11-10): why a wisdom entry is wisdom — 'operator-approved' | 'curated' | null — appended last.
    promotion: { ...promotionOf(o, e), wisdomBy: wisdomByOf(o, e) },
    // Operator-approved wisdom (2026-11-10, §6 6e): may the operator approve this entry, and is it approved now.
    approval: approvalOf(o, e),
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

/** CLI `feedback <entryId> [--unhelpful | --favorite | --unfavorite]` (§6 item 6b): the agents' feedback loop
 *  for one ACTIVE entry. Unknown / non-active → a JSON refusal (`reason`), never an error, so the caller can
 *  stop retrying. `favorite: true | false` (schema 6) sets / clears the favorite instead of a plain vote →
 *  `{ success, id, favorite, helpful_count, trust_score, changed }`; it is one vote, so it never combines with
 *  `helpful: false`. */
export function feedbackIfActive(o, id, { helpful = true, favorite } = {}) {
  if (typeof id !== 'string' || !id) throw new Error('feedback needs <entryId>');
  checkId(id, 'entry id');
  if (favorite !== undefined && typeof favorite !== 'boolean') throw new Error('favorite must be true or false');
  if (favorite !== undefined && helpful === false) throw new Error('feedback takes one vote: --unhelpful, --favorite or --unfavorite');
  const e = o.recall(id);
  if (!e) return { success: false, reason: 'not-found', id };
  if (e.status !== 'active') return { success: false, reason: 'not-active', id, status: e.status };
  if (favorite !== undefined) return o.favorite(id, favorite, { activeOnly: true });
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
