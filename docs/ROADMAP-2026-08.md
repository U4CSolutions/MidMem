# MidMem Roadmap — August 2026

> Grounded in the 2026-08-03 weekly arXiv review (staged with citation manifest under
> `ingest-staging/weekly-arxiv-2026-08-03-llm-wiki-memory/`) and a review of gbrain
> (github.com/garrytan/gbrain, MIT) as convergent external validation. Operator granted
> full-build authorization 2026-08-04. Every increment: deterministic-first, pure-core,
> smoke-gated, its own commit.

## Research → increment map

| # | Increment | Research driver | Principle |
|---|-----------|-----------------|-----------|
| 1 | **Transition verifier** | TRUSTMEM (2606.25161) | Verify the transition, not just the final memory: coverage / preservation / insertion checks on supersede + promote, deterministic token-overlap, deny on hard insertion failure, receipts to audit. |
| 2 | **Write-path conflict tagging** | MOSAIC (2607.16211) | Compare an incoming claim against live neighbors AT WRITE: tag additive / corroborating / superseding-candidate / contradictory / uncertain. Flag, never auto-mutate. |
| 3 | **Projection QA** | WiCER (2605.07068) | The compiled wiki gets tests: per-page deterministic probes (backing row live, content coverage) on forced/daily maintain; failures reported, never auto-"fixed". |
| 4 | **Function axis** | Memory for LLMs survey (2607.25380) | Memory typed along independent axes: `mem_function` (working/episodic/semantic/procedural/prospective) orthogonal to persistence tier; deterministic default mapping from type; retrieval filter. |
| 5 | **Capture packs** | survey + gbrain schema packs | Domain extensibility as DATA, not code: a pack registers entry types (tier+function), categorizer rules, edge types, and template fields. Core never learns domain names (4-mode discipline). Ships with `coding-patterns` example pack + `recordPattern` surface. |
| 6 | **Prospective memory** | PM-Bench (2607.12385) | New capability class: intent + trigger + status entries, `due` surfacing. EXECUTION STAYS IN THE SCHEDULER (cron is the system of record for firing — PM-Bench's 65.1% F1 ceiling is the warning); MidMem records intent and outcome. |
| 7 | **Revision history** | Ground Truth First (2607.21962) + Git-memory (2607.14390) | Long-term memory as a reproducible knowledge product: deterministic canonical export (stable ordering, vectors excluded) committable to git, refreshed by maintain. |

## Non-goals (deliberate)
- No LLM in any verifier/tagger/QA path (DELEGATE-52).
- No Postgres/graph-db adoption from gbrain — concepts yes, stack no (zero-dep node:sqlite is load-bearing).
- No auto-mutation on conflict: contradictions and QA failures are surfaced for judgment.
- No trigger execution in MidMem: prospective memory informs; cron fires.
- Wiki stays a projection; state.db stays canonical; the export gives the product git history.

## Adopted from gbrain (concepts, MIT-licensed reference)
- Schema/capture packs threading non-destructively through read/write paths.
- Gap analysis as a first-class retrieval output (deferred: surface "insufficient evidence"
  from proactiveRecall thresholds — follow-up after this build).
- Eval-gated changes (already ours: smoke + bench are the gates).

## Sequencing & status
1. Transition verifier — core `verifyTransition` + wiring into supersede/promote. ☑ (smoke 111→117, bench PASS)
2. Write-path conflict tagging — `relate()` at claims.add, lint writeConflicts queue. ☑ (smoke 117→121, bench PASS)
3. Projection QA — completeness + sampled-fidelity probes, report-only, in forced maintain. ☑ (smoke 121→124, bench PASS)
4. Function axis — `mem_function` column, deterministic type map, retrieval filter, CLI/MCP. ☑ (smoke 124→130, bench PASS)
5. Capture packs — data-driven loader, recordPattern, coding-patterns pack, pattern-capture skill. ☑ (smoke 130→136, bench PASS)
6. Prospective memory — intent+trigger entries, deterministic due surface, resolve; cron fires. ☑ (smoke 136→145, bench PASS)
7. Revision export — stable-byte JSONL snapshot, forced-maintain refresh, CLI/MCP. ☑ (smoke 145→149, bench PASS)
8. Adversarial review pass — 11 findings (1 critical, 4 major), ALL fixed + regression-tested. ☑ (smoke 149→155, bench PASS)

Each step: full smoke suite must pass (no skips), bench must stay PASS, one commit,
root-changelog entry. Results recorded in this file's status column as steps land.

## 2026-08-10 additions (next wave — pending, from the 2026-08-10 weekly review)

Grounded against `packages/core/src` before listing (already-have items excluded — see the
operator digest for the full already/partial/gap sort). Priority order:

| # | Increment | Research driver | Principle |
|---|-----------|-----------------|-----------|
| 9 | **Deferred-claim ledger** | TARL (2608.03699) | Third claim state between kept and quarantined: `deferred` + review queue. Uncertain/conflicting candidates stop being forced into keep-or-reject; surfaced for judgment, never auto-resolved. |
| 10 | **Source-authority propagation** | Provenance Laundering (2607.29167) | Formal `source_authority` at ingest, propagated through every derived entry/claim/summary; consolidation must never raise authority. Action-risk-gated recall for low-authority material. Security boundary, not a ranking tweak. |
| 11 | **Sufficiency-gated retrieval** | Router-Mem (2608.01285) | Cheap lane first, deterministic sufficiency check, expand (graph/episodic/source) only on insufficiency. Extends the existing lanes; pairs with the deferred gbrain "gap analysis as retrieval output" idea. |
| 12 | **Hierarchical graph + path rewrite** | HiGram (2608.05095) | Parent/child structure over communities; when a claim supersedes, rewrite the affected dependency path, not one node. Builds on forget_nodes/orphan-sweep. |
| 13 | **Global consistency pass** | Verifiable Memory (2608.03137) | Increment 1 verified transitions; this verifies the resulting state: maintain-time sweep for cross-claim contradictions and dangling supersede chains. Report-only (non-goal: no auto-mutation). Respect maintain re-entrancy guard. |
| 14 | **Claim validity windows** | PGMem (2608.01708) | first-observed / last-observed / contradicting-evidence fields on durable preference-type claims; extends conflict tagging (#2). |
| 15 | **Expected-query probes** | PMMC (2608.00962) | Projection QA (#3) extension: per-page likely-query probes precompiled at consolidation, verified like WiCER probes. Lowest urgency. |

Same discipline as increments 1-8: deterministic-first, pure-core, smoke-gated, one commit each,
no LLM in verifier paths, no auto-mutation on conflict.

### Sequencing & status (wave 2 — built 2026-08-10)
9. Deferred-claim ledger — 'deferred' status + explicit defer/resolve, pending queue in lint,
   deferContradictory default-on. ☑ (smoke 163→175, bench PASS, `a3a05ac`)
10. Source-authority propagation — operator>stack>doc>web at origin, claim inheritance,
    parentAuthority clamp, governance gate on operator, minAuthority filter + post-RRF nudge.
    ☑ (smoke 175→184, bench PASS, `f9d6a32`)
11. Sufficiency-gated retrieval — lexicalOnly first pass + deterministic coverage gate,
    deep:true escape hatch, sufficiency descriptor on every query. ☑ (smoke 184→190, bench
    PASS, `e5d7ce9`)
12. Hierarchical graph + path rewrite — community parent nodes + member_of edges (idempotent),
    supersede flags the dependency path (report-only), stale_paths_clear by explicit ids.
    ☑ (smoke 190→198, bench PASS, `64b802d`)
13. Global consistency pass — state-level contradictions + dangling supersede chains +
    deferred aging, report-only, on forced maintain + on demand. ☑ (smoke 198→204, bench
    PASS, `e4cbd90`)
14. Claim validity windows — firstObserved/lastObserved/supportCount/contradictedBy +
    currentlyValid verdict; observation bookkeeping never mutates status. ☑ (smoke 204→209,
    bench PASS, `0d0ef62`)
15. Expected-query probes — per-entry probe compilation persisted in meta + lexical
    evidence-path verification on forced maintain. ☑ (smoke 209→213, bench PASS, `d1fd414`)

Live-store QA after landing (state.db, 665 live claims): MCP serves **37 tools** (was 30) incl.
all 7 new; consistency chain-integrity clean (0 dangling, 0 deferred-aging); pairwise
contradiction pairs at default minShared=3 are noisy at this scale (1295) — **operational
review range is minShared 5–7 (124 → 39 pairs)**; default left unchanged (smoke exercises the
tight-locality behavior).
