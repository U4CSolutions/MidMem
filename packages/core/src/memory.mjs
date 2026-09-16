/**
 * TieredMemory — fact → memory → wisdom store, backed entirely by state.db.
 * No parallel markdown store (the vault is a downstream projection).
 */
import { genId, nowISO, json } from './util.mjs';
import { functionForType, MEMORY_FUNCTIONS } from './workmemory.mjs';
import { normalizeProject, projectClause } from './projectaxis.mjs';

export class TieredMemory {
  /** @param {import('./db.mjs').StateDB} db @param {object} cfg */
  constructor(db, cfg, vectorStore) {
    this.db = db;
    this.cfg = cfg;
    this.vectorStore = vectorStore; // pluggable: sqlite (default) | qdrant
    this.tierNames = cfg.tiers.map((t) => t.name);
  }

  tier(name) { return this.cfg.tiers.find((t) => t.name === name); }

  /**
   * Store an entry (single transactional write to entries; vector set separately).
   * @returns {{id:string, rowid:number, tier:string}}
   */
  store({ content, type = 'note', tier = 'memory', scope = 'shared', sourceId = null, provenance = null, concepts = null, memFunction = null, project = null }) {
    const tc = this.tier(tier);
    if (!tc) throw new Error(`unknown tier: ${tier}`);
    const fn = memFunction || functionForType(type);
    const proj = normalizeProject(project); // null = global
    if (!MEMORY_FUNCTIONS.includes(fn)) throw new Error(`unknown memory function: ${fn} (expected: ${MEMORY_FUNCTIONS.join('|')})`);
    const id = genId(tier, content.slice(0, 80) + type + Date.now());
    const ts = nowISO();
    let expiresAt = tc.ttl ? new Date(Date.now() + tc.ttl).toISOString() : null;
    // Lifecycle class (#44): a `working` entry is context-assembly state — lease-bound to the
    // working TTL whatever its tier, so a transient note can never outlive the task that wrote it.
    if (fn === 'working') {
      const cap = new Date(Date.now() + (this.cfg.lifecycle?.workingTtlMs ?? 24 * 3600e3)).toISOString();
      expiresAt = expiresAt && expiresAt < cap ? expiresAt : cap;
    }
    const info = this.db.prepare(`
      INSERT INTO entries(id,tier,type,content,source_id,provenance,concepts,status,scope,created_at,updated_at,expires_at,mem_function,project)
      VALUES(?,?,?,?,?,?,?, 'active', ?,?,?,?,?,?)
    `).run(id, tier, type, content, sourceId,
      provenance ? JSON.stringify(provenance) : null,
      concepts ? JSON.stringify(concepts) : null, scope, ts, ts, expiresAt, fn, proj);
    return { id, rowid: Number(info.lastInsertRowid), tier, scope, memFunction: fn, project: proj };
  }

  async upsertVector(entryId, embedding, model, mode = 'unknown') {
    // Dimension guard: real-model vectors must all share one dimension (the mixed-dim trap).
    // Fallback (hash) vectors are exempt — they're the offline placeholder, not the canonical space.
    const isFallback = mode === 'fallback' || (model || '').startsWith('fallback');
    if (!isFallback) {
      const row = this.db.prepare("SELECT value FROM meta WHERE key='vector_dim'").get();
      if (!row) this.db.prepare("INSERT INTO meta(key,value) VALUES('vector_dim',?)").run(String(embedding.length));
      else if (Number(row.value) !== embedding.length)
        throw new Error(`embedding dim mismatch: canonical=${row.value}, got ${embedding.length} from model '${model}'. Refusing to mix dimensions — re-embed or reset 'vector_dim'.`);
    }
    await this.vectorStore.upsert({ id: entryId, embedding, model });
  }

  /** Bump retrieval_count + last_accessed_at for entries that were returned (usage signal).
   *  When maintenance.refreshOnAccess is on, retrieval also RENEWS the entry's lease
   *  (expires_at = now + tier TTL): entries that keep getting used keep living;
   *  entries nobody asks about expire on their tier's TTL (decay-by-disuse). */
  recordRetrieval(ids) {
    if (!ids?.length) return;
    const ts = nowISO();
    const refresh = this.cfg.maintenance?.refreshOnAccess !== false;
    // One tier lookup + one transaction for the whole batch (this runs on every query).
    const ph = ids.map(() => '?').join(',');
    const tiers = new Map(this.db.prepare(`SELECT id, tier FROM entries WHERE id IN (${ph})`).all(...ids).map((r) => [r.id, r.tier]));
    const bump = this.db.prepare('UPDATE entries SET retrieval_count = retrieval_count + 1, last_accessed_at = ? WHERE id = ?');
    const renew = this.db.prepare('UPDATE entries SET expires_at = ? WHERE id = ?');
    this.db.tx(() => {
      for (const id of ids) {
        bump.run(ts, id);
        if (!refresh) continue;
        const tier = this.tier(tiers.get(id));
        if (tier?.ttl) renew.run(new Date(Date.now() + tier.ttl).toISOString(), id);
      }
    });
  }

  /** Feedback loop: nudge trust_score (and helpful_count) up/down. Clamped to [0,1]. */
  recordFeedback(id, helpful = true) {
    const e = this.db.prepare('SELECT trust_score FROM entries WHERE id=?').get(id);
    if (!e) return { success: false, message: `not found: ${id}` };
    const trust = Math.max(0, Math.min(1, (e.trust_score ?? 0.5) + (helpful ? 0.05 : -0.10)));
    this.db.prepare('UPDATE entries SET helpful_count = helpful_count + ?, trust_score = ?, updated_at = ? WHERE id = ?')
      .run(helpful ? 1 : 0, trust, nowISO(), id);
    return { success: true, id, trust_score: Number(trust.toFixed(3)), helpful };
  }

  /** Vector store health: canonical dim (dim-guard) + backend-specific counts.
   *  Delegates to the active backend — the sqlite `vectors` table is empty under qdrant. */
  async vectorHealth() {
    const canonical = this.db.prepare("SELECT value FROM meta WHERE key='vector_dim'").get()?.value;
    const health = await this.vectorStore.health();
    return { ...health, canonicalDim: canonical ? Number(canonical) : null };
  }

  get(id) {
    const r = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
    return r ? this.#hydrate(r) : null;
  }

  /** Entries filtered by tier, scope and project (project + global rule) and — roadmap #43 —
   *  by status: default `['active']` (expired-but-unswept excluded — an expired lease is dead even
   *  before maintenance runs); `statuses:['active','archived']` is the historical read, where the
   *  lease rule applies to active rows only; `asOf` keeps rows that existed at that time. */
  listActive({ tiers = this.tierNames, scopes = null, projects = null, statuses = null, asOf = null } = {}) {
    const st = statuses && statuses.length ? statuses : ['active'];
    const conds = [`status IN (${st.map(() => '?').join(',')})`, "(status != 'active' OR expires_at IS NULL OR expires_at > ?)", `tier IN (${tiers.map(() => '?').join(',')})`];
    const params = [...st, nowISO(), ...tiers];
    if (asOf) { conds.push('created_at <= ?'); params.push(asOf); }
    if (scopes && scopes.length) { conds.push(`scope IN (${scopes.map(() => '?').join(',')})`); params.push(...scopes); }
    const pc = projectClause('project', projects);
    if (pc) { conds.push(pc.sql); params.push(...pc.params); }
    return this.db.prepare(`SELECT * FROM entries WHERE ${conds.join(' AND ')}`).all(...params).map((r) => this.#hydrate(r));
  }

  /** Map of rowid → entry for a tier/scope set (used by retrieval to join FTS hits). */
  rowidMap(tiers = this.tierNames, scopes = null, projects = null, statuses = null, asOf = null) {
    const m = new Map();
    for (const e of this.listActive({ tiers, scopes, projects, statuses, asOf })) m.set(e.rowid, e);
    return m;
  }

  /** Vectors for entries in the given tiers/scopes/projects/statuses: [{id, tier, vector}]. */
  activeVectors(tiers = this.tierNames, scopes = null, projects = null, statuses = null, asOf = null) {
    const st = statuses && statuses.length ? statuses : ['active'];
    const conds = [`e.status IN (${st.map(() => '?').join(',')})`, "(e.status != 'active' OR e.expires_at IS NULL OR e.expires_at > ?)", `e.tier IN (${tiers.map(() => '?').join(',')})`];
    const params = [...st, nowISO(), ...tiers];
    if (asOf) { conds.push('e.created_at <= ?'); params.push(asOf); }
    if (scopes && scopes.length) { conds.push(`e.scope IN (${scopes.map(() => '?').join(',')})`); params.push(...scopes); }
    const pc = projectClause('e.project', projects);
    if (pc) { conds.push(pc.sql); params.push(...pc.params); }
    return this.db.prepare(`
      SELECT v.entry_id id, e.tier tier, v.embedding emb
      FROM vectors v JOIN entries e ON e.id = v.entry_id
      WHERE ${conds.join(' AND ')}
    `).all(...params).map((r) => ({ id: r.id, tier: r.tier, vector: json(r.emb, []) }));
  }

  promote(id, toTier) {
    const tc = this.tier(toTier);
    if (!tc) throw new Error(`unknown tier: ${toTier}`);
    const r = this.db.prepare('SELECT id, project, provenance FROM entries WHERE id=?').get(id);
    if (!r) return { success: false, message: `not found: ${id}` };
    // Single write (one FTS trigger pass); expires_at follows the destination tier's TTL
    // so e.g. a fact promoted to wisdom doesn't carry its 7-day expiry along.
    const expiresAt = tc.ttl ? new Date(Date.now() + tc.ttl).toISOString() : null;
    // Project lift (roadmap #18): a project-tagged entry earning a curated-only tier becomes
    // GLOBAL — that tier is the cross-project lesson set. Lineage is kept (provenance.liftedFrom)
    // so the source project is never lost. Deterministic; off via projectAxis.liftOnCurated=false.
    const lift = this.cfg.projectAxis?.liftOnCurated !== false && tc.curatedOnly && r.project != null;
    if (lift) {
      const prov = { ...json(r.provenance, {}), liftedFrom: { project: r.project, tier: toTier, at: nowISO() } };
      this.db.prepare("UPDATE entries SET tier=?, status='active', expires_at=?, updated_at=?, project=NULL, provenance=? WHERE id=?")
        .run(toTier, expiresAt, nowISO(), JSON.stringify(prov), id);
      return { success: true, message: `promoted ${id} → ${toTier} (lifted from project '${r.project}' to global)`, liftedFrom: r.project };
    }
    this.db.prepare("UPDATE entries SET tier=?, status='active', expires_at=?, updated_at=? WHERE id=?")
      .run(toTier, expiresAt, nowISO(), id);
    return { success: true, message: `promoted ${id} → ${toTier}` };
  }

  async forget(id, { soft = true } = {}) {
    const r = this.db.prepare('SELECT id FROM entries WHERE id=?').get(id);
    if (!r) return { success: false, message: `not found: ${id}` };
    if (soft) {
      this.db.prepare("UPDATE entries SET status='deleted', updated_at=? WHERE id=?").run(nowISO(), id);
    } else {
      await this.vectorStore.delete(id);
      this.db.prepare('DELETE FROM vectors WHERE entry_id=?').run(id); // no-op for qdrant backend
      this.db.prepare('DELETE FROM entries WHERE id=?').run(id);
    }
    return { success: true, message: `${soft ? 'soft-' : ''}deleted ${id}` };
  }

  /** Lifecycle sweep (decay): archive entries whose lease expired, plus entries the
   *  feedback loop has buried (trust below the distrust floor) in non-permanent tiers.
   *  Permanent (ttl 0) tiers like wisdom are untouched by both rules. */
  sweepLifecycle({ distrustBelow = 0 } = {}) {
    const ts = nowISO();
    const expired = this.db.prepare(`
      UPDATE entries SET status='archived', updated_at=? WHERE status='active' AND expires_at IS NOT NULL AND expires_at <= ?
      RETURNING id
    `).all(ts, ts).map((r) => r.id);
    let distrusted = [];
    if (distrustBelow > 0) {
      const ttlTiers = this.cfg.tiers.filter((t) => t.ttl > 0).map((t) => t.name);
      distrusted = this.db.prepare(`
        UPDATE entries SET status='archived', updated_at=? WHERE status='active' AND trust_score < ? AND tier IN (${ttlTiers.map(() => '?').join(',')})
        RETURNING id
      `).all(ts, distrustBelow, ...ttlTiers).map((r) => r.id);
    }
    return { expired, distrusted };
  }

  /** Promotion candidates earned through use (consumes the tiers' autoPromote flag).
   *  fact→memory: enough retrievals OR risen trust. memory→wisdom: explicit helpful
   *  feedback (minHelpful) + sustained use — that feedback IS the curation signal. */
  autoPromoteCandidates(maint) {
    const next = Object.fromEntries(this.tierNames.map((t, i) => [t, this.tierNames[i + 1]]));
    const out = [];
    for (const tc of this.cfg.tiers) {
      if (!tc.autoPromote || !next[tc.name]) continue;
      const target = this.tier(next[tc.name]);
      const rule = target.curatedOnly ? maint.wisdomPromote : maint.factPromote;
      // Lifecycle class (#44): working entries are never promotion candidates, whatever their counts.
      const conds = ["status='active'", 'tier = ?', "(mem_function IS NULL OR mem_function != 'working')"];
      const params = [tc.name];
      if (target.curatedOnly) {
        conds.push('retrieval_count >= ?', 'trust_score >= ?', 'helpful_count >= ?');
        params.push(rule.minRetrievals, rule.minTrust, rule.minHelpful);
      } else {
        conds.push('(retrieval_count >= ? OR trust_score >= ?)');
        params.push(rule.minRetrievals, rule.minTrust);
      }
      for (const r of this.db.prepare(`SELECT id FROM entries WHERE ${conds.join(' AND ')}`).all(...params))
        out.push({ id: r.id, from: tc.name, to: target.name, curated: target.curatedOnly });
    }
    return out;
  }

  archive({ olderThanMs = 30 * 864e5, tiers = null } = {}) {
    // Default to expiring tiers only — never bulk-archive permanent (ttl 0) tiers
    // like wisdom unless the caller names them explicitly.
    if (!tiers || !tiers.length) tiers = this.cfg.tiers.filter((t) => t.ttl > 0).map((t) => t.name);
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const ph = tiers.map(() => '?').join(',');
    const info = this.db.prepare(`
      UPDATE entries SET status='archived', updated_at=? WHERE status='active' AND updated_at < ? AND tier IN (${ph})
    `).run(nowISO(), cutoff, ...tiers);
    return { archived: info.changes, message: `archived ${info.changes} entries` };
  }

  stats() {
    const rows = this.db.prepare("SELECT tier, COUNT(*) c FROM entries WHERE status='active' GROUP BY tier").all();
    const out = {};
    for (const t of this.tierNames) out[t] = 0;
    for (const r of rows) out[r.tier] = r.c;
    return out;
  }

  /** Active-entry counts per project (roadmap #18 open-project listing); `null` key = global. */
  projectStats() {
    const rows = this.db.prepare("SELECT project, COUNT(*) c FROM entries WHERE status='active' GROUP BY project ORDER BY c DESC").all();
    return rows.map((r) => ({ project: r.project ?? null, entries: r.c }));
  }

  #hydrate(r) {
    return {
      ...r, rowid: Number(r.rowid),
      provenance: json(r.provenance), concepts: json(r.concepts),
    };
  }
}
