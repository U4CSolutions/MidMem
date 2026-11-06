#!/usr/bin/env node
/**
 * midmem hook — the modular caller seam for trigger-less recall + automatic work capture.
 *
 * Stack-agnostic by design: an OpenClaw pre-turn hook, a Hermes hook, a bridge step, or a
 * plain standalone shell alias all invoke the SAME entrypoint against the shared state.db
 * (located via MIDMEM_DB_PATH / MIDMEM_AGENT_SCOPE env). This is the one place the otherwise
 * pure-core library touches a "caller path" — keeping every mode wired through one seam.
 *
 *   node bin/hook.mjs pre   "<user message>"                     → prints recall inject block (or nothing)
 *   node bin/hook.mjs post  --kind correction --task "..." ...   → records a work-memory event
 *   node bin/hook.mjs tasks                                      → prints ongoing requests (JSON)
 *
 * Project axis (#18): `--project <slug>` on pre (filter: project + global) and post (tag); the
 * MIDMEM_PROJECT env is the per-caller default, so a harness sets it once and never passes it.
 *
 * `pre` writes ONLY the inject text to stdout (empty when nothing clears the threshold), so a hook
 * can splice the result straight into the model's context. Diagnostics/JSON go to stderr.
 */
import { Orchestrator } from '../src/index.mjs';

const [mode, ...rest] = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) { const k = rest[i].slice(2); const v = rest[i + 1]?.startsWith('--') || rest[i + 1] === undefined ? true : rest[++i]; flags[k] = v; }
  else pos.push(rest[i]);
}

const o = new Orchestrator();
try {
  if (mode === 'pre' || mode === 'pre-turn') {
    const message = flags.message || pos.join(' ');
    const r = await o.proactiveRecall(message, {
      minScore: flags.minScore != null ? Number(flags.minScore) : undefined,
      maxTokens: flags.maxTokens != null ? Number(flags.maxTokens) : undefined,
      scopes: flags.scopes?.split(','), force: !!flags.force,
      ...(flags['all-projects'] ? { projects: null } : typeof flags.projects === 'string' ? { projects: flags.projects.split(',') } : typeof flags.project === 'string' ? { project: flags.project } : {}),
    });
    if (r.inject) process.stdout.write(r.inject + '\n');
    process.stderr.write(`[midmem hook pre] injected=${r.used?.length || 0} topScore=${r.topScore}\n`);
  } else if (mode === 'post' || mode === 'post-turn' || mode === 'work') {
    const r = await o.recordWork({
      kind: flags.kind, task: flags.task, content: flags.content || (pos.join(' ') || undefined),
      outcome: flags.outcome, status: flags.status, source: flags.source, artifact: flags.artifact,
      profile: flags.profile, related: flags.related, scope: flags.scope,
      ...(typeof flags.project === 'string' ? { project: flags.project } : {}),
    });
    process.stderr.write(`[midmem hook post] ${JSON.stringify(r)}\n`);
  } else if (mode === 'tasks') {
    process.stdout.write(JSON.stringify(o.openTasks(), null, 2) + '\n');
  } else {
    process.stderr.write('Usage: hook.mjs <pre "<msg>" [--project <slug>|--projects a,b|--all-projects] | post --kind <type> --task "..." [--outcome --source --artifact --status --project <slug>] | tasks>\n');
    process.exitCode = 2;
  }
} catch (e) { process.stderr.write(`[midmem hook] ERROR: ${e.message}\n`); process.exitCode = 1; }
finally { o.close(); }
