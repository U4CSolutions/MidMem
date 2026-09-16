/**
 * Governance — fail-closed policy gating (the AGT layer the handoff expected but
 * that never existed). Every mutating operation is dispatched through `governed()`;
 * a policy that denies, or that throws during evaluation, blocks the op.
 *
 * This is the OpenClaw-side analog of fail-closed dispatch: deny-by-exception.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sha12 } from './util.mjs';

export class GovernanceError extends Error {
  constructor(reason, op) { super(`governance denied [${op}]: ${reason}`); this.name = 'GovernanceError'; this.op = op; this.reason = reason; }
}

/** @typedef {{name:string, applies:(op:string,ctx:object)=>boolean, check:(op:string,ctx:object)=>{allow:boolean,reason?:string}}} Policy */

/** Default policy set realizing the approved guardrails. */
export function defaultPolicies(cfg) {
  // Roots resolve through symlinks too (fail-soft: a not-yet-existing root keeps its resolved
  // form) so both sides of the prefix check live in the same, real filesystem namespace.
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  const roots = cfg.sourceRoots.map((r) => real(path.resolve(r)));
  const tierByName = Object.fromEntries(cfg.tiers.map((t) => [t.name, t]));
  return [
    {
      name: 'ingest-path-allowed',
      applies: (op) => op === 'ingest',
      check: (_op, ctx) => {
        // realpath, not just resolve: a symlink planted INSIDE an allowed root must not reach
        // a target outside it. Fail-closed — an unresolvable path (missing file) is denied here
        // rather than trusted through to the read.
        let p;
        try { p = fs.realpathSync(path.resolve(ctx.path || '')); }
        catch { return { allow: false, reason: `source path not resolvable: ${ctx.path}` }; }
        const ok = roots.some((r) => p === r || p.startsWith(r + path.sep));
        return ok ? { allow: true } : { allow: false, reason: `source outside allowed roots: ${p}` };
      },
    },
    {
      name: 'tier-valid',
      applies: (op) => op === 'store' || op === 'promote',
      check: (_op, ctx) => {
        const tier = ctx.toTier || ctx.tier;
        return tierByName[tier] ? { allow: true } : { allow: false, reason: `unknown tier: ${tier}` };
      },
    },
    {
      name: 'curated-tier-write',
      applies: (op) => op === 'store' || op === 'promote',
      check: (_op, ctx) => {
        const tier = tierByName[ctx.toTier || ctx.tier];
        if (tier?.curatedOnly && ctx.curated !== true)
          return { allow: false, reason: `tier '${tier.name}' is curated-only; pass curated:true` };
        return { allow: true };
      },
    },
    {
      // Lifecycle class (roadmap #44): `working` is context-assembly state and never climbs tiers —
      // the documented contract, now enforced on the manual path too (auto-promotion filters it out).
      name: 'working-never-promotes',
      applies: (op) => op === 'promote',
      check: (_op, ctx) => (ctx.memFunction === 'working')
        ? { allow: false, reason: "memory function 'working' is lease-bound context state; it cannot be promoted" }
        : { allow: true },
    },
    {
      name: 'scope-write',
      applies: (op) => op === 'store' || op === 'ingest' || op === 'promote',
      check: (_op, ctx) => {
        const target = ctx.scope;
        if (!target || cfg.agentScope === 'shared') return { allow: true }; // admin/bridge may write any scope
        return (target === cfg.agentScope || target === 'shared')
          ? { allow: true }
          : { allow: false, reason: `agent '${cfg.agentScope}' cannot write to private scope '${target}'` };
      },
    },
    {
      // Provenance-laundering guard (roadmap #10): 'operator' is the one authority level that
      // cannot be claimed by an ordinary write — it must arrive through explicit curation.
      name: 'operator-authority-curated',
      applies: (op) => op === 'store' || op === 'ingest',
      check: (_op, ctx) => (ctx.authority === 'operator' && ctx.curated !== true)
        ? { allow: false, reason: "authority 'operator' requires curated:true" }
        : { allow: true },
    },
    {
      name: 'hard-delete-guard',
      applies: (op) => op === 'forget',
      check: (_op, ctx) => (ctx.soft === false && ctx.force !== true)
        ? { allow: false, reason: 'hard delete requires force:true (soft delete is default)' }
        : { allow: true },
    },
  ];
}

export class PolicyEvaluator {
  /** @param {object} cfg @param {Policy[]} [policies] */
  constructor(cfg, policies) {
    this.cfg = cfg;
    this.policies = policies || defaultPolicies(cfg);
  }

  /** @returns {{allow:boolean, reason?:string, policy?:string}} */
  evaluate(op, ctx = {}) {
    for (const p of this.policies) {
      let applies = false;
      try { applies = p.applies(op, ctx); }
      catch (e) { if (this.cfg.failClosed) return { allow: false, reason: `policy '${p.name}' applies() threw: ${e.message}`, policy: p.name }; continue; }
      if (!applies) continue;
      let res;
      try { res = p.check(op, ctx); }
      catch (e) { if (this.cfg.failClosed) return { allow: false, reason: `policy '${p.name}' check() threw: ${e.message}`, policy: p.name }; continue; }
      if (!res || res.allow !== true) return { allow: false, reason: res?.reason || 'denied', policy: p.name };
    }
    return { allow: true };
  }
}

/**
 * Gate a mutating operation. Records an audit row; throws GovernanceError on deny.
 * @param {{evaluator:PolicyEvaluator, db?:import('./db.mjs').StateDB}} g
 */
export async function governed(g, op, ctx, fn) {
  const d = g.evaluator.evaluate(op, ctx);
  g.db?.recordAudit('governance', sha12(`${op}:${JSON.stringify(d)}`), { op, decision: d, ctx: redact(ctx) });
  if (!d.allow) throw new GovernanceError(d.reason, op);
  return fn();
}

const redact = (ctx) => { const { content, ...rest } = ctx || {}; return content ? { ...rest, content: `<${content.length} chars>` } : rest; };
