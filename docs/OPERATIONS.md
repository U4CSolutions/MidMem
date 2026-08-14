# Operations — running MidMem day 2 and beyond

The store is self-driving for the routine work (decay, promotion, projection). What's left for an
operator is **judgment on the review queues, scheduled deep passes, and backups**. All commands
below assume a `midmem` wrapper (see [GETTING-STARTED.md](GETTING-STARTED.md)).

## The two maintenance modes

- **Opportunistic** — runs automatically on normal use (query/ingest/remember), throttled to
  ~1/hour across all processes sharing the db. Cheap: sweep + promote + reproject.
- **Forced/daily** (`midmem maintain --force`, schedule it — cron/systemd timer) — adds the heavy
  passes: concept embedding + communities, retention pruning, projection QA, expected-query
  probes, global consistency check, revision export. Schedule exactly one owner for this.

## The review queues (judgment work, surfaced by `midmem lint` / MCP `audit`)

| queue | what it means | your action |
|---|---|---|
| `deferredClaims` | contradictory evidence parked pending judgment | `claim-resolve <id>` accept/reject (`claims-deferred` lists oldest-first) |
| `writeConflicts` | live claims tagged contradictory at write (legacy/accepted) | supersede the stale side, or defer |
| `stalePaths` | concepts + community parents touched by a superseded claim | review, then `stale-clear <ids>` |
| `dupeConcepts` | near-duplicate concept candidates | `merge-concepts "<variant>" "<canonical>"` if truly the same |
| `lowTrustWisdom` | curated entries the feedback loop buried | re-verify or forget — wisdom never auto-archives |

**Cadence that works in production: skim queues weekly; don't let `deferredClaims` age past the
review window** (the consistency pass flags them at 14 days by default).

## The consistency verdict

`midmem consistency` (or MCP `consistency_check`) verifies the *state*: cross-claim
contradictions, dangling supersede chains, deferred aging. Report-only. **At store scale, run
contradiction review with `--minShared 5`–`7`** — the tight default (3) is a write-time locality
setting and gets noisy over a large corpus (measured: 1295 pairs at minShared 3 vs 39 at 7 on a
~4.4k-node store).

## Health signals worth watching

- `midmem brief` — tier counts, claim stats, vector health, recent ops.
- **Grounding numbers on every ingest** (`summaryScore`, quarantined counts) — a low score means
  the extraction drifted; triage before it poisons recall. The authoritative record is the `log`
  table row `operation='ingest'`.
- `maintain` summary: `projectionQA` (wiki completeness/fidelity), `queryProbes` (would future
  queries find their evidence?), `consistency`, and vector-dimension health.
- Offline fallback: if the embed endpoint is down, ingest/query still work lexically and vectors
  are marked fallback — re-ingest important documents once the model is back for semantic recall.

## Backup & restore

Everything is one file: **back up `state.db`** (plus `-wal`/`-shm` if copying hot, or use
sqlite's `.backup`; a stopped copy of `state.db` alone is sufficient). The wiki projection and
the JSONL revision export are both regenerable (`midmem project --force`, `midmem export`) —
never restore *from* them. Suggested: snapshot `state.db` before bulk ingests; the deterministic
`snapshots/state-export.jsonl` (refreshed each forced maintain) can live in a private git repo
for content-level history — **note it contains your full knowledge content; treat it with the
same sensitivity as the db.**

## Scheduled jobs a deployment typically runs

| job | cadence | command |
|---|---|---|
| forced maintain | daily | `midmem maintain --force` |
| prospective surfacing | daily/hourly | `midmem prospective due` → route to your notifier |
| bridge (if using native-memory ingestion) | daily | `midmem bridge` — must run as scope `shared` |
| backup | daily | copy/`.backup` of `state.db` |

Exactly **one** process should own auto-ingest/bridge; every other registered instance (e.g. a
Claude Code MCP registration) sets `MIDMEM_AUTO_INGEST=0`.

## Upgrades

`git pull && npm run verify` — the smoke suite, bench regression gate, and docs drift-check are
the contract. Schema migrations are idempotent and run on first open. Long-lived MCP consumers
must reconnect after an upgrade (they hold pre-upgrade code).

## When things look wrong

- **Recall misses something you just stored** → check vector health in `brief` (fallback vs
  real embed), then `query --deep` to bypass the sufficiency gate; if lexical finds it and
  vector doesn't, the embedder was offline at write time.
- **Entry count climbing with junk** → `lint` for opaque work events; `forget-entries --opaque
  --dryRun` first, then without.
- **Wiki out of sync** → it's a projection: `midmem project --force` regenerates every page.
- **Governance denial you don't understand** → the audit table records every decision with
  reason; query the last rows of `audit`.
