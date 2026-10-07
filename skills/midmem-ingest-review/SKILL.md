---
name: midmem-ingest-review
description: >-
  Ingest LLM Wiki knowledge AND review/audit its quality and the two stacks' understanding — a
  check-and-balance over the shared MidMem store. Use for "ingest and review", "review/audit the
  knowledge base", "knowledge quality check", "what does OpenClaw vs Hermes understand about X", "is
  our stored knowledge grounded/consistent". Cross-checks OpenClaw and/or Hermes scope to surface
  confabulation, drift, contradictions, scope leakage, and divergent assumptions before they mislead.
---

# MidMem Ingest & Review — knowledge quality + cross-stack check-and-balance

Two jobs: (1) **ingest** new knowledge cleanly, (2) **audit** the store and the two stacks'
*understanding* of it. The premise (DELEGATE-52): models confabulate and drift silently and will
confidently assert faithfulness — so judge quality by **deterministic signals + cross-stack
agreement**, never by asking a model "is this right?"

## Ingest (with verification, not blind)
- `midmem ingest <path> --scope <openclaw|hermes|shared> [--type ...]`. Grounding runs automatically.
- **Read the grounding report** in the result (`summaryScore`, `conceptsKept/Quarantined`,
  `claimsKept/Quarantined`). Flags: low `summaryScore` (≲0.4) → the summary drifted from the source;
  heavy quarantine → the extractor confabulated. Investigate the source/extraction before trusting it.
- Finish editing a source BEFORE ingesting (mid-edit saves mint duplicates). Re-ingest supersedes.
- **A multi-paper digest (a weekly report, one `###` per paper) is ingested with `--sections`:** every
  section that cites exactly one URL becomes its own grounded entry keyed by the canonical citation
  (arXiv ids normalised, versions stripped), so a paper cited again next week supersedes its earlier
  entry; the digest entry stays as the index. Without it a six-paper report yields one short summary
  and about one claim, and a paper can be absent from the store by name (2026-10-05: MemAgent, at a
  grounding score of 0.864).
- **After the ingest, search the store for the named entities and key numbers the source carries**
  (`midmem claims "<name>"`, a `query`): the grounding score measures the summary against the
  source, not what the summary left out.

## Review / audit the store
- **`midmem brief`** — tier distribution, vector health (dim, fallback count), recent ops.
- **`midmem audit`** — contradictions + orphan concepts (deterministic verifier). Triage each.
- **Per-entry quality:** `midmem recall <id>` → check `provenance.grounding`, `trust_score`,
  `retrieval_count`, tier. Low grounding or low trust + low usage = decay/forget candidate.

## Cross-stack check-and-balance (the core differentiator)
The store is shared but each stack reads **its own scope + `shared`**. To compare what each
*understands* about a topic, run the same query under each lens and diff:
```
midmem query "<topic>" --scopes openclaw,shared   # what OpenClaw can surface
midmem query "<topic>" --scopes hermes,shared     # what Hermes can surface
```
Then assess:
- **Divergence** — entries one stack has and the other doesn't (private-scope knowledge that should
  be `shared`? or stale to one side?).
- **Contradiction** — the two return conflicting claims → flag; reconcile to the source.
- **Grounding/assumption gaps** — a surfaced claim whose `provenance.grounding` is low, or that isn't
  in the cited source → an assumption the system is treating as fact. Surface it explicitly.
- **Scope leakage** — private-scope content that's actually general (promote to `shared`) or shared
  content that's stack-specific.

## Output: a review report
Summarize: ingest grounding outcome; contradictions/orphans; per-stack divergences on the reviewed
topics; ungrounded/low-trust entries; and recommended actions. Distinguish **quality issues**
(ungrounded, contradictory, orphaned) from **understanding gaps** (one stack missing/misreading
shared knowledge).

## Apply (safe vs flag)
- **Safe, do with a note:** `midmem feedback <id> --helpful=false` to down-weight a bad entry;
  re-ingest a corrected source (supersede); `forget` (soft) a clearly-confabulated entry.
- **Flag for the human:** contradictions needing a judgment call, scope re-classification of
  sensitive content, anything that changes canonical facts (MEMORY.md).
- Never hand-promote tiers (let usage/feedback earn it) and never edit the vault (re-project).
- **Record** the review + actions via `openduck-record`.
