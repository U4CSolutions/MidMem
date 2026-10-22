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

**Nightly repair batches** (since 2026-10-19, forced pass only, after the consistency check): the
pass re-embeds at most `MIDMEM_MAINTAIN_REEMBED` (default 200) hash-placeholder vectors through
`reembed`'s own self-gating (its first embed is the probe; offline → nothing touched, `reason:
embedder-offline`), then re-extracts at most `MIDMEM_MAINTAIN_REEXTRACT` (default 20) fallback-extracted
entries through `reextract` — only when the endpoint answers a cheap `GET /models` probe (never a model
call just to test); otherwise `reextracted: { skipped: true, reason }`. Capture children that run with
`MIDMEM_LLM_ENABLED=0` by contract and entries ingested while the box was down are repaired without a
hand run. Both summaries land in the `maintain` result and log row as `reembedded` / `reextracted`; an
error is recorded there and never fails the pass; with the model off in the maintaining process both
read `{ skipped: true, reason: 'disabled' }`. `0` disables either. Note `reextract`'s default selection
includes legacy entries that carry no extraction record, and what it rewrites is projected by the next pass.
Both batches leave `favorite`, `favorite_helpful`, `helpful_count` and `trust_score` alone (schema 6, merged
2026-10-22): the re-embed writes vectors only, archived rows included, and the reextract rewrites content,
concepts, provenance and `updated_at` in place, so a favorite keeps exactly its one vote through any number of
passes. The reextract half reads the source files: run by the store user (the `midmem-maintain` timer below), the
sources of a capture system whose archive only its own user can read count `skipped.unreadable` and cost no model
call. Only the re-embed half, which needs no file, repairs such a store; re-extract its fallback entries as the
capture system's user (Enabling an on-network model, step 4). With the endpoint unreachable both halves skip in
about a second and write nothing; against a hung one the re-embed probe waits up to (`MIDMEM_EMBED_RETRIES` + 1)
× `MIDMEM_LLM_TIMEOUT_MS` and the `/models` probe at most 5 s. A separately scheduled `midmem reembed` finds only
what this pass left.

## The review queues (judgment work, surfaced by `midmem lint` / MCP `audit`)

| queue | what it means | your action |
|---|---|---|
| `deferredClaims` | contradictory evidence parked pending judgment | `claim-resolve <id>` accept/reject (`claims-deferred` lists oldest-first) |
| `writeConflicts` | live claims tagged contradictory at write (legacy/accepted) | supersede the stale side, or defer; tags written before the containment floor → `claims-reclassify` (below) |
| `fragmentClaims` / `orphanClaims` | live claims that are not claim-shaped, or whose source entry is gone (counts) | `claims-sweep --dryRun`, then `claims-sweep` (below) |
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

## Correcting misplaced rows and false conflict tags

Reclassification is governed, never hand-edited: `rescope` moves rows to the right scope and
`lower-authority` corrects an over-labelled origin (both need a selector; preview with `--dryRun`).
**A row that should not be in the default read at all** — misfiled, obsolete, ingested by mistake —
is retired with `midmem archive <entry id…> [--reason <text>] [--dryRun]` (MCP `archive` with `ids`).
Ids are required; the row becomes `archived` with `provenance.archivedBy`, stays readable through
`query --historical`, and the claims its ingest produced are archived too (reason `source-archived`).
A stack scope may archive only its own and `shared` rows. Prefer it to `forget` when the history matters.

**Write-time `contradictory` tags** need a containment floor since 2026-10-05: a differing-polarity
pair counts as a contradiction only when shared tokens / the smaller claim's tokens reach
`MIDMEM_CLAIM_CONTRADICTION_MIN_CONTAINMENT` (default 0.6). Tags written before (or under a lower
floor) are re-judged by `midmem claims-reclassify --dryRun`, then without `--dryRun`: below-floor
tags become `additive`, the claims the write path deferred for them are released to `active`, and
claims deferred by judgment are never touched. Deterministic; the run is logged as `claims-reclassify`.

**Claim shape** (since 2026-10-19): a claim must look like a statement. `isClaimShaped` (grounding.mjs,
deterministic, no knob) refuses text that opens with markdown structure — a heading, a table row, a
quote, a `* ` bullet, a bullet or numbered item with a bold lead, a bold or italic-wrapped lead-in, a code
fence — carries a `Session Key` / `Session ID` / `**Session` label, has fewer than 3 words, has no
letter, or is more than 60 % non-letters. The fallback extractor (claims from the lead sentences, now
split per markdown block so a heading no longer swallows the sentence under it) and the model path both
drop such text (`droppedFragments`), and the ingest / reextract grounding check quarantines any that
reach it with `reason: 'not-a-claim'` before the overlap check; the grounding report and the `ingest` /
`reextract` log rows count both as `notClaim`. Measured before it: 125 live fragment claims (headings,
table rows, bullets) from fallback ingests, colliding with real claims as false contradictions.

**Claims that should not be live** are cleared by `midmem claims-sweep [--no-fragments] [--no-orphans]
[--dryRun]` (MCP `claims_sweep`): fragments (not claim-shaped, `archivedBy.reason: not-a-claim`) and
orphans — a claim whose `source.sourceId` has no active entry (superseded by a re-ingest, archived,
forgotten), or a legacy claim without one whose path no active entry stands for (`source-gone`,
`archivedBy.entry` when known). Archived, never deleted; each leaves every `contradictedBy` list. One
transaction, deterministic, logged as `claims-sweep`; `lint` / MCP `audit` show the queue as
`fragmentClaims` / `orphanClaims`. A re-ingest supersedes the old entry but not its claims, so orphans
accumulate between sweeps; a claim made by `claim_supersede` inherits its predecessor's source and is
swept with it, as the forget cascade would archive it. The sweep writes claims only: no entry row changes, so
after a favorite's re-capture the superseded version's claims are archived while the favorite (and its one vote)
that the new entry carried stays exactly as it was.

**Claim stance** (since 2026-10-12, roadmap #33): every claim is tagged at commit with
`metadata.stance` — `observed` (the default), `provisional` (could / might / would / if we / plan to /
dry run / simulated …), `quoted` (according to / said that / reportedly …) or `rejected` (decided
against / ruled out / withdrawn …) — by fixed word lists (`stanceOf` in `claims.mjs`, the only source;
`metadata.stanceMarkers` records what fired). A non-observed claim asserts nothing: it never defers, never
counts as a neighbour or a contradiction side, never lands in `writeConflicts`, and `midmem claims <q>` (the
current read) leaves it out. To see it, use `midmem claims <q> --all-stances` (or `--stances provisional,quoted`;
MCP `claims` with `allStances: true` / `stances`); `claims <q> --all` returns every status and stance.
`lint` reports the live mix as `stances`, `brief` as `claims.byStance`. A research claim of the form "the
paper reports X" stays `observed` — the source speaking is not a quotation. `MIDMEM_CLAIM_STANCE=0` turns
tagging off and every read behaves as before; claims written earlier keep their tag. Claims written before
stance tagging existed carry none and read as `observed`: on an upgraded store the first `lint` shows every
live claim as observed and the current read returns them as before; new ingests and re-extractions are tagged.

## Health signals worth watching

- `midmem brief` — tier counts, claim stats, vector health, recent ops.
- **Grounding numbers on every ingest** (`summaryScore`, quarantined counts) — a low score means
  the extraction drifted; triage before it poisons recall. The authoritative record is the `log`
  table row `operation='ingest'`.
- **Multi-paper digests: ingest with `--sections`** (`midmem ingest <file> --sections`, MCP `ingest`
  with `sections: true`). A good grounding score on a whole digest can still mean almost nothing
  was kept (measured 2026-10-05: a six-paper weekly report scored 0.864 as one 430-character
  summary, and no paper name was recallable). With `--sections` the file is ingested whole, then
  every heading section that cites exactly one URL and has ≥ `--min-chars` (default 200) of body is
  ingested on its own through the same grounded path, keyed by its citation (arXiv versions and
  `/pdf/` links fold to `https://arxiv.org/abs/<id>`, DOIs to `https://doi.org/<doi>`), so the
  same paper in a later digest supersedes its section instead of duplicating it. Sections take the
  digest's authority (`doc` unless curated). The result lists each section and why the others were
  skipped (`no-citation`, `multiple-citations`, `too-short`); fewer than `--min-sections` (default 2)
  distinct citations → the file stands alone (`not-a-digest`). The parent's
  `provenance.digestSections` links the sections; the run is logged as `ingest-sections`.
- `maintain` summary: `projectionQA` (wiki completeness/fidelity), `queryProbes` (would future
  queries find their evidence?), `consistency`, and vector-dimension health.
- Offline fallback: if the embed endpoint is down, ingest/query still work lexically and vectors
  are marked fallback — `midmem reembed` repairs them once the model is back; entries extracted while
  the model was down (`extraction.mode: fallback` in `midmem entries`) get model concepts and claims
  from `midmem reextract` (see Enabling an on-network model).
- **Embed retries** (since 2026-10-19): a timeout, a refused connection or an HTTP 5xx / 429 from the
  embed endpoint is retried `MIDMEM_EMBED_RETRIES` times (default 2), waiting `MIDMEM_EMBED_RETRY_MS ×
  2^attempt` (default 250 ms, then 500 ms), before the hash placeholder; any other 4xx falls back at
  once. Measured before it: one agent process wrote 37 placeholders in a day after single timeouts
  while CLI ingests in the same hours embedded normally. An `ingest` / `remember` log row carries
  `embedAttempts` when the embed needed more than one. Each attempt gets the full
  `MIDMEM_LLM_TIMEOUT_MS`, so against a hung box (not a refusing one) every write's embed (ingest,
  remember, reextract, the re-embed batch) waits up to (retries + 1) timeouts; retrieval and the concept
  refresh make one attempt. Lower the retries where that latency matters: a capture system that bounds
  its MidMem children (say 120 s) and runs them with the model ON sees a hung endpoint cost one ingest
  the extraction timeout plus (retries + 1) embed timeouts. Children that run with the model OFF
  (`MIDMEM_LLM_ENABLED=0`) call no endpoint, so the retries change nothing for them.

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

## Host install for a capture system

When a capture system (a read-later app, a document library — see
[INTEGRATION-MODES.md §6](INTEGRATION-MODES.md)) shells out to `midmem` on the same host, give the
store its own user and keep every entry point on one launcher. A worked layout:

| Item | Value |
|---|---|
| user/group | `midmem:midmem`, a system account with no login shell (`useradd --system --home-dir /var/lib/midmem --shell /usr/sbin/nologin midmem`) |
| code | `/opt/midmem/releases/<sha>/` (root, 0755), `/opt/midmem/current` → the live release; the sha in `/opt/midmem/RELEASE` |
| state | `/var/lib/midmem`, `midmem:midmem` mode **2770** (setgid, so files the capture system creates keep group `midmem`): `state.db{,-wal,-shm}`, `ingest-content/`, `vault/`, `snapshots/` |
| env file | `/etc/midmem/midmem.env`, `root:midmem` 0640 |
| launcher | `/usr/local/bin/midmem`; the capture system's `KC_MIDMEM_BIN`-style setting, the maintain timer and operators all enter here |
| backups | `/var/backups/midmem/<date>/`, `midmem` 0700, pruned after 14 days |

**Launcher.** One shell script, `umask 0007` so the db and its `-wal`/`-shm` stay group-writable. It
reads the env file only when the caller has not set `MIDMEM_DB_PATH`; a caller that sets it owns the
**whole** config (sandbox and acceptance runs), otherwise the host env file applies whole — never a
mix. It refuses (exit 78) when the env file is unreadable or `MIDMEM_DB_PATH` is still unset, because
the repo-local default db would silently be used. It then `exec`s
`node $MIDMEM_HOME/packages/core/bin/cli.mjs "$@"`.

**Env-file ownership rule.** `midmem.env` is owned by root, readable by group `midmem`, and is the
only place store configuration lives: `MIDMEM_DB_PATH`, `MIDMEM_CONTENT_INGEST_DIR`,
`OBSIDIAN_VAULT_PATH`, `MIDMEM_EXPORT_PATH`, `MIDMEM_SOURCE_ROOTS` (the full default list plus the
capture system's archive root — it **replaces** the default), `MIDMEM_STORE_ID`, and the switches that
keep a capture host quiet (`MIDMEM_AGENT_SCOPE=shared`, `MIDMEM_AUTO_INGEST=0`,
`MIDMEM_AUTO_INGEST_ON_MAINTAIN=0`, and `MIDMEM_LLM_ENABLED=0` if nothing may leave the network).
Keep secrets out of it (no `*_KEY`, `*_TOKEN`, `*_SECRET`) while the capture system can read it;
see the privilege note below.

**Timers.** Two systemd timers, both `User=midmem`, `UMask=0007`, `NoNewPrivileges`,
`ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp`. `midmem-maintain` has
`ReadWritePaths=/var/lib/midmem`; `midmem-backup` also needs `/var/backups/midmem` there, because
`ProtectSystem=strict` makes everything else read-only:

- `midmem-maintain`: `ExecStart=/usr/local/bin/midmem maintain --force`, `Nice=10`, idle IO,
  `MemoryMax=1G`, `OnCalendar=*-*-* 04:15:00`, `Persistent`, `RandomizedDelaySec=10m`. It is the
  **only** forced-maintain owner (see Scheduled jobs above); the capture system never forces one.
  It also runs the nightly repair batches (The two maintenance modes, above): when the endpoint answers,
  up to 200 embeddings and 20 extractions; as `midmem` its reextract half re-extracts only sources that
  user can read.
- `midmem-backup` (03:45): a `node:sqlite` `backup()` of `state.db`, `PRAGMA integrity_check` on the
  copy, the export snapshot, and a 14-day prune.

**Operators run MidMem only as the store user** (`sudo -u midmem midmem …`). A root-run CLI creates
root-owned `-wal`/`-shm` files the service accounts then cannot open.

**Privilege note.** A capture system that runs the launcher as **its own user** (it must, when
MidMem's ingest reads files only that user can read) holds group write on `state.db` and can read
`midmem.env`. The capture system's per-op argv allowlist then protects against its **own bugs**, not
against a **compromised** capture process: that process could write arbitrary entries, curated or
wisdom included, into a store other agents read. Acceptable only while the store holds no secret
(no LLM key, sqlite vectors, no Qdrant key) and every other writer is already at least as trusted.
**A broker removes the exposure**: a socket-activated unit running as `midmem` that accepts one
`{ op, argv }` per connection, re-validates it against the same allowlist and execs the CLI. The
capture system then drops the group and the `ReadWritePaths`, and the archive grants `midmem` read
through a dedicated group. Put the broker in place before enabling the Qdrant backend (an API key in
the store's env) or any consumer off the host.

## Enabling an on-network model (extraction + embeddings)

With `MIDMEM_LLM_ENABLED=0` every ingest uses the deterministic fallbacks: the summary is the lead
sentences, the concepts are frequent tokens (stopwords included), the claims are the first sentences,
and the vector is a hash placeholder. Turning a model on is an operator decision when the store holds
third-party text: the endpoint receives each source's first 12,000 characters and every summary, so use
an OpenAI-compatible server on the trusted network (LM Studio or llama.cpp), never a hosted API, and keep
its credentials (if any) out of `midmem.env` while a capture system can read that file.

1. **Probe the endpoint** from the host: `curl -s http://<lan-host>:1234/v1/models` lists the loaded
   models; one chat completion answering `{"summary": …}` proves extraction. A reasoning model (for
   example `qwen/qwen3.6-35b-a3b`) is fine: LM Studio returns its thinking in
   `message.reasoning_content` and the JSON answer in `message.content`, which is what MidMem parses
   (an inline `<think>…</think>` block is dropped). Measured: ≈ 13 s per 12,000-character article.
2. **Set the env** (in `midmem.env`; the launcher reads it whole):
   ```sh
   MIDMEM_LLM_ENABLED=1
   MIDMEM_LLM_ENDPOINT=http://<lan-host>:1234/v1
   MIDMEM_EXTRACT_MODEL=qwen/qwen3.6-35b-a3b    # the chat model id the server lists
   MIDMEM_EMBED_MODEL=text-embedding-bge-m3      # 1024 dimensions
   MIDMEM_LLM_TIMEOUT_MS=60000                   # per call, extraction and embeddings alike
   ```
   From the next ingest on, the result says `mode: "lmstudio"` and the entry records
   `provenance.extraction: { mode, model, at }` (`midmem entries` shows it as `extraction`).
3. **`midmem reembed`** (repeat until `remaining: 0`) swaps the hash placeholders for real vectors in
   place. The first real vector fixes the store's dimension; a store that already holds real vectors
   of another model is a new-collection / full re-embed job (see Moving a store), not this.
4. **`midmem reextract`** for the entries ingested while the model was off. Re-ingesting them would do
   nothing: an unchanged source is skipped by its hash. `reextract` re-runs the extraction on each
   active entry whose source file is unchanged and updates it **in place**, keeping its id, tier, lease,
   counters (retrieval, helpful, trust), scope, project, authority and `provenance.source`; the old
   claims are archived with lineage, the entry is re-embedded. It writes only when the model really
   answers and stops at the first sign the model is down, so it is safe to start and re-run. An entry
   whose own answer fails (unparseable, or an HTTP 400/413 when its text overflows the loaded context)
   is skipped and left alone for 24 h (`skipped.retryLater`), so the loop still reaches `remaining: 0`;
   `--retry-failed` retries such entries at once (after loading a model with a larger context, say).
   Curated entries (tier `wisdom`, `operator` authority) are never touched (`skipped.denied`):
   ```sh
   midmem reextract --dry-run                    # what it would do; calls no model, writes nothing
   midmem reextract --limit 20                   # 20 model calls (~5 min); repeat until remaining: 0
   midmem reextract --library <id> --doc-ids a,b # one capture system's sources only
   ```
   Snapshot `state.db` first (Backup & restore): the old summaries and concept lists are replaced, not
   kept (old claims stay, archived). **Run it as a user that can read the sources.** A capture system
   whose archive only its own user can read (the privilege note above) must run it as that user
   (`sudo -u <capture-user> /usr/local/bin/midmem reextract …`) or trigger it through the capture
   system; run as `midmem`, those sources come back `skipped.unreadable` and nothing changes. Never as
   root (root-owned `-wal`/`-shm`). `--all` re-extracts model-extracted entries too (a new model).
5. **Rollback** is `MIDMEM_LLM_ENABLED=0`: new ingests fall back at once; entries already re-extracted
   keep their model output and real vectors, and queries then embed with the hash placeholder, so the
   vector lane misses until the model is back (lexical recall is unaffected). To undo the content
   itself, restore the snapshot taken before step 4.

## Moving a store

- **`state.db` moves by file copy.** Stop every writer (or take a `sqlite` `.backup`, which is safe
  hot), copy `state.db` — with `-wal`/`-shm` if the copy is hot and a backup was not used — then keep
  the owner/group/mode of the destination (`midmem:midmem`, state dir 2770). The wiki projection and
  the export are regenerable; never restore from them.
- **The source path is identity.** The sources row, and therefore supersede and dedup, are keyed by
  the file path that was ingested; `provenance.source` carries the library/doc identity instead. Move the capture system's
  archive and the **path must not change** (mount it at the same location, or re-point nothing). A
  new path is a new source: the old entry is not superseded, and identical content only links as
  `alsoSources`. Keep `MIDMEM_SOURCE_ROOTS` listing the same root.
- **Keep `MIDMEM_STORE_ID`** the same; it is the tenant key written on every Qdrant point.
- **Collection naming.** A Qdrant collection holds one embedding space and is named
  `midmem_memory_<modelslug>_<dim>` (for example `midmem_memory_bgem3_1024`). A different embedding
  model or dimension is a different collection, never a reuse of the old one.
- **Order after the move:** `midmem reembed` first, then `midmem vectors backfill`, then `midmem
  vectors parity` before flipping `MIDMEM_VECTOR_BACKEND=qdrant`. `reembed` only replaces
  `fallback` placeholder vectors (written while the embedder was offline) with real ones; backfill
  skips placeholders, so an entry still holding one never reaches Qdrant and silently loses semantic
  recall after the flip. This applies whether or not the model changed.
- **A change of embedding model is not a `reembed` job.** `reembed` does not touch real vectors from
  an older model, and backfill would push them into a collection named for the new model. Use a new
  collection (`midmem_memory_<modelslug>_<dim>`) and a full re-embed or re-ingest, not a backfill of
  the old vectors.
- **After the Qdrant flip, Qdrant holds the only vectors** for the entries it serves. A `state.db`
  copy alone no longer restores semantic recall: **snapshot Qdrant** (its own snapshot API) alongside
  the db, and restore the two together.

## Upgrades

`git pull && npm run verify` — the smoke suite, bench regression gate, and docs drift-check are
the contract. Schema migrations are idempotent and run on first open. Long-lived MCP consumers
must reconnect after an upgrade (they hold pre-upgrade code).

### Schema 6: favorites (2026-10-21)

The first process that opens a schema-5 store with this code adds two columns
([INTEGRATION-MODES.md §6](INTEGRATION-MODES.md) item 6(b) has what they mean) and records the version:

```sql
BEGIN IMMEDIATE;
ALTER TABLE entries ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entries ADD COLUMN favorite_helpful INTEGER NOT NULL DEFAULT 0;
COMMIT;
INSERT INTO meta(key, value) VALUES ('schema_version', '6')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
```

- **Safe on a live store.** A constant default makes each `ADD COLUMN` a schema-only change: no row is
  rewritten, so the time does not grow with the store. Measured on a production-shaped store built by the
  schema-5 release (200 entries: active, archived, wisdom and deleted rows, 950 claims, 1024-dimension
  vectors, 7.6 MB): 13 ms; on 20,200 entries (104 MB): 4.6 ms; the first CLI call after the upgrade takes
  about 11 ms longer than the next. Both columns land in one transaction taken with `BEGIN IMMEDIATE`:
  a process that opens the store while a capture system is writing waits (busy_timeout, 5 s) instead of
  failing, and two processes opening it at once add the columns once. Every existing row reads
  `favorite = 0`, `favorite_helpful = 0`, and nothing else changes: on the rehearsal copy every other column
  of every row, both FTS indexes (`integrity-check`) and the query results were identical before and after.
- **Rehearse on a copy first**, as for any release: take a `.backup` (or a stopped copy) of `state.db`, run
  the new release once against the copy (`MIDMEM_DB_PATH=<copy> MIDMEM_HOME=<new release> midmem entries
  --library <id> --doc-ids <one id>`), then check `PRAGMA integrity_check` (ok), `schema_version` (6) and
  one `midmem feedback <id> --favorite` / `--unfavorite` round trip on the copy.
- **Order: MidMem first, then the capture system's favorites.** A capture system tells a favorites-capable
  MidMem by the `favorite` key on its `entries` rows.
- **Rollback** of the release needs no database change: the schema-5 release runs on a schema-6 store (it
  ignores the two columns and writes `schema_version` 5 again when it opens the store; the favorites stay
  stored but boost nothing until a schema-6 release reopens the store, which writes 6 again). But the older
  CLI ignores switches it does not know: it counts `feedback <id> --favorite` AND `--unfavorite` as plain
  helpful votes and drops `ingest --favorite`, so **stop the capture system's favorite sends before rolling
  MidMem back**. Re-captures go on during the rollback, and the schema-5 code knows no carry-over: a changed
  source re-ingested then supersedes its favorite entry with a new entry that is NOT a favorite, and a
  `--favorite` on that ingest is dropped. After the re-upgrade the head entry of such a capture is therefore
  not a favorite: **the capture system re-sends the favorites of every starred capture it re-ingested during
  the rollback window** (`feedback <new entry id> --favorite`; idempotent, so re-sending all its starred
  captures is safe too).
- **The revision export** keeps both columns, so the first export after the upgrade differs on every entry
  line (once). Long-lived MCP servers show no favorite fields until they reconnect.

**At run time:** `midmem brief` counts the active `favorites`; `entries`, `recall` and `query` show the flags
(and `rank.favorite` / `rank.favoriteHelpful` / `rank.favoriteGuard` on query rows); every answered favorite
call leaves a `favorite` log row (`changed`, `via`: feedback, ingest or carry-over). The boosts are
`MIDMEM_FAVORITE_WEIGHT` (0.004) and `MIDMEM_FAVORITE_HELPFUL_WEIGHT` (0.002) in `midmem.env`; `0` turns
one off (the favorite's helpful vote stays — it is feedback). They reach a favorite only when a lexical lane
returned it holding one of the query's own words, or the vector lane ranked it in its top
`MIDMEM_FAVORITE_VECTOR_TOP_K` (10) among the rows the query's filters leave: with a dense embedder every entry
is a vector candidate of every query, and on a question nearly every entry is a lexical hit. Starring never
lowers an entry. After changing any of the three, or anything in fusion, re-run
`node packages/core/test/favorite-ranking.mjs`: it measures the fused scores on a seeded corpus with hash
vectors and again with dense 1024-dimension vectors, and checks that favorite + helpful > favorite > neither at
equal relevance (also under one better match), that starring never lowers an entry, that no favorite passes a
clearly better match on being a favorite (Cyrillic and CJK queries included), that past the vector top K a
favorite gains nothing, and that question-form queries pull no starred unrelated entry into a top 3; it also
prints the cost (measured 2026-10-21: 7 ms → 12 ms for a 60-word query over 800 entries with 600 favorites). A
favorite does not pin an entry: lease expiry and distrust archival apply as to any entry, and a source whose
entry has expired stays `unchanged` on re-ingest.

### Main's review guards on the favorites line (2026-10-22)

The release that merges main (review guards #56/#57, claim stance #33, the nightly repair batches) into the
favorites line keeps **schema 6**: no migration runs, the first open adds no column, table or meta row, and the
favorites release still reads the store afterwards, so a rollback needs no database change. Rehearsed on a
production-shaped schema-6 store built by the favorites release (250 active web-article captures, 22 of them
fallback-extracted; 12 superseded versions; 1,963 claims; 262 vectors, 18 of them hash placeholders; 27
favorites), with the env of a host that has the model on (60 s timeout). The counts are that synthetic store's;
the same dry runs on a copy of a real store give its own:

- **The first forced maintain with the endpoint unreachable** (a closed port): exit 0 in about 2 s;
  `reembedded: { reembedded: 0, reason: 'embedder-offline' }`, `reextracted: { skipped: true, reason:
  'unreachable' }`, the concept refresh `stopped: 'embedder-offline'`. Every entry, vector and claim row was
  byte-identical afterwards, and identical to the same pass with both batches off. The favorites release's pass
  stored hash vectors into 60 concept nodes in the same situation.
- **What the first nightly pass selects** once the endpoint answers: `midmem reembed --dryRun` lists the
  candidates (every placeholder vector, archived rows included; the pass takes up to 200 — there all 18), and
  `midmem reextract --dry-run --limit 20` the batch (fallback-extracted entries whose source is readable and
  unchanged — there 20 of 22; the 228 model-extracted entries count `notSelected`). Run by a user that cannot
  read the capture system's archive (the store user, on a host where the archive is the capture system's own),
  those 22 count `skipped.unreadable` and no model call is made. Favorites, `favorite_helpful`, helpful counts and
  trust stayed as they were in every case, the answering endpoint included (18 re-embedded, 20 re-extracted).
- **`claims-sweep` is manual** (never part of maintain). On the rehearsal store `claims-sweep --dryRun` counted
  187 fragments (headings, bold-lead bullets and table rows the favorites release kept as claims) and 55 orphans
  (claims of superseded versions) among 1,463 live claims; `lint` shows the same queue as `fragmentClaims` /
  `orphanClaims`. Read the sample, then run it without `--dryRun`.
- **Stances**: existing claims carry none, so `lint.stances` reports them all as observed and the current read
  returns them as before; claims written from the upgrade on are tagged.

## When things look wrong

- **Recall misses something you just stored** → check vector health in `brief` (fallback vs
  real embed), then `query --deep` to bypass the sufficiency gate; if lexical finds it and
  vector doesn't, the embedder was offline at write time.
- **Entry count climbing with junk** → `lint` for opaque work events; `forget-entries --opaque
  --dryRun` first, then without.
- **Wiki out of sync** → it's a projection: `midmem project --force` regenerates every page.
- **Governance denial you don't understand** → the audit table records every decision with
  reason; query the last rows of `audit`.
