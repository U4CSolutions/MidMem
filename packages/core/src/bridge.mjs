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

/** Recursive markdown walk (roadmap 2026-09 #38). Dot-dirs and node_modules are skipped; the
 *  result is sorted so a bridge pass is deterministic. Returns paths relative to `root`. */
export function walkMarkdown(root, { recursive = true, exclude = [] } = {}) {
  const out = [];
  // Excluded subfolders are matched by path relative to the root ('research', 'reports/drafts');
  // another source owns them (e.g. a shared-scope deliverables source) — skipping is not loss.
  const ex = new Set((exclude || []).map((e) => String(e).replace(/^\/+|\/+$/g, '')).filter(Boolean));
  const visit = (dir, rel) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of ents) {
      if (d.name.startsWith('.') || d.name === 'node_modules') continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) { if (recursive && !ex.has(r)) visit(path.join(dir, d.name), r); }
      else if (d.name.endsWith('.md')) out.push(r);
    }
  };
  visit(root, '');
  return out.sort();
}

/**
 * @param {import('./orchestrator.mjs').Orchestrator} o
 * @param {{sources?:Array<{dir:string,scope:string,type?:string,project?:string|null,recursive?:boolean}>, project?:boolean}} [opts]
 *   `project:true` here means "reproject the vault afterwards" (legacy name); a source's own
 *   `project` field is the project-axis tag its files are ingested under.
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
    if (!fs.existsSync(s.dir)) continue; // dir may not exist yet (e.g. vault not on NFS yet)
    const recursive = s.recursive ?? o.cfg.bridgeRecursive !== false;
    const files = walkMarkdown(s.dir, { recursive, exclude: s.exclude || [] });
    let si = 0, ss = 0;
    for (const f of files) {
      const p = path.join(s.dir, f);
      try {
        // Title = path relative to the root, so nested files stay distinguishable in the wiki.
        const r = await o.ingest({ path: p, type: s.type || 'note', scope: s.scope, title: f, project: s.project ?? null });
        if (r.skipped) { skipped++; ss++; } else { ingested++; si++; }
      } catch (e) { errors.push(`${p}: ${e.message}`); }
    }
    perSource.push({ dir: s.dir, scope: s.scope, project: s.project ?? null, recursive, ...(s.exclude?.length ? { exclude: s.exclude } : {}), files: files.length, ingested: si, skipped: ss });
  }

  if (project) o.project();
  o.db.logOp('bridge', { ingested, skipped, errors: errors.length });
  return { ingested, skipped, errors, perSource };
}
