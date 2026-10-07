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
  are marked fallback — `midmem reembed` repairs them once the model is back; entries extracted while
  the model was down (`extraction.mode: fallback` in `midmem entries`) get model concepts and claims
  from `midmem reextract` (see Enabling an on-network model).

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

## When things look wrong

- **Recall misses something you just stored** → check vector health in `brief` (fallback vs
  real embed), then `query --deep` to bypass the sufficiency gate; if lexical finds it and
  vector doesn't, the embedder was offline at write time.
- **Entry count climbing with junk** → `lint` for opaque work events; `forget-entries --opaque
  --dryRun` first, then without.
- **Wiki out of sync** → it's a projection: `midmem project --force` regenerates every page.
- **Governance denial you don't understand** → the audit table records every decision with
  reason; query the last rows of `audit`.
