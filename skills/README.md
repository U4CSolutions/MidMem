# MidMem Skills Library (Claude Code)

Claude Code CLI skills that ship **with** the MidMem middleware, so they travel with the repo and
work wherever it's deployed. They drive MidMem through the same `midmem` CLI / MCP tools the middleware
exposes — no extra dependencies.

| Skill | Purpose |
|---|---|
| **`midmem-dev`** | Develop/iterate on the MidMem **core** — the test→verify→commit→record loop plus the load-bearing guardrails (pure-core / 4 modes, smoke stays green, determinism + grounding, `maintain()` re-entrancy). For changing the code, not operating the store. |
| **`midmem-orchestrator`** | Orchestrate knowledge-curation pipelines (bulk ingest, re-ground, dedup, vault verify) with the frontier-plans / Hermes-builds / frontier-QA loop. A MidMem-specialized repurpose of `hermes-build-orchestrator`. |
| **`midmem-ingest-review`** | Ingest LLM Wiki knowledge **and** review/audit its quality + the two stacks' understanding — cross-checks OpenClaw vs Hermes scope to catch confabulation, drift, contradictions, scope leakage, and divergent assumptions. The QA gate for `midmem-orchestrator`. |
| **`midmem-record`** | Record a change/decision/lesson **durably into MidMem** — distilled lesson → wisdom tier, clean commit, optional changelog — plus the harness-guaranteed `Stop`-hook recording pattern so a recordable change can't be left unrecorded. |
| **`midmem-ingest`** | Verified knowledge intake: stage into an allowed root, ingest, read the deterministic grounding numbers, recall-check, record. Never blind-ingest. |
| **`midmem-pattern-capture`** | Capture a reusable coding/workflow pattern into the store via capture packs (`recordPattern`), so it becomes recallable procedure memory. |
| **`midmem-research-digest`** | Digest a recurring research report end-to-end: `midmem-ingest` intake → grounded gap-analysis of every recommendation **against the actual core source** → operator digest → roadmap deltas in `docs/ROADMAP-*.md`. Reports grade nothing by themselves. |

They compose across the lifecycle: **`midmem-dev`** changes the core → **`midmem-orchestrator`** runs
bulk curation with **`midmem-ingest-review`** as its per-card QA gate → **`midmem-record`** makes the
outcome durable. All follow the DELEGATE-52 posture — judge quality by **deterministic signals**
(grounding scores, contradiction checks, cross-stack agreement), never by asking a model "is this
faithful?"

## Install (make discoverable to Claude Code)
Claude Code discovers skills in `~/.claude/skills/`. Symlink the library skills in (keeps the
canonical files here in the repo):
```bash
for s in midmem-dev midmem-orchestrator midmem-ingest-review midmem-record midmem-ingest midmem-pattern-capture midmem-research-digest; do
  ln -sfn "$(pwd)/skills/$s" "$HOME/.claude/skills/$s"
done
```
Re-run after a fresh checkout of the middleware repo.

## These are shared, genericized copies — keep them in sync
These are **portable, Claude-Code-only** adaptations meant to travel with the repo — host-specific
plumbing (an operator's changelog path, vault sync, `openclaw memory index`) is deliberately stripped.
Some are adapted from richer host skills that a live deployment runs (e.g. `midmem-record` ← an
operator's `*-record` skill; `midmem-orchestrator` ← `hermes-build-orchestrator`). **When the live
skill a deployment uses in its architecture changes, update the shared copy here in the same change**
so the repo version doesn't drift from the iteration actually in use.

## Related (not in this library)
- `midmem-ops` — an **OpenClaw** skill (lives in `~/.openclaw/workspace/skills/`) for OpenClaw to
  operate the store directly. See the repo README's *Skills — which one to use per integration*.
- `hermes-build-orchestrator` — the general Claude Code build-orchestration skill these repurpose.

← Back to the [main README](../README.md) · [core engine](../packages/core/README.md) · [RESEARCH](../RESEARCH.md)
