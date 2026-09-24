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
// Project axis (#18): --project <slug> tags writes / filters reads (project + global);
// --projects a,b filters reads on several; --all-projects lifts the env default on reads.
const wproj = () => (typeof flags.project === 'string' ? { project: flags.project } : {});
const rproj = () => (flags['all-projects'] ? { projects: null } : typeof flags.projects === 'string' ? { projects: flags.projects.split(',') } : wproj());
// Source provenance (#46): --source-uri … --language map onto ingest's `source` object (string flags only).
const SOURCE_FLAGS = { 'source-uri': 'sourceUri', 'canonical-uri': 'canonicalUri', library: 'libraryId', 'doc-id': 'docId', 'capture-method': 'captureMethod', 'captured-at': 'capturedAt', site: 'site', author: 'author', 'published-at': 'publishedAt', language: 'language' };
const srcFlags = () => { const src = {}; for (const [f, k] of Object.entries(SOURCE_FLAGS)) if (typeof flags[f] === 'string') src[k] = flags[f]; return Object.keys(src).length ? { source: src } : {}; };
// Metadata filters (#48): the same source flags (+ date bounds) narrow reads via `filters`; --types a,b → `types`.
const FILTER_FLAGS = { site: 'site', author: 'author', library: 'libraryId', 'doc-id': 'docId', 'capture-method': 'captureMethod', 'source-uri': 'sourceUri', 'canonical-uri': 'canonicalUri', language: 'language', 'published-after': 'publishedAfter', 'published-before': 'publishedBefore', 'captured-after': 'capturedAfter', 'captured-before': 'capturedBefore' };
const readFilters = () => {
  const f = {}; for (const [fl, k] of Object.entries(FILTER_FLAGS)) if (typeof flags[fl] === 'string') f[k] = flags[fl];
  return { ...(Object.keys(f).length ? { filters: f } : {}), ...(typeof flags.types === 'string' ? { types: flags.types.split(',') } : {}) };
};
// Library lane (#49): --libraries a,b asks only those libraries; --no-libraries skips the lane.
const rlib = () => (flags['no-libraries'] ? { libraries: false } : typeof flags.libraries === 'string' ? { libraries: flags.libraries.split(',') } : {});
const readStdin = async () => { let t = ''; process.stdin.setEncoding('utf8'); for await (const c of process.stdin) t += c; return t; };

const o = new Orchestrator();
try {
  switch (cmd) {
    case 'init': out({ db: o.cfg.dbPath, vault: o.cfg.vaultPath, tiers: o.memory.tierNames }); break;
    case 'ingest': out(await o.ingest({ path: pos[0], type: flags.type || 'note', title: flags.title, scope: flags.scope, curated: !!flags.curated, authority: typeof flags.authority === 'string' ? flags.authority : undefined, ...srcFlags(), ...wproj() })); break;
    case 'ingest-content': out(await o.ingestContent({ content: flags.stdin ? await readStdin() : pos.join(' '), type: typeof flags.type === 'string' ? flags.type : 'note', title: typeof flags.title === 'string' ? flags.title : undefined, scope: typeof flags.scope === 'string' ? flags.scope : undefined, authority: typeof flags.authority === 'string' ? flags.authority : 'web', curated: !!flags.curated, ...srcFlags(), ...wproj() })); break;
    case 'remember': out(await o.storeMemory({ content: pos.join(' '), tier: flags.tier || 'memory', type: flags.type || 'insight', scope: flags.scope, curated: !!flags.curated, memFunction: typeof flags.function === 'string' ? flags.function : null, authority: typeof flags.authority === 'string' ? flags.authority : undefined, ...wproj() })); break;
    case 'query': out(await o.query(pos.join(' '), { tiers: flags.tiers?.split(','), scopes: flags.scopes?.split(','), functions: typeof flags.functions === 'string' ? flags.functions.split(',') : undefined, limit: Number(flags.limit) || 20, includeGraphContext: !!flags.graph, minAuthority: typeof flags.minAuthority === 'string' ? flags.minAuthority : undefined, deep: !!flags.deep, historical: !!flags.historical, statuses: typeof flags.statuses === 'string' ? flags.statuses.split(',') : undefined, asOf: typeof flags.asOf === 'string' ? flags.asOf : undefined, bounded: !!flags.bounded, includeWorking: !!flags.includeWorking, ...readFilters(), ...rlib(), ...rproj() })); break;
    case 'bridge': { const { bridgeMemory } = await import('../src/bridge.mjs'); out(await bridgeMemory(o)); break; }
    case 'handoff': out(await o.handoffBrief({ task: pos.join(' '), profile: flags.profile || 'local', scopes: flags.scopes?.split(','), tiers: flags.tiers?.split(','), ...readFilters(), ...rlib(), ...rproj() })); break;
    case 'recall': out(o.recall(pos[0])); break;
    case 'brief': out(await o.brief()); break;
    case 'lint': out(o.lint()); break;
    case 'project': out(o.project({ force: !!flags.force })); break;
    case 'promote': out(await o.promote(pos[0], pos[1], { curated: !!flags.curated })); break;
    case 'maintain': out(await o.maintain({ force: !!flags.force })); break;
    case 'recall-check': out(await o.proactiveRecall(pos.join(' '), { minScore: flags.minScore != null ? Number(flags.minScore) : undefined, maxTokens: flags.maxTokens != null ? Number(flags.maxTokens) : undefined, scopes: flags.scopes?.split(','), force: !!flags.force, ...readFilters(), ...rlib(), ...rproj() })); break;
    case 'work': out(await o.recordWork({ kind: flags.kind || pos[0], task: flags.task, content: pos.slice(flags.kind ? 0 : 1).join(' ') || undefined, outcome: flags.outcome, status: flags.status, source: flags.source, artifact: flags.artifact, profile: flags.profile, related: flags.related, scope: flags.scope, ...wproj() })); break;
    case 'tasks': out(o.openTasks()); break;
    case 'close-tasks': out(o.closeTasks({ tasks: flags.task ? [flags.task] : pos, match: typeof flags.match === 'string' ? flags.match : null, opaque: !!flags.opaque, olderThanDays: flags.olderThanDays != null ? Number(flags.olderThanDays) : null, dryRun: !!flags.dryRun })); break;
    case 'forget-entries': out(await o.forgetEntries({ ids: pos, match: typeof flags.match === 'string' ? flags.match : null, opaque: !!flags.opaque, scope: typeof flags.scope === 'string' ? flags.scope : null, project: typeof flags.project === 'string' ? flags.project : null, types: typeof flags.types === 'string' ? flags.types.split(',') : [], olderThanDays: flags.olderThanDays != null ? Number(flags.olderThanDays) : null, dryRun: !!flags.dryRun })); break;
    case 'forget-nodes': out(await o.forgetNodes({ ids: pos, match: typeof flags.match === 'string' ? flags.match : null, opaque: !!flags.opaque, types: typeof flags.types === 'string' ? flags.types.split(',') : [], dryRun: !!flags.dryRun })); break;
    case 'claims': out(flags.all ? o.searchClaims(pos.join(' '), { limit: Number(flags.limit) || 50 }) : o.currentClaims(pos.join(' '), { limit: Number(flags.limit) || 50 })); break;
    case 'contradictions': out(o.claimContradictions({ minShared: flags.minShared != null ? Number(flags.minShared) : 3 })); break;
    case 'claims-deferred': out(o.deferredClaims()); break;
    case 'claim-defer': out(await o.deferClaim(pos[0], typeof flags.reason === 'string' ? flags.reason : 'manual')); break;
    case 'claim-resolve': out(await o.resolveDeferredClaim(pos[0], flags.reject ? 'reject' : 'accept')); break;
    case 'stale-clear': out(await o.clearStaleFlags({ ids: pos })); break;
    case 'claim-validity': out(o.claimValidity(pos[0])); break;
    case 'query-probes': out(await o.probeExpectedQueries({ sampleSize: flags.sample != null ? Number(flags.sample) : undefined, topK: flags.topK != null ? Number(flags.topK) : undefined })); break;
    case 'consistency': out(o.checkConsistency({ minShared: flags.minShared != null ? Number(flags.minShared) : undefined, deferAgeDays: flags.deferAgeDays != null ? Number(flags.deferAgeDays) : undefined })); break;
    case 'merge-concepts': out(await o.mergeConcepts(pos[0], pos[1], { type: flags.type || 'concept' })); break;
    case 'refresh-concepts': out(await o.refreshConcepts({ maxEmbedPerPass: flags.max != null ? Number(flags.max) : undefined })); break;
    case 'packs': out(o.listPacks()); break;
    case 'libraries': out(o.listLibraries()); break;
    case 'library-get': out(await o.libraryGet(pos[0], pos[1], JSON.parse(flags.locator))); break;
    case 'export': out(o.exportKnowledge()); break;
    case 'rescope':
    case 'lower-authority': {
      const sel = { to: flags.to, ids: pos, pathPrefix: typeof flags.pathPrefix === 'string' ? flags.pathPrefix : null, match: typeof flags.match === 'string' ? flags.match : null, fromScopes: typeof flags.from === 'string' ? flags.from.split(',') : null, statuses: typeof flags.statuses === 'string' ? flags.statuses.split(',') : null, dryRun: !!flags.dryRun };
      out(cmd === 'rescope' ? await o.rescope(sel) : await o.lowerAuthority({ ...sel, reason: typeof flags.reason === 'string' ? flags.reason : null }));
      break;
    }
    case 'reembed': out(await o.reembedFallback({ limit: Number(flags.limit) || 200, since: typeof flags.since === 'string' ? flags.since : null, dryRun: !!flags.dryRun })); break;
    case 'prospective': {
      const sub = pos[0];
      if (sub === 'add') out(await o.recordProspective({ intent: flags.intent || pos.slice(1).join(' '), trigger: { type: flags.on ? 'date' : 'event', value: flags.on || flags.event }, context: flags.context, scope: flags.scope, ...wproj() }));
      else if (sub === 'due') out(o.dueProspective({ now: flags.now || undefined, event: typeof flags.event === 'string' ? flags.event : null }));
      else if (sub === 'complete' || sub === 'cancel') out(o.resolveProspective(pos[1], sub === 'complete' ? 'completed' : 'cancelled'));
      else out('Usage: prospective <add --intent "…" (--on <ISO date> | --event <name>) [--context …] | due [--now <ISO>] [--event <name>] | complete <id> | cancel <id>>');
      break;
    }
    case 'pattern': out(await o.recordPattern({ type: flags.type || pos[0], title: flags.title || pos.slice(flags.type ? 0 : 1).join(' '), context: flags.context, problem: flags.problem, solution: flags.solution, outcome: flags.outcome, evidence: typeof flags.evidence === 'string' ? flags.evidence.split(';').filter(Boolean) : [], scope: flags.scope, ...wproj() })); break;
    default:
      out('Usage: ocmw <init|ingest <path>|ingest-content <text>|remember <text>|query <text>|recall <id>|recall-check <message>|work --kind <type>|tasks|close-tasks [labels…]|brief|lint|project|promote <id> <tier>|maintain|bridge|reembed [--since <ISO> --limit <n> --dryRun]|rescope --to <scope>|lower-authority --to <authority>|handoff <task>> [--kind task_attempt|source_used|dead_end|correction|artifact|decision --task --outcome --status --source --artifact --related --type --title --tier --tiers --scope --scopes --limit --minScore --maxTokens --graph --curated --force --profile local|frontier --project <slug> --projects a,b --all-projects]\n  project axis: --project tags writes (default MIDMEM_PROJECT) and filters reads to project + global; --projects a,b filters on several; --all-projects lifts the default\n  rescope / lower-authority selectors (at least one required): [entry ids…] | --pathPrefix <source dir> | --match <content regex>; --from a,b and --statuses a,b narrow; --reason (lower-authority); preview with --dryRun\n  query history/policy: --historical (active + archived, labelled) | --statuses a,b | --asOf <ISO> | --bounded (occupancy policy without a token budget) | --includeWorking\n  close-tasks selectors (at least one required): [labels…] | --task <label> | --match <regex> | --opaque | --olderThanDays <n>; preview with --dryRun\n  forget-nodes (HARD delete, edges cascade) selectors: [node ids…] | --match <label regex> | --opaque; --types narrows; preview with --dryRun\n  ingest source provenance: --source-uri --canonical-uri --library --doc-id --capture-method --captured-at --site --author --published-at --language\n  query / handoff / recall-check metadata filters (AND): --site --author --library --doc-id --capture-method --source-uri --canonical-uri --language --published-after --published-before --captured-after --captured-before <ISO> | --types a,b\n  library lane (#49): libraries (list registered, MIDMEM_LIBRARIES) | library-get <libraryId> <docId> --locator <JSON {docId,version,charStart,charEnd}>; query / handoff / recall-check take --libraries a,b (ask only those) | --no-libraries (skip the lane)\n  ingest-content <text> | --stdin: same source flags (one of --canonical-uri/--source-uri/--doc-id required) + --type --title --scope --authority (default web) --curated');
  }
} catch (e) { console.error('ERROR:', e.message); process.exitCode = 1; }
finally { o.close(); }
