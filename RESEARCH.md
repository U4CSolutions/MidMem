<!-- research-tracker: evaluated-through=2026-09-11T01:10:00Z -->
# RESEARCH — midmem-kb-store

Research and architecture decisions behind **midmem-kb-store**, grounded in published work we
research, develop, architect, and test against. This is a living document; each entry pairs a paper's
finding with the concrete design decision (or safeguard) it drove and how we validate it. Intended to
mature into a publishable record of *why the store is built the way it is*.

## How to add an entry
For each paper, capture: **(1) Paper** (cite + link), **(2) Finding** (the empirical claim that
matters to us), **(3) Decision** (what we changed or chose, and what we deliberately did *not*),
**(4) Validation** (how we test the safeguard holds — prefer deterministic checks + smoke tests).
Keep claims verified against the source, not a model's summary. Verdict vocabulary: **ADOPT NOW**
(serves the current build update; spec for `midmem-dev`) · **BACKLOG** (real gap, tracked by a
roadmap number below) · **VALIDATION** (confirms a shipped design — roadmap evidence) · **NOT
ADOPTING** (contradicts a non-goal; the reason is recorded). The `midmem-research-tracker` skill
maintains this file from the store's research ingestions; `node scripts/research-sources.mjs` lists
what the marker at the top has not yet evaluated.

> **Operational companion:** [`docs/DEVELOPMENT-GUIDELINES.md`](docs/DEVELOPMENT-GUIDELINES.md) turns
> these findings (DELEGATE-52 grounding, structured-over-fuzzy signals, verify-a-hook-*fires*, call-time
> DB paths, three-tier QA) into the concrete engineering rules that real MidMem integration work
> (OD-CYCLE-004…007) produced. [`docs/STACK-CAPTURE.md`](docs/STACK-CAPTURE.md) records what each agent
> stack actually captures. Increment numbers (#n) refer to [`docs/ROADMAP-2026-08.md`](docs/ROADMAP-2026-08.md)
> (1–15, shipped) and [`docs/ROADMAP-2026-09.md`](docs/ROADMAP-2026-09.md) (16–42).

---

## 2026-09-11 — Operator-named paper: procedural knowledge as a graph of (procedure, relation, procedure) triplets

Named by the operator via the tracker; not in the store before. Staged from the HTML full text
(`ingest-staging/arxiv-2609-09153-procedural-graphs/`), ingested scope `shared` type `research`:
grounding 0.902, 8 concepts + 1 claim kept, 0 quarantined, real embedding (entry
`memory-mtw8usyw-317bbda964ff`). No weekly digest covers this paper yet (submitted 2026-09-08).

### ADOPT NOW — the second reference capture pack is a procedure graph; procedures need relations to each other
- **Paper:** Yuxing Lu, Yicheng Chen, Shanchan Wu, Sercan Ö. Arık, *Procedural Graphs: Self-Evolving
  Execution Structures for LLM Agents* — arXiv [2609.09153](https://arxiv.org/abs/2609.09153)
  (submitted 2026-09-08; cs.AI, cs.CL, cs.MA).
- **Finding:** procedural knowledge kept as a directed, attributed graph of (procedure, relation,
  procedure) triplets — edges carrying *condition*, *guidance* and *pitfalls* — and served at each step
  as the h-hop neighbourhood around the agent's localized node beats memory-based baselines across
  six benchmarks and two solvers (sign test 19 wins / 2 ties / 3 losses, p = 4.3×10⁻⁴; e.g. τ-bench
  73.91% vs 60.87–71.30%, ALFWorld 93.28% vs 67.16–91.79% with Claude Sonnet). The *connected
  neighbourhood* is what matters: full-graph guidance scores 54.48% on ALFWorld against 81.53% for the
  subgraph, at 70.9% fewer guidance tokens — "independent retrieval of transition attributes, such as
  top-k similarity search, can omit the connections between procedural steps". Long-horizon
  EnterpriseArena survival rises 44%→58% (Claude Sonnet) and 6%→34% (Gemini 3.1 Pro). Self-evolution
  accepts an LLM-proposed graph edit only if held-out validation does not drop, and keeps every
  rejected candidate in a *rejection memory* so the same bad edit is not re-proposed (10 rounds:
  0% → 85% test survival, p = 2.6×10⁻⁸). Stated cost: guidance raises tokens per task even when it
  cuts solver steps (MultiChallenge 6,629 → 12,295).
- **Decision (ground-checked 2026-09-11):** MidMem stores procedures as pack-typed entries
  (`coding-patterns`: pattern / scaffold / anti-pattern / recipe, function `procedural`) whose graph
  node links only to *evidence* (the pack's edge) and *concepts* (`about`) — there is no
  procedure→procedure relation, and `recordPattern` has no way to write one even though packs may
  declare edge vocabularies (`packs.mjs`, `graph.mjs` `EDGE_TYPES`). So the paper's contribution is
  adoptable as the **second reference pack roadmap #22 already owes**: a `procedures` pack with a
  `procedure` type (tier memory, function procedural, fields *condition / guidance / pitfalls*) and
  the edge vocabulary `precedes · requires · alternative_to · pitfall_of`, plus one S-sized core seam
  — `recordPattern({ relations: [{ to, type }] })` writing pack-declared edges between pattern nodes.
  Retrieval of the connected neighbourhood is the bounded-expansion shape of **#25** (the paper's
  subgraph-vs-full-graph numbers are the strongest budget evidence in the ledger; composes with
  **#42**). Rejection memory is VALIDATION of `dead_end` work events with the retrieval demotion + the
  bench `dead-end-avoided` metric; validation gating that never restarts from a rejected candidate is
  VALIDATION of the paired bench gate and the **#35** verdict object. NOT ADOPTING in core: the
  LLM refiner that rewrites the graph — graph/schema evolution stays data plus a migration op (#22),
  and any such loop is a consumer's (orchestrator's) job that records its accepted procedures and its
  rejected candidates into the store.
- **Validation (planned with #22):** smoke — the `procedures` pack loads with zero errors; two
  procedures linked `precedes` are returned together by a neighbourhood read; an undeclared relation
  type is rejected; existing dead-end smoke + bench `dead-end-avoided` cover the rejection-memory half.

## 2026-09-09 — Weeks of 2026-08-31 and 2026-09-07: memory as typed, provenance-carrying state that must survive compaction, model swaps, poisoning and revocation

Evaluated by the research tracker straight from the two ingested weekly reports (no vault digest was
written for these weeks; store grounding 0.86 and 0.80, nothing quarantined). Build context: the
project axis (#18), recursive bridge roots (#38) and the fallback re-embed (#23) shipped the same day,
and the next consumer is the Agent Console's Wave 5 "prior knowledge, quarantined" recall card — a
read-only adapter that injects one fenced, length-capped block into a supervised agent's prompt. The
four ADOPT NOW decisions below are the design rules that card and its MidMem read must follow.

### ADOPT NOW — Stale constraints survive a budgeted verification; recall must route through supersession
- **Paper:** *When Stale Constraints Go Unchecked: Budgeted Verification Failures in Inherited Agent
  Memory* — arXiv [2608.25553](https://arxiv.org/abs/2608.25553). Carry-over driver: *Can Agent Memory
  Systems Track Evolving State?* (StateMem) — arXiv [2608.19652](https://arxiv.org/abs/2608.19652).
- **Finding:** agents inheriting consolidated memory that contains a withdrawn constraint fail to
  inspect the provenance path that reveals the newer authoritative state; under a fixed verification
  budget, native allocation produced stale-consistent decisions in roughly three quarters of tested
  episodes. Reallocating a single verification slot to the critical provenance path dramatically
  raised current-record-consistent decisions at the same total budget.
- **Decision:** the Wave 5 recall read is not `query` alone. It composes `query` with `claims`
  (mode `current`) and `claim_validity`, and never injects an entry whose claim is `superseded`,
  `contradicted` or `deferred` — the "one verification slot" is spent deterministically, in the
  adapter, before injection. Supersede/current/validity semantics already exist (#2, #13, #14);
  the card consumes them. Claim dependency edges (#32) stay BACKLOG, now with PlanFence as a second
  driver (below).
- **Validation:** `smoke.mjs` sections on `currentClaims()`, `supersedeClaim()` (on-subject +
  evidence-covered), `claimValidity()` (contradicted claim flagged not-currently-valid without a
  status mutation); `bench.mjs` `current-claim` metric = 1 on the treatment run.

### ADOPT NOW — An additive trust score cannot defend a budgeted brief; bound occupancy per source class
- **Paper:** *Utility Under Attack: Agent Memory Poisoning and the Limits of Content Screening and
  Provenance Ranking* — arXiv [2608.21230](https://arxiv.org/abs/2608.21230).
- **Finding:** poisoning a small fraction of persistent memory sharply degrades future performance;
  the tested write-time content screener rejected none of the deliberately false but fluent
  memories; a provenance weight strong enough to suppress untrusted poison also suppresses legitimate
  evidence from untrusted sources — a hard trade-off, not a tuning problem.
- **Decision:** MidMem's authority boost is exactly the "simple additive provenance weighting" the
  paper shows insufficient, so it stays a ranking nudge and stops being a defence. The token-budget
  selection in `hybridSearch` / `handoffBrief` / `proactiveRecall` gains per-authority occupancy caps
  with protected slots for `operator` lines and a minimum number of independent source lineages
  (composes with #34). Roadmap **#39**, effort S. What we do *not* do: add an LLM content screener —
  the paper measured that class of filter at zero recall on fluent poison.
- **Validation (planned with #39):** smoke — a budgeted brief over a store where one authority class
  holds 90% of matching entries still returns operator lines and at least N lineages; bench
  `recall-inject-tok` stays inside budget.

### ADOPT NOW — Retrieved memory is evidence, never instruction
- **Paper:** *InjecMEM: Memory Injection Attack on LLM Agent Memory Systems* — arXiv
  [2608.23471](https://arxiv.org/abs/2608.23471). Co-driver: *Agent Memory Is a Surface for Endogenous
  Authorization Laundering* — arXiv [2609.01836](https://arxiv.org/abs/2609.01836).
- **Finding:** one ordinary interaction, with no access to the memory store, plants a topical anchor
  engineered to be retrieved later plus a command optimized to survive varied fused contexts; the
  attack steers later turns across several memory systems and backbone models. The laundering paper
  shows the writer itself manufactures false authority for up to 50.2% of unauthorized requests, and
  executors act on it in 98.6% of trials once stored.
- **Decision:** the fenced recall block (console decision DEC-CM-10: drop, never clamp, the run's own
  output) is the right shape and is now backed on the MidMem side: `proactiveRecall` /
  `handoff_brief` headers state that the block is evidence, not instruction; a deterministic
  instruction-likeness tagger (`rank.instructionLike`: agent-directed imperatives, tool-call syntax,
  role markers) demotes and labels such lines. Roadmap **#40**, effort S. Authorization is never a
  memory: governance stays code (`governance.mjs`), the console's outbox allowlist stays the ledger,
  and MidMem records decisions but grants nothing — NOT ADOPTING an authorization ledger inside the
  store (VALIDATION of #10 no-raise authority + `operator` requires `curated:true`).
- **Validation (planned with #40):** smoke — an entry whose content is an agent-directed imperative
  is returned flagged and ranked below an unflagged peer with equal lexical score; existing
  governance smoke (`operator` authority without curation is denied) covers the laundering half.

### ADOPT NOW — Memory portability is a representation choice; re-embed must cover a model swap, not just outages
- **Paper:** *Does Your Agent's Memory Survive a Model Upgrade? A Controlled Study of Memory
  Portability* — arXiv [2609.05339](https://arxiv.org/abs/2609.05339). Co-driver: *Runtime-Independent
  Persistent Agents* — arXiv [2609.00546](https://arxiv.org/abs/2609.00546).
- **Finding:** the same histories stored as raw context, RAG chunks, model-written notes and
  fixed-schema knowledge graphs port very differently across a writer-model swap — fixed-schema
  structures stay stable while model-written notes are strongly coupled to the producing model; partial
  embedding migrations leave most of a full re-embedding's benefit unrealized.
- **Decision:** VALIDATION of the founding bet (`state.db` canonical; wiki, vectors and probes are
  disposable derived views; `export` #7 is the stable-schema snapshot). The re-embed path shipped today
  (`reembedFallback`, #23) repairs outage placeholders only; it must also drive a deliberate
  embedder-model swap over *every* vector (`reembed --model <old>` / `--all`), because partial
  migration is the measured failure. The migration pipeline is snapshot (#7) → migrate → re-embed (#23)
  → reproject → replay probes (#3, #15) → promote or roll back (#26). Amended into #23 and #26.
- **Validation:** smoke section 34 (re-embed self-gates offline, replaces in place, stops on a mid-run
  drop); the `vector_dim` canonical-dimension guard refuses mixed spaces; probes + bench replay after a
  swap are the promote/rollback gate once #26 lands.

### VALIDATION — confirmed by these weeks, no change
- *Making Prospective Memory SLM-Shaped: Typed Intention Stores* — arXiv
  [2609.01272](https://arxiv.org/abs/2609.01272): lifecycle logic in deterministic code, the model does
  only scoped language work, large PM-Bench gains including with small models. This is #6's design
  (MidMem records intents and outcomes; the scheduler fires). Its extra states (activate / defer /
  expire) and intent dependencies are folded into **#28**.
- *What Makes Agent Memory Useful for Reliable Unanswerable Question Handling?* — arXiv
  [2608.27924](https://arxiv.org/abs/2608.27924): procedural, rule-shaped memories guide more reliably
  than raw trajectories, and benefits are fragile under dataset shift. Validates the function axis
  (#4, procedural vs episodic); the trajectory → procedure step is **#27**; the explicit "cannot
  answer" output is **#19**.
- *LycheeMemory V2* — arXiv [2608.12990](https://arxiv.org/abs/2608.12990): segment-level consolidation
  instead of an LLM call per turn cuts construction tokens substantially. MidMem consolidates per
  document / per work event with no per-turn LLM — same choice.
- *LeanMem* [2608.03463](https://arxiv.org/abs/2608.03463), *LLM-Wiki* [2605.25480](https://arxiv.org/abs/2605.25480),
  *WiCER* [2605.07068](https://arxiv.org/abs/2605.07068) recur as supporting sources: type decides how
  compressible a memory is (#4), the wiki stays a rebuildable compiled layer over an evidence/state
  substrate (founding bet), compile → probe → refine (#3, #15).

### BACKLOG and NOT ADOPTING from these weeks → see the tables at the end
Compaction Cliff (2608.22752) → **#42** fidelity class; HERO (2608.22310) → **#34** evidence locator;
GraphMemix (2608.26983) → **#25** evidence-forest shape; Forgetting Without Restarting (2609.04875) →
**#41**; PlanFence (2609.03340) → **#32**; CHIME (2609.02074) → **#27/#31**; CAPTURE (2609.02265) →
**#33**; MemoryWalker (2609.00865) → not adopting.

---

## 2026-08-24 — Memory as governed state: independence of evidence, write commitment, order-randomized evaluation
Digest: vault `OpenClaw/research/2026-08-24-weekly-memory-research-digest.md` (+ ingest review). Headline: the
report describes the control plane MidMem already has; its three genuinely new items became #33, #34, #37.

- **StateMem** — *Can Agent Memory Systems Track Evolving State?* arXiv [2608.19652](https://arxiv.org/abs/2608.19652).
  **Finding:** recall of facts is not the same as maintaining the currently operative state; needs
  statuses, atomic supersession, validity, dependencies. **Decision:** VALIDATION of the claim ledger
  (statuses active/verified/contradicted/superseded/archived/deferred, atomic `supersede()`,
  `currentClaims()`, first/last observed #14, dangling-chain check #13, stale-path flags #12); claim
  dependency edges are BACKLOG **#32**; declared validity intervals and subject-predicate-value triples
  NOT ADOPTING (grounded text stays). **Validation:** smoke claim sections; bench `current-claim`.
- **Remember, Verify, or Ask?** arXiv [2608.19564](https://arxiv.org/abs/2608.19564). **Finding:** a
  four-outcome write policy (REMEMBER / SESSION_ONLY / VERIFY / ASK); models verify but under-ask.
  **Decision:** BACKLOG **#33** — classify each candidate claim from computed signals only (grounding
  score, write relation, subject churn, scope-ambiguous provenance); ASK is recorded as a prospective
  intent the consumer asks. Model-judged commitment NOT ADOPTING.
- **Beyond Memory Majority** arXiv [2608.19701](https://arxiv.org/abs/2608.19701). **Finding:**
  corroboration by majority is biased when the "corroborating" records descend from one upstream
  source; weight arbitration by independent lineage. **Decision:** BACKLOG **#34** — group hits and
  write relations by root source; sufficiency counts distinct lineages; `corroborating` only across
  roots. Driver in our own store: report + ingest review + digest all descend from one weekly report.
- **D²ACCI** arXiv [2608.17756](https://arxiv.org/abs/2608.17756). **Finding:** release-style gating for
  memory changes — paired baseline/treatment, protected slices, PROMOTE/FLAG/REJECT, stage-attributed
  traceability. **Decision:** VALIDATION of the paired bench with a non-zero-exit gate and the
  byte-stable export; BACKLOG **#35** protected slices + verdict object and **#36** retrieval trace;
  feature flags NOT ADOPTING as a new mechanism (`MIDMEM_*` env already is one).
- **On the Fragility of Self-Improving Agents** arXiv [2608.18066](https://arxiv.org/abs/2608.18066).
  **Finding:** self-improvement results can hinge on a hidden curriculum (insertion order); evaluate
  over seeds and gate on the worst case. **Decision:** BACKLOG **#37** — K seeded permutations of
  knowledge order in `bench.mjs`, per-metric spread, worst-case gate.
- **WMT** — *Weighted Memory Tree* arXiv [2608.20631](https://arxiv.org/abs/2608.20631). **Finding:**
  working vs durable separation with a task tree, fold/unfold of finished branches, activation scores.
  **Decision:** VALIDATION of the working function (context-assembly only, not persisted), lease renewal
  and budgeted briefs; the task hierarchy (`parent_of` + `folded`) is the open half of **#18**;
  in-context activation scoring stays consumer-side.
- **CABLE** arXiv [2608.17911](https://arxiv.org/abs/2608.17911). **Finding:** seed → expand → check with
  causal/temporal/antecedent edges traversed at query time. **Decision:** VALIDATION of the pipeline
  shape (concept seeding, ref-chain boost, sufficiency gate); typed-edge traversal folded into **#25** —
  `contradicts`/`supports`/`corrected_by`/`avoided` edges exist but are never read at query time.
- **Conflict Memory** (report section, no arXiv id given). **Finding:** unresolved conflicts should be
  preserved, not auto-resolved. **Decision:** VALIDATION of the deferred ledger + explicit
  `resolve()` and report-only consistency; second driver for **#24** (wiki rendering of conflicts).

## 2026-08-22 — AVO deep research: the winning agent pattern is curated knowledge + attempt lineage + verified commit
Doc: vault `OpenClaw/research/2026-08-22-avo-deep-research.md` (97 agents; 25 claims adversarially verified: 22 confirmed, 3 refuted).

- **AVO** — *Agentic Variation Operators for Autonomous Evolutionary Search* (NVIDIA) arXiv
  [2603.24517](https://arxiv.org/abs/2603.24517). **Finding:** one agent run over a scored lineage, a
  curated knowledge base and a hard correctness gate; 7 unattended days on B200, 500+ directions, 40
  committed versions, peak 1668 TFLOPS, +5.0–10.5% over FA4 on causal MHA configurations (cross-checked
  against the FA4 paper [2603.05451](https://arxiv.org/abs/2603.05451): 1613 TFLOPs/s, ~71% utilization —
  arithmetically consistent). **Decision:** VALIDATION — curated KB + deterministic
  grounding-before-persist + usage-earned promotion is the knowledge leg of that pattern; the lineage
  split mirrors tier/function. Strengthens **#17** (decision-role assembler) and **#18** (per-project
  attempt lineage — its `P_t`); new BACKLOG **#30** phase-aware retrieval profiles and **#31**
  structured outcome metrics on work events. The supervisor stays a harness concern (non-goal: no
  trigger execution in MidMem).

## 2026-08-17 — Serving cost, unresolved conflicts, snapshot restore: what the store is not yet
Digest: vault `OpenClaw/research/2026-08-17-weekly-memory-research-digest.md`. Headline: the report converges on what
MidMem already is and names three gaps; one bit us the same week (fallback vectors during the .210 outage).

- **Total Recall at What Cost?** arXiv [2608.11879](https://arxiv.org/abs/2608.11879). **Finding:** a memory
  system can look healthy while recall silently degrades unless per-op cost, call counts and
  degraded-mode share are measured. **Decision:** BACKLOG → half shipped as **#23**: the fallback
  re-embed path landed 2026-09-09 (driver: 54 placeholder vectors in August, 63 more on 2026-09-09);
  the serving-cost ledger (`durationMs` / `llmCalls` / `embedMode` in the op log, fallback share in
  `brief`) stays open. **Validation:** smoke section 34; `vectorHealth().fallbackVectors`.
- **TANGLE** arXiv [2608.13921](https://arxiv.org/abs/2608.13921). **Finding:** a conflict taxonomy with
  finer unresolved states (context-partitioned, oscillating…) rendered as current / alternative /
  context / open uncertainty. **Decision:** BACKLOG **#24** typed conflict states + wiki rendering
  (deferred ledger #9 and validity windows #14 exist; no class, no projection).
- **RippleMem** arXiv [2608.13334](https://arxiv.org/abs/2608.13334). **Finding:** multi-hop associative
  expansion from anchors with an evidence-completion step; ~30× cheaper graph construction consistent
  with a no-LLM build. **Decision:** BACKLOG **#25** — walk work-memory + typed edges ≤2 hops only when
  the full pass still fails `evidenceSufficient()`, then emit the #19 verdict.
- **ChronoMem** arXiv [2607.27773](https://arxiv.org/abs/2607.27773). **Finding:** snapshot-based
  rollback/restore. **Decision:** BACKLOG **#26** import + FTS/vector rebuild, refuse on schema
  mismatch; natural-language rollback NOT ADOPTING.
- **Externalization** arXiv [2604.08224](https://arxiv.org/abs/2604.08224) + **AMD** arXiv
  [2608.07169](https://arxiv.org/abs/2608.07169). **Finding:** skills separate from memory; procedures
  earn a "candidate" state from repeated successful task patterns. **Decision:** VALIDATION of the
  procedural function + capture packs + procedures shipped as skills, not entries; BACKLOG **#27**
  procedure-candidate detection (promotion to a skill file stays consumer-side).
- **MindMemOS** arXiv [2608.12428](https://arxiv.org/abs/2608.12428). **Finding:** versioned ontology
  evolution; LLM "dreaming" consolidation. **Decision:** the versioned-pack + migration-op half folded
  into **#22**; self-evolving schemas / dreaming NOT ADOPTING (DELEGATE-52 failure mode).
- **TrajWiki** arXiv [2608.00967](https://arxiv.org/abs/2608.00967) + **LLM-Wiki** (as above).
  **Finding:** the wiki is a compiled layer over a source-grounded trajectory substrate. **Decision:**
  VALIDATION — `state.db` is truth, `projectVault()` deterministic with `probeProjection()` QA, work
  events are the episodic trajectory with typed edges.

## 2026-08-10 — The wiki is a verified compiled artifact over transactional memory (founding bet validated); wave-2 increments 9–15
Digest: vault `OpenClaw/research/2026-08-10-weekly-memory-research-digest.md`. All seven became shipped increments (2026-08-10 wave 2).

- **TARL** arXiv [2608.03699](https://arxiv.org/abs/2608.03699) — pending/DEFER state + review queue
  instead of keep-or-reject. → **#9 shipped**: `deferred` claim status, `claims_deferred`,
  `claim_defer` / `claim_resolve`; contradictory arrivals defer by default. Validation: smoke deferred
  ledger; `lint().deferredClaims`.
- **Provenance Laundering** arXiv [2607.29167](https://arxiv.org/abs/2607.29167) — authority is lost
  when low- and high-trust inputs share one summarization path. → **#10 shipped**: origin authority
  `operator > stack > doc > web`, clamped through derived writes (never raised), `operator` requires
  curation, `minAuthority` read gate. Validation: smoke authority + governance denial.
- **Router-Mem** arXiv [2608.01285](https://arxiv.org/abs/2608.01285) — cheap pass + sufficiency gate
  before deeper retrieval. → **#11 shipped**: `progressiveSearch()` lexical-first, `evidenceSufficient()`
  deterministic, `deep:true` bypass. Validation: smoke sufficiency descriptors.
- **HiGram** arXiv [2608.05095](https://arxiv.org/abs/2608.05095) — hierarchical communities + dependency
  path rewrite. → **#12 shipped**: community hierarchy (`member_of`), stale-path flags on supersede,
  `stale_paths_clear` judgment op. Validation: smoke stale-path flagging + clear.
- **Verifiable Memory** arXiv [2608.03137](https://arxiv.org/abs/2608.03137) — verify the resulting
  global state, not only each mutation. → **#13 shipped**: `checkConsistency()` on forced maintain
  (cross-claim contradictions, dangling chains, deferred aging), report-only. Validation: smoke
  consistency section.
- **PGMem** arXiv [2608.01708](https://arxiv.org/abs/2608.01708) — evidence edges with first/last
  observed and contradicting evidence. → **#14 shipped**: `claim_validity` windows, `supportCount`,
  `currentlyValid` verdict without status mutation. Validation: smoke validity section.
- **PMMC** arXiv [2608.00962](https://arxiv.org/abs/2608.00962) — expected-query precompilation at
  consolidation. → **#15 shipped**: `query_probes`, persisted probe set, verified on forced maintain.
  Validation: smoke section 31.
- Also named this week and tracked in the roadmap re-evaluation: **MemArbiter**
  [2608.02113](https://arxiv.org/abs/2608.02113) (memory–action gap → **#17**), **Filesystem-Memory**
  [2607.26637](https://arxiv.org/abs/2607.26637) + **LeanMem** [2608.03463](https://arxiv.org/abs/2608.03463)
  (episode/project boundary → **#18**, half shipped 2026-09-09), **Horizon Gap**
  [2608.06663](https://arxiv.org/abs/2608.06663) (probe outcomes as a series → **#20**).

## 2026-08-03 — Memory tiers along independent axes; wave-1 increments 1–8
Report: `ingest-staging/weekly-arxiv-2026-08-03-llm-wiki-memory/report.md`. Headline: memory is a lifecycle, not a database.

- **Memory for Large Language Models** (survey) arXiv [2607.25380](https://arxiv.org/abs/2607.25380) —
  memory organized along orthogonal axes (representation, update dynamics, persistence, function).
  → **#4 shipped**: `mem_function` (working / episodic / semantic / procedural / prospective) orthogonal
  to the persistence tier, deterministic default per type, retrieval filter. Validation: smoke function
  axis; legacy rows resolve through the same map.
- **TRUSTMEM** arXiv [2606.25161](https://arxiv.org/abs/2606.25161) — omission / corruption / insertion
  are the three consolidation failures; verify the transition. → **#1 shipped**: `verifyTransition()`
  (subject overlap + evidence coverage) on supersede, `verifyPromotion()` grounding floor, receipts
  audited, deny by default. Validation: smoke transition sections.
- **MOSAIC** arXiv [2607.16211](https://arxiv.org/abs/2607.16211) — compare an incoming fact with graph
  neighbors before commit. → **#2 shipped**: write-path relation tagging (additive / corroborating /
  superseding-candidate / contradictory / uncertain), flag never auto-mutate. Validation: smoke
  `writeRelation`.
- **WiCER** arXiv [2605.07068](https://arxiv.org/abs/2605.07068) — naive compilation discards knowledge;
  compile → evaluate → refine recovers it; targeted probes beat generic instructions. → **#3 shipped**:
  `probeProjection()` completeness + sampled fidelity on forced maintain, report-only. Validation:
  smoke projection QA.
- **Retrieval as Reasoning: LLM-Wiki** arXiv [2605.25480](https://arxiv.org/abs/2605.25480) — navigational
  retrieval over interlinked pages beats independent chunks on multi-hop. → VALIDATION of the projected
  wiki as a navigational layer; the store, not the wiki, stays authoritative (Git-memory below).
- **PM-Bench** arXiv [2607.12385](https://arxiv.org/abs/2607.12385) — prospective memory tops out at
  65.1% F1 in-model. → **#6 shipped**: `prospective_add` / `prospective_due` / `prospective_resolve`;
  MidMem records intent + outcome, the scheduler (cron) fires — the F1 ceiling is exactly why.
  Validation: smoke prospective section; idempotent add is **#28**.
- **Ground Truth First** arXiv [2607.21962](https://arxiv.org/abs/2607.21962) + **Why Git Is the Memory
  Solution** arXiv [2607.14390](https://arxiv.org/abs/2607.14390) — compact curated memory wins on short
  horizons and loses older content under pressure, provenance-typed structure wins long; never let
  generated memory become authoritative where a real system of record exists. → **#7 shipped**:
  deterministic JSONL export (stable bytes, no vectors) for git revision history; capture packs **#5**
  keep domain schema as data. Validation: smoke export byte-stability.
- **LightMem** (no arXiv id in the source report; flagged at ingest review 2026-08-04) — route routine
  memory ops to a small model, reserve the strong model for consolidation. → VALIDATION of the
  dedicated extraction model (`MIDMEM_EXTRACT_MODEL`) separate from the chat primary; nothing else.

---

## 2026-06 — DELEGATE-52: LLMs corrupt documents under delegation
- **Paper:** Laban, Schnabel, Neville (Microsoft Research), *"LLMs Corrupt Your Documents When You
  Delegate"* — DELEGATE-52 benchmark, 19 LLMs × 52 domains. arXiv [2604.15597](https://arxiv.org/abs/2604.15597).
  (Source ingested in midmem; findings verified against it, not a summary.)
- **Findings:** even frontier models corrupt **~25% of content over ~20 delegated interactions**
  (avg ~50% across models); errors are **sparse but severe and compound silently**; **agentic tool
  use does not help (+6% degradation)**; severity rises with **document size, interaction length, and
  distractor context**; short-horizon performance does not predict long-horizon.
- **Decisions (what we built / chose):**
  - **Extraction grounding check** (`src/grounding.mjs`, wired into `ingest`): deterministically
    quarantine extracted concepts/claims whose content-words aren't in the source — *before* they
    persist. Never ask the model to self-verify faithfulness (the paper shows that fails).
  - **Protect `state.db` content, not the projection.** The vault projection is deterministic
    (`project.mjs`, no LLM) and regenerable — it is NOT a corruption surface. The real surfaces are
    *ingest extraction* and *long edit sessions*. (Corrected an earlier mis-analysis that flagged the
    projection.)
  - **Quantitative tier promotion**, never LLM judgment — promotion runs on retrieval/feedback signals.
  - **Bounded, verify-after-write curation** (the `midmem-orchestrator` / `hermes-build-orchestrator`
    loop): cap interactions per unit of work, restrain tools on edits, QA each write against the spec.
  - **Tight, budgeted context** (`handoff_brief`, `proactiveRecall` maxTokens) to limit the
    distractor-context degradation the paper measured.
- **Validation:** `packages/core/test/smoke.mjs` covers grounding (keeps grounded, quarantines
  confabulated, scores) and the ingest grounding report; the `midmem-ingest-review` skill audits
  stored knowledge and cross-checks OpenClaw vs Hermes understanding using deterministic signals.

---

## Backlog — tracked for a roadmap build-out
One row per open item. Effort: S = one module + smoke · M = module + surfaces + docs · L = schema or lane change.
Evidence: numbers (benchmark / controlled result) or prose (the source gives no measurement).

| Paper | Finding that matters | Candidate | Roadmap # | Effort | Evidence | Blocker / note |
|---|---|---|---|---|---|---|
| Procedural Graphs [2609.09153](https://arxiv.org/abs/2609.09153) | procedure triplets served as an h-hop neighbourhood beat memory baselines (19/2/3 sign test); subgraph 81.53% vs full graph 54.48% at −70.9% tokens | `procedures` pack (condition / guidance / pitfalls; `precedes · requires · alternative_to · pitfall_of`) + `recordPattern` relations seam; neighbourhood read | **#22** (spec), **#25** (evidence) | S | numbers (six benchmarks, two solvers) | ADOPT NOW — next `midmem-dev` item after #39/#40; LLM refiner stays consumer-side |
| Utility Under Attack [2608.21230](https://arxiv.org/abs/2608.21230) | additive provenance weighting cannot suppress poison without suppressing legitimate untrusted evidence | per-authority occupancy caps + protected operator slots + lineage minimum in budgeted selection | **#39** | S | prose (screener rejected 0 poisons) | ADOPT NOW — next `midmem-dev` item; composes with #34 |
| InjecMEM [2608.23471](https://arxiv.org/abs/2608.23471) | one ordinary interaction plants a retrievable command | instruction-likeness flag + "evidence, not instruction" inject framing | **#40** | S | prose | ADOPT NOW; deterministic patterns only |
| Forgetting Without Restarting [2609.04875](https://arxiv.org/abs/2609.04875) | deleting the record leaves derived summaries/plans unchanged | dependency-aware `forget` (claims by source, sole-support concepts, dirty pages, cascade log) | **#41** | M | prose ("substantially fewer" tokens) | execution-state replay stays consumer-side |
| Compaction Cliff [2608.22752](https://arxiv.org/abs/2608.22752) | 53% of safety rules survive one compaction, 10% after five | fidelity class (verbatim / loss-limited / compressible) from authority × tier; verbatim lines untruncated in briefs | **#42** | S | numbers (20 configs) | today every result is a 600-char preview |
| Memory Portability [2609.05339](https://arxiv.org/abs/2609.05339) | partial embedding migration forfeits most of a full re-embed | `reembed --model <old>` / `--all` for an embedder swap; migration pipeline with replay probes | **#23** (amend), **#26** | S / M | prose | re-embed half shipped 2026-09-09 |
| Total Recall at What Cost? [2608.11879](https://arxiv.org/abs/2608.11879) | healthy-looking store, degraded recall | serving-cost ledger in the op log + fallback share in `brief` | **#23** (ledger half) | S | prose + our own outages | — |
| StateMem [2608.19652](https://arxiv.org/abs/2608.19652) + PlanFence [2609.03340](https://arxiv.org/abs/2609.03340) | operative state needs dependencies; a freshness-only executor acted on obsolete plans in every revision scenario | `depends_on` claim edges; decisions cite the record ids they depend on; supersede flags dependents | **#32** | M | controlled workflows (PlanFence) | action-time validation is the consumer's |
| Remember, Verify, or Ask? [2608.19564](https://arxiv.org/abs/2608.19564) + CAPTURE [2609.02265](https://arxiv.org/abs/2609.02265) | models under-ask; recency + provenance cannot separate drift from poisoning | deterministic write-commitment policy with an ASK outcome recorded as a prospective intent; competing hypotheses with evidence ids | **#33** | M | prose | no LLM judgment in the classifier |
| Beyond Memory Majority [2608.19701](https://arxiv.org/abs/2608.19701) + HERO [2608.22310](https://arxiv.org/abs/2608.22310) | corroboration by majority is lineage-biased; derived memory should point to evidence | group by root source in retrieval/arbitration; claims keep a source excerpt locator | **#34** | S–M | prose | our own store shows the bias (digest chains) |
| RippleMem [2608.13334](https://arxiv.org/abs/2608.13334) + CABLE [2608.17911](https://arxiv.org/abs/2608.17911) + GraphMemix [2608.26983](https://arxiv.org/abs/2608.26983) | multi-hop expansion behind the gate; typed edges read at query time; budgeted evidence-forest selection | ≤2-hop traversal over work + typed edges when the full pass fails sufficiency; forest-style budget with redundancy/conflict penalties | **#25** | M–L | prose (~30× cheaper build, RippleMem) | after #19 verdict |
| TANGLE [2608.13921](https://arxiv.org/abs/2608.13921) + Conflict Memory (section) | finer unresolved-conflict states, rendered | typed conflict classes on deferred pairs + wiki rendering | **#24** | M | benchmark instances (TANGLE) | — |
| ChronoMem [2607.27773](https://arxiv.org/abs/2607.27773) + Runtime-Independent Agents [2609.00546](https://arxiv.org/abs/2609.00546) | snapshot restore; quiesce → checkpoint → validate → bind → rehydrate | `import_knowledge` + FTS/vector rebuild, schema-version refusal, replay probes gate | **#26** | M | prose | NL rollback not adopting |
| Externalization [2604.08224](https://arxiv.org/abs/2604.08224) + AMD [2608.07169](https://arxiv.org/abs/2608.07169) + CHIME [2609.02074](https://arxiv.org/abs/2609.02074) + UAQ [2608.27924](https://arxiv.org/abs/2608.27924) | procedures earn a candidate state; type lessons by causal role (planning / execution / tool / environment), attribute before memorizing | procedure-candidate detection from repeated successful attempts; causal-role field on work events | **#27**, **#31** | S–M | gains across four benchmarks (CHIME, unquantified) | skill promotion stays consumer-side |
| Typed Intention Stores [2609.01272](https://arxiv.org/abs/2609.01272) | deterministic lifecycle + scoped LM work wins PM-Bench, even with small models | states activate / defer / expire + intent dependencies; idempotent add | **#28** | S | "large gains" (unquantified) | validates #6 |
| D²ACCI [2608.17756](https://arxiv.org/abs/2608.17756) | protected slices; stage-attributed evidence loss | protected bench slices + PROMOTE/FLAG/REJECT verdict; retrieval trace log op | **#35**, **#36** | S | prose | — |
| Fragility of Self-Improving Agents [2608.18066](https://arxiv.org/abs/2608.18066) | hidden curriculum in insertion order | K seeded permutations in the bench, worst-case gate | **#37** | S | prose | `test/bench.mjs` only |
| WMT [2608.20631](https://arxiv.org/abs/2608.20631) | fold finished subtasks; task tree | `parent_of` task edge + `folded` flag; `handoff_brief` collapses done branches | **#18** (open half) | M | prose | activation scoring consumer-side |
| AVO [2603.24517](https://arxiv.org/abs/2603.24517) | phase-shifted consultation; scored attempt lineage steered a 7-day unattended run | phase-aware retrieval profiles; structured outcome metrics on work events | **#30**, **#31** | M / S | numbers (adversarially verified) | — |
| MemArbiter [2608.02113](https://arxiv.org/abs/2608.02113) · Router-Mem [2608.01285](https://arxiv.org/abs/2608.01285) · Horizon Gap [2608.06663](https://arxiv.org/abs/2608.06663) · MindMemOS [2608.12428](https://arxiv.org/abs/2608.12428) | memory–action gap; explicit insufficiency; probe outcomes as a series; versioned packs | decision-role assembler; insufficient-evidence verdict; probe-outcome series; pack versioning + migration op | **#17**, **#19**, **#20**, **#22** | M / S / S / S | prose | #17 is the strongest open item |

## Not adopting — recorded so the question is not reopened by the next digest
- **Context compaction as a MidMem feature** — Compaction Cliff [2608.22752](https://arxiv.org/abs/2608.22752),
  MemoryWalker [2609.00865](https://arxiv.org/abs/2609.00865): MidMem does not own a context window; the
  harness compacts. We take the retention-by-type lesson (#42) and nothing else.
- **An authorization ledger inside memory** — Endogenous Authorization Laundering
  [2609.01836](https://arxiv.org/abs/2609.01836): authorization is governance code and the consumer's
  allowlist; MidMem records decisions and never grants (the paper is VALIDATION of #10, not a feature).
- **LLM-judged belief tracking / clarification** — CAPTURE [2609.02265](https://arxiv.org/abs/2609.02265):
  no LLM judgment in arbitration or promotion paths; the deterministic ASK outcome (#33) is the bound.
- **LLM content screening at write time** — Utility Under Attack [2608.21230](https://arxiv.org/abs/2608.21230)
  measured it at zero recall on fluent poison; grounding-before-persist plus bounded occupancy is the
  defence.
- **Self-evolving schemas / "dreaming" consolidation** — MindMemOS [2608.12428](https://arxiv.org/abs/2608.12428):
  DELEGATE-52 failure mode; schema changes are data (packs) with a migration op.
- **Natural-language rollback** — ChronoMem [2607.27773](https://arxiv.org/abs/2607.27773): restore is a
  snapshot import, never a model interpreting "undo".
- **Subject-predicate-value triple claims / declared validity intervals** — StateMem
  [2608.19652](https://arxiv.org/abs/2608.19652): grounded text claims with observed windows stay.
- **Feature flags as a new mechanism** — D²ACCI [2608.17756](https://arxiv.org/abs/2608.17756): `MIDMEM_*`
  env already gates every behavior.
