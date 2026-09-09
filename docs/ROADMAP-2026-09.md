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
| Serving-cost observability — per-op latency / LLM+embed calls / fallback share; a store can look healthy while recall silently degrades (2026-08-17: 54 fallback-hash vectors written while the embedder was down, no re-embed path) | Total Recall at What Cost? (2608.11879) | not started — operationally urgent |
| Typed unresolved-conflict states rendered in the wiki (context-partitioned / source-disputed / temporally-separated / unresolved), not one `deferred` bucket | TANGLE (2608.13921) | partial (deferred ledger #9 + validity windows #14 exist; no class, no projection) |
| Multi-hop associative expansion over event edges before declaring insufficiency | RippleMem (2608.13334) | partial (one-hop ref-chain boost + concept routing) |
| Snapshot restore/rollback with index rebuild | ChronoMem (2607.27773) | partial (export #8 only) |
| Procedure-candidate detection (episode → procedure candidate → skill, deterministic) | Externalization (2604.08224), AMD (2608.07169) | not started — low |

## Increment candidates (16–37) — sequenced, same discipline as 1–15

| # | Increment | Driver | Principle served |
|---|---|---|---|
| 16 | **Config-driven handoff scopes** — remove the hardcoded `['openclaw','hermes','shared']` default in `handoff.mjs` (2026-08-14 audit finding: the last stack-name leak beyond env-overridable config) | structural audit | #2, #3 — pure-core precision |
| 17 | **Decision-role context assembler** — retrieval output optionally grouped by role: goal / critical constraint / known failure / applicable procedure / fact / background. Deterministic from `mem_function` + type (dead_end→failure, procedural→procedure, prospective→goal…) | MemArbiter | #1 — recall that shapes action |
| 18 | **Project/episode boundary** — ✅ **shipped 2026-09-09 (project axis half):** nullable `entries.project` orthogonal to scope; `MIDMEM_PROJECT` default; `project` on remember/ingest/record_work/prospective_add/record_pattern; `projects` filter on query/proactive_recall/handoff_brief in every lane (FTS, trigram, vector, concept seeds); reads = project + global; `brief.projects` counts; promotion into `wisdom` lifts to global with `provenance.liftedFrom`. Driver: Agent Console cross-harness memory (2026-09-09 analysis) — the Wave 5 "prior knowledge, quarantined" recall card needs a project-scoped read. **Open:** the 08-24 WMT amendment — task nodes gain a `parent_of` edge + a `folded` flag on done branches so `handoff_brief` collapses completed subtasks; the activation scoring itself stays consumer-side | LeanMem, Filesystem-Memory, WMT (2608.20631) | #1, #2 — domain-agnostic (a project is not a domain) |
| 19 | **Insufficient-evidence verdict** — when the full pipeline still fails sufficiency, `query` says so explicitly (gap statement + what was searched) instead of returning weak top-k as if confident | Router-Mem, gbrain | #1 — honest recall |
| 20 | **Probe-outcome series** — persist projection-QA + expected-query + consistency verdicts per forced maintain as a time series; `brief` trends them (memory-health regression detection) | Horizon Gap | #1 — verified memory over time |
| 21 | **Authority-aware handoff briefs** — `handoff_brief` composes with #10: profile-configurable authority floor, and briefs label each line's origin authority | Provenance Laundering (2607.29167) | #1, #3 — trust survives hand-off |
| 22 | **Pack authoring guide + example second pack** — document the capture-pack contract for external users; ship a second reference pack proving domain extension without core changes. Packs declare a `version`; a pack change logs a migration op (MindMemOS 2608.12428 — ontology evolution as data, never LLM-driven) | principle #2 directly | #2, #3 |
| 23 | **Serving-cost ledger + fallback re-embed** — ✅ **re-embed half shipped 2026-09-09** (`reembedFallback` / CLI `reembed` / MCP `reembed_fallback`: fallback vectors swapped in place, oldest first, self-gating on embedder availability; driver: the 2026-09-09 .210 outage left 63 placeholder vectors that hash-dedup made un-re-ingestable). Ledger half open. — `log` detail gains `durationMs` / `llmCalls` / `embedMode`; `audit`+`brief` surface fallback-vector share and per-op cost trend; `maintain --reembed` re-embeds fallback vectors when the embedder is reachable (hash-dedup otherwise blocks a repair re-ingest) | Total Recall at What Cost? (2608.11879); 2026-08-17 incident | #1 — recall that is honestly measured |
| 24 | **Typed conflict states + unresolved-conflict wiki rendering** — deterministic class on deferred pairs (`temporally-separated` from #14, `source-disputed` from #10 authority delta, `context-partitioned` from scope-disjoint provenance, else `unresolved`); projection renders current / alternative / context / sources / open uncertainty | TANGLE (2608.13921) | #1 — conflict survives consolidation |
| 25 | **Multi-hop associative expansion behind the gate** — when the full pass still fails `evidenceSufficient()`, walk work-memory edges ≤2 hops from the anchors, re-check, then emit the #19 verdict if still short. *Amended 08-24 (CABLE 2608.17911):* traversal also follows the typed edges already in `EDGE_TYPES` (`contradicts / supports / corrected_by / avoided / used_source`) plus a deterministic `superseded` edge written by `supersede()` — today those edges are never read at query time | RippleMem (2608.13334), CABLE (2608.17911) | #1 — distributed evidence recovered |
| 26 | **Snapshot restore + index rebuild** — `import_knowledge` from the #8 JSONL snapshot, rebuild FTS + vectors, refuse on schema-version mismatch; NL rollback explicitly out | ChronoMem (2607.27773) | #1, #3 — reversible memory |
| 27 | **Procedure-candidate detection** — N successful `task_attempt` events sharing task label + tool signature → suggested `record_pattern`; promotion to a skill artifact stays consumer-side | Externalization (2604.08224), AMD (2608.07169) | #2 — procedures leave memory |
| 28 | **Idempotent `prospective_add`** — a pending intent with the same (scope, intent, trigger, context) is returned, not duplicated; `prospective_due` groups by intent. Driver: 2026-08-18 incident — a consumer with per-DB dedupe re-added the same intent 44× and the operator got a "20 overdue" report | Agent Console incident 2026-08-18 | #1, #2 — a memory layer must be safe against naive consumers |
| 29 | **Compact claims projection** — `claims` list results return content+status+id, not full provenance/metadata blobs, and/or a lower default limit. Driver: 2026-08-21 sweep overflow — six bare ~36KB `claims` calls (681 active claims, default limit 50) overflowed a 120K-context consumer twice | research-sweep incident 2026-08-21 | #1, #2 — a memory layer must be safe against naive consumers |
| 30 | **Phase-aware retrieval profiles** — consumer passes a task phase (`explore`/`refine`); deterministic lane + `mem_function` weighting shifts: semantic/reference material early, episodic outcomes + dead-ends + procedural lessons during refinement. Builds on #4 (function axis), composes with #17 | AVO (2603.24517) §3.2 phase-shifted consultation, empirically confirmed across its 7-day trajectory (v1–20 structural from KB refs, v21–40 feedback-driven tuning) | #1 — recall matched to the phase of the work |
| 31 | **Structured outcome metrics on work events** — optional deterministic `metrics` object ({name→number}) on `record_work`, persisted in `provenance.work`, with a per-task/project trend query; today `outcome` is prose-only (verified in `workmemory.mjs`, 2026-08-22) | AVO score-vector `f` — a scored attempt lineage is what made its unattended 7-day run steerable; no LLM anywhere in the path | #1, #2 — outcomes as data, consumer-agnostic |
| 32 | **Claim dependency edges** — `depends_on` between claims (declared at ingest from explicit references or via `claim_supersede` options); `supersede()` flags dependent claims `staleReview` the way it flags communities (#12); `consistency` lists dependents of a superseded claim. Lower urgency: claims are mostly leaf facts today | StateMem (2608.19652), 2026-08-24 digest | #1 — current state that knows what it invalidates |
| 33 | **Deterministic write-commitment policy** — classify each candidate claim REMEMBER / SESSION_ONLY / VERIFY / ASK from computed signals only (grounding score, `writeRelation`, subject churn = same neighborhood superseded N× in a window → VERIFY, scope-ambiguous provenance → ASK); ASK is recorded as a `prospective` intent the consumer asks, MidMem never asks or judges. Extends #9 + `governance.mjs` | Remember, Verify, or Ask? (2608.19564) | #1, #3 — commitment is a decision, not a side effect |
| 34 | **Source-lineage independence** — group retrieval hits and write-relations by root source (`entries.source_id` / provenance chain root); sufficiency coverage counts distinct lineages; `corroborating` only when the neighbor's root differs; `rank` exposes `lineage`. Driver in our own store: report entry + ingest-review doc + digest all descend from one upstream report | Beyond Memory Majority (2608.19701) | #1 — evidence counted, not echoes |
| 35 | **Protected bench slices + promotion verdict** — `correction-applied`, `dead-end-avoided`, `current-claim` become protected slices that must not regress independent of the aggregate; bench emits a `PROMOTE / FLAG / REJECT` verdict object the record loop stores; composes with #20 | D²ACCI (2608.17756) | #1 — verified memory changes |
| 36 | **Retrieval trace + stage attribution** — optional `query` log op with lane ranks, sufficiency and expansion; a probe miss records which lane held the evidence and at what rank (or none), so ingest-vs-extract-vs-retrieve-vs-gate is answerable from the log | D²ACCI DCR (2608.17756) | #1 — localizable failures |
| 37 | **Order-randomized bench** — K seeded permutations of KNOWLEDGE insertion order in `test/bench.mjs` (today one fixed order, single pass), per-metric min/max spread, gate on worst case | On the Fragility of Self-Improving Agents (2608.18066) | #1 — no hidden curriculum in the gate |
| 39 | **Bounded-occupancy recall selection** — the token-budget selection in `hybridSearch` / `handoffBrief` / `proactiveRecall` enforces per-authority occupancy caps + protected slots (operator lines never crowded out; `web`/untrusted bounded; a minimum of N independent source lineages, composing with #34) instead of relying on the additive authority nudge alone. Deterministic; effort S | Utility Under Attack (2608.21230): write-time screening rejected none of the fluent poisons and additive provenance weighting has a hard utility trade-off; InjecMEM (2608.23471) | #1, #3 — recall that cannot be crowded by one source |
| 40 | **Instruction-likeness flag + data framing on inject** — deterministic tagger on retrieval (`rank.instructionLike` when content matches agent-directed imperatives: "ignore previous", "you must now", tool-call syntax, role markers); `proactiveRecall` / `handoff_brief` headers state the block is evidence, not instruction, and flagged lines are demoted + labelled. Never executes or filters by LLM judgment; effort S | InjecMEM (2608.23471): one ordinary interaction plants a topical anchor + command that steers later turns; Endogenous Authorization Laundering (2609.01836) | #3 — memory is never an instruction channel |
| 41 | **Dependency-aware forget** — `forget(id)` follows provenance forward: archive claims whose `source` is the forgotten entry, flag concept nodes that only it supported, mark projected pages dirty, and log the derived set; `forget_entries` reports the cascade. Deterministic; effort M (claims/graph/projection seams exist). Execution-state (prompt/KV) replay stays consumer-side | Forgetting Without Restarting (2609.04875): deleting the record leaves derived summaries/plans/caches unchanged; selective provenance-guided replay matches a full reset | #1, #3 — a revoked memory leaves every derived artifact |
| 42 | **Fidelity class on return** — entries carry a deterministic fidelity class from authority × tier (operator/wisdom = verbatim, memory = loss-limited, fact = compressible); briefs and `proactiveRecall` return verbatim-class content untruncated (today every result is cut to a 600-char preview) and budget the rest. Effort S | Compaction Cliff (2608.22752): 53% of safety rules survive one compaction round, 10% after five — per-type retention guarantees | #1 — curated rules reach the model intact |
| 38 | **Configurable, recursive bridge roots** — ✅ **shipped 2026-09-09:** `MIDMEM_BRIDGE_SOURCES` (`dir\|scope\|type\|project\|recursive;…`) replaces the four constants in `config.mjs`; the walk recurses (dot-dirs + `node_modules` skipped, sorted, per-source `recursive:false` / `MIDMEM_BRIDGE_RECURSIVE=0` opt out); each source may carry a project tag; nested files ingest with a relative-path title. Driver: 2026-09-09 defect — vault `OpenClaw/{reports,research,notes}` and `Hermes/reports/D18-Control-Plane` (57 files, 42 unknown to the store by hash) were unreachable by the flat walk, and a third harness could not register its memory dir without a core change | Agent Console cross-harness memory analysis 2026-09-09 | #2, #3 — capture registered as data, not code |

Sequencing note (2026-08-17 digest, amended 08-18): #23 and #28 first (small, operational), then #17/#19 with #25 folded in, #24, #26; #27 last. Amended 08-22: #29 joins the small-operational pair; #30/#31 rank immediately after #17/#19 (same surfaces).

2026-08-24 digest addition (weekly review, 7 papers): #32–37 added above; #25 and #18 amended; rec 6 (preserve unresolved conflicts) is a second driver for #24. Ranking within the new six: **#34 first** (small-medium, and a live bias in our own store — every digest re-summarizes its report), then #33, then the three small bench/log items #37 → #35 → #36 together, #32 last. Validation evidence: the report's ten recommendations map 2 already-have / 6 partial / 2 new against `packages/core/src` — the "governed state" control plane it describes is the shipped design. Full record: vault `OpenClaw/research/2026-08-24-weekly-memory-research-digest.md`.

2026-08-22 deep-research addition (AVO, arXiv:2603.24517 + NVIDIA dev blog 2026-08-21): #30–31 added above. AVO also independently **strengthens the drivers for #17** (its lineage consultation = known failures + procedures assembled at decision time) **and #18** (its `P_t` is exactly a per-project attempt lineage). Beyond the increments, AVO validates the shipped design: curated KB + deterministic grounding-before-persist + usage-earned promotion is the knowledge leg of its winning pattern, and its committed-lineage vs internal-trajectory split mirrors the tier/function design. Its supervisor stays a *harness* concern (non-goal here: no trigger execution in MidMem). Full record: vault `OpenClaw/research/2026-08-22-avo-deep-research.md`.

2026-09-09 research-tracker addition (weeks 2026-08-31 + 2026-09-07, 21 papers, evaluated straight from the ingested reports — no vault digest was written for those weeks; ledger: [`RESEARCH.md`](../RESEARCH.md)): #39–#42 added above. Amendments: **#23** — the re-embed path must also cover a deliberate embedder-model swap (`reembed --model <old>` / all vectors), since partial migrations forfeit most of a full re-embed's benefit (Memory Portability 2609.05339); **#25** — GraphMemix (2608.26983) frames the expansion as budgeted evidence-forest selection with redundancy/conflict penalties, the shape #25 + #34 + #39 should converge on; **#26** — the restore pipeline is snapshot → migrate → re-embed → rebuild views → replay probes → promote or roll back (2609.05339, 2609.00546); **#27/#31** — CHIME (2609.02074) types procedural lessons by causal role (planning vs execution vs tool vs environment) with attribute-before-memorize; **#28** — Typed Intention Stores (2609.01272) validates #6's deterministic-lifecycle design and adds the missing states (activate / defer / expire) + intent dependencies to the idempotent-add card; **#32** — PlanFence (2609.03340) is a second driver: decisions cite the record ids they depend on and a consumer validates only action-affecting ones before acting; **#33** — CAPTURE (2609.02265) supplies the drift-vs-poisoning distinction for the ASK outcome (competing hypotheses with evidence episode ids, never last-write-wins); **#34** — HERO (2608.22310) adds "derived memory points to evidence": claims keep a source excerpt locator, not just the path. Not adopting: context compaction itself (Compaction Cliff, MemoryWalker 2609.00865) — MidMem does not own a context window; an authorization ledger inside memory (2609.01836) — authorization is governance code and the consumer's allowlist, MidMem records decisions and never grants; LLM-judged preference belief tracking (CAPTURE) — no LLM judgment in promotion/arbitration paths.

2026-09-09 addition (Agent Console cross-harness memory analysis): #18's project-axis half and new #38 shipped together as one increment (smoke 244/244, bench PASS) so the console's Wave 5 recall card has a project-scoped read to consume. Sequencing consequence: the WMT half of #18 (`parent_of` / `folded`) stays open and now ranks with #17/#19.

Non-goals carry over unchanged from wave 1–2: no LLM in verifier/tagger paths, no auto-mutation
on conflict, no external deps, wiki stays a projection, no trigger execution in MidMem, no LLM-driven schema evolution or natural-language rollback, no subject-predicate-value triple claims (grounded text stays).

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
