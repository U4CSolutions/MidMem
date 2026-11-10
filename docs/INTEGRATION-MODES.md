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
6. **Never write memory for captures — except operator-initiated writes (amended 2026-10-04, 2026-10-07 and
   2026-11-10).** No `remember`, no `record_work`, no `promote`, never `--curated`, and no `ingest-content` from a
   system that keeps files. A capture system may write only: **(a)** the ingest above; **(b) operator feedback**:
   `midmem feedback <entryId> [--unhelpful]`, sent only when the operator, signed in to the capture system,
   marks one of its entries helpful or not. It moves `helpful_count`/`trust_score` exactly as an agent's
   feedback does. Promotion into `wisdom` happens in `maintain`, under the earned rule
   (`retrieval_count ≥ 5`, `trust_score ≥ 0.7`, `helpful_count ≥ 2`, write-time grounding ≥ the promotion
   floor), so feedback alone never promotes: agents must also recall the entry — or, since 2026-11-10, on the
   operator's explicit approval of that one entry (item (e) below), which no vote can stand in for. The caller
   rate-limits votes (one per entry per cooldown) and never sends a vote the operator did not cast.

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
   are usage errors: exit 1 and `ERROR:` on stderr, nothing written. The three switches (`--unhelpful` too)
   never take a value, so they may sit anywhere in the argv and a token after one counts as a second id.
   `feedback <entryId> [--unhelpful]` and its output `{ success, id, trust_score, helpful }` are unchanged.
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
     a lexical lane (fts or trigram) returned it AND it holds one of the query's words (on a question — "what
     did the minister say about the tariffs" — the stopwords and trigram substrings make nearly every entry a
     lexical hit; a query with no words of its own falls back to any lexical hit), or the vector lane ranked it
     in its top `favoriteVectorTopK` (default 10, `MIDMEM_FAVORITE_VECTOR_TOP_K`; 0 = lexical matches only),
     counted over the candidates the query's filters leave (`types`, `functions`, metadata filters,
     `minAuthority`). A dense embedder (bge-m3) gives every entry a positive cosine, so the vector lane alone
     returns up to 200 candidates for any query; past its top 10 a favorite ranks exactly where its relevance and
     its votes put it. A favorite is never added to a result. A relevance guard then holds any favorite whose
     favorite lift (the boosts plus the trust of its own vote) would carry it past a candidate holding more of
     the query's words just below that candidate — never below the score it would have as a non-favorite, so
     starring never lowers an entry, and an explicit helpful vote lifts a favorite exactly as it lifts any entry
     — and the favorites it holds there keep their own order (favorite + helpful above favorite). The query's
     words: Unicode letters and digits, English stopwords and question words (what, say, …) out, Latin
     diacritics folded as FTS folds them (café = cafe, İ → i), runs split where the script changes; a script
     written without spaces (Chinese, Japanese, Thai, Korean) counts each character and each pair, so a
     one-character word matches and 학교 is found in 학교에서. Query rows carry `favorite`; `rank.favorite` /
     `rank.favoriteHelpful` show the boosts and `rank.favoriteGuard` marks a favorite the guard held. Measured
     offline (`packages/core/test/favorite-ranking.mjs`, with hash vectors AND with dense 1024-dimension
     vectors): the order above holds in every role assignment, also under one better match; starring never
     lowers an entry; no favorite passes a target holding more of the query's words except on its own explicit
     vote; past the vector top 10 a favorite gains nothing (without that gate one at vector rank 40 reached #1);
     Cyrillic and CJK favorites stay below the entry holding the query's words; on question-form queries the
     word gate keeps starred unrelated entries out of a top 3 (0 of 15 synonym questions; 15 of 15 without the
     gate). The vector side trusts the embedder: the offline hash embedder (no model configured) hashes stopwords
     like words, and in its deep pass 1 synonym question in 15 lifted a starred unrelated entry from its vector
     top 10 into the top 3.
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
   Since 2026-10-19 the forced maintain also runs a bounded reextract batch (`MIDMEM_MAINTAIN_REEXTRACT`,
   default 20, only when the model endpoint answers) that re-extracts only sources the store user can read,
   so a capture system whose archive is its own keeps re-extraction in its own hands.

   **Amended 2026-11-10 (operator decision).** The operator decided, answering the assistant options record:
   *"build promotion and claims review queue"* and *"add operator approved wisdom promotion"*, with the assistant
   that prepares those queues living inside the capture app (*"assistant lives inside the app; currently this is a
   single user app for operator only"*). A capture system may therefore additionally send (e) and (f) below — **each
   write only as the direct result of ONE explicit operator action on ONE entry or claim in the capture system's UI:
   never batched, scheduled, automatic or initiated by a model.** A model may PREPARE a case for the operator to
   read; it never decides and never sends. Still no `promote`, never `--curated`, no `remember` / `record_work`.
   **Who can run them:** MidMem does not identify its caller. Like `promote --curated` today, these writes can be run
   by anything with shell access to the store (the launcher and the store's group), an agent session included;
   "operator only" is enforced by the capture system's UI and by convention, not by MidMem.

   **(e) operator-approved wisdom**: `midmem approve-wisdom <entryId> [--note <text>] [--via <system>]` and
   `midmem revoke-wisdom <entryId> [--note <text>] [--via <system>]` (CLI only — no MCP tool).
   - **What an approval is.** It moves ONE `memory` entry into `wisdom`. It **replaces the usage evidence** of the
     earned rule (`retrieval_count`, `trust_score`, `helpful_count`) **and nothing else**: every other check the
     earned path applies holds. The checks run in this order and the first that applies is the answer
     (`{ success: false, denied, id, message }`, exit 0, nothing moved): `not-found`; `not-active` (not active, or
     its lease has run out — `maintain` sweeps before it promotes); then, if the entry is already wisdom by a live
     approval, the answer is `{ success: true, changed: false, … }` (see Retries); `already-wisdom` (wisdom by another
     road: earned or curated); `not-memory-tier` (only from `memory`, never `fact` → `wisdom`); `lifecycle` (a
     `working` entry never promotes); `fallback-extraction` (an ingested entry that is not model-extracted —
     `provenance.extraction.mode` is the fallback, or there is no record because it was ingested before 2026-10-07:
     wisdom is never re-extracted, so frozen fallback text is never approved; `reextract` it first. A direct write such
     as a `remember`ed note has no extraction and is not refused here); `grounding-below-floor` (the transition
     verifier's write-time grounding floor, `MIDMEM_PROMOTE_MIN_GROUNDING`, 0.3 — maintain's pre-filter);
     `instruction-like` (the #40 screen flags the entry's text or its full source; it runs for an approval even with
     `MIDMEM_INSTRUCTION_FLAG=0`, which turns off only the read-time label); `governance` (the policy
     `operator-approved-wisdom`, and `working-never-promotes`, which covers this op too); `transition-verifier` (re-run
     inside the write with its receipt, exactly as `promote()` runs it for the earned path — it answers only when the
     entry changed between the checks). Success: `{ success: true, changed: true, id, tier: "wisdom", approval: { at,
     via } }`.
   - **What the approval gives: what the wisdom tier gives an earned entry, nothing more.** An approved entry is
     earned-equivalent. (1) It has no lease: it never decays by disuse. (2) It is immune to distrust archival:
     unhelpful votes can only put it on `lint`'s `lowTrustWisdom`. (3) Its fidelity class is `verbatim`: a recall
     returns its whole text up to `MIDMEM_VERBATIM_MAX_CHARS` (4,000) instead of the 600-character preview. (4)
     `reextract` skips it (`skipped.denied`), the nightly batch included — which is why a fallback-extracted entry is
     refused. (5) A project-tagged entry is lifted to global (`project` null, `provenance.liftedFrom`), so it appears in
     every project's reads, not only `--projects library`. The tier moves through the same `memory.promote` the earned
     path uses, so (1) and (5) are exactly an earned promotion's. It is **not curation**: authority stays what it was
     (`web` for a capture), so no protected recall slots (#39), no operator authority; the `curated-tier-write` policy is
     unchanged (`promote <id> wisdom` without `--curated` is denied exactly as before) and a separate policy admits this
     one op, only with `operatorApproved: true` and `curated: false`.
   - **The record.** `provenance.approval = { by: "operator-approval", from, to, at, via, note, liftedFrom }`, written
     in the same write as the tier move (`via` / `note` null when not sent; `liftedFrom` the project the lift moved, or
     null); the `promote` log row the earned path writes (`{ id, toTier }`) plus the reason `{ by, at, via, note }`;
     the `transition:promote` receipt plus `by`; a governance audit row for op `approve-wisdom` with
     `{ fromTier, toTier, operatorApproved: true, curated: false, memFunction }`. Denials are logged
     (`approve-wisdom-denied`); a `changed: false` answer writes nothing.
   - **An approval ends when another road moves the entry.** Any tier move that is not `approve-wisdom` /
     `revoke-wisdom` — `maintain`'s earned promotion, an agent's `promote --curated`, `promote <id> memory` moving it
     down — stamps the record `{ endedAt, endedBy: "promote", endedTier }` in the same write. An ended record is never
     live again: the entry is not revocable, `approvedAt` is null, `wisdomBy` does not say `operator-approved`, and the
     OPERATIONS listing leaves it out. A later `approve-wisdom` writes a fresh record (the old one moves to
     `provenance.approvalHistory`).
   - **Revoke** takes back only a live approval. Checks in order: `not-found`, `not-active`, then — if the latest
     approval was revoked by `revoke-wisdom`, the entry is back in `memory` and nothing ended the record since —
     `{ success: true, changed: false, … }`; `not-wisdom`; `not-operator-approved` (earned and curated wisdom, also when
     an older approval of it was ended by that other road, is never moved down here); `governance`. The entry returns
     to `memory` with a **fresh lease by the rule ingest applies to its type** (the capture pack's `ttlDays` —
     `web-article` 90 days, `news` 45 — else the memory tier's 30 days), the project the approval lifted comes back,
     counters, trust and favorite stay as they are, and the record stays as history with `revokedAt` (plus
     `revokeNote` / `revokeVia` when sent). Success: `{ success: true, changed: true, id, tier: "memory", expiresAt,
     project, approval: { at, via, revokedAt } }` (a `changed: false` answer has the same keys, with the entry's current
     lease and project). Afterwards the entry can earn wisdom in `maintain` like any other entry — it is then earned
     wisdom, not revocable — or be approved again. Logged (`revoke-wisdom`, denials `revoke-wisdom-denied`) and governed
     (op `revoke-wisdom`).
   - **Interplay** (smoke §80, §83): `maintain` never demotes, sweeps or re-promotes an approved entry; `reextract`
     skips it as it skips earned wisdom (`skipped.denied`) and, after a revoke, re-extracts it in place with the record
     kept; a re-ingest of the same source with changed content archives it as it archives earned wisdom and the new
     version enters `memory` unapproved — **a re-capture drops the approval (the operator approves the new version
     again), while a favorite carries over**; `forget-source`, `archive`, `feedback` and favorites treat it as any entry
     (the record stays on an archived or forgotten row as history); `lint`'s `lowTrustWisdom` lists it by its own rule.
     Linked duplicates (item 6(b)) are ONE entry, so one approval stands for every source it holds.
   - **Usage errors** (exit 1, `ERROR:` on stderr, nothing written): no id or two; any flag but `--note` / `--via` (a
     stray `--curated` included), a `--flag=value` form, a flag given twice; a bare `--note`; a note over 500 UTF-16
     code units (JavaScript string length: an emoji counts 2), or carrying a control character other than newline and
     tab (CR included), a C1 control (U+0080–U+009F), a line or paragraph separator (U+2028, U+2029) or a
     bidirectional override or isolate (U+202A–U+202E, U+2066–U+2069), or a secret-shaped value (the ingest boundary's
     rule, plus for notes the `password: …` / `token: …` form); a `--via` other than 1–40 letters, digits, `.`, `_`,
     `:` or `-`. A note never starts with `--` (the parser would read it as a flag).
   - **Capability check:** `entries` rows carry `approval` and `thresholds.operatorApproval: true` (item 7); it covers
     (e), (f)'s `--replace-neighbor` and item 7's `claims-deferred --library`. Never send any of them to an older
     MidMem: it answers `approve-wisdom` / `revoke-wisdom` with its usage text (not JSON) **and exit 0**, and its CLI
     ignores switches it does not know, so `claims-deferred --library` prints the whole ledger and `claim-resolve <id>
     --replace-neighbor` **accepts** the claim (both stand) instead of replacing the neighbour.

   **(f) claims review**: `midmem claim-resolve <claimId>` (accept: active, the pair re-tagged additive, both stand),
   `midmem claim-resolve <claimId> --reject` (archived) and `midmem claim-resolve <claimId> --replace-neighbor`
   (2026-11-10, CLI only: the MCP `claim_resolve` tool keeps accept | reject). `claim-resolve` is strict: exactly one
   id, at most one of `--reject` / `--replace-neighbor`, nothing else — a misspelling (`--replace-neighbour`), a
   `=value` form, a repeated or second resolution flag is a usage error (exit 1, nothing written), never a plain
   accept. Accept and reject answer a first call exactly as before (`{ success, id, status[, judged] }`).
   `--replace-neighbor` accepts this claim AND supersedes its contradicting neighbour by it **in one transaction**,
   with the existing supersede chain fields — the neighbour `superseded` with `metadata.superseded_by`, this claim
   `metadata.supersedes` — that `claim-validity`, the current read (`claims`) and the consistency check read; this
   claim also records `deferredResolution` and `judged: { action: "replace-neighbor", at, from }`. The checks, the
   transition receipt, both claim writes, the `claim-resolve` log row and the stale-path flags land together or not at
   all. Stale-path flagging for a replacement applies only rule (ii) of the supersede rule: concept labels the
   contested claim itself names (≥ 2 of its significant words, covering the containment floor of the label) — not every
   node the neighbour's capture created. Success: `{ success: true, changed: true, id, status: "active", neighbor: {
   id, status: "superseded" }, stalePath }`. Refused (`{ success: false, denied, id, message }`, exit 0; nothing written
   but the log row and the receipts) in this order: `not-found`; `not-deferred` (it also carries `status` and
   `resolution`, see Retries); `claim-source-gone` (the claim's source entry is no longer active — a superseded capture
   version, an archived or forgotten entry: such a claim would be swept as `source-gone` and take the live neighbour
   with it); `claim-stance` (the claim is no observed fact — `provisional`, `quoted` or `rejected`, as
   `claims-restance` can re-tag a deferred claim — and would drop an observed fact from current reads);
   `no-neighbor` (the claim records no write-time neighbour — an explicit deferral, say); `neighbor-not-live` (the
   neighbour is not active or verified, e.g. another claim already replaced it); `neighbor-authority` (the neighbour's
   authority is higher than this claim's: a web claim never supersedes an operator-authored one; a claim stored
   without a label counts as `doc`); `transition-verifier` (the supersede's transition receipt denies the pair as
   off-subject). There is no "verified" mark. The read side is item 7's `claims-deferred --library`.

   **Retries and unknown outcomes.** Each of the five forms — `approve-wisdom`, `revoke-wisdom`, `claim-resolve`,
   `claim-resolve --reject`, `claim-resolve --replace-neighbor` — may be repeated with the same argv. `{ success: true,
   changed: false, … }` means the requested state already holds by this road (approved by a live approval, the original
   record returned; revoked; resolved the same way — a repeated accept or reject answers `{ success: true, changed:
   false, id, status }`); nothing was written. Exit 0 with `success: false` is a final refusal with a fixed code; for a
   claim that is no longer deferred by another resolution it is `{ success: false, denied: "not-deferred", id, status,
   resolution, message }` (`resolution` what the record says, or null). Exit 1 with `ERROR: database is locked`, a killed
   child or a timeout is an **unknown outcome**: re-read (`entries <id>`, `claims-deferred --library`) and retry.
   `approve-wisdom`, `revoke-wisdom` and `--replace-neighbor` take the store's write lock before they re-check
   (`BEGIN IMMEDIATE`), and every write waits up to `busy_timeout` (5 s) for the lock, so the message appears only when
   another writer holds it longer than that; any verb, reads included, can then exit 1 that way (a store locked at open
   answers `ERROR: database is locked` too). Usage errors (exit 1, `ERROR:` and the reason) are final.

   None of these exceptions changes an entry's authority (`web`) or scope. Only (e) changes a tier (`memory` ↔
   `wisdom`) and, through the project lift, the project (put back on revoke).
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
   Since 2026-11-10 each entry also carries `approval: { eligible, blockedBy, approvedAt, via, revocable }`:
   `blockedBy` lists every `approve-wisdom` code that applies now, in item 6(e)'s order (`governance` only when the
   tier and lifecycle checks pass), `eligible` is `blockedBy` empty, `approvedAt` / `via` are those of a live approval
   (not revoked, not ended by another road, the entry still in `wisdom`), and `revocable` is true for an active entry
   whose wisdom a live approval put there. The row predicts `approve-wisdom` exactly: `revocable` → `{ success: true,
   changed: false }` (approved already; `blockedBy` still says `already-wisdom` for a NEW approval); otherwise
   `eligible` → approved (`changed: true`); otherwise the first `blockedBy` code (75 of 75 fuzzed rows agree, as for
   `revocable` and `revoke-wisdom`). Where the row explains promotion, `promotion.wisdomBy` (appended after the
   promotion object's other keys) says why a wisdom entry is wisdom when the store can tell:
   `operator-approved` (a live approval), `curated` (operator authority — only a curated write sets it) or `null` (an
   entry earned in `maintain` and one promoted by a caller with `--curated` leave no per-entry record that tells them
   apart). `thresholds.operatorApproval: true` is the capability key. The same keys reach MCP `entry_status`.
   **The claims review queue** (2026-11-10): `midmem claims-deferred --library <libraryId> [--limit <n>] [--offset <n>]`
   (limit ≤ 200, default 50) → `{ total, staleOmitted, claims: [{ id, content, status, stance, deferredAt, deferReason,
   libraryId, docId, sourceTitle, entryId, authority, relation: { relation, shared, similarity, containment? } | null,
   neighbor: { id, content, status, stance, libraryId, docId, sourceTitle, entryId, authority } | null }] }` — the
   deferred claims whose source belongs to that library AND whose source entry is still active, oldest first; `total`
   counts those (before paging). A deferred claim of a superseded capture version (or of an archived or forgotten entry)
   is left out and counted in `staleOmitted`: it is not the operator's to judge (`--replace-neighbor` refuses it,
   `claim-source-gone`), and `claims-sweep` archives it as `source-gone` — its orphan rule covers deferred claims.
   **Offset paging shifts when a claim is resolved** (a resolved claim leaves the list): after each resolution re-read
   from offset 0. Any flag but `--library` / `--limit` / `--offset`, or one given twice, is a usage error. A claim's
   `libraryId` / `docId` are the ones its source was ingested with (`--library` / `--doc-id`, the ids `entries
   --library --doc-ids` reads): its `source.sourceId` (written by ingest since #41, kept by `reextract` and
   `claim_supersede`) names the entry whose ingest produced it — `entryId`, whatever that entry's status now (`entries
   <entryId>` says whether it is still the live one) — and that entry's `provenance.source` (else the sources row's
   own) carries the ids; a legacy claim without a `sourceId` maps through its source path (the newest sources row at
   that path, the active entry standing for it). A claim from no library (an agent's, an operator note) maps to null
   ids. `sourceTitle` is the title sent at ingest; `authority` the claim's origin authority (`doc` when it carries
   none); `relation` the write-time relation (null for an explicit deferral); `neighbor` the claim it contradicts,
   mapped the same way (null without one). A pure read.
   Without flags `claims-deferred` prints the whole ledger exactly as before, stale claims included (MCP
   `claims_deferred` too).
8. **Call shape.** Shell out to the `midmem` CLI through a durable queue with a frozen argv allowlist
   and a provider switch (mock in every test: zero `execFile`); or import `Orchestrator` in-process
   for a Node caller on the same host. Both are governed identically.
   The allowlist names the verbs `ingest`, `feedback`, `forget-source`, `entries` and `reextract`;
   favorites (2026-10-21) add only the switches `--favorite` (feedback, ingest) and `--unfavorite`
   (feedback). The 2026-11-10 amendment adds exactly these argv forms (each value one argv element, sent only on one
   explicit operator action, item 6):
   - `approve-wisdom <entryId> [--note <text>] [--via <system>]`
   - `revoke-wisdom <entryId> [--note <text>] [--via <system>]`
   - `claim-resolve <claimId>` · `claim-resolve <claimId> --reject` · `claim-resolve <claimId> --replace-neighbor`
   - `claims-deferred --library <libraryId> [--limit <n>] [--offset <n>]`

   Each may be repeated after an unknown outcome (item 6, "Retries and unknown outcomes").

   No MCP tool exists for the three writes, deliberately: an operator action comes from a capture system's UI through
   the CLI, and the agent sessions on the host deny tools by MCP name. That keeps them out of the agents' tool lists; it
   does not stop a shell (item 6, "Who can run them").

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
