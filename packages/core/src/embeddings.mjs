/**
 * Embedder — vectors for hybrid RAG.
 *
 * Primary: LM Studio OpenAI-compatible /embeddings (plumbing proven in the
 * scaffold's semantic-cache). Fallback: a deterministic hashed term vector so
 * the pipeline is fully testable offline and when the local model saturates.
 * Same interface either way; callers never branch on availability.
 *
 * Retries (2026-10-19). Measured: one agent process wrote 37 placeholder vectors in a day after SINGLE
 * embed timeouts, while CLI ingests in the same hours embedded normally — the box was busy, not down.
 * A transport error, a timeout or a 5xx / 429 answer is now retried up to `embedRetries` times
 * (MIDMEM_EMBED_RETRIES, default 2) with backoff `embedRetryMs × 2^attempt` (MIDMEM_EMBED_RETRY_MS,
 * default 250 ms) before the fallback; any other 4xx is the request's fault, not the box's, and falls
 * back at once, as does an answer without a vector. Every result records `attempts`; a fallback names
 * its `reason` ('disabled' | 'timeout' | 'unreachable' | 'http-<status>' | 'no-vector'). Each attempt
 * has the full `llmTimeoutMs`, so a hung box costs (embedRetries + 1) timeouts per embed.
 */
import { tokenize } from './util.mjs';

/** Worth another attempt: the box is busy or briefly away (5xx, 429, a timeout, a refused connection). */
const retryable = (reason) => reason === 'timeout' || reason === 'unreachable' || /^http-(5\d\d|429)$/.test(reason);

export class Embedder {
  /** @param {ReturnType<import('./config.mjs').loadConfig>} cfg */
  constructor(cfg) {
    this.cfg = cfg;
    this.lastMode = 'unknown';
  }

  /** @returns {Promise<{vector:number[], model:string, mode:'lmstudio'|'fallback', attempts:number, reason?:string}>} */
  /** `retries` overrides the knob per call: retrieval and the concept refresh pass 0 — a query must
   *  not wait (retries+1) timeouts on a hung box, and a fallback query vector still serves the lexical
   *  lanes; the retries are for WRITES, where a placeholder vector would otherwise persist. */
  async embed(text, { retries: retriesOpt } = {}) {
    let attempts = 0;
    let reason = 'disabled';
    if (this.cfg.llmEnabled) {
      // A missing / non-numeric knob (an embedded host's partial cfg) keeps the defaults, never NaN loops.
      const retries = Number.isFinite(retriesOpt) ? Math.max(0, Math.floor(retriesOpt)) : (Number.isFinite(this.cfg.embedRetries) ? Math.max(0, Math.floor(this.cfg.embedRetries)) : 2);
      const backoff = Number.isFinite(this.cfg.embedRetryMs) ? Math.max(0, this.cfg.embedRetryMs) : 250;
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, backoff * 2 ** (attempt - 1)));
        attempts++;
        const r = await this.#remote(text);
        if (r.ok) { this.lastMode = 'lmstudio'; return { vector: r.vector, model: this.cfg.embedModel, mode: 'lmstudio', attempts }; }
        reason = r.reason;
        if (!retryable(reason)) break;
      }
    }
    this.lastMode = 'fallback';
    return { vector: this.#fallback(text), model: `fallback-hash-${this.cfg.fallbackDim}`, mode: 'fallback', attempts, reason };
  }

  /** One /embeddings call → `{ ok: true, vector }` or `{ ok: false, reason }`. */
  async #remote(text) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.cfg.llmTimeoutMs);
    try {
      const res = await fetch(`${this.cfg.llmEndpoint}/embeddings`, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.cfg.embedModel, input: text.slice(0, 8000) }),
      });
      if (!res.ok) return { ok: false, reason: `http-${res.status}` };
      // A body that is not JSON is an answer without a vector (no retry) — unless the timer cut it off.
      let data;
      try { data = await res.json(); } catch { return { ok: false, reason: ctrl.signal.aborted ? 'timeout' : 'no-vector' }; }
      const v = data?.data?.[0]?.embedding;
      return Array.isArray(v) && v.length ? { ok: true, vector: v } : { ok: false, reason: 'no-vector' };
    } catch { return { ok: false, reason: ctrl.signal.aborted ? 'timeout' : 'unreachable' }; }
    finally { clearTimeout(t); }
  }

  /** Deterministic hashed bag-of-words vector, L2-normalized. */
  #fallback(text) {
    const dim = this.cfg.fallbackDim;
    const v = new Array(dim).fill(0);
    for (const tok of tokenize(text)) {
      let h = 0;
      for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) | 0;
      v[((h % dim) + dim) % dim] += 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}
