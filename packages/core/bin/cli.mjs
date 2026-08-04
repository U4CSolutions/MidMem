#!/usr/bin/env node
/** ocmw — middleware CLI. Replaces the scaffold's disconnected scripts/. */
import { Orchestrator } from '../src/index.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) { const k = rest[i].slice(2); const v = rest[i + 1]?.startsWith('--') || rest[i + 1] === undefined ? true : rest[++i]; flags[k] = v; }
  else pos.push(rest[i]);
}
const out = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));

const o = new Orchestrator();
try {
  switch (cmd) {
    case 'init': out({ db: o.cfg.dbPath, vault: o.cfg.vaultPath, tiers: o.memory.tierNames }); break;
    case 'ingest': out(await o.ingest({ path: pos[0], type: flags.type || 'note', title: flags.title, scope: flags.scope, curated: !!flags.curated })); break;
    case 'remember': out(await o.storeMemory({ content: pos.join(' '), tier: flags.tier || 'memory', type: flags.type || 'insight', scope: flags.scope, curated: !!flags.curated, memFunction: typeof flags.function === 'string' ? flags.function : null })); break;
    case 'query': out(await o.query(pos.join(' '), { tiers: flags.tiers?.split(','), scopes: flags.scopes?.split(','), functions: typeof flags.functions === 'string' ? flags.functions.split(',') : undefined, limit: Number(flags.limit) || 20, includeGraphContext: !!flags.graph })); break;
    case 'bridge': { const { bridgeMemory } = await import('../src/bridge.mjs'); out(await bridgeMemory(o)); break; }
    case 'handoff': out(await o.handoffBrief({ task: pos.join(' '), profile: flags.profile || 'local', scopes: flags.scopes?.split(','), tiers: flags.tiers?.split(',') })); break;
    case 'recall': out(o.recall(pos[0])); break;
    case 'brief': out(await o.brief()); break;
    case 'lint': out(o.lint()); break;
    case 'project': out(o.project({ force: !!flags.force })); break;
    case 'promote': out(await o.promote(pos[0], pos[1], { curated: !!flags.curated })); break;
    case 'maintain': out(await o.maintain({ force: !!flags.force })); break;
    case 'recall-check': out(await o.proactiveRecall(pos.join(' '), { minScore: flags.minScore != null ? Number(flags.minScore) : undefined, maxTokens: flags.maxTokens != null ? Number(flags.maxTokens) : undefined, scopes: flags.scopes?.split(','), force: !!flags.force })); break;
    case 'work': out(await o.recordWork({ kind: flags.kind || pos[0], task: flags.task, content: pos.slice(flags.kind ? 0 : 1).join(' ') || undefined, outcome: flags.outcome, status: flags.status, source: flags.source, artifact: flags.artifact, profile: flags.profile, related: flags.related, scope: flags.scope })); break;
    case 'tasks': out(o.openTasks()); break;
    case 'close-tasks': out(o.closeTasks({ tasks: flags.task ? [flags.task] : pos, match: typeof flags.match === 'string' ? flags.match : null, opaque: !!flags.opaque, olderThanDays: flags.olderThanDays != null ? Number(flags.olderThanDays) : null, dryRun: !!flags.dryRun })); break;
    case 'forget-entries': out(await o.forgetEntries({ ids: pos, match: typeof flags.match === 'string' ? flags.match : null, opaque: !!flags.opaque, scope: typeof flags.scope === 'string' ? flags.scope : null, types: typeof flags.types === 'string' ? flags.types.split(',') : [], olderThanDays: flags.olderThanDays != null ? Number(flags.olderThanDays) : null, dryRun: !!flags.dryRun })); break;
    case 'claims': out(flags.all ? o.searchClaims(pos.join(' '), { limit: Number(flags.limit) || 50 }) : o.currentClaims(pos.join(' '), { limit: Number(flags.limit) || 50 })); break;
    case 'contradictions': out(o.claimContradictions({ minShared: flags.minShared != null ? Number(flags.minShared) : 3 })); break;
    case 'merge-concepts': out(await o.mergeConcepts(pos[0], pos[1], { type: flags.type || 'concept' })); break;
    case 'refresh-concepts': out(await o.refreshConcepts({ maxEmbedPerPass: flags.max != null ? Number(flags.max) : undefined })); break;
    case 'packs': out(o.listPacks()); break;
    case 'prospective': {
      const sub = pos[0];
      if (sub === 'add') out(await o.recordProspective({ intent: flags.intent || pos.slice(1).join(' '), trigger: { type: flags.on ? 'date' : 'event', value: flags.on || flags.event }, context: flags.context, scope: flags.scope }));
      else if (sub === 'due') out(o.dueProspective({ now: flags.now || undefined, event: typeof flags.event === 'string' ? flags.event : null }));
      else if (sub === 'complete' || sub === 'cancel') out(o.resolveProspective(pos[1], sub === 'complete' ? 'completed' : 'cancelled'));
      else out('Usage: prospective <add --intent "…" (--on <ISO date> | --event <name>) [--context …] | due [--now <ISO>] [--event <name>] | complete <id> | cancel <id>>');
      break;
    }
    case 'pattern': out(await o.recordPattern({ type: flags.type || pos[0], title: flags.title || pos.slice(flags.type ? 0 : 1).join(' '), context: flags.context, problem: flags.problem, solution: flags.solution, outcome: flags.outcome, evidence: typeof flags.evidence === 'string' ? flags.evidence.split(';').filter(Boolean) : [], scope: flags.scope })); break;
    default:
      out('Usage: ocmw <init|ingest <path>|remember <text>|query <text>|recall <id>|recall-check <message>|work --kind <type>|tasks|close-tasks [labels…]|brief|lint|project|promote <id> <tier>|maintain|bridge|handoff <task>> [--kind task_attempt|source_used|dead_end|correction|artifact|decision --task --outcome --status --source --artifact --related --type --title --tier --tiers --scope --scopes --limit --minScore --maxTokens --graph --curated --force --profile local|frontier]\n  close-tasks selectors (at least one required): [labels…] | --task <label> | --match <regex> | --opaque | --olderThanDays <n>; preview with --dryRun');
  }
} catch (e) { console.error('ERROR:', e.message); process.exitCode = 1; }
finally { o.close(); }
