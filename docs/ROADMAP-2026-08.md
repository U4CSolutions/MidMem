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
1. Transition verifier — core `verifyTransition` + wiring into supersede/promote. ☐
2. Write-path conflict tagging — `relateClaim` at claims.add + storeMemory claims. ☐
3. Projection QA — probe pass in forced/daily maintain. ☐
4. Function axis — `mem_function` column, defaults, retrieval filter, surfaces. ☐
5. Capture packs — pack loader + `recordPattern` + example pack + skill. ☐
6. Prospective memory — type + due surfacing + CLI/MCP. ☐
7. Revision export — deterministic `export` + maintain refresh. ☐
8. Adversarial review pass (independent subagent) + full-suite verification + push. ☐

Each step: full smoke suite must pass (no skips), bench must stay PASS, one commit,
root-changelog entry. Results recorded in this file's status column as steps land.
