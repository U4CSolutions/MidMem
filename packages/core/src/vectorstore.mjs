/**
 * Vector store abstraction — pluggable ANN backend.
 *
 * `state.db` remains the source of truth for ALL metadata (tier/scope/status/trust);
 * the vector store holds only `entry_id → embedding` and returns similarity-ranked ids.
 * Retrieval then filters those ids against the live `entries` table. This keeps the two
 * backends symmetric and avoids payload/status sync.
 *
 *  - `sqlite`  : vectors as JSON in state.db + JS cosine. Zero-dep, default.
 *  - `qdrant`  : external Qdrant (REST, v1.19.x API). Dense cosine collection, `store_id` tenant key.
 *              Built against the published OpenAPI + a faithful fake; ⚠ not yet validated on a live instance.
 *
 * Interface (all async): upsert({id,embedding,model}) · delete(id) · search(vec,limit) → [{id,score}] · health()
 * (Qdrant adds upsertMany(rows) and count() for the backfill/parity path.)
 */
import { createHash } from 'node:crypto';
import { cosine, json, nowISO } from './util.mjs';

// ── SQLite backend (default) ────────────────────────────────────────────────
export class SqliteVectorStore {
  constructor(db) { this.db = db; this.backend = 'sqlite'; }

  async upsert({ id, embedding, model }) {
    this.db.prepare(`
      INSERT INTO vectors(entry_id,dim,embedding,model,created_at) VALUES(?,?,?,?,?)
      ON CONFLICT(entry_id) DO UPDATE SET dim=excluded.dim, embedding=excluded.embedding, model=excluded.model
    `).run(id, embedding.length, JSON.stringify(embedding), model, nowISO());
  }

  async delete(id) { this.db.prepare('DELETE FROM vectors WHERE entry_id=?').run(id); }

  async search(queryVector, limit = 400) {
    return this.db.prepare('SELECT entry_id id, embedding emb FROM vectors').all()
      .map((r) => ({ id: r.id, score: cosine(queryVector, json(r.emb, [])) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async health() {
    const byDim = this.db.prepare('SELECT dim, COUNT(*) c FROM vectors GROUP BY dim').all();
    const fallback = this.db.prepare("SELECT COUNT(*) c FROM vectors WHERE model LIKE 'fallback%'").get().c;
    return { backend: 'sqlite', byDim: Object.fromEntries(byDim.map((r) => [r.dim, r.c])), fallbackVectors: fallback };
  }
}

// Qdrant point ids must be uint64 or UUID; hash our string entry_id into a 52-bit safe int.
export const pointId = (s) => parseInt(createHash('sha1').update(s).digest('hex').slice(0, 13), 16);

// ── Qdrant backend (external ANN), built to the v1.19.x REST API (docs/redoc/v1.19.x, read
//    2026-09-24): search is `POST /points/query` (`/points/search` was removed in 1.19), one
//    unnamed Cosine vector per point, payload `{ entry_id, store_id, model }`. Tenant key (#51):
//    `store_id` has a keyword index created `is_tenant: true` and every search filters on it, so
//    one collection per embedding space can hold several stores. Default OFF
//    (MIDMEM_VECTOR_BACKEND=qdrant to enable); `backfillVectors` + `vectorParity` are the
//    migration path from the SQLite vectors (#50). ──
export class QdrantVectorStore {
  constructor(cfg) {
    this.url = (cfg.qdrantUrl || 'http://localhost:6333').replace(/\/$/, '');
    this.collection = cfg.qdrantCollection || 'midmem_memory';
    this.apiKey = cfg.qdrantApiKey || '';
    this.storeId = cfg.storeId || 'default';
    this.timeoutMs = Number(cfg.qdrant?.timeoutMs) > 0 ? Number(cfg.qdrant.timeoutMs) : 5000;
    this.batch = Number(cfg.qdrant?.batch) > 0 ? Math.floor(Number(cfg.qdrant.batch)) : 100;
    this.backend = 'qdrant';
    this._ready = false;
  }

  /** The tenant filter pushed into every search/count (#51). */
  #storeFilter() { return { must: [{ key: 'store_id', match: { value: this.storeId } }] }; }

  /** One REST call. An HTTP error carries `.status` (the server answered); a connection error or
   *  a timeout carries none (the server is unreachable). */
  async #req(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['api-key'] = this.apiKey;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.url}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ac.signal });
      if (!res.ok) {
        const e = new Error(`qdrant ${method} ${path} → ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
        e.status = res.status;
        throw e;
      }
      return await res.json();
    } catch (e) {
      if (e?.status) throw e;
      const cause = e?.name === 'AbortError' ? `timeout after ${this.timeoutMs} ms` : (e?.cause?.code || e?.cause?.message || e?.message || String(e));
      throw new Error(`qdrant ${method} ${path} → unreachable (${cause})`);
    } finally { clearTimeout(timer); }
  }

  /** Collection (Cosine, `dim`) + the `store_id` tenant index; ready only after both. */
  async #ensure(dim) {
    if (this._ready) return;
    const c = `/collections/${this.collection}`;
    try { await this.#req('GET', c); }
    catch (e) {
      if (e.status !== 404) throw e;
      try { await this.#req('PUT', c, { vectors: { size: dim, distance: 'Cosine' } }); }
      catch (e2) { if (!(e2.status === 409 || (e2.status >= 400 && e2.status < 500 && /already exists/i.test(e2.message)))) throw e2; } // created concurrently by another store
    }
    try { await this.#req('PUT', `${c}/index?wait=true`, { field_name: 'store_id', field_schema: { type: 'keyword', is_tenant: true } }); }
    catch (e) { if (!(e.status >= 400 && e.status < 500 && /already exists/i.test(e.message))) throw e; }
    this._ready = true;
  }

  #point({ id, embedding, model }) {
    // Unnamed-vector collection: the vector MUST be a plain number array (a named-vector object is
    // silently dropped by some releases) — refuse anything else before it reaches the wire.
    if (!Array.isArray(embedding)) throw new Error(`qdrant upsert: embedding for ${id} must be a plain number array`);
    return { id: pointId(id), vector: embedding, payload: { entry_id: id, store_id: this.storeId, model: model ?? null } };
  }

  async upsert({ id, embedding, model }) {
    const point = this.#point({ id, embedding, model }); // throws on a non-array embedding
    // Fail-soft: a down/misconfigured Qdrant must not block the state.db write (the source of
    // truth). The entry is still stored + lexically searchable; vectors index once Qdrant is up.
    try {
      await this.#ensure(embedding.length);
      await this.#req('PUT', `/collections/${this.collection}/points?wait=true`, { points: [point] });
    } catch (e) {
      if (!this._warned) { console.error(`[vectorstore:qdrant] upsert failed (${e.message}) — entries stored in state.db but not vector-indexed until Qdrant is reachable; check 'brief'.vectors`); this._warned = true; }
    }
  }

  /** Batched upsert (backfill): one `PUT /points` per `batch` rows. THROWS on the first failing
   *  batch so the caller stops there. Returns the number of points sent. */
  async upsertMany(rows) {
    if (!rows?.length) return 0;
    const points = rows.map((r) => this.#point(r));
    await this.#ensure(rows[0].embedding.length);
    let sent = 0;
    for (let i = 0; i < points.length; i += this.batch) {
      const chunk = points.slice(i, i + this.batch);
      await this.#req('PUT', `/collections/${this.collection}/points?wait=true`, { points: chunk });
      sent += chunk.length;
    }
    return sent;
  }

  async delete(id) {
    try { await this.#req('POST', `/collections/${this.collection}/points/delete?wait=true`, { points: [pointId(id)] }); } catch {}
  }

  async search(queryVector, limit = 400) {
    try {
      const r = await this.#req('POST', `/collections/${this.collection}/points/query`,
        { query: queryVector, limit, with_payload: true, filter: this.#storeFilter() });
      return (r.result?.points || []).map((p) => ({ id: p.payload?.entry_id || String(p.id), score: p.score }));
    } catch { return []; } // fail soft → lexical lanes still answer
  }

  /** Points this store holds in the collection (tenant-filtered, exact); null when unknown. */
  async count() {
    try {
      const r = await this.#req('POST', `/collections/${this.collection}/points/count`, { filter: this.#storeFilter(), exact: true });
      return r.result?.count ?? null;
    } catch { return null; }
  }

  /** Never throws. `reachable` = the server answered at all (an auth or HTTP error still counts);
   *  a missing collection is reported as `exists: false` with zero points (created on first upsert). */
  async health() {
    const base = { backend: 'qdrant', url: this.url, collection: this.collection, storeId: this.storeId };
    try {
      const r = await this.#req('GET', `/collections/${this.collection}`);
      return { ...base, reachable: true, exists: true, points: r.result?.points_count ?? null, storePoints: await this.count() };
    } catch (e) {
      if (e.status === 404) return { ...base, reachable: true, exists: false, points: 0, storePoints: 0 };
      return { ...base, reachable: !!e.status, exists: null, points: null, storePoints: null, error: e.message };
    }
  }
}

export function makeVectorStore(cfg, db) {
  return cfg.vectorBackend === 'qdrant' ? new QdrantVectorStore(cfg) : new SqliteVectorStore(db);
}
