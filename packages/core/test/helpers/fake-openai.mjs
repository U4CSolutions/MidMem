/**
 * Fake OpenAI-compatible endpoint (the LM Studio shapes MidMem calls) on 127.0.0.1, ephemeral port —
 * no network. `POST /v1/chat/completions` answers like a reasoning model: thinking in
 * `message.reasoning_content`, the JSON answer in `message.content`. `POST /v1/embeddings` returns a
 * deterministic `dim`-wide vector per input. Behaviour is scripted per call through `state`:
 *   state.chat  = 'ok' | 'http-<status>' (e.g. 'http-500', 'http-400') | 'hang' | 'unparseable' | 'think' (inline <think> block before the JSON)
 *   state.queue = [behaviour, …] consumed first, one per chat call
 *   state.embed = 'ok' | 'http-500'
 * The 'ok' answer is built from the article text: a grounded summary (its first sentence), two
 * grounded concepts (`state.grounded(text)`), one fabricated concept, its first two sentences as
 * claims and one fabricated claim — so the grounding step must quarantine exactly 1 + 1.
 * Node built-ins only.
 */
import * as http from 'node:http';
import { createHash } from 'node:crypto';

export const FABRICATED_CONCEPT = 'Zanzibar quokka telemetry';
export const FABRICATED_CLAIM = 'The Andromeda treaty of 1823 banned submarine chess in Lisbon.';

const sentences = (text) => text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 15);

export async function startFakeOpenAI({ dim = 16 } = {}) {
  const state = { chat: 'ok', queue: [], embed: 'ok', chatCalls: 0, embedCalls: 0, models: [], grounded: () => [] };
  const answer = (text) => {
    const ss = sentences(text);
    return {
      summary: `Model summary: ${ss[0] || text.slice(0, 120)}`,
      concepts: [...state.grounded(text).map((name) => ({ name, type: 'concept', confidence: 0.9 })), { name: FABRICATED_CONCEPT, type: 'concept', confidence: 0.8 }],
      claims: [...ss.slice(0, 2).map((content) => ({ content: content.trim(), confidence: 0.8 })), { content: FABRICATED_CLAIM, confidence: 0.7 }],
    };
  };
  const vector = (s) => {
    const h = createHash('sha256').update(String(s)).digest();
    const v = Array.from({ length: dim }, (_, i) => (h[i % h.length] / 255) - 0.5);
    const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
    return v.map((x) => x / n);
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
      let msg = {};
      try { msg = JSON.parse(body || '{}'); } catch { return send(400, { error: 'bad JSON' }); }
      if (req.method === 'POST' && req.url === '/v1/embeddings') {
        state.embedCalls++;
        if (state.embed !== 'ok') return send(500, { error: 'embedder down' });
        return send(200, { data: [{ embedding: vector(msg.input), index: 0 }], model: msg.model });
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        state.chatCalls++;
        state.models.push(msg.model);
        const mode = state.queue.length ? state.queue.shift() : state.chat;
        if (mode === 'hang') return; // never answers: the caller's timeout fires
        if (/^http-\d{3}$/.test(mode)) return send(Number(mode.slice(5)), { error: `model answered ${mode}` });
        const user = msg.messages?.find((m) => m.role === 'user')?.content || '';
        const text = user.replace(/^type=[^\n]*\n\n/, '');
        const json = JSON.stringify(answer(text));
        const content = mode === 'unparseable' ? 'I am sorry, I cannot produce JSON for this article.'
          : mode === 'think' ? `<think>Plan: emit {"summary": …} with {"concepts": []} — then answer.</think>\n${json}` : json;
        return send(200, { choices: [{ index: 0, message: { role: 'assistant', reasoning_content: 'The user wants JSON. {draft} I will extract.', content }, finish_reason: 'stop' }], model: msg.model });
      }
      send(404, { error: 'not found' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  const close = () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
  return { url, state, close };
}
