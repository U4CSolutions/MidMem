/**
 * Native → middleware bridge.
 *
 * Pulls each stack's flat, siloed memory (OpenClaw daily logs, Hermes memories,
 * agent vault folders) into the shared `state.db` via `ingest` — making it tiered,
 * embedded, scoped, deduped, and recallable by BOTH agents.
 *
 * Idempotent: ingest hash-dedup skips unchanged files, so this is safe to re-run
 * on a cron. Run with agentScope='shared' (default / no OCMW_AGENT_SCOPE) so the
 * governance scope-write policy permits tagging entries per source.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * @param {import('./orchestrator.mjs').Orchestrator} o
 * @param {{sources?:Array<{dir:string,scope:string,type?:string}>, project?:boolean}} [opts]
 */
export async function bridgeMemory(o, { sources = o.cfg.bridgeSources, project = true } = {}) {
  let ingested = 0, skipped = 0;
  const errors = [];
  const perSource = [];

  for (const s of sources) {
    // Governance allows writes to the agent's own scope + 'shared' (and everything when the
    // agent IS 'shared'). A bridge running under a stack scope (e.g. the in-maintain bridge
    // inside an agent's MCP server) must skip the other stack's sources instead of hammering
    // governance with a denial per file per hour — those sources belong to the shared-scope
    // cron/CLI bridge.
    if (o.cfg.agentScope !== 'shared' && s.scope !== o.cfg.agentScope && s.scope !== 'shared') {
      perSource.push({ dir: s.dir, scope: s.scope, skippedReason: `not writable from agentScope '${o.cfg.agentScope}'` });
      continue;
    }
    let files = [];
    try { files = fs.readdirSync(s.dir).filter((f) => f.endsWith('.md')); }
    catch { continue; } // dir may not exist yet (e.g. vault not on NFS yet)
    let si = 0, ss = 0;
    for (const f of files) {
      const p = path.join(s.dir, f);
      try {
        const r = await o.ingest({ path: p, type: s.type || 'note', scope: s.scope, title: f });
        if (r.skipped) { skipped++; ss++; } else { ingested++; si++; }
      } catch (e) { errors.push(`${p}: ${e.message}`); }
    }
    perSource.push({ dir: s.dir, scope: s.scope, files: files.length, ingested: si, skipped: ss });
  }

  if (project) o.project();
  o.db.logOp('bridge', { ingested, skipped, errors: errors.length });
  return { ingested, skipped, errors, perSource };
}
