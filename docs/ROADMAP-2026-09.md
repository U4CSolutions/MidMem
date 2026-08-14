# MidMem Roadmap — September 2026 wave

> Successor to [ROADMAP-2026-08.md](ROADMAP-2026-08.md) (increments 1–15, ALL shipped: smoke
> 163→213, bench PASS throughout). Grounded in the 2026-08-03 + 2026-08-10 weekly research
> reviews, the 2026-08-14 dependency/structural audit, and the operator's product principles
> below. Maintained by the weekly research-digest loop: **every weekly review updates this file's
> candidate list; nothing lands without a paper/audit driver and a principle.**

## Product principles (operator-set, 2026-08-14 — every increment must serve these)

1. **Memory is first-class, not middleware.** Long-term recall of memories *and concepts* is a
   top-tier capability of the agent system, regardless of knowledge domain.
2. **Domain-agnostic core, domain-specific packs.** Extensibility and modularity come from
   purpose-built knowledge-domain extensions (capture packs); **no single use-case may drive the
   memory layer's design**. Consumers validate the core; they don't bend it.
3. **Open-source posture is load-bearing.** Zero external dependencies, deterministic verifiers,
   nothing host-specific in core — any increment that would compromise portability is rejected
   regardless of local convenience.

## Research re-evaluation (state of the art vs what's shipped)

The 2026-08 literature converged on: typed memory · transactional updates · verification in the
lifecycle · hierarchical structure · adaptive retrieval · provenance as a security boundary.
MidMem now has a first implementation of **all six** (waves 1–2). What the papers describe that
we do *not* yet have, ranked by evidence strength:

| gap | driver | status |
|---|---|---|
| Decision-time memory arbitration — retrieved-but-poorly-presented memory fails to guide action (the "Memory-Action Gap") | MemArbiter (2608.02113) | not started — strongest open item |
| Explicit insufficient-evidence output when even full retrieval can't support an answer | Router-Mem (2608.01285) + gbrain deferred item | not started |
| Episode/project grouping — recall bounded to an ongoing body of work, not just scope/tier | LeanMem event memory (2608.03463) + Filesystem-Memory (2607.26637) | partial (work-memory task nodes exist; no project boundary) |
| Evaluation memory as trend, not snapshot — probe outcomes tracked over time for regression detection | Horizon Gap (2608.06663) + WiCER lineage | partial (probes run; results not persisted as series) |
| Multi-agent memory coordination beyond scopes (which agent knew what, when) | emerging; expect coverage in coming weeklies | watch |

## Increment candidates (16–22) — sequenced, same discipline as 1–15

| # | Increment | Driver | Principle served |
|---|---|---|---|
| 16 | **Config-driven handoff scopes** — remove the hardcoded `['openclaw','hermes','shared']` default in `handoff.mjs` (2026-08-14 audit finding: the last stack-name leak beyond env-overridable config) | structural audit | #2, #3 — pure-core precision |
| 17 | **Decision-role context assembler** — retrieval output optionally grouped by role: goal / critical constraint / known failure / applicable procedure / fact / background. Deterministic from `mem_function` + type (dead_end→failure, procedural→procedure, prospective→goal…) | MemArbiter | #1 — recall that shapes action |
| 18 | **Project/episode boundary** — first-class `project` tag on entries + work events; `brief`/`query`/`handoff_brief` accept a project filter; open-project listing. The primitive any large build consumer needs | LeanMem, Filesystem-Memory | #1, #2 — domain-agnostic (a project is not a domain) |
| 19 | **Insufficient-evidence verdict** — when the full pipeline still fails sufficiency, `query` says so explicitly (gap statement + what was searched) instead of returning weak top-k as if confident | Router-Mem, gbrain | #1 — honest recall |
| 20 | **Probe-outcome series** — persist projection-QA + expected-query + consistency verdicts per forced maintain as a time series; `brief` trends them (memory-health regression detection) | Horizon Gap | #1 — verified memory over time |
| 21 | **Authority-aware handoff briefs** — `handoff_brief` composes with #10: profile-configurable authority floor, and briefs label each line's origin authority | Provenance Laundering (2607.29167) | #1, #3 — trust survives hand-off |
| 22 | **Pack authoring guide + example second pack** — document the capture-pack contract for external users; ship a second reference pack proving domain extension without core changes | principle #2 directly | #2, #3 |

Non-goals carry over unchanged from wave 1–2: no LLM in verifier/tagger paths, no auto-mutation
on conflict, no external deps, wiki stays a projection, no trigger execution in MidMem.

## Readiness evaluation: multi-agent CLI management system (next consumer, ~1 week out)

A separate build (not the homelab cockpit) will manage Claude Code / Codex / Antigravity /
OpenCode CLIs — OAuth/passkey auth, session-expiry monitoring, dashboard controls, local-LLM +
OpenRouter routing — and will lean on MidMem as its planning/recording memory. Verdict:
**ready to serve it today; increments 16–18 sharpen it; nothing blocks.** Verified point by point:

- **New agent scopes need zero code** — scope is an arbitrary string; `codex`/`antigravity`/
  `opencode` agents register with `MIDMEM_AGENT_SCOPE=<name>` and governance partitioning just
  works (verified in `governance.mjs` scope-write policy).
- **Domain modeling is a pack, not a patch** — a `cli-fleet` capture pack registers entry types
  (agent-session, auth-event, route-decision, incident) with tiers/functions/edges; core stays
  domain-blind (principle #2 validated, not violated).
- **OAuth session expiry → prospective memory** (decision 2026-08-14): tokens/passkeys stay in
  the manager's own store; MidMem records only **non-secret expiry timestamps as date-trigger
  prospective intents** + auth events as work memory. The manager's scheduler polls
  `prospective_due` — same proven pattern as the daily cron. **No credentials in the shared
  store, no crypto subsystem in the zero-dep core.**
- **Build tracking is proven** — work-memory events + kanban-loop recording carried waves 1–15;
  the same loop records the manager build.
- **What the build will want from wave 3:** #18 (project boundary — recall scoped to "the CLI
  manager build"), #17 (role-grouped briefs for its planning turns), #16/#21 (clean multi-agent
  hand-offs). These are *accelerators*, not prerequisites.

## Monitoring cadence

Weekly arXiv review → `weekly-research-digest` skill (verified ingest → grounded gap-analysis
vs THIS codebase → digest → this file's candidate table updated). Roadmap re-ranked at each
digest; increments only graduate to a build wave with operator authorization.
