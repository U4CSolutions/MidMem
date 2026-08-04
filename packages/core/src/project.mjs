/**
 * Vault projection — render state.db → Obsidian markdown (LLM-owned files).
 *
 * The db is source-of-truth; the vault is a deterministic, idempotent projection
 * for human reading / Obsidian graph view. Files carry `owner: llm` so a future
 * bidirectional sync can distinguish LLM-owned from human-owned notes.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { frontmatter, nowISO, canonicalConceptKey, sha12 } from './util.mjs';
import { groundingScore } from './grounding.mjs';

/** A projection pass must survive any single bad page — the vault sits on a network share
 *  where one entry can be individually broken (e.g. a server-corrupt CIFS name that EACCESes
 *  every open while the rest of the dir works). Collect a capped sample of per-file failures
 *  and keep writing; the caller reports them. */
const MAX_ERROR_SAMPLE = 8;
function safeWrite(file, body, state) {
  try { fs.writeFileSync(file, body); return true; }
  catch (e) {
    state.failed++;
    if (state.errors.length < MAX_ERROR_SAMPLE) state.errors.push(`${path.basename(file)}: ${e.code || e.message}`);
    return false;
  }
}

/** Remove stale projected pages: any .md in `dir` not in `keep`. The projection owns these
 *  dirs outright (owner: llm), so a page with no live backing row is stale by definition —
 *  without this, archived/expired entries stay visible in the vault forever. */
function pruneDir(dir, keep) {
  let pruned = 0;
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const f of names) {
    if (!f.endsWith('.md') || keep.has(f)) continue;
    try { fs.unlinkSync(path.join(dir, f)); pruned++; } catch { /* share hiccup — next pass */ }
  }
  return pruned;
}

/**
 * @param {import('./db.mjs').StateDB} db
 * @param {import('./memory.mjs').TieredMemory} memory
 * @param {import('./graph.mjs').GraphStore} graph
 */
export function projectVault(db, memory, graph, cfg, { force = false } = {}) {
  const root = path.join(cfg.vaultPath, cfg.wikiPath);
  // Root must exist before anything else — if THIS fails the vault is gone (unmounted share),
  // which is a whole-projection failure and should throw as before.
  fs.mkdirSync(root, { recursive: true });
  const entries = memory.listActive();
  let written = 0;
  let skipped = 0;
  let pruned = 0;
  const state = { failed: 0, errors: [] };
  const keepByDir = new Map(); // dir → Set of filenames that belong in this projection

  // Dirty-check: the vault sits on a network share, so an unconditional pass costs one write
  // per page (~5.8k pages ≈ 3.5min over CIFS) even when NOTHING changed. Page hashes live in
  // state.db; a page is skipped only when its hash matches AND the file is present on disk
  // (one readdir per dir), so hand-deleted vault files still get repaired. `force` rewrites all.
  const pageHashes = new Map(db.prepare('SELECT path, hash FROM projected_pages').all().map((r) => [r.path, r.hash]));
  const seenPages = new Set();
  const upsertHash = db.prepare("INSERT INTO projected_pages(path,hash,updated_at) VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET hash=excluded.hash, updated_at=excluded.updated_at");
  const dirListings = new Map();
  const madeDirs = new Set();
  const mkdirOnce = (dir) => { if (!madeDirs.has(dir)) { fs.mkdirSync(dir, { recursive: true }); madeDirs.add(dir); } };
  const listDir = (dir) => {
    if (!dirListings.has(dir)) { try { dirListings.set(dir, new Set(fs.readdirSync(dir))); } catch { dirListings.set(dir, new Set()); } }
    return dirListings.get(dir);
  };
  const writePage = (dir, fname, body) => {
    const rel = path.join(path.relative(root, dir) || '.', fname);
    // Two nodes can canonicalize to one filename (e.g. a task and a concept sharing a label).
    // First writer wins the pass — without this, the stored hash always belongs to the other
    // writer and both rewrite every pass forever (hash ping-pong).
    if (seenPages.has(rel)) { skipped++; return; }
    seenPages.add(rel);
    const h = sha12(body);
    if (!force && pageHashes.get(rel) === h && listDir(dir).has(fname)) { skipped++; return; }
    if (safeWrite(path.join(dir, fname), body, state)) { written++; upsertHash.run(rel, h, nowISO()); }
  };

  // Per-entry pages, grouped by tier.
  for (const e of entries) {
    const dir = path.join(root, e.tier);
    mkdirOnce(dir);
    if (!keepByDir.has(dir)) keepByDir.set(dir, new Set());
    keepByDir.get(dir).add(`${e.id}.md`);
    const concepts = (e.concepts || []).map((c) => `[[${c.name}]]`);
    const fm = frontmatter({
      id: e.id, tier: e.tier, type: e.type, status: e.status,
      created: e.created_at, updated: e.updated_at, owner: 'llm',
      source: e.source_id || undefined,
    });
    const body = [
      fm, '', `# ${e.type}: ${e.id}`, '', e.content, '',
      concepts.length ? `## Concepts\n${concepts.join(' · ')}` : '',
      e.provenance ? `\n## Provenance\n\`\`\`json\n${JSON.stringify(e.provenance, null, 2)}\n\`\`\`` : '',
    ].join('\n');
    writePage(dir, `${e.id}.md`, body);
  }

  // Concept/entity pages from the graph. Filenames come from the CANONICAL key, not the raw
  // label — the vault share is case-insensitive, so case-variant labels used to collapse into
  // one file nondeterministically; the canonical (lowercase) slug makes the collision impossible.
  const g = graph.getGraph();
  if (g.nodes.length) {
    const cdir = path.join(root, 'concepts');
    mkdirOnce(cdir);
    const ckeep = new Set();
    keepByDir.set(cdir, ckeep);
    for (const n of g.nodes) {
      const links = graph.neighbors(n.id)
        .map((e) => { const other = e.from === n.id ? e.to : e.from; const o = graph.node(other); return o ? `[[${o.label}]] (${e.type})` : null; })
        .filter(Boolean);
      const body = [
        frontmatter({ id: n.id, type: n.type, label: n.label, owner: 'llm' }),
        '', `# ${n.label}`, '', `Type: ${n.type}`, '',
        links.length ? `## Related\n${links.join('\n')}` : '',
      ].join('\n');
      const fname = `${(canonicalConceptKey(n.label) || n.id).replace(/[^\w.-]+/g, '_')}.md`;
      writePage(cdir, fname, body);
      ckeep.add(fname); // keep even on failure — a half-broken name must not get pruned into worse state
    }
  }

  // Prune pages whose backing row is gone (archived/expired/merged) from the dirs we own.
  for (const [dir, keep] of keepByDir) pruned += pruneDir(dir, keep);
  // A tier dir can also empty out entirely (everything expired) — sweep known tier dirs too.
  for (const t of memory.tierNames) {
    const dir = path.join(root, t);
    if (!keepByDir.has(dir)) pruned += pruneDir(dir, new Set());
  }

  // index.md + log.md
  const byTier = {};
  for (const e of entries) (byTier[e.tier] ||= []).push(e);
  let idx = `# Wiki Index\n\n> Projected from state.db — ${nowISO()}\n> ${entries.length} entries · ${g.nodes.length} graph nodes\n\n`;
  for (const [tier, es] of Object.entries(byTier)) {
    idx += `## ${tier}\n`;
    for (const e of es) idx += `- [[${e.tier}/${e.id}]]: ${e.content.slice(0, 80).replace(/\n/g, ' ')}\n`;
    idx += '\n';
  }
  writePage(root, 'index.md', idx);

  const logs = db.prepare('SELECT ts,operation,detail FROM log ORDER BY id DESC LIMIT 50').all();
  let logmd = `# Wiki Log\n\n> Projected from state.db — ${nowISO()}\n\n`;
  for (const l of logs) logmd += `## [${l.ts}] ${l.operation}\n\`\`\`json\n${l.detail}\n\`\`\`\n\n`;
  writePage(root, 'log.md', logmd);

  // Keep the hash table in lockstep with what this projection owns: rows for pruned or
  // no-longer-projected pages must go, or a page re-created later under the same path
  // could be skipped against a stale hash.
  const dropHash = db.prepare('DELETE FROM projected_pages WHERE path=?');
  for (const p of pageHashes.keys()) if (!seenPages.has(p)) dropHash.run(p);

  return { written, skipped, pruned, failed: state.failed, errors: state.errors, vaultPath: root };
}

/**
 * Projection QA — WiCER-style (arXiv 2605.07068) tests over the compiled wiki: naive
 * compilation can silently discard or corrupt knowledge, so the projection gets probed,
 * not trusted. Deterministic, report-only (failures are surfaced, never auto-"fixed"):
 *
 *  1. completeness — every ACTIVE entry has its page on disk (one readdir per tier dir;
 *     the dirty-check can't catch a page that was never written or was hand-deleted
 *     between passes AND has a stale hash row).
 *  2. fidelity — for a bounded sample (most recently updated entries), the page on disk
 *     actually contains the entry's content (grounding overlap ≥ minFidelity). Catches
 *     truncated/corrupted writes on the network share that returned success.
 *
 * Sampling keeps a QA pass cheap over CIFS: completeness is O(dirs) readdirs;
 * fidelity reads `sampleSize` files, newest-updated first (the pages most likely to
 * have been rewritten recently — where write corruption would live).
 */
export function probeProjection(db, memory, cfg, { sampleSize = 20, minFidelity = 0.9 } = {}) {
  const root = path.join(cfg.vaultPath, cfg.wikiPath);
  const entries = memory.listActive();
  const missing = [];
  const dirList = new Map();
  const listing = (dir) => {
    if (!dirList.has(dir)) { try { dirList.set(dir, new Set(fs.readdirSync(dir))); } catch { dirList.set(dir, new Set()); } }
    return dirList.get(dir);
  };
  for (const e of entries) {
    if (!listing(path.join(root, e.tier)).has(`${e.id}.md`)) missing.push(e.id);
  }

  const fidelityFailures = [];
  const sample = [...entries]
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
    .slice(0, sampleSize)
    .filter((e) => !missing.includes(e.id));
  for (const e of sample) {
    try {
      const page = fs.readFileSync(path.join(root, e.tier, `${e.id}.md`), 'utf8');
      const score = groundingScore(page, e.content);
      if (score < minFidelity) fidelityFailures.push({ id: e.id, score: Number(score.toFixed(3)) });
    } catch (err) {
      fidelityFailures.push({ id: e.id, error: err.code || err.message });
    }
  }

  const pass = missing.length === 0 && fidelityFailures.length === 0;
  return { pass, entries: entries.length, missingPages: missing.slice(0, 20), missingCount: missing.length, sampled: sample.length, fidelityFailures };
}
