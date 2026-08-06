# Architecture basis — claims verified against the source

**What this is.** Every load-bearing architectural claim about MidMem, stated with its *basis in
the code* and a deterministic way to re-verify it. Modeled on the DELEGATE-52 discipline: LLMs
(and humans) confidently repeat architecture claims that have drifted from the code — so this
document never asks you to trust it. Re-run the checks. If a check disagrees with the prose,
**the code and `state.db` schema are canonical and this file is wrong** — fix it here.

Last verified: 2026-08-06 (all `Verify` commands run against `main` @ the commit adding this file).
Conventions: commands run from `packages/core/` unless a path says otherwise.

---

## 1. `state.db` is the single source of truth; the vault is a deterministic projection

**Claim.** All knowledge lives in one SQLite database. The Obsidian "LLM Wiki" is a regenerable
render of it — no LLM in the projection path, so the vault can never be corrupted by model error,
only by a stale pass (and `project` repairs hand-deleted pages).

**Basis.** `src/project.mjs` — templated `fs.writeFileSync` over `state.db` rows; dirty-check by
content hash; stale pages pruned. The DELEGATE-52 safeguards review (2026-06-16) specifically
*corrected* an earlier confident-but-wrong claim that projection was the top corruption risk —
it is the safest path, because it is deterministic.

**Verify.**
```bash
grep -cE "chat/completions|embed\(|fetch\(" src/project.mjs   # 0 — no model/network calls in the
                                             # projection path ("llm" appears only as the literal
                                             # frontmatter string `owner: llm`)
node bin/cli.mjs project --force             # full deterministic rebuild from state.db
```

## 2. Tables (the actual schema)

**Claim.** The store is: `entries` (tiered memory; FTS5 + trigram shadow tables), `vectors`,
`nodes` + `edges` (typed graph), `claims`, `sources`, `log` (operation ledger), `audit`
(governance receipts), `meta`, `projected_pages`.

**Basis.** `src/db.mjs` (schema DDL).

**Verify.**
```bash
node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.MIDMEM_DB_PATH||'../../state.db',{readOnly:true});console.log(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'entries_fts%' AND name NOT LIKE 'sqlite_%'\").all().map(r=>r.name).join(' '))"
```

## 3. Pure core, three surfaces, four modes — stated precisely

**Claim (precise form).** All capability lives in `packages/core` and is reached through exactly
three surfaces: CLI (`bin/cli.mjs`), MCP (`bin/mcp-server.mjs`), and the hook seam
(`bin/hook.mjs`). The core has **no stack-specific code paths** — which is what lets one build run
standalone, as an OpenClaw add-on, as a Hermes add-on, or bridged (`docs/INTEGRATION-MODES.md`).

**Correction (2026-08-06 audit).** The absolutist phrasing used elsewhere — "nothing in the core
may know about OpenClaw or Hermes" — is **not literally true** and should not be repeated as such.
`grep -riE 'openclaw|hermes' src/` matches 5 files: comments/docstrings (benign), plus real
identifiers in `config.mjs` (default `bridgeSources`, default ingest roots, vault subdir names)
and `handoff.mjs` (default scope list). These are **deployment defaults, all env-overridable**
(`MIDMEM_BRIDGE_SOURCES`, `MIDMEM_SOURCE_ROOTS`, `MIDMEM_AGENT_SCOPE`, `OPENCLAW_VAULT_DIR`,
`HERMES_VAULT_DIR`) — configuration data, not control flow. The invariant that matters and holds:
**no branch in the core behaves differently because a particular stack is calling.**

**Verify.**
```bash
ls ../../packages/core/bin                    # cli.mjs hook.mjs mcp-server.mjs — the only surfaces
grep -rlE "openclaw|hermes" src/ | xargs grep -lE "if.*(openclaw|hermes)"   # no conditional logic on stack names (empty)
node -e "console.log(Object.keys(require('./package.json').dependencies||{}).length)"  # 0 — node built-ins only
```

## 4. Governance is fail-closed and every decision leaves a receipt

**Claim.** Every mutating op dispatches through `governed()`: policies that deny — or *throw* —
block the op; every evaluation (allow or deny) writes an `audit` row. Default policies:
`ingest-path-allowed` (realpath'd source-root guard, symlink-safe), `tier-valid`,
`curated-tier-write`, `scope-write` (an agent cannot write another's private scope),
`hard-delete-guard` (hard forget requires `force:true`).

**Basis.** `src/governance.mjs` (`defaultPolicies`, `PolicyEvaluator.evaluate`, `governed`).

**Verify.**
```bash
grep -n "name: '" src/governance.mjs          # the five policy names
node test/smoke.mjs 2>&1 | grep -c "✓.*blocked\|✓.*denied"   # denial paths under test
```

## 5. Determinism where judgment must not drift; grounding where an LLM writes

**Claim.** Categorization (`categorizeIngest` — ordered regex rules), work-event recording,
community detection (sorted label propagation), claim contradiction/supersede detection, the
transition verifier, and projection are **deterministic — no LLM in the path**. The only
LLM-mediated write path is ingest extraction, and it is gated by the DELEGATE-52 grounding check
(`src/grounding.mjs`): deterministic content-word overlap against the source; below-threshold
extractions are **quarantined, not stored** (`MIDMEM_GROUNDING_MIN_OVERLAP`, default 0.5). No LLM
self-review anywhere in verification or promotion.

**Basis.** `src/workmemory.mjs` (CATEGORY_RULES), `src/concepts.mjs` (`detectCommunities`),
`src/verify.mjs`, `src/transitions.mjs`, `src/grounding.mjs`; wired in `orchestrator.ingest()`.
Offline, everything still runs via a deterministic fallback embedder (`src/embeddings.mjs`) —
which is why the whole test suite runs hermetic.

**Verify.**
```bash
grep -c "await.*llm\|chat/completions" src/grounding.mjs src/verify.mjs src/transitions.mjs  # 0 each
MIDMEM_LLM_ENABLED=0 node test/smoke.mjs      # entire contract passes offline
```

## 6. Memory lifecycle: earned, never judged

**Claim.** Tiers `fact` (7d TTL) → `memory` (30d) → `wisdom` (no TTL, curated-only). Retrieval
renews leases (decay-by-disuse); promotion is earned from usage/trust counters and additionally
gated by the write-time-grounding transition verifier — never by asking a model. Forced/daily
maintain runs retention: old `log`/`audit` rows, orphan vectors, **orphan edges** (§8), bounded
by `MIDMEM_RETENTION_DAYS` (default 90). Anything that ingests inside `maintain()` is
re-entrancy-guarded (`_maintaining`) — the time throttle alone is not a safe guard.

**Basis.** `config/tier-config.json` (ttl 604800000 / 2592000000 / 0), `src/memory.mjs`
(`renewLeases`, `sweep`), `src/orchestrator.mjs` (`maintain`, retention block, `_maintaining`).

**Verify.**
```bash
grep -n '"ttl"' ../../config/tier-config.json
grep -n "_maintaining" src/orchestrator.mjs
```

## 7. Retrieval: hybrid lanes fused, boosts small and post-fusion

**Claim.** Query = FTS5/BM25 ⊕ FTS5-trigram ⊕ vector cosine, fused by Reciprocal Rank Fusion;
trust, graph, temporal/workflow, and concept-routing boosts are applied **after** RRF and are
deliberately small (~0.004–0.01 — rerankers, never gatekeepers). Concept routing seeds candidates
from query-vector-nearest concept nodes + their communities and **fails soft** to flat hybrid.

**Basis.** `src/retrieval.mjs` (fusion + post-RRF boosts), `src/concepts.mjs`
(`conceptSeedsFromVector`).

**Verify.**
```bash
grep -nE "0\.00[1-9]|0\.01" src/retrieval.mjs   # boost magnitudes
node test/bench.mjs                              # recall/correction/dead-end/current/budget gate
```

## 8. Graph integrity: deterministic identity, sanctioned deletes, self-healing sweep

**Claim.** Node identity is content-derived (`node-sha12(type:key)`; concept-like types
canonicalized, identifier-like types exact) — so writers converge on one node without
coordination. There is exactly **one sanctioned delete path**: `GraphStore.deleteNode` /
`forgetNodes` (selector-required, dry-run, governed + audited), which **cascades edges**. Because
SQLite here has no FK constraints, deletes that bypass it strand edges — so forced/daily maintain
runs an idempotent `sweepOrphanEdges` (reported as `retention.orphanEdges`).

**Basis (incident-grounded).** 2026-08-05 audit: an out-of-band cleanup of ~1,500 flood-era task
nodes (done via raw SQL because no delete path existed) left **2,006 dangling edges**; the July 1
backup had zero. Fix + sweep shipped in `072e634`; live store swept to 0.

**Verify.**
```bash
node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.MIDMEM_DB_PATH||'../../state.db',{readOnly:true});console.log('orphan edges:',db.prepare('SELECT COUNT(*) c FROM edges e WHERE from_id NOT IN (SELECT id FROM nodes) OR to_id NOT IN (SELECT id FROM nodes)').get().c)"
```

## 9. Work memory: events are first-class; junk cannot mint state

**Claim.** Six event kinds (`task_attempt`, `source_used`, `dead_end`, `correction`, `artifact`,
`decision`) store as provenance-linked entries + typed edges; durable kinds land in `memory` tier,
cheap kinds in `fact`. Opaque machine identifiers (bare UUIDs/hex/timestamps) are recorded as
entries but **never mint task nodes** (`isOpaqueTaskLabel` guard — the July-2026 flood lesson).
Bulk hygiene is a consistent selector-gated family: `closeTasks` (status→done, non-destructive),
`forgetEntries` (soft), `forgetNodes` (hard, cascading) — each requires an explicit selector,
previews with `dryRun`, and is logged.

**Basis.** `src/workmemory.mjs` (WORK_EVENT_TYPES, OPAQUE_TASK_PATTERNS, the three bulk ops).

**Verify.**
```bash
grep -n "requires a\|requires at least one" src/workmemory.mjs   # every bulk op selector-gated
```

## 10. Claims: supersede beats delete; conflicts are queued, not auto-resolved

**Claim.** Claims carry provenance; newer claims supersede rather than overwrite; contradiction
detection is deterministic (token-locality + single-negation) and runs both at audit time and at
**write time** (`metadata.writeRelation`) — contradictory writes are *flagged into lint's
`writeConflicts` queue*, never auto-mutated. `current()` returns freshest non-superseded claims.

**Basis.** `src/claims.mjs`; transition verifier (`src/transitions.mjs`) gates supersede with
subject-continuity + evidence-coverage, deny-by-default, audit receipt per check.

**Verify.**
```bash
node bin/cli.mjs contradictions               # deterministic candidates, report-only
```

## 11. The test contract

**Claim.** `test/smoke.mjs` is the contract: **163 assertions**, hermetic and offline (temp db,
fallback embedder, auto-ingest off). `test/bench.mjs` is the Brain-style regression gate
(recall@3, correction-applied, dead-end-avoided, current-claim, inject-token budget) — treatment
must meet or beat baseline. CI runs both on Node 22 (`npm run verify`) plus gitleaks and CodeQL
on every push/PR. A green suite is necessary, not sufficient: the 2026-08-04 adversarial review
found 11 real defects behind 149 green tests — fresh-eyes review after a green build is part of
the contract for substantial changes.

**Verify.**
```bash
npm run verify                                # smoke (163) + bench, offline
```

---

## Appendix: drift corrections from the 2026-08-06 audit

Recorded per the DELEGATE-52 memo pattern — the wrong claim, and what is actually true:

| Stale claim (where) | Verified reality |
|---|---|
| "smoke **90/90**" (README ×2, CONTRIBUTING) | 163 assertions (grew 90→163 across the 2026-07/08 builds) |
| "MCP server (**21 tools**)" (README ×2, INTEGRATION-MODES) | **30 tools** (verified live via `tools/list`) |
| "nothing in the core may know about OpenClaw or Hermes" | Precise form in §3 — no stack-conditional code paths; stack names exist only as env-overridable defaults |
| "retention prunes log/audit/orphan vectors" | Also prunes **orphan edges** since `072e634` (§8) |
| `docs/hillel-wayne-ese-talk.txt`, `docs/claude-code-vs-opencode-token-overhead.txt` in repo | Stray research-scrape caches swept into `e76d3d7` by `git add -A`; removed 2026-08-06 |
