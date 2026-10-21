/**
 * Favorite ranking calibration (2026-10-21, schema 6) — offline, deterministic, no live LLM.
 *
 * Measures the REAL fused scores (hybridSearch: RRF over the fts / trigram / vector lanes plus every post-RRF
 * boost) on a seeded corpus shaped like the knowledge-capture store (web-article captures, project `library`,
 * authority web, summaries of one or two sentences), prints the numbers that justify the defaults
 * favoriteWeight / favoriteHelpfulWeight, and checks the two promises:
 *
 *   1. among equally relevant candidates: favorite + helpful > favorite > neither — every assignment of the
 *      three roles over three equally relevant captures, lexical pass and deep pass;
 *   2. a favorite never outranks a clearly more relevant entry: over every corpus query, no favorite that holds
 *      fewer of the query's words than the target is placed above it (and the corpus margins show the guard is
 *      only ever needed where RRF ranks sit one step apart).
 *
 * hybridSearch is called directly (a pure read: no retrieval counts, no lease renewal), so baseline and
 * favorite runs see identical stores. Run: `node packages/core/test/favorite-ranking.mjs` (exit 1 on a broken
 * promise). `--json` prints only the numbers.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Orchestrator } from '../src/index.mjs';
import { hybridSearch } from '../src/retrieval.mjs';
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
const search = (q, lexicalOnly) => hybridSearch(o.db, o.memory, o.embedder, q, { limit: 400, scopes: ['shared'], projects: ['library'], lexicalOnly });
const round6 = (x) => Number(x.toFixed(6));
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] : null; };
const numbers = {};

try {
  say('Favorite ranking calibration (offline, deterministic)\n');
  say(`weights: favoriteWeight ${o.cfg.favoriteWeight}, favoriteHelpfulWeight ${o.cfg.favoriteHelpfulWeight}, trustWeight ${o.cfg.trustWeight} (a vote = +${o.cfg.trustWeight * 0.05} trust boost), rrfK ${o.cfg.rrfK}, lanes ${JSON.stringify(o.cfg.fusionWeights)}`);
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
    const words = [...new Set(contentWords(lead))].filter((w) => topicWords[topic].includes(w));
    groups.push({ g, ids, query: words.slice(0, 3).join(' ') });
  }
  say(`corpus: ${corpus.length} captures + ${groups.length} groups of 8 equally relevant captures (${o.memory.stats().memory} active memory entries)\n`);

  // --- Measure 1: the fused-score spread among k equally relevant candidates (no favorites yet).
  say('1. spread among equally relevant captures (score of the best − score of the k-th, no favorites):');
  const spread = { lexical: {}, deep: {} };
  for (const lexical of [true, false]) {
    const pass2 = lexical ? 'lexical' : 'deep';
    for (const { ids, query } of groups) {
      const res = await search(query, lexical);
      const rows = res.filter((r) => ids.includes(r.id));
      for (let k = 2; k <= rows.length; k++) (spread[pass2][k] ||= []).push(rows[0].score - rows[k - 1].score);
    }
    const line = Object.entries(spread[pass2]).map(([k, v]) => `k=${k} ${round6(Math.max(...v))}`).join('  ');
    say(`   ${pass2.padEnd(7)} max ${line}`);
  }
  numbers.equalRelevanceSpreadMax = Object.fromEntries(Object.entries(spread).map(([p, byK]) => [p, Object.fromEntries(Object.entries(byK).map(([k, v]) => [k, round6(Math.max(...v))]))]));

  // --- Measure 2: adjacent-rank gaps and the gap from the target to weaker matches over corpus queries.
  const queries = corpus.filter((_, i) => i % 3 === 0).map((c) => {
    const words = [...new Set(contentWords(o.recall(c.id).content))].filter((w) => topicWords[c.topic].includes(w));
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

  // --- Promise 1: every assignment of (favorite+helpful, favorite, neither) over three equally relevant captures.
  say('\n3. favorite + helpful > favorite > neither among equally relevant captures (all 6 role assignments × 3 groups × 2 passes):');
  const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  let orderOk = 0, orderAll = 0, minMargin = Infinity;
  for (const { ids, query } of groups) {
    const trio = ids.slice(0, 3);
    for (const [fh, f, n] of perms) {
      for (const id of trio) { o.memory.setFavorite(id, false); o.db.prepare('UPDATE entries SET helpful_count = 0, trust_score = 0.5 WHERE id = ?').run(id); }
      o.memory.setFavorite(trio[fh], true); o.memory.recordFeedback(trio[fh], true); // favorite + an explicit helpful vote
      o.memory.setFavorite(trio[f], true);
      for (const lexical of [true, false]) {
        const res = await search(query, lexical);
        const at = (id) => res.findIndex((r) => r.id === id);
        const s = (id) => res[at(id)].score;
        orderAll++;
        if (at(trio[fh]) < at(trio[f]) && at(trio[f]) < at(trio[n])) orderOk++;
        minMargin = Math.min(minMargin, s(trio[fh]) - s(trio[f]), s(trio[f]) - s(trio[n]));
      }
    }
    for (const id of trio) { o.memory.setFavorite(id, false); o.db.prepare('UPDATE entries SET helpful_count = 0, trust_score = 0.5 WHERE id = ?').run(id); }
  }
  say(`   ordered ${orderOk}/${orderAll}; smallest winning margin ${round6(minMargin)}`);
  numbers.equalRelevanceOrder = { ordered: orderOk, of: orderAll, minMargin: round6(minMargin) };
  ok(orderOk === orderAll && minMargin > 0, `favorite + helpful > favorite > neither in every assignment and pass (${orderOk}/${orderAll})`);

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
  say(`   a favorite reaches the top of 8 equally relevant captures from rank ≤ ${climb.lexical} (lexical) / ≤ ${climb.deep} (deep)`);
  numbers.favoriteClimbsFromRank = climb;

  // --- Promise 2: favorites never outrank a clearly more relevant entry. Favorites: one capture in five, none of
  //     them a query target; every other one also carries an explicit helpful vote (the strongest lift). A vote
  //     moves trust for a favorite as for any entry, so a favorite above the target counts as a broken promise
  //     only when the same entry WITHOUT the favorite (its baseline + its explicit vote) would sit below it.
  const targets = new Set(queries.map((q) => q.target));
  const favorites = corpus.filter((c, i) => i % 5 === 2 && !targets.has(c.id)).map((c) => c.id);
  const voted = new Set(favorites.filter((_, i) => i % 2 === 1));
  for (const id of favorites) { o.memory.setFavorite(id, true); if (voted.has(id)) o.memory.recordFeedback(id, true); }
  const vote = o.cfg.trustWeight * 0.05;
  say(`\n4. ${favorites.length} favorites (${voted.size} also voted helpful: gain ${o.cfg.favoriteWeight} + ${o.cfg.favoriteHelpfulWeight} + 2 × ${vote}; the others ${o.cfg.favoriteWeight} + ${vote}), ${queries.length} queries × 2 passes:`);
  let above = 0, byVote = 0, guardFired = 0, unguardedAbove = 0, compared = 0;
  const unrelatedMargin = [], weakerMargin = [];
  const gainOf = (id) => o.cfg.favoriteWeight + vote + (voted.has(id) ? o.cfg.favoriteHelpfulWeight + vote : 0);
  const lift = gainOf([...voted][0]);
  for (const lexical of [true, false]) {
    const p = lexical ? 'lexical' : 'deep';
    for (const q of queries) {
      const words = [...new Set(contentWords(q.query))];
      const cov = (id) => { const have = new Set(contentWords(o.recall(id).content)); return words.filter((w) => have.has(w)).length / words.length; };
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
        const own = b.score + (voted.has(f) ? vote : 0); // the same entry without the favorite: baseline + its explicit vote
        if (fPos < tPos) { if (own > res[tPos].score) byVote++; else above++; }
        const margin = bt.score - b.score; // how far below the target the favorite sat before any favorite or vote
        (fCov === 0 ? unrelatedMargin : weakerMargin).push(margin);
        if (margin < gainOf(f)) unguardedAbove++; // its gain would carry it past the target without the guard
      }
    }
  }
  const mm = (xs) => (xs.length ? `min ${round6(Math.min(...xs))} median ${round6(pct(xs, 0.5))}` : 'n/a');
  say(`   comparisons (a favorite holding fewer of the query's words than the target): ${compared}`);
  say(`   base margin target − favorite, unrelated favorites (none of the words): ${unrelatedMargin.length} × ${mm(unrelatedMargin)}`);
  say(`   base margin target − favorite, partly matching favorites:               ${weakerMargin.length} × ${mm(weakerMargin)}`);
  say(`   the gain would carry ${unguardedAbove} of them past the target without the guard; guard fired ${guardFired}×`);
  say(`   placed above the target by the favorite: ${above}; by its explicit helpful vote alone (as for any entry, one rank step): ${byVote}`);
  numbers.unrelated = { compared, unrelatedMarginMin: unrelatedMargin.length ? round6(Math.min(...unrelatedMargin)) : null, unrelatedMarginMedian: round6(pct(unrelatedMargin, 0.5)), weakerMarginMin: weakerMargin.length ? round6(Math.min(...weakerMargin)) : null, weakerMarginMedian: round6(pct(weakerMargin, 0.5)), gainMax: round6(lift), wouldPassWithoutGuard: unguardedAbove, guardFired, placedAboveByFavorite: above, placedAboveByExplicitVote: byVote };
  ok(compared > 0 && above === 0, `no favorite carried by being a favorite above a target that holds more of the query's words (${compared} comparisons)`);
  ok(unrelatedMargin.length > 0 && Math.min(...unrelatedMargin) > 3 * lift, `an unrelated favorite sits far below the target: min margin ${round6(Math.min(...unrelatedMargin))} > 3 × the largest gain ${round6(lift)}`);

  // --- The adjacent-rank case the guard exists for: a favorite holding one of three words, one rank under the
  //     entry holding all three (a store this small has nothing between them). Lexical pass: a favorite alone;
  //     deep pass (three lanes, so one rank is worth more than one vote's trust nudge): favorite + helpful.
  const tiny = new Orchestrator({ dbPath: path.join(tmp, 'tiny.db'), vaultPath: path.join(tmp, 'vault'), llmEnabled: false, sourceRoots: [tmp], autoIngest: { enabled: false, onMaintain: false }, maintenance: { enabled: false, intervalMs: 3600e3 } });
  try {
    const strong = (await tiny.storeMemory({ content: 'Quorvex zibbon plavet: the quorvex ledger syncs zibbon shards across the plavet mesh.', tier: 'memory', type: 'note', scope: 'shared' })).id;
    const weak = (await tiny.storeMemory({ content: 'Plavet hosts keep the nightly backup window short.', tier: 'memory', type: 'note', scope: 'shared' })).id;
    const run = (lexicalOnly) => hybridSearch(tiny.db, tiny.memory, tiny.embedder, 'quorvex zibbon plavet', { limit: 5, lexicalOnly });
    const label = (rows) => rows.map((r) => `${r.id === strong ? 'strong' : 'weak'} ${r.score}${r.rank.favoriteGuard ? ' (guard)' : ''}`).join(', ');
    numbers.adjacentCase = {};
    for (const [lexical, voted] of [[true, false], [false, true]]) {
      const p = lexical ? 'lexical' : 'deep';
      tiny.memory.setFavorite(weak, false); tiny.db.prepare('UPDATE entries SET helpful_count = 0, trust_score = 0.5 WHERE id = ?').run(weak);
      const before = await run(lexical);
      const gap = before[0].score - before[1].score;
      tiny.memory.setFavorite(weak, true);
      if (voted) tiny.memory.recordFeedback(weak, true);
      const gain = o.cfg.favoriteWeight + (voted ? o.cfg.favoriteHelpfulWeight + o.cfg.trustWeight * 0.05 : 0) + o.cfg.trustWeight * 0.05;
      const after = await run(lexical);
      say(`\n5${lexical ? 'a' : 'b'}. two-entry store, ${p}: strong (3/3 words) ${round6(before[0].score)} vs weak (1/3) ${round6(before[1].score)} — gap ${round6(gap)} < gain ${round6(gain)}`);
      say(`    weak made a favorite${voted ? ' + helpful' : ''}: ${label(after)}`);
      numbers.adjacentCase[p] = { gap: round6(gap), gain: round6(gain), order: after.map((r) => (r.id === strong ? 'strong' : 'weak')), guard: !!after.find((r) => r.id === weak)?.rank.favoriteGuard };
      ok(before[0].id === strong && gap < gain && after[0].id === strong && after[1].rank.favoriteGuard === true, `${p}: the guard keeps the one-word favorite${voted ? ' (+ helpful)' : ''} under the all-words entry it would pass`);
    }
  } finally { tiny.close(); }

  if (JSON_ONLY) console.log(JSON.stringify(numbers));
  say(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
} catch (e) {
  console.error('\nFATAL:', e.stack); fail++;
} finally {
  o.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
}
