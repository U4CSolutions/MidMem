/**
 * Concept routing (Phase 2 / P5) — concept-node embeddings + deterministic community detection.
 *
 * Graph build (in maintain, daily/forced only — keeps the hot path cheap):
 *   - embed each concept node from a digest (label + a few linked entries), stored in node.properties;
 *   - assign communities by deterministic label propagation over the edge graph.
 * Retrieval (hot path, fail-soft): the query vector finds the nearest concept nodes; entries linked
 * to those concepts and their communities are SEEDED into the candidate pool + lightly boosted.
 * If nothing is embedded yet, it returns an empty set → retrieval falls back to flat hybrid.
 *
 * No external deps, no per-query LLM traversal (the memo's caution): routing is pure vector + graph.
 */
import { cosine, sha12, nowISO, json, canonicalConceptKey } from './util.mjs';
import { GraphStore, CANON_NODE_TYPES } from './graph.mjs';

/** Build a deterministic digest for a node: its label + up to N linked entries' content. */
function nodeDigest(db, node, maxEntries = 3) {
  const rows = db.prepare("SELECT content FROM entries WHERE status='active' AND concepts LIKE ? ORDER BY rowid DESC LIMIT ?")
    .all(`%${node.label}%`, maxEntries);
  return [node.label, ...rows.map((r) => r.content.slice(0, 200))].join(' \n ');
}

/** Deterministic label propagation: each node adopts the most common community among neighbors,
 *  ties broken by smallest community id, nodes processed in sorted id order. Persists to properties. */
function detectCommunities(o, rounds = 5) {
  // Community (hierarchy) nodes are OUTPUT of this pass, never input — including them in
  // propagation would feed the previous round's hierarchy back into itself.
  const nodes = o.graph.allNodes().filter((n) => n.type !== 'community').sort((a, b) => a.id.localeCompare(b.id));
  const comm = new Map(nodes.map((n) => [n.id, n.id]));
  const adj = new Map(nodes.map((n) => [n.id, []]));
  for (const e of o.db.prepare('SELECT from_id,to_id FROM edges').all()) {
    if (adj.has(e.from_id)) adj.get(e.from_id).push(e.to_id);
    if (adj.has(e.to_id)) adj.get(e.to_id).push(e.from_id);
  }
  for (let r = 0; r < rounds; r++) {
    let changed = false;
    for (const n of nodes) {
      const counts = new Map();
      for (const nb of adj.get(n.id)) { const c = comm.get(nb); if (c) counts.set(c, (counts.get(c) || 0) + 1); }
      if (!counts.size) continue;
      const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      if (best !== comm.get(n.id)) { comm.set(n.id, best); changed = true; }
    }
    if (!changed) break;
  }
  for (const n of nodes) o.db.prepare('UPDATE nodes SET properties=? WHERE id=?')
    .run(JSON.stringify({ ...n.properties, community: comm.get(n.id) }), n.id);

  // HiGram hierarchy (roadmap #12): materialize each multi-member community as a parent node
  // with `member_of` edges from its members — coarse-to-fine structure over the flat concept
  // graph. Deterministic: the community id IS a member node id (label propagation converges to
  // ids), so the parent is named after that root member. Stale parents from earlier passes are
  // pruned (their edges cascade), keeping repeated passes idempotent.
  const byComm = new Map();
  for (const [nid, c] of comm) { if (!byComm.has(c)) byComm.set(c, []); byComm.get(c).push(nid); }
  const labelOf = new Map(nodes.map((n) => [n.id, n.label]));
  const wanted = new Set();
  let parents = 0;
  for (const [c, members] of [...byComm.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (members.length < 2) continue;
    const rootLabel = labelOf.get(c) || c;
    const pid = o.graph.upsertNode({ type: 'community', label: `community:${rootLabel}`, source: 'community-detect', properties: { root: c, size: members.length } });
    wanted.add(pid);
    parents++;
    for (const m of members.sort()) o.graph.upsertEdge({ from: m, to: pid, type: 'member_of', source: 'community-detect' });
  }
  for (const stale of o.graph.byType('community')) if (!wanted.has(stale.id)) o.graph.deleteNode(stale.id);
  return { count: new Set(comm.values()).size, parents };
}

/**
 * Fold node `fromId` into node `toId`: re-point every edge (recomputing edge identity via
 * upsertEdge), union the variant label into the target's `aliases`, and delete the variant
 * row. Deterministic; shared by the dedupe pass and the curated merge.
 */
function foldNode(o, fromId, toId) {
  const from = o.graph.node(fromId);
  const to = o.graph.node(toId);
  if (!from || !to || fromId === toId) return false;
  for (const e of o.graph.neighbors(fromId)) {
    const nf = e.from === fromId ? toId : e.from;
    const nt = e.to === fromId ? toId : e.to;
    if (nf !== nt) o.graph.upsertEdge({ from: nf, to: nt, type: e.type, confidence: e.confidence, properties: e.properties, source: 'concept-merge' });
    o.db.prepare('DELETE FROM edges WHERE id=?').run(e.id);
  }
  const aliases = new Set([...(to.properties?.aliases || []), ...(from.properties?.aliases || [])]);
  if (from.label !== to.label) aliases.add(from.label);
  o.db.prepare('UPDATE nodes SET properties=?, updated_at=? WHERE id=?')
    .run(JSON.stringify({ ...to.properties, aliases: [...aliases].sort() }), nowISO(), toId);
  o.db.prepare('DELETE FROM nodes WHERE id=?').run(fromId);
  return true;
}

/**
 * Canonicalization sweep: fold every concept-like node whose id predates (or disagrees with)
 * the canonical identity key into its canonical node. Runs on the forced/daily maintain pass
 * only — it can rewrite many edges. Idempotent: a second pass is a no-op.
 */
export function dedupeConceptNodes(o) {
  const merged = [];
  // Sorted for determinism; only concept-like types — identifier-like labels are exempt.
  const nodes = o.graph.allNodes().filter((n) => CANON_NODE_TYPES.has(n.type)).sort((a, b) => a.id.localeCompare(b.id));
  for (const n of nodes) {
    const canonId = `node-${sha12(`${n.type}:${GraphStore.nodeKey(n.type, n.label)}`)}`;
    if (n.id === canonId) continue;
    if (!o.graph.node(canonId)) {
      // No canonical row yet — re-key this node in place (keeps label/properties/edges' content).
      o.db.prepare('UPDATE nodes SET id=? WHERE id=?').run(canonId, n.id);
      o.db.prepare('UPDATE edges SET from_id=? WHERE from_id=?').run(canonId, n.id);
      o.db.prepare('UPDATE edges SET to_id=? WHERE to_id=?').run(canonId, n.id);
    } else if (foldNode(o, n.id, canonId)) {
      merged.push({ from: n.label, intoId: canonId });
    }
  }
  return { merged: merged.length, details: merged.slice(0, 20) };
}

/**
 * Curated merge: "<fromLabel> is the same concept as <toLabel>" — for near-duplicates the
 * canonical key correctly keeps apart ("AI inference costs" vs "inference costs"). The variant's
 * label joins the target's aliases so retrieval seeding treats them as one concept. Human/agent
 * judgment in, deterministic execution — never merged automatically.
 */
export function mergeConceptNodes(o, fromLabel, toLabel, type = 'concept') {
  const byKey = (label) => o.graph.node(`node-${sha12(`${type}:${GraphStore.nodeKey(type, label)}`)}`);
  const from = byKey(fromLabel);
  const to = byKey(toLabel);
  if (!from) return { success: false, message: `no ${type} node for '${fromLabel}'` };
  if (!to) return { success: false, message: `no ${type} node for '${toLabel}'` };
  if (from.id === to.id) return { success: false, message: 'already the same node' };
  foldNode(o, from.id, to.id);
  return { success: true, merged: from.label, into: to.label, intoId: to.id };
}

/**
 * Near-duplicate candidates for review (report-only, never auto-merged): concept pairs whose
 * canonical token sets nest with at most one extra token — the "inference costs" vs
 * "AI inference costs" shape the research notes flagged. Feed the winners to mergeConceptNodes.
 */
export function conceptDupeCandidates(o, { limit = 20 } = {}) {
  const nodes = o.graph.allNodes().filter((n) => CANON_NODE_TYPES.has(n.type));
  const toks = nodes.map((n) => ({ n, set: new Set(canonicalConceptKey(n.label).split(' ').filter(Boolean)) }));
  const out = [];
  for (let i = 0; i < toks.length && out.length < limit; i++) {
    for (let j = i + 1; j < toks.length && out.length < limit; j++) {
      const [small, big] = toks[i].set.size <= toks[j].set.size ? [toks[i], toks[j]] : [toks[j], toks[i]];
      if (small.set.size === 0 || big.set.size - small.set.size > 1) continue;
      if (![...small.set].every((t) => big.set.has(t))) continue;
      out.push({ keep: small.n.label, variant: big.n.label, hint: `merge '${big.n.label}' into '${small.n.label}' if same concept` });
    }
  }
  return out;
}

/** Build/refresh the concept graph: embed new/changed nodes (bounded) + recompute communities.
 *  Deterministic + offline-safe (uses the embedder's fallback when LLM is off). */
export async function refreshConceptGraph(o, { maxEmbedPerPass } = {}) {
  const rc = o.cfg.conceptRouting || {};
  if (rc.enabled === false) return { skipped: true, reason: 'disabled' };
  // Canonicalization first, so embedding/community effort isn't spent on doomed duplicates.
  const deduped = dedupeConceptNodes(o);
  const cap = maxEmbedPerPass ?? rc.maxEmbedPerPass ?? 60;
  const nodes = o.graph.allNodes().filter((n) => n.type !== 'community'); // hierarchy nodes aren't embedded
  let embedded = 0;
  for (const n of nodes) {
    if (embedded >= cap) break;
    const digest = nodeDigest(o.db, n);
    const h = sha12(digest);
    if (n.properties?.embDigestHash === h && Array.isArray(n.properties?.embedding)) continue; // unchanged
    const { vector } = await o.embedder.embed(digest);
    o.db.prepare('UPDATE nodes SET properties=?, updated_at=? WHERE id=?')
      .run(JSON.stringify({ ...n.properties, embedding: vector, embDigestHash: h }), nowISO(), n.id);
    embedded++;
  }
  const communities = detectCommunities(o);
  return { nodes: nodes.length, embedded, communities: communities.count, communityParents: communities.parents, deduped: deduped.merged };
}

/**
 * Hot-path concept routing: from the query vector, find the nearest concept nodes, expand to their
 * communities, and return the set of active entry ids linked to those concepts. Fail-soft: empty set
 * if nothing is embedded. Pure (reads db only) so retrieval can call it with the vector it already has.
 */
export function conceptSeedsFromVector(db, qv, cfg = {}) {
  const rc = cfg.conceptRouting || {};
  if (rc.enabled === false || !qv) return new Set();
  const rows = db.prepare('SELECT id,label,properties FROM nodes').all()
    .map((r) => ({ id: r.id, label: r.label, props: json(r.properties, {}) }))
    .filter((n) => Array.isArray(n.props.embedding) && n.props.embedding.length === qv.length);
  if (!rows.length) return new Set();
  const ranked = rows.map((n) => ({ n, sim: cosine(qv, n.props.embedding) }))
    .sort((a, b) => b.sim - a.sim).slice(0, rc.topConcepts ?? 5)
    .filter((x) => x.sim > (rc.minSim ?? 0.1));
  if (!ranked.length) return new Set();
  const topIds = new Set(ranked.map((x) => x.n.id));
  const communities = new Set(ranked.map((x) => x.n.props.community).filter(Boolean));
  // Match on canonical keys, and include each node's merged-in aliases — so "Inference Costs",
  // "inference cost" and a curated alias all reach the same entries.
  const keys = new Set();
  for (const n of rows) {
    if (!topIds.has(n.id) && !communities.has(n.props.community)) continue;
    keys.add(canonicalConceptKey(n.label));
    for (const a of n.props.aliases || []) keys.add(canonicalConceptKey(a));
  }
  const seeds = new Set();
  for (const e of db.prepare("SELECT id,concepts FROM entries WHERE status='active'").all()) {
    const cs = json(e.concepts, []);
    if (Array.isArray(cs) && cs.some((c) => keys.has(canonicalConceptKey(c.name)))) seeds.add(e.id);
  }
  return seeds;
}
