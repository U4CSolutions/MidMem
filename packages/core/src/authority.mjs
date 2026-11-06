/**
 * Source authority (roadmap #10, arXiv 2607.29167 "Memory Provenance Laundering").
 *
 * A low-trust observation must not become high-trust just because an LLM summarized
 * it into a clean memory entry. Authority is assigned at ORIGIN, rides in provenance
 * through every derived entry/claim, and can only be lowered downstream — never raised.
 * The one sanctioned raise is explicit operator curation (curated:true), which is
 * governance-gated at the write surface.
 *
 * Ordinal levels (higher = more authoritative):
 *   operator (4) — curated by the operator; the only level that requires curated:true
 *   stack    (3) — written by a trusted agent process (direct remember/work events)
 *   doc      (2) — ingested local documents/notes (default for ingest)
 *   web      (1) — fetched external material (scrapes, downloaded papers)
 */

export const AUTHORITY_LEVELS = { operator: 4, stack: 3, doc: 2, web: 1 };

/** Valid label or null (unknown labels are rejected at the surface, not silently mapped). */
export function normalizeAuthority(a) {
  return a && Object.hasOwn(AUTHORITY_LEVELS, a) ? a : null;
}

/** Ordinal rank; entries from before this feature (no label) rank as 'doc'. */
export function authorityRank(label) {
  return AUTHORITY_LEVELS[label] ?? AUTHORITY_LEVELS.doc;
}

/** The no-raise rule: a derived record keeps the LOWER of its own vs its parent's authority. */
export function clampAuthority(requested, parentLabel) {
  const req = normalizeAuthority(requested) || 'doc';
  if (!parentLabel) return req;
  return authorityRank(req) <= authorityRank(parentLabel) ? req : parentLabel;
}
