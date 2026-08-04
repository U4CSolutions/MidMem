/**
 * GraphStore — OmegaWiki-style typed knowledge graph, stored in state.db.
 * One graph representation (the scaffold had three). Used for query graph-context,
 * verification, and wikilink projection.
 */
import { genId, nowISO, sha12, json, canonicalConceptKey } from './util.mjs';

const EDGE_TYPES = new Set([
  'references', 'contradicts', 'supports', 'relates',
  // work-memory relations (task → source/artifact/concept/correction)
  'attempted', 'used_source', 'avoided', 'corrected_by', 'produced', 'decided', 'about',
  // concept canonicalization: a merged-away variant points at its canonical node
  'alias_of',
]);

/** Node types whose labels are concepts (canonicalized identity). Identifier-like types
 *  (task, source, artifact) keep exact lowercase identity — plural-folding a file path
 *  or task name would merge things that are genuinely distinct. */
export const CANON_NODE_TYPES = new Set(['concept', 'entity', 'topic', 'category']);

export class GraphStore {
  constructor(db) { this.db = db; }

  /** Identity key for a node label under its type's rules (shared with the dedupe pass). */
  static nodeKey(type, label) {
    return CANON_NODE_TYPES.has(type) ? canonicalConceptKey(label) : String(label).toLowerCase();
  }

  upsertNode({ type, label, properties = {}, source = '' }) {
    // Stable per (type, identity key) → trivial concept variants ("Inference Costs" /
    // "inference cost") land on ONE node; the display label stays as given. Nodes written
    // before canonicalization are folded in by the dedupe pass (forced/daily maintain).
    const id = `node-${sha12(`${type}:${GraphStore.nodeKey(type, label)}`)}`;
    const ts = nowISO();
    this.db.prepare(`
      INSERT INTO nodes(id,type,label,properties,source,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET label=excluded.label, properties=excluded.properties, updated_at=excluded.updated_at
    `).run(id, type, label, JSON.stringify(properties), source, ts, ts);
    return id;
  }

  /** Capture packs register additional edge vocabularies PER INSTANCE — a module-global set
   *  would leak one instance's packs into every other orchestrator in the process (tests run
   *  several) and silently loosen validation for packs-disabled instances. */
  allowEdgeTypes(types = []) { this.extraEdgeTypes ||= new Set(); for (const t of types) if (t && typeof t === 'string') this.extraEdgeTypes.add(t); }

  upsertEdge({ from, to, type, confidence = 1, properties = {}, source = '' }) {
    if (!EDGE_TYPES.has(type) && !this.extraEdgeTypes?.has(type)) type = 'relates';
    const id = `edge-${sha12(`${from}:${to}:${type}`)}`;
    this.db.prepare(`
      INSERT INTO edges(id,from_id,to_id,type,confidence,properties,source,created_at)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET confidence=excluded.confidence, properties=excluded.properties
    `).run(id, from, to, type, confidence, JSON.stringify(properties), source, nowISO());
    return id;
  }

  node(id) { const r = this.db.prepare('SELECT * FROM nodes WHERE id=?').get(id); return r ? this.#n(r) : null; }
  byType(type) { return this.db.prepare('SELECT * FROM nodes WHERE type=?').all(type).map((r) => this.#n(r)); }
  allNodes() { return this.db.prepare('SELECT * FROM nodes').all().map((r) => this.#n(r)); }

  neighbors(id) {
    return this.db.prepare('SELECT * FROM edges WHERE from_id=? OR to_id=?').all(id, id).map((r) => this.#e(r));
  }

  /** Whole graph for visualization/projection. */
  getGraph() {
    return {
      nodes: this.allNodes().map((n) => ({ id: n.id, label: n.label, type: n.type })),
      edges: this.db.prepare('SELECT from_id,to_id,type FROM edges').all()
        .map((e) => ({ from: e.from_id, to: e.to_id, type: e.type })),
    };
  }

  /** Nodes whose label matches a query token (graph-context for retrieval). */
  findByText(query) {
    const toks = (query.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length >= 3);
    if (!toks.length) return [];
    return this.allNodes().filter((n) => toks.some((t) => n.label.toLowerCase().includes(t)));
  }

  #n(r) { return { ...r, properties: json(r.properties, {}) }; }
  #e(r) { return { id: r.id, from: r.from_id, to: r.to_id, type: r.type, confidence: r.confidence, properties: json(r.properties, {}) }; }
}
