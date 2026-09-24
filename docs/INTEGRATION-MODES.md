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
2. **Register the archive root once.** `MIDMEM_SOURCE_ROOTS` **replaces** the default root list — set
   the full default list plus the archive root, never the archive root alone. Keep the archive
   outside every `bridgeSources` folder (or the bridge would auto-ingest it under that folder's
   scope) and, on this host, outside the Obsidian vault.
3. **Call ingest with the source's identity** so recall shows the chain back to the URL:
   ```
   midmem ingest <archive>/web/<id>/article.md --type web-article --authority web \
     --scope shared --project library \
     --source-uri <original url> --canonical-uri <canonical url> --library <libraryId> \
     --doc-id <docId> --capture-method url_fetch --captured-at <ISO> [--site --author --published-at --language]
   ```
   The values land in `provenance.source` (and on the sources row) and come back on every recall
   row. `--type` may be a capture-pack type (`web-knowledge` pack: `web-article`, `news`,
   `research-paper`, `technical-documentation`, `tutorial`, …), which sets the entry's type, memory
   function and lease; any other type stores a plain `ingest` entry in the memory tier.
4. **Text without a file:** `midmem ingest-content --source-uri <url> --stdin` (MCP `ingest_content`)
   materializes the text under `MIDMEM_CONTENT_INGEST_DIR` at a path keyed by the source identity and
   runs the same governed ingest — the same source always supersedes itself.
5. **Authority is `web` for anything external.** Never `--curated`: it labels the source
   operator-authored and grants protected recall slots (#39) and verbatim returns (#42).
6. **Never write memory for captures.** No `remember`, no `record_work`, no write to `state.db`.
   The only write is the ingest above; retrieval renews leases on its own.
7. **Reads.** Any consumer: `midmem query "<q>" --projects library` (MCP `query` with
   `projects: ["library"]`), or unfiltered when the caller has no project set. Rows carry
   `authority`, `provenance.source`, `fidelity`, `status` and the instruction-likeness flag (#40).
8. **Call shape.** Shell out to the `midmem` CLI through a durable queue with a frozen argv allowlist
   and a provider switch (mock in every test: zero `execFile`); or import `Orchestrator` in-process
   for a Node caller on the same host. Both are governed identically.

**Coming for this mode:** metadata filters on query (#48) and MidMem's Qdrant spin-up with a vector
backfill (#50, #51). None changes the contract above. **Shipped (#49): the library lane** — MidMem
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
| `MIDMEM_OCCUPANCY` / `…_CAP_STACK` `…_CAP_DOC` `…_CAP_WEB` `…_OPERATOR_SLOTS` `…_MIN_LINEAGES` | on / 0.6 / 0.6 / 0.25 / 2 / 2 | bounded-occupancy selection on budgeted reads (#39): per-authority caps that bind only against a waiting competitor, protected operator slots, lineage floor |
| `MIDMEM_INSTRUCTION_FLAG` / `MIDMEM_INSTRUCTION_PENALTY` | on / 0.01 | instruction-likeness flag on results (#40); flagged rows demoted + labelled, never dropped |
| `MIDMEM_FIDELITY` / `MIDMEM_VERBATIM_MAX_CHARS` | on / 4000 | fidelity class on results (#42); verbatim rows (operator / curated tier) uncut up to the ceiling |
| `MIDMEM_WORKING_TTL_MS` | 86400000 (24 h) | lease for `working`-function entries (#44); they never promote and are excluded from default reads |
| `MIDMEM_FORGET_CASCADE` | on | dependency-aware forget (#41): archive sourced claims, flag sole-support concepts |
| `MIDMEM_WORK_MEMORY` | on | enable work-memory event recording |
| `MIDMEM_AUTO_INGEST` / `…_ON_MAINTAIN` | on | auto-bridge agent session/memory dirs during `maintain()` |
| `MIDMEM_PROACTIVE_RECALL` | on | enable the pre-turn recall primitive |
| `MIDMEM_MAINTENANCE` | on | self-driving decay/promotion/projection (+ auto-ingest) |
