---
name: midmem-ingest
description: Ingest a document, URL, or a recurring research digest into MidMem with grounding verification. Use for "ingest this", "ingest the weekly report/paper/URL", or committing a research digest to the knowledge base. Verifies the grounding report instead of blind-ingesting, stages URLs into an allowed source root, and records the outcome.
---

# MidMem Ingest — verified knowledge intake

Commit a source into the store the RIGHT way: staged into an allowed root, grounding-checked
(deterministic — DELEGATE-52 discipline), recall-verified, recorded. Never blind-ingest; never
trust an extractor's own claim of faithfulness — read the grounding numbers.

## Inputs this handles
- **A file path** already under one of your configured ingest source roots.
- **A URL** (arXiv page/PDF, blog post, article) → fetch it FIRST into a staging directory inside
  an allowed root (one subdir per source, kebab slug). For arXiv prefer the abs page or HTML
  render; keep the paper id in the filename.
- **A recurring research digest** (e.g. a weekly report of new papers on your domain). Ingest the
  REPORT as one document (`--type research`), then — only for items the report marks
  high-relevance or the operator names — fetch and ingest those sources individually.

## Citations review (REQUIRED for reports/digests — before ingesting)
Recurring research digests carry citations; review the structure and build a manifest FIRST:
1. **Extract every citation link** (`[Title](url)` markdown). **Canonicalize each URL**: strip
   tracking params (`?utm_source=…` and friends); for arXiv keep the bare `abs/<id>` URL and
   record the paper id.
2. **Flag uncited claims:** any section making benchmark/experiment claims with NO link gets
   flagged inline in the staged copy (`Citation: NONE PROVIDED…`) and marked `ingest: BLOCKED`
   in the manifest — never fetch-and-ingest a paper you had to guess the identity of.
3. **Dedup against the store** per paper id (search content + provenance) — papers already
   present are marked `skip: in store`; hash-dedup only catches identical files, not the same
   paper cited by two digests.
4. **Write `citations.json`** beside the staged report: section, title, id, canonical URL,
   digest status (new vs continuing), ingest decision. This is the deterministic provenance for
   any follow-up per-paper ingest.
5. Ingest decisions: papers the digest marks **new/highest-relevance** (or the operator names)
   → fetch into the same staging dir and ingest individually. Continuing/"tracked" papers → do
   NOT bulk-ingest; note whether per-paper evidence exists in the store and surface the gap to
   the operator instead.

## Procedure
1. **Finish the source before ingesting.** Mid-edit ingests mint duplicates; a re-ingest after
   changes supersedes cleanly. A doc from outside the allowed roots gets COPIED into staging
   (governance rejects foreign paths by design).
2. **Ingest:** `midmem ingest <path> --scope shared --type <research|report|note> [--title "..."]`.
   Default to the shared scope for knowledge every agent should recall; use a private scope only
   for genuinely agent-private material.
3. **Read the grounding report in the result — this is the point of the skill:**
   - `summaryScore` ≲ 0.4 → the summary drifted from the source. Read the source; if it's a
     fetch artifact (paywall stub, cookie wall, empty PDF text), fix the fetch and re-ingest;
     if the extractor confabulated, do NOT keep the entry — `midmem forget <id>`.
   - `conceptsQuarantined`/`claimsQuarantined` high relative to kept → the extractor invented
     content the grounding check caught. Same triage.
   - `skipped: unchanged` → hash-dedup no-op; nothing new to verify.
4. **Verify recall:** `midmem query "<distinctive term from the source>" --limit 3` — the new
   entry should surface. If it doesn't, check whether its vector is an offline fallback before
   blaming relevance — a fallback vector means the embedder was unreachable; fix and re-ingest.
5. **Batch digests:** after a batch, run ONE `midmem lint` pass — new concept nodes are where
   dupe-variants appear (merge only unambiguous ones via `merge-concepts`; flag the rest).
6. **Record** the ingest per your project's conventions: source, entry id(s), grounding numbers.

## Don'ts (standing rules)
- Don't ingest a high-churn live file (e.g. a working changelog) — it supersede-thrashes; ingest
  frozen snapshots/archives once.
- Don't ingest from outside allowed roots — copy into staging first.
- Don't hand-promote tiers on fresh ingests; usage/feedback earns promotion.
- Don't batch-ingest a directory without reading each grounding report — one bad source in a
  sweep pollutes quietly (field report: one misconfigured capture week became 88% of a
  production store's durable memory tier before an audit caught it).
