// The owner's chat reaches the browsing loop and the sub-agents through /api/chat. Offline: no page is fetched,
// and the model returns no plan, so every search must end honestly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';

const generated = new URL('./.chat_browse.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let worker;
try { worker = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }

async function owner() {
  const saved = new Map();
  const storage = {
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => saved.has(x)).map((x) => [x, saved.get(x)])) : saved.get(k)),
    put: async (k, v) => { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) saved.set(a, b); else saved.set(k, v); },
    delete: async (k) => saved.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...saved].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'Here is my answer.' }) } };
  const state = new worker.CheState({ storage, waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const post = (path, body, token = '') => worker.default.fetch(new Request(`https://che.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }), env);
  const token = (await (await post('/api/pair', { code: '123456' })).json()).device_token;
  return {
    ask: async (message) => {
      const res = await post('/api/chat', { message, agent_mode: 'full' }, token);
      // The owner's chat answers either as one JSON object or as a stream of NDJSON lines (deltas, then done).
      const raw = await res.text();
      try { return { status: res.status, body: JSON.parse(raw) }; } catch (_) { /* a stream */ }
      const items = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const done = items.find((item) => item.type === 'done') || {};
      const streamed = items.filter((item) => item.type === 'delta').map((item) => item.delta).join('');
      return { status: res.status, body: { ...done, message: done.message ?? streamed } };
    },
    tasks: () => (saved.get('che')?.team_tasks || []),
  };
}

test('a web search goes to the loop; with no plan it says so, and no model guess is shown', async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('offline'); };
  t.after(() => { globalThis.fetch = realFetch; });
  const che = await owner();
  const { status, body } = await che.ask('Browse the web for the history of pizza');
  assert.equal(status, 200);
  assert.equal(body.source, 'che_browse');
  assert.match(body.message, /could not decide the next step/);
  assert.doesNotMatch(body.message, /Here is my answer/);
});

test('a question about search, and a search of the owner\'s memory, do not enter the browse route', async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('offline'); };
  t.after(() => { globalThis.fetch = realFetch; });
  const che = await owner();
  const question = await che.ask("Shouldn't searching the web be free?");
  assert.notEqual(question.body.source, 'che_browse');
  const memory = await che.ask('Search my long-term memory for Atlas');
  assert.notEqual(memory.body.source, 'che_browse');
});

test('an original story goes to Mira as a queued task, and CHE says who has it', async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('offline'); };
  t.after(() => { globalThis.fetch = realFetch; });
  const che = await owner();
  const { body } = await che.ask('Write an original story about a lighthouse keeper');
  assert.equal(body.source, 'che_browse');
  assert.match(body.message, /Mira is working on it: write an original story\. Mira will hand the result to me for review; ask me for it when it is back\./);
  const queued = che.tasks().find((task) => task.partner_name === 'Mira' && task.source === 'owner_chat');
  assert.ok(queued, 'the story task is in the team queue');
  assert.match(queued.task, /original story/);
});
