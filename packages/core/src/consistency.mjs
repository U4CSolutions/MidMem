/**
 * Global memory-consistency pass (roadmap #13, arXiv 2608.03137 "Verifiable Memory").
 *
 * The transition verifier (roadmap #1) checks each mutation; this checks the RESULTING
 * STATE: cross-claim contradictions among live claims, dangling supersede chains, and
 * deferred claims aging past their review window. Report-only by design (non-goal: no
 * auto-mutation) — findings are queued for judgment, never "fixed" silently. Runs on the
 * forced/daily maintain pass where the other heavy sweeps live.
 */

export function checkConsistency(o, opts = {}) {
  const cfg = o.cfg.claims || {};
  const deferAgeDays = opts.deferAgeDays ?? cfg.deferAgeDays ?? 14;
  const all = o.claims.getAll();
  const byId = new Map(all.map((c) => [c.id, c]));

  // a) Live cross-claim contradictions (the pairwise audit, at state level).
  const contradictions = o.claims.findContradictions(opts.minShared != null ? { minShared: opts.minShared } : {});

  // b) Dangling supersede chains — the pointers must form a closed, consistent history:
  //    superseded_by must exist; a claim marked superseded must say what replaced it;
  //    a supersedes pointer must reference a claim actually marked superseded.
  const danglingChains = [];
  for (const c of all) {
    const supBy = c.metadata?.superseded_by;
    if (supBy && !byId.has(supBy)) danglingChains.push({ id: c.id, problem: 'superseded_by-missing', ref: supBy });
    if (c.status === 'superseded' && !supBy) danglingChains.push({ id: c.id, problem: 'superseded-without-pointer' });
    const sup = c.metadata?.supersedes;
    if (sup) {
      const old = byId.get(sup);
      if (!old) danglingChains.push({ id: c.id, problem: 'supersedes-missing', ref: sup });
      else if (old.status !== 'superseded') danglingChains.push({ id: c.id, problem: 'supersedes-target-not-superseded', ref: sup, refStatus: old.status });
    }
  }

  // c) Deferred-ledger aging: pending judgment is fine; forgotten judgment is not.
  const cutoff = Date.now() - deferAgeDays * 864e5;
  const deferredAging = o.claims.deferred()
    .filter((c) => (Date.parse(c.metadata?.deferredAt || c.updated_at || '') || 0) < cutoff)
    .map((c) => ({ id: c.id, since: c.metadata?.deferredAt, content: c.content.slice(0, 100) }));

  const findings = contradictions.length + danglingChains.length + deferredAging.length;
  return {
    pass: findings === 0,
    findings,
    contradictions,
    danglingChains,
    deferredAging,
    checked: { claims: all.length, deferAgeDays },
  };
}
