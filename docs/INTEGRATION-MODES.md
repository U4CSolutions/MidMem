# MidMem Integration Modes

MidMem is **pure core** (`packages/core`, Node ESM, zero deps, one `state.db`). Every capability —
hybrid retrieval, tiers/lifecycle, grounding, the concept graph, **work-memory events**, deterministic
**ingest categorization**, **proactive recall**, and **auto-ingest of agent work** — lives in the core
and is reached through three stable surfaces:

- **CLI** — `bin/cli.mjs` (`midmem …`)
- **MCP server** — `bin/mcp-server.mjs` (stdio JSON-RPC; 37 tools incl. `record_work`, `list_tasks`, `proactive_recall`, `forget_nodes`, `prospective_*`)
- **Hook seam** — `bin/hook.mjs` (`pre` / `post` / `tasks`) — the one caller-path touchpoint

Because nothing in the core knows about OpenClaw or Hermes, the same build runs in **four modes**.
The only thing that differs per mode is *who calls the hook seam* and *which `MIDMEM_*` env is set*.

---

## 1. Independent (standalone LLM-Wiki curation, single user)

No agent stack required. Use the CLI; `state.db` is the source of truth and the Obsidian
`LLM Wiki` is its projection.

```bash
export MIDMEM_DB_PATH=~/midmem/state.db
midmem ingest notes/paper.md --type research      # categorized automatically
midmem work --kind decision --task "Adopt OKF" --outcome "import/export only"
midmem query "what did we decide about OKF"
midmem tasks                                       # ongoing requests
midmem maintain --force                            # decay + promote + auto-ingest + project
```
Automatic ingest: point `MIDMEM_BRIDGE_SOURCES` at your notes dirs (or rely on `ingest`); `maintain`
(daily timer `midmem-maintain.timer`) pulls + categorizes them. Trigger-less recall: alias
`midmem-recall () { midmem recall-check "$*"; }`.

## 2. Single OpenClaw add-on

Register the MCP server in `openclaw.json` (already done) so the OpenClaw agent gets
`query/remember/record_work/proactive_recall/list_tasks/…`:
```json
"mcp": { "servers": { "middleware-memory": {
  "command": "node",
  "args": ["…/midmem-kb-store/packages/core/bin/mcp-server.mjs"],
  "env": { "MIDMEM_DB_PATH": "…/state.db", "MIDMEM_AGENT_SCOPE": "openclaw" } } } }
```
- **Trigger-less recall (P1):** an OpenClaw pre-turn hook runs
  `node bin/hook.mjs pre "<message>"` and splices stdout into context. (Until a deterministic
  pre-turn hook exists, the `midmem-ops` skill instructs the agent to call `proactive_recall`;
  the hook seam is the deterministic upgrade path — same seam as the Matrix routing layer.)
- **Automatic work ingest:** `MIDMEM_AGENT_SCOPE=openclaw` + `autoIngest.onMaintain` pulls
  `~/.openclaw/workspace/memory/*.md` (session logs) into the store on every maintenance pass.

## 3. Single Hermes add-on

Identical, registered in `~/.hermes/config.yaml` `mcp_servers.middleware-memory` with
`MIDMEM_AGENT_SCOPE=hermes` (already done). Hermes records `task_attempt`/`correction`/`artifact`
events at task boundaries (build-orchestrator skill), and its `~/.hermes/memories` are auto-bridged.

## 4. Bridge — both stacks, OpenClaw drives Hermes (the OpenDuck default)

Both MCP registrations point at the **same `state.db`** (scopes `openclaw` / `hermes`; reads =
own + `shared`). OpenClaw is the driver: it routes research/build to Hermes over ACP and uses
`handoff_brief` to push scoped memory across the boundary (ACP sessions don't share context).
- Cross-stack knowledge is published with `scope: "shared"`.
- `midmem bridge` (and `autoIngest.onMaintain`) consolidate *both* stacks' native memory dirs.
- Work events recorded by either stack are visible to both — a correction Hermes logs shapes
  OpenClaw's future turns, and vice-versa.

## 5. Claude Code overlay — frontier orchestration (composes with any mode)

Not a fifth *store* mode — Claude Code reaches the core through the **same CLI + MCP + hook seam** as
everyone else — but a distinct *role* worth calling out, because it integrates tightly with Hermes.
Claude Code is the **frontier orchestrator**: it plans MidMem work, dispatches the mechanical build to
**Hermes** over kanban / ACP, QAs each result, and records durably. Claude Code decides and verifies;
Hermes builds; both read/write the one shared `state.db`.

- **Wiring (copy-paste):** drop a `.mcp.json` at your project root and approve it once:

  ```json
  // <project>/.mcp.json
  { "mcpServers": { "midmem": { "type": "stdio", "command": "/path/to/bin/midmem-mcp" } } }
  ```
  ```json
  // ~/.claude/settings.json (approve the project server)
  { "enabledMcpjsonServers": ["midmem"] }
  ```
  ```bash
  #!/usr/bin/env bash
  # /path/to/bin/midmem-mcp — thin wrapper; ALL env lives in one shared file
  source /path/to/bin/midmem-env.sh     # same file your midmem CLI wrapper sources
  export MIDMEM_AUTO_INGEST=0           # bridge/auto-ingest stays single-owner elsewhere
  export MIDMEM_AGENT_SCOPE="${MIDMEM_AGENT_SCOPE:-shared}"
  exec node /path/to/midmem-kb-store/packages/core/bin/mcp-server.mjs
  ```
  `midmem-env.sh` holds `MIDMEM_DB_PATH`, `OBSIDIAN_VAULT_PATH`, `MIDMEM_LLM_ENDPOINT`, model +
  timeout knobs — **one file sourced by every wrapper**; duplicated env blocks are how deployments
  drift. Verify before first use:
  `printf '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n' | /path/to/bin/midmem-mcp`
- **Guardrails that make the wiring safe:** (1) exactly one process owns auto-ingest — every other
  registered instance sets `MIDMEM_AUTO_INGEST=0`; (2) the MCP process is long-lived, so
  core-development sessions verify via the CLI and reconnect (`/mcp`) after changes; (3) treat
  wiring impact as part of every core change (checklist in the `midmem-dev` skill).
- **Skills:** the [MidMem Skills Library](../skills/) (ships in-repo) equips it — `midmem-dev` (change
  the core), `midmem-orchestrator` + `midmem-ingest-review` (curate + QA), `midmem-record` (durable
  capture). These are portable, Claude-Code-only adaptations of the skills a live deployment runs.
- **Guaranteed capture:** a Claude Code `Stop`-hook can block a turn from ending until a recordable
  change is written to MidMem — the most reliable capture path in the stack. See
  [STACK-CAPTURE.md](STACK-CAPTURE.md).

---

## 6. External library or capture system (any harness) — roadmap #45

A system that captures or curates documents (a read-later app, a document library, a notes
exporter) feeds MidMem through the ordinary governed ingest and needs **no core change**. MidMem
holds the derived knowledge (summary, claims, concepts, embedding) and its lifecycle; the calling
system keeps the evidence (the raw artifact and the canonical text) permanently, outside MidMem.

**The contract, on the code as of #46 (2026-09-24):**

1. **A stable path per source.** Write the canonical text of each source to one stable file path
   (for example `<archive>/web/<hash of the canonical URL>/article.md`) and re-write it in place when
   the source changes. Re-ingesting the same path with changed content archives the previous entry
   (path-keyed supersede); unchanged content is a no-op (hash dedup). The same content arriving at a
   second path is linked onto the existing entry (`provenance.alsoSources`), never duplicated.
   A source whose entries were all forgotten re-ingests afresh at the same path; it is not
   `unchanged`.
2. **Register the archive root once.** `MIDMEM_SOURCE_ROOTS` **replaces** the default root list — set
   the full default list plus the archive root, never the archive root alone. Keep the archive
   outside every `bridgeSources` folder (or the bridge would auto-ingest it under that folder's
   scope) and, on this host, outside the Obsidian vault.
3. **Call ingest with the source's identity** so recall shows the chain back to the URL:
   ```
   midmem ingest <archive>/web/<id>/article.md --type web-article --authority web \
     --scope shared --project library \
     --source-uri <original url> --canonical-uri <canonical url> --library <libraryId> \
     --doc-id <docId> --capture-method url_fetch --captured-at <ISO> [--site --author --published-at --language] \
     [--favorite]
   ```
   The values land in `provenance.source` (and on the sources row) and come back on every recall
   row. `--type` may be a capture-pack type (`web-knowledge` pack: `web-article`, `news`,
   `research-paper`, `technical-documentation`, `tutorial`, …), which sets the entry's type, memory
   function and lease; any other type stores a plain `ingest` entry in the memory tier.
   The capture system may set `--type` to any web-knowledge pack entryType it determines
   deterministically on-box. `--favorite` (added 2026-10-21) is sent for a source the operator has
   starred; it is a bare switch (it never takes a value, so any position in the argv works) with the
   effects in item 6(b).
4. **Text without a file:** `midmem ingest-content --source-uri <url> --stdin` (MCP `ingest_content`)
   materializes the text under `MIDMEM_CONTENT_INGEST_DIR` at a path keyed by the source identity and
   runs the same governed ingest — the same source always supersedes itself.
5. **Authority is `web` for anything external.** Never `--curated`: it labels the source
   operator-authored and grants protected recall slots (#39) and verbatim returns (#42).
6. **Never write memory for captures — except two operator-initiated writes (amended 2026-10-04).** No
   `remember`, no `record_work`, no `promote`, never `--curated`, and no `ingest-content` from a system that
   keeps files. A capture system may write only: **(a)** the ingest above; **(b) operator feedback**:
   `midmem feedback <entryId> [--unhelpful]`, sent only when the operator, signed in to the capture system,
   marks one of its entries helpful or not. It moves `helpful_count`/`trust_score` exactly as an agent's
   feedback does. Promotion into `wisdom` still happens only in `maintain`, under the earned rule
   (`retrieval_count ≥ 5`, `trust_score ≥ 0.7`, `helpful_count ≥ 2`, write-time grounding ≥ the promotion
   floor), so feedback alone never promotes: agents must also recall the entry. The caller rate-limits votes
   (one per entry per cooldown) and never sends a vote the operator did not cast.

   **Favorites (added 2026-10-21, schema 6)** are part of (b): `midmem feedback <entryId> --favorite` and
   `midmem feedback <entryId> --unfavorite`, sent only when the operator stars or unstars one of its entries.
   A favorite counts as **one helpful vote**: the first `--favorite` on an ACTIVE entry sets `favorite`, adds 1
   to `helpful_count` and the helpful trust delta (`thresholds.feedback.helpfulTrustDelta`, 0.05) to
   `trust_score`, clamped to [0, 1], and records that vote (`favorite_helpful`). `--unfavorite` clears the
   favorite and takes back **exactly that vote** — `helpful_count` − 1 (never below 0), `trust_score` − the
   delta (clamped; a favorite set at trust ≥ 0.95 therefore comes back up to 0.05 lower) — while explicit
   helpful votes stay. Both are **idempotent** (a repeat answers `changed: false` and moves nothing) and
   metadata-only (`updated_at`, the lease and the other counters are untouched). Each prints ONE JSON
   document, `{ success, id, favorite, helpful_count, trust_score, changed }` (`favorite` and `changed` are
   booleans, `trust_score` has 3 decimals); an unknown or non-active entry is refused exactly like feedback
   (`{ success: false, reason: "not-found" | "not-active", id, status? }`, exit 0, nothing moves). Two votes
   in one call (`--favorite` with `--unfavorite` or `--unhelpful`, or `--unfavorite` with `--unhelpful`), any
   other switch (a misspelt `--favourite` would otherwise count as a plain helpful vote) and a second entry id
   are usage errors: exit 1 and `ERROR:` on stderr, nothing written. The switches never take a value, so they
   may sit anywhere in the argv. `feedback <entryId> [--unhelpful]` and its output
   `{ success, id, trust_score, helpful }` are unchanged.
   - **`ingest … --favorite`** (item 3; also `ingest-content`, and with `--sections` the digest itself):
     the entry the ingest stands for — the new entry, the live holder of a linked duplicate, or the active
     entry of an unchanged source — becomes (or stays) a favorite under the same one-vote rule, and the result
     carries `favorite: { success, id, favorite, helpful_count, trust_score, changed }`, plus
     `linkedDuplicate: true, holder: <entry id>` when that entry is a linked duplicate's holder; an unchanged
     source with no active entry answers `favorite: { success: false, reason: "no-active-entry" }`. An ingest
     never unfavorites (`ingest --unfavorite` is a usage error; leaving `--favorite` out changes nothing).
   - **Linked duplicates are N : 1.** Identical text from several sources lives in ONE entry (the holder;
     the others are its `provenance.alsoSources`), so those sources share ONE favorite: `ingest --favorite`
     of a linked source favorites the holder, and `--unfavorite` through any of them clears it for all. A
     capture system therefore counts its stars per holder (an `entries` row's `linkedTo` names it), sends
     `--unfavorite` only when none of the captures sharing that holder is starred any more, and re-checks the
     holder whenever a linked capture gets an entry of its own (its text changed): it unfavorites a holder no
     starred capture shares any more, and favorites the capture's new entry if that capture is starred.
   - **A live flag.** Only an ACTIVE entry is a favorite: an archived or deleted version (a superseded one in
     `query --historical`, an `entries` head that is no longer active) reports `favorite: false` and gets no
     boost; `favorite_helpful` / `helpful_count` stay as its vote history, and `recall` shows the stored
     columns.
   - **Carry-over:** when an ingest supersedes (archives) an entry of the same source that was a favorite,
     the new entry inherits the favorite and its one helpful vote — applied **once**, also when `--favorite`
     is passed (the result's `favorite` block then lists `carriedFrom: [ids]`). Explicit votes stay with the
     archived version, whose counters and favorite are history and are not rewritten.
   - **Ranking:** after fusion, a favorite gets `favoriteWeight` (default 0.004, `MIDMEM_FAVORITE_WEIGHT`)
     and a favorite that ALSO has an explicit helpful vote (`helpful_count − favorite_helpful ≥ 1`)
     `favoriteHelpfulWeight` on top (default 0.002, `MIDMEM_FAVORITE_HELPFUL_WEIGHT`), so among equally
     relevant entries favorite + helpful > favorite > neither — but only when the query MATCHES the favorite:
     a lexical lane (fts or trigram) returned it, or the vector lane ranked it in its top `favoriteVectorTopK`
     (default 10, `MIDMEM_FAVORITE_VECTOR_TOP_K`; 0 = lexical matches only). A dense embedder (bge-m3) gives
     every entry a positive cosine, so the vector lane alone returns up to 200 candidates for any query; past
     its top 10 a favorite ranks exactly where its relevance and its votes put it. A favorite is never added to
     a result. A relevance guard then holds any favorite whose lift — the boosts plus its votes' trust boost —
     would carry it past a candidate holding more of the query's words (Unicode letters and digits; a script
     written without spaces, such as Chinese or Japanese, by character bigrams) just below that candidate, and
     the favorites it holds there keep their own order (favorite + helpful above favorite). Query rows carry
     `favorite`; `rank.favorite` / `rank.favoriteHelpful` show the boosts and `rank.favoriteGuard` marks a
     favorite the guard held. Measured offline (`packages/core/test/favorite-ranking.mjs`, with hash vectors
     AND with dense 1024-dimension vectors): the order above holds in every role assignment, also under one
     better match; no favorite is placed above a target holding more of the query's words; past the vector
     top 10 a favorite gains nothing (without that gate one at vector rank 40 reached #1); Cyrillic and CJK
     favorites stay below the entry holding the query's words. Inside the guard's window a favorite with
     explicit votes can sit just below an equally relevant non-favorite carrying the same votes (a
     non-favorite's votes are not held).
   - **Capability check:** every `entries` row of a favorites-capable MidMem carries `favorite` (item 7).
     Never send the switches to an older MidMem: its CLI ignores unknown switches, so it would count
     `--favorite` AND `--unfavorite` as plain helpful votes.

   **(c) operator-initiated
   forget**: `midmem forget-source --library <id> --doc-id <docId>`, sent only when the operator permanently
   deletes that source in the capture system. It soft-forgets every entry from the source (#41 cascade) and
   unlinks it from other entries' `alsoSources`, and the calling system logs each forget. **(d)
   operator-initiated re-extraction (added 2026-10-07)**: only after the operator has approved an
   on-network extraction model for the store ([OPERATIONS.md](OPERATIONS.md), "Enabling an on-network
   model"), `midmem reextract --library <id> --doc-ids a,b [--limit n] [--retry-failed] [--dry-run]` re-runs model
   extraction for that system's entries whose source file is **unchanged** (same path, same content hash)
   and updates each one **in place**: the same entry id, tier, scope, project, authority, lease
   (`expiresAt`), counters (retrieval, helpful, trust) and `provenance.source`. Summary, concepts and
   claims are replaced through ingest's own steps (ungrounded concepts and claims quarantined; the old
   claims archived with lineage, never deleted; the entry re-embedded; the instruction-likeness verdict
   recomputed from the full source), and `provenance.extraction` records the model. It writes only when
   the model really answers: a fallback (model off, unreachable, timed out, an HTTP error, an
   unparseable answer, or the embedder down) leaves the entry exactly as it was and counts
   `skipped.fallback`. A model that is **down** (off, unreachable, timed out, HTTP 5xx / 401 / 403 / 404
   / 408 / 429, the embedder down) stops the pass (`stopped: { id, reason }`); a failure that belongs to
   **one entry** (an unparseable or empty answer, any other HTTP 4xx such as 400 or 413 for a text that
   overflows the loaded context) skips only that entry, and later runs leave it alone for 24 hours
   (`skipped.retryLater`, no model call; `--retry-failed` retries now) and take never-failed entries
   first, so one poison source never stalls the loop. An unexpected error while writing one entry stops
   the pass with `stopped: { id, reason: "error", message }` (that entry stays in `remaining`) and the
   document is still printed. **Curated knowledge is never rewritten:** an entry in a curated-only tier
   (`wisdom`) or with `operator` authority counts `skipped.denied` (the run is never curated). A
   changed, missing or unreadable source is skipped with that reason (a changed one is the ordinary
   ingest's job); the source path passes the governance gate before the file is opened. Default
   selection `--only-fallback` (entries whose extraction is not `lmstudio`, legacy entries without a
   record included), so a re-run resumes where the last one stopped; `--all` forces; `--limit` caps the
   model calls per run (default 100, ≤ 5000); one model call at a time. It prints ONE JSON document:
   ```
   { success, dryRun, examined, reextracted,
     skipped: { changed, missing, unreadable, fallback, deleted, notSelected, denied, retryLater },
     entries: [ { id, docId, mode, concepts, claims, quarantined } ], remaining, stopped }
   ```
   `examined = reextracted + Σ skipped + remaining`; per requested doc id its active entry is examined (a
   doc whose newest entry was forgotten counts `deleted`; an unknown or inactive doc, or one already
   model-extracted, `notSelected` — an entry archived by id meanwhile included); `denied` = a curated
   entry, a row whose stored title, author or source URI the ingest boundary guards would now refuse
   (secret-shaped, 2026-10-05; `MIDMEM_SECRET_TEXT_GUARD=0` lifts the title/author half), or the
   governance gate refused the source path or scope; the source is read through its canonical path and
   the rows reextract writes record that form (the sources row keeps its stored identity);
   `retryLater` = its last answer failed less than 24 h ago; `remaining > 0` = call again;
   `success: false` only when the pass stopped (model down, or an error) before re-extracting anything;
   `--dry-run` lists the would-be `entries` with `mode: null`, calls no model and writes nothing. CLI only (no MCP tool). It
   reads the source files, so it runs as the user that can read the archive (the capture system's own
   user, or through the capture system); run as any other user those sources come back `unreadable`.
   None of these exceptions changes an entry's authority (`web`), tier, scope or project.
7. **Reads.** Any consumer: `midmem query "<q>" --projects library` (MCP `query` with
   `projects: ["library"]`), or unfiltered when the caller has no project set. Rows carry
   `authority`, `provenance.source`, `fidelity`, `status`, the instruction-likeness flag (#40) and
   `favorite` (2026-10-21).
   `midmem entries --library <id> --doc-ids a,b [--claims]` (MCP `entry_status`) returns each
   source's lifecycle view: tier, lease, counters, concepts, claims and promotion progress.
   Reading it is not a recall; it never renews a lease or bumps `retrieval_count`. Each entry carries
   `extraction: { mode, model, at }` — `lmstudio` (model-extracted) or `fallback` (the deterministic
   offline heuristics: lead sentences and frequent tokens) — or `null` for an entry ingested before
   2026-10-07, which recorded nothing; a capture system uses it to tell model concepts from fallback ones.
   Since schema 6 (2026-10-21) each entry also carries `favorite` and `favoriteHelpful` (booleans: the
   operator's favorite — true on an active entry only — and whether a favorite's one vote is inside
   `helpfulCount`); `midmem recall <id>` returns the stored columns `favorite` / `favorite_helpful` (0 or 1)
   and `midmem brief` counts the active favorites.
8. **Call shape.** Shell out to the `midmem` CLI through a durable queue with a frozen argv allowlist
   and a provider switch (mock in every test: zero `execFile`); or import `Orchestrator` in-process
   for a Node caller on the same host. Both are governed identically.
   The allowlist names the verbs `ingest`, `feedback`, `forget-source`, `entries` and `reextract`;
   favorites (2026-10-21) add only the switches `--favorite` (feedback, ingest) and `--unfavorite`
   (feedback).

**Coming for this mode:** metadata filters on query (#48) and MidMem's Qdrant spin-up with a vector
backfill (#50, #51). None changes the contract above. The Qdrant adapter's code half has landed: search
uses `POST /points/query` (Qdrant ≥ 1.19 removed `/points/search`), one collection per embedding space,
and a `store_id` tenant key (keyword index created `is_tenant: true`, filtered on every search); the
migration path is `vectors backfill` (copies the SQLite vectors, no re-embed) → `vectors parity` → flip
`MIDMEM_VECTOR_BACKEND=qdrant` by config. **Shipped (#49): the library lane** — MidMem
asks a registered library system for full-document evidence at the deep stage of retrieval and fuses
it as its own lane, never storing it; register one with
`MIDMEM_LIBRARIES="kb|http:http://127.0.0.1:8790/provider"` (HTTP) or `kb|module:/abs/provider.mjs`
(in-process ES module exporting `search` + `get`), per the frozen contract in
`packages/core/test/fixtures/library-provider.json`.

## What stays constant across all modes
- `state.db` is the single source of truth; the vault is a deterministic, regenerable projection.
- DELEGATE-52 grounding gates every extracted concept/claim before it persists (no LLM self-review).
- Categorization and work-event recording are **deterministic** (no LLM in that path).
- Governance is fail-closed; scope rules prevent cross-private writes.

## Config knobs (env)
| Env | Default | Effect |
|---|---|---|
| `MIDMEM_DB_PATH` | repo `state.db` | shared source of truth (point all modes here to bridge) |
| `MIDMEM_AGENT_SCOPE` | `shared` | this caller's write scope (`openclaw`/`hermes`/`shared`) |
| `MIDMEM_PROJECT` | unset (global) | this caller's project slug — writes tag it, reads return project + global; unset = global writes, unfiltered reads |
| `MIDMEM_PROJECT_LIFT` | on | promotion into `wisdom` lifts a project entry to global (lineage kept in `provenance.liftedFrom`) |
| `MIDMEM_BRIDGE_SOURCES` | built-in: OpenClaw/Hermes memory dirs + each agent vault folder split (the folder private, its `research/` + `reports/` bridged as `shared`) | `dir\|scope\|type\|project\|recursive\|exclude,…;…` — replaces the default bridge roots so any harness's memory dir or report folder registers with zero core change; the sixth field lists subfolders another source owns |
| `MIDMEM_BRIDGE_RECURSIVE` | on | bridge walks subfolders (dot-dirs + `node_modules` skipped); `0` = flat walk |
| `MIDMEM_LIBRARIES` | unset (no library) | `id\|module:<abs path>;id2\|http:<base url>` — registers external library systems (#49) asked for evidence at the deep stage of retrieval; their rows are fused, never stored |
| `MIDMEM_LIBRARY_LANE` / `…_LIMIT` / `…_TIMEOUT_MS` / `…_WEIGHT` | on / 8 / 4000 / 0.8 | library lane (#49): on/off, max library rows per query, per-provider call timeout, RRF weight of the lane |
| `MIDMEM_VECTOR_BACKEND` / `MIDMEM_QDRANT_URL` / `…_COLLECTION` / `…_API_KEY` | `sqlite` / `http://localhost:6333` / `midmem_memory` / unset | vector backend; the Qdrant endpoint, collection (one per embedding space) and `api-key` header (#50) |
| `MIDMEM_STORE_ID` | `default` | tenant key (#51): written as payload `store_id` on every Qdrant point and filtered on every Qdrant search, so several stores can share one collection |
| `MIDMEM_QDRANT_TIMEOUT_MS` / `MIDMEM_QDRANT_BATCH` | 5000 / 100 | per-request Qdrant timeout; points per upsert batch in `vectors backfill` |
| `MIDMEM_OCCUPANCY` / `…_CAP_STACK` `…_CAP_DOC` `…_CAP_WEB` `…_OPERATOR_SLOTS` `…_MIN_LINEAGES` | on / 0.6 / 0.6 / 0.25 / 2 / 2 | bounded-occupancy selection on budgeted reads (#39): per-authority caps that bind only against a waiting competitor, protected operator slots, lineage floor |
| `MIDMEM_INSTRUCTION_FLAG` / `MIDMEM_INSTRUCTION_PENALTY` | on / 0.01 | instruction-likeness flag on results (#40): computed over the full source at ingest (kept as `provenance.instructionLike`) and on library-lane rows' full evidence text; flagged rows demoted + labelled, never dropped; `0` turns all of it off |
| `MIDMEM_FIDELITY` / `MIDMEM_VERBATIM_MAX_CHARS` | on / 4000 | fidelity class on results (#42); verbatim rows (operator / curated tier) uncut up to the ceiling |
| `MIDMEM_FAVORITE_WEIGHT` / `MIDMEM_FAVORITE_HELPFUL_WEIGHT` / `MIDMEM_FAVORITE_VECTOR_TOP_K` | 0.004 / 0.002 / 10 | post-fusion boost of an operator's favorite, and of a favorite that also has an explicit helpful vote (§6 6b, 2026-10-21); only for a favorite a lexical lane returned or the vector lane ranked in its top K, never past an entry holding more of the query's words; a weight of `0` turns that boost off (the favorite's helpful vote stays), K `0` keeps the boosts to lexical matches |
| `MIDMEM_WORKING_TTL_MS` | 86400000 (24 h) | lease for `working`-function entries (#44); they never promote and are excluded from default reads |
| `MIDMEM_FORGET_CASCADE` | on | dependency-aware forget (#41): archive sourced claims, flag sole-support concepts |
| `MIDMEM_WORK_MEMORY` | on | enable work-memory event recording |
| `MIDMEM_AUTO_INGEST` / `…_ON_MAINTAIN` | on | auto-bridge agent session/memory dirs during `maintain()` |
| `MIDMEM_PROACTIVE_RECALL` | on | enable the pre-turn recall primitive |
| `MIDMEM_MAINTENANCE` | on | self-driving decay/promotion/projection (+ auto-ingest) |
