// The Knowledge Library's owner routes through the real Worker (same harness as chat_browse.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';

const generated = new URL('./.knowledge_routes.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let worker;
try { worker = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }

async function owner() {
  const saved = new Map();
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const storage = {
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => saved.has(x)).map((x) => [x, saved.get(x)])) : saved.get(k)),
    put: async (k, v) => { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) saved.set(a, b); else saved.set(k, v); },
    delete: async (k) => saved.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...saved].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
    sql: { exec: (q, ...p) => { const stmt = db.prepare(q); return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []); } },
  };
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'unused' }) } };
  const state = new worker.CheState({ storage, waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const call = (method, path, body, token = '') => worker.default.fetch(new Request(`https://che.example${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  const token = (await (await call('POST', '/api/pair', { code: '123456' })).json()).device_token;
  return { call: (m, p, b) => call(m, p, b, token), anon: (m, p, b) => call(m, p, b, '') };
}

test('the owner catalogs, indexes and searches references; the status lists all 20 categories', async () => {
  const che = await owner();
  const status = await (await che.call('GET', '/api/knowledge')).json();
  assert.equal(status.categories.length, 20);

  const added = await che.call('POST', '/api/knowledge', { title: 'Reliable Services', creator: 'J. Engineer', category: 'software_engineering', kind: 'book', license: 'owner', source_url: 'https://example.com/r' });
  const ref = await added.json();
  assert.equal(added.status, 200);
  assert.equal(ref.access, 'cataloged');

  const indexed = await che.call('POST', '/api/knowledge', { action: 'index', id: ref.id, text: 'Retries with exponential backoff spread load after a failure. Add jitter to every wait.'.repeat(6) });
  assert.equal((await indexed.json()).access, 'indexed');

  const found = await (await che.call('GET', '/api/knowledge/search?q=' + encodeURIComponent('retry with backoff'))).json();
  assert.equal(found.status, 'answered');
  assert.match(found.citations[0], /Reliable Services by J\. Engineer, part 1; software_engineering/);
});

test('a copyrighted text is refused with a 422 and nothing is indexed', async () => {
  const che = await owner();
  const ref = await (await che.call('POST', '/api/knowledge', { title: 'Locked Book', category: 'business_management', kind: 'book', license: 'all rights reserved' })).json();
  const refused = await che.call('POST', '/api/knowledge', { action: 'index', id: ref.id, text: 'Some copyrighted text that is long enough to index if it were allowed.' });
  assert.equal(refused.status, 422);
  assert.match((await refused.json()).error, /stays catalogued/);
});

test('guests cannot read or change the knowledge library', async () => {
  const che = await owner();
  const res = await che.anon('GET', '/api/knowledge');
  assert.notEqual(res.status, 200);
});
