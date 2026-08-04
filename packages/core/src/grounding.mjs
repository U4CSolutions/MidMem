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

/**
 * Split `items` into {grounded, ungrounded} by content-word overlap with `sourceText`.
 * @param getText maps an item to the string to ground (e.g. c => c.content)
 * @param minOverlap fraction required to be considered grounded (default 0.5)
 * Each returned item carries `groundingScore`.
 */
export function checkGrounding(sourceText, items, getText, minOverlap = 0.5) {
  const hay = new Set(contentWords(sourceText));
  const grounded = [];
  const ungrounded = [];
  for (const it of items || []) {
    const score = Number(scoreAgainst(hay, getText(it)).toFixed(3));
    const rec = { ...it, groundingScore: score };
    (score >= minOverlap ? grounded : ungrounded).push(rec);
  }
  return { grounded, ungrounded };
}
