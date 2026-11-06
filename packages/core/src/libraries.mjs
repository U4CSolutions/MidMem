/**
 * Library lane (roadmap #49) — evidence from external library systems.
 *
 * A library is a SEPARATE system (own repository, own store, own lifecycle) reached through a
 * provider: an in-process ES module exporting `{ search, get }`, or an HTTP service answering
 * `POST <target>/search` and `POST <target>/get` with JSON. The contract is frozen in
 * `test/fixtures/library-provider.json` (midmem-library-provider/1).
 *
 * MidMem only ASKS a registered provider for evidence at the deep stage of retrieval and fuses what
 * comes back: it never stores library rows, never gives them tiers, trust, promotion or decay, and
 * never renews anything for them. With no library registered nothing here runs.
 *
 * `search` is a lane, so it never throws: a provider that throws, times out or answers with
 * something other than a JSON array contributes [] and records `lastError`. Malformed rows are
 * dropped (counted). `get` is an explicit read, so its errors propagate.
 */
import { pathToFileURL } from 'node:url';

const isStr = (v) => typeof v === 'string';
const isInt = (v) => Number.isInteger(v);

/** Validate one provider row against the contract's response shape; returns a clean copy or null. */
function cleanRow(row, providerId) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  if (row.libraryId !== undefined && row.libraryId !== null && !isStr(row.libraryId)) return null;
  if (!isStr(row.docId) || !isStr(row.chunkId) || !isStr(row.text) || !isStr(row.sourceUri)) return null;
  if (typeof row.score !== 'number' || !Number.isFinite(row.score)) return null;
  const loc = row.locator;
  if (!loc || typeof loc !== 'object' || Array.isArray(loc)) return null;
  if (!isStr(loc.docId) || !isInt(loc.version) || !isInt(loc.charStart) || !isInt(loc.charEnd)) return null;
  if (row.capturedAt !== undefined && row.capturedAt !== null && !isStr(row.capturedAt)) return null;
  return {
    // The registry knows which provider answered: a missing or foreign libraryId is overwritten.
    libraryId: providerId,
    docId: row.docId,
    chunkId: row.chunkId,
    text: row.text,
    score: row.score,
    locator: { docId: loc.docId, version: loc.version, charStart: loc.charStart, charEnd: loc.charEnd },
    sourceUri: row.sourceUri,
    ...(isStr(row.capturedAt) ? { capturedAt: row.capturedAt } : {}),
  };
}

/** The contract's tie rule: score desc, then libraryId, docId, chunkId ascending (code-unit order). */
function compareRows(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  for (const k of ['libraryId', 'docId', 'chunkId']) {
    if (a[k] < b[k]) return -1;
    if (a[k] > b[k]) return 1;
  }
  return 0;
}

export class LibraryRegistry {
  /** @param {{libraries?: {id:string, transport:'module'|'http', target:string}[], library?: {limit?:number, timeoutMs?:number}}} cfg */
  constructor(cfg = {}) {
    this.library = cfg.library || {};
    this.providers = (cfg.libraries || []).map((l) => ({
      id: l.id, transport: l.transport, target: l.target,
      lastError: null, calls: 0, dropped: 0, warned: false, mod: null,
    }));
  }

  /** Registered providers with their health counters. */
  list() {
    return this.providers.map(({ id, transport, target, lastError, calls, dropped }) => ({ id, transport, target, lastError, calls, dropped }));
  }

  #timeoutMs() { const t = Number(this.library.timeoutMs); return Number.isFinite(t) && t > 0 ? t : 4000; }

  #fail(p, e) {
    p.lastError = String(e?.message || e);
    if (!p.warned) { p.warned = true; console.error(`[midmem] library '${p.id}' (${p.transport}) failed: ${p.lastError}`); }
  }

  /** Module transport: import once, cache; the module must export search and get functions. */
  async #module(p) {
    if (p.mod) return p.mod;
    const mod = await import(pathToFileURL(p.target).href);
    if (typeof mod.search !== 'function' || typeof mod.get !== 'function') throw new Error(`library module ${p.target} must export search and get functions`);
    p.mod = mod;
    return mod;
  }

  /** HTTP transport: POST <target>/<verb> with a JSON body, bounded by the timeout. */
  async #post(p, verb, body) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(`timed out after ${this.#timeoutMs()} ms`)), this.#timeoutMs());
    try {
      const res = await fetch(`${p.target.replace(/\/+$/, '')}/${verb}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal,
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { throw new Error(`${verb} answered non-JSON (HTTP ${res.status})`); }
      if (!res.ok) throw new Error(data?.error ? String(data.error) : `${verb} answered HTTP ${res.status}`);
      return data;
    } finally { clearTimeout(timer); }
  }

  /** Bound an in-process call by the same timeout the HTTP transport uses. */
  async #bounded(promise) {
    let timer;
    const t = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${this.#timeoutMs()} ms`)), this.#timeoutMs()); });
    try { return await Promise.race([promise, t]); } finally { clearTimeout(timer); }
  }

  async #searchOne(p, query, limit, filters) {
    p.calls++;
    try {
      let rows;
      if (p.transport === 'module') {
        const mod = await this.#module(p);
        rows = await this.#bounded(Promise.resolve().then(() => mod.search(query, { limit, filters })));
      } else if (p.transport === 'http') {
        rows = await this.#post(p, 'search', { query, limit, filters });
      } else throw new Error(`unknown library transport: ${p.transport}`);
      if (!Array.isArray(rows)) throw new Error('search did not return an array');
      const out = [];
      for (const r of rows) { const c = cleanRow(r, p.id); if (c) out.push(c); else p.dropped++; }
      p.lastError = null;
      return out;
    } catch (e) { this.#fail(p, e); return []; }
  }

  /**
   * Ask the selected providers for evidence. `libraries`: null = every registered provider, an
   * array = only those ids, false = none. Never throws; returns at most `limit` rows, merged and
   * ordered by the contract's tie rule.
   */
  async search(query, { limit, filters = null, libraries = null } = {}) {
    if (libraries === false || !this.providers.length) return [];
    const chosen = Array.isArray(libraries) ? this.providers.filter((p) => libraries.includes(p.id)) : this.providers;
    if (!chosen.length) return [];
    const n = Number.isInteger(limit) && limit > 0 ? limit : (Number(this.library.limit) || 8);
    const parts = await Promise.all(chosen.map((p) => this.#searchOne(p, query, n, filters)));
    return parts.flat().sort(compareRows).slice(0, n);
  }

  /** Explicit read of one document range from one library; errors propagate. */
  async get(libraryId, docId, locator) {
    const p = this.providers.find((x) => x.id === libraryId);
    if (!p) throw new Error(`unknown library: ${libraryId}`);
    p.calls++;
    if (p.transport === 'module') return (await this.#module(p)).get(docId, locator);
    if (p.transport === 'http') return this.#post(p, 'get', { docId, locator });
    throw new Error(`unknown library transport: ${p.transport}`);
  }
}
