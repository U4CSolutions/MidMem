/**
 * End-to-end smoke test (offline, no external deps, no live LLM).
 * Exercises: ingest → hybrid retrieval → governance (fail-closed) → verify → projection.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Orchestrator, GovernanceError, checkGrounding, groundingScore, categorizeIngest, isOpaqueTaskLabel, WORK_EVENT_NAMES } from '../src/index.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`  ✓ ${msg}`); } else { fail++; console.log(`  ✗ ${msg}`); } };
async function denies(fn, msg) { try { await fn(); fail++; console.log(`  ✗ ${msg} (expected denial)`); } catch (e) { ok(e instanceof GovernanceError, `${msg} → ${e.message}`); } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocmw-'));
const o = new Orchestrator({
  dbPath: path.join(tmp, 'state.db'),
  vaultPath: path.join(tmp, 'vault'),
  llmEnabled: false,
  sourceRoots: [tmp],
  // Hermetic: don't let maintenance auto-bridge the real ~/.openclaw / ~/.hermes dirs into the test db.
  autoIngest: { enabled: false, onMaintain: false },
});

try {
  console.log('Foundation smoke test\n');

  // 1. Ingest
  const src = path.join(tmp, 'sample.md');
  fs.writeFileSync(src, 'Hybrid retrieval fuses BM25 lexical search with vector cosine similarity. ' +
    'Reciprocal Rank Fusion combines the two ranked lists. Vectors come from a local embedding model.');
  const ing = await o.ingest({ path: src, type: 'note', title: 'Hybrid RAG' });
  ok(ing.success, 'ingest succeeded');
  ok(ing.concepts > 0, `extracted ${ing.concepts} concepts (fallback mode=${ing.mode})`);
  ok(ing.claims > 0, `extracted ${ing.claims} claims`);

  // 2. Governance: path traversal blocked
  await denies(() => o.ingest({ path: '/etc/passwd', type: 'note' }), 'ingest outside source roots blocked');

  // 3. More memories + hybrid query
  await o.storeMemory({ content: 'The fact tier stores raw unprocessed knowledge from sources.', tier: 'fact', type: 'note' });
  await o.storeMemory({ content: 'A sourdough recipe needs flour, water, salt and starter.', tier: 'memory', type: 'note' });
  const q = await o.query('vector cosine fusion retrieval', { limit: 5 });
  ok(q.results.length > 0, `hybrid query returned ${q.results.length} results`);
  ok(/hybrid|vector|fusion|retrieval/i.test(q.results[0].content), `top result is relevant: "${q.results[0].content.slice(0, 50)}…"`);
  ok(q.results[0].rank.fts != null || q.results[0].rank.vector != null, 'top result has lexical and/or vector rank components');

  // 4. Governance: curated-only wisdom tier
  await denies(() => o.storeMemory({ content: 'curated truth', tier: 'wisdom', type: 'note' }), 'uncurated write to wisdom tier blocked');
  const w = await o.storeMemory({ content: 'curated truth', tier: 'wisdom', type: 'note', curated: true });
  ok(w.success, 'curated write to wisdom tier allowed');

  // 5. Governance: hard delete guard
  await denies(() => o.forget(w.id, { soft: false }), 'hard delete without force blocked');
  const soft = await o.forget(w.id, { soft: true });
  ok(soft.success, 'soft delete allowed');

  // 6. Verify + lint
  const lint = o.lint();
  ok(Array.isArray(lint.contradictions), `lint ran (${lint.summary.entries} entries, ${lint.summary.nodes} nodes)`);

  // 7. Projection to vault
  const proj = o.project();
  ok(proj.written > 0, `projected ${proj.written} files to vault`);
  ok(fs.existsSync(path.join(proj.vaultPath, 'index.md')), 'index.md projected');

  // 8. Brief
  const b = await o.brief();
  ok(b.tiers.memory >= 1 && b.tiers.fact >= 1, `brief reports tier counts: ${JSON.stringify(b.tiers)}`);
  ok(b.vectors?.backend === 'sqlite', `vector backend reported via brief: ${b.vectors?.backend}`);

  // 9. Cross-agent scope isolation (#2)
  await o.storeMemory({ content: 'OPENCLAW_ONLY beacon zebra marker', tier: 'memory', scope: 'openclaw' });
  await o.storeMemory({ content: 'HERMES_ONLY beacon zebra marker', tier: 'memory', scope: 'hermes' });
  const ocq = await o.query('beacon zebra marker', { scopes: ['openclaw'], limit: 5 });
  ok(ocq.results.some((r) => /OPENCLAW_ONLY/.test(r.content)) && !ocq.results.some((r) => /HERMES_ONLY/.test(r.content)),
    'scope filter returns openclaw entry, excludes hermes');
  const shq = await o.query('beacon zebra marker', { scopes: ['shared'], limit: 5 });
  ok(!shq.results.some((r) => /OPENCLAW_ONLY|HERMES_ONLY/.test(r.content)), 'shared-scope query excludes both private entries');

  // 10. Native→middleware bridge + hash dedup (#1)
  const srcDir = path.join(tmp, 'bridge-src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'note1.md'), 'Bridged note: retrieval-augmented generation fuses search with generation.');
  const { bridgeMemory } = await import('../src/index.mjs');
  const b1 = await bridgeMemory(o, { sources: [{ dir: srcDir, scope: 'openclaw', type: 'note' }], project: false });
  ok(b1.ingested === 1, `bridge ingested ${b1.ingested} new file`);
  const b2 = await bridgeMemory(o, { sources: [{ dir: srcDir, scope: 'openclaw', type: 'note' }], project: false });
  ok(b2.ingested === 0 && b2.skipped === 1, `bridge re-run is idempotent (dedup): ingested ${b2.ingested}, skipped ${b2.skipped}`);

  // 11. Trust feedback loop (borrow)
  const fb = await o.storeMemory({ content: 'Trust feedback target about kubernetes operators.', tier: 'memory', scope: 'shared' });
  const before = o.recall(fb.id).trust_score;
  o.feedback(fb.id, true);
  ok(o.recall(fb.id).trust_score > before, `feedback raised trust ${before} → ${o.recall(fb.id).trust_score}`);

  // 12. Token-budget retrieval (borrow)
  const tb = await o.query('hybrid vector retrieval', { maxTokens: 80, limit: 10 });
  const totalTok = tb.results.reduce((s, r) => s + Math.ceil(r.content.length / 4), 0);
  ok(totalTok <= 80, `token budget respected (${totalTok} ≤ 80 tok across ${tb.results.length} results)`);

  // 13. Trigram substring lane (borrow) — query a non-token substring
  await o.storeMemory({ content: 'The authentication subsystem uses OAuth2 tokens.', tier: 'memory', scope: 'shared' });
  const tg = await o.query('thenticat', { scopes: ['shared'], limit: 5 });
  ok(tg.results.some((r) => /authentication/i.test(r.content)), 'trigram lane finds substring (non-token) match');

  // 14. Embedding dimension guard (borrow)
  let dimGuard = false;
  try {
    await o.memory.upsertVector('dimtest-1', new Array(1024).fill(0.1), 'real-model-a', 'lmstudio');
    await o.memory.upsertVector('dimtest-2', new Array(768).fill(0.1), 'real-model-b', 'lmstudio');
  } catch (e) { dimGuard = /dim mismatch/i.test(e.message); }
  ok(dimGuard, 'dim guard rejects mixing real-model vector dimensions');

  // 15. Hand-off memory gate (firstware) — local + frontier profiles
  const hbLocal = await o.handoffBrief({ task: 'hybrid retrieval vector fusion', profile: 'local' });
  ok(/AUTHORITATIVE MEMORY/.test(hbLocal.brief) && hbLocal.count >= 1,
    `local hand-off brief: authoritative framing, ${hbLocal.count} items, ~${hbLocal.tokensEstimate} tok`);
  const hbFrontier = await o.handoffBrief({ task: 'hybrid retrieval vector fusion', profile: 'frontier' });
  ok(/Retrieved memory/.test(hbFrontier.brief) && /recall|query/.test(hbFrontier.brief) && /trust/.test(hbFrontier.brief),
    'frontier hand-off brief: provenance/trust + invites pull');
  const hbEmpty = await o.handoffBrief({ task: 'anything', profile: 'local', scopes: ['void_scope'] });
  ok(hbEmpty.count === 0 && /no prior knowledge/i.test(hbEmpty.brief), 'empty hand-off brief degrades cleanly');

  // 16. Archive default spares permanent tiers (wisdom must survive a routine archive)
  const oldWisdom = await o.storeMemory({ content: 'Ancient curated wisdom entry.', tier: 'wisdom', type: 'note', curated: true });
  o.db.prepare("UPDATE entries SET updated_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(oldWisdom.id);
  o.archive({ olderThanMs: 1 * 864e5 });
  ok(o.recall(oldWisdom.id).status === 'active', 'default archive leaves ttl-0 (wisdom) entries active');
  o.archive({ olderThanMs: 1 * 864e5, tiers: ['wisdom'] });
  ok(o.recall(oldWisdom.id).status === 'archived', 'explicit tiers:[wisdom] still archives it');

  // 17. Failed ingest must not poison the dedup hash (sources row commits with the entry)
  const poison = path.join(tmp, 'poison.md');
  fs.writeFileSync(poison, 'Content whose first ingest attempt fails must remain ingestable.');
  const origStore = o.memory.store.bind(o.memory);
  o.memory.store = () => { throw new Error('injected store failure'); };
  let ingestFailed = false;
  try { await o.ingest({ path: poison, type: 'note' }); } catch { ingestFailed = true; }
  o.memory.store = origStore;
  ok(ingestFailed, 'injected ingest failure propagated');
  const retry = await o.ingest({ path: poison, type: 'note' });
  ok(retry.success && !retry.skipped, 'retry after failed ingest stores the content (hash not poisoned)');

  // 18. Promote refreshes expires_at for the destination tier (single-write lifecycle)
  const pr = await o.storeMemory({ content: 'Fact destined for wisdom.', tier: 'fact', type: 'note' });
  ok(o.recall(pr.id).expires_at != null, 'fact entry starts with an expiry');
  await o.promote(pr.id, 'wisdom', { curated: true });
  const promoted = o.recall(pr.id);
  ok(promoted.tier === 'wisdom' && promoted.status === 'active' && promoted.expires_at == null,
    'promotion to wisdom clears expiry and stays active');

  // 19. Supersede-on-reingest: editing a file archives its earlier entries (any tier)
  const evolving = path.join(tmp, 'evolving.md');
  fs.writeFileSync(evolving, 'First revision of an evolving document about pelican migration routes.');
  const rev1 = await o.ingest({ path: evolving, type: 'note' });
  await o.promote(rev1.entry.id, 'wisdom', { curated: true });
  fs.writeFileSync(evolving, 'Second revision of the evolving document — the migration routes shifted north.');
  const rev2 = await o.ingest({ path: evolving, type: 'note' });
  ok(rev2.superseded.length === 1 && rev2.superseded[0] === rev1.entry.id,
    'reingest of a changed file supersedes its prior entry (even after wisdom promotion)');
  ok(o.recall(rev1.entry.id).status === 'archived' && o.recall(rev2.entry.id).status === 'active',
    'old revision archived, new revision active');
  const rev3 = await o.ingest({ path: evolving, type: 'note' });
  ok(rev3.skipped === true && o.recall(rev2.entry.id).status === 'active',
    'unchanged reingest still dedups and supersedes nothing');

  // 26. Self-driving lifecycle: decay (lease expiry, lease renewal, distrust) + usage-earned promotion.
  const lo = new Orchestrator({
    dbPath: path.join(tmp, 'lifecycle.db'), vaultPath: path.join(tmp, 'vault2'), llmEnabled: false, sourceRoots: [tmp],
    autoIngest: { enabled: false, onMaintain: false }, // hermetic: no real-dir bridging during maintain()
    tiers: [
      { name: 'fact', ttl: 100, autoPromote: true, curatedOnly: false }, // 100ms lease for the test
      { name: 'memory', ttl: 60_000, autoPromote: true, curatedOnly: false },
      { name: 'wisdom', ttl: 0, autoPromote: false, curatedOnly: true },
    ],
    maintenance: { enabled: true, intervalMs: 0, refreshOnAccess: true, distrustBelow: 0.2, factPromote: { minRetrievals: 3, minTrust: 0.6 }, wisdomPromote: { minRetrievals: 5, minTrust: 0.7, minHelpful: 2 } },
  });

  const dying = await lo.storeMemory({ content: 'ephemeral quokka migration sighting', tier: 'fact', type: 'note' });
  const renewing = await lo.storeMemory({ content: 'renewable goose telemetry beacon', tier: 'fact', type: 'note' });
  const expBefore = lo.recall(renewing.id).expires_at;
  await new Promise((r) => setTimeout(r, 10));
  const rq = await lo.query('renewable goose telemetry', { limit: 5 });
  ok(rq.results.some((x) => x.id === renewing.id), 'lifecycle: entry retrievable before its lease expires');
  ok(lo.recall(renewing.id).expires_at > expBefore, 'retrieval renews the lease (decay-by-disuse)');

  await new Promise((r) => setTimeout(r, 120)); // both fact leases lapse (no further use)
  const xq = await lo.query('ephemeral quokka migration', { limit: 5 });
  ok(!xq.results.some((x) => x.id === dying.id), 'expired entry excluded from retrieval even before a sweep');
  ok(lo.recall(dying.id).status === 'archived',
    'lazy maintenance hooked to the query swept the expired lease (no explicit maintain call)');

  const hero = await lo.storeMemory({ content: 'frequently used wombat routing heuristic', tier: 'fact', type: 'note' });
  lo.db.prepare('UPDATE entries SET retrieval_count=3 WHERE id=?').run(hero.id);
  const mt2 = await lo.maintain({ force: true });
  ok(mt2.promoted.some((p) => p.id === hero.id && p.to === 'memory') && lo.recall(hero.id).tier === 'memory',
    'well-used fact auto-promotes to memory');
  ok(mt2.projected && typeof mt2.projected.written === 'number', 'maintain auto-projects the vault when state changed');

  lo.db.prepare('UPDATE entries SET retrieval_count=6, trust_score=0.75, helpful_count=2 WHERE id=?').run(hero.id);
  const mt3 = await lo.maintain({ force: true });
  ok(mt3.promoted.some((p) => p.id === hero.id && p.to === 'wisdom' && p.curated) && lo.recall(hero.id).tier === 'wisdom',
    'helpful-feedback memory auto-promotes to wisdom (usage-earned curation)');
  ok(lo.recall(hero.id).expires_at == null, 'auto-promotion to wisdom clears the lease (permanent tier)');

  const distrusted = await lo.storeMemory({ content: 'repeatedly wrong pelican advice', tier: 'memory', type: 'note' });
  lo.db.prepare('UPDATE entries SET trust_score=0.1 WHERE id=?').run(distrusted.id);
  const mt4 = await lo.maintain({ force: true });
  ok(mt4.swept.distrusted.includes(distrusted.id) && lo.recall(distrusted.id).status === 'archived',
    'distrusted entry (negative feedback) decays to archived');

  lo.cfg.maintenance.intervalMs = 3600e3;
  const mt5 = await lo.maintain();
  ok(mt5.skipped === true && mt5.reason === 'not_due', 'maintain throttles between intervals (lazy hook stays cheap)');
  lo.close();

  // 27. Phase-1 trigger-less recall: self-gating + budget + surfaced-only lease renewal.
  await o.storeMemory({ content: 'The reciprocal rank fusion constant k defaults to 60 in the retrieval layer.', tier: 'memory', type: 'note' });
  const relevant = await o.proactiveRecall('how does reciprocal rank fusion scoring work', { minScore: 0.01 });
  ok(relevant.inject && /fusion|rank/i.test(relevant.inject), 'proactiveRecall surfaces an inject block for a relevant message');
  ok(relevant.used.length > 0, `proactiveRecall returned ${relevant.used.length} surfaced id(s)`);
  const irrelevant = await o.proactiveRecall('quokka marsupial breakfast cereal coupons', { minScore: 0.5 });
  ok(irrelevant.inject === null && irrelevant.used.length === 0, 'proactiveRecall injects nothing when nothing clears the threshold (cheap on irrelevant turns)');
  // surfaced-only renewal: a lexically-unrelated entry stays below the threshold, so its lease is untouched
  const untouched = await o.storeMemory({ content: 'isolated penguin telemetry note', tier: 'fact', type: 'note' });
  const leaseBefore = o.recall(untouched.id).expires_at;
  await o.proactiveRecall('reciprocal rank fusion', { minScore: 0.03 });
  ok(o.recall(untouched.id).expires_at === leaseBefore, 'proactiveRecall does not renew leases for entries it did not surface');

  // 28. Extraction grounding (DELEGATE-52 safeguard): deterministic, quarantines confabulation.
  const gsrc = 'Cats are small domesticated mammals that purr and hunt mice in the garden.';
  const gsplit = checkGrounding(gsrc, [
    { content: 'Cats hunt mice' },                                  // grounded
    { content: 'Quantum entanglement enables faster-than-light teleportation' }, // confabulated
  ], (x) => x.content, 0.5);
  ok(gsplit.grounded.length === 1 && /cats/i.test(gsplit.grounded[0].content), 'grounding keeps a source-grounded claim');
  ok(gsplit.ungrounded.length === 1 && /quantum/i.test(gsplit.ungrounded[0].content), 'grounding quarantines a confabulated claim');
  ok(gsplit.grounded[0].groundingScore === 1, 'grounded claim scores 1.0');
  ok(groundingScore(gsrc, 'teleportation quantum') === 0, 'fully-ungrounded phrase scores 0');
  ok(groundingScore(gsrc, 'the of a to') === 1, 'all-stopword phrase is treated as grounded (1.0)');

  // ingest integration: result carries a grounding report; offline-fallback claims are source
  // sentences, so nothing is quarantined on a normal doc.
  const gfile = path.join(tmp, 'grounding-src.md');
  fs.writeFileSync(gfile, 'Reciprocal rank fusion merges ranked lists. Vector cosine similarity scores embeddings. The collector reads systemd and produces a status snapshot.');
  const ging = await o.ingest({ path: gfile, type: 'note' });
  ok(ging.grounding && typeof ging.grounding.summaryScore === 'number', `ingest returns a grounding report (summaryScore=${ging.grounding?.summaryScore})`);
  ok(ging.grounding.claimsQuarantined === 0, 'a faithful doc quarantines no claims');

  // 11. Work-memory: deterministic ingest categorization (no LLM)
  ok(categorizeIngest({ type: 'note', content: 'We need to research and compare these arxiv papers' }) === 'research', 'categorizer tags research');
  ok(categorizeIngest({ type: 'note', content: 'Implement the build and add a PR' }) === 'build', 'categorizer tags build');
  ok(categorizeIngest({ type: 'note', content: 'the gateway was unresponsive, a 404 outage' }) === 'incident', 'categorizer tags incident');
  ok(categorizeIngest({ type: 'correction', content: 'x' }) === 'correction', 'a work-event type is its own category');
  ok(categorizeIngest({ type: 'note', content: 'plain neutral statement about flour' }) === 'knowledge', 'uncategorized falls back to knowledge');

  // 12. Work-memory events: record → entry + graph edges + open-task tracking
  ok(WORK_EVENT_NAMES.includes('task_attempt') && WORK_EVENT_NAMES.includes('correction'), 'work-event kinds registered');
  const wt = await o.recordWork({ kind: 'task_attempt', task: 'Wire proactive recall', content: 'starting the build', source: 'brain-memo.md' });
  ok(wt.success && wt.kind === 'task_attempt' && wt.status === 'open', 'task_attempt recorded as open');
  const wc = await o.recordWork({ kind: 'correction', task: 'Wire proactive recall', content: 'use a pre-turn hook, not a tool the model must choose', outcome: 'hook approach adopted' });
  ok(wc.success && wc.tier === 'memory', 'correction lands in durable memory tier');
  const openA = o.openTasks();
  ok(openA.some((t) => t.task === 'Wire proactive recall' && t.status === 'open'), 'open task is tracked as an ongoing request');
  await o.recordWork({ kind: 'task_attempt', task: 'Wire proactive recall', status: 'done', outcome: 'shipped' });
  ok(!o.openTasks().some((t) => t.task === 'Wire proactive recall'), 'marking status done removes it from ongoing requests');
  // work events are first-class entries → retrievable by hybrid search
  const wq = await o.query('proactive recall pre-turn hook', { limit: 5 });
  ok(wq.results.some((r) => /proactive recall/i.test(r.content)), 'recorded work event is retrievable via query');

  // 12b. Opaque task-label guard: machine identifiers are recorded but never become task nodes
  //      (2026-07-31: session UUIDs + timestamped file ids had minted 341 unactionable open tasks).
  ok(isOpaqueTaskLabel('f04e6d59-38e1-4cc8-9c99-4aca30644f5c'), 'bare session UUID reads as opaque');
  ok(isOpaqueTaskLabel('20260710_033427_3d468f'), 'timestamped file id reads as opaque');
  ok(!isOpaqueTaskLabel('Wire proactive recall'), 'a human request is not opaque');
  ok(!isOpaqueTaskLabel('migrate DNS for f04e6d59-38e1-4cc8-9c99-4aca30644f5c'), 'a title merely containing an id is not opaque');
  const wOpaque = await o.recordWork({ kind: 'task_attempt', task: '20260710_033427_3d468f', content: 'bridged session file' });
  ok(wOpaque.success && wOpaque.taskNodeSkipped === true, 'opaque label still records the event, flagged taskNodeSkipped');
  ok(!o.openTasks().some((t) => t.task === '20260710_033427_3d468f'), 'opaque label never reaches the ongoing-requests list');

  // 12c. Bulk close: selector required, dryRun previews without mutating, close is idempotent
  await o.recordWork({ kind: 'task_attempt', task: 'SEO remediation' });
  await o.recordWork({ kind: 'task_attempt', task: 'DNS migration' });
  let threw = false;
  try { o.closeTasks({}); } catch { threw = true; }
  ok(threw, 'closeTasks refuses to run without a selector');
  const dry = o.closeTasks({ match: '^DNS migration$', dryRun: true });
  ok(dry.matched === 1 && dry.closed === 0 && o.openTasks().some((t) => t.task === 'DNS migration'), 'dryRun reports matches without closing');
  const closed = o.closeTasks({ tasks: ['DNS migration', 'SEO remediation'] });
  ok(closed.closed === 2 && !o.openTasks().some((t) => ['DNS migration', 'SEO remediation'].includes(t.task)), 'bulk close marks the selected tasks done');
  ok(o.closeTasks({ tasks: ['DNS migration'] }).closed === 0, 'closing an already-closed task is a no-op');

  // 12d. Bulk forget: content selector required; opaque matches boilerplate work events;
  //      dryRun previews; scope narrows; soft (status flip) not hard delete.
  const j1 = await o.recordWork({ kind: 'dead_end', task: 'f04e6d59-38e1-4cc8-9c99-4aca30644f5c', content: '[IMPORTANT: You are running as a scheduled task' });
  const j2 = await o.recordWork({ kind: 'dead_end', task: 'real parser dead end', content: 'regex over minified bundle is too brittle keepme' });
  let fthrew = false;
  try { await o.forgetEntries({ scope: 'shared' }); } catch { fthrew = true; }
  ok(fthrew, 'forgetEntries refuses scope-only selection');
  const fdry = await o.forgetEntries({ opaque: true, dryRun: true });
  ok(fdry.matched >= 1 && fdry.forgotten === 0, `bulk forget dryRun previews without deleting (matched=${fdry.matched})`);
  const freal = await o.forgetEntries({ opaque: true });
  ok(freal.forgotten >= 1, 'bulk forget removes opaque boilerplate work events');
  ok(o.recall(j1.id)?.status !== 'active', 'junk entry is soft-deleted');
  ok(o.recall(j2.id)?.status === 'active', 'legitimate dead_end with real content survives the opaque selector');

  // 12k. Revision export: deterministic bytes on an unchanged store; a knowledge mutation
  //      changes the snapshot; vectors/log/audit stay out of it.
  const expPath = path.join(tmp, 'snapshots', 'export.jsonl');
  o.cfg.export = { enabled: true, path: expPath };
  const ex1 = o.exportKnowledge();
  ok(ex1.rows > 0 && fs.existsSync(expPath), `export wrote ${ex1.rows} rows`);
  const bytes1 = fs.readFileSync(expPath, 'utf8');
  o.exportKnowledge();
  ok(fs.readFileSync(expPath, 'utf8') === bytes1, 'unchanged store exports byte-identical snapshot');
  ok(!/"_table":"(vectors|log|audit)"/.test(bytes1), 'volatile tables excluded from the snapshot');
  await o.storeMemory({ content: 'export delta probe entry', tier: 'fact' });
  o.exportKnowledge();
  ok(fs.readFileSync(expPath, 'utf8') !== bytes1, 'a knowledge mutation changes the snapshot');

  // 12j. Prospective memory (PM-Bench): record → not due before trigger → due after →
  //      event triggers match by name → resolve archives with outcome → validation rejects junk.
  const pd = await o.recordProspective({ intent: 'rotate API credentials', trigger: { type: 'date', value: '2026-09-01T00:00:00Z' }, context: 'memory-platform' });
  ok(pd.success && pd.prospective.status === 'pending', 'date-triggered intent recorded pending');
  ok(o.recall(pd.id).mem_function === 'prospective', 'prospective entry carries the prospective function');
  ok(!o.dueProspective({ now: '2026-08-31T00:00:00Z' }).some((x) => x.id === pd.id), 'not due before its trigger date');
  ok(o.dueProspective({ now: '2026-09-01T00:00:01Z' }).some((x) => x.id === pd.id), 'due once the trigger date passes');
  const pe = await o.recordProspective({ intent: 'rebuild wiki after runtime upgrade', trigger: { type: 'event', value: 'lmstudio-runtime-upgraded' } });
  ok(!o.dueProspective({ now: '2027-01-01T00:00:00Z' }).some((x) => x.id === pe.id), 'event intent never fires on time alone');
  ok(o.dueProspective({ event: 'lmstudio-runtime-upgraded' }).some((x) => x.id === pe.id), 'event intent fires on its named event');
  const pres = o.resolveProspective(pd.id, 'completed');
  ok(pres.success && !o.dueProspective({ now: '2026-09-02T00:00:00Z' }).some((x) => x.id === pd.id), 'resolved intent leaves the due list');
  ok(o.recall(pd.id) === null || o.recall(pd.id).status !== 'active', 'resolved intent archived (kept as history)');
  let pBad = false; try { await o.recordProspective({ intent: 'x', trigger: { type: 'date', value: 'not-a-date' } }); } catch { pBad = true; }
  ok(pBad, 'bad date trigger rejected');

  // 12i. Capture packs: builtin coding-patterns pack loads; recordPattern lands with the pack's
  //      tier+function and typed edges; pack categorizer rule outranks generic; unknown type rejected.
  const pk = o.listPacks();
  ok(pk.packs.some((p) => p.name === 'coding-patterns') && pk.errors.length === 0, `builtin pack loaded (${pk.packs.map((p) => p.name).join(',')})`);
  const pat = await o.recordPattern({ type: 'pattern', title: 'Selector-required bulk mutation', context: 'bulk store mutations', problem: 'a bare call could clear everything', solution: 'require an explicit selector and offer dryRun preview', evidence: ['midmem-kb-store@2e12489'], concepts: [{ name: 'safety gates' }] });
  ok(pat.success && pat.pack === 'coding-patterns' && pat.memFunction === 'procedural', 'pattern recorded via pack with procedural function');
  const patQ = await o.query('selector required bulk mutation dryRun', { functions: ['procedural'], limit: 5 });
  ok(patQ.results.some((r) => r.id === pat.id), 'recorded pattern retrievable through the procedural lens');
  const patNode = o.graph.byType('pattern').find((n) => n.label === 'Selector-required bulk mutation');
  ok(!!patNode && o.graph.neighbors(patNode.id).some((e) => e.type === 'applies'), 'pattern node linked to evidence with the pack-registered edge type');
  ok(categorizeIngest({ type: 'note', content: 'a reusable component scaffold for dashboards' }, o.packs.rules) === 'pattern', 'pack categorizer rule outranks the generic set');
  let pkBad = false; try { await o.recordPattern({ type: 'sorcery', title: 'x' }); } catch { pkBad = true; }
  ok(pkBad, 'unknown pack type rejected');

  // 12h. Function axis (survey 2607.25380): deterministic defaults per type; explicit override;
  //      retrieval filters by role; legacy null rows resolve via the same type map.
  const fnSem = await o.storeMemory({ content: 'zanzibar deployment doctrine document alpha', tier: 'memory' });
  ok(fnSem.memFunction === 'semantic', 'insight defaults to semantic function');
  const fnWork = await o.recordWork({ kind: 'task_attempt', task: 'fn axis probe', content: 'zanzibar deployment doctrine attempt beta' });
  ok(o.recall(fnWork.id).mem_function === 'episodic', 'task_attempt defaults to episodic function');
  const fnProc = await o.storeMemory({ content: 'zanzibar deployment doctrine recipe gamma', tier: 'memory', memFunction: 'procedural' });
  ok(fnProc.memFunction === 'procedural', 'explicit memFunction override wins');
  const fnQ = await o.query('zanzibar deployment doctrine', { functions: ['episodic'], limit: 10 });
  ok(fnQ.results.some((r) => r.id === fnWork.id) && !fnQ.results.some((r) => r.id === fnSem.id || r.id === fnProc.id),
    'functions filter returns only the requested role');
  o.db.prepare('UPDATE entries SET mem_function=NULL WHERE id=?').run(fnWork.id);
  const fnQ2 = await o.query('zanzibar deployment doctrine', { functions: ['episodic'], limit: 10 });
  ok(fnQ2.results.some((r) => r.id === fnWork.id), 'legacy NULL mem_function resolves via the type map');
  let fnBad = false; try { await o.storeMemory({ content: 'x', tier: 'memory', memFunction: 'telepathic' }); } catch { fnBad = true; }
  ok(fnBad, 'unknown memory function is rejected');

  // 12g. Projection QA (WiCER): clean wiki passes; a deleted page fails completeness;
  //      a corrupted page fails sampled fidelity; report-only (probe never mutates).
  o.project();
  const qa0 = o.probeProjection();
  ok(qa0.pass === true && qa0.entries > 0, `projection QA passes on a clean wiki (${qa0.entries} entries)`);
  const qaVictim = (await o.query('hybrid vector retrieval', { limit: 1 })).results[0];
  const qaPage = path.join(tmp, 'vault', 'LLM Wiki', qaVictim.tier, `${qaVictim.id}.md`);
  fs.unlinkSync(qaPage);
  const qa1 = o.probeProjection();
  ok(qa1.pass === false && qa1.missingPages.includes(qaVictim.id), 'QA catches a missing page (completeness probe)');
  o.project(); // repair via dirty-check's existence path
  fs.writeFileSync(qaPage, '---\nid: corrupt\n---\ntruncated garbage page');
  const qa2 = o.probeProjection({ sampleSize: 500 }); // full sweep: the victim must be in-sample regardless of recency
  ok(qa2.pass === false && qa2.fidelityFailures.some((f) => f.id === qaVictim.id), 'QA catches a corrupted page (fidelity probe)');
  o.project({ force: true }); // restore for later tests

  // 12e. Transition verifier (TRUSTMEM): on-subject supersede passes; topic-swap supersede is
  //      denied; evidence-covered supersede passes the coverage gate; ungrounded promote denied.
  const tvOld = o.claims.add({ content: 'The gateway webhook route listens on port 18789 and is healthy' });
  const tvSwap = o.supersedeClaim(tvOld.id, { content: 'Bananas ripen faster inside a paper bag entirely' });
  ok(tvSwap.success === false && tvSwap.denied === 'transition-verifier', 'supersede with a topic swap is denied (corruption guard)');
  const tvOk = o.supersedeClaim(tvOld.id, { content: 'The gateway webhook route on port 18789 was de-registered and is unhealthy' });
  ok(tvOk.success === true, 'on-subject supersede passes the verifier');
  const tvEvOld = o.claims.add({ content: 'The build pipeline deploys from the main branch' });
  const tvEvBad = o.supersedeClaim(tvEvOld.id, { content: 'The build pipeline deploys from the release branch after quantum blockchain approval', evidence: 'ops note: pipeline still deploys from main' });
  ok(tvEvBad.success === false, 'evidence-contradicting insertion fails the coverage gate');
  ok(o.db.prepare("SELECT COUNT(*) c FROM audit WHERE kind='transition:supersede'").get().c >= 3, 'every supersede transition wrote an audit receipt');
  // promotion floor: a poorly-grounded ingest must not climb tiers
  const tvEntry = await o.storeMemory({ content: 'well grounded direct write for promotion test', tier: 'fact' });
  o.db.prepare('UPDATE entries SET provenance=? WHERE id=?').run(JSON.stringify({ grounding: { summaryScore: 0.1 } }), tvEntry.id);
  const tvProm = await o.promote(tvEntry.id, 'memory');
  ok(tvProm.success === false && tvProm.denied === 'transition-verifier', 'promotion denied for entry below the write-time grounding floor');
  o.db.prepare('UPDATE entries SET provenance=? WHERE id=?').run(JSON.stringify({ grounding: { summaryScore: 0.9 } }), tvEntry.id);
  ok((await o.promote(tvEntry.id, 'memory')).success !== false, 'well-grounded entry promotes normally');

  // 12f. Write-path conflict tagging (MOSAIC): incoming claims are related to live neighbors
  //      at write time — contradictory/corroborating/superseding-candidate/additive/novel.
  const wr1 = o.claims.add({ content: 'The staging database runs postgres fourteen on the blue cluster' });
  ok(!wr1.metadata.writeRelation, 'first claim in a locality is novel (no tag)');
  const wr2 = o.claims.add({ content: 'The staging database does not run postgres fourteen on the blue cluster' });
  ok(wr2.metadata.writeRelation?.relation === 'contradictory' && wr2.metadata.writeRelation.neighborId === wr1.id,
    'negated twin is tagged contradictory against its neighbor at WRITE time');
  const wr3 = o.claims.add({ content: 'The staging database runs postgres fourteen on the blue cluster nodes' });
  ok(['corroborating', 'superseding-candidate'].includes(wr3.metadata.writeRelation?.relation),
    `near-duplicate is tagged ${wr3.metadata.writeRelation?.relation} (same polarity, high overlap)`);
  ok(o.lint().writeConflicts.some((c) => c.id === wr2.id), 'lint surfaces the write-time conflict queue');

  // 13. proactiveRecall self-gates: surfaces a relevant hit, stays silent on noise
  const prHit = await o.proactiveRecall('how do we wire proactive recall', { minScore: 0, force: true });
  ok(prHit.inject && prHit.used.length > 0, 'proactiveRecall surfaces an inject block for a relevant message');
  const prNoise = await o.proactiveRecall('zzqx unrelated gibberish term', { minScore: 0.99 });
  ok(prNoise.inject === null, 'proactiveRecall stays silent (inject:null) below threshold');

  // 14. P4 temporal/workflow boosts: dead-ends are demoted + flagged; corrections retrievable.
  await o.recordWork({ kind: 'dead_end', task: 'parser approach', content: 'tried regex spelunking the minified bundle dead end avoid', outcome: 'too brittle' });
  const deq = await o.query('regex spelunking minified bundle dead end avoid', { limit: 5 });
  const deHit = deq.results.find((r) => /dead end avoid|regex spelunking/i.test(r.content));
  ok(deHit && deHit.rank?.deadEndWarning === true, 'P4: dead-end surfaces flagged as a warning (rank.deadEndWarning)');

  // 15. P6 atomic claims: supersede + freshness "current" + deterministic contradiction
  const c1 = o.claims.add({ content: 'The OpenClaw gateway webhook route is registered and healthy' });
  const sup = o.supersedeClaim(c1.id, { content: 'The OpenClaw gateway webhook route was de-registered after the matrix reload' });
  ok(sup.success && o.claims.get(c1.id).status === 'superseded', 'P6: supersede marks the old claim superseded + cross-links');
  const cur = o.currentClaims('OpenClaw gateway webhook route', { limit: 5 });
  ok(cur.length && cur[0].id === sup.current && cur.every((c) => c.status !== 'superseded'), 'P6: current() returns the freshest non-superseded claim');
  o.claims.add({ content: 'the matrix plugin is enabled and configured' });
  o.claims.add({ content: 'the matrix plugin is not enabled, it was disabled' });
  const contra = o.claimContradictions({ minShared: 2 });
  ok(contra.some((p) => /matrix plugin/i.test(p.contentA) && /matrix plugin/i.test(p.contentB)), 'P6: deterministic contradiction finder flags the negated pair');

  // 16. P5 concept routing: build the graph (embed nodes + communities), retrieval stays fail-soft.
  const cg = await o.refreshConcepts();
  ok(cg.embedded > 0 && cg.communities >= 1, `P5: concept graph built (embedded ${cg.embedded} nodes, ${cg.communities} communities)`);
  const crq = await o.query('hybrid retrieval vector fusion', { limit: 5 });
  ok(crq.results.length > 0, 'P5: retrieval still returns results with concept routing enabled (fail-soft)');

  // 17. Governance realpath: a symlink inside an allowed root must not escape it.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ocmw-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'secret.md'), 'outside the allowed roots entirely');
    const link = path.join(tmp, 'escape.md');
    fs.symlinkSync(path.join(outside, 'secret.md'), link);
    await denies(() => o.ingest({ path: link, type: 'note' }), 'symlink escaping the source root blocked');
    await denies(() => o.ingest({ path: path.join(tmp, 'does-not-exist.md'), type: 'note' }), 'unresolvable path denied (fail-closed)');
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }

  // 18. Concept canonicalization: trivial variants land on ONE node; identifiers are exempt.
  const idA = o.graph.upsertNode({ type: 'concept', label: 'Inference Costs' });
  const idB = o.graph.upsertNode({ type: 'concept', label: 'inference cost' });
  ok(idA === idB, 'case/plural concept variants share one node id');
  const tA = o.graph.upsertNode({ type: 'source', label: 'notes/plan.md' });
  const tB = o.graph.upsertNode({ type: 'source', label: 'note/plan.md' });
  ok(tA !== tB, 'identifier-like node types are NOT plural-folded (distinct paths stay distinct)');

  // 19. Curated merge: near-duplicate folds into the target with its label kept as an alias.
  o.graph.upsertNode({ type: 'concept', label: 'AI inference costs' });
  const dupes = o.lint().dupeConcepts;
  ok(dupes.some((d) => /ai inference costs/i.test(d.variant) || /ai inference costs/i.test(d.keep)), 'lint surfaces the near-duplicate pair as a merge candidate');
  const mg = await o.mergeConcepts('AI inference costs', 'Inference Costs');
  ok(mg.success, `curated merge folded '${mg.merged}' into '${mg.into}'`);
  const target = o.graph.node(mg.intoId);
  ok((target.properties.aliases || []).includes('AI inference costs'), 'merged label retained as an alias on the canonical node');
  ok(o.lint().lowTrustWisdom.length === 0, 'lint reports no low-trust wisdom on a healthy store');

  // 20. Dedupe sweep is idempotent (pre-canonicalization rows get folded, second pass is a no-op).
  const dd = await o.refreshConcepts();
  ok(dd.deduped === 0, 'canonical store dedupes to zero on a follow-up pass');

  // 21. Projection hygiene: archived entries lose their vault page; concept slugs are canonical.
  const staleEntry = await o.storeMemory({ content: 'ephemeral page that should be pruned from the vault', tier: 'fact', type: 'note' });
  o.project();
  const factDir = path.join(tmp, 'vault', 'LLM Wiki', 'fact');
  ok(fs.existsSync(path.join(factDir, `${staleEntry.id}.md`)), 'active entry projects a vault page');
  await o.forget(staleEntry.id, { soft: true });
  const reproj = o.project();
  ok(!fs.existsSync(path.join(factDir, `${staleEntry.id}.md`)) && reproj.pruned >= 1, `stale vault page pruned on reprojection (pruned=${reproj.pruned})`);
  const cfiles = fs.readdirSync(path.join(tmp, 'vault', 'LLM Wiki', 'concepts'));
  ok(cfiles.every((f) => f === f.toLowerCase()), 'concept page filenames are canonical lowercase (case-insensitive-share safe)');

  // 21b. Projection dirty-check: unchanged pages hash-skip (the vault is a network share);
  //      index.md/log.md carry a timestamp so they always rewrite — everything else skips.
  const noop = o.project();
  ok(noop.skipped > 0 && noop.written <= 2, `no-op projection skips unchanged pages (written=${noop.written}, skipped=${noop.skipped})`);
  // A hand-deleted vault file is repaired despite a matching hash (existence check per dir).
  const anyEntry = (await o.query('proactive recall pre-turn hook', { limit: 1 })).results[0];
  const repairDir = path.join(tmp, 'vault', 'LLM Wiki');
  const someProjected = fs.readdirSync(path.join(repairDir, 'memory')).find((f) => f.endsWith('.md'));
  fs.unlinkSync(path.join(repairDir, 'memory', someProjected));
  o.project();
  ok(fs.existsSync(path.join(repairDir, 'memory', someProjected)), 'hand-deleted vault page is re-written on the next pass');
  // force:true rewrites everything regardless of hashes (only same-filename duplicates
  // still skip — first writer wins the pass whether forced or not).
  const forced = o.project({ force: true });
  ok(forced.written > noop.written && forced.written + forced.skipped === noop.written + noop.skipped,
    `force:true rewrites all unique pages (written=${forced.written}, skipped=${forced.skipped})`);

  // 22. Projection resilience: one unwritable page (a corrupt share entry) must not abort the pass.
  const survivor = await o.storeMemory({ content: 'page that must still project around a broken sibling', tier: 'fact', type: 'note' });
  const ghost = await o.storeMemory({ content: 'page whose vault file is broken server-side', tier: 'fact', type: 'note' });
  // Simulate the broken entry deterministically: a DIRECTORY squatting on the page's filename
  // makes writeFileSync fail (EISDIR) just like the CIFS ghost EACCESes, without needing root.
  fs.mkdirSync(path.join(factDir, `${ghost.id}.md`), { recursive: true });
  const resil = o.project();
  ok(resil.failed === 1 && resil.errors.length === 1 && resil.errors[0].includes(ghost.id),
    `projection reported the broken page and only it: ${JSON.stringify(resil.errors)}`);
  ok(fs.existsSync(path.join(factDir, `${survivor.id}.md`)), 'sibling page still projected around the broken one');
  ok(fs.existsSync(path.join(tmp, 'vault', 'LLM Wiki', 'index.md')) && resil.written > 0, 'index.md and the rest of the pass completed');
  fs.rmSync(path.join(factDir, `${ghost.id}.md`), { recursive: true, force: true });

  // 23. Retention: forced maintain prunes old log/audit rows + vectors of hard-deleted entries.
  o.db.prepare("INSERT INTO log(ts,operation,detail) VALUES('2020-01-01T00:00:00Z','ancient','{}')").run();
  const doomed = await o.storeMemory({ content: 'to be hard deleted for vector retention', tier: 'fact', type: 'note' });
  o.db.prepare("UPDATE entries SET status='deleted' WHERE id=?").run(doomed.id);
  const mres = await o.maintain({ force: true });
  ok(mres.retention && mres.retention.log >= 1, `retention pruned ${mres.retention?.log} ancient log rows`);
  ok(o.db.prepare('SELECT COUNT(*) c FROM vectors WHERE entry_id=?').get(doomed.id).c === 0, 'retention removed vectors of hard-deleted entries');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
} catch (e) {
  console.error('\nFATAL:', e.stack); fail++;
} finally {
  o.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
}
