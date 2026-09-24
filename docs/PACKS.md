# Capture packs — authoring guide

A capture pack is a JSON file that teaches MidMem a domain **as data, not code**: entry types
(each with a tier, a memory function, an optional graph edge and an optional lease), categorizer
rules, and an edge vocabulary. The core never learns domain names, so the same build serves coding
patterns, captured web knowledge, runbooks or lab notebooks in all four deployment modes
(see [`INTEGRATION-MODES.md`](INTEGRATION-MODES.md)). Ship your domain as a pack, not a patch.

Loader: `packages/core/src/packs.mjs` (`loadPacks`). Surfaces: `list_packs` / `record_pattern`
(MCP), `ocmw packs` / `ocmw pattern` / `ocmw ingest --type` (CLI).

## Where packs live

| Source | Setting | Notes |
|---|---|---|
| Builtin dir | `MIDMEM_CAPTURE_PACKS_DIR` (default `config/packs/` in the repo) | every `*.json`, loaded in filename order |
| Extra files | `MIDMEM_CAPTURE_PACKS` | `;`-separated file paths, loaded after the builtin dir in the order given |
| Kill switch | `MIDMEM_CAPTURE_PACKS_ENABLED=0` | no packs at all |

Packs load when the orchestrator is constructed; the same config always yields the same type, rule
and edge universe (deterministic). Changing a pack takes effect on the next process start (for a
long-lived MCP server, reconnect it).

## The JSON shape

```json
{
  "name": "web-knowledge",
  "version": 1,
  "description": "What this pack captures and why.",
  "entryTypes": {
    "news": { "tier": "memory", "function": "semantic", "edge": "captured_from", "fields": ["source", "summary"], "ttlDays": 45 }
  },
  "categorizerRules": [
    ["news", "\\bbreaking\\b|\\breuters\\b|\\bnews\\b"]
  ],
  "edgeTypes": ["captured_from"]
}
```

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Pack identity. A file without it is skipped with an error. Also the key of the version ledger. |
| `version` | no (default `1`) | Any JSON value; a change is ledgered as a migration (see below). Bump it whenever the pack's types, rules or leases change. |
| `description` | no | Human text. |
| `entryTypes` | no | Map of type name → definition (below). |
| `categorizerRules` | no | `[category, regex]` pairs, tested case-insensitively against an ingest's title + summary; **pack rules run before the core rules** and the first match wins across all packs in load order. |
| `edgeTypes` | no | Edge types this pack adds to the graph vocabulary. An edge type the graph does not know degrades to `relates`. |

Entry type definition:

| Field | Default | Meaning |
|---|---|---|
| `tier` | `memory` | Tier the entry lands in (`fact` / `memory` / `wisdom` in the default config). |
| `function` | `procedural` | Memory function: `working` / `episodic` / `semantic` / `procedural` / `prospective`. |
| `edge` | none | Edge type `record_pattern` uses to link the pattern node to each evidence node (falls back to `references`). Should be declared in `edgeTypes` — an undeclared edge is reported as an error (the type still loads). |
| `fields` | `[]` | Declarative: which structured fields the type is meant to carry. The content composer itself uses the fixed `record_pattern` argument set. |
| `ttlDays` | none | Pack-declared lease (#47): a finite number > 0. The entry's lease is `now + ttlDays` instead of the tier TTL — at first lease and at every retrieval renewal. |

### Reserved type names

A pack may not register the core types: the work-event kinds `task_attempt`, `source_used`,
`dead_end`, `correction`, `artifact`, `decision`, plus `ingest`, `session`, `note`, `insight`,
`prospective`. A type name already registered by an earlier pack is also refused (first pack wins).

## Validation — a bad pack is reported, never fatal

The loader never throws. Every problem is collected into `errors` (returned by `list_packs`) and the
offending part is skipped; the rest of the pack, and every other pack, still loads.

| Error | Effect |
|---|---|
| `<file>: pack has no name` / `<file>: <JSON parse error>` | whole file skipped |
| `<pack>: type '<t>' is reserved` | type skipped |
| `<pack>: type '<t>' already registered by pack '<other>'` | type skipped |
| `<pack>: type '<t>' has unknown function '<fn>'` | type skipped |
| `<pack>: type '<t>' has invalid ttlDays` | type skipped |
| `<pack>: type '<t>' cannot set ttlDays on curated-only tier '<tier>'` | type skipped |
| `<pack>: type '<t>' uses edge '<e>' not declared in edgeTypes` | reported; type still loads |
| `<pack>: bad rule regex for '<category>'` | that rule skipped |

## How entries use a pack type

**Ingest** (`ingest --type <packType>`, MCP `ingest { type }`, `ingest_content { type }`; #46/#47).
A pack-registered type stores **as that type**, in the pack's tier, with the pack's memory function
and — when the type declares `ttlDays` — the pack's lease. Any other type stays a plain `ingest`
entry in the memory tier with the tier TTL. A pack type aimed at a curated-only tier requires
`curated: true`, checked before any write. Authority is never set by a pack: it comes from the caller
(`web` for `ingest_content`, `doc` for a plain ingest, `operator` when curated).

**record_pattern** (`ocmw pattern`, MCP `record_pattern`). Composes the entry content
deterministically from `title`, `context`, `problem`, `solution`, `outcome` and `evidence` (stable
section order), stores it through the governed `storeMemory` path with the pack's tier, function
and lease, then writes the graph: a node typed after the entry type, an edge of the pack's `edge`
type to a `source` node per evidence item, and an `about` edge to each concept.

**Categorization.** The pack's `categorizerRules` tag the provenance `category` of every ingest
(whatever its type) — a tag for tracking requests by kind, not a type change.

## Leases (`ttlDays`, #47)

- `ttlDays` is the entry's lease for its **first** lease **and every retrieval renewal**: a recalled
  `research-paper` is renewed to `now + 180 days`, not to the tier TTL. Promotion into another tier
  applies that tier's TTL (a promoted entry takes its destination tier's lease, and a promotion into a
  permanent tier stays permanent on later recalls).
- `ttlDays` is refused on a curated-only tier (`wisdom`): **permanence is earned by promotion, never
  declared by a pack.**
- A `working`-function entry is still capped by the working TTL (the shorter of the two wins).

## Version ledger (#22)

Each time an orchestrator is constructed it compares every loaded pack's `version` with the value
held in the `meta` table under `pack_version:<name>`:

| State | Action |
|---|---|
| no stored value | store it, log op `pack-registered { pack, version }` |
| stored value differs | store the new one, log op `pack-migrated { pack, from, to }` |
| equal | nothing |

The ledger records ontology evolution; it does not rewrite existing entries (their type, tier and
lease stay as stored).

## Rules that keep packs data, not code

1. Packs **add** types, rules and edges; they cannot redefine core types or core edges.
2. No pack can make knowledge permanent: curated-only tiers need explicit curation on every write,
   and `ttlDays` is refused there. Promotion stays usage-earned.
3. No pack sets authority, and no pack runs code — regexes and declarations only.
4. The core never branches on a pack or type name; everything a pack changes flows through the
   generic type → `{ tier, function, edge, ttlDays }` lookup.

## Reference packs

| Pack | Status | What it shows |
|---|---|---|
| [`coding-patterns`](../config/packs/coding-patterns.json) | shipped | procedural types (`pattern`, `scaffold`, `anti-pattern`, `recipe`) with typed evidence edges; tier TTL leases |
| [`web-knowledge`](../config/packs/web-knowledge.json) | shipped (#47) | ten captured-knowledge kinds (`web-article`, `news`, `blog`, `analysis`, `research-paper`, `reference`, `technical-documentation`, `tutorial`, `forum-thread`, `github-project`), each leased per kind (45–180 days), `captured_from` edges, six categorizer rules |
| `procedures` | specified, not built | ROADMAP-2026-09 #22: type `procedure` (memory / procedural; fields condition · guidance · pitfalls), edges `precedes` · `requires` · `alternative_to` · `pitfall_of`; needs a `record_pattern` relations seam |

Checking a pack: `ocmw packs` / MCP `list_packs` returns the loaded packs (name, version, types) and every
load error; an empty `errors` array is the pass condition.
