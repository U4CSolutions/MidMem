/**
 * Work-memory — Perplexity-Brain-style "memory about work, not just the user".
 *
 * Records what agents DID — task attempts, sources used, dead ends, corrections,
 * artifacts, decisions — as first-class, provenance-linked entries + typed graph
 * edges, and deterministically CATEGORIZES every ingest so the LLM Wiki tracks
 * ongoing requests by kind. No LLM in this path (DELEGATE-52 discipline: the
 * categorizer is deterministic; grounding still gates any extracted content upstream).
 *
 * Pure core: zero stack-specific code, so it works identically standalone, as an
 * OpenClaw add-on, as a Hermes add-on, or bridged across both (one shared state.db).
 */
import { nowISO } from './util.mjs';

/**
 * First-class work-event kinds.
 *  tier  — where the event lands (corrections/decisions/dead-ends are durable `memory`;
 *          raw attempts/sources/artifacts are cheap `fact` and decay unless they prove useful).
 *  edge  — the task→X graph relation recorded for the event.
 */
export const WORK_EVENT_TYPES = {
  task_attempt: { tier: 'fact',   edge: 'attempted' },
  source_used:  { tier: 'fact',   edge: 'used_source' },
  dead_end:     { tier: 'memory', edge: 'avoided' },       // a warning worth keeping for next time
  correction:   { tier: 'memory', edge: 'corrected_by' },  // highest-value: reshapes future behavior
  artifact:     { tier: 'fact',   edge: 'produced' },
  decision:     { tier: 'memory', edge: 'decided' },
};
export const WORK_EVENT_NAMES = Object.keys(WORK_EVENT_TYPES);

/**
 * Function axis (survey arXiv 2607.25380): memory typed along independent axes — the
 * persistence tier says how long it lives, mem_function says what ROLE it plays.
 * Deterministic default per entry type; explicit memFunction on store always wins.
 *  - episodic: what happened (sessions, attempts, sources touched, artifacts, dead ends)
 *  - procedural: how to act (corrections reshape behavior; patterns/recipes when packs land)
 *  - semantic: what is known (ingested knowledge, insights, decisions' rationale)
 *  - prospective: what must become actionable later (roadmap #6)
 *  - working: context-assembly-time only — valid but not persisted by default
 */
export const MEMORY_FUNCTIONS = ['working', 'episodic', 'semantic', 'procedural', 'prospective'];
const FUNCTION_OF_TYPE = {
  task_attempt: 'episodic', source_used: 'episodic', artifact: 'episodic', dead_end: 'episodic',
  session: 'episodic',
  correction: 'procedural', pattern: 'procedural', scaffold: 'procedural', recipe: 'procedural', 'anti-pattern': 'procedural',
  decision: 'semantic', insight: 'semantic', note: 'semantic', research: 'semantic', report: 'semantic',
  prospective: 'prospective',
};
export function functionForType(type) { return FUNCTION_OF_TYPE[type] || 'semantic'; }

/** Categories every ingest is tagged with (provenance.category) — lets the store track
 *  ongoing requests by kind without an LLM. Order matters: first match wins. */
const CATEGORY_RULES = [
  ['correction', /\b(correct(ion|ed)?|mistake|wrong|retract|misremember|actually it)\b/i],
  ['incident',   /\b(outage|broke|failed|crash|lost access|unresponsive|regression|\b40\d\b|\b50\d\b)/i],
  ['build',      /\b(build|implement|scaffold|refactor|deploy|wrote a|created (a|the)|added (a|the)|patch|pull request|\bPR\b)/i],
  ['research',   /\b(research|analy[sz]e|compare|investigat|survey|arxiv|paper|synthesi[sz])/i],
  ['decision',   /\b(decid|chose|opted for|recommend|trade-?off|we will|going with)\b/i],
  ['config',     /\b(config|setting|env var|flag|enable|disable|gateway|systemd|plugin|webhook)\b/i],
  ['reference',  /\b(https?:\/\/|documentation|reference doc|api docs)\b/i],
];

/**
 * Opaque machine identifiers that are NOT task names — bare session UUIDs, timestamped
 * file IDs, bare hex digests. The hook seam records whatever the calling stack hands it
 * as `--task`; when that is a session handle rather than a request, a task node is minted
 * that nobody can act on and that sits in `listOpenTasks` forever (2026-07-31: 341 of 384
 * open tasks were exactly these). Deterministic, no LLM, anchored so a real title that
 * merely CONTAINS an id is untouched.
 */
const OPAQUE_TASK_PATTERNS = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // bare UUID
  /^\d{8}[_-]\d{6}(?:[_-][0-9a-f]{4,})?$/,                           // 20260710_033427_3d468f
  /^[0-9a-f]{16,}$/i,                                                // bare hex digest
];

/** True when a task label is a machine identifier rather than a human request. */
export function isOpaqueTaskLabel(label = '') {
  const s = String(label).trim();
  return !!s && OPAQUE_TASK_PATTERNS.some((re) => re.test(s));
}

/** Deterministic ingest categorizer (no LLM). Returns a single category string.
 *  `extraRules` (capture packs) are checked FIRST — domain rules outrank the generic set,
 *  first match still wins, so pack order stays deterministic. */
export function categorizeIngest({ type, content = '', title = '' } = {}, extraRules = []) {
  if (WORK_EVENT_NAMES.includes(type)) return type;       // a work event is its own category
  if (type === 'session') return 'session';
  const hay = `${title}\n${content}`.slice(0, 2000);
  for (const [cat, re] of extraRules) if (re.test(hay)) return cat;
  for (const [cat, re] of CATEGORY_RULES) if (re.test(hay)) return cat;
  return 'knowledge';
}

/**
 * Record one work event as a provenance-linked entry (+ typed graph edges).
 * @param {import('./orchestrator.mjs').Orchestrator} o
 * @param {{kind:string, task?:string, content?:string, outcome?:string, status?:string,
 *          source?:string, artifact?:string, profile?:string, related?:string,
 *          concepts?:Array<{name:string,type?:string}>, scope?:string}} ev
 */
export async function recordWorkEvent(o, ev = {}) {
  const spec = WORK_EVENT_TYPES[ev.kind];
  if (!spec) throw new Error(`unknown work-event kind: ${ev.kind} (expected: ${WORK_EVENT_NAMES.join(', ')})`);
  const scope = ev.scope || o.cfg.agentScope;
  const status = ev.status || (ev.kind === 'task_attempt' ? 'open' : 'done');
  const task = (ev.task || '').trim();

  const parts = [task ? `[${ev.kind}] ${task}` : `[${ev.kind}]`];
  if (ev.content) parts.push(ev.content);
  if (ev.outcome) parts.push(`Outcome: ${ev.outcome}`);
  if (ev.source) parts.push(`Source: ${ev.source}`);
  if (ev.artifact) parts.push(`Artifact: ${ev.artifact}`);
  const content = parts.join(' — ');

  // Stored through the governed storeMemory path: it embeds + logs + maintains like any entry.
  const res = await o.storeMemory({ content, type: ev.kind, tier: spec.tier, scope, concepts: ev.concepts });
  // Tag provenance with the category + structured work fields (storeMemory leaves provenance null
  // when no source; we write the full object — no reliance on SQLite JSON1).
  const prov = {
    category: ev.kind, recordedAt: nowISO(), chain: [{ step: 'record_work', kind: ev.kind }],
    work: { kind: ev.kind, task, status, outcome: ev.outcome ?? null, source: ev.source ?? null, artifact: ev.artifact ?? null, profile: ev.profile ?? null, related: ev.related ?? null },
  };
  o.db.prepare('UPDATE entries SET provenance=?, updated_at=? WHERE id=?').run(JSON.stringify(prov), nowISO(), res.id);

  // Graph: a stable task node (status tracked here) + typed edges to source/artifact/concepts.
  // An opaque identifier is recorded as an entry but never becomes a task node — the event
  // keeps its provenance, the ongoing-requests list stays answerable.
  const opaque = !!task && o.cfg.workMemory?.guardOpaqueTaskLabels !== false && isOpaqueTaskLabel(task);
  if (opaque) o.db.logOp('work-task-label-skipped', { task: task.slice(0, 80), kind: ev.kind, reason: 'opaque-identifier' });
  if (task && !opaque) {
    // Only a task_attempt sets the task's status; other events (correction, source_used, …) link to
    // the task but must NOT flip its open/done state — preserve the existing status (default 'open').
    const existing = o.graph.byType('task').find((n) => n.label === task);
    const taskStatus = ev.kind === 'task_attempt' ? status : (existing?.properties?.status || 'open');
    const taskNode = o.graph.upsertNode({ type: 'task', label: task, source: 'work', properties: { status: taskStatus } });
    if (ev.source)   o.graph.upsertEdge({ from: taskNode, to: o.graph.upsertNode({ type: 'source',   label: ev.source,   source: 'work' }), type: spec.edge,   source: 'work' });
    if (ev.artifact) o.graph.upsertEdge({ from: taskNode, to: o.graph.upsertNode({ type: 'artifact', label: ev.artifact, source: 'work' }), type: 'produced', source: 'work' });
    for (const c of ev.concepts || []) o.graph.upsertEdge({ from: taskNode, to: o.graph.upsertNode({ type: c.type || 'concept', label: c.name, source: 'work' }), type: 'about', source: 'work' });
  }
  o.db.logOp('record-work', { kind: ev.kind, entry: res.id, task: task.slice(0, 80), status, category: ev.kind });
  return { success: true, kind: ev.kind, status, category: ev.kind, taskNodeSkipped: opaque, ...res };
}

/**
 * Bulk-close open task nodes (mark `status: done`). Task nodes are upserted and never
 * deleted by design — `listOpenTasks` filters on status — so "cleanup" means closing,
 * not removing, and nothing is destroyed: the entries and edges stay intact.
 *
 * At least one selector is REQUIRED so a bare call can never close the whole board.
 * Selectors are OR-ed: explicit `tasks`, a `match` regex, `opaque` (the machine-identifier
 * guard above), and `olderThanDays` against the node's updated_at.
 *
 * @param {import('./orchestrator.mjs').Orchestrator} o
 * @param {{tasks?:string[], match?:string, opaque?:boolean, olderThanDays?:number, dryRun?:boolean}} [opts]
 */
export function closeTasks(o, { tasks = [], match = null, opaque = false, olderThanDays = null, dryRun = false } = {}) {
  const wanted = new Set(tasks.map((t) => String(t).trim()).filter(Boolean));
  if (!wanted.size && !match && !opaque && olderThanDays == null) {
    throw new Error('closeTasks requires at least one selector: tasks, match, opaque, or olderThanDays');
  }
  const re = match ? new RegExp(match, 'i') : null;
  const cutoff = olderThanDays == null ? null : Date.now() - olderThanDays * 864e5;

  const selected = o.graph.byType('task')
    .filter((n) => (n.properties?.status || 'open') !== 'done')
    .filter((n) => wanted.has(n.label)
      || (re && re.test(n.label))
      || (opaque && isOpaqueTaskLabel(n.label))
      || (cutoff != null && n.updated_at && Date.parse(n.updated_at) < cutoff));

  if (!dryRun) {
    // upsertNode REPLACES properties — merge so nothing else on the node is dropped.
    for (const n of selected) {
      o.graph.upsertNode({ type: 'task', label: n.label, source: n.source || 'work', properties: { ...(n.properties || {}), status: 'done' } });
    }
    o.db.logOp('close-tasks', { closed: selected.length, opaque, match: match || null, olderThanDays });
  }
  return { matched: selected.length, closed: dryRun ? 0 : selected.length, dryRun, tasks: selected.map((n) => n.label) };
}

/** Ongoing requests = task nodes not yet marked done (latest status wins via upsert). */
export function listOpenTasks(o) {
  return o.graph.byType('task')
    .filter((n) => (n.properties?.status || 'open') !== 'done')
    .map((n) => ({ task: n.label, status: n.properties?.status || 'open', updated_at: n.updated_at }))
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
}

/**
 * Bulk soft-forget entries by selector — the entry-level sibling of `closeTasks` (born the
 * same way: 1,400 junk work-event entries from one misconfigured capture week, and `forget`
 * only takes a single id). Same safety contract: at least one CONTENT selector is required
 * (`ids`, `match` on content, or `opaque` — matching work events whose task label is a bare
 * machine identifier or whose content is captured prompt boilerplate); `scope`/`types` only
 * narrow, they can never select on their own. Soft-only (status='deleted', reversible until
 * retention hard-prunes); `dryRun` previews. Routed through orchestrator.forget so
 * governance, logging and vault-dirty behave exactly like a single forget.
 *
 * @param {import('./orchestrator.mjs').Orchestrator} o
 * @param {{ids?:string[], match?:string, opaque?:boolean, scope?:string, types?:string[],
 *          olderThanDays?:number, dryRun?:boolean}} [opts]
 */
export async function forgetEntries(o, { ids = [], match = null, opaque = false, scope = null, types = [], olderThanDays = null, dryRun = false } = {}) {
  const wanted = new Set(ids.map((s) => String(s).trim()).filter(Boolean));
  if (!wanted.size && !match && !opaque) {
    throw new Error('forgetEntries requires a content selector: ids, match, or opaque (scope/types/olderThanDays only narrow)');
  }
  const re = match ? new RegExp(match, 'i') : null;
  const cutoff = olderThanDays == null ? null : Date.now() - olderThanDays * 864e5;
  const OPAQUE_CONTENT = /^\[(?:task_attempt|source_used|dead_end|correction|artifact|decision)\]\s+(?:\S+\s+—\s+\[IMPORTANT: You are running as|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\d{8}[_-]\d{6})/i;

  const rows = o.db.prepare("SELECT id, scope, type, content, created_at FROM entries WHERE status='active'").all();
  const selected = rows.filter((r) => {
    if (scope && r.scope !== scope) return false;
    if (types.length && !types.includes(r.type)) return false;
    if (cutoff != null && Date.parse(r.created_at) >= cutoff) return false;
    return wanted.has(r.id) || (re && re.test(r.content || '')) || (opaque && OPAQUE_CONTENT.test(r.content || ''));
  });

  let forgotten = 0;
  if (!dryRun) {
    for (const r of selected) { const res = await o.forget(r.id, { soft: true }); if (res.success) forgotten++; }
    o.db.logOp('forget-entries', { forgotten, match: match || null, opaque, scope, types: types.join(',') || null });
  }
  return { matched: selected.length, forgotten, dryRun, sample: selected.slice(0, 5).map((r) => r.id) };
}

/**
 * Bulk hard-delete graph nodes by selector — the node-level sibling of `forgetEntries`,
 * born from the July-2026 flood aftermath: opaque task nodes were removed out-of-band
 * (no sanctioned delete path existed) and left ~2,000 edges dangling. Same safety
 * contract as its siblings: at least one selector is required (`ids`: exact node ids,
 * `match`: regex on label, or `opaque`: machine-identifier labels); `types` only
 * narrows. Edges cascade through graph.deleteNode so a delete can never strand one.
 * HARD delete (nodes carry no status column) — preview with `dryRun` first.
 *
 * @param {import('./orchestrator.mjs').Orchestrator} o
 * @param {{ids?:string[], match?:string, opaque?:boolean, types?:string[], dryRun?:boolean}} [opts]
 */
export function forgetNodes(o, { ids = [], match = null, opaque = false, types = [], dryRun = false } = {}) {
  const wanted = new Set(ids.map((s) => String(s).trim()).filter(Boolean));
  if (!wanted.size && !match && !opaque) {
    throw new Error('forgetNodes requires a selector: ids, match, or opaque (types only narrows)');
  }
  const re = match ? new RegExp(match, 'i') : null;
  const selected = o.graph.allNodes().filter((n) => {
    if (types.length && !types.includes(n.type)) return false;
    return wanted.has(n.id) || (re && re.test(n.label)) || (opaque && isOpaqueTaskLabel(n.label));
  });
  let deleted = 0, edges = 0;
  if (!dryRun) {
    for (const n of selected) { const r = o.graph.deleteNode(n.id); deleted += r.node; edges += r.edges; }
    o.db.logOp('forget-nodes', { deleted, edges, match: match || null, opaque, types: types.join(',') || null });
  }
  return { matched: selected.length, deleted, edges, dryRun, sample: selected.slice(0, 5).map((n) => `${n.type}:${n.label.slice(0, 60)}`) };
}

/**
 * Prospective memory (PM-Bench, arXiv 2607.12385; roadmap #6) — "what must become
 * actionable later" as its own capability class, separated from historical memory.
 *
 * DELIBERATE BOUNDARY: MidMem records intents and their outcomes; it does NOT fire
 * triggers. Execution belongs to the scheduler that owns time (cron) — PM-Bench's
 * 65.1% F1 ceiling for in-model trigger recognition is exactly why the system of
 * record for "when" must stay outside the memory layer. `dueProspective` is a
 * deterministic read surface a scheduler/hook polls; nothing here acts.
 */
export async function recordProspective(o, { intent, trigger = {}, context, scope, expiresWhen = ['completed', 'cancelled'] } = {}) {
  if (!intent) throw new Error('recordProspective requires an intent');
  if (trigger.type === 'date') {
    if (Number.isNaN(Date.parse(trigger.value))) throw new Error(`bad date trigger: ${trigger.value}`);
  } else if (trigger.type === 'event') {
    if (!trigger.value || typeof trigger.value !== 'string') throw new Error('event trigger requires a value');
  } else throw new Error(`unknown trigger type: ${trigger.type} (expected date|event)`);

  const content = `[prospective] ${intent} — trigger: ${trigger.type}=${trigger.value}${context ? ` — ${context}` : ''}`;
  const res = await o.storeMemory({ content, type: 'prospective', tier: 'memory', scope });
  const prov = {
    category: 'prospective', recordedAt: nowISO(),
    prospective: { intent, trigger, status: 'pending', context: context ?? null, expiresWhen },
  };
  // A pending intent must OUTLIVE the tier lease: the memory tier's 30-day TTL would archive
  // a far-future intent before its trigger ever fired, and dueProspective (a raw read, not
  // retrieval) never renews leases — the intent would silently vanish from the due surface.
  // Pending intents are therefore lease-exempt (expires_at NULL); resolution is the exit.
  o.db.prepare('UPDATE entries SET provenance=?, expires_at=NULL, updated_at=? WHERE id=?').run(JSON.stringify(prov), nowISO(), res.id);
  o.db.logOp('prospective-add', { id: res.id, trigger: `${trigger.type}=${String(trigger.value).slice(0, 60)}` });
  return { success: true, ...res, prospective: prov.prospective };
}

/** Pending intents whose trigger has fired: date triggers ≤ `now`, plus event triggers matching
 *  `event` when one is passed. Deterministic — `now` is a parameter, never Date.now() implicitly
 *  hidden from the caller's control. */
export function dueProspective(o, { now = nowISO(), event = null } = {}) {
  const rows = o.db.prepare("SELECT id, provenance, scope, created_at FROM entries WHERE type='prospective' AND status='active'").all();
  const due = [];
  for (const r of rows) {
    let p; try { p = JSON.parse(r.provenance || '{}').prospective; } catch { continue; }
    if (!p || p.status !== 'pending') continue;
    const t = p.trigger || {};
    const fired = (t.type === 'date' && Date.parse(t.value) <= Date.parse(now))
      || (t.type === 'event' && event != null && t.value === event);
    if (fired) due.push({ id: r.id, intent: p.intent, trigger: t, context: p.context, scope: r.scope, created_at: r.created_at });
  }
  return due.sort((a, b) => (a.trigger.value || '').localeCompare(b.trigger.value || ''));
}

/** Close out an intent: completed | cancelled. The entry archives (leaves active recall)
 *  but is preserved as history — outcomes are knowledge too. */
export function resolveProspective(o, id, outcome = 'completed') {
  if (!['completed', 'cancelled'].includes(outcome)) throw new Error(`bad outcome: ${outcome} (completed|cancelled)`);
  const row = o.db.prepare("SELECT provenance FROM entries WHERE id=? AND type='prospective'").get(id);
  if (!row) return { success: false, message: `not a prospective entry: ${id}` };
  let prov; try { prov = JSON.parse(row.provenance || '{}'); } catch { prov = {}; }
  if (!prov.prospective) return { success: false, message: `no prospective record on ${id}` };
  prov.prospective.status = outcome;
  prov.prospective.resolvedAt = nowISO();
  o.db.prepare("UPDATE entries SET provenance=?, status='archived', updated_at=? WHERE id=?").run(JSON.stringify(prov), nowISO(), id);
  o.db.logOp('prospective-resolve', { id, outcome });
  return { success: true, id, outcome };
}

/**
 * Deterministic background capture for `maintain()` — pull each stack's session/memory
 * dirs into the store via the (idempotent, hash-deduped) bridge so agent work is
 * auto-ingested without anyone remembering to run it. Projection is left to maintain's
 * own step. Best-effort: never throws into the maintenance loop.
 */
export async function consolidateWork(o) {
  try {
    const { bridgeMemory } = await import('./bridge.mjs');
    const r = await bridgeMemory(o, { project: false });
    return { bridged: r.ingested, skipped: r.skipped, errors: r.errors.length };
  } catch (e) { return { error: e.message }; }
}
