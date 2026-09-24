/**
 * Configuration for the rebuilt middleware core.
 *
 * Single source-of-truth lives in `state.db`; the Obsidian vault is a projection.
 * All paths/endpoints overridable via env so OpenClaw/Hermes can point at the
 * same db without code changes.
 */

import * as path from 'node:path';
import * as os from 'node:os';
import { normalizeProject } from './projectaxis.mjs';

const HOME = os.homedir();
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
/** Obsidian vault root. Local now; will repoint at the Unraid share later (env-only change).
 *  Layout: `<vault>/LLM Wiki` (projected from state.db) · `<vault>/OpenClaw` · `<vault>/Hermes`. */
const VAULT = process.env.OBSIDIAN_VAULT_PATH || path.join(HOME, 'Obsidian');

/** @typedef {'fact'|'memory'|'wisdom'} Tier */

/**
 * Tier model (Core-LLM-Wiki inspired): fact (raw) → memory (synthesized) → wisdom (curated).
 * TTL in ms (0 = never). `autoPromote` marks tiers whose aged entries are promotion
 * candidates. `curatedOnly` tiers are governance-gated (no uncurated writes).
 */
export const DEFAULT_TIERS = [
  { name: 'fact', description: 'Raw, unprocessed knowledge from sources', ttl: 7 * 864e5, autoPromote: true, curatedOnly: false },
  { name: 'memory', description: 'Synthesized knowledge with context', ttl: 30 * 864e5, autoPromote: true, curatedOnly: false },
  { name: 'wisdom', description: 'Curated, verified knowledge (future fine-tune training set)', ttl: 0, autoPromote: false, curatedOnly: true },
];

export function loadConfig(overrides = {}) {
  // Env reads honor the new MIDMEM_ prefix, falling back to legacy OCMW_ (safe rename).
  const env = (k) => process.env['MIDMEM_' + k] ?? process.env['OCMW_' + k];
  const dbPath = env('DB_PATH') || path.join(REPO, 'state.db');
  const cfg = {
    /** Single SQLite source-of-truth. */
    dbPath,
    /** Content ingest (roadmap #46): `ingestContent` materializes captured text (web pages, library
     *  documents) here as <sha12(source key)>.md before the ordinary governed ingest. Defaults to a
     *  sibling of the db; appended to sourceRoots below so the path policy admits it. */
    contentIngestDir: env('CONTENT_INGEST_DIR') || path.join(path.dirname(dbPath), 'ingest-content'),
    /** Obsidian vault root (LLM-owned wiki projected into the `wikiPath` subfolder). */
    vaultPath: VAULT,
    /** Wiki subdir inside the vault — the projected, LLM-owned knowledge base. */
    wikiPath: process.env.WIKI_PATH || 'LLM Wiki',
    /** Agent-owned vault folders (human-readable in Obsidian; also ingest source roots). */
    openclawPath: process.env.OPENCLAW_VAULT_DIR || 'OpenClaw',
    hermesPath: process.env.HERMES_VAULT_DIR || 'Hermes',
    /** Raw sources allowed for ingest (path-traversal guard in governance).
     *  Agents drop research into their vault folder; the router ingests it into the wiki.
     *  ~/changelog = frozen quarterly CHANGELOG archives (ingested once at archive time;
     *  the live root CHANGELOG.md stays QMD-only — too churny for one-summary-per-version). */
    sourceRoots: (env('SOURCE_ROOTS') ||
      [REPO, `${HOME}/.openclaw/workspace`, `${HOME}/.hermes/memories`, `${HOME}/changelog`, path.join(VAULT, 'OpenClaw'), path.join(VAULT, 'Hermes')].join(';')
    ).split(';').filter(Boolean),
    /** Native→middleware bridge: dirs scanned by `bridgeMemory`, each tagged with a scope (+ an
     *  optional project). Pulls each stack's memory into the shared, tiered, searchable store.
     *  Configurable (roadmap 2026-09 #38): MIDMEM_BRIDGE_SOURCES = `dir|scope|type|project;…`
     *  (type/project optional; a sixth field lists subfolders to skip, comma-separated) REPLACES the default list, so a third harness's memory dir or a
     *  console's report folders register without a core change. */
    bridgeSources: parseBridgeSources(env('BRIDGE_SOURCES')) || [
      { dir: path.join(HOME, '.openclaw', 'workspace', 'memory'), scope: 'openclaw', type: 'session' },
      { dir: path.join(HOME, '.hermes', 'memories'), scope: 'hermes', type: 'note' },
      ...agentVaultSources(path.join(VAULT, 'OpenClaw'), 'openclaw'),
      ...agentVaultSources(path.join(VAULT, 'Hermes'), 'hermes'),
    ],
    /** Bridge walk recurses into subfolders (skipping dot-dirs + node_modules); a per-source
     *  `recursive:false` opts out. MIDMEM_BRIDGE_RECURSIVE=0 restores the flat walk globally. */
    bridgeRecursive: env('BRIDGE_RECURSIVE') !== '0',
    /** LM Studio OpenAI-compatible endpoint (embeddings + extraction). */
    llmEndpoint: env('LLM_ENDPOINT') || 'http://localhost:1234/v1',
    embedModel: env('EMBED_MODEL') || 'nomic-embed-text',
    extractModel: env('EXTRACT_MODEL') || 'qwen/qwen3.6-35b-a3b',
    /** Allow network LLM calls; when false, deterministic offline fallbacks are used. */
    llmEnabled: env('LLM_ENABLED') !== '0',
    /** Per-call timeout for LLM (ms) — the local model can saturate; keep tight. */
    llmTimeoutMs: Number(env('LLM_TIMEOUT_MS') || 20000),
    /** Hybrid fusion: RRF constant + per-lane weights (fts token, trigram substring, vector). */
    rrfK: 60,
    fusionWeights: { fts: 1.0, trigram: 0.5, vector: 1.0 },
    /** Additive ranking boosts, kept small vs a single RRF rank (≈ 1/60 ≈ 0.0167). */
    trustWeight: 0.01, // × (trust_score − 0.5) → ±0.005
    graphBoost: 0.004, // × shared-concept count (capped at 3)
    /** P4 temporal/workflow boosts — fused after RRF like trust/graph. Recency + proven usefulness
     *  lift entries; corrections/decisions (work-memory) are boosted because they reshape behavior;
     *  dead-ends are DEMOTED and flagged (rank.deadEndWarning) so they surface as warnings, not
     *  primary evidence. All deterministic from the entry's own fields. enabled:false → no-op. */
    workflowBoost: {
      enabled: env('WORKFLOW_BOOST') !== '0',
      recency: 0.004, recencyHalfLifeDays: 30,
      usefulness: 0.002, // × min(retrieval_count, 5)
      correction: 0.01, decision: 0.006, deadEndPenalty: 0.008,
    },
    /** Fallback embedding dimension when offline. */
    fallbackDim: 256,
    /** Vector backend: 'sqlite' (in-DB JSON cosine, zero-dep, default) or 'qdrant' (external ANN). */
    vectorBackend: env('VECTOR_BACKEND') || 'sqlite',
    qdrantUrl: env('QDRANT_URL') || 'http://localhost:6333',
    qdrantCollection: env('QDRANT_COLLECTION') || 'midmem_memory',
    qdrantApiKey: env('QDRANT_API_KEY') || '',
    /** Tenant key (roadmap #51): this store writes it as payload `store_id` on every Qdrant point
     *  and filters every Qdrant search on it (keyword index created `is_tenant: true`). One memory
     *  collection may then hold several stores, each promoted to its own shard later without new
     *  collections. Collections split only by embedding space, workload and access boundary. */
    storeId: env('STORE_ID') || 'default',
    /** Qdrant client knobs: per-request timeout (ms) and points per upsert batch (backfill). */
    qdrant: { timeoutMs: Number(env('QDRANT_TIMEOUT_MS') ?? 5000), batch: Number(env('QDRANT_BATCH') ?? 100) },
    /** P5 concept routing: embed concept nodes + deterministic communities (built in forced/daily
     *  maintain), then the query vector seeds entries linked to its nearest concept communities into
     *  retrieval (+ a small boost). Fail-soft → flat hybrid when nothing is embedded. No per-query LLM. */
    conceptRouting: {
      enabled: env('CONCEPT_ROUTING') !== '0',
      topConcepts: 5, minSim: 0.1, boost: 0.005, maxEmbedPerPass: 60,
    },
    tiers: DEFAULT_TIERS,
    /** DELEGATE-52 safeguard: deterministically verify LLM-extracted concepts/claims appear in the
     *  source before they enter state.db (quarantine confabulated/drifted extractions). minOverlap =
     *  fraction of an item's content-words that must occur in the source. enabled:false → no-op. */
    grounding: {
      enabled: env('GROUNDING') !== '0',
      minOverlap: Number(env('GROUNDING_MIN_OVERLAP') || 0.5),
    },
    /** Phase 1 trigger-less recall: pre-turn hook calls `proactiveRecall(message)` which self-gates
     *  on `minScore` and caps injection at `maxTokens`. minScore is conservative by default (skip
     *  unless a real match); it's the seam for later feedback-driven self-tuning. */
    proactiveRecall: {
      enabled: env('PROACTIVE_RECALL') !== '0',
      minScore: Number(env('RECALL_MIN_SCORE') || 0.02),
      maxTokens: Number(env('RECALL_MAX_TOKENS') || 600),
      maxItems: Number(env('RECALL_MAX_ITEMS') || 4),
      /** Library lane (#49) in pre-turn recall: OFF by default — a pre-turn recall runs on every
       *  message and would otherwise call every registered provider each time. Explicit `query` and
       *  `handoff_brief` ask libraries by default; set MIDMEM_RECALL_LIBRARIES=1 (or pass
       *  `libraries`) to include library evidence here too. Library rows are gated on the provider's
       *  own score (libraryMinScore), not on the RRF score, which by construction sits below minScore. */
      libraries: env('RECALL_LIBRARIES') === '1',
      libraryMinScore: Number(env('RECALL_LIBRARY_MIN_SCORE') ?? 0.2),
    },
    /** Self-driving lifecycle (decay + promotion) — runs opportunistically on normal use
     *  (query/ingest/remember), throttled by intervalMs, plus an external daily timer.
     *  Decay: expired leases archived; retrieval renews an entry's lease (decay-by-disuse);
     *  repeatedly-unhelpful entries (trust < distrustBelow) archived. Promotion: fact→memory
     *  on usage alone; memory→wisdom only when EARNED via explicit helpful feedback (that
     *  feedback is the curation signal — the curated-only gate stays meaningful). */
    maintenance: {
      enabled: env('MAINTENANCE') !== '0',
      intervalMs: Number(env('MAINT_INTERVAL_MS') || 3600e3), // lazy sweep ≤ 1/hour
      refreshOnAccess: true, // retrieval extends expires_at by the tier's TTL
      distrustBelow: 0.2, // archive non-permanent entries the feedback loop has buried
      factPromote: { minRetrievals: 3, minTrust: 0.6 }, // fact→memory: proven useful by use
      wisdomPromote: { minRetrievals: 5, minTrust: 0.7, minHelpful: 2 }, // memory→wisdom: earned curation
      /** Bounded history: forced/daily maintain prunes log/audit rows older than this and
       *  vectors orphaned by hard-deleted entries. 0 disables pruning. */
      retentionDays: Number(env('RETENTION_DAYS') || 90),
    },
    /** Work-memory (Perplexity-Brain-style "memory about work"): record agent task attempts,
     *  sources used, dead ends, corrections, artifacts, decisions as first-class entries + graph
     *  edges, and deterministically categorize every ingest. Pure-core; works in all 4 modes. */
    /** Revision export (roadmap #7): deterministic JSONL snapshot of the knowledge tables
     *  (no vectors/log/audit), stable bytes for an unchanged store — commit it to give the
     *  knowledge product git history. Refreshed by forced/daily maintain. */
    export: {
      enabled: env('EXPORT_ENABLED') !== '0',
      path: env('EXPORT_PATH') || path.join(REPO, 'snapshots', 'state-export.jsonl'),
    },
    /** Capture packs (roadmap #5): domain extensibility as data — JSON packs registering entry
     *  types (tier + function + edge), categorizer rules and edge vocabularies. Builtin dir ships
     *  with the repo; extra packs via MIDMEM_CAPTURE_PACKS (';'-separated file paths). */
    capturePacks: {
      enabled: env('CAPTURE_PACKS_ENABLED') !== '0',
      builtinDir: env('CAPTURE_PACKS_DIR') || path.join(REPO, 'config', 'packs'),
      paths: (env('CAPTURE_PACKS') || '').split(';').filter(Boolean),
    },
    /** Projection QA (WiCER-style, arXiv 2605.07068): deterministic probes over the compiled
     *  wiki on the forced/daily maintain — completeness (every active entry has its page) +
     *  sampled fidelity (page actually contains the entry's content). Report-only. */
    projectionQA: {
      enabled: env('PROJECTION_QA') !== '0',
      sampleSize: Number(env('PROJECTION_QA_SAMPLE') ?? 20),
      minFidelity: Number(env('PROJECTION_QA_MIN_FIDELITY') ?? 0.9),
      /** PMMC expected-query probes (roadmap #15): compiled + verified on forced/daily maintain. */
      queryProbes: env('QUERY_PROBES') !== '0',
      queryProbeSample: Number(env('QUERY_PROBE_SAMPLE') ?? 12),
      queryProbeTopK: Number(env('QUERY_PROBE_TOPK') ?? 5),
    },
    /** Transition verifier (TRUSTMEM-style, arXiv 2606.25161): deterministic checks on memory
     *  TRANSITIONS — supersede stays on-subject + evidence-covered; promotion requires the
     *  write-time grounding floor. Receipts always audit; deny is the default. */
    transitions: {
      enabled: env('TRANSITION_VERIFY') !== '0',
      deny: env('TRANSITION_DENY') !== '0',
      minSubjectOverlap: Number(env('TRANSITION_MIN_SUBJECT') ?? 0.15),
      minCoverage: Number(env('TRANSITION_MIN_COVERAGE') ?? 0.6),
      promoteMinGrounding: Number(env('PROMOTE_MIN_GROUNDING') ?? 0.3),
    },
    /** Global consistency pass (roadmap #13, arXiv 2608.03137): state-level verification on the
     *  forced/daily maintain — cross-claim contradictions, dangling supersede chains, deferred
     *  aging. Report-only; findings logged, never auto-fixed. */
    consistency: { enabled: env('CONSISTENCY') !== '0' },
    /** Progressive retrieval (roadmap #11, arXiv 2608.01285): cheap lexical-only pass first,
     *  expand to full hybrid (embed + vector + concept routing) only when the deterministic
     *  sufficiency gate fails. deep:true on a query always forces the full pipeline. */
    progressive: {
      enabled: env('PROGRESSIVE') !== '0',
      minHits: Number(env('PROGRESSIVE_MIN_HITS') || 1),
      minCoverage: Number(env('PROGRESSIVE_MIN_COVERAGE') ?? 0.6),
    },
    /** Library lane (roadmap #49): registered external library systems, asked for evidence at
     *  the DEEP stage of retrieval only (never the cheap lexical pass). MIDMEM_LIBRARIES =
     *  `id|module:<abs path to an ES module>;id2|http:<base url>`. Default empty: no provider is
     *  loaded or called and retrieval is unchanged. A library is a separate system — MidMem never
     *  stores its rows, never tiers, trusts, promotes, decays or renews them. */
    libraries: parseLibraries(env('LIBRARIES')),
    /** Library lane knobs: rows fused as their own RRF lane (weight × 1/(rrfK + rank)), at most
     *  `limit` per query across providers, each provider call bounded by `timeoutMs`; never stored. */
    library: {
      enabled: env('LIBRARY_LANE') !== '0',
      limit: Number(env('LIBRARY_LIMIT') ?? 8),
      timeoutMs: Number(env('LIBRARY_TIMEOUT_MS') ?? 4000),
      weight: Number(env('LIBRARY_WEIGHT') ?? 0.8),
    },
    /** Source authority (roadmap #10, arXiv 2607.29167): origin-assigned trust level
     *  (operator|stack|doc|web) that propagates through derived entries/claims and can never be
     *  raised by consolidation ('operator' requires curated:true — governance-gated). Retrieval
     *  gets a small post-RRF nudge (±rank·boost around 'doc') and a minAuthority filter. */
    authority: {
      enabled: env('AUTHORITY') !== '0',
      boost: Number(env('AUTHORITY_BOOST') ?? 0.002), // × (rank − doc) → operator +0.004 … web −0.002
    },
    /** TARL deferred ledger (roadmap #9, arXiv 2608.03699): a claim arriving with a write-path
     *  contradiction lands status 'deferred' (pending judgment) instead of 'active' — the third
     *  ledger state between kept and quarantined. Resolution (accept|reject) is always explicit. */
    claims: {
      deferContradictory: env('DEFER_CONTRADICTORY') !== '0',
      /** Consistency pass (roadmap #13) flags deferred claims older than this. */
      deferAgeDays: Number(env('DEFER_AGE_DAYS') || 14),
    },
    workMemory: {
      enabled: env('WORK_MEMORY') !== '0',
      /** Skip minting a task node when the label is a bare machine identifier (session UUID,
       *  timestamped file id, hex digest). The event is still recorded; only the unactionable
       *  graph node is suppressed. Set MIDMEM_GUARD_OPAQUE_TASK_LABELS=0 to record them anyway. */
      guardOpaqueTaskLabels: env('GUARD_OPAQUE_TASK_LABELS') !== '0',
    },
    /** Automatic ingest of agent work + knowledge. When `onMaintain`, the maintenance pass also
     *  runs the (idempotent, hash-deduped) bridge — pulling each stack's session/memory dirs into
     *  the store so ongoing requests are tracked without anyone remembering to ingest. Deterministic. */
    autoIngest: {
      enabled: env('AUTO_INGEST') !== '0',
      onMaintain: env('AUTO_INGEST_ON_MAINTAIN') !== '0',
    },
    /** Recall policy (roadmap 2026-09 #39/#40/#42): what a budgeted recall may return. */
    recall: {
      /** #39 bounded occupancy — applies when a query carries maxTokens (briefs, proactive recall)
       *  or `bounded:true`. Caps are fractions of the row limit per authority class and bind only
       *  while a competitor from another class is waiting; operator lines get protected slots;
       *  selection keeps at least minLineages distinct root sources when candidates allow. */
      occupancy: {
        enabled: env('OCCUPANCY') !== '0',
        caps: { operator: 1, stack: Number(env('OCCUPANCY_CAP_STACK') ?? 0.6), doc: Number(env('OCCUPANCY_CAP_DOC') ?? 0.6), web: Number(env('OCCUPANCY_CAP_WEB') ?? 0.25) },
        protectedOperatorSlots: Number(env('OCCUPANCY_OPERATOR_SLOTS') ?? 2),
        minLineages: Number(env('OCCUPANCY_MIN_LINEAGES') ?? 2),
      },
      /** #40 instruction-likeness — deterministic injection-shape flag; flagged rows are demoted
       *  by `penalty` (same magnitude family as the dead-end penalty) and labelled, never dropped. */
      instructionLike: { enabled: env('INSTRUCTION_FLAG') !== '0', penalty: Number(env('INSTRUCTION_PENALTY') ?? 0.01) },
      /** #42 fidelity class — verbatim rows (operator authority / curated tier) return full content
       *  up to verbatimMaxChars (a safety ceiling, flagged `truncated` when hit). */
      fidelity: { enabled: env('FIDELITY') !== '0', verbatimMaxChars: Number(env('VERBATIM_MAX_CHARS') ?? 4000) },
    },
    /** Lifecycle class (roadmap 2026-09 #44): `working` entries are context-assembly state —
     *  lease-bound to workingTtlMs regardless of tier, never promoted, excluded from default reads. */
    lifecycle: { workingTtlMs: Number(env('WORKING_TTL_MS') || 24 * 3600e3) },
    /** Dependency-aware forget (roadmap 2026-09 #41): forgetting an entry archives the claims it
     *  sourced and flags concept nodes it alone supported (report-only flags). */
    forget: { cascade: env('FORGET_CASCADE') !== '0' },
    /** Default memory scope for this process: `openclaw` | `hermes` | `shared`.
     *  Set per MCP registration (OCMW_AGENT_SCOPE). Writes default here; reads = this + shared.
     *  `shared` = admin/bridge context (may write any scope). */
    agentScope: env('AGENT_SCOPE') || 'shared',
    /** Project axis (roadmap 2026-09 #18), orthogonal to scope. MIDMEM_PROJECT = this process's
     *  default project slug: writes (remember/ingest/record_work/…) tag it, reads default to
     *  project + global. Unset = global writes, unfiltered reads (the admin/bridge analog). */
    project: normalizeProject(env('PROJECT')),
    projectAxis: {
      /** Promotion into a curated-only tier (wisdom) lifts a project entry to global —
       *  cross-project lessons emerge from use. MIDMEM_PROJECT_LIFT=0 keeps the tag on promotion. */
      liftOnCurated: env('PROJECT_LIFT') !== '0',
    },
    /** Governance: deny on policy-eval error (fail-closed). */
    failClosed: true,
  };
  const out = { ...cfg, ...overrides };
  // An overridden dbPath (tests, embedded hosts) moves the default content dir with it.
  if (overrides.dbPath && !overrides.contentIngestDir && !env('CONTENT_INGEST_DIR')) out.contentIngestDir = path.join(path.dirname(out.dbPath), 'ingest-content');
  // Content ingest materializes to a governed root: appending the dir here (rather than bypassing
  // the ingest-path-allowed policy for content) keeps the path policy fail-closed for every
  // other path, whatever sourceRoots were configured or overridden.
  if (out.contentIngestDir && !out.sourceRoots.includes(out.contentIngestDir)) out.sourceRoots = [...out.sourceRoots, out.contentIngestDir];
  return out;
}

/**
 * Deliverable subfolders of an agent's vault folder (2026-09-23). Documents an agent writes FOR the
 * operator — research write-ups and reports — are shared knowledge: each stack must be able to read
 * the other's. Everything else under the agent's folder (notes/, the root, any subfolder added later)
 * stays private to that stack by default, because notes can be personal.
 */
export const DELIVERABLE_DIRS = Object.freeze(['research', 'reports']);

/** Bridge sources for one agent vault folder: the folder itself (private scope, deliverable
 *  subfolders excluded) plus each deliverable subfolder as its own `shared` source. */
export function agentVaultSources(dir, scope, type = 'note') {
  return [
    { dir, scope, type, exclude: [...DELIVERABLE_DIRS] },
    ...DELIVERABLE_DIRS.map((d) => ({ dir: path.join(dir, d), scope: 'shared', type })),
  ];
}

/**
 * Parse MIDMEM_BRIDGE_SOURCES: entries separated by `;`, fields by `|` — `dir|scope|type|project`.
 * `~` expands to $HOME; type defaults to `note`; project omitted = global. Returns null when unset
 * (so the built-in defaults apply); a malformed entry throws — misconfigured capture must be loud.
 */
export function parseBridgeSources(spec) {
  if (!spec || !String(spec).trim()) return null;
  const out = [];
  for (const raw of String(spec).split(';')) {
    const item = raw.trim();
    if (!item) continue;
    const [dir, scope, type, project, recursive, exclude] = item.split('|').map((f) => f.trim());
    if (!dir || !scope) throw new Error(`bad MIDMEM_BRIDGE_SOURCES entry '${item}' (expected dir|scope[|type[|project[|recursive[|exclude,…]]]])`);
    const src = { dir: dir.startsWith('~/') ? path.join(HOME, dir.slice(2)) : dir, scope, type: type || 'note' };
    if (project) src.project = normalizeProject(project);
    if (recursive === '0' || recursive === 'false') src.recursive = false;
    if (exclude) src.exclude = exclude.split(',').map((e) => e.trim()).filter(Boolean);
    out.push(src);
  }
  return out.length ? out : null;
}

/**
 * Parse MIDMEM_LIBRARIES (roadmap #49): entries separated by `;`, fields by `|` —
 * `id|module:<abs path to an ES module>` or `id|http:<base url>`. `~/` expands to $HOME for module
 * paths. Returns [] when unset; a malformed entry throws — a misregistered library must be loud.
 */
export function parseLibraries(spec) {
  if (!spec || !String(spec).trim()) return [];
  const out = [];
  for (const raw of String(spec).split(';')) {
    const item = raw.trim();
    if (!item) continue;
    const bad = () => new Error(`bad MIDMEM_LIBRARIES entry '${item}' (expected id|module:<path> or id|http:<url>)`);
    const fields = item.split('|').map((f) => f.trim());
    if (fields.length !== 2) throw bad();
    const [id, where] = fields;
    const m = /^(module|http):(.+)$/.exec(where || '');
    if (!id || !m) throw bad();
    const transport = m[1];
    let target = m[2].trim();
    if (!target) throw bad();
    if (transport === 'module' && target.startsWith('~/')) target = path.join(HOME, target.slice(2));
    out.push({ id, transport, target });
  }
  return out;
}

export const REPO_ROOT = REPO;
