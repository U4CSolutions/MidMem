# `docs/` — midmem-kb-store design notes

Design and architecture notes for the store. For *research → decision* records grounded in papers,
see [RESEARCH.md](../RESEARCH.md) at the repo root.

- [`ARCHITECTURE-BASIS.md`](ARCHITECTURE-BASIS.md) — **start here for "why believe the
  architecture claims":** every load-bearing claim with its basis in the code and a re-runnable
  verification command (DELEGATE-52 discipline applied to this repo's own docs). Includes the
  drift-corrections log from the 2026-08-06 audit.
- [`DEVELOPMENT-GUIDELINES.md`](DEVELOPMENT-GUIDELINES.md) — engineering + grounding rules for
  changing the core (pure-core, determinism, smoke-stays-green, maintain re-entrancy).
- [`INTEGRATION-MODES.md`](INTEGRATION-MODES.md) — the 4 deployment modes (standalone · OpenClaw
  add-on · Hermes add-on · bridge) over the 3 surfaces (CLI · MCP · hook seam).
- [`STACK-CAPTURE.md`](STACK-CAPTURE.md) — how knowledge is *captured* per stack (OpenClaw ·
  Hermes · Claude Code): reliable paths vs. best-effort ones.
- [`ROADMAP-2026-08.md`](ROADMAP-2026-08.md) — the research-grounded 2026-08 build wave
  (per-increment status + smoke counts).
- [`midmem-knowledge-routing-design.md`](midmem-knowledge-routing-design.md) — trigger-less,
  token-budgeted retrieval: Phase 1 proactive injection → Phase 2 concept-tree routing.
- [`hermes-vs-opencode-harness-comparison.md`](hermes-vs-opencode-harness-comparison.md) —
  research note (2026-07-13) comparing agent harnesses; background for the capture design.

← Back to the [main README](../README.md).
