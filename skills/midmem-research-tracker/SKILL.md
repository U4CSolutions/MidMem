---
name: midmem-research-tracker
description: >-
  Keep the repo's RESEARCH.md ledger current from the research ingestions already in the MidMem
  store: for every unevaluated weekly research ingestion, evaluate each paper's feasibility and
  applicable improvement for MidMem, and record it as Paper (cite + link) · Finding (the empirical
  claim that matters) · Decision (adopt now / backlog with a roadmap number / validation of a
  shipped design / not adopting, with why). Use after each weekly research digest lands, or when
  asked to "update the research ledger", "what research applies to the roadmap", "evaluate the
  weekly papers", "refresh RESEARCH.md". Companion to `midmem-research-digest` (which handles the
  report's arrival); this skill owns the ledger and the feasibility verdicts.
---

# MidMem Research Tracker — ingestion → grounded ledger → roadmap-ready decisions

`RESEARCH.md` is the record of *why the store is built the way it is*: each paper paired with the
finding that matters and the decision it drove (or the reason it is parked). A weekly digest is an
LLM synthesis; the ledger is only trustworthy when every entry is checked against the source
document and the actual core code (DELEGATE-52 discipline — never grade the system from a summary).

## Inputs
- The store: research-shaped sources in `state.db` (type `research`, weekly report / digest paths,
  arXiv-id file names). The deterministic intake list is
  `node scripts/research-sources.mjs` (reads the ledger's `evaluated-through` marker; `--json`,
  `--all`, `--include-gone`, `--mark <ISO>`).
- The ledger: `RESEARCH.md` (repo root). Marker line: `<!-- research-tracker: evaluated-through=<ISO> -->`.
- Ground truth for "what exists": `packages/core/src/` and the current `docs/ROADMAP-*.md` status
  marks (✅ shipped / open increment numbers).

## Procedure

1. **Intake.** `node scripts/research-sources.mjs`. For each unevaluated source read its
   **grounding numbers** first (`summaryScore`, quarantined counts come from the entry's own
   provenance). `summaryScore` ≲ 0.4 or heavy quarantine → re-ingest per `midmem-ingest` before
   evaluating; a ledger built on a drifted extraction poisons the roadmap.
2. **Extract, from the source document — not the store summary.** For each paper the source
   covers, capture: `title`, `arxiv_id`, `link` (`https://arxiv.org/abs/<id>`; null if the source
   gives none — say so), `finding` (the empirical claim with its numbers), the source's own
   recommendation, and a relevance tag tied to ONE MidMem capability (retrieval · tiers/promotion ·
   claims/contradictions · grounding · work-memory · concept graph · projection · bridge/ingest ·
   bench/eval · governance/authority · project axis). Large reports → delegate extraction to a
   subagent that reads the file in full and returns JSON; never let it summarize from memory.
3. **Ground-check each recommendation against the code.** Targeted greps beat reading:
   `memFunction` (typing) · `supersede|contradict|defer` (claims) · `authority` · `communit|parent`
   (graph) · `sufficien|progressive` (gating) · `project` (project axis) · `reembed|fallback`
   (serving) · `bridgeSources|walkMarkdown` (capture). Then place it against the roadmap: shipped
   (which ✅ increment), open (which #), or absent.
4. **Feasibility rubric (deterministic, one line per paper).**
   - *Fit* — the subsystem it lands in (from step 2's tag).
   - *Effort* — S (one module + smoke) / M (module + surfaces + docs) / L (schema or lane change).
   - *Discipline check* — passes zero-deps, deterministic (no LLM in verifier/tagger/promotion
     paths), pure-core (no stack names), grounding-before-persist, maintain re-entrancy? Any "no"
     is a blocker to name.
   - *Evidence* — numbers from a benchmark / a controlled result / prose only.
   - *Verdict* — **ADOPT NOW** (serves an in-flight increment or the current build update and is
     S/M with a clean discipline check) · **BACKLOG** (real gap; gets or keeps a roadmap #) ·
     **VALIDATION** (confirms a shipped design — cite it under that entry, it is roadmap evidence) ·
     **NOT ADOPTING** (say why: contradicts a non-goal, filesystem-as-truth, LLM-judged promotion…).
5. **Write the ledger.** Dated `## YYYY-MM-DD — <theme>` sections, newest at top, one entry per
   ADOPT NOW / VALIDATION paper with **Paper · Finding · Decision · Validation** (validation = the
   smoke assertion, bench metric or deterministic check that proves the safeguard holds). BACKLOG
   papers go to the **Backlog** table (paper · finding · candidate · roadmap # · effort · blocker).
   NOT ADOPTING papers go to the **Not adopting** list with the reason. Every arXiv id links.
   Then advance the marker: `node scripts/research-sources.mjs --mark <latest ingested_at evaluated>`.
6. **Roadmap consistency.** A BACKLOG row without a roadmap # gets a new row in the current
   `docs/ROADMAP-*.md` (same table format: increment · driver · principle served). An ADOPT NOW
   verdict does not open code — hand it to `midmem-dev` with the ledger entry as the spec.
7. **Record.** Commit the ledger + roadmap delta (`docs: research ledger <date> — N papers, A adopt /
   B backlog / V validation`), push, and store one lesson per genuinely new rule via
   `midmem-record`. If a changelog exists, one line with counts and the marker.

## Judgment calls
- A paper that matches what is already built is not noise — record it as VALIDATION under the
  existing entry; consistent external validation is how a design earns its keep.
- One paper, one verdict. If it drives two increments, the entry cites both; do not split it.
- Prefer the paper's own numbers over the digest's paraphrase; if the digest gives none, say
  "prose only" in *Evidence* and let that lower the verdict.
- Contradictions with an earlier week: check the store's current claims (`midmem claims "<topic>"`)
  and supersede the ledger entry — never keep both versions.
- Per-paper full-text ingests are NOT part of this loop; fetch a paper only when its increment is
  picked up or the operator names it.
