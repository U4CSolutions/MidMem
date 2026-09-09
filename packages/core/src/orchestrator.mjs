/**
 * Orchestrator — the single coordinator. Every mutating op is gated by governance;
 * all state lives in state.db; retrieval is hybrid; the vault is a projection.
 */
import * as fs from 'node:fs/promises';
import { StateDB } from './db.mjs';
import { loadConfig } from './config.mjs';
import { TieredMemory } from './memory.mjs';
import { Embedder } from './embeddings.mjs';
import { Extractor } from './extract.mjs';
import { GraphStore } from './graph.mjs';
import { ClaimStore } from './claims.mjs';
import { SigmaVerifier } from './verify.mjs';
import { PolicyEvaluator, governed } from './governance.mjs';
import { projectVault, probeProjection } from './project.mjs';
import { hybridSearch, progressiveSearch } from './retrieval.mjs';
import { checkGrounding, groundingScore } from './grounding.mjs';
import { makeVectorStore } from './vectorstore.mjs';
import { handoffBrief as buildHandoffBrief } from './handoff.mjs';
import { recordWorkEvent, listOpenTasks, closeTasks, forgetEntries, forgetNodes, consolidateWork, categorizeIngest, recordProspective, dueProspective, resolveProspective } from './workmemory.mjs';
import { verifyTransition, verifyPromotion, auditTransition } from './transitions.mjs';
import { loadPacks, recordPattern } from './packs.mjs';
import { exportKnowledge } from './export.mjs';
import { refreshConceptGraph, mergeConceptNodes, conceptDupeCandidates } from './concepts.mjs';
import { normalizeAuthority, clampAuthority } from './authority.mjs';
import { checkConsistency } from './consistency.mjs';
import { runExpectedQueryProbes } from './evalprobes.mjs';
import { genId, sha12, nowISO } from './util.mjs';
import { normalizeProject, resolveProjects } from './projectaxis.mjs';

export class Orchestrator {
  constructor(overrides = {}) {
    this.cfg = loadConfig(overrides);
    this.db = new StateDB(this.cfg.dbPath);
    this.vectorStore = makeVectorStore(this.cfg, this.db);
    this.memory = new TieredMemory(this.db, this.cfg, this.vectorStore);
    this.embedder = new Embedder(this.cfg);
    this.extractor = new Extractor(this.cfg);
    this.graph = new GraphStore(this.db);
    this.claims = new ClaimStore(this.db, this.cfg);
    this.verifier = new SigmaVerifier(this.db, this.graph, this.cfg);
    this.gov = { evaluator: new PolicyEvaluator(this.cfg), db: this.db };
    // Capture packs load at construction (data, deterministic): same config → same
    // type/rule/edge universe. Errors are carried, not thrown — a bad pack file must
    // not take the orchestrator down.
    this.packs = loadPacks(this.cfg);
    this.graph.allowEdgeTypes(this.packs.edgeTypes || []);
  }

  /** Loaded capture packs (name/version/types) + any load errors. */
  listPacks() { return { packs: this.packs.packs, errors: this.packs.errors }; }

  /** Record a structured domain entry via a pack-registered type (governed storeMemory inside). */
  async recordPattern(rec = {}) { return recordPattern(this, rec); }

  /** Ingest a raw source: extract → store (memory tier) → embed → graph → claims → verify. */
  async ingest({ path, type = 'note', title, metadata = {}, curated = false, scope = this.cfg.agentScope, authority, project = this.cfg.project }) {
    // Authority assigned at origin (roadmap #10): explicit label wins; curation implies operator;
    // otherwise ingested material is 'doc'. Unknown labels are rejected, not silently mapped.
    if (authority !== undefined && !normalizeAuthority(authority)) throw new Error(`unknown authority: ${authority} (expected operator|stack|doc|web)`);
    const auth = normalizeAuthority(authority) || (curated ? 'operator' : 'doc');
    const proj = normalizeProject(project); // project axis (#18): null = global
    const r = await governed(this.gov, 'ingest', { path, type, scope, curated, authority: auth, project: proj }, async () => {
      const text = await fs.readFile(path, 'utf8');
      const hash = sha12(text);
      // Hash-dedup: re-ingesting an unchanged file is a no-op (makes the bridge/cron idempotent).
      const dup = this.db.prepare('SELECT id FROM sources WHERE hash=?').get(hash);
      if (dup) { this.db.logOp('ingest-skip', { path, hash, sourceId: dup.id }); return { success: true, skipped: true, reason: 'unchanged', sourceId: dup.id }; }

      const ex = await this.extractor.extract(text, type);
      // DELEGATE-52 safeguard: ground LLM-extracted concepts/claims against the source BEFORE they
      // persist — quarantine (don't store) any whose content-words aren't actually in the document.
      const gcfg = this.cfg.grounding || {};
      const minOverlap = gcfg.enabled === false ? 0 : (gcfg.minOverlap ?? 0.5);
      const gc = checkGrounding(text, ex.concepts, (c) => c.name, minOverlap);
      const gcl = checkGrounding(text, ex.claims, (c) => c.content, minOverlap);
      const grounding = {
        summaryScore: Number(groundingScore(text, ex.summary).toFixed(3)), minOverlap,
        conceptsKept: gc.grounded.length, conceptsQuarantined: gc.ungrounded.length,
        claimsKept: gcl.grounded.length, claimsQuarantined: gcl.ungrounded.length,
      };
      const { vector, model, mode } = await this.embedder.embed(ex.summary);
      const sourceId = genId('src', path);
      // Deterministic category tag so the store tracks ongoing requests by kind (research/build/...).
      const category = categorizeIngest({ type, content: ex.summary, title }, this.packs?.rules || []);
      const prov = { originalSource: path, extractedAt: nowISO(), category, authority: auth, grounding, chain: [{ step: 'ingest', source: path }] };
      // Sources row (the dedup hash) commits WITH the entry: a failed ingest must not
      // leave the hash behind, or re-ingests would be skipped as 'unchanged' forever.
      // Supersede-on-reingest: a changed file replaces its earlier ingests — archive
      // every active entry from a prior source row for the same path, whatever its
      // tier (a stale wisdom copy is still stale). Same tx, so the old entries can't
      // be archived without the replacement landing.
      let superseded = [];
      const stored = this.db.tx(() => {
        superseded = this.db.prepare(
          "SELECT e.id FROM entries e JOIN sources s ON e.source_id = s.id WHERE s.path = ? AND e.status = 'active'",
        ).all(path).map((r) => r.id);
        const sup = this.db.prepare("UPDATE entries SET status='archived', updated_at=? WHERE id=?");
        for (const id of superseded) sup.run(nowISO(), id);
        this.db.prepare('INSERT INTO sources(id,path,type,title,hash,ingested_at,metadata) VALUES(?,?,?,?,?,?,?)')
          .run(sourceId, path, type, title || null, hash, nowISO(), JSON.stringify(metadata));
        return this.memory.store({ content: ex.summary, type: 'ingest', tier: 'memory', scope, sourceId, provenance: prov, concepts: gc.grounded, project: proj });
      });
      await this.memory.upsertVector(stored.id, vector, model, mode);

      const nodeIds = gc.grounded.map((c) => this.graph.upsertNode({ type: c.type || 'concept', label: c.name, source: path, properties: { confidence: c.confidence, grounding: c.groundingScore } }));
      for (let i = 1; i < nodeIds.length; i++) this.graph.upsertEdge({ from: nodeIds[0], to: nodeIds[i], type: 'relates', source: path });
      // Claims inherit the source's authority — summarization/extraction must not raise it.
      for (const cl of gcl.grounded) this.claims.add({ content: cl.content, type: 'fact', source: { path, type, title }, provenance: { extractor: ex.mode, confidence: cl.confidence, grounding: cl.groundingScore, authority: auth } });

      const verification = this.verifier.verifyConcepts(gc.grounded);
      this.db.logOp('ingest', { path, entry: stored.id, concepts: gc.grounded.length, claims: gcl.grounded.length, quarantined: gc.ungrounded.length + gcl.ungrounded.length, summaryScore: grounding.summaryScore, mode: ex.mode, conflicts: verification.conflicts.length, superseded: superseded.length });
      this.#markVaultDirty();
      return { success: true, entry: stored, concepts: gc.grounded.length, claims: gcl.grounded.length, grounding, verification, mode: ex.mode, superseded };
    });
    await this.#maybeMaintain();
    return r;
  }

  /** The MCP `remember` op — store a memory directly. */
  async storeMemory({ content, type = 'insight', tier = 'memory', scope = this.cfg.agentScope, source, concepts, curated = false, memFunction = null, authority, parentAuthority = null, project = this.cfg.project }) {
    if (authority !== undefined && !normalizeAuthority(authority)) throw new Error(`unknown authority: ${authority} (expected operator|stack|doc|web)`);
    // Direct agent writes are 'stack' by default; curation implies operator; a derived write
    // passes parentAuthority and is CLAMPED to it — consolidation can never raise authority.
    const auth = clampAuthority(normalizeAuthority(authority) || (curated ? 'operator' : 'stack'), parentAuthority);
    const proj = normalizeProject(project); // project axis (#18): null = global
    const r = await governed(this.gov, 'store', { tier, scope, curated, authority: auth, project: proj }, async () => {
      const prov = { authority: auth, ...(source ? { originalSource: source.path, extractedAt: nowISO(), chain: [{ step: 'remember', source: source.path }] } : {}) };
      const stored = this.db.tx(() => this.memory.store({ content, type, tier, scope, provenance: prov, concepts, memFunction, project: proj }));
      const { vector, model, mode } = await this.embedder.embed(content);
      await this.memory.upsertVector(stored.id, vector, model, mode);
      if (concepts) for (const c of concepts) this.graph.upsertNode({ type: c.type || 'concept', label: c.name, source: 'remember' });
      this.db.logOp('remember', { entry: stored.id, tier });
      this.#markVaultDirty();
      return { success: true, ...stored };
    });
    await this.#maybeMaintain();
    return r;
  }

  async query(question, opts = {}) {
    const scopes = opts.scopes || this.#defaultScopes();
    const projects = resolveProjects(opts, this.#defaultProjects()); // project + global; null = all
    // Progressive by default (roadmap #11): lexical-first with a sufficiency gate; deep:true
    // (or progressive.enabled=false) runs the full hybrid pipeline unconditionally.
    const { results, sufficiency } = await progressiveSearch(this.db, this.memory, this.embedder, question, { ...opts, scopes, projects });
    this.memory.recordRetrieval(results.map((r) => r.id)); // usage signal feeds trust/decay (+ lease renewal)
    const graphContext = opts.includeGraphContext ? this.#graphContext(question) : null;
    await this.#maybeMaintain();
    return { query: question, results, sufficiency, scopes, projects, graphContext, tiers: opts.tiers || this.memory.tierNames, timestamp: nowISO() };
  }

  /**
   * Phase 1 of trigger-less recall: a self-gating, token-budgeted pre-turn primitive.
   * Runs the hybrid search on the raw user message and returns a compact, provenance-tagged
   * inject block ONLY when the top hit clears `minScore` — otherwise `{inject:null}` (near-zero
   * cost on irrelevant turns). Designed to be called by a pre-turn hook so the model spends no
   * tool-call cycle. Records retrieval ONLY for items actually surfaced, so proactively scanning
   * every turn does not renew leases for things we merely considered (decay stays meaningful).
   * Threshold/budget are env-tunable and are the seam for later self-tuning via `feedback`.
   */
  async proactiveRecall(message, opts = {}) {
    const c = this.cfg.proactiveRecall || {};
    if (c.enabled === false && !opts.force) return { inject: null, used: [], topScore: null, skipped: 'disabled' };
    const minScore = opts.minScore ?? c.minScore ?? 0.02;
    const maxTokens = opts.maxTokens ?? c.maxTokens ?? 600;
    const maxItems = opts.maxItems ?? c.maxItems ?? 4;
    const scopes = opts.scopes || this.#defaultScopes();
    const projects = resolveProjects(opts, this.#defaultProjects());
    const results = await hybridSearch(this.db, this.memory, this.embedder, message, { scopes, projects, maxTokens, limit: maxItems });
    const passing = results.filter((r) => r.score >= minScore);
    const topScore = results[0]?.score ?? null;
    if (!passing.length) { this.db.logOp('proactive-recall', { injected: 0, topScore }); return { inject: null, used: [], topScore }; }
    this.memory.recordRetrieval(passing.map((r) => r.id)); // only surfaced items count + renew
    const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 200);
    const lines = passing.map((r) => {
      const src = r.provenance?.originalSource ? ` _(src: ${r.provenance.originalSource})_` : '';
      return `- [${r.tier} · trust ${(r.trust ?? 0.5).toFixed(2)}] ${oneLine(r.content)}${src}`;
    });
    const inject = ['## Recalled knowledge (midmem — weigh by trust, may be partial)', ...lines].join('\n');
    this.db.logOp('proactive-recall', { injected: passing.length, topScore });
    return { inject, used: passing.map((r) => r.id), topScore };
  }

  /**
   * Self-driving lifecycle pass — the user never has to remember to decay or promote.
   * Runs opportunistically on normal use (query/ingest/remember), throttled to one pass
   * per maintenance.intervalMs across all processes sharing state.db; a daily timer with
   * force:true covers idle periods. Steps: sweep decay (expired leases + distrusted
   * entries) → auto-promote usage-earned entries → reproject the vault if anything
   * (including earlier mutations) left it stale.
   */
  async maintain({ force = false } = {}) {
    const m = this.cfg.maintenance || {};
    if (!m.enabled && !force) return { skipped: true, reason: 'disabled' };
    // Re-entrancy guard: auto-ingest bridges files via ingest(), which calls #maybeMaintain() →
    // maintain(). Without this, a low intervalMs would recurse infinitely (the throttle alone is
    // not a safe guard). One maintenance pass at a time, period.
    if (this._maintaining) return { skipped: true, reason: 're-entrant' };
    const now = Date.now();
    const last = Number(this.db.prepare("SELECT value FROM meta WHERE key='last_maintenance_at'").get()?.value || 0);
    if (!force && now - last < m.intervalMs) return { skipped: true, reason: 'not_due', nextDueMs: m.intervalMs - (now - last) };
    this.db.prepare("INSERT INTO meta(key,value) VALUES('last_maintenance_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(now));

    this._maintaining = true;
    try {
      // Auto-ingest agent work first (deterministic bridge of session/memory dirs) so this pass's
      // projection + promotion sees the freshly-captured entries. Best-effort; never fails maintenance.
      // The re-entrancy guard (above) stops the bridge's own ingests from recursing back into maintain.
      let autoIngested = null;
      if (this.cfg.autoIngest?.enabled && this.cfg.autoIngest?.onMaintain) {
        autoIngested = await consolidateWork(this);
        if (autoIngested?.bridged) this.#markVaultDirty();
      }

      const swept = this.memory.sweepLifecycle({ distrustBelow: m.distrustBelow ?? 0 });
      const promoted = [];
      for (const c of this.memory.autoPromoteCandidates(m)) {
        // Write-time grounding is immutable, so a below-floor entry is PERMANENTLY ineligible:
        // pre-filter here rather than letting promote() deny it — which would (a) misreport it
        // in `promoted`, and (b) re-deny + re-audit the same entry on every pass forever.
        if (this.cfg.transitions?.enabled !== false && !verifyPromotion(this.recall(c.id), this.cfg.transitions).pass) continue;
        // Governance still gates each promotion — a veto stands, the rest proceed.
        try {
          const pr = await this.promote(c.id, c.to, { curated: c.curated });
          if (pr?.success !== false) promoted.push(c);
        } catch { /* vetoed */ }
      }
      if (swept.expired.length || swept.distrusted.length) this.#markVaultDirty();

      // P5: (re)build the concept graph (embed nodes + communities + canonical dedupe) only on a
      // forced/daily pass — it can embed many nodes, so it must NOT run on the hot-path maintain.
      let concepts = null;
      if (force && this.cfg.conceptRouting?.enabled) {
        try { concepts = await refreshConceptGraph(this); } catch (e) { concepts = { error: e.message }; }
      }

      // Retention (forced/daily only): the log/audit tables grow without bound otherwise, and
      // hard-deleted entries leave orphan vectors. Bounded history, deterministic cutoffs.
      let retention = null;
      if (force && (m.retentionDays ?? 0) > 0) {
        try {
          const cutoff = new Date(now - m.retentionDays * 864e5).toISOString();
          retention = {
            log: this.db.prepare('DELETE FROM log WHERE ts < ?').run(cutoff).changes,
            audit: this.db.prepare('DELETE FROM audit WHERE ts < ?').run(cutoff).changes,
            orphanVectors: this.db.prepare(
              "DELETE FROM vectors WHERE entry_id IN (SELECT id FROM entries WHERE status='deleted')",
            ).run().changes,
            // Node deletes that bypassed graph.deleteNode strand their edges — heal here.
            orphanEdges: this.graph.sweepOrphanEdges(),
          };
        } catch (e) { retention = { error: e.message }; }
      }

      let projected = null;
      if (this.#vaultDirty()) {
        // Vault is a projection on possibly-remote storage — its failure must not fail maintenance.
        try { projected = this.project(); } catch (e) { projected = { error: e.message }; }
      }
      // Projection QA (WiCER): probe the compiled wiki on the heavy pass only (force/daily),
      // where the concept-embedding work already lives. Report-only; failure must not fail
      // maintenance — a QA failure is a finding, not an outage.
      let projectionQA = null;
      if (force && this.cfg.projectionQA?.enabled !== false) {
        try {
          projectionQA = this.probeProjection();
          if (!projectionQA.pass) this.db.logOp('projection-qa-fail', { missing: projectionQA.missingCount, fidelity: projectionQA.fidelityFailures.length });
        } catch (e) { projectionQA = { error: e.message }; }
      }
      let exported = null;
      if (force && this.cfg.export?.enabled !== false) {
        try { exported = this.exportKnowledge(); } catch (e) { exported = { error: e.message }; }
      }
      // Expected-query probes (roadmap #15): compile likely future queries at consolidation
      // time and verify their evidence paths now — beside the WiCER probes they extend.
      let queryProbes = null;
      if (force && this.cfg.projectionQA?.queryProbes !== false) {
        try {
          queryProbes = await this.probeExpectedQueries();
          if (!queryProbes.pass) this.db.logOp('query-probe-miss', { sampled: queryProbes.sampled, misses: queryProbes.misses.length });
        } catch (e) { queryProbes = { error: e.message }; }
      }
      // Global consistency pass (roadmap #13): verify the resulting memory STATE on the heavy
      // pass. Report-only — findings are logged for judgment, never auto-fixed.
      let consistency = null;
      if (force && this.cfg.consistency?.enabled !== false) {
        try {
          consistency = this.checkConsistency();
          if (!consistency.pass) this.db.logOp('consistency-findings', { findings: consistency.findings, contradictions: consistency.contradictions.length, danglingChains: consistency.danglingChains.length, deferredAging: consistency.deferredAging.length });
        } catch (e) { consistency = { error: e.message }; }
      }
      const summary = { swept, promoted, projected, projectionQA, queryProbes, exported, autoIngested, concepts, retention, consistency, forced: force };
      this.db.logOp('maintain', summary);
      return summary;
    } finally { this._maintaining = false; }
  }

  /** Record a work-memory event (task_attempt|source_used|dead_end|correction|artifact|decision).
   *  Stored as a provenance-linked, categorized entry + typed graph edges — the Brain-style
   *  "memory about work". storeMemory inside handles governance/embedding. */
  async recordWork(ev = {}) {
    if (this.cfg.workMemory?.enabled === false) return { success: false, reason: 'work-memory disabled' };
    const r = await recordWorkEvent(this, ev);
    this.#markVaultDirty();
    return r;
  }

  /** Ongoing requests: task nodes not yet marked done. */
  openTasks() { return listOpenTasks(this); }

  /** Bulk-close open task nodes (status → done). Requires a selector; supports dryRun. */
  closeTasks(opts) { return closeTasks(this, opts); }

  /** Bulk soft-forget entries by selector (content selector required; supports dryRun). */
  forgetEntries(opts) { return forgetEntries(this, opts); }

  /** Bulk hard-delete graph nodes by selector (edges cascade; selector required; supports dryRun). */
  async forgetNodes(opts = {}) {
    return governed(this.gov, 'forget-nodes', { ids: opts.ids, match: opts.match, opaque: !!opts.opaque, types: opts.types, dryRun: !!opts.dryRun }, () => {
      const r = forgetNodes(this, opts);
      if (r.deleted) this.#markVaultDirty();
      return r;
    });
  }

  /** Prospective memory: record an intent (date|event trigger). MidMem informs; cron fires. */
  async recordProspective(opts) { return recordProspective(this, opts); }

  /** Pending intents whose trigger has fired (deterministic; `now`/`event` are caller inputs). */
  dueProspective(opts) { return dueProspective(this, opts); }

  /** Resolve an intent: completed | cancelled (archives the entry, keeps the history). */
  resolveProspective(id, outcome) { return resolveProspective(this, id, outcome); }

  /**
   * Fallback re-embed (roadmap 2026-09 #23, re-embed half). While the embedder is down, every
   * write silently stores a deterministic hash vector (`model = fallback-hash-<dim>`) — the entry
   * is stored and lexically searchable, but the vector lane is blind to it. Re-ingest cannot
   * repair that (hash-dedup skips the unchanged file; work events have no file), so this swaps
   * the placeholder vectors for real ones in place, oldest first, bounded by `limit`.
   * Self-gating: the first embed is a probe — if the embedder is still offline nothing is
   * touched; if it drops mid-run the pass stops at that entry (never writes a fallback over a
   * fallback and calls it repaired). `since` narrows to vectors created at/after an ISO time.
   */
  async reembedFallback({ limit = 200, since = null, dryRun = false } = {}) {
    const conds = ["v.model LIKE 'fallback%'", "e.status = 'active'"];
    const params = [];
    if (since) { conds.push('v.created_at >= ?'); params.push(since); }
    const rows = this.db.prepare(`SELECT v.entry_id id, e.content, v.created_at FROM vectors v JOIN entries e ON e.id = v.entry_id
      WHERE ${conds.join(' AND ')} ORDER BY v.created_at LIMIT ?`).all(...params, Math.max(1, limit));
    const total = this.db.prepare(`SELECT COUNT(*) c FROM vectors v JOIN entries e ON e.id = v.entry_id WHERE ${conds.join(' AND ')}`).get(...params).c;
    if (dryRun || !rows.length) return { success: true, dryRun, candidates: total, batch: rows.length, reembedded: 0 };
    let reembedded = 0, stoppedAt = null, model = null;
    for (const r of rows) {
      const { vector, model: m, mode } = await this.embedder.embed(r.content);
      if (mode !== 'lmstudio') { stoppedAt = r.id; break; } // probe on the first row; box-down mid-run on later ones
      await this.memory.upsertVector(r.id, vector, m, mode); // dim guard still applies
      model = m; reembedded++;
    }
    const success = reembedded > 0 || !stoppedAt;
    const out = { success, candidates: total, batch: rows.length, reembedded, remaining: total - reembedded, model, stoppedAt, reason: stoppedAt && !reembedded ? 'embedder-offline' : stoppedAt ? 'embedder-dropped-mid-run' : null };
    this.db.logOp('reembed', out);
    return out;
  }

  /** Deterministic knowledge snapshot (JSONL, stable bytes) for git revision history. */
  exportKnowledge() { const r = exportKnowledge(this.db, this.cfg); this.db.logOp('export', { rows: r.rows }); return r; }

  /** P5: (re)build the concept graph (embed nodes + communities) on demand. */
  async refreshConcepts(opts) { return refreshConceptGraph(this, opts); }

  /** Curated concept merge: fold near-duplicate `fromLabel` into `toLabel` (alias retained).
   *  For pairs the canonical key rightly keeps apart — judgment in, deterministic execution. */
  async mergeConcepts(fromLabel, toLabel, { type = 'concept' } = {}) {
    return governed(this.gov, 'merge-concepts', { fromLabel, toLabel, type }, () => {
      const r = mergeConceptNodes(this, fromLabel, toLabel, type);
      this.db.logOp('merge-concepts', r);
      if (r.success) this.#markVaultDirty();
      return r;
    });
  }

  /** Lazy maintenance hook — cheap when not due; never breaks the primary op. */
  async #maybeMaintain() {
    if (!this.cfg.maintenance?.enabled) return;
    try { await this.maintain(); } catch { /* maintenance is best-effort */ }
  }

  #markVaultDirty() { this.db.prepare("INSERT INTO meta(key,value) VALUES('vault_dirty','1') ON CONFLICT(key) DO UPDATE SET value='1'").run(); }
  #vaultDirty() { return this.db.prepare("SELECT value FROM meta WHERE key='vault_dirty'").get()?.value === '1'; }

  /** Feedback loop — caller marks a recalled entry helpful/unhelpful (nudges trust_score). */
  feedback(id, helpful = true) { const r = this.memory.recordFeedback(id, helpful); this.db.logOp('feedback', { id, helpful }); return r; }

  /** Hand-off memory gate (firstware) — build a brief to inject into an agent hand-off. */
  handoffBrief(opts = {}) { return buildHandoffBrief(this, opts); }

  /** Reads default to this agent's own scope plus the shared commons. */
  #defaultScopes() { return [...new Set([this.cfg.agentScope, 'shared'])]; }

  /** Reads default to this process's project plus global (null = no project set → everything). */
  #defaultProjects() { return this.cfg.project ? [this.cfg.project] : null; }

  recall(id) { return this.memory.get(id); }

  async brief() {
    const g = this.graph.getGraph();
    return {
      tiers: this.memory.stats(),
      projects: this.memory.projectStats(),
      claims: this.claims.stats(),
      graph: { nodes: g.nodes.length, edges: g.edges.length },
      vectors: await this.memory.vectorHealth(),
      recent: this.db.prepare('SELECT ts,operation FROM log ORDER BY id DESC LIMIT 10').all(),
    };
  }

  lint() {
    const conflicts = this.verifier.detectConflicts();
    const g = this.graph.getGraph();
    const linked = new Set(g.edges.flatMap((e) => [e.from, e.to]));
    const orphans = g.nodes.filter((n) => !linked.has(n.id)).map((n) => n.label);
    // Wisdom is immune to distrust-archival (permanent tier), so buried-but-curated entries
    // need a human eye — surface them here rather than silently keeping them ranked low.
    const lowTrustWisdom = this.db.prepare(
      "SELECT id, trust_score, content FROM entries WHERE status='active' AND tier='wisdom' AND trust_score < 0.3",
    ).all().map((r) => ({ id: r.id, trust: r.trust_score, content: r.content.slice(0, 80) }));
    const dupeConcepts = conceptDupeCandidates(this);
    // Write-path conflicts (MOSAIC): claims that arrived tagged contradictory and are still live —
    // the write-time queue of judgment calls, distinct from the pairwise audit above.
    // Both sides must still be live: a conflict whose neighbor was since superseded/archived is
    // resolved history, not a pending judgment call — without this filter the queue could never
    // be cleared for corrected claims.
    const claimById = new Map(this.claims.getAll().map((c) => [c.id, c]));
    const writeConflicts = [...claimById.values()]
      .filter((c) => (c.status === 'active' || c.status === 'verified') && c.metadata?.writeRelation?.relation === 'contradictory')
      .filter((c) => { const n = claimById.get(c.metadata.writeRelation.neighborId); return n && (n.status === 'active' || n.status === 'verified'); })
      .map((c) => ({ id: c.id, neighbor: c.metadata.writeRelation.neighborId, content: c.content.slice(0, 120) }));
    // TARL pending ledger: deferred claims are a review queue, not a hidden state — always surfaced.
    const deferredClaims = this.claims.deferred().map((c) => ({ id: c.id, since: c.metadata?.deferredAt, reason: c.metadata?.deferReason, content: c.content.slice(0, 120) }));
    // HiGram stale paths: dependency paths flagged by a supersede, awaiting review (report-only).
    const stalePaths = this.graph.allNodes().filter((n) => n.properties?.staleReview)
      .map((n) => ({ id: n.id, type: n.type, label: n.label, ...n.properties.staleReview }));
    return { contradictions: conflicts.conflicts, writeConflicts, deferredClaims, stalePaths, orphans, lowTrustWisdom, dupeConcepts, summary: { nodes: g.nodes.length, edges: g.edges.length, entries: Object.values(this.memory.stats()).reduce((a, b) => a + b, 0) } };
  }

  async forget(id, { soft = true, force = false } = {}) {
    return governed(this.gov, 'forget', { soft, force }, async () => { const r = await this.memory.forget(id, { soft }); this.db.logOp('forget', { id, soft }); this.#markVaultDirty(); return r; });
  }

  archive(opts = {}) { const r = this.memory.archive(opts); this.db.logOp('archive', r); if (r.archived) this.#markVaultDirty(); return r; }

  async promote(id, toTier, { curated = false } = {}) {
    return governed(this.gov, 'promote', { toTier, curated }, () => {
      // Transition check (TRUSTMEM): drifted-at-write content must not climb tiers.
      if (this.cfg.transitions?.enabled !== false) {
        const entry = this.recall(id);
        const verdict = verifyPromotion(entry, this.cfg.transitions);
        auditTransition(this.db, 'promote', { ...verdict, id, toTier }, { before: entry?.content || '', after: entry?.content || '' });
        if (!verdict.pass && this.cfg.transitions?.deny !== false) {
          this.db.logOp('promote-denied', { id, toTier, reason: verdict.reason });
          return { success: false, denied: 'transition-verifier', ...verdict };
        }
      }
      const r = this.memory.promote(id, toTier); this.db.logOp('promote', { id, toTier }); this.#markVaultDirty(); return r;
    });
  }

  /** WiCER-style projection QA: completeness + sampled fidelity probes over the compiled wiki. */
  probeProjection(opts = {}) {
    const r = probeProjection(this.db, this.memory, this.cfg, { ...this.cfg.projectionQA, ...opts });
    this.db.logOp('projection-qa', { pass: r.pass, entries: r.entries, missing: r.missingCount, sampled: r.sampled, fidelityFailures: r.fidelityFailures.length });
    return r;
  }

  project({ force = false } = {}) {
    const r = projectVault(this.db, this.memory, this.graph, this.cfg, { force });
    this.db.logOp('project', r);
    this.db.prepare("INSERT INTO meta(key,value) VALUES('vault_dirty','0') ON CONFLICT(key) DO UPDATE SET value='0'").run();
    return r;
  }

  getGraph() { return this.graph.getGraph(); }
  searchClaims(q, opts) { return this.claims.search(q, opts); }
  /** P6: the current (freshest, non-superseded/contradicted) claim(s) for a query. */
  currentClaims(q, opts) { return this.claims.current(q, opts); }
  /** P6: supersede a claim with an updated one (knowledge-point update). */
  supersedeClaim(oldId, next) {
    // Transition check (TRUSTMEM): the replacement must stay on-subject (corruption guard),
    // and when evidence is supplied its content must be supported by old ∪ evidence
    // (insertion guard). Receipt always written; deny is config-controlled.
    if (this.cfg.transitions?.enabled !== false) {
      const old = this.claims.get(oldId);
      if (old) {
        const verdict = verifyTransition({ before: old.content, after: next?.content || '', evidence: next?.evidence || '' }, this.cfg.transitions);
        auditTransition(this.db, 'supersede', { ...verdict, oldId }, { before: old.content, after: next?.content || '' });
        if (!verdict.pass && this.cfg.transitions?.deny !== false) {
          this.db.logOp('supersede-denied', { oldId, subjectOverlap: verdict.subjectOverlap, coverage: verdict.coverage });
          return { success: false, denied: 'transition-verifier', ...verdict };
        }
      }
    }
    const old = this.claims.get(oldId);
    const r = this.claims.supersede(oldId, next); this.db.logOp('claim-supersede', { oldId, current: r.current }); if (r.success) this.#markVaultDirty();
    // HiGram path rewrite (roadmap #12), report-only: when a claim is superseded, flag the
    // concept nodes its content touches — and their community parents — as the affected
    // dependency path needing review. Judgment clears the flags (clearStaleFlags); nothing
    // here mutates knowledge.
    if (r.success && old) {
      const flagged = [];
      const ts = nowISO();
      for (const n of this.graph.findByText(old.content)) {
        if (n.type === 'community') continue;
        this.db.prepare('UPDATE nodes SET properties=? WHERE id=?')
          .run(JSON.stringify({ ...n.properties, staleReview: { claim: oldId, at: ts } }), n.id);
        flagged.push(n.id);
        for (const e of this.graph.neighbors(n.id)) {
          if (e.type !== 'member_of') continue;
          const parent = this.graph.node(e.to);
          if (parent && !parent.properties.staleReview) {
            this.db.prepare('UPDATE nodes SET properties=? WHERE id=?')
              .run(JSON.stringify({ ...parent.properties, staleReview: { claim: oldId, at: ts, via: n.id } }), parent.id);
            flagged.push(parent.id);
          }
        }
      }
      if (flagged.length) this.db.logOp('stale-path', { claim: oldId, flagged: flagged.length });
      r.stalePath = flagged;
    }
    return r;
  }

  /** HiGram (roadmap #12): clear reviewed stale-path flags (judgment op; ids required). */
  async clearStaleFlags({ ids = [] } = {}) {
    return governed(this.gov, 'stale-clear', { ids }, () => {
      if (!ids.length) throw new Error('ids required (judgment op — no bulk blind clear)');
      let cleared = 0;
      for (const id of ids) {
        const n = this.graph.node(id);
        if (!n || !n.properties.staleReview) continue;
        const { staleReview, ...rest } = n.properties;
        this.db.prepare('UPDATE nodes SET properties=? WHERE id=?').run(JSON.stringify(rest), id);
        cleared++;
      }
      this.db.logOp('stale-clear', { ids, cleared });
      return { success: true, cleared };
    });
  }
  /** P6: deterministic contradiction candidates among live claims. */
  claimContradictions(opts) { return this.claims.findContradictions(opts); }

  /** PMMC (roadmap #15): compile expected-query probes + verify their evidence paths. */
  async probeExpectedQueries(opts = {}) {
    const pc = this.cfg.projectionQA || {};
    const r = await runExpectedQueryProbes(this, { sampleSize: opts.sampleSize ?? pc.queryProbeSample ?? 12, topK: opts.topK ?? pc.queryProbeTopK ?? 5 });
    this.db.logOp('query-probes', { pass: r.pass, sampled: r.sampled, hits: r.hits });
    return r;
  }

  /** PGMem (roadmap #14): a claim's validity window (first/last observed, support,
   *  contradicting evidence, currently-valid verdict). */
  claimValidity(id) { return this.claims.validity(id); }

  /** Global consistency check (roadmap #13): verify the memory STATE — cross-claim
   *  contradictions, dangling supersede chains, deferred-ledger aging. Report-only. */
  checkConsistency(opts = {}) { const r = checkConsistency(this, opts); this.db.logOp('consistency', { pass: r.pass, findings: r.findings }); return r; }

  /** TARL (roadmap #9): the pending ledger — deferred claims awaiting judgment, oldest first. */
  deferredClaims() { return this.claims.deferred(); }

  /** TARL: park a live claim as deferred (judgment op, governed like other claim mutations). */
  async deferClaim(id, reason) {
    return governed(this.gov, 'claim-defer', { id }, () => {
      const r = this.claims.defer(id, reason);
      this.db.logOp('claim-defer', { id, success: r.success });
      return r;
    });
  }

  /** TARL: resolve a deferred claim — accept (→ active) or reject (→ archived). */
  async resolveDeferredClaim(id, action) {
    return governed(this.gov, 'claim-resolve', { id, action }, () => {
      const r = this.claims.resolveDeferred(id, action);
      this.db.logOp('claim-resolve', { id, action, success: r.success });
      if (r.success) this.#markVaultDirty();
      return r;
    });
  }

  #graphContext(q) {
    const nodes = this.graph.findByText(q);
    const ids = new Set(nodes.map((n) => n.id));
    const edges = nodes.flatMap((n) => this.graph.neighbors(n.id)).filter((e) => ids.has(e.from) && ids.has(e.to));
    return { nodes: nodes.map((n) => ({ id: n.id, label: n.label, type: n.type })), edges: edges.map((e) => ({ from: e.from, to: e.to, type: e.type })) };
  }

  close() { this.db.close(); }
}
