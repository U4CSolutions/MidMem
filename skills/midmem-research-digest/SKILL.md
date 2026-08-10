---
name: midmem-research-digest
description: >-
  Digest a recurring research report (e.g. a weekly arXiv review of memory-systems papers)
  end-to-end: verified ingest into MidMem, a GROUNDED gap-analysis of every recommendation
  against the actual MidMem source code (not memory of it), a published digest for the operator,
  and roadmap deltas recorded in the repo. Wraps `midmem-ingest` for intake; this skill owns
  digestion, gap analysis, and recording.
---

# MidMem Research Digest — from report to roadmap, grounded

A research digest is an LLM-written synthesis. Its value is only realized when each
recommendation is checked against what the store ACTUALLY implements (DELEGATE-52 discipline)
and the deltas land in the roadmap. Never let a report grade your system by itself — its "you
should have X" claims are hypotheses to verify, not facts.

## Procedure

1. **Intake via `midmem-ingest`** (authoritative for staging rules): stage the report, build a
   citations manifest (canonical paper ids, dedup against the store), ingest
   `--scope shared --type research`, **read the grounding numbers** — note the CLI summary may
   print only `{"success": true}`; the authoritative record is the `log` table row
   `operation='ingest'` (`summaryScore`, `concepts`, `claims`, `quarantined`) in `state.db` —
   then run the recall check.
2. **Ground-check every "the system should…" recommendation against the source** at
   `packages/core/src/` — targeted greps beat reading: memory typing (`memFunction`), claim
   verbs (`supersede|contradict`), ledger states (`pending|quarantine|deferred`),
   provenance/authority (`provenance|trust|authority`), graph shape (`communit|parent`),
   retrieval gating (`sufficien|progressive`). Sort every recommendation into exactly one
   bucket: **already-have** (cite the evidence) / **partial** (what exists, what's missing) /
   **new gap** / **explicitly-not-adopting** (say why — e.g. filesystem-taxonomy ideas don't
   apply to a DB-as-truth + projected-wiki design).
3. **Write the digest** where your operator reads documents. Structure: headline (what this
   report validates or overturns about the architecture) → already-have (with code evidence) →
   gaps as a **priority-ordered roadmap candidate list** (effort + which existing subsystem each
   fits) → explicitly-not-adopting → paper shortlist for deeper follow-up.
4. **Record roadmap deltas in the repo** (`docs/ROADMAP-*.md` or equivalent): one increment row
   per new gap, tagged with the paper id and the design principle. Do NOT start code changes
   from a digest — `midmem-dev` owns implementation when an item is picked up.
5. **Record the run** in your system of record: source id, grounding numbers, digest location,
   count of roadmap candidates.

## Judgment calls (learned in production)

- A recommendation that matches the existing architecture is a **validation finding** — say so
  explicitly in the headline; consistent external validation is roadmap evidence too.
- Per-paper ingests are NOT part of the recurring loop — fetch a paper only when its roadmap
  item is picked up or the operator names it (prevents tracked-paper bloat: report-summary
  coverage without per-paper evidence quietly accumulates).
- If a report contradicts a previous one, check current claims before repeating either version —
  supersede, don't accumulate.
- Grounding drift (summaryScore low or quarantines high relative to kept): stop and triage per
  `midmem-ingest` before writing any digest — a digest built on a bad extraction poisons the
  roadmap.
