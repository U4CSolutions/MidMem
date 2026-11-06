/**
 * Fake library provider (roadmap #49 tests) over the frozen contract fixture
 * `test/fixtures/library-provider.json`. Deterministic: a chunk scores the share of the query's
 * tokens (lowercased, letters/digits, ≥3 chars) present among the chunk's own tokens. Read-only.
 */
import * as http from 'node:http';

const tokens = (s) => (String(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((t) => t.length >= 3);

/** The contract's tie rule: score desc, then libraryId, docId, chunkId ascending. */
const byContract = (a, b) => (b.score - a.score)
  || (a.libraryId < b.libraryId ? -1 : a.libraryId > b.libraryId ? 1 : 0)
  || (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0)
  || (a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0);

/** A provider `{ search, get }` over one fixture library (default: the first). */
export function makeProvider(fixture, { libraryId } = {}) {
  const lib = fixture.libraries.find((l) => l.libraryId === libraryId) || fixture.libraries[0];
  const id = libraryId || lib.libraryId;
  const docs = new Map(lib.documents.map((d) => [d.docId, d]));

  const passes = (doc, filters) => {
    if (!filters) return true;
    if (filters.site != null && String(doc.site).toLowerCase() !== String(filters.site).toLowerCase()) return false;
    if (filters.captureMethod != null && doc.captureMethod !== filters.captureMethod) return false;
    const at = Date.parse(doc.capturedAt);
    if (filters.capturedAfter != null && !(at >= Date.parse(filters.capturedAfter))) return false;
    if (filters.capturedBefore != null && !(at <= Date.parse(filters.capturedBefore))) return false;
    return true;
  };

  async function search(query, { limit = 10, filters = null } = {}) {
    if (filters?.libraryId != null && filters.libraryId !== id) return [];
    const q = [...new Set(tokens(query))];
    if (!q.length) return [];
    const rows = [];
    for (const ch of lib.chunks) {
      const doc = docs.get(ch.docId);
      if (!doc || !passes(doc, filters)) continue;
      const have = new Set(tokens(ch.text));
      const score = q.filter((t) => have.has(t)).length / q.length;
      if (score <= 0) continue;
      rows.push({
        libraryId: id, docId: ch.docId, chunkId: ch.chunkId, text: ch.text, score,
        locator: { docId: ch.docId, version: ch.version, charStart: ch.charStart, charEnd: ch.charEnd },
        sourceUri: doc.sourceUri, capturedAt: doc.capturedAt,
      });
    }
    return rows.sort(byContract).slice(0, limit);
  }

  async function get(docId, locator) {
    const doc = docs.get(docId);
    if (!doc) throw new Error(`unknown docId: ${docId}`);
    if (!locator || locator.version !== doc.version) throw new Error(`locator version ${locator?.version} does not match ${docId} v${doc.version}`);
    const { charStart, charEnd } = locator;
    if (!Number.isInteger(charStart) || !Number.isInteger(charEnd) || charStart < 0 || charEnd < charStart || charEnd > doc.text.length) {
      throw new Error(`locator ${charStart}..${charEnd} is outside ${docId} (length ${doc.text.length})`);
    }
    return { text: doc.text.slice(charStart, charEnd), locator, sourceUri: doc.sourceUri };
  }

  return { search, get };
}

/** Serve a provider over HTTP on 127.0.0.1 (ephemeral port): POST /search, POST /get → JSON. */
export async function startHttpProvider(provider) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const verb = (req.url || '').replace(/\/+$/, '').split('/').pop();
      if (req.method !== 'POST' || !['search', 'get'].includes(verb)) return send(404, { error: 'not found' });
      let msg;
      try { msg = JSON.parse(body); } catch { return send(400, { error: 'bad JSON' }); }
      try {
        const out = verb === 'search'
          ? await provider.search(msg.query, { limit: msg.limit, filters: msg.filters ?? null })
          : await provider.get(msg.docId, msg.locator);
        send(200, out);
      } catch (e) { send(500, { error: String(e?.message || e) }); }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

/** Wrap a provider so every search/get call is counted: `{ search, get, counts: { search, get } }`. */
export function makeCallCounter(provider) {
  const counts = { search: 0, get: 0 };
  return {
    counts,
    search: (...args) => { counts.search++; return provider.search(...args); },
    get: (...args) => { counts.get++; return provider.get(...args); },
  };
}
