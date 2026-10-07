/**
 * Extractor — turns raw source text into {summary, concepts, claims}.
 *
 * Primary: LM Studio chat completion (JSON-instructed). Fallback: deterministic
 * heuristics so ingest works offline / under model saturation. The scaffold did
 * extraction with regex only and never called an LLM at all.
 *
 * Every result names its `mode` ('lmstudio' | 'fallback') and `model` (the extraction model, or
 * null for the heuristics); a fallback also names its `reason` ('disabled' | 'unreachable' |
 * 'timeout' | 'http-<status>' | 'no-content' | 'unparseable'), so a caller that must never let a
 * fallback overwrite model output (`reextract`) can tell a model that is down from one bad answer.
 * A reasoning model (LM Studio returns its thinking in `message.reasoning_content`) needs nothing
 * special: the JSON answer is in `message.content`; an inline <think>…</think> block is dropped.
 */
import { tokenize } from './util.mjs';

const SYS = `You extract structured knowledge. Return ONLY minified JSON:
{"summary":"1-3 sentences","concepts":[{"name":"","type":"concept|entity|tool|person|org","confidence":0..1}],"claims":[{"content":"one factual claim","confidence":0..1}]}`;

export class Extractor {
  constructor(cfg) { this.cfg = cfg; this.lastMode = 'unknown'; }

  /** @returns {Promise<{summary:string, concepts:Array, claims:Array, mode:string, model:string|null, reason?:string}>} */
  async extract(text, type = 'note') {
    let reason = 'disabled';
    if (this.cfg.llmEnabled) {
      const r = await this.#remote(text, type);
      if (r.ok) { this.lastMode = 'lmstudio'; return { ...r.value, mode: 'lmstudio', model: this.cfg.extractModel }; }
      reason = r.reason;
    }
    this.lastMode = 'fallback';
    return { ...this.#fallback(text), mode: 'fallback', model: null, reason };
  }

  /** One chat completion → `{ ok: true, value }` or `{ ok: false, reason }`. An answer without a
   *  non-empty string summary is unparseable (it would store an empty entry); concept and claim items
   *  that are not `{name}` / `{content}` objects with string text are dropped. */
  async #remote(text, type) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.cfg.llmTimeoutMs);
    const fail = (reason) => ({ ok: false, reason });
    try {
      const res = await fetch(`${this.cfg.llmEndpoint}/chat/completions`, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.cfg.extractModel, temperature: 0,
          messages: [{ role: 'system', content: SYS },
            { role: 'user', content: `type=${type}\n\n${text.slice(0, 12000)}` }],
        }),
      });
      if (!res.ok) return fail(`http-${res.status}`);
      let data;
      try { data = await res.json(); } catch { return fail(ctrl.signal.aborted ? 'timeout' : 'unparseable'); }
      const raw = data?.choices?.[0]?.message?.content;
      if (typeof raw !== 'string' || !raw.trim()) return fail('no-content');
      const m = raw.replace(/<think>[\s\S]*?<\/think>/g, '').match(/\{[\s\S]*\}/);
      if (!m) return fail('unparseable');
      let obj;
      try { obj = JSON.parse(m[0]); } catch { return fail('unparseable'); }
      if (!obj || typeof obj !== 'object' || typeof obj.summary !== 'string' || !obj.summary.trim()) return fail('unparseable');
      const named = (c) => c && typeof c === 'object' && typeof c.name === 'string' && c.name.trim();
      const stated = (c) => c && typeof c === 'object' && typeof c.content === 'string' && c.content.trim();
      return { ok: true, value: {
        summary: obj.summary.slice(0, 2000),
        concepts: Array.isArray(obj.concepts) ? obj.concepts.filter(named).slice(0, 50) : [],
        claims: Array.isArray(obj.claims) ? obj.claims.filter(stated).slice(0, 50) : [],
      } };
    } catch { return fail(ctrl.signal.aborted ? 'timeout' : 'unreachable'); }
    finally { clearTimeout(t); }
  }

  /** Deterministic heuristic extraction (no LLM). */
  #fallback(text) {
    const sentences = text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 15);
    const summary = sentences.slice(0, 2).join(' ').slice(0, 600) || text.slice(0, 300);
    // frequent tokens → concepts; Capitalized words → entity candidates
    const freq = new Map();
    for (const t of tokenize(text)) freq.set(t, (freq.get(t) || 0) + 1);
    const concepts = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([name, n]) => ({ name, type: 'concept', confidence: Math.min(0.5 + n / 50, 0.9) }));
    const caps = [...new Set((text.match(/\b[A-Z][a-zA-Z0-9]{2,}\b/g) || []))].slice(0, 8)
      .map((name) => ({ name, type: 'entity', confidence: 0.5 }));
    const claims = sentences.slice(0, 5).map((content) => ({ content: content.trim(), confidence: 0.5 }));
    return { summary, concepts: [...concepts, ...caps].slice(0, 16), claims };
  }
}
