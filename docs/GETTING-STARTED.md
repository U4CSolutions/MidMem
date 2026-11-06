# Getting started — standalone in five minutes

MidMem is a zero-dependency memory layer for LLM agents: one SQLite file of truth, a compiled
markdown wiki as its projection, reached through three surfaces (CLI · MCP · hook). This page gets
you from clone to first recall in standalone mode; wiring agents comes after
([INTEGRATION-MODES.md](INTEGRATION-MODES.md)).

## Prerequisites

- **Node ≥ 22.13** (uses `node:sqlite`; nothing to `npm install` — there are no dependencies)
- Optional: an OpenAI-compatible endpoint (LM Studio, Ollama, llama.cpp server) for real
  embeddings + extraction. **Without one, everything still works** — retrieval falls back to
  lexical (FTS5 token + trigram) and extraction to deterministic rules.

## 1. Clone and smoke-test

```bash
git clone https://github.com/U4CSolutions/MidMem midmem-kb-store && cd midmem-kb-store
npm run verify        # smoke suite + Brain-style bench + docs drift-check; no network needed
```

If `verify` passes, the core works on your machine. It never touches files outside the repo.

## 2. Point it at a database and (optionally) a model

The store is created on first use at `MIDMEM_DB_PATH`. Put your env in ONE file you can source
from every wrapper you create later (this discipline matters — duplicated env blocks drift):

```bash
# midmem-env.sh
export MIDMEM_DB_PATH="$HOME/midmem/state.db"
export MIDMEM_LLM_ENDPOINT="http://localhost:1234/v1"   # omit to run offline/lexical
export MIDMEM_EMBED_MODEL="bge-m3"                      # any embedding model your endpoint serves
export MIDMEM_EXTRACT_MODEL="qwen2.5-7b-instruct"       # small instruct model for ingest extraction
```

All knobs: [reference/CONFIG.md](reference/CONFIG.md).

## 3. First memory, first recall

```bash
alias midmem='source ./midmem-env.sh && node packages/core/bin/cli.mjs'

midmem remember "The staging database runs postgres 16 on the blue cluster" --type note
midmem query "what does staging run"
midmem brief          # store state across tiers
```

`query` runs the progressive hybrid pipeline: cheap lexical first, vector + concept routing only
when the sufficiency gate demands it. Results carry provenance, trust, and source authority.

## 4. First document ingest

```bash
midmem ingest ./docs/GETTING-STARTED.md --type note --title "Getting started"
```

Watch the result's **grounding report** — `summaryScore`, kept vs quarantined concepts/claims.
That's the DELEGATE-52 gate: LLM-extracted content that isn't actually supported by the source is
quarantined before it can persist. Never skip reading these numbers.

## 5. Project the wiki (optional)

```bash
export OBSIDIAN_VAULT_PATH="$HOME/vault"   # any folder; Obsidian is optional
midmem project
```

`<vault>/LLM Wiki/` now holds the compiled markdown projection. It is regenerable at any time —
**state.db is the truth; never hand-edit the wiki**.

## Where next

- **Concepts** (tiers, claims, scopes, authority, lifecycle): [CONCEPTS.md](CONCEPTS.md)
- **Wire an agent** (OpenClaw / Hermes / Claude Code / any MCP client):
  [INTEGRATION-MODES.md](INTEGRATION-MODES.md)
- **Day-2 operations** (maintenance, review queues, backups): [OPERATIONS.md](OPERATIONS.md)
- **Full surfaces**: [reference/MCP-TOOLS.md](reference/MCP-TOOLS.md) ·
  [reference/CLI.md](reference/CLI.md) · [reference/CONFIG.md](reference/CONFIG.md)
- **Equip Claude Code sessions** with the in-repo [skills library](../skills/)
