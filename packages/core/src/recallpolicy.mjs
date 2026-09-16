/**
 * Recall policy (roadmap 2026-09 #39 / #40 / #42) — three deterministic rules that shape WHAT a
 * budgeted recall returns. They run after ranking and before the token budget, so ranking stays
 * one concern and "what may reach a prompt" another. No LLM anywhere in this path.
 *
 *  - Instruction-likeness (#40, InjecMEM 2608.23471): flag text that is shaped like an
 *    instruction TO the agent (override/reveal phrasing, role markers, tool-call syntax,
 *    secrecy-from-the-user or secret-exfiltration asks). Flagged rows are demoted and labelled,
 *    never silently dropped — the consumer drops by name and counts. Ordinary imperative lessons
 *    ("never restart the gateway from inside the agent") are NOT instruction-like: the patterns
 *    target injection shapes, not advice.
 *  - Fidelity class (#42, Compaction Cliff 2608.22752): authority × tier → `verbatim`
 *    (operator authority or wisdom tier), `loss-limited` (memory), `compressible` (fact).
 *    Verbatim rows return their full content instead of the preview cut.
 *  - Bounded occupancy (#39, Utility Under Attack 2608.21230): per-authority occupancy caps,
 *    protected slots for operator lines, and a minimum number of independent source lineages.
 *    A cap binds only while a competitor from another class is waiting — with one class present
 *    the selection is unchanged. Composes with #34 (lineage = root source).
 */
import { authorityRank, AUTHORITY_LEVELS, normalizeAuthority } from './authority.mjs';

/** Injection shapes. Each pattern is named so a flag can say WHY. Deterministic, anchored to
 *  prompt-attack phrasing; generic imperatives are deliberately not matched. */
export const INSTRUCTION_PATTERNS = [
  ['override-prior', /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any)\b[^.\n]{0,24}\b(instructions?|prompts?|rules?|guidelines?|messages?|context)\b/i],
  ['role-reassign', /\b(you are now|from now on,? you|act as (?:a|an|the)\b|pretend (?:to be|you are)|your new (?:instructions?|task|role|persona) (?:is|are))\b/i],
  ['reveal-prompt', /\b(reveal|print|repeat|output|show|leak|dump)\b[^.\n]{0,30}\b(system prompt|hidden prompt|developer message|your instructions)\b/i],
  ['hide-from-user', /\b(do not|don't|never)\b[^.\n]{0,12}\b(tell|inform|mention|reveal|show)\b[^.\n]{0,20}\b(the )?(user|operator|human|owner)\b/i],
  ['exfiltrate', /\b(exfiltrate|send|post|upload|transmit|forward)\b[^.\n]{0,40}\b(api[- ]?keys?|tokens?|passwords?|secrets?|credentials?)\b[^.\n]{0,40}\b(to|at)\b/i],
  ['message-syntax', /<\/?(tool_call|function_call|tool_result|system|assistant|developer|user)\b[^>]*>|<\|(im_start|im_end|system|user|assistant)\|>|\[INST\]|\[\/INST\]/i],
  ['role-marker', /^\s*(system|assistant|developer|tool)\s*:\s*\S/im],
  ['tool-json', /"(tool_calls|function_call|tool_use)"\s*:/],
];

/** @returns {{flag:boolean, matched:string[]}} */
export function instructionLikeness(text) {
  const s = String(text || '');
  const matched = [];
  for (const [name, re] of INSTRUCTION_PATTERNS) if (re.test(s)) matched.push(name);
  return { flag: matched.length > 0, matched };
}

export const FIDELITY_CLASSES = ['verbatim', 'loss-limited', 'compressible'];

/** Deterministic fidelity class from authority × tier. `tiers` is the configured tier list so the
 *  curated-only tier (wisdom) is found by its flag, not its name. */
export function fidelityClass(entry, tiers = []) {
  if (!entry) return 'compressible';
  const auth = normalizeAuthority(entry.provenance?.authority);
  const tierCfg = tiers.find((t) => t.name === entry.tier);
  if (auth === 'operator' || tierCfg?.curatedOnly) return 'verbatim';
  if (tierCfg && tierCfg.ttl > 0 && tierCfg.autoPromote && entry.tier !== tiers[0]?.name) return 'loss-limited';
  if (entry.tier === 'memory') return 'loss-limited';
  return 'compressible';
}

/** Root source lineage of an entry: the source row, else the original path, else the entry
 *  itself (a direct write is its own lineage). */
export function lineageOf(entry) {
  return entry?.source_id || entry?.provenance?.originalSource || entry?.provenance?.chain?.[0]?.source || `self:${entry?.id}`;
}

function authorityClass(entry) {
  return normalizeAuthority(entry?.provenance?.authority) || 'doc';
}

/**
 * Bounded-occupancy selection over ranked candidates `cand` ([{ id, score, ranks, entry }]).
 * `costOf(c)` is the token cost of what the row will return; `budget` may be null (top-k only).
 * Returns the selected candidates in score order with `ranks.occupancy` set where a rule acted.
 */
export function selectBounded(cand, { limit = 20, budget = null, costOf = () => 0, occupancy = {} } = {}) {
  const caps = { operator: 1, stack: 0.6, doc: 0.6, web: 0.25, ...(occupancy.caps || {}) };
  const protectedSlots = occupancy.protectedOperatorSlots ?? 2;
  const minLineages = occupancy.minLineages ?? 2;
  const max = Math.max(1, limit || 20);
  const capCount = (cls) => Math.max(1, Math.ceil((caps[cls] ?? 0.6) * max));

  const selected = [];
  const taken = new Set();
  const count = { operator: 0, stack: 0, doc: 0, web: 0 };
  let remaining = budget;
  const fits = (c) => remaining == null || costOf(c) <= remaining;
  const take = (c, why) => {
    selected.push(c); taken.add(c.id); count[authorityClass(c.entry)]++;
    if (remaining != null) remaining -= costOf(c);
    if (why) c.ranks.occupancy = why;
  };

  // Pass 1 — protected operator slots (score order).
  for (const c of cand) {
    if (selected.length >= max || count.operator >= protectedSlots) break;
    if (authorityClass(c.entry) === 'operator' && fits(c)) take(c, 'protected');
  }
  // Pass 2 — main fill with caps that bind only against a waiting competitor.
  const spill = [];
  for (const c of cand) {
    if (selected.length >= max) break;
    if (taken.has(c.id) || !fits(c)) continue;
    const cls = authorityClass(c.entry);
    if (count[cls] >= capCount(cls)) {
      const competitor = cand.some((o) => !taken.has(o.id) && o !== c && authorityClass(o.entry) !== cls && count[authorityClass(o.entry)] < capCount(authorityClass(o.entry)) && fits(o));
      if (competitor) { spill.push(c); continue; }
    }
    take(c, null);
  }
  for (const c of spill) { // caps relax once nothing else competes
    if (selected.length >= max) break;
    if (!taken.has(c.id) && fits(c)) take(c, 'spill');
  }
  // Pass 3 — lineage floor: swap in the best unrepresented lineage for the weakest over-represented row.
  const lineages = () => { const m = new Map(); for (const s of selected) { const l = lineageOf(s.entry); m.set(l, (m.get(l) || 0) + 1); } return m; };
  let guard = 0;
  while (guard++ < minLineages) {
    const m = lineages();
    if (m.size >= minLineages || selected.length === 0) break;
    const candidate = cand.find((c) => !taken.has(c.id) && !m.has(lineageOf(c.entry)));
    if (!candidate) break;
    const over = [...selected].reverse().find((s) => (m.get(lineageOf(s.entry)) || 0) > 1 && s.ranks.occupancy !== 'protected');
    if (selected.length < max && fits(candidate)) { take(candidate, 'lineage'); continue; }
    if (!over) break;
    const idx = selected.indexOf(over);
    selected.splice(idx, 1); taken.delete(over.id); count[authorityClass(over.entry)]--;
    if (remaining != null) remaining += costOf(over);
    if (!fits(candidate)) { selected.splice(idx, 0, over); taken.add(over.id); count[authorityClass(over.entry)]++; if (remaining != null) remaining -= costOf(over); break; }
    take(candidate, 'lineage');
  }
  selected.sort((a, b) => b.score - a.score);
  return selected;
}
