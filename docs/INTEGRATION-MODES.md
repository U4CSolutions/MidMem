# MidMem Integration Modes

MidMem is **pure core** (`packages/core`, Node ESM, zero deps, one `state.db`). Every capability —
hybrid retrieval, tiers/lifecycle, grounding, the concept graph, **work-memory events**, deterministic
**ingest categorization**, **proactive recall**, and **auto-ingest of agent work** — lives in the core
and is reached through three stable surfaces:

- **CLI** — `bin/cli.mjs` (`midmem …`)
- **MCP server** — `bin/mcp-server.mjs` (stdio JSON-RPC; 30 tools incl. `record_work`, `list_tasks`, `proactive_recall`, `forget_nodes`, `prospective_*`)
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
Automatic ingest: point `bridgeSources` at your notes dirs (or rely on `ingest`); `maintain`
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

- **Wiring:** register the MCP server for Claude Code as a consumer (`MIDMEM_AGENT_SCOPE=shared`, or a
  dedicated scope in a multi-stack deployment), or drive the `midmem` CLI directly.
- **Skills:** the [MidMem Skills Library](../skills/) (ships in-repo) equips it — `midmem-dev` (change
  the core), `midmem-orchestrator` + `midmem-ingest-review` (curate + QA), `midmem-record` (durable
  capture). These are portable, Claude-Code-only adaptations of the skills a live deployment runs.
- **Guaranteed capture:** a Claude Code `Stop`-hook can block a turn from ending until a recordable
  change is written to MidMem — the most reliable capture path in the stack. See
  [STACK-CAPTURE.md](STACK-CAPTURE.md).

---

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
| `MIDMEM_WORK_MEMORY` | on | enable work-memory event recording |
| `MIDMEM_AUTO_INGEST` / `…_ON_MAINTAIN` | on | auto-bridge agent session/memory dirs during `maintain()` |
| `MIDMEM_PROACTIVE_RECALL` | on | enable the pre-turn recall primitive |
| `MIDMEM_MAINTENANCE` | on | self-driving decay/promotion/projection (+ auto-ingest) |
