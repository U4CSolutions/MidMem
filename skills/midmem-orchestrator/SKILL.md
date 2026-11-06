---
name: midmem-orchestrator
description: >-
  Orchestrate MidMem (LLM Wiki) knowledge-curation pipelines with the frontier-plans / Hermes-builds /
  frontier-QA loop — bulk ingestion, re-grounding, dedup/supersede cleanup, tier-promotion review,
  vault verification. Use for "curate the knowledge base", "bulk ingest these docs", "rebuild/clean
  the wiki", "orchestrate midmem curation". A MidMem-specialized repurpose of
  `hermes-build-orchestrator`; pair it with `midmem-ingest-review` as the QA gate.
---

# MidMem Orchestrator — curation pipelines, frontier-planned + QA'd

This is the `hermes-build-orchestrator` loop (read that skill for the kanban CLI, the issue-resolution
decision tree, autonomy/reporting policy, and the DELEGATE-52 long-horizon defenses) **specialized for
MidMem knowledge work**. You (frontier) plan + QA; Hermes/qwen does the bulk mechanical work via
kanban; the **QA gate is the `midmem-ingest-review` skill**.

## When to use
Multi-item knowledge-store work that's too much for one session: ingesting a batch of sources,
re-grounding/auditing existing entries, deduping, reviewing tier promotions, or verifying the vault
projection after a large change. Single recall/store/ingest = just use `midmem-ops` (OpenClaw) or the
`midmem` CLI directly; don't orchestrate.

## The contract (what every curation card must respect)
- **`state.db` is the source of truth; the vault is a deterministic, regenerable projection** — never
  edit the vault; if it looks wrong, `midmem project` rebuilds it. Curate the store, not the projection.
- **Grounding holds:** ingest deterministically quarantines extracted concepts/claims not present in
  the source. A card must not bypass it (no `MIDMEM_GROUNDING=0` in curation).
- **Scope discipline:** writes default to the agent's scope; publish cross-agent facts as `shared`;
  never write another stack's private scope.
- **Tiers are earned, not asserted:** promotion runs on usage/feedback (quantitative), never LLM
  judgment. Curation should add `feedback`/usage signals, not hand-promote.
- **Supersede on reingest:** re-ingesting a changed source archives its prior entries — prefer
  re-ingest over manual edits.

## Card patterns (decompose to these — small, verifiable)
- **Ingest one source** → `midmem ingest <path> --scope <s>`; acceptance: `success`, grounding report
  shows acceptable `summaryScore` and no unexpected quarantine.
- **Re-ground / audit a slice** → run `midmem-ingest-review` over a topic; acceptance: report has no
  unresolved contradictions/ungrounded entries (or they're flagged for forget/supersede).
- **Dedup / cleanup** → identify duplicates via query; supersede by re-ingest or `forget` (soft);
  acceptance: `brief` counts reconcile.
- **Vault verify** → `midmem project` then confirm projection matches `state.db` counts.

## Coding-harness routing (portable rule of thumb)
When a card needs a coding harness rather than a curation step, pick by the task's shape: an
interactive harness that iterates against the local tree and local tests (Claude Code) for
backend logic, failing suites and root-cause fixes — decompose, because context/rate limits are
its flaw; an isolated, asynchronous harness that returns a reviewable diff (Codex cloud sandbox)
for bounded batch work against *pushed* code — its cloud mode sees only what is committed; a
browser-driving harness (Antigravity) for UI-flow checks with screenshots — and never accept its
"done" without a local test/type-check/build pass afterwards. Keep the full guide in the
project's docs (here: `docs/CODING-HARNESSES.md` in the console repo) and mark which claims
about each harness you verified yourself and which are third-party reporting.

## Loop
Plan the cards → `hermes kanban` dispatch (`--assignee qwen`; escalate stuck/precision to
gpt-5.5) → **QA each with `midmem-ingest-review`** → resolve per the orchestrator decision tree →
finish via `openduck-record`. **DELEGATE-52:** curation IS long-horizon editing — keep cards small
(~8 interactions), restrain tools, verify-after-write with deterministic signals (grounding,
contradiction checks), never LLM self-assessment.
