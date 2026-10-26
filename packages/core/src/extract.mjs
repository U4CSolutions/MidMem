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
 * Claims of either mode pass `isClaimShaped` (grounding.mjs, 2026-10-19): a heading, table row, bullet
 * lead or session label never leaves the extractor as a claim; `droppedFragments` counts the ones refused.
 */
import { tokenize } from './util.mjs';
import { isClaimShaped } from './grounding.mjs';

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

  /**
   * Is the extraction endpoint up? (2026-10-19, for the forced maintain's reextract batch.) A cheap
   * `GET <endpoint>/models` — the listing every OpenAI-compatible server serves — never a model call:
   * the probe must not cost a completion. Bounded by min(llmTimeoutMs, 5 s), so a hung box costs one
   * short wait, not a full extraction timeout. `{ ok }` or `{ ok: false, reason }` with the extractor's
   * own reason vocabulary ('disabled' | 'timeout' | 'unreachable' | 'http-<status>').
   */
  async reachable() {
    if (!this.cfg.llmEnabled) return { ok: false, reason: 'disabled' };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), Math.min(this.cfg.llmTimeoutMs, 5000));
    try {
      const res = await fetch(`${this.cfg.llmEndpoint}/models`, { signal: ctrl.signal });
      await res.arrayBuffer().catch(() => {}); // drain: no dangling socket in a short-lived CLI
      return res.ok ? { ok: true } : { ok: false, reason: `http-${res.status}` };
    } catch { return { ok: false, reason: ctrl.signal.aborted ? 'timeout' : 'unreachable' }; }
    finally { clearTimeout(t); }
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
      // A model echoes markdown too (a heading as a "claim"): the shape check runs on the model path as on the fallback.
      const said = Array.isArray(obj.claims) ? obj.claims.filter(stated) : [];
      const claims = said.filter((c) => isClaimShaped(c.content));
      return { ok: true, value: {
        summary: obj.summary.slice(0, 2000),
        concepts: Array.isArray(obj.concepts) ? obj.concepts.filter(named).slice(0, 50) : [],
        claims: claims.slice(0, 50),
        droppedFragments: said.length - claims.length,
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
    // Claims: the first five claim-shaped sentences (2026-10-19). A fragment on the way is skipped and
    // counted, never stored — measured, the first five "sentences" of a markdown file were headings,
    // table rows and bullets, and they later collided with real claims as false contradictions.
    const claims = [];
    let droppedFragments = 0;
    for (const s of claimCandidates(text)) {
      if (claims.length >= 5) break;
      if (isClaimShaped(s)) claims.push({ content: s.trim(), confidence: 0.5 }); else droppedFragments++;
    }
    return { summary, concepts: [...concepts, ...caps].slice(0, 16), claims, droppedFragments };
  }
}

/** Markdown lines that open a block of their own (a bullet, a quote, a numbered item) — and the two
 *  that are a whole block by themselves (an ATX heading, a table row). */
const BLOCK_OPEN_RE = /^\s*(?:>|[-*+]\s|\d+[.)]\s)/;
const BLOCK_LINE_RE = /^\s*(?:#|\|)/;
const FENCE_RE = /^\s*(?:```|~~~)/;
/**
 * Fallback claim candidates (2026-10-19): sentences WITHIN markdown blocks, never across them. Collapsing
 * every newline first glued a heading onto the sentence after it ("# Title The first real sentence."),
 * so refusing the heading's shape would have thrown the real sentence away with it. A blank line, a
 * heading or table row (each a block alone), or a line opening a bullet / quote / numbered item ends
 * the current block; any other line continues it, so hard-wrapped prose stays one sentence. Fenced code
 * is skipped whole — code is never a claim. Same length floor as the summary's sentences.
 */
function claimCandidates(text) {
  const blocks = [];
  let cur = [];
  let fenced = false;
  const flush = () => { if (cur.length) blocks.push(cur.join(' ')); cur = []; };
  for (const line of String(text).split(/\r?\n/)) {
    if (FENCE_RE.test(line)) { flush(); fenced = !fenced; continue; }
    if (fenced) continue;
    if (!line.trim()) { flush(); continue; }
    // A heading or table row is never a claim candidate (2026-10-26): kept as its own block it was split
    // at a '?' or '.' inside the title ("### 2. Title: …" → "Title: …"), and the piece without the '#'
    // passed the shape check as a sentence — a paper's title became a live claim.
    if (BLOCK_LINE_RE.test(line)) { flush(); continue; }
    if (BLOCK_OPEN_RE.test(line)) flush();
    cur.push(line.trim());
  }
  flush();
  return blocks.flatMap((b) => b.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/)).filter((s) => s.trim().length > 15);
}
