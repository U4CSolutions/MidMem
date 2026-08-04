/**
 * Capture packs — domain extensibility as DATA, not code (roadmap 2026-08 #5; the
 * gbrain "schema pack" idea adapted to pure-core discipline). A pack is a JSON file
 * registering, for one domain: entry types (each with a tier + memory function and an
 * optional graph edge), categorizer rules, and an edge vocabulary. The core never
 * learns domain names — swap packs and the same build serves coding patterns, ops
 * runbooks, or lab notebooks (4-mode rule preserved).
 *
 * Non-destructive by construction: packs ADD types/rules/edges; they cannot redefine
 * core work-event kinds or core edge types, and unknown/invalid packs are skipped with
 * a report rather than failing the orchestrator.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WORK_EVENT_NAMES, MEMORY_FUNCTIONS } from './workmemory.mjs';
import { registerEdgeTypes } from './graph.mjs';

const RESERVED_TYPES = new Set([...WORK_EVENT_NAMES, 'ingest', 'session', 'note', 'insight', 'prospective']);

/** Load all packs from cfg.capturePacks (builtin dir + extra paths). Deterministic order:
 *  builtin dir sorted by filename, then extra paths in configured order. */
export function loadPacks(cfg = {}) {
  const pc = cfg.capturePacks || {};
  if (pc.enabled === false) return { packs: [], types: {}, rules: [], errors: [] };
  const files = [];
  if (pc.builtinDir) {
    try { files.push(...fs.readdirSync(pc.builtinDir).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(pc.builtinDir, f))); }
    catch { /* no builtin packs dir — fine */ }
  }
  for (const p of pc.paths || []) files.push(p);

  const packs = [];
  const types = {};   // entryType -> { pack, tier, function, edge }
  const rules = [];   // [category, RegExp] prepended to the core categorizer
  const errors = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!raw.name) { errors.push(`${path.basename(file)}: pack has no name`); continue; }
      const loadedTypes = [];
      for (const [t, def] of Object.entries(raw.entryTypes || {})) {
        if (RESERVED_TYPES.has(t)) { errors.push(`${raw.name}: type '${t}' is reserved`); continue; }
        if (types[t]) { errors.push(`${raw.name}: type '${t}' already registered by pack '${types[t].pack}'`); continue; }
        const fn = def.function || 'procedural';
        if (!MEMORY_FUNCTIONS.includes(fn)) { errors.push(`${raw.name}: type '${t}' has unknown function '${fn}'`); continue; }
        types[t] = { pack: raw.name, tier: def.tier || 'memory', function: fn, edge: def.edge || null, fields: def.fields || [] };
        loadedTypes.push(t);
      }
      for (const [cat, re] of raw.categorizerRules || []) {
        try { rules.push([cat, new RegExp(re, 'i')]); } catch { errors.push(`${raw.name}: bad rule regex for '${cat}'`); }
      }
      registerEdgeTypes(raw.edgeTypes || []);
      packs.push({ name: raw.name, version: raw.version ?? 1, file, types: loadedTypes, edgeTypes: raw.edgeTypes || [] });
    } catch (e) { errors.push(`${path.basename(file)}: ${e.message}`); }
  }
  return { packs, types, rules, errors };
}

/**
 * Record a structured pattern/domain entry through a pack-registered type.
 * Content is composed deterministically from the structured fields (stable section
 * order → stable hashes/diffs); the entry lands via the governed storeMemory path with
 * the pack's tier + function; the graph gets a typed node for the pattern plus
 * `evidence` edges to source nodes and `about` edges to concepts.
 */
export async function recordPattern(o, { type, title, context, problem, solution, evidence = [], concepts = [], scope, outcome } = {}) {
  const def = o.packs?.types?.[type];
  if (!def) throw new Error(`unknown pack type: ${type} (loaded: ${Object.keys(o.packs?.types || {}).join(', ') || 'none'})`);
  if (!title) throw new Error('recordPattern requires a title');
  const parts = [`[${type}] ${title}`];
  if (context) parts.push(`Context: ${context}`);
  if (problem) parts.push(`Problem: ${problem}`);
  if (solution) parts.push(`Solution: ${solution}`);
  if (outcome) parts.push(`Outcome: ${outcome}`);
  if (evidence.length) parts.push(`Evidence: ${evidence.join(' · ')}`);
  const content = parts.join(' — ');

  const res = await o.storeMemory({ content, type, tier: def.tier, scope, memFunction: def.function, concepts });
  const prov = {
    category: type, recordedAt: new Date().toISOString(), pack: def.pack,
    pattern: { title, context: context ?? null, problem: problem ?? null, solution: solution ?? null, outcome: outcome ?? null, evidence },
  };
  o.db.prepare('UPDATE entries SET provenance=? WHERE id=?').run(JSON.stringify(prov), res.id);

  const node = o.graph.upsertNode({ type, label: title, source: `pack:${def.pack}` });
  for (const ev of evidence) o.graph.upsertEdge({ from: node, to: o.graph.upsertNode({ type: 'source', label: ev, source: `pack:${def.pack}` }), type: def.edge || 'references', source: `pack:${def.pack}` });
  for (const c of concepts) o.graph.upsertEdge({ from: node, to: o.graph.upsertNode({ type: c.type || 'concept', label: c.name, source: `pack:${def.pack}` }), type: 'about', source: `pack:${def.pack}` });
  o.db.logOp('record-pattern', { type, pack: def.pack, entry: res.id, title: title.slice(0, 80) });
  return { success: true, type, pack: def.pack, ...res };
}
