/**
 * Extraction grounding — DELEGATE-52 safeguard.
 *
 * Deterministically verifies that LLM-extracted concepts/claims actually appear in the source
 * text before they persist into state.db. Catches confabulated or drifted extractions WITHOUT
 * asking a (possibly degraded) LLM to self-verify — the DELEGATE-52 benchmark (MSR) shows models
 * confidently report faithful capture while having silently corrupted content. Pure token overlap;
 * no model, no network. The vault projection is deterministic and needs no such check — the risk
 * is what the LLM writes INTO state.db (ingest extraction), not the projection out of it.
 */

const STOP = new Set((
  'the a an of to in on for and or but is are was were be been being with by as at from this that '
  + 'these those it its their our your his her not no can will would should may might must has have '
  + 'had do does did then than so if into over under out up down about more most some any not all'
).split(/\s+/));

/** Content words: lowercased alnum tokens > 2 chars, minus stopwords. */
export function contentWords(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

function scoreAgainst(haySet, phrase) {
  const w = contentWords(phrase);
  if (!w.length) return 1; // nothing groundable (degenerate) — don't penalize
  let hit = 0;
  for (const t of w) if (haySet.has(t)) hit++;
  return hit / w.length;
}

/** Fraction of `phrase` content-words present in `sourceText` (0..1; empty phrase → 1). */
export function groundingScore(sourceText, phrase) {
  return scoreAgainst(new Set(contentWords(sourceText)), phrase);
}

/** Numbers a unit-drift check reads: integer or decimal, optional sign, never inside a word or id. */
const NUMBER_RE = /(?<![\w.])[+-]?\d+(?:\.\d+)?/g;
/** The unit token right after a number: a spaced or hyphenated word unit, `%`, `×`, or a glued `x`
 *  (`2.2x`, never `2x2` or `2 x 3`, which are dimensions). */
/** One hyphenated compound modifier may sit between the number and a word unit — the measured
 *  phrase was "15.9 success-rate points" — so `15.9 success-rate points`, `4.1 pass-rate points` read as
 *  points. Plain words are NOT skipped (`2 key points` is a count, not a unit), and nothing may precede
 *  `%` or a glued `x`. */
const UNIT_RE = /^(?:\s*-?\s*(?:[a-z0-9]+(?:-[a-z0-9]+)+\s+)?(%|percentage[\s-]+points?\b|percent\b|pct\b|points?\b|pp\b|×)|(x)(?![a-z0-9]))/i;
const unitClass = (u) => {
  const l = u.toLowerCase();
  if (l === '%' || l === 'percent' || l === 'pct') return 'percent';
  if (l === '×' || l === 'x') return 'multiplier';
  return 'points'; // point(s), pp, percentage point(s)
};
function numbersWithUnits(text) {
  const s = String(text || '');
  const out = [];
  for (const m of s.matchAll(NUMBER_RE)) {
    const end = m.index + m[0].length;
    const u = UNIT_RE.exec(s.slice(end, end + 32));
    const unit = u ? (u[1] || u[2]).replace(/\s+/g, ' ') : null;
    out.push({ number: Number(m[0]), magnitude: Math.abs(Number(m[0])), unit, cls: unit ? unitClass(unit) : null });
  }
  return out;
}
/**
 * Unit drift (2026-10-12). Token overlap cannot see a number whose UNIT changed: measured, the
 * extractor turned "15.9 success-rate points" into "15.9 % higher success rates" and the overlap check
 * passed it at 0.40 — the words were all there, the meaning was not. Deterministic: every number in
 * the claim (integer or decimal, optional sign) is read with the unit token right after it, as is every
 * occurrence of the same number (by magnitude) in the source. Three unit classes — percent (`%`,
 * `percent`, `pct`), points (`points`, `point`, `pp`, `percentage points`) and multiplier (`×`, or an
 * `x` glued to the number: `2.2x`) — and a claim unit whose class NO source occurrence shares, while
 * some source occurrence carries another class, is a drift. A number absent from the source, or
 * unitless on either side, is not this check's job (the overlap check handles absence).
 * The unit is the token right after the number, or right after ONE hyphenated compound modifier
 * ("15.9 success-rate points"); a plain word between them ("2 key points") is not skipped.
 * Returns [{ number, claimUnit, sourceUnit }] (empty = no drift).
 */
export function unitDrift(sourceText, claimText) {
  const src = numbersWithUnits(sourceText).filter((x) => x.cls);
  const drifts = [];
  const seen = new Set();
  for (const c of numbersWithUnits(claimText)) {
    if (!c.cls) continue;
    const same = src.filter((x) => x.magnitude === c.magnitude);
    if (!same.length || same.some((x) => x.cls === c.cls)) continue;
    const key = `${c.number}|${c.unit}`;
    if (seen.has(key)) continue;
    seen.add(key);
    drifts.push({ number: c.number, claimUnit: c.unit, sourceUnit: same[0].unit });
  }
  return drifts;
}

/** Markdown structure a claim never starts with: an ATX heading, a table row, a block quote, a bullet
 *  with a bold lead (`- **Owner:** …`), a `* ` bullet, a bold lead-in, an italic-wrapped lead-in
 *  (`*Backlog check* — …`), a numbered item with a bold lead (`2. **Step**`), a code fence. */
const STRUCTURE_LEAD_RE = /^(?:#|\||>|- \*\*|\* |\*\*|\*[^*\s][^*]*\*|\d+[.)]\s*\*\*|```|~~~)/;
/** Label lines from session/log templates — a field name, not a statement. Case-sensitive on purpose:
 *  prose about "the session key" stays a claim; the Title-cased label and the bold form do not. */
const LABEL_RE = /Session Key|Session ID|\*\*Session/;
/**
 * Claim shape (2026-10-19). Measured: with the model timing out, the fallback extractor turned the first
 * five "sentences" of a markdown file into claims — headings, table rows, bullets, session-log labels —
 * and 125 such fragments were live, colliding with real claims as false contradictions. Token overlap
 * cannot see this (a heading copied from the source is perfectly grounded), so the shape is its own
 * deterministic check. False when the trimmed text opens with markdown structure (STRUCTURE_LEAD_RE),
 * carries a session-label (LABEL_RE), has fewer than 3 words, has no letter, or is more than 60 %
 * non-alphabetic (whitespace excluded — it separates words, it is not content: a run of ids, dates
 * and numbers is a log line, not a statement). A plain sentence with `**bold**` mid-way, or one that
 * starts with a number, is a claim. No model, no config: same text, same verdict.
 */
export function isClaimShaped(text) {
  const t = String(text ?? '').trim();
  if (!t || STRUCTURE_LEAD_RE.test(t) || LABEL_RE.test(t)) return false;
  if (t.split(/\s+/).length < 3) return false;
  const chars = t.replace(/\s+/g, '');
  const letters = (chars.match(/\p{L}/gu) || []).length;
  return letters > 0 && (chars.length - letters) / chars.length <= 0.6;
}

/**
 * Split `items` into {grounded, ungrounded} by content-word overlap with `sourceText`.
 * @param getText maps an item to the string to ground (e.g. c => c.content)
 * @param minOverlap fraction required to be considered grounded (default 0.5)
 * @param opts.unitCheck the source text to check numbers' units against (claims): an item that passes
 *   the overlap but carries a unit drift is quarantined too, with `reason: 'unit-drift'` + `unitDrift`
 *   (the details). Off when omitted, so concept checks are unchanged.
 * @param opts.claimShape true for claims (2026-10-19): an item that is not `isClaimShaped` is quarantined
 *   BEFORE the overlap check, with `reason: 'not-a-claim'` — a grounded heading is still not a claim.
 *   Off when omitted (concept names are short labels by design).
 * Each returned item carries `groundingScore`; `unitDrift` counts the items quarantined for a drift,
 * `notClaim` those quarantined for their shape.
 */
export function checkGrounding(sourceText, items, getText, minOverlap = 0.5, { unitCheck = null, claimShape = false } = {}) {
  const hay = new Set(contentWords(sourceText));
  const grounded = [];
  const ungrounded = [];
  let drifted = 0, notClaim = 0;
  for (const it of items || []) {
    const text = getText(it);
    const score = Number(scoreAgainst(hay, text).toFixed(3));
    const rec = { ...it, groundingScore: score };
    if (claimShape && !isClaimShaped(text)) { notClaim++; ungrounded.push({ ...rec, reason: 'not-a-claim' }); continue; }
    if (score < minOverlap) { ungrounded.push(rec); continue; }
    const drift = typeof unitCheck === 'string' ? unitDrift(unitCheck, text) : [];
    if (drift.length) { drifted++; ungrounded.push({ ...rec, reason: 'unit-drift', unitDrift: drift }); continue; }
    grounded.push(rec);
  }
  return { grounded, ungrounded, unitDrift: drifted, notClaim };
}
