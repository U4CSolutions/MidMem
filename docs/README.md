# MidMem documentation

Three kinds of docs: **guides** (hand-written, start here), **reference** (generated from source —
cannot drift, verified by `npm run verify`), and **design** (architecture + research records).

## Guides

- [`GETTING-STARTED.md`](GETTING-STARTED.md) — clone → first memory → first ingest → wiki
  projection, standalone, in five minutes. Works fully offline.
- [`CONCEPTS.md`](CONCEPTS.md) — the mental model: tiers/lifecycle, claims + the deferred
  ledger, grounding, scopes, source authority, progressive retrieval, graph hierarchy,
  work/prospective memory, capture packs.
- [`INTEGRATION-MODES.md`](INTEGRATION-MODES.md) — wiring agents: the 4 deployment modes
  (standalone · OpenClaw · Hermes · bridge) + the Claude Code MCP recipe with its guardrails.
- [`OPERATIONS.md`](OPERATIONS.md) — day-2: maintenance modes, the review queues, consistency
  cadence, health signals, backup/restore, upgrade contract.

## Reference (generated — `node scripts/gen-docs.mjs`; drift-checked in CI)

- [`reference/MCP-TOOLS.md`](reference/MCP-TOOLS.md) — all MCP tools with descriptions + schemas,
  emitted from the live server.
- [`reference/CLI.md`](reference/CLI.md) — every CLI command + the flags it reads, parsed from
  `bin/cli.mjs`.
- [`reference/CONFIG.md`](reference/CONFIG.md) — every `MIDMEM_*` env knob with its source
  context and visible default.

## Design & research

- [`ARCHITECTURE-BASIS.md`](ARCHITECTURE-BASIS.md) — every load-bearing architecture claim with
  a re-runnable verification command (DELEGATE-52 applied to our own docs).
- [`DEVELOPMENT-GUIDELINES.md`](DEVELOPMENT-GUIDELINES.md) — engineering + grounding rules for
  changing the core.
- [`STACK-CAPTURE.md`](STACK-CAPTURE.md) — how knowledge is captured per consumer stack;
  reliable vs best-effort paths.
- [`ROADMAP-2026-09.md`](ROADMAP-2026-09.md) — **current**: product principles, research
  re-evaluation, increment candidates 16–22, next-consumer readiness.
  [`ROADMAP-2026-08.md`](ROADMAP-2026-08.md) — shipped wave 1–2 (increments 1–15, status ☑).
- [`midmem-knowledge-routing-design.md`](midmem-knowledge-routing-design.md) ·
  [`hermes-vs-opencode-harness-comparison.md`](hermes-vs-opencode-harness-comparison.md) —
  design/research notes.

Research→decision records grounded in papers: [`../RESEARCH.md`](../RESEARCH.md).
Claude Code skills that ship with the repo: [`../skills/`](../skills/).

← Back to the [main README](../README.md).
