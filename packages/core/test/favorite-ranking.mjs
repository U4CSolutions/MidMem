/**
 * Favorite ranking calibration (2026-10-21, schema 6) — offline, deterministic, no live LLM.
 *
 * Measures the REAL fused scores (hybridSearch: RRF over the fts / trigram / vector lanes plus every post-RRF
 * boost) on a seeded corpus shaped like the knowledge-capture store (web-article captures, project `library`,
 * authority web, summaries of one or two sentences), prints the numbers behind the defaults favoriteWeight /
 * favoriteHelpfulWeight / favoriteVectorTopK, and checks the promises:
 *
 *   1. among equally relevant candidates: favorite + helpful > favorite > neither — every assignment of the three
 *      roles, lexical pass and deep pass — also when one better match sits above the three (the relevance guard
 *      holds both favorites under it and keeps their order);
 *   2. a favorite never outranks a clearly more relevant entry: no favorite that holds fewer of the query's words
 *      than the target is placed above it, by its boosts or its votes.
 *
 * Two vector spaces: the offline hash embedder (sections 1–5: only entries sharing a hashed word with the query
 * are vector candidates) and a DENSE pass (section 6): pseudo-semantic 1024-dim vectors sharing one mean direction,
 * as a real embedder (bge-m3) gives them — every entry has a positive cosine with every query, so the vector lane
 * returns the whole store. That pass checks the vector top-k gate (a favorite the query does not match lexically is
 * lifted only inside the vector lane's top favoriteVectorTopK) and the Unicode guard on a Cyrillic query.
 *
 * hybridSearch is called directly (a pure read: no retrieval counts, no lease renewal), so baseline and favorite
 * runs see identical stores. Run: `node packages/core/test/favorite-ranking.mjs` (exit 1 on a broken promise);
 * `--json` prints only the numbers.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Orchestrator } from '../src/index.mjs';
import { hybridSearch, coverageWords } from '../src/retrieval.mjs';
import { contentWords } from '../src/grounding.mjs';

const JSON_ONLY = process.argv.includes('--json');
const say = (...a) => { if (!JSON_ONLY) console.log(...a); };
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; say(`  ✓ ${msg}`); } else { fail++; say(`  ✗ ${msg}`); } };

// --- Seeded corpus: 15 topics × 10 captures, sentences mixing topic words, shared words and a few cross-topic words.
let seed = 0x5eed2026;
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const TOPICS = {
  astronomy: 'telescope galaxy nebula orbit comet asteroid planet stellar quasar eclipse observatory cosmic supernova lunar meteor spectrum',
  medicine: 'vaccine clinical patient therapy diagnosis antibody hospital surgeon dosage symptom trial immune infection cardiac oncology pharmacy',
  finance: 'inflation bond equity dividend portfolio interest lender mortgage currency liquidity treasury hedge auditor earnings budget pension',
  climate: 'emissions carbon glacier drought rainfall heatwave methane wildfire coastline sealevel permafrost monsoon aerosol warming flood ocean',
  software: 'compiler kernel database latency cache container runtime deploy framework library debugger refactor endpoint schema thread memory',
  football: 'striker goalkeeper midfield penalty league transfer stadium referee tactics manager fixture tournament offside defender trophy squad',
  cooking: 'recipe oven garlic simmer pastry marinade skillet saffron dough braise roast vinegar spice broth knead caramel',
  energy: 'turbine solar battery grid reactor hydrogen pipeline voltage refinery wind nuclear storage substation lithium inverter charger',
  law: 'court verdict appeal statute plaintiff defendant attorney jury ruling testimony contract injunction tribunal lawsuit precedent counsel',
  biology: 'genome protein enzyme cell mutation species evolution neuron bacteria fungus habitat molecule chromosome microbe organism tissue',
  transport: 'railway airport freight highway subway tram ferry cargo shipping airline bridge tunnel locomotive runway terminal congestion',
  politics: 'election senate minister coalition ballot campaign parliament referendum governor policy cabinet legislature voter opposition reform mayor',
  music: 'orchestra album guitar concert melody symphony festival vinyl chorus rhythm composer drummer quartet opera lyric tempo',
  farming: 'harvest wheat tractor irrigation livestock orchard soil fertilizer barley dairy greenhouse pasture seedling crop silo vineyard',
  security: 'malware phishing firewall encryption breach ransomware password vulnerability exploit botnet patch audit credential intrusion certificate token',
};
// Words no capture contains, tied to a topic only in the dense pass's embedder (a paraphrase query: no lexical hit).
const SYNONYMS = { astronomy: ['stargazing', 'skywatching', 'heavens'], medicine: ['wellbeing', 'physician', 'remedies'] };
const SHARED = ('report study team data city year group local national public service program research analysis effect impact change growth '
  + 'project system market region official result period review plan network center level process support series community future record '
  + 'source value industry council survey sector agency standard quality model track').split(' ');
const topicWords = Object.fromEntries(Object.entries(TOPICS).map(([k, v]) => [k, v.split(' ')]));
const topicNames = Object.keys(topicWords);
const sentence = (topic, n = 12) => {
  const w = [];
  for (let i = 0; i < n; i++) { const r = rnd(); w.push(r < 0.4 ? pick(topicWords[topic]) : r < 0.9 ? pick(SHARED) : pick(topicWords[pick(topicNames)])); }
  return w.join(' ').replace(/^./, (c) => c.toUpperCase()) + '.';
};
const article = (topic) => Array.from({ length: 6 }, () => sentence(topic, 10 + Math.floor(rnd() * 6))).join(' ');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'midmem-favrank-'));
const o = new Orchestrator({
  dbPath: path.join(tmp, 'state.db'), vaultPath: path.join(tmp, 'vault'), llmEnabled: false, sourceRoots: [tmp],
  autoIngest: { enabled: false, onMaintain: false }, maintenance: { enabled: false, intervalMs: 3600e3, distrustBelow: 0.2, factPromote: { minRetrievals: 3, minTrust: 0.6 }, wisdomPromote: { minRetrievals: 5, minTrust: 0.7, minHelpful: 2 } },
});
const capture = async (docId, content) => (await o.ingestContent({ content, source: { libraryId: 'kb-article-library', docId, canonicalUri: `https://news.example.test/${docId}` }, type: 'web-article', authority: 'web', project: 'library' })).entry.id;
let embedder = o.embedder; // the offline hash embedder; section 6 swaps in the dense one
const search = (q, lexicalOnly, limit = 400) => hybridSearch(o.db, o.memory, embedder, q, { limit, scopes: ['shared'], projects: ['library'], lexicalOnly });
const round6 = (x) => Number(x.toFixed(6));
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] : null; };
const resetVotes = (ids) => { for (const id of ids) o.db.prepare('UPDATE entries SET favorite = 0, favorite_helpful = 0, helpful_count = 0, trust_score = 0.5 WHERE id = ?').run(id); };
const PERMS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
const numbers = {};

try {
  say('Favorite ranking calibration (offline, deterministic)\n');
  say(`weights: favoriteWeight ${o.cfg.favoriteWeight}, favoriteHelpfulWeight ${o.cfg.favoriteHelpfulWeight}, favoriteVectorTopK ${o.cfg.favoriteVectorTopK}, trustWeight ${o.cfg.trustWeight} (a vote = +${o.cfg.trustWeight * 0.05} trust boost), rrfK ${o.cfg.rrfK}, lanes ${JSON.stringify(o.cfg.fusionWeights)}`);
  const corpus = [];
  for (const t of topicNames) for (let i = 0; i < 10; i++) {
    const docId = `${t.slice(0, 4)}${String(i).padStart(2, '0')}`;
    corpus.push({ docId, topic: t, id: await capture(docId, article(t)) });
  }
  // Three groups of equally relevant captures: one summary template, a distinct tag word of equal length each.
  const groups = [];
  for (const [g, topic] of [['tide', 'climate'], ['vault', 'security'], ['relay', 'energy']]) {
    const lead = `${sentence(topic, 12)} ${sentence(topic, 12)}`;
    const ids = [];
    for (const tag of ['kxq', 'kxr', 'kxs', 'kxt', 'kxu', 'kxv', 'kxw', 'kxz']) ids.push(await capture(`${g}-${tag}`, `${tag.toUpperCase()} ${lead}`));
    const words = [...new Set(coverageWords(lead))].filter((w) => topicWords[topic].includes(w));
    groups.push({ g, ids, query: words.slice(0, 3).join(' ') });
  }
  // One better match above an equal trio (the 2026-10-21 review fixture, plus two variants).
  const betters = [];
  for (const [g, strong, weak, query] of [
    ['lighthouse', 'Lighthouse beacon restoration: the volunteers finished the lighthouse beacon restoration on the headland.', 'the volunteers repainted the lighthouse on the headland before the winter storms arrived.', 'lighthouse beacon restoration'],
    ['orchard', 'Orchard frost protection: growers installed orchard frost protection fans across the valley.', 'growers walked the orchard at dawn to count the blossoms on every row.', 'orchard frost protection'],
    ['tunnel', 'Tunnel ventilation upgrade: engineers completed the tunnel ventilation upgrade under the river.', 'engineers inspected the tunnel walls for cracks during the night closure.', 'tunnel ventilation upgrade'],
  ]) {
    const strongId = await capture(`${g}-strong`, strong);
    const trio = [];
    for (const tag of ['KXQ', 'KXR', 'KXS']) trio.push(await capture(`${g}-${tag.toLowerCase()}`, `${tag} ${weak}`));
    betters.push({ g, strongId, trio, query });
  }
  say(`corpus: ${corpus.length} captures + ${groups.length} groups of 8 equally relevant captures + ${betters.length} better-match fixtures (${o.memory.stats().memory} active memory entries)\n`);

  // --- Measure 1: the fused-score spread among k equally relevant candidates (no favorites yet).
  say('1. spread among equally relevant captures (score of the best − score of the k-th, no favorites):');
  const spread = { lexical: {}, deep: {} };
  for (const lexical of [true, false]) {
    const p = lexical ? 'lexical' : 'deep';
    for (const { ids, query } of groups) {
      const rows = (await search(query, lexical)).filter((r) => ids.includes(r.id));
      for (let k = 2; k <= rows.length; k++) (spread[p][k] ||= []).push(rows[0].score - rows[k - 1].score);
    }
    say(`   ${p.padEnd(7)} max ${Object.entries(spread[p]).map(([k, v]) => `k=${k} ${round6(Math.max(...v))}`).join('  ')}`);
  }
  numbers.equalRelevanceSpreadMax = Object.fromEntries(Object.entries(spread).map(([p, byK]) => [p, Object.fromEntries(Object.entries(byK).map(([k, v]) => [k, round6(Math.max(...v))]))]));

  // --- Measure 2: adjacent-rank gaps in the top 10 over corpus queries.
  const queries = corpus.filter((_, i) => i % 3 === 0).map((c) => {
    const words = [...new Set(coverageWords(o.recall(c.id).content))].filter((w) => topicWords[c.topic].includes(w));
    return { target: c.id, topic: c.topic, query: words.slice(0, 3).join(' ') };
  }).filter((q) => q.query.split(' ').length === 3);
  const adjacent = { lexical: [], deep: [] };
  const baseline = new Map(); // `${pass}|${query}` → rows
  for (const lexical of [true, false]) {
    const p = lexical ? 'lexical' : 'deep';
    for (const q of queries) {
      const res = await search(q.query, lexical);
      baseline.set(`${p}|${q.query}`, res);
      for (let i = 0; i + 1 < Math.min(res.length, 10); i++) adjacent[p].push(res[i].score - res[i + 1].score);
    }
  }
  say(`\n2. adjacent-rank gaps in the top 10 over ${queries.length} corpus queries (3 topic words each):`);
  for (const p of ['lexical', 'deep']) say(`   ${p.padEnd(7)} median ${round6(pct(adjacent[p], 0.5))}  p90 ${round6(pct(adjacent[p], 0.9))}  max ${round6(Math.max(...adjacent[p]))}`);
  numbers.adjacentGap = Object.fromEntries(['lexical', 'deep'].map((p) => [p, { median: round6(pct(adjacent[p], 0.5)), p90: round6(pct(adjacent[p], 0.9)), max: round6(Math.max(...adjacent[p])) }]));

  // --- Promise 1: every assignment of (favorite+helpful, favorite, neither) over three equally relevant captures,
  //     alone (3a) and under one better match (3b), in both passes.
  const rolePass = async (trio, query, above = null) => {
    let ordered = 0, total = 0, minMargin = Infinity;
    for (const [fh, f, n] of PERMS) {
      resetVotes(trio);
      o.memory.setFavorite(trio[fh], true); o.memory.recordFeedback(trio[fh], true); // favorite + an explicit helpful vote
      o.memory.setFavorite(trio[f], true);
      for (const lexical of [true, false]) {
        const res = await search(query, lexical);
        const at = (id) => res.findIndex((r) => r.id === id);
        total++;
        const order = [trio[fh], trio[f], trio[n]].map(at);
        if (order[0] < order[1] && order[1] < order[2] && (above === null || at(above) < order[0])) ordered++;
        minMargin = Math.min(minMargin, res[order[0]].score - res[order[1]].score, res[order[1]].score - res[order[2]].score);
      }
    }
    resetVotes(trio);
    return { ordered, total, minMargin };
  };
  say('\n3a. favorite + helpful > favorite > neither among equally relevant captures (6 role assignments × 3 groups × 2 passes):');
  let o3 = 0, t3 = 0, m3 = Infinity;
  for (const { ids, query } of groups) { const r = await rolePass(ids.slice(0, 3), query); o3 += r.ordered; t3 += r.total; m3 = Math.min(m3, r.minMargin); }
  say(`    ordered ${o3}/${t3}; smallest winning margin ${round6(m3)}`);
  ok(o3 === t3 && m3 > 0, `favorite + helpful > favorite > neither in every assignment and pass (${o3}/${t3})`);
  say('3b. the same trio under ONE better match (all words vs one of three; the guard holds both favorites under it):');
  let o3b = 0, t3b = 0, m3b = Infinity;
  for (const { strongId, trio, query } of betters) { const r = await rolePass(trio, query, strongId); o3b += r.ordered; t3b += r.total; m3b = Math.min(m3b, r.minMargin); }
  say(`    better match > favorite + helpful > favorite > neither: ${o3b}/${t3b}; smallest margin inside the trio ${m3b.toExponential(2)}`);
  numbers.equalRelevanceOrder = { alone: { ordered: o3, of: t3, minMargin: round6(m3) }, underBetterMatch: { ordered: o3b, of: t3b, minMargin: m3b } };
  ok(o3b === t3b && m3b > 0, `under one better match the held favorites keep their order (${o3b}/${t3b})`);

  // --- How deep a favorite climbs inside one group of 8 equally relevant captures (the k-th one made a favorite).
  const climb = { lexical: 0, deep: 0 };
  for (const lexical of [true, false]) {
    const p = lexical ? 'lexical' : 'deep';
    const { ids, query } = groups[0];
    const order = (await search(query, lexical)).filter((r) => ids.includes(r.id)).map((r) => r.id);
    for (let k = order.length - 1; k >= 1; k--) {
      o.memory.setFavorite(order[k], true);
      const top = (await search(query, lexical)).find((r) => ids.includes(r.id)).id;
      o.memory.setFavorite(order[k], false);
      if (top === order[k]) { climb[p] = k + 1; break; }
    }
  }
  say(`    a favorite reaches the top of 8 equally relevant captures from rank ≤ ${climb.lexical} (lexical) / ≤ ${climb.deep} (deep)`);
  numbers.favoriteClimbsFromRank = climb;

  // --- Promise 2: favorites never outrank a clearly more relevant entry. Favorites: one capture in five, none of
  //     them a query target; every other one also carries an explicit helpful vote (the strongest lift). The guard
  //     holds a favorite's boosts AND its votes, so none may sit above a target holding more of the query's words.
  const targets = new Set(queries.map((q) => q.target));
  const favorites = corpus.filter((c, i) => i % 5 === 2 && !targets.has(c.id)).map((c) => c.id);
  const voted = new Set(favorites.filter((_, i) => i % 2 === 1));
  const vote = o.cfg.trustWeight * 0.05;
  const gainOf = (id) => o.cfg.favoriteWeight + vote + (voted.has(id) ? o.cfg.favoriteHelpfulWeight + vote : 0);
  const promise2 = async (passes) => {
    let above = 0, aboveByRelevance = 0, guardFired = 0, unguardedAbove = 0, compared = 0;
    const unrelatedMargin = [], weakerMargin = [];
    for (const lexical of passes) {
      const p = lexical ? 'lexical' : 'deep';
      for (const q of queries) {
        const words = [...new Set(coverageWords(q.query))];
        const cov = (id) => { const have = new Set(coverageWords(o.recall(id).content)); return words.filter((w) => have.has(w)).length / words.length; };
        const before = baseline.get(`${p}|${q.query}`);
        const res = await search(q.query, lexical);
        const tPos = res.findIndex((r) => r.id === q.target);
        if (tPos < 0) continue;
        const tCov = cov(q.target);
        for (const f of favorites) {
          const fPos = res.findIndex((r) => r.id === f);
          if (fPos < 0) continue;
          const fCov = cov(f);
          if (fCov >= tCov) continue; // only favorites the target clearly out-matches
          const b = before.find((r) => r.id === f);
          const bt = before.find((r) => r.id === q.target);
          if (!b || !bt) continue;
          compared++;
          if (res[fPos].rank.favoriteGuard) guardFired++;
          const margin = bt.score - b.score; // how far below the target the favorite sat before any favorite or vote
          // Above the target by its own relevance already (a dense vector lane can rank a weaker word match first):
          // not the favorite's doing. Above it after starting below: the promise is broken.
          if (fPos < tPos) { if (margin <= 0) aboveByRelevance++; else above++; }
          (fCov === 0 ? unrelatedMargin : weakerMargin).push(margin);
          if (margin > 0 && margin < gainOf(f)) unguardedAbove++;
        }
      }
    }
    return { above, aboveByRelevance, guardFired, unguardedAbove, compared, unrelatedMargin, weakerMargin };
  };
  for (const id of favorites) { o.memory.setFavorite(id, true); if (voted.has(id)) o.memory.recordFeedback(id, true); }
  const mm = (xs) => (xs.length ? `min ${round6(Math.min(...xs))} median ${round6(pct(xs, 0.5))}` : 'n/a');
  const lift = gainOf([...voted][0]);
  say(`\n4. ${favorites.length} favorites (${voted.size} also voted helpful: gain ${o.cfg.favoriteWeight} + ${o.cfg.favoriteHelpfulWeight} + 2 × ${vote}; the others ${o.cfg.favoriteWeight} + ${vote}), ${queries.length} queries × 2 passes, hash vectors:`);
  const p2 = await promise2([true, false]);
  say(`   comparisons (a favorite holding fewer of the query's words than the target): ${p2.compared}`);
  say(`   base margin target − favorite, unrelated favorites (none of the words): ${p2.unrelatedMargin.length} × ${mm(p2.unrelatedMargin)}`);
  say(`   base margin target − favorite, partly matching favorites:               ${p2.weakerMargin.length} × ${mm(p2.weakerMargin)}`);
  say(`   the gain would carry ${p2.unguardedAbove} of them past the target without the guard; guard fired ${p2.guardFired}×; placed above the target: ${p2.above}`);
  numbers.promise2Hash = { compared: p2.compared, unrelatedMarginMin: round6(Math.min(...p2.unrelatedMargin)), unrelatedMarginMedian: round6(pct(p2.unrelatedMargin, 0.5)), weakerMarginMin: round6(Math.min(...p2.weakerMargin)), weakerMarginMedian: round6(pct(p2.weakerMargin, 0.5)), gainMax: round6(lift), wouldPassWithoutGuard: p2.unguardedAbove, guardFired: p2.guardFired, placedAbove: p2.above };
  ok(p2.compared > 0 && p2.above === 0, `no favorite placed above a target that holds more of the query's words (${p2.compared} comparisons)`);
  ok(p2.unrelatedMargin.length > 0 && Math.min(...p2.unrelatedMargin) > 3 * lift, `hash vectors: an unrelated favorite sits far below the target: min margin ${round6(Math.min(...p2.unrelatedMargin))} > 3 × the largest gain ${round6(lift)}`);
  for (const id of favorites) o.memory.setFavorite(id, false);
  resetVotes(favorites);

  // --- The adjacent-rank case the guard exists for: a favorite holding one of three words, one rank under the
  //     entry holding all three. Lexical pass: a favorite alone; deep pass: favorite + helpful.
  const tiny = new Orchestrator({ dbPath: path.join(tmp, 'tiny.db'), vaultPath: path.join(tmp, 'vault'), llmEnabled: false, sourceRoots: [tmp], autoIngest: { enabled: false, onMaintain: false }, maintenance: { enabled: false, intervalMs: 3600e3 } });
  try {
    const strong = (await tiny.storeMemory({ content: 'Quorvex zibbon plavet: the quorvex ledger syncs zibbon shards across the plavet mesh.', tier: 'memory', type: 'note', scope: 'shared' })).id;
    const weak = (await tiny.storeMemory({ content: 'Plavet hosts keep the nightly backup window short.', tier: 'memory', type: 'note', scope: 'shared' })).id;
    const run = (lexicalOnly) => hybridSearch(tiny.db, tiny.memory, tiny.embedder, 'quorvex zibbon plavet', { limit: 5, lexicalOnly });
    const label = (rows) => rows.map((r) => `${r.id === strong ? 'strong' : 'weak'} ${r.score}${r.rank.favoriteGuard ? ' (guard)' : ''}`).join(', ');
    numbers.adjacentCase = {};
    for (const [lexical, votedTiny] of [[true, false], [false, true]]) {
      const p = lexical ? 'lexical' : 'deep';
      tiny.memory.setFavorite(weak, false); tiny.db.prepare('UPDATE entries SET helpful_count = 0, trust_score = 0.5 WHERE id = ?').run(weak);
      const before = await run(lexical);
      const gap = before[0].score - before[1].score;
      tiny.memory.setFavorite(weak, true);
      if (votedTiny) tiny.memory.recordFeedback(weak, true);
      const gain = o.cfg.favoriteWeight + (votedTiny ? o.cfg.favoriteHelpfulWeight + vote : 0) + vote;
      const after = await run(lexical);
      say(`\n5${lexical ? 'a' : 'b'}. two-entry store, ${p}: strong (3/3 words) ${round6(before[0].score)} vs weak (1/3) ${round6(before[1].score)} — gap ${round6(gap)} < gain ${round6(gain)}`);
      say(`    weak made a favorite${votedTiny ? ' + helpful' : ''}: ${label(after)}`);
      numbers.adjacentCase[p] = { gap: round6(gap), gain: round6(gain), order: after.map((r) => (r.id === strong ? 'strong' : 'weak')), guard: !!after.find((r) => r.id === weak)?.rank.favoriteGuard };
      ok(before[0].id === strong && gap < gain && after[0].id === strong && after[1].rank.favoriteGuard === true, `${p}: the guard keeps the one-word favorite${votedTiny ? ' (+ helpful)' : ''} under the all-words entry it would pass`);
    }
  } finally { tiny.close(); }

  // --- 6. DENSE pass: pseudo-semantic 1024-dim vectors sharing one mean direction (cos > 0 for every pair, like a
  //        real embedder), topic words leaning toward a topic direction, SYNONYMS (in no capture) too.
  const DIM = 1024;
  const unit = (v) => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map((x) => x / n); };
  const keyed = (key) => {
    let h = 2166136261; for (const ch of key) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
    let s = h >>> 0;
    return Array.from({ length: DIM }, () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5; });
  };
  const MEAN = unit(keyed('::mean::'));
  const TOPIC_DIR = Object.fromEntries(topicNames.map((t) => [t, unit(keyed(`::topic::${t}`))]));
  const wordTopic = new Map();
  for (const [t, ws] of Object.entries(topicWords)) for (const w of ws) wordTopic.set(w, t);
  for (const [t, ws] of Object.entries(SYNONYMS)) for (const w of ws) wordTopic.set(w, t);
  const wordMemo = new Map();
  const wordVec = (w) => {
    if (!wordMemo.has(w)) { const r = unit(keyed(w)); const t = wordTopic.get(w); wordMemo.set(w, t ? unit(r.map((x, i) => x + 1.5 * TOPIC_DIR[t][i])) : r); }
    return wordMemo.get(w);
  };
  const denseVec = (text) => {
    const ws = coverageWords(text);
    const acc = MEAN.map((x) => 2 * x);
    for (const w of ws) { const v = wordVec(w); for (let i = 0; i < DIM; i++) acc[i] += v[i] / Math.sqrt(ws.length || 1); }
    return unit(acc);
  };
  embedder = { embed: async (text) => ({ vector: denseVec(text), model: 'pseudo-dense-1024', mode: 'lmstudio' }) };
  const all = o.db.prepare("SELECT id, content FROM entries WHERE status = 'active'").all();
  for (const r of all) await o.memory.upsertVector(r.id, denseVec(r.content), 'pseudo-dense-1024', 'lmstudio');
  const para = SYNONYMS.astronomy.join(' ');
  const denseCand = await search(para, false);
  say(`\n6. DENSE pass (pseudo-semantic 1024-dim vectors, shared mean direction): ${all.length} entries re-embedded`);
  say(`   a paraphrase query with no lexical hit ("${para}") returns ${denseCand.length} vector candidates; lexical hits: ${denseCand.filter((r) => r.rank.fts || r.rank.trigram).length}; top-5 topics: ${denseCand.slice(0, 5).map((r) => corpus.find((c) => c.id === r.id)?.topic ?? 'other').join(', ')}`);
  numbers.dense = { entries: all.length, vectorCandidatesOfAParaphraseQuery: denseCand.length };
  ok(denseCand.length >= Math.min(200, all.length) && denseCand.every((r) => !r.rank.fts && !r.rank.trigram), 'dense: every entry is a vector candidate of a query no lexical lane answers');

  // 6a. Promise 1 again, now with dense vectors (the deep pass carries the vector lane).
  let o6 = 0, t6 = 0;
  for (const { ids, query } of groups) { const r = await rolePass(ids.slice(0, 3), query); o6 += r.ordered; t6 += r.total; }
  for (const { strongId, trio, query } of betters) { const r = await rolePass(trio, query, strongId); o6 += r.ordered; t6 += r.total; }
  say(`6a. favorite + helpful > favorite > neither (alone and under a better match), dense vectors: ${o6}/${t6}`);
  ok(o6 === t6, `dense: the favorite order holds in every assignment and pass (${o6}/${t6})`);
  numbers.dense.order = { ordered: o6, of: t6 };

  // 6b. The vector top-k gate on a query no lexical lane answers: one favorite (+ helpful) at vector rank r.
  const base6 = await search(para, false);
  const climbOf = {};
  const k = o.cfg.favoriteVectorTopK;
  for (const r of [3, 5, 8, 10, 11, 15, 20, 30, 40]) {
    const target = base6.find((x) => x.rank.vector === r);
    if (!target) continue;
    // The same entry with the same trust (two helpful votes) but no favorite: where its votes alone put it.
    o.memory.recordFeedback(target.id, true); o.memory.recordFeedback(target.id, true);
    const plainPos = (await search(para, false)).findIndex((x) => x.id === target.id) + 1;
    resetVotes([target.id]);
    o.memory.setFavorite(target.id, true); o.memory.recordFeedback(target.id, true);
    const res = await search(para, false);
    const pos = res.findIndex((x) => x.id === target.id) + 1;
    const boosted = res[pos - 1].rank.favorite !== undefined;
    // Without the gate it would carry favoriteWeight + favoriteHelpfulWeight on top of its votes: where would it land?
    const ungated = res[pos - 1].score + (boosted ? 0 : o.cfg.favoriteWeight + o.cfg.favoriteHelpfulWeight);
    const ungatedPos = res.filter((x) => x.id !== target.id && x.score > ungated).length + 1;
    climbOf[r] = { position: pos, boosted, sameVotesNoFavorite: plainPos, withoutGate: ungatedPos };
    resetVotes([target.id]);
  }
  say('6b. paraphrase query, one favorite + helpful at vector rank r → its position (the same votes without the favorite; and without the gate):');
  say(`    ${Object.entries(climbOf).map(([r, v]) => `r=${r} → #${v.position}${v.boosted ? ' (boosted)' : ''} [votes only: #${v.sameVotesNoFavorite}; no gate: #${v.withoutGate}]`).join(', ')}`);
  numbers.dense.vectorGate = { k, byRank: climbOf };
  ok(Object.keys(climbOf).length >= 8 && Object.entries(climbOf).every(([r, v]) => (Number(r) <= k ? v.boosted : !v.boosted && v.position === v.sameVotesNoFavorite)) && Object.entries(climbOf).some(([r, v]) => Number(r) > k && v.withoutGate === 1),
    `dense: past the vector top ${k} being a favorite adds nothing (it ranks where its votes alone put it) — without the gate it would reach #1`);

  // 6c. Non-Latin queries (their own small store, dense vectors, no concepts — so only the vector lane, the boosts and
  //     the guard decide): no lexical lane answers them (the FTS lanes tokenize ASCII). Every favorite (+ helpful)
  //     inside the vector top 10 would pass the entry holding the query's words on its lift (the RRF gap within the
  //     top 10 is ≤ 0.0022); the Unicode guard holds each one below it. An ASCII-only word list sees no words at all.
  const multi = new Orchestrator({ dbPath: path.join(tmp, 'multi.db'), vaultPath: path.join(tmp, 'vault'), llmEnabled: false, sourceRoots: [tmp], autoIngest: { enabled: false, onMaintain: false }, maintenance: { enabled: false, intervalMs: 3600e3 } });
  try {
    const put = async (content) => { const id = (await multi.storeMemory({ content, tier: 'memory', type: 'note', scope: 'shared' })).id; await multi.memory.upsertVector(id, denseVec(content), 'pseudo-dense-1024', 'lmstudio'); return id; };
    const sets = [
      { lang: 'Cyrillic', q: 'маяк реставрация берег', strong: 'Маяк, реставрация, берег: волонтёры закончили реставрацию маяка на берегу залива.',
        others: ['Заметка о расписании ночного парома у старой пристани.', 'Волонтёры покрасили ограду у школы до первых холодов.', 'Совет утвердил новую велодорожку вдоль набережной.', 'Музей открыл зал морской истории после ремонта.',
          'Рыбаки обсудили квоты на вылов трески этой весной.', 'В парке высадили сто молодых лип и клёнов.', 'Библиотека продлила часы работы по выходным.', 'Городской хор выступил на празднике урожая.'] },
      { lang: 'CJK', q: '灯塔修复', strong: '灯塔修复工程在海岸边顺利完成。',
        others: ['学校的围栏被志愿者重新粉刷。', '市议会批准了沿河的新自行车道。', '博物馆的海洋历史展厅重新开放。', '图书馆延长了周末的开放时间。'] },
    ];
    numbers.dense.nonLatin = {};
    for (const set of sets) {
      const strongId = await put(set.strong);
      const otherIds = [];
      for (const t of set.others) otherIds.push(await put(t));
      const run = () => hybridSearch(multi.db, multi.memory, embedder, set.q, { limit: 50 });
      const base = await run();
      const lexical = base.filter((r) => r.rank.fts || r.rank.trigram).length;
      const inTopK = base.filter((r) => r.id !== strongId && otherIds.includes(r.id) && r.rank.vector <= k);
      let held = 0, above = 0, wouldPass = 0;
      for (const fr of inTopK) {
        multi.memory.setFavorite(fr.id, true); multi.memory.recordFeedback(fr.id, true);
        const res = await run();
        const fPos = res.findIndex((r) => r.id === fr.id), sPos = res.findIndex((r) => r.id === strongId);
        if (fPos < sPos) above++;
        if (res[fPos].rank.favoriteGuard) held++;
        if (base[0].score - fr.score < o.cfg.favoriteWeight + o.cfg.favoriteHelpfulWeight + 2 * vote) wouldPass++;
        multi.db.prepare('UPDATE entries SET favorite = 0, favorite_helpful = 0, helpful_count = 0, trust_score = 0.5 WHERE id = ?').run(fr.id);
      }
      say(`6c. ${set.lang} query "${set.q}": lexical hits ${lexical}; the all-words entry is #${base.findIndex((r) => r.id === strongId) + 1} (vector rank ${base.find((r) => r.id === strongId).rank.vector}); coverage words ${JSON.stringify(coverageWords(set.q))} (grounding's ASCII-only contentWords: ${JSON.stringify(contentWords(set.q))})`);
      say(`    ${inTopK.length} favorites (+ helpful) inside the vector top ${k}, one at a time: their lift would carry ${wouldPass} past it; held by the guard ${held}; placed above it ${above}`);
      numbers.dense.nonLatin[set.lang] = { lexicalHits: lexical, strongPosition: base.findIndex((r) => r.id === strongId) + 1, tried: inTopK.length, wouldPassOnLift: wouldPass, held, placedAbove: above };
      ok(lexical === 0 && base[0].id === strongId && inTopK.length > 0 && wouldPass === inTopK.length && held === inTopK.length && above === 0,
        `dense, ${set.lang}: no favorite passes the entry holding the query's words (${inTopK.length} tried, all held by the Unicode guard)`);
    }
  } finally { multi.close(); }

  // 6d. Promise 2 with dense vectors, deep pass (re-baselined: the vectors changed).
  for (const q of queries) baseline.set(`deep|${q.query}`, await search(q.query, false));
  for (const id of favorites) { o.memory.setFavorite(id, true); if (voted.has(id)) o.memory.recordFeedback(id, true); }
  const p2d = await promise2([false]);
  say(`6d. promise 2, dense vectors, deep pass: ${p2d.compared} comparisons; unrelated favorites' base margin ${mm(p2d.unrelatedMargin)}; partly matching ${mm(p2d.weakerMargin)}`);
  say(`    the gain would carry ${p2d.unguardedAbove} past the target without the guard; guard fired ${p2d.guardFired}×; placed above the target by the favorite: ${p2d.above} (above it by their own relevance already: ${p2d.aboveByRelevance})`);
  numbers.dense.promise2 = { compared: p2d.compared, unrelatedMarginMin: p2d.unrelatedMargin.length ? round6(Math.min(...p2d.unrelatedMargin)) : null, unrelatedMarginMedian: round6(pct(p2d.unrelatedMargin, 0.5)), weakerMarginMin: p2d.weakerMargin.length ? round6(Math.min(...p2d.weakerMargin)) : null, wouldPassWithoutGuard: p2d.unguardedAbove, guardFired: p2d.guardFired, placedAbove: p2d.above, aboveByOwnRelevance: p2d.aboveByRelevance };
  ok(p2d.compared > 0 && p2d.above === 0, `dense: no favorite placed above a target that holds more of the query's words (${p2d.compared} comparisons)`);

  if (JSON_ONLY) console.log(JSON.stringify(numbers));
  say(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
} catch (e) {
  console.error('\nFATAL:', e.stack); fail++;
} finally {
  o.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
}
