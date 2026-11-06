/**
 * Fake Qdrant (roadmap #50/#51 tests) — a `node:http` server on 127.0.0.1 imitating the v1.19.x
 * REST API (docs/redoc/v1.19.x, read 2026-09-24) for exactly the calls MidMem makes. Test-only;
 * no real Qdrant is ever contacted.
 *
 *   GET  /collections/{c}                 → { status, points_count, indexed_vectors_count, payload_schema, config }
 *   PUT  /collections/{c}                 { vectors: { size, distance } }  (409 if it exists)
 *   PUT  /collections/{c}/index           { field_name, field_schema }     (400 "Index already exists" on repeat)
 *   PUT  /collections/{c}/points          { points: [{ id, vector: number[], payload }] }  (upsert by id)
 *   POST /collections/{c}/points/query    { query: number[], filter?, limit, with_payload, with_vector }
 *   POST /collections/{c}/points/delete   { points: [ids] }
 *   POST /collections/{c}/points/count    { filter?, exact }
 *   POST /collections/{c}/points/scroll   { limit, offset?, filter?, with_payload, with_vector }
 *   POST /collections/{c}/points/search   → 404 (removed in 1.19)
 *
 * Rules enforced so the adapter cannot drift from the real server: point ids are unsigned integers or
 * UUID strings; an unnamed-vector collection takes a PLAIN number array of the collection size (a
 * named-vector object → 400); query vectors must match the size; bad JSON → 400; with `apiKey` set,
 * a request without the matching `api-key` header → 401. Scores are cosine similarity. Every reply
 * is `{ result, status: 'ok', time: 0 }` or `{ status: { error }, time: 0 }`, like Qdrant.
 */
import * as http from 'node:http';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DISTANCES = ['Cosine', 'Euclid', 'Dot', 'Manhattan'];

const isPointId = (id) => (Number.isSafeInteger(id) && id >= 0) || (typeof id === 'string' && UUID.test(id));
const idKey = (id) => `${typeof id}:${id}`;
const isNumArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'number' && Number.isFinite(x));
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const m = Math.sqrt(na) * Math.sqrt(nb);
  return m === 0 ? 0 : dot / m;
}

/** `filter.must[]` of `{ key, match: { value } }` — equality on payload keys (all must hold). */
function matches(point, filter) {
  if (!filter) return true;
  for (const cond of filter.must || []) {
    if (point.payload?.[cond.key] !== cond.match?.value) return false;
  }
  return true;
}

/** Scroll order: integer ids ascending, then UUIDs ascending (Qdrant scrolls by point id). */
const byId = (a, b) => {
  const ta = typeof a.id, tb = typeof b.id;
  if (ta !== tb) return ta === 'number' ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/** Start the fake: `{ url, close, state, setDown(bool), calls }` (calls: `{ method, path, query, body }`). */
export async function startFakeQdrant({ apiKey = null } = {}) {
  const state = { collections: new Map(), operationId: 0 };
  const calls = [];
  let down = false;

  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://fake');
    const call = { method: req.method, path: u.pathname, query: u.search.slice(1), body: undefined };
    calls.push(call);
    // Outage: no HTTP answer at all — the client sees a connection error.
    if (down) { req.socket.destroy(); return; }
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const ok = (result, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ result, status: 'ok', time: 0 })); };
      const fail = (status, error) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: { error }, time: 0 })); };
      if (apiKey && req.headers['api-key'] !== apiKey) return fail(401, 'Must provide an API key');
      let body = {};
      if (raw.length) {
        try { body = JSON.parse(raw); } catch { return fail(400, 'Format error in JSON body: bad JSON'); }
      }
      call.body = body;
      const m = /^\/collections\/([^/]+)(\/.*)?$/.exec(u.pathname);
      if (!m) return fail(404, `Not found: ${u.pathname}`);
      const name = decodeURIComponent(m[1]);
      const rest = m[2] || '';
      const col = state.collections.get(name);
      const missing = () => fail(404, `Not found: Collection \`${name}\` doesn't exist!`);
      const op = () => ({ operation_id: ++state.operationId, status: 'completed' });
      const route = `${req.method} ${rest}`;

      if (route === 'GET ') {
        if (!col) return missing();
        const n = col.points.size;
        const payload_schema = Object.fromEntries(Object.entries(col.indexes).map(([f, sch]) => [f, {
          data_type: sch.type, params: sch, points: [...col.points.values()].filter((p) => p.payload?.[f] !== undefined).length,
        }]));
        return ok({ status: 'green', optimizer_status: 'ok', points_count: n, indexed_vectors_count: n, segments_count: 1, payload_schema, config: { params: { vectors: { size: col.size, distance: col.distance } } } });
      }
      if (route === 'PUT ') {
        if (col) return fail(409, `Wrong input: Collection \`${name}\` already exists!`);
        const v = body.vectors;
        if (!isPlainObject(v) || !Number.isInteger(v.size) || v.size <= 0 || !DISTANCES.includes(v.distance)) {
          return fail(400, 'Wrong input: vectors must be { size: <positive integer>, distance: Cosine|Euclid|Dot|Manhattan }');
        }
        state.collections.set(name, { size: v.size, distance: v.distance, points: new Map(), indexes: {} });
        return ok(true);
      }
      if (route === 'POST /points/search') return fail(404, 'Not found: /points/search was removed in v1.19 — use /points/query');
      if (!col) return missing();

      if (route === 'PUT /index') {
        if (typeof body.field_name !== 'string' || !body.field_name) return fail(400, 'Wrong input: field_name is required');
        if (col.indexes[body.field_name]) return fail(400, 'Index already exists');
        col.indexes[body.field_name] = body.field_schema ?? null;
        return ok(op());
      }
      if (route === 'PUT /points') {
        if (!Array.isArray(body.points)) return fail(400, 'Wrong input: points must be an array');
        for (const p of body.points) {
          if (!isPlainObject(p) || !isPointId(p.id)) return fail(400, `Wrong input: point id ${JSON.stringify(p?.id)} is not an unsigned integer or a UUID`);
          if (!isNumArray(p.vector)) return fail(400, `Wrong input: point ${p.id} vector must be a plain number array (unnamed-vector collection)`);
          if (p.vector.length !== col.size) return fail(400, `Wrong input: Vector dimension error: expected dim: ${col.size}, got ${p.vector.length}`);
          if (p.payload !== undefined && p.payload !== null && !isPlainObject(p.payload)) return fail(400, `Wrong input: point ${p.id} payload must be an object`);
        }
        for (const p of body.points) col.points.set(idKey(p.id), { id: p.id, vector: p.vector.slice(), payload: p.payload ? { ...p.payload } : {} });
        return ok(op());
      }
      if (route === 'POST /points/query') {
        if (!isNumArray(body.query) || body.query.length !== col.size) return fail(400, `Wrong input: query must be a number array of dim ${col.size}`);
        const limit = Number.isInteger(body.limit) && body.limit > 0 ? body.limit : 10;
        const points = [...col.points.values()].filter((p) => matches(p, body.filter))
          .map((p) => ({ p, score: cosine(body.query, p.vector) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, limit)
          .map(({ p, score }) => ({ id: p.id, version: 0, score, ...(body.with_payload ? { payload: p.payload } : {}), ...(body.with_vector ? { vector: p.vector } : {}) }));
        return ok({ points });
      }
      if (route === 'POST /points/delete') {
        if (!Array.isArray(body.points)) return fail(400, 'Wrong input: points must be an array of ids');
        for (const id of body.points) col.points.delete(idKey(id));
        return ok(op());
      }
      if (route === 'POST /points/count') {
        return ok({ count: [...col.points.values()].filter((p) => matches(p, body.filter)).length });
      }
      if (route === 'POST /points/scroll') {
        const limit = Number.isInteger(body.limit) && body.limit > 0 ? body.limit : 10;
        const all = [...col.points.values()].filter((p) => matches(p, body.filter)).sort(byId);
        const start = body.offset === undefined || body.offset === null ? 0 : Math.max(0, all.findIndex((p) => p.id === body.offset));
        const page = all.slice(start, start + limit);
        const next = all[start + limit]?.id ?? null;
        return ok({
          points: page.map((p) => ({ id: p.id, ...(body.with_payload ? { payload: p.payload } : {}), ...(body.with_vector ? { vector: p.vector } : {}) })),
          next_page_offset: next,
        });
      }
      return fail(404, `Not found: ${req.method} ${u.pathname}`);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    calls,
    setDown: (v) => { down = !!v; if (down) server.closeAllConnections?.(); },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
