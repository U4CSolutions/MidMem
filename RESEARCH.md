<!-- research-tracker: evaluated-through=2026-10-06T00:18:24.870Z -->
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

## 2026-10-05 — Weeks of 2026-09-21, 2026-09-28 and 2026-10-05: write cheaply and keep the evidence; evolve policy only behind gates; route across memories instead of unifying them

Three weekly reports evaluated together (none has a vault digest; the digest step was skipped):
`ingest-staging/llmwiki-weekly-2026-09-21/report.md` (ingested 2026-09-23, grounding 0.917, 0 quarantined),
`…-2026-09-28/report.md` (2026-10-02, grounding 0.69 — the lowest of the series, above the 0.4 re-ingest
line) and `…-2026-10-05/report.md` (2026-10-05, grounding 0.864, 0 quarantined; entry
`memory-muv91862-06e277892ce6`). Fourteen papers are cited; every arXiv id was fetched from the arXiv
API and the digests' figures were read against the abstracts. Five already carry a verdict and keep it:
RippleMem [2608.13334](https://arxiv.org/abs/2608.13334) (#25), Procedural Graphs
[2609.09153](https://arxiv.org/abs/2609.09153) (2026-09-11 entry), LLM-Wiki
[2605.25480](https://arxiv.org/abs/2605.25480) (the founding bet, 2026-08-10), WikiSkill
[2608.27454](https://arxiv.org/abs/2608.27454) (2026-10-03 entry), and the LLM-Wiki carry-over in all
three reports. Two store facts shaped this evaluation: (1) the 09-28 ingest's RRSI claim had inverted the
paper ("reducing out-of-distribution performance by up to 4.7 points"; the abstract reports *gains* of
up to 4.7 points out of distribution) and was superseded on 2026-10-02 by a claim read from the abstract
(`claim-muq83sv7-551db3205192`) — the digest is a paraphrase, the abstract is the source; (2) the six-paper
10-05 report produced one 430-character summary, eight concepts and one claim, and the name MemAgent
appeared nowhere in the store while the grounding score read 0.864 — the ADOPT NOW entry below.
Verdicts: 1 ADOPT NOW · 7 VALIDATION · 5 BACKLOG · 3 NOT ADOPTING (one paper, one verdict; a paper that
validates one design and opens a gap in another is counted once, under the entry that names both).

### ADOPT NOW — a multi-paper digest is ingested per cited section, so paper-level facts survive the summary
- **Paper (2026-10-05 report):** Mitchell Piehl, Muchao Ye, *MemFit: Efficient Long-Term Agentic Memory* —
  arXiv [2610.00872](https://arxiv.org/abs/2610.00872) (submitted 2026-10-01; cs.AI).
- **Finding:** every turn is stored verbatim in an append-only store with LLM-free insertion, and segment
  summaries *index* the turns rather than replace them; retrieval is LLM-free too (lexical + semantic
  signals, cross-encoder reranking over caption-augmented episodes). State of the art on LoCoMo,
  MemGallery and LongMemEval-S while memory construction time and cost fall "several-fold" (the abstract
  gives no finer number). The lesson that matters to us: a summary written at ingest is an index, and an
  index that *replaces* its source loses exactly the facts a later question asks for.
- **Decision:** measured on 2026-10-05, MidMem's ingest keeps a summary, grounded concepts and grounded
  claims plus the source path — for a six-paper digest that was 430 characters, eight concepts and one
  claim; "MemAgent", "URAM", "Ansatz", "Error Book" and DyadMem's sizes were retrievable by neither stack.
  Adopted (`midmem-dev`, 2026-10-05): `midmem ingest <path> --sections` (orchestrator `ingestSections`, MCP
  `ingest` with `sections:true`): a deterministic split on markdown headings, every section that cites
  exactly one URL is ingested through the same grounded path as its own entry, keyed by the canonical
  citation (arXiv ids normalised to `https://arxiv.org/abs/<id>`, versions stripped) so a paper cited by a
  later week supersedes its earlier section entry instead of duplicating it, and the digest entry stays as
  the index with links to its sections. Not adopted: MidMem as the verbatim evidence archive — that is the
  library's job (#49, the KB Article Library); the core keeps the index and the path to the file.
- **Validation:** smoke assertions for the split (one-citation sections ingested, two-citation and short
  sections skipped with a reason, re-run skipped as unchanged, a later digest citing the same id
  supersedes, a secret-shaped citation URL skipped while the rest proceed, a path outside the allowed
  roots denied before any section file is written); the 10-05 digest re-ingested with `--sections` and
  the store searched for "MemAgent" and "URAM" afterwards (the check the `midmem-ingest-review` skill now
  requires after every digest ingest). Landed 2026-10-06 as `92ac9e7` (smoke 629 → 667); the 10-05 digest
  re-ingested with `--sections`: 6 of 6 cited sections became entries (grounding 0.60–0.90, one claim
  each, `provenance.digestSections` on the index entry); "MemAgent", "URAM", "Error Book" and the
  61,210 figure are now findable; "Ansatz" still is not (the section summary kept the memory's name,
  not the agent's) — the index remains an index, the source file remains the evidence.

### VALIDATION — confirmed by these weeks, no change
- **Agent Zero Memory** (09-21, carried 09-28) — Ming Wu, Pengyuan Zhu, *Agent Zero Memory:
  Provenance-Aware Long-Term Memory for LLM Agents* — arXiv [2608.29606](https://arxiv.org/abs/2608.29606).
  Three parallel memories (an episodic events timeline, an entity-event graph, a curated, citation-locked
  documentary memory), every learned item a provenanced item with origin, timestamp and evidence pointer,
  and every answer read under a citation lock so it can cite only evidence its reader opened; 95.60%
  LongMemEval and 93.60% LoCoMo (+0.73 / +1.10 over the strongest prior systems); across eight backbones
  accuracy varies by 3.4 points while cost varies ~30×. Validates the design MidMem already runs: entries +
  claims + concept graph + work events + the projected wiki as parallel views of one `state.db`, the
  provenance chain on every entry and claim (#10 authority at origin), grounding-before-persist, and
  the sufficiency gate as the intent gate (#19). The "memory-driven, not model-driven, quality" result is
  the argument for the small-model extraction path we run.
- **ScrubJay-MEM** (09-21) — Kartikey Singh Bhandari, Aarya Wadhwani, Dhruv Kumar, Pratik Narang, *Caching
  for the Future: Scrub Jay Episodic Memory Principles for Agent Memory Systems* — arXiv
  [2608.04746](https://arxiv.org/abs/2608.04746). Per-memory, type-conditioned temporal decay (a
  perishability coefficient and a utility horizon per memory) is *necessary* for temporal generalisation:
  only retrieval system with substantially positive GenGap (+0.108) on their Temporal Generalization
  Test, F1 +2.66 over Mem0 and +3.09 over Qwen3-Embedding-4B on EventQA-64k, and a decay ablation collapses
  GenGap 5.7×; gains narrow under stronger backbones and reverse on fact-consolidation tasks. Validates
  #47 (pack-declared lease per entry type: a research paper keeps a 180-day lease, a work event a short
  one) together with the P3 temporal boosts and retrieval-renewed leases — decay by type, refreshed by
  use, history never deleted (#43). Their scoping caveat is ours too: the lease is a retrieval signal,
  never a judgment.
- **MemRL** (09-21) — Shengtao Zhang, Jiaqian Wang, Ruiwen Zhou et al., *MemRL: Self-Evolving Agents via
  Runtime Reinforcement Learning on Episodic Memory* — arXiv [2601.03192](https://arxiv.org/abs/2601.03192).
  Similarity-matched episodic memory retrieves noise; a second phase selects by utility learned from
  environmental feedback (HLE, BigCodeBench, ALFWorld, Lifelong Agent Bench; the abstract gives no numbers).
  Validates the lifecycle rule that promotion is earned by use and feedback (`retrieval_count`,
  `helpful_count`, `trust_score`, the `feedback` op), never by similarity alone. The RL part is the
  NOT ADOPTING item below.
- **Harness as a Language (JAZ)** (09-28) — Zhening Li, Joshua Liu, Mateja Vukelic et al., *Harness as a
  Language: A Minimalist Agent Framework With Maximal Expressivity* — arXiv
  [2609.26891](https://arxiv.org/abs/2609.26891). A single recursive `invoke` primitive with runtime
  variables as the only state beats Letta (MemGPT) by 8% at half the cost on the recall-heavy part of
  StuLife and ACE by 4% at lower cost on AppWorld. The lesson the digest draws — execution-local state
  belongs in runtime variables and checkpoints, durable memory only for what must survive a session, a
  model or a host — is #44 (the `working` function never promotes and expires on its own lease) and the
  reason the hook seam records work *events*, not transcripts.
- **RRSI** (09-28) — Peng Xia, Rujun Han, Zifeng Wang et al. (Google Research), *RRSI: Regularized Recursive
  Self-Improvement of Agent Harnesses* — arXiv [2609.24972](https://arxiv.org/abs/2609.24972). Unregularised
  harness evolution memorises its training split; a budgeted proposer plus a critic and pruner keep
  reusable mechanisms: up to +14.1 points on the evolution split, up to +4.7 on five out-of-distribution
  benchmarks, 30% fewer policy tokens. Validates #35 — a retrieval or ranking change ships only through
  the protected bench slices and the PROMOTE/FLAG/REJECT verdict — and the rule that policy lives in
  `MIDMEM_*` knobs and pack versions, separately from content. The out-of-distribution half amends #37
  (backlog table): the bench has no held-out slice yet, so a policy can still overfit the fixtures it is
  gated on.
- **Continual Graph Memory / Ansatz** (10-05) — Junyi Zhang, Jinxi Yu, Eric Hanchen Jiang et al.,
  *Continual Graph Memory for Mathematical Research Agents* — arXiv
  [2610.02945](https://arxiv.org/abs/2610.02945). A graph of facts, plans, counterexamples, intermediate
  results, dependencies and lessons; dependency-aware retrieval; an evidence-sensitive curator; and
  *scoped recall* that surfaces earlier statements and negative findings "for local re-proving rather than
  uncritical reuse" — closure on all ten First Proof Second Batch problems (prose for our purposes).
  Validates negative knowledge as first-class in MidMem: `dead_end` work events, the `dead-end-avoided`
  bench slice, Failed Attempts in the record skill, and labelled historical reads (#43) as the scoped-recall
  discipline ("previously observed; verify locally").
- **MemAgent** (10-05) — Yongxian Wei, Yilin Zhao, Runxi Cheng et al., *MemAgent: Learning to Manage
  Heterogeneous Memory Providers for LLM Agents* — arXiv [2609.32521](https://arxiv.org/abs/2609.32521).
  Thirteen memory methods evaluated; none generalises across benchmarks; routing across providers
  (content-aware probing before retrieval, short-term gating, selective multi-provider storage) lifts
  average accuracy by 10.0% on GAIA, WebWalkerQA and xBench-DS with under 0.3% routing overhead and 12%
  fewer task steps. Validates the rule-based router MidMem already has — sufficiency-gated stages, the
  library lane asked only at the deep stage (#49), pre-turn recall never calling a provider unless
  configured — and the decision to keep the library a separate system rather than one universal store.
  The learned router is the NOT ADOPTING item below.

### BACKLOG and NOT ADOPTING from these weeks → the tables at the end
DyadMem [2610.03020](https://arxiv.org/abs/2610.03020) (relational memory function; delete / suppress
bench slice; **#52**), LAM [2610.02488](https://arxiv.org/abs/2610.02488) (memory economics in the op log;
amends **#23**), LycheeMemory V2 [2608.12990](https://arxiv.org/abs/2608.12990) (episode-boundary
consolidation of working memory; **#53**), RSIAgent [2609.15364](https://arxiv.org/abs/2609.15364)
(verify-then-freeze procedures by version; amends **#27**), RRSI's held-out slice (amends **#37**).
Not adopting: a learned memory-management policy (AgeMem [2601.01885](https://arxiv.org/abs/2601.01885),
MemRL, MemAgent's trained router), MidMem as the verbatim evidence archive (MemFit), and a "Memory Harness
Registry" as a new subsystem (the 09-28 recommendation).

## 2026-10-03 — Operator-named paper: a persistent wiki between raw experience and executable skills

Named by the operator (`/midmem-ingest-review https://arxiv.org/abs/2608.27454`); not in the store or
this ledger before. Staged from the HTML full text (`ingest-staging/arxiv-2608-27454/`, abs page kept
beside it), ingested scope `shared` type `research` authority `doc` with source provenance
(`canonicalUri` → the abs page): grounding 0.913, 6 concepts + 1 claim kept, 0 quarantined, real
embedding (entry `memory-murmkpza-9e5104043699`). The one kept claim was read against the abstract
and holds. No weekly digest covers this paper yet (submitted 2026-08-27; the 08-31 and 09-07 reports
did not cite it).

### BACKLOG (amends #22 · #27 · #31 · #32) + VALIDATION (#11 · #35 · #41 · #49) — WikiSkill
- **Paper:** Liyan Tang, Cyrus Rashtchian, Chun-Sung Ferng, Andrew Tomkins, Da-Cheng Juan, Tu Vu
  (Google Research), *WikiSkill: Compiling Agent Experience into Persistent Knowledge for Skill
  Evolution* — arXiv [2608.27454](https://arxiv.org/abs/2608.27454) (submitted 2026-08-27; cs.AI, cs.CL).
- **Finding:** skill evolution works better when what the agent learned is kept as a *separate,
  persistent knowledge layer* rather than scattered through optimisation history. The workspace has
  three layers — `raw/` (immutable execution traces), `wiki/` (pattern pages for failure modes and
  successful strategies with workarounds, an `index.md`, an evolution log `logs.md`, and a
  `skill-impact.md` written **programmatically by the outer harness**: proposal metadata, target skill,
  unified diff, validation score, accept/reject), and `skills/` (`SKILL.md` + a `PURPOSE.md` mapping
  each skill back to the wiki patterns that motivated it). Each iteration an Inference Agent runs the
  training split with the active skills (wiki access *withheld*), a Wiki Maintainer consolidates
  sampled traces into patterns with patch-based edits, a Skill Proposer reads the index + impact
  tracker + an outcome summary and pulls pattern pages and traces on demand, and a gate accepts the
  single atomic proposal only if validation score ≥ the running threshold, rolling the skill set back
  otherwise — **the wiki is never rolled back**. Across LiveMath, SealQA, SpreadsheetBench, OfficeQA and
  ALFWorld with Qwen-3.5-4B/9B, Qwen-3.6-27B, Gemma-4-31B and Gemini-3.5-Flash, WikiSkill beats the
  strongest of Trace2Skill / EvoSkill / SkillOpt by 3.3 / 5.1 / 10.0 / 5.8 / 12.0 points per model.
  Gains grow with scale (Qwen 4B/9B/27B: +12.3% / +17.5% / +23.9% average) yet skills compensate for
  scale (Qwen-3.5-9B with skills 47.4% vs Qwen-3.6-27B without 39.4%). Evolved skills transfer across
  models and can beat self-evolved ones (ALFWorld: 9B at 70.2% with the 27B-evolved skill vs 63.4% with
  its own) — when they capture general procedures rather than model-specific workarounds. Ablation
  (Gemini-3.5-Flash): giving the Proposer the persistent wiki lifts the average 48.7% → 63.7%; giving
  the *Inference Agent* wiki access during training rollouts lowers it 63.7% → 60.9% (LiveMath 72.6% →
  64.8%) — trajectories become less informative for skill development. 6.3–8.9 patterns created and
  7.0–18.4 edited per model on average, all retained; 39–52% of accepted skill updates land in the
  first two iterations and the rest continue through the middle and late stages.
- **Decision (ground-checked 2026-10-03 against `workmemory.mjs`, `packs.mjs`, `graph.mjs`):**
  - **VALIDATION of the layer split:** `sources` (hash-keyed, path-stable, never rewritten) / entries +
    claims + graph projected into the vault wiki / pack-typed procedural entries are the paper's
    raw / wiki / skills, and "the wiki is never rolled back while skills are" is the design already
    encoded in `dead_end` events (the evidence of a rejected attempt stays and is retrieved as a
    warning) and in **#41**'s cascade running only on *revoked evidence*, never on a rejected procedure.
  - **#31 amended — `skill-impact.md` is the field spec for structured outcomes.** Today
    `provenance.work` holds `kind · task · status · outcome (prose) · source · artifact · profile ·
    related` (`workmemory.mjs:126`) — no score, no target, no verdict. #31's `metrics` object gains
    the harness-written fields the paper shows carry the loop: `target` (the procedure/artifact
    changed), `delta` (a diff reference, not the diff text), `score` (validation metric) and
    `verdict` (`accepted|rejected`), all supplied by the consumer's harness, none by an LLM. The
    `dead-end-avoided` bench slice then has a structured predicate (rejected verdict on the same
    target) instead of a prose match.
  - **#22 amended — `PURPOSE.md` is a `motivated_by` edge.** `recordPattern` writes its `evidence`
    as free-string `source` nodes (`packs.mjs:98`), so a procedure cannot be traced to the *entries
    or claims* that justified it — label-only provenance. The `procedures` pack's `relations` seam
    (already specified) adds `motivated_by` from a procedure to pattern/evidence **entry ids**, and
    `evidence` accepts entry ids that resolve to entry nodes. The 2026-10-02 audit of the 09-28 weekly
    report found the same gap from the other side: report entries name papers but carry no arXiv id.
  - **#32 amended — a superseded motivating claim flags its procedures.** With `motivated_by` edges,
    `supersede()`'s HiGram pass flags dependent procedures `staleReview` the way it flags communities.
    **Prerequisite:** the 2026-10-02 finding that `graph.findByText` (`orchestrator.mjs:919`) matches
    any ≥3-char substring of any token with no stopword filter — one supersede flagged 196 nodes (99
    via `agent`, 23 via `out` in "Router", 7 via `can` in "Canada"), one of them real. Until that pass
    tokenizes with `grounding.contentWords` and matches whole label tokens, every flag it writes is
    noise and #32's extension would multiply it.
  - **#27 amended — both polarities.** The Wiki Maintainer's stated job includes "identify which
    errors recur across iterations"; #27 detects only N *successful* attempts sharing a task label +
    tool signature. Add the mirror: N `dead_end` / failed `task_attempt` events sharing a failure
    signature → a suggested anti-pattern. Deterministic, same seam.
  - **#31/#18 amended — record who evolved it.** Transferability depends on general-procedure vs
    model-specific-workaround, and a consumer can only tell if the producing model/harness is on the
    record. Work events and patterns gain an optional `agent: { model, harness }` provenance field
    (today nothing in `provenance.work` identifies the producer beyond scope).
  - **VALIDATION #35:** accept-iff-validation-≥-θ with a ratcheting θ and rollback on rejection is the
    `PROMOTE / FLAG / REJECT` verdict + `.bench-last.json`; that 48–61% of accepted updates arrive
    *after* the first two iterations is why the protected slices run every round, not once.
  - **VALIDATION #11 / #49:** the Proposer receives index + impact tracker + outcome summary and pulls
    pattern pages and raw traces on demand — progressive retrieval with the evidence layer behind the
    sufficiency gate.
  - **Consumer guidance, not core (the ablation):** withhold semantic recall from the acting agent
    during *evaluation* rollouts so its trajectories measure the procedure, not the wiki. MidMem
    already offers the knobs (`functions: ["procedural"]`, `tiers`, `types` on query / proactive
    recall); the policy belongs in the orchestrator skills (`midmem-orchestrator`,
    `hermes-build-orchestrator`), which should record it.
  - **NOT ADOPTING in core:** the LLM Wiki Maintainer and Skill Proposer — pattern consolidation by an
    LLM and skill proposal are the consumer's orchestrator loop; MidMem records the accepted patterns,
    the rejected ones as `dead_end`, and the verdicts. Full-prompt injection of every active skill
    (§3.2.1, chosen to remove retrieval as a confound) is the opposite of #39's bounded occupancy and
    stays a benchmarking choice, not a design.
- **Validation:** the paper reports numbers for five benchmarks × five models plus a four-way ablation
  (Table 3) and a per-iteration acceptance breakdown (Appendix Table 5); the layer, gate and audit-trail
  claims are read from §3.1–§3.2.4 of the staged full text. Our side: smoke assertions arrive with each
  amended increment (#31 structured fields round-trip through `record_work` → `provenance.work`; #22
  `motivated_by` resolves to an entry node; #27 fires on N failures sharing a signature; #32 a
  supersede flags ≤ the claim's own concept count).

---

## 2026-09-14 — Week of 2026-09-14: what is stored vs what is used; lifecycle at write time; summaries as cues

Weekly report ingested (`ingest-staging/llmwiki-weekly-2026-09-14/report.md`, scope `shared`, type
`research`): grounding **0.909**, 11 concepts + 1 claim kept, **0 quarantined**, real embedding,
verification clean (entry `memory-mu195djt-ad3da0374ece`). Seven key papers; one (Procedural Graphs
2609.09153) was already evaluated on 2026-09-11 and is cross-referenced, not re-decided. The report's
own headline — "persistent memory should retain more than the agent actively uses" — is the week's
one genuinely new architectural claim against our code, and it lands on the entry store, not the
claim ledger.

### ADOPT NOW — the claim ledger already separates stored from used; the entry store does not
- **Paper:** *What Should an Agent Forget? Separating What Is Stored from What Is Used* (RD-Forget) —
  arXiv [2609.10263](https://arxiv.org/abs/2609.10263) (submitted 2026-09-09).
- **Finding:** forgetting for answering does not require deleting history. The framework keeps the
  source archive and builds a *query-conditioned* view: a superseded value is suppressed for
  current-state questions while staying retrievable for historical ones, via semantic slots,
  same-slot replacement links, intent-aware retrieval and rate-distortion selection at answer time.
  The report states the distinction as five states: stored · eligible for current query · suppressed
  for current query · historically retrievable · physically deleted. *Evidence: prose — the report
  quotes no benchmark numbers for this paper.*
- **Decision (ground-checked 2026-09-14):** MidMem implements exactly this split for **claims** and
  not at all for **entries**. `claims.search()` accepts a `statuses` filter and searches every status,
  while `current()` narrows to active/verified — that is RD-Forget's two views, already shipped (#14,
  #9). Entries are the opposite: every read path hardcodes `status='active'` — both FTS lanes and the
  vector-candidate filter in `retrieval.mjs`, plus `listActive()` and `activeVectors()` in
  `memory.mjs`. Archival is therefore a **one-way exit from retrieval**: the lifecycle sweep archives
  an expired lease or a distrusted entry, supersede-on-reingest archives the previous version, and
  from that moment the content is reachable only by `recall(<id>)` if the caller already knows the id
  (`memory.get()` has no status filter — history is preserved, just unsearchable). For a consumer
  whose run history outlives a 30-day `memory` lease, that is silent loss of exactly the historical
  answers this paper says to keep. Adopt the read half: a `statuses` / `asOf` option threaded through
  the lanes and `listActive`, defaulting to current-only so today's behavior is unchanged, plus a
  `historical:true` query mode that reports which results are archived and why. Roadmap **#43**,
  effort S — no schema change (the `status` column and the archival writes already exist), fully
  deterministic. NOT ADOPTING: rate-distortion answer-time selection (a learned objective; our
  budgeted selection stays deterministic) and semantic slots as a new schema (claim supersession
  already carries the same-slot link).
- **Validation (shipped 2026-09-16, smoke section 38):** an archived entry is absent from a default query and
  present in a `historical` query, labelled archived; a superseded ingest's prior version is
  retrievable historically while the current version alone answers the default query; `recall(id)`
  behavior for archived entries is asserted unchanged.

### BACKLOG — `working` memory is documented as non-persistent and nothing enforces it
- **Paper:** *LifeFuse-Mem: Lifecycle-Aware State Fusion Against Temporary Overwriting for Long-Term
  Memory* — arXiv [2609.12436](https://arxiv.org/abs/2609.12436) (submitted 2026-09-11).
- **Finding:** **temporary overwriting** — a short-lived condition incorrectly replaces durable
  knowledge because the system treats recency as equivalent to persistence. The fix is lifecycle
  metadata carried on the write (`class: transient | durable`, `valid_for`, `promotion_allowed`) so
  transient and durable state evolve separately; retention tier and lifecycle semantics are different
  axes. *Evidence: prose.*
- **Decision (ground-checked 2026-09-14):** MidMem already declares the axis and does not enforce it.
  `MEMORY_FUNCTIONS` includes `working`, documented in `workmemory.mjs` as "context-assembly-time only
  — valid but not persisted by default", but `working` appears nowhere else in the core: a caller may
  store a `working` entry and it persists exactly like a semantic one, it is ranked by the same lanes,
  and `autoPromoteCandidates()` filters on tier, trust and counts only — so a transient entry that
  happens to be retrieved enough can be promoted toward `wisdom`. That is the paper's failure mode
  reached by our own promotion path rather than by recency. Roadmap **#44**, effort S–M: honor the
  declared contract — `working` entries are lease-bound and ineligible for promotion, excluded from
  default reads, and may never supersede an entry of durable function. Deterministic, no LLM, no new
  column (`mem_function` exists). This is a documentation-versus-code discrepancy, so it also earns a
  smoke assertion regardless of when the rest lands.
- **Validation (shipped 2026-09-16, smoke section 39):** a `working` entry is never returned by
  `autoPromoteCandidates()`; a `working` write does not archive a durable entry on the same subject;
  the existing function-axis filter still returns it when `functions:['working']` is asked for
  explicitly.

### VALIDATION — confirmed by this week, no change
- **AIM** — arXiv [2609.12320](https://arxiv.org/abs/2609.12320): privacy scope must be a field on the
  memory object with **index-level** enforcement, not a prompt instruction (96.0% visibility
  classification accuracy, 58.8% strict and 70.5% state-aware operation accuracy on its MUMBench).
  MidMem enforces scope exactly there — `scope IN (…)` is a SQL predicate in both FTS lanes, the
  vector-candidate filter, `listActive()` and `activeVectors()`, with a fail-closed governance policy
  blocking cross-private writes; reads default to own-plus-shared and the project axis adds a second
  orthogonal partition. What we do **not** have is a per-*user* axis (`owner_id`, `shared_with`,
  `tenant`): our scopes are per-agent. Deliberately deferred — a third partition needs a real
  multi-user consumer, and the store is single-operator today. Tracked as a watch row, not an
  increment.
- **Agent Zero Memory** — arXiv [2608.29606](https://arxiv.org/abs/2608.29606): three parallel
  representations (memory events timeline, entity-event graph, hierarchical documentary memory) with
  provenance, timestamp and evidence pointers on every learned item, plus citation-locking so an
  answer may cite only evidence actually opened; 95.60% LongMemEval, 93.60% LoCoMo, and **accuracy
  varies far less than cost across backbone models**. MidMem's three representations over one
  `state.db` are the same shape: work events are the episodic timeline, the typed concept graph is the
  associative layer, the projected wiki is the documentary layer. The cross-model result is
  independent evidence for two of our standing choices — architecture over backbone size, and a
  dedicated small extraction model rather than the chat primary. Citation-locking is a consumer rule:
  the Wave 5 recall card should cite only the entry ids it actually injected, which is already how the
  fenced block is built.
- **Procedural Graphs** — arXiv [2609.09153](https://arxiv.org/abs/2609.09153): evaluated
  2026-09-11 (ADOPT NOW → the #22 `procedures` pack spec). This report independently states the same
  conclusion we drew — a semantic graph and a procedural graph, separate but cross-referencing — which
  is why #22's pack declares procedure→procedure edges rather than a second node type in the concept
  graph. No re-decision.
- **Recommendation 10** (smaller models for routine memory operations, frontier models reserved for
  hard consolidation) restates the 2026-08-03 LightMem lesson and matches the shipped split
  (`MIDMEM_EXTRACT_MODEL` separate from the chat primary).

### Amendments to open increments
- **#34** gains a second driver: **CueMem** arXiv [2609.12354](https://arxiv.org/abs/2609.12354) —
  compressed records should act as *cues* that map to source-turn anchors and expand locally to
  reconstruct evidence, beating long-term baselines on LoCoMo and LongMemEval at fewer query-time
  tokens than full-history prompting. Our entries carry `provenance.originalSource` and a `source_id`
  row, which is a *file path*, not a locator: reconstructing evidence means re-reading the whole
  document. HERO (2608.22310) already put an excerpt locator on #34; CueMem raises its rank and adds
  the local-expansion step, which is the same bounded neighbourhood #25 owes.
- **#35** gains a security dimension: **SoK: Rethinking Jailbreaking in the Era of Agentic AI** arXiv
  [2609.12413](https://arxiv.org/abs/2609.12413) — a final-output filter cannot repair a poisoned
  durable memory state, so evaluation must cover write → state → retrieval, not answer accuracy. Our
  smoke covers governance denials and write-time grounding, and the bench covers recall quality;
  neither has an adversarial slice. #35's protected slices should include poisoned-entry,
  instruction-injection and scope-leak probes — which also makes the already-adopted **#39**
  (bounded occupancy) and **#40** (instruction-likeness flag) the tests' subjects rather than
  untested claims.

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
- **Validation (shipped 2026-09-16, smoke section 37):** a budgeted brief over a store where one authority class
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
- **Validation (shipped 2026-09-16, smoke section 35):** an entry whose content is an agent-directed imperative
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
| DyadMem [2610.03020](https://arxiv.org/abs/2610.03020) | memory about *how this agent works with this user* is a category of its own (URAM); Gold-Memory QA strong, Full-Pipeline QA drops sharply across 16 open-weight + 4 proprietary models; low capture recall and unsafe deletion even in frontier LLMs; 3,065 episodes / 50,961 sessions / 61,210 QA | a `relational` value on the function axis (today: working · episodic · semantic · procedural · prospective) with its own lease and inject framing; a delete / suppress bench slice (forget must not leave a derived claim live — #41's cascade, measured) | **#52** | M | numbers | none; the capture side already records per-user events, the axis value and the slice are core work |
| LAM [2610.02488](https://arxiv.org/abs/2610.02488) | harness resources are the cost: context–memory traffic, access pattern, stored state vs recomputation, verification, checkpoint interval (a resource theory with tight bounds; experiments on chained MATH tasks) | the op log records ingest duration + extraction tokens and per-query retrieval cost; `brief` reports recomputation avoided (dedup skips, linked duplicates) beside the fallback share | **#23** (ledger half, amended) | S | theory + controlled experiments; prose for our metrics | none |
| LycheeMemory V2 [2608.12990](https://arxiv.org/abs/2608.12990) | consolidating semantic segments instead of every turn keeps 89.22% LoCoMo / 92.20% LongMemEval-S while cutting construction tokens 86.0% / 75.9% vs A-Mem, with no extra query-time tokens | `consolidateWork` batches working entries at an episode boundary (session end, project transition) instead of per event; boundary detection deterministic (event kinds + time gap), no LLM | **#53** | M | numbers | depends on #18's episode boundary |
| RSIAgent [2609.15364](https://arxiv.org/abs/2609.15364) | reusable causal rules (action, condition, consequence) are built by explore → verify → freeze and reused without weight updates (OSWorld-v2, Agent's Last Exam; the abstract gives no numbers) | procedure candidates (#27) carry a verification record before promotion and are superseded by version, never mutated in place (entries already supersede on re-ingest; claims already `supersede`) | **#27** (amended) | S | prose | none |
| RRSI [2609.24972](https://arxiv.org/abs/2609.24972) (held-out half) | harness evolution overfits its evolution split (+14.1 in-distribution vs +4.7 out of distribution) | a held-out bench slice the PROMOTE verdict must also pass, beside the K seeded permutations | **#37** (amended) | S | numbers | none |
| WikiSkill [2608.27454](https://arxiv.org/abs/2608.27454) | a persistent, never-rolled-back knowledge layer between immutable traces and executable skills lifts skill evolution (+15.0 avg with Proposer wiki access; beats the strongest baseline by 3.3–12.0 points per model); a harness-written impact ledger (target · diff · validation score · verdict) stops re-proposing rejected edits; `PURPOSE.md` traces each skill to its motivating patterns | #31 structured outcome fields `target · delta · score · verdict` + `agent:{model,harness}`; #22 `motivated_by` edges to entry ids; #27 recurring-*failure* signatures; #32 superseded motivating claim flags its procedures | **#31** (spec), **#22**, **#27**, **#32** (amend) | S each; #32 blocked | numbers (five benchmarks × five models, four-way ablation) | #32's extension waits on the `findByText` stale-path flagger fix (2026-10-02: 196 nodes flagged by one supersede); Maintainer/Proposer LLM loops stay consumer-side |
| RD-Forget [2609.10263](https://arxiv.org/abs/2609.10263) | forgetting for answering ≠ deleting history; a query-conditioned view suppresses superseded values that stay historically retrievable | `statuses`/`asOf` through the lanes + a `historical` query mode (claims already have this split; entries hardcode `status='active'`) | **#43 ✅ 2026-09-16** | S | prose | shipped; no schema change |
| LifeFuse-Mem [2609.12436](https://arxiv.org/abs/2609.12436) | transient context must not overwrite durable knowledge by recency; lifecycle is an axis beyond retention | enforce the declared `working` contract: lease-bound, never promoted, excluded from default reads, never supersedes a durable entry | **#44 ✅ 2026-09-16** | S–M | prose | shipped; the doc-vs-code discrepancy is closed |
| CueMem [2609.12354](https://arxiv.org/abs/2609.12354) | compressed memory should be a cue mapping to source anchors, then expand locally | source excerpt locator + local expansion (second driver, raises rank) | **#34**, **#25** | S–M | prose (LoCoMo, LongMemEval; no figures quoted) | our `originalSource` is a file path, not a locator |
| SoK Jailbreaking [2609.12413](https://arxiv.org/abs/2609.12413) | a final-output filter cannot repair a poisoned durable memory state | adversarial slice (poisoned entry, instruction injection, scope leak) in the protected bench slices | **#35** | S | prose | makes #39/#40 tested rather than asserted |
| AIM [2609.12320](https://arxiv.org/abs/2609.12320) | multi-user memory needs owner/tenant visibility on the object, enforced at the index | per-user scope axis (`owner_id`, `shared_with`) beside the agent scope | watch — no consumer yet | M | numbers (96.0% visibility classification) | index-level enforcement already VALIDATED; deferred until a real multi-user consumer |
| Procedural Graphs [2609.09153](https://arxiv.org/abs/2609.09153) | procedure triplets served as an h-hop neighbourhood beat memory baselines (19/2/3 sign test); subgraph 81.53% vs full graph 54.48% at −70.9% tokens | `procedures` pack (condition / guidance / pitfalls; `precedes · requires · alternative_to · pitfall_of`) + `recordPattern` relations seam; neighbourhood read | **#22** (spec), **#25** (evidence) | S | numbers (six benchmarks, two solvers) | ADOPT NOW — next `midmem-dev` item after #39/#40; LLM refiner stays consumer-side |
| Utility Under Attack [2608.21230](https://arxiv.org/abs/2608.21230) | additive provenance weighting cannot suppress poison without suppressing legitimate untrusted evidence | per-authority occupancy caps + protected operator slots + lineage minimum in budgeted selection | **#39 ✅ 2026-09-16** | S | prose (screener rejected 0 poisons) | shipped; composes with #34 |
| InjecMEM [2608.23471](https://arxiv.org/abs/2608.23471) | one ordinary interaction plants a retrievable command | instruction-likeness flag + "evidence, not instruction" inject framing | **#40 ✅ 2026-09-16** | S | prose | shipped; eight named deterministic patterns |
| Forgetting Without Restarting [2609.04875](https://arxiv.org/abs/2609.04875) | deleting the record leaves derived summaries/plans unchanged | dependency-aware `forget` (claims by source, sole-support concepts, dirty pages, cascade log) | **#41 ✅ 2026-09-16** | M | prose ("substantially fewer" tokens) | shipped; execution-state replay stays consumer-side |
| Compaction Cliff [2608.22752](https://arxiv.org/abs/2608.22752) | 53% of safety rules survive one compaction, 10% after five | fidelity class (verbatim / loss-limited / compressible) from authority × tier; verbatim lines untruncated in briefs | **#42 ✅ 2026-09-16** | S | numbers (20 configs) | shipped |
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
- **Rate-distortion answer-time memory selection / semantic slots as new schema** — RD-Forget
  [2609.10263](https://arxiv.org/abs/2609.10263): the two-view split is adopted (#43), but budgeted
  selection stays deterministic rather than a learned objective, and claim supersession already
  carries the same-slot replacement link.
- **Feature flags as a new mechanism** — D²ACCI [2608.17756](https://arxiv.org/abs/2608.17756): `MIDMEM_*`
  env already gates every behavior.
- **A learned memory-management policy** — AgeMem [2601.01885](https://arxiv.org/abs/2601.01885) (memory ops as
  agent actions under a GRPO-trained policy), MemRL [2601.03192](https://arxiv.org/abs/2601.03192) (utility
  learned by runtime RL), MemAgent [2609.32521](https://arxiv.org/abs/2609.32521) (a trained router): MidMem
  exposes the same operations as tools (46 MCP tools) and routes by deterministic rules; promotion is earned
  by use and feedback, never by a learned or LLM judgment (the founding discipline, DELEGATE-52).
- **MidMem as the verbatim evidence archive** — MemFit [2610.00872](https://arxiv.org/abs/2610.00872): the
  core stays light; verbatim text lives in the library system (#49) and the source file, the core keeps the
  index (summary, concepts, claims, per-section entries) and the path.
- **A "Memory Harness Registry" as a new subsystem** — the 2026-09-28 digest's recommendation: `MIDMEM_*`
  knobs, the pack version ledger (#47) and the bench verdict (#35) already version policy apart from
  content and gate its promotion; a registry object would duplicate them.
