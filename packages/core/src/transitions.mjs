/**
 * Transition verifier — TRUSTMEM-style (arXiv 2606.25161) check on memory TRANSITIONS,
 * not just final states. A consolidation/supersede/promotion can fail three ways: omission
 * (prior knowledge lost), corruption (subject drift — the replacement is about something
 * else), and insertion (content supported by neither the prior memory nor the evidence).
 *
 * DELEGATE-52 discipline: pure token-overlap arithmetic, no model, no network. The verdict
 * is deterministic and auditable — every check writes a proof receipt to the audit table.
 * Thresholds are env-tunable (config.transitions); deny-on-fail can be disabled but the
 * receipt is always written.
 */
import { groundingScore } from './grounding.mjs';
import { tokenize, sha, nowISO } from './util.mjs';

const NEG = new Set(['not', 'no', 'never', 'none', 'cannot', 'cant', 'isnt', 'arent', 'wont', 'dont', 'false', 'incorrect', 'deprecated', 'removed', 'without', 'disabled', 'fails', 'failed']);

/** Shared significant (non-negation) token fraction of the SMALLER side — subject continuity. */
export function subjectOverlap(a, b) {
  const A = new Set(tokenize(a).filter((t) => !NEG.has(t)));
  const B = new Set(tokenize(b).filter((t) => !NEG.has(t)));
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / Math.min(A.size, B.size);
}

/**
 * Verify a memory transition before(t) + evidence → after(t+1).
 *
 * - subjectOverlap: is `after` still about the same knowledge point as `before`?
 *   (guards corruption — a supersede must not silently swap topics)
 * - coverage: fraction of `after`'s content-words supported by before ∪ evidence
 *   (its complement is insertion — unsupported content entering memory)
 *
 * `pass` = subjectOverlap ≥ minSubjectOverlap AND (evidence given → coverage ≥ minCoverage).
 * Without evidence the coverage gate is informational only: a legitimate correction can
 * introduce new facts, but it must at least stay on-subject.
 */
export function verifyTransition({ before = '', after = '', evidence = '' }, cfg = {}) {
  const minSubject = cfg.minSubjectOverlap ?? 0.15;
  const minCoverage = cfg.minCoverage ?? 0.6;
  const subj = Number(subjectOverlap(before, after).toFixed(3));
  const support = [before, evidence].filter(Boolean).join('\n');
  const coverage = Number(groundingScore(support, after).toFixed(3));
  const insertion = Number((1 - coverage).toFixed(3));
  const coverageGate = evidence ? coverage >= minCoverage : true;
  const pass = subj >= minSubject && coverageGate;
  return { pass, subjectOverlap: subj, coverage, insertion, gates: { minSubjectOverlap: minSubject, minCoverage: evidence ? minCoverage : null } };
}

/** Write the deterministic proof receipt. Always recorded, pass or fail. */
export function auditTransition(db, kind, verdict, { before = '', after = '' } = {}) {
  db.prepare('INSERT INTO audit(ts,kind,proof_hash,detail) VALUES(?,?,?,?)')
    .run(nowISO(), `transition:${kind}`, sha(before + '→' + after).slice(0, 16), JSON.stringify(verdict));
}

/**
 * Promotion check: an entry may only climb tiers if its stored write-time grounding
 * cleared the floor. Content doesn't change on promote, so the deterministic signal is
 * the provenance grounding record; an entry ingested with a drifted summary must not
 * become durable knowledge just because it got retrieved a lot.
 * Entries with no grounding record (hand-written remember/work events) pass — grounding
 * applies to extracted content, and storeMemory text IS the source.
 */
export function verifyPromotion(entry, cfg = {}) {
  const min = cfg.promoteMinGrounding ?? 0.3;
  const g = entry?.provenance?.grounding;
  if (!g || g.summaryScore == null) return { pass: true, reason: 'no-grounding-record (direct write)' };
  const pass = g.summaryScore >= min;
  return { pass, summaryScore: g.summaryScore, gate: min, reason: pass ? 'grounded' : 'write-time grounding below promotion floor' };
}
