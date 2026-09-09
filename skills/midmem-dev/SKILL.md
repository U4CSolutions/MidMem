---
name: midmem-dev
description: >-
  Develop/iterate on the MidMem middleware core (this repo's `packages/core` — the shared "LLM Wiki"
  knowledge layer). Use when adding or changing MidMem capability — retrieval lanes, tiers/lifecycle,
  work-memory events, concept routing, claims, grounding, the MCP/CLI/hook surfaces, or its tests.
  Encodes the test→verify→commit→record loop and the load-bearing guardrails (pure-core, modular
  4 modes, smoke stays green, determinism + grounding, maintain re-entrancy). NOT for operating the
  store at runtime (that's `midmem-orchestrator`) — this is for changing the code.
---

# MidMem development loop

Repo: this checkout (own git). Node ESM, `node:sqlite`, **zero external deps**. Core: `packages/core/`.
Paths below are repo-relative; `<repo>` = the `midmem-kb-store` checkout root.

## The architecture you must preserve
- **Pure-core.** Everything lives in `packages/core/src` over one `state.db`, reached via exactly
  three surfaces: **CLI** `bin/cli.mjs`, **MCP** `bin/mcp-server.mjs`, **hook seam** `bin/hook.mjs`.
  No file in the core may reference OpenClaw, Hermes, Claude Code, or any host stack. This is what
  makes it run in **4 modes** (standalone · OpenClaw add-on · Hermes add-on · bridge); see
  `docs/INTEGRATION-MODES.md`.
- **`state.db` = source of truth; the Obsidian `LLM Wiki` = deterministic projection** (regenerable;
  never canonical, never hand-edited).
- **Determinism + grounding.** Categorization, work-events, community detection, contradiction
  detection are deterministic (no LLM). Ingest runs the DELEGATE-52 grounding check before persisting.
  Never bypass grounding; never use LLM self-review for grounding/promotion.

## Map of the core (where things go)
- `orchestrator.mjs` — the coordinator; every public op + governance + `#maybeMaintain`. Add new
  public methods here.
- `db.mjs` — schema (`entries`, `vectors`, `nodes`, `edges`, `claims`, `sources`, `log`, `audit`).
  Prefer using `entries.type` + `provenance` over new tables/columns.
- `memory.mjs` tiers/lifecycle · `retrieval.mjs` hybrid lanes + post-RRF boosts · `graph.mjs`
  nodes/edges (extend `EDGE_TYPES` for new relations) · `claims.mjs` · `workmemory.mjs` work events +
  categorization · `concepts.mjs` concept embeddings + communities · `grounding.mjs` · `config.mjs`
  (env-tunable knobs) · `index.mjs` (public exports).

## Adding a capability — the checklist
1. **Core logic** in the right module (or a new `src/<feature>.mjs`); keep it deterministic where it
   can be. Read the module first and match its idiom/comment density.
2. **Wire** an `Orchestrator` method → export in `index.mjs` → expose via **MCP tool** (`bin/mcp-server.mjs`)
   and **CLI command** (`bin/cli.mjs`). Add a config block (env-tunable) in `config.mjs` if it has knobs.
3. **Boosts go post-RRF** in `retrieval.mjs`, small (≈ trust/graph magnitude, ~0.004–0.01), additive.
4. **Anything that ingests inside `maintain()` must be re-entrancy-guarded** (`this._maintaining`) —
   the bridge→ingest→`#maybeMaintain`→maintain path recurses infinitely on a low `intervalMs`; the
   throttle alone is not safe. Heavy work (embedding) runs on **forced/daily maintain only**.
5. **Test it.** Add assertions to `packages/core/test/smoke.mjs` (offline, hermetic — pass
   `autoIngest:{enabled:false}` to test orchestrators so `maintain()` doesn't bridge real dirs).

## Test → verify → commit → record
```bash
cd <repo>
node packages/core/test/smoke.mjs        # MUST stay green (244/244 as of 2026-09-09)
node packages/core/test/bench.mjs        # Brain-style regression gate (recall/correction/dead-end/current/budget)
# live sanity (real shared db), keep the heavy bridge off:
printf '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n' | \
  MIDMEM_DB_PATH=<repo>/state.db MIDMEM_AUTO_INGEST=0 node packages/core/bin/mcp-server.mjs   # tools present
git add -A && git commit -m "feat(core): …"   # end with the active model's Co-Authored-By line
```
Then **record** (see `midmem-record`): a one-line
`midmem remember "<lesson>" --tier wisdom --curated --scope shared`, plus a changelog entry if your
project keeps one.

## If the store is exposed as a long-lived MCP server

Deployments often register `bin/mcp-server.mjs` with an agent harness (e.g. Claude Code) as a
long-lived stdio process. That wiring imposes discipline on core development:

- **Dev sessions use the CLI, not the running MCP instance** — a long-lived server keeps executing
  pre-edit code after you change the core. Verify via `bin/cli.mjs` / the smoke suite; reconnect or
  restart the MCP consumer after landing changes.
- **Wiring impact is part of every core change.** In the same commit/record: (1) tool
  added/renamed/schema changed → consumers must reconnect to see it; update any recorded tool-count
  facts. (2) new `MIDMEM_*` knob → decide its default for each registered instance, and keep env in
  ONE shared file sourced by all wrappers — duplicated env blocks drift. (3) scope/governance
  semantics changed → re-check each instance's scope and `MIDMEM_AUTO_INGEST` posture (the bridge
  should have exactly one owner). (4) `mcp-server.mjs` startup/protocol changed → pipe-test:
  `printf '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n' | <your mcp wrapper>`.

## Gotchas
- Build the work-event/categorize/community paths **deterministically** — the bench + smoke assume it.
- `midmem remember` text: no backticks / `$()` (shell substitution).
- node:sqlite quoting in one-liners is painful — write a temp `.mjs` with an **absolute** import path
  to `packages/core/src/index.mjs` instead of fighting `-e` quotes.
- Offline tests use deterministic fallback embeddings — don't assert semantic similarity in smoke;
  assert structure/flags. Semantic behavior is the bench's job (and is still lane-driven offline).
