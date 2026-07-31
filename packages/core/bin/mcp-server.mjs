#!/usr/bin/env node
/**
 * MCP memory server — stdio JSON-RPC 2.0, dependency-free (no @modelcontextprotocol/sdk).
 * Exposes the preserved tool contract over the rebuilt core. Logs to stderr only.
 */
import { Orchestrator } from '../src/index.mjs';

const o = new Orchestrator();
const S = (props, required = []) => ({ type: 'object', properties: props, required });

const TOOLS = {
  ingest: {
    description: 'Compile a source file into the knowledge store (extract → tier-store → embed → graph → verify). Path must be under allowed source roots; wisdom-tier requires curated:true.',
    schema: S({ path: { type: 'string' }, type: { type: 'string' }, title: { type: 'string' }, scope: { type: 'string' }, curated: { type: 'boolean' } }, ['path']),
    run: (a) => o.ingest({ path: a.path, type: a.type || 'note', title: a.title, scope: a.scope, curated: !!a.curated }),
  },
  query: {
    description: 'Hybrid (lexical+vector) search of the knowledge store with provenance. Defaults to this agent\'s scope + shared; pass scopes to override.',
    schema: S({ query: { type: 'string' }, tiers: { type: 'array', items: { type: 'string' } }, scopes: { type: 'array', items: { type: 'string' } }, limit: { type: 'number' }, maxTokens: { type: 'number' }, includeGraphContext: { type: 'boolean' } }, ['query']),
    run: (a) => o.query(a.query, { tiers: a.tiers, scopes: a.scopes, limit: a.limit ?? 20, maxTokens: a.maxTokens, includeGraphContext: !!a.includeGraphContext }),
  },
  feedback: {
    description: 'Mark a recalled memory entry helpful (or not) — adjusts its trust score over time.',
    schema: S({ entryId: { type: 'string' }, helpful: { type: 'boolean' } }, ['entryId']),
    run: (a) => o.feedback(a.entryId, a.helpful !== false),
  },
  handoff_brief: {
    description: 'Build a memory brief to inject into an agent hand-off (e.g. before spawning Hermes over ACP, which does not share context). Returns {brief} to prepend to the task string. profile: "local" (tight, authoritative, push-only — for small/local models) or "frontier" (richer, provenance+ids, push+pull — for cloud models).',
    schema: S({ task: { type: 'string' }, profile: { type: 'string' }, scopes: { type: 'array', items: { type: 'string' } }, tiers: { type: 'array', items: { type: 'string' } } }, ['task']),
    run: (a) => o.handoffBrief({ task: a.task, profile: a.profile || 'local', scopes: a.scopes, tiers: a.tiers }),
  },
  remember: {
    description: 'Store a memory entry (tier default: memory; wisdom requires curated:true). scope defaults to this agent; pass "shared" to publish to the commons.',
    schema: S({ content: { type: 'string' }, type: { type: 'string' }, tier: { type: 'string' }, scope: { type: 'string' }, curated: { type: 'boolean' } }, ['content']),
    run: (a) => o.storeMemory({ content: a.content, type: a.type || 'insight', tier: a.tier || 'memory', scope: a.scope, curated: !!a.curated }),
  },
  recall: { description: 'Retrieve a memory entry by id.', schema: S({ entryId: { type: 'string' } }, ['entryId']), run: (a) => o.recall(a.entryId) },
  brief: { description: 'Summary of knowledge state across tiers.', schema: S({}), run: () => o.brief() },
  audit: { description: 'Health check: contradictions, orphans, counts.', schema: S({}), run: () => o.lint() },
  forget: { description: 'Remove a memory entry (soft by default; hard requires force:true).', schema: S({ entryId: { type: 'string' }, soft: { type: 'boolean' }, force: { type: 'boolean' } }, ['entryId']), run: (a) => o.forget(a.entryId, { soft: a.soft !== false, force: !!a.force }) },
  archive: { description: 'Archive entries older than N days.', schema: S({ olderThanDays: { type: 'number' }, tiers: { type: 'array', items: { type: 'string' } } }), run: (a) => o.archive({ olderThanMs: (a.olderThanDays ?? 30) * 864e5, tiers: a.tiers }) },
  promote: { description: 'Promote an entry to another tier (wisdom requires curated:true).', schema: S({ entryId: { type: 'string' }, toTier: { type: 'string' }, curated: { type: 'boolean' } }, ['entryId', 'toTier']), run: (a) => o.promote(a.entryId, a.toTier, { curated: !!a.curated }) },
  project: { description: 'Project state.db to the Obsidian vault.', schema: S({}), run: () => o.project() },
  maintain: { description: 'Run the lifecycle pass now (decay sweep + usage-earned promotion + vault reprojection). Normally automatic — runs opportunistically on query/ingest/remember and via the daily timer; force:true bypasses the hourly throttle.', schema: S({ force: { type: 'boolean' } }), run: (a) => o.maintain({ force: !!a.force }) },
  proactive_recall: { description: 'Trigger-less pre-turn recall: run the budgeted hybrid search on a raw user message and return {inject} ONLY if results clear the relevance threshold (else inject:null). Call this from a pre-turn hook to surface stored knowledge without the model spending a tool-call cycle. Records retrieval only for surfaced items.', schema: S({ message: { type: 'string' }, minScore: { type: 'number' }, maxTokens: { type: 'number' }, scopes: { type: 'array', items: { type: 'string' } } }, ['message']), run: (a) => o.proactiveRecall(a.message, { minScore: a.minScore, maxTokens: a.maxTokens, scopes: a.scopes }) },
  record_work: { description: 'Record a work-memory event (Brain-style "memory about work"): kind = task_attempt|source_used|dead_end|correction|artifact|decision. Call at task boundaries to track ongoing requests, what worked/failed, corrections, and produced artifacts. Stored as a provenance-linked, categorized entry + typed graph edges; recallable by both stacks.', schema: S({ kind: { type: 'string' }, task: { type: 'string' }, content: { type: 'string' }, outcome: { type: 'string' }, status: { type: 'string' }, source: { type: 'string' }, artifact: { type: 'string' }, profile: { type: 'string' }, related: { type: 'string' }, scope: { type: 'string' } }, ['kind']), run: (a) => o.recordWork(a) },
  list_tasks: { description: 'List ongoing requests — work-memory task nodes not yet marked done (status != done).', schema: S({}), run: () => o.openTasks() },
  close_tasks: { description: 'Bulk-close open task nodes (status → done). Task nodes are never deleted by design — closing is how you clear the ongoing-requests list, and entries/edges are preserved. AT LEAST ONE selector is required (they are OR-ed) so a bare call cannot clear the board: tasks (exact labels), match (regex), opaque (bare session UUIDs / timestamped file ids / hex digests that are not real requests), olderThanDays. Preview with dryRun:true before running for real.', schema: S({ tasks: { type: 'array', items: { type: 'string' } }, match: { type: 'string' }, opaque: { type: 'boolean' }, olderThanDays: { type: 'number' }, dryRun: { type: 'boolean' } }), run: (a) => o.closeTasks({ tasks: a.tasks, match: a.match, opaque: !!a.opaque, olderThanDays: a.olderThanDays, dryRun: !!a.dryRun }) },
  claims: { description: 'Search atomic claims. mode "current" (default) returns only the freshest non-superseded/contradicted claim(s) — use to get the right CURRENT fact after updates; mode "all" searches every status.', schema: S({ query: { type: 'string' }, mode: { type: 'string' }, limit: { type: 'number' } }, ['query']), run: (a) => (a.mode === 'all' ? o.searchClaims(a.query, { limit: a.limit ?? 50 }) : o.currentClaims(a.query, { limit: a.limit ?? 50 })) },
  claim_supersede: { description: 'Supersede an old claim with an updated one (knowledge-point update): old → status superseded + cross-linked; new records what it supersedes.', schema: S({ oldId: { type: 'string' }, content: { type: 'string' }, type: { type: 'string' } }, ['oldId', 'content']), run: (a) => o.supersedeClaim(a.oldId, { content: a.content, type: a.type }) },
  claim_contradictions: { description: 'Deterministic contradiction candidates among live claims (pairs sharing tokens but exactly one negated). Review candidates; does not auto-mutate.', schema: S({ minShared: { type: 'number' } }), run: (a) => o.claimContradictions({ minShared: a.minShared ?? 3 }) },
  refresh_concepts: { description: 'P5: (re)build the concept graph — embed concept nodes (bounded) + recompute communities. Normally runs in the daily/forced maintenance pass; call to refresh on demand.', schema: S({ maxEmbedPerPass: { type: 'number' } }), run: (a) => o.refreshConcepts({ maxEmbedPerPass: a.maxEmbedPerPass }) },
  concept_merge: { description: 'Curated concept merge: fold near-duplicate concept fromLabel into toLabel (e.g. "AI inference costs" into "inference costs"). The variant label is kept as an alias so retrieval treats them as one concept. Use audit\'s dupeConcepts list for candidates; trivial case/plural variants dedupe automatically.', schema: S({ fromLabel: { type: 'string' }, toLabel: { type: 'string' }, type: { type: 'string' } }, ['fromLabel', 'toLabel']), run: (a) => o.mergeConcepts(a.fromLabel, a.toLabel, { type: a.type || 'concept' }) },
};

function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
function err(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n'); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') return reply(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'openclaw-mcp-memory', version: '0.2.0' } });
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') return reply(id, { tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.schema })) });
  if (method === 'tools/call') {
    const t = TOOLS[params?.name];
    if (!t) return err(id, -32602, `unknown tool: ${params?.name}`);
    try { const r = await t.run(params.arguments || {}); return reply(id, { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }); }
    catch (e) { return reply(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }); }
  }
  if (id !== undefined) err(id, -32601, `method not found: ${method}`);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    try { await handle(JSON.parse(line)); } catch { /* ignore malformed */ }
  }
});
process.stdin.on('end', () => o.close());
process.on('SIGINT', () => { o.close(); process.exit(0); });
console.error('openclaw-mcp-memory (rebuilt core) ready on stdio');
