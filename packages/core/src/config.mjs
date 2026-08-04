/**
 * Configuration for the rebuilt middleware core.
 *
 * Single source-of-truth lives in `state.db`; the Obsidian vault is a projection.
 * All paths/endpoints overridable via env so OpenClaw/Hermes can point at the
 * same db without code changes.
 */

import * as path from 'node:path';
import * as os from 'node:os';

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
  const cfg = {
    /** Single SQLite source-of-truth. */
    dbPath: env('DB_PATH') || path.join(REPO, 'state.db'),
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
    /** Native→middleware bridge: dirs scanned by `bridgeMemory`, each tagged with a scope.
     *  Pulls each stack's flat memory into the shared, tiered, searchable store. */
    bridgeSources: [
      { dir: path.join(HOME, '.openclaw', 'workspace', 'memory'), scope: 'openclaw', type: 'session' },
      { dir: path.join(HOME, '.hermes', 'memories'), scope: 'hermes', type: 'note' },
      { dir: path.join(VAULT, 'OpenClaw'), scope: 'openclaw', type: 'note' },
      { dir: path.join(VAULT, 'Hermes'), scope: 'hermes', type: 'note' },
    ],
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
    qdrantCollection: env('QDRANT_COLLECTION') || 'openduck_memory',
    qdrantApiKey: env('QDRANT_API_KEY') || '',
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
    /** Default memory scope for this process: `openclaw` | `hermes` | `shared`.
     *  Set per MCP registration (OCMW_AGENT_SCOPE). Writes default here; reads = this + shared.
     *  `shared` = admin/bridge context (may write any scope). */
    agentScope: env('AGENT_SCOPE') || 'shared',
    /** Governance: deny on policy-eval error (fail-closed). */
    failClosed: true,
  };
  return { ...cfg, ...overrides };
}

export const REPO_ROOT = REPO;
