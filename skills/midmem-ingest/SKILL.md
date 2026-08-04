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
