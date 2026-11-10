# Concepts — the mental model

One page to hold the whole system in your head. Everything here is enforced by code, not
convention; the verification commands live in [ARCHITECTURE-BASIS.md](ARCHITECTURE-BASIS.md).

## The one-sentence architecture

**`state.db` (SQLite) is the single source of truth; the markdown wiki is a deterministic,
regenerable projection of it; agents reach it only through the CLI, the MCP server, or the hook
seam.** Long-term memory is treated as a reproducible knowledge product, not a pile of
remembered text.

## Entries, tiers, lifecycle

An **entry** is the atomic memory record (content + type + provenance + concepts + scope).
Entries live in three **tiers**:

| tier | what it is | TTL | how you get in |
|---|---|---|---|
| `fact` | raw, unprocessed capture | 7d lease | direct store |
| `memory` | synthesized knowledge with context | 30d lease | ingest/remember default |
| `wisdom` | curated, verified knowledge | permanent | **earned** (usage + helpful feedback), **approved by the operator** (one entry at a time) or explicitly curated |

Retrieval **renews leases** (decay-by-disuse); repeatedly-unhelpful entries get archived by the
maintenance sweep. **Promotion is earned by use, or approved by the operator in person — never by
an LLM's judgment** (of itself or of anything else). Wisdom is curated-only: governance blocks
uncurated writes, and the one other road in is the operator's approval.

**Operator-approved wisdom** (operator decision 2026-11-10; `approve-wisdom`, [INTEGRATION-MODES.md
§6](INTEGRATION-MODES.md) item 6(e)). The operator may approve ONE `memory` entry into `wisdom`. The
approval stands in for the **usage evidence** of the earned rule (retrievals, trust, helpful votes) and
for nothing else: the entry must still be active, in `memory`, not a `working` entry, above the
write-time grounding floor, and not flagged instruction-like; governance and the transition verifier
still run, with their receipts. It is not curation — authority stays what it was (`web` for a capture),
so no protected recall slots — and `revoke-wisdom` takes it back (the entry returns to `memory` with a
fresh lease and can then earn wisdom by use like any other). This is not LLM judgment in a promotion
path, so the roadmap's non-goals — no LLM in any verifier or tagger path, promotion never by LLM
judgment — stay true: the decision is a person's, made on one entry, recorded with when and through which
system; every check is the same deterministic code; and a model may at most **prepare** a case for the
operator to read — it never decides, and nothing it says is ever sent as an approval.

Orthogonal to tier, every entry has a **memory function** — `working | episodic | semantic |
procedural | prospective` — so retrieval can filter by *role* ("give me procedures") regardless
of persistence.

## Claims — atomic facts with a lifecycle

Facts extracted from sources become **claims** with provenance. Claims have real state:

- **Write-path relation**: every new claim is compared to live neighbors at write time —
  novel / corroborating / superseding-candidate / additive / **contradictory**.
- **Contradictory claims are deferred**, not stored as truth: they land in the **pending
  ledger** awaiting explicit accept/reject (TARL). Deferred claims are invisible to
  current-fact retrieval until resolved. A third judgment (2026-11-10), **replace the neighbour**,
  accepts the claim and supersedes the live claim it contradicts in one step — never a neighbour of
  higher authority (a web claim never replaces an operator-authored one). All three are explicit:
  nothing resolves a deferred claim automatically.
- **Supersede** replaces an outdated claim, cross-linked both directions; `claims` (current
  mode) always returns the freshest non-superseded fact.
- **Validity windows** (PGMem): corroboration extends `lastObserved`/`supportCount`;
  contradiction records evidence refs; `claim_validity` renders a currently-valid verdict.

## Grounding — the DELEGATE-52 gate

Ingest extraction (concepts, claims, summary) is checked **deterministically against the source
text** before anything persists; unsupported items are quarantined. No LLM ever reviews its own
faithfulness — grounding, categorization, community detection, and contradiction detection are
all deterministic code paths.

## Scopes — multi-agent partitioning

Every entry has a **scope** (an arbitrary string — `openclaw`, `hermes`, `codex`, anything).
An agent writes to its own scope or `shared`; reads default to *own + shared*. `shared` is the
admin/bridge context. Governance blocks cross-private writes. Adding a new agent requires **zero
code** — set `MIDMEM_AGENT_SCOPE` in its registration.

**Reclassification is governed, never hand-edited.** `rescope` moves selected entries to another
scope (metadata-only — content, tier, lease and `updated_at` untouched; the move is recorded in
`provenance.rescoped`), and `authority_lower` corrects an over-labelled origin **downward only**,
propagating to the claims derived from it. Both require a selector (ids, source-path prefix, or content
match), preview with `dryRun`, and a stack scope may reclassify only rows in its own scope and `shared`.
The default vault bridge keeps each agent folder private but bridges its `research/` and `reports/`
subfolders as `shared` — deliverables are meant for both stacks; notes can be personal.

## Project axis — per-project memory, global lessons

Orthogonal to scope: **scope** says who may read/write an entry (access), **project** says which
body of work it belongs to (partition). `entries.project` is nullable — `NULL` means global.
`MIDMEM_PROJECT` is a process's default: writes (`remember`, `ingest`, `record_work`,
`prospective_add`, `record_pattern`) tag it, and reads (`query`, `proactive_recall`,
`handoff_brief`) return *project + global* — the same shape as scope's own-plus-shared rule. A
process with no project writes global and reads everything (the admin/bridge analog); `projects`
on a read overrides the default, `[]`/`null` lifts it. Any scope may tag any project — access
stays scope's job, so no governance policy changed.

**Lessons climb.** Promotion into the curated-only `wisdom` tier lifts a project entry to global
(`project → NULL`, lineage kept in `provenance.liftedFrom`): a dead end or decision that earns
wisdom through use in one project becomes available to every project without being written twice.
`MIDMEM_PROJECT_LIFT=0` keeps the tag on promotion.

## Source authority — trust that can't be laundered

Every record carries an origin **authority**: `operator > stack > doc > web`. Claims inherit it
from their source; derived writes are **clamped to their parent's level** — summarization can
never raise trust. `operator` requires explicit curation (governance-gated). Retrieval exposes a
`minAuthority` filter so action-risky callers can exclude low-trust origins.

## Retrieval — progressive and evidence-aware

`query` runs lanes: FTS5 token ⊕ trigram ⊕ vector cosine, fused by RRF, then small additive
boosts (trust, shared-concept graph, recency/usefulness, authority, concept-community routing;
dead-ends are demoted and flagged). **Progressive gating** runs the cheap lexical lanes first
and only pays for embedding/vector/concept work when a deterministic sufficiency check says the
evidence isn't enough. Every result carries provenance + the stage that answered.

## Graph — concepts, communities, hierarchy

Grounded concepts become canonicalized graph nodes (case/plural variants fold to one node);
label-propagation communities are materialized as **parent nodes** (`member_of` edges) for
coarse-to-fine structure. When a claim is superseded, the concept nodes it touched — and their
community parents — are flagged as the **stale dependency path** for review (never auto-rewritten).

## Work memory & prospective memory

Agents record **work events** (task attempts, sources used, dead ends, corrections, artifacts,
decisions) as first-class entries + typed edges — "memory about work" that makes *how* something
was done recallable. **Prospective memory** stores future intents with date/event triggers;
MidMem surfaces what's due (`prospective_due`) but **never fires anything** — your scheduler
(cron) stays the system of record for time.

## Extension — capture packs

Domain extensibility is **data, not code**: a JSON pack registers entry types (tier + function),
categorizer rules, and edge vocabularies. The core never learns domain names — that discipline is
what keeps the same build running in all four deployment modes and keeps any single use-case from
bending the memory layer. Ship your domain as a pack, not a patch.

## Maintenance — self-driving, verified

An opportunistic throttled pass (plus a daily forced one) runs: decay sweep → earned promotions →
concept-graph refresh → retention pruning → wiki reprojection → **projection QA** (WiCER probes) →
**expected-query probes** (would a plausible future query find its evidence?) → **global
consistency check** (state-level contradictions, dangling supersede chains, deferred-ledger
aging). All verification is report-only: findings queue for judgment, nothing self-mutates.
