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
  //     alone (3a) and under one better match (3b), in both passes. Each favorite is also compared with its own
  //     twin — the same configuration with only THAT entry unstarred (it keeps its explicit vote): starring it never
  //     lowers it, and the better match stays above it unless its twin is above too (a pass earned by the entry's
  //     own explicit vote, which any non-favorite gets, is not the favorite's doing).
  const rolePass = async (trio, query, above = null) => {
    let ordered = 0, kept = 0, better = 0, ownVote = 0, total = 0, minMargin = Infinity;
    const roles = (fh, f, unstarred = null) => {
      resetVotes(trio);
      o.memory.recordFeedback(trio[fh], true); // fh's explicit helpful vote, starred or not
      if (unstarred !== fh) o.memory.setFavorite(trio[fh], true);
      if (unstarred !== f) o.memory.setFavorite(trio[f], true);
    };
    for (const [fh, f, n] of PERMS) {
      for (const lexical of [true, false]) {
        roles(fh, f); const res = await search(query, lexical);
        roles(fh, f, fh); const twinFH = (await search(query, lexical)).map((r) => r.id);
        roles(fh, f, f); const twinF = (await search(query, lexical)).map((r) => r.id);
        const at = (id) => res.findIndex((r) => r.id === id);
        const twins = [[trio[fh], twinFH], [trio[f], twinF]];
        total++;
        const order = [trio[fh], trio[f], trio[n]].map(at);
        if (order[0] < order[1] && order[1] < order[2]) ordered++;
        if (twins.every(([id, tw]) => at(id) <= tw.indexOf(id))) kept++;
        if (above === null || twins.every(([id, tw]) => at(above) < at(id) || tw.indexOf(id) < tw.indexOf(above))) better++;
        if (above !== null && at(trio[fh]) < at(above)) ownVote++;
        minMargin = Math.min(minMargin, res[order[0]].score - res[order[1]].score, res[order[1]].score - res[order[2]].score);
      }
    }
    resetVotes(trio);
    return { ordered, kept, better, ownVote, total, minMargin };
  };
  const sum = (rs) => rs.reduce((a, r) => ({ ordered: a.ordered + r.ordered, kept: a.kept + r.kept, better: a.better + r.better, ownVote: a.ownVote + r.ownVote, total: a.total + r.total, minMargin: Math.min(a.minMargin, r.minMargin) }), { ordered: 0, kept: 0, better: 0, ownVote: 0, total: 0, minMargin: Infinity });
  say('\n3a. favorite + helpful > favorite > neither among equally relevant captures (6 role assignments × 3 groups × 2 passes):');
  const r3 = []; for (const { ids, query } of groups) r3.push(await rolePass(ids.slice(0, 3), query));
  const s3 = sum(r3);
  say(`    ordered ${s3.ordered}/${s3.total}; starred ≥ unstarred ${s3.kept}/${s3.total}; smallest winning margin ${round6(s3.minMargin)}`);
  ok(s3.ordered === s3.total && s3.kept === s3.total && s3.minMargin > 0, `favorite + helpful > favorite > neither in every assignment and pass (${s3.ordered}/${s3.total}), never below the unstarred twin`);
  say('3b. the same trio under ONE better match (all words vs one of three):');
  const r3b = []; for (const { strongId, trio, query } of betters) r3b.push(await rolePass(trio, query, strongId));
  const s3b = sum(r3b);
  say(`    favorite + helpful > favorite > neither ${s3b.ordered}/${s3b.total}; starred ≥ unstarred ${s3b.kept}/${s3b.total}; the better match above every favorite it out-ranks unstarred ${s3b.better}/${s3b.total} (favorite + helpful above it on its own vote: ${s3b.ownVote}); smallest margin inside the trio ${s3b.minMargin.toExponential(2)}`);
  numbers.equalRelevanceOrder = { alone: { ordered: s3.ordered, kept: s3.kept, of: s3.total, minMargin: round6(s3.minMargin) }, underBetterMatch: { ordered: s3b.ordered, kept: s3b.kept, better: s3b.better, ownVotePasses: s3b.ownVote, of: s3b.total, minMargin: s3b.minMargin } };
  ok(s3b.ordered === s3b.total && s3b.kept === s3b.total && s3b.better === s3b.total && s3b.minMargin > 0, `under one better match: the order holds, starred ≥ unstarred, and only an entry's own vote passes the better match (${s3b.ordered}/${s3b.total})`);

  // --- 3c. Starring never lowers an entry (the round-2 inversion): each member of each better-match trio carries
  //         one explicit helpful vote; unstarred vs starred, both passes (3 fixtures × 3 members × 2 = 18).
  let inv = 0, invTotal = 0, invLifted = 0, invLiftedKept = 0;
  for (const { strongId, trio, query } of betters) {
    for (const m of trio) {
      for (const lexical of [true, false]) {
        resetVotes(trio); o.memory.recordFeedback(m, true);
        const u = await search(query, lexical);
        o.memory.setFavorite(m, true);
        const s = await search(query, lexical);
        const at = (res, id) => res.findIndex((r) => r.id === id);
        invTotal++;
        if (at(s, m) <= at(u, m)) inv++;
        if (at(u, m) < at(u, strongId)) { invLifted++; if (at(s, m) < at(s, strongId)) invLiftedKept++; }
      }
    }
    resetVotes(trio);
  }
  say(`3c. starred ≥ unstarred, one explicit vote each: ${inv}/${invTotal}; ${invLifted} rank above the better match on their own vote, ${invLiftedKept} of them still above it starred`);
  numbers.starredNeverLower = { ok: inv, of: invTotal, aboveOnOwnVote: invLifted, keptStarred: invLiftedKept };
  ok(inv === invTotal && invLiftedKept === invLifted, `starring never lowers an entry (${inv}/${invTotal})`);

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
  // The unstarred twin of a run (the same explicit votes, no favorites) decides what is the favorite's doing: a
  // favorite above the target is a broken promise only when its twin sits below the target.
  const twinRuns = async (passes) => {
    const twin = new Map();
    for (const id of favorites) if (voted.has(id)) o.memory.recordFeedback(id, true);
    for (const lexical of passes) for (const q of queries) twin.set(`${lexical ? 'lexical' : 'deep'}|${q.query}`, (await search(q.query, lexical)).map((r) => r.id));
    for (const id of favorites) o.memory.setFavorite(id, true);
    return twin;
  };
  const promise2 = async (passes, twin) => {
    let above = 0, aboveByRelevance = 0, aboveByOwnVote = 0, guardFired = 0, unguardedAbove = 0, compared = 0;
    const unrelatedMargin = [], weakerMargin = [];
    for (const lexical of passes) {
      const p = lexical ? 'lexical' : 'deep';
      for (const q of queries) {
        const words = [...new Set(coverageWords(q.query))];
        const cov = (id) => { const have = new Set(coverageWords(o.recall(id).content)); return words.filter((w) => have.has(w)).length / words.length; };
        const before = baseline.get(`${p}|${q.query}`);
        const tw = twin.get(`${p}|${q.query}`);
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
          // Above the target by its own relevance (a dense vector lane can rank a weaker word match first) or by its
          // own explicit vote (its unstarred twin is above too): not the favorite's doing. Otherwise: broken.
          if (fPos < tPos) { if (margin <= 0) aboveByRelevance++; else if (tw.indexOf(f) < tw.indexOf(q.target)) aboveByOwnVote++; else above++; }
          (fCov === 0 ? unrelatedMargin : weakerMargin).push(margin);
          if (margin > 0 && margin < gainOf(f)) unguardedAbove++;
        }
      }
    }
    return { above, aboveByRelevance, aboveByOwnVote, guardFired, unguardedAbove, compared, unrelatedMargin, weakerMargin };
  };
  const twinHash = await twinRuns([true, false]);
  const mm = (xs) => (xs.length ? `min ${round6(Math.min(...xs))} median ${round6(pct(xs, 0.5))}` : 'n/a');
  const lift = gainOf([...voted][0]);
  say(`\n4. ${favorites.length} favorites (${voted.size} also voted helpful: gain ${o.cfg.favoriteWeight} + ${o.cfg.favoriteHelpfulWeight} + 2 × ${vote}; the others ${o.cfg.favoriteWeight} + ${vote}), ${queries.length} queries × 2 passes, hash vectors:`);
  const p2 = await promise2([true, false], twinHash);
  say(`   comparisons (a favorite holding fewer of the query's words than the target): ${p2.compared}`);
  say(`   base margin target − favorite, unrelated favorites (none of the words): ${p2.unrelatedMargin.length} × ${mm(p2.unrelatedMargin)}`);
  say(`   base margin target − favorite, partly matching favorites:               ${p2.weakerMargin.length} × ${mm(p2.weakerMargin)}`);
  say(`   the gain would carry ${p2.unguardedAbove} of them past the target without the guard; guard fired ${p2.guardFired}×; placed above the target by the favorite: ${p2.above} (by the entry's own explicit vote, as unstarred: ${p2.aboveByOwnVote})`);
  numbers.promise2Hash = { compared: p2.compared, unrelatedMarginMin: round6(Math.min(...p2.unrelatedMargin)), unrelatedMarginMedian: round6(pct(p2.unrelatedMargin, 0.5)), weakerMarginMin: round6(Math.min(...p2.weakerMargin)), weakerMarginMedian: round6(pct(p2.weakerMargin, 0.5)), gainMax: round6(lift), wouldPassWithoutGuard: p2.unguardedAbove, guardFired: p2.guardFired, placedAbove: p2.above, aboveByOwnVote: p2.aboveByOwnVote };
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
  const r6 = [];
  for (const { ids, query } of groups) r6.push(await rolePass(ids.slice(0, 3), query));
  for (const { strongId, trio, query } of betters) r6.push(await rolePass(trio, query, strongId));
  const s6 = sum(r6);
  say(`6a. dense vectors, alone and under a better match: favorite + helpful > favorite > neither ${s6.ordered}/${s6.total}; starred ≥ unstarred ${s6.kept}/${s6.total}; the better match above every favorite it out-ranks unstarred ${s6.better}/${s6.total} (own-vote passes ${s6.ownVote})`);
  ok(s6.ordered === s6.total && s6.kept === s6.total && s6.better === s6.total, `dense: the favorite order holds, starred ≥ unstarred, only an entry's own vote passes a better match (${s6.ordered}/${s6.total})`);
  numbers.dense.order = { ordered: s6.ordered, kept: s6.kept, better: s6.better, ownVotePasses: s6.ownVote, of: s6.total };

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
      let held = 0, above = 0, ownVote = 0, wouldPass = 0;
      for (const fr of inTopK) {
        multi.memory.recordFeedback(fr.id, true);
        const twin = (await run()).map((r) => r.id); // its explicit vote alone, unstarred
        multi.memory.setFavorite(fr.id, true);
        const res = await run();
        const fPos = res.findIndex((r) => r.id === fr.id), sPos = res.findIndex((r) => r.id === strongId);
        if (fPos < sPos) { if (twin.indexOf(fr.id) < twin.indexOf(strongId)) ownVote++; else above++; }
        if (res[fPos].rank.favoriteGuard) held++;
        if (base[0].score - fr.score < o.cfg.favoriteWeight + o.cfg.favoriteHelpfulWeight + 2 * vote) wouldPass++;
        multi.db.prepare('UPDATE entries SET favorite = 0, favorite_helpful = 0, helpful_count = 0, trust_score = 0.5 WHERE id = ?').run(fr.id);
      }
      say(`6c. ${set.lang} query "${set.q}": lexical hits ${lexical}; the all-words entry is #${base.findIndex((r) => r.id === strongId) + 1} (vector rank ${base.find((r) => r.id === strongId).rank.vector}); coverage words ${JSON.stringify(coverageWords(set.q))} (grounding's ASCII-only contentWords: ${JSON.stringify(contentWords(set.q))})`);
      say(`    ${inTopK.length} favorites (+ helpful) inside the vector top ${k}, one at a time: their lift would carry ${wouldPass} past it; held by the guard ${held}; above it on their own explicit vote (as unstarred) ${ownVote}; placed above it by the favorite ${above}`);
      numbers.dense.nonLatin[set.lang] = { lexicalHits: lexical, strongPosition: base.findIndex((r) => r.id === strongId) + 1, tried: inTopK.length, wouldPassOnLift: wouldPass, held, aboveOnOwnVote: ownVote, placedAbove: above };
      ok(lexical === 0 && base[0].id === strongId && inTopK.length > 0 && wouldPass === inTopK.length && held + ownVote === inTopK.length && held > 0 && above === 0,
        `dense, ${set.lang}: no favorite passes the entry holding the query's words by being a favorite (${inTopK.length} tried: ${held} held by the Unicode guard, ${ownVote} above on their own vote)`);
    }
  } finally { multi.close(); }

  // 6d. Promise 2 with dense vectors, deep pass (re-baselined: the vectors changed).
  for (const q of queries) baseline.set(`deep|${q.query}`, await search(q.query, false));
  const twinDense = await twinRuns([false]);
  const p2d = await promise2([false], twinDense);
  say(`6d. promise 2, dense vectors, deep pass: ${p2d.compared} comparisons; unrelated favorites' base margin ${mm(p2d.unrelatedMargin)}; partly matching ${mm(p2d.weakerMargin)}`);
  say(`    the gain would carry ${p2d.unguardedAbove} past the target without the guard; guard fired ${p2d.guardFired}×; placed above the target by the favorite: ${p2d.above} (above it by their own relevance already: ${p2d.aboveByRelevance}; by their own explicit vote: ${p2d.aboveByOwnVote})`);
  numbers.dense.promise2 = { compared: p2d.compared, unrelatedMarginMin: p2d.unrelatedMargin.length ? round6(Math.min(...p2d.unrelatedMargin)) : null, unrelatedMarginMedian: round6(pct(p2d.unrelatedMargin, 0.5)), weakerMarginMin: p2d.weakerMargin.length ? round6(Math.min(...p2d.weakerMargin)) : null, wouldPassWithoutGuard: p2d.unguardedAbove, guardFired: p2d.guardFired, placedAbove: p2d.above, aboveByOwnRelevance: p2d.aboveByRelevance, aboveByOwnVote: p2d.aboveByOwnVote };
  ok(p2d.compared > 0 && p2d.above === 0, `dense: no favorite placed above a target that holds more of the query's words (${p2d.compared} comparisons)`);
  for (const id of favorites) o.memory.setFavorite(id, false);
  resetVotes(favorites);

  // --- 7. Question-form queries (round 2): "what did the <subject> say about the <topic>". 3+-letter stopwords (the,
  //        did, about) and trigram substrings give nearly every entry a lexical hit, so the lexical gate wants one of
  //        the query's content words in the favorite. Five unrelated favorites (+ helpful) may reach the top 3 no more
  //        often than the same five unstarred; a target that is a favorite keeps its own gain.
  const qs = new Orchestrator({ dbPath: path.join(tmp, 'questions.db'), vaultPath: path.join(tmp, 'vault'), llmEnabled: false, sourceRoots: [tmp], autoIngest: { enabled: false, onMaintain: false }, maintenance: { enabled: false, intervalMs: 3600e3 } });
  try {
    const SUBJ = ['minister', 'mayor', 'coach', 'surgeon', 'banker', 'farmer', 'pilot', 'curator', 'judge', 'senator', 'chemist', 'ranger', 'sailor', 'teacher', 'engineer'];
    const TOPIC = ['tariffs', 'potholes', 'transfers', 'vaccines', 'mortgages', 'droughts', 'runways', 'exhibits', 'appeals', 'ballots', 'solvents', 'wildfires', 'moorings', 'exams', 'viaducts'];
    const PLACES = ['in the capital', 'at the council', 'on the radio', 'at the summit', 'in the paper', 'at the hearing'];
    const put = async (content) => (await qs.storeMemory({ content, tier: 'memory', type: 'note', scope: 'shared' })).id;
    const qTargets = [];
    for (let i = 0; i < SUBJ.length; i++) qTargets.push(await put(`The ${SUBJ[i]} said the ${TOPIC[i]} would change after the meeting ${PLACES[i % PLACES.length]}.`));
    for (let i = 0; i < SUBJ.length; i++) for (const j of [3, 7]) await put(`The ${SUBJ[i]} spoke about the ${TOPIC[(i + j) % TOPIC.length]} ${PLACES[(i + j) % PLACES.length]} and the plans for the year.`);
    const unrelated = [];
    for (const t of ['The museum reopened its gallery about the history of the old harbour wall.', 'The library said the reading room will stay open late during the festival.', 'A choir sang about the river at the opening of the new park.',
      'The bakery on the square added rye loaves and a sourdough class for the autumn.', 'Volunteers cleared the trail and talked about the birds that nest by the lake.']) unrelated.push(await put(t));
    // Two forms: DIRECT (the target holds the subject and the topic) and SYNONYM (no capture holds the query's
    // content words, so every lexical hit is a stopword hit — the review's "what did the <synonym> say about the
    // <synonym>"). The synonym form's DEEP pass is reported, not asserted: the offline hash embedder hashes
    // stopwords like content words, so its vector top 10 for such a question is stopword overlap, not meaning.
    const SUBJ_SYN = ['statesman', 'alderman', 'trainer', 'medic', 'financier', 'grower', 'aviator', 'keeper', 'magistrate', 'lawmaker', 'pharmacist', 'warden', 'mariner', 'educator', 'technician'];
    const TOPIC_SYN = ['levies', 'craters', 'trades', 'jabs', 'loans', 'aridity', 'airstrips', 'displays', 'petitions', 'votes', 'thinners', 'blazes', 'berths', 'tests', 'overpasses'];
    const forms = {
      direct: SUBJ.map((s, i) => ({ q: `what did the ${s} say about the ${TOPIC[i]}`, target: qTargets[i] })),
      synonym: SUBJ_SYN.map((s, i) => ({ q: `what did the ${s} say about the ${TOPIC_SYN[i]}`, target: qTargets[i] })),
    };
    const top3 = async (q, lexicalOnly) => (await hybridSearch(qs.db, qs.memory, qs.embedder, q, { limit: 10, lexicalOnly })).slice(0, 3).map((r) => r.id);
    const intrusions = async (list, lexicalOnly) => { let n = 0; for (const { q } of list) if ((await top3(q, lexicalOnly)).some((id) => unrelated.includes(id))) n++; return n; };
    const res7 = {};
    for (const [form, list] of Object.entries(forms)) {
      for (const lexicalOnly of [true, false]) {
        const p = lexicalOnly ? 'lexical' : 'deep';
        const plain = await intrusions(list, lexicalOnly);
        for (const id of unrelated) { qs.memory.setFavorite(id, true); qs.memory.recordFeedback(id, true); }
        const starred = await intrusions(list, lexicalOnly);
        for (const id of unrelated) qs.db.prepare('UPDATE entries SET favorite = 0, favorite_helpful = 0, helpful_count = 0, trust_score = 0.5 WHERE id = ?').run(id);
        // A starred target that holds the query's words keeps its gain (the direct form).
        let gained = null;
        if (form === 'direct') {
          gained = 0;
          for (const { q, target } of list) {
            qs.memory.setFavorite(target, true);
            const row = (await hybridSearch(qs.db, qs.memory, qs.embedder, q, { limit: 10, lexicalOnly })).find((r) => r.id === target);
            if (row?.rank.favorite === qs.cfg.favoriteWeight) gained++;
            qs.memory.setFavorite(target, false);
          }
        }
        const anyHit = (await hybridSearch(qs.db, qs.memory, qs.embedder, list[0].q, { limit: 400, lexicalOnly: true })).filter((r) => r.rank.fts || r.rank.trigram).length;
        res7[`${form}/${p}`] = { unrelatedInTop3Unstarred: plain, unrelatedInTop3Starred: starred, ...(gained !== null ? { targetsBoosted: gained } : {}), of: list.length, lexicalHitsOfOneQuestion: anyHit };
        say(`${form === 'direct' && lexicalOnly ? '\n7.' : '  '} question-form (${form}, ${p}): 5 unrelated captures in a top 3 — unstarred ${plain}/15, starred (+ helpful) ${starred}/15${gained !== null ? `; a starred target keeps its boost ${gained}/15` : ''}${lexicalOnly ? ` (one question is a lexical hit for ${anyHit} of ${SUBJ.length * 3 + 5} entries)` : ''}`);
      }
    }
    numbers.questionForm = res7;
    ok(['direct/lexical', 'synonym/lexical', 'direct/deep'].every((k2) => res7[k2].unrelatedInTop3Starred <= res7[k2].unrelatedInTop3Unstarred) && res7['direct/lexical'].targetsBoosted === 15 && res7['direct/deep'].targetsBoosted === 15,
      'question form: starring unrelated captures adds no intrusion into a top 3 on the lexical side (direct and synonym questions), and a starred target holding the words keeps its boost');
  } finally { qs.close(); }

  // --- 8. Cost (round 2): 600 favorites among 800 entries, one 60-word query, the lexical pass (median of 7 runs).
  const perf = new Orchestrator({ dbPath: path.join(tmp, 'perf.db'), vaultPath: path.join(tmp, 'vault'), llmEnabled: false, sourceRoots: [tmp], autoIngest: { enabled: false, onMaintain: false }, maintenance: { enabled: false, intervalMs: 3600e3 } });
  try {
    const words = [...SHARED, ...Object.values(topicWords).flat()];
    const perfIds = [];
    for (let i = 0; i < 800; i++) {
      const body = Array.from({ length: 40 }, () => pick(words)).join(' ');
      const content = i % 4 === 1 ? `It’s ${body} — said the report.` : i % 4 === 3 ? `${body} 灯塔修复工程在海岸边顺利完成。` : body; // ASCII, curly punctuation, mixed CJK
      perfIds.push((await perf.storeMemory({ content, tier: 'memory', type: 'note', scope: 'shared' })).id);
    }
    const q60 = Array.from({ length: 60 }, () => pick(words)).join(' ');
    const time = async () => { const ms = []; for (let i = 0; i < 7; i++) { const t = process.hrtime.bigint(); await hybridSearch(perf.db, perf.memory, perf.embedder, q60, { limit: 20, lexicalOnly: true }); ms.push(Number(process.hrtime.bigint() - t) / 1e6); } return round6(pct(ms, 0.5)); };
    const without = await time();
    for (const id of perfIds.slice(0, 600)) perf.memory.setFavorite(id, true);
    const withFav = await time();
    const cwT = process.hrtime.bigint(); for (let i = 0; i < 200; i++) coverageWords(perf.recall(perfIds[3]).content); const cwMs = Number(process.hrtime.bigint() - cwT) / 1e6 / 200;
    say(`\n8. cost, lexical pass, 800 entries, a 60-word query (median of 7): no favorites ${without.toFixed(1)} ms; 600 favorites ${withFav.toFixed(1)} ms; coverageWords on one mixed-script entry ${(cwMs * 1000).toFixed(0)} µs`);
    numbers.cost = { entries: 800, favorites: 600, queryWords: 60, lexicalMsWithoutFavorites: without, lexicalMsWith600Favorites: withFav, coverageWordsMicrosPerMixedEntry: Math.round(cwMs * 1000) };
  } finally { perf.close(); }

  if (JSON_ONLY) console.log(JSON.stringify(numbers));
  say(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
} catch (e) {
  console.error('\nFATAL:', e.stack); fail++;
} finally {
  o.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
}
