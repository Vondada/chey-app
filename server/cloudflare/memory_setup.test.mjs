import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { checkAllKeys, memorySetupIntent, memorySetupSteps, normalizeMemoryUrl, removeMemoryDatabase, saveMemoryDatabase, storedKeys, withStoredKeys } from './resilience.js';
import { vectorMemoryReadiness } from './vector_memory.js';

const memory = () => { const m = new Map(); return { m, get: async (k) => structuredClone(m.get(k)), put: async (k, v) => { m.set(k, structuredClone(v)); } }; };
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.service-role-key-for-tests';

test('voice phrases and steps for the memory database', () => {
  for (const p of ['set up the memory database', 'Che, connect your vector memory', 'turn on long-term memory', 'set up supabase']) assert.ok(memorySetupIntent(p), p);
  assert.ok(!memorySetupIntent('what do you remember about my trip'));
  const steps = memorySetupSteps('https://github.com/o/r/blob/main/server/cloudflare/pgvector_setup.sql', 'https://che.example/app');
  assert.match(steps, /SQL editor/);
  assert.match(steps, /https:\/\/che\.example\/app/);
  assert.match(steps, /do not paste them into chat/);
});

test('Supabase project URLs get the PostgREST path; non-https is refused', () => {
  assert.equal(normalizeMemoryUrl('https://abc.supabase.co/'), 'https://abc.supabase.co/rest/v1');
  assert.equal(normalizeMemoryUrl('https://db.example.com/rest/v1'), 'https://db.example.com/rest/v1');
  assert.equal(normalizeMemoryUrl('http://abc.supabase.co'), '');
  assert.equal(normalizeMemoryUrl('javascript:alert(1)'), '');
});

test('a tested database is saved server-side and switches long-term memory on', async () => {
  const storage = memory();
  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url, auth: init.headers.Authorization }); return new Response('[]', { status: 200 }); };
  const out = await saveMemoryDatabase(storage, 'https://abc.supabase.co', TOKEN, fetcher);
  assert.equal(out.ok, true);
  assert.equal(calls[0].url, 'https://abc.supabase.co/rest/v1/che_memory?select=external_id&limit=1');
  const env = withStoredKeys({ AI: {} }, await storedKeys(storage));
  assert.equal(vectorMemoryReadiness(env).configured, true);
  await removeMemoryDatabase(storage);
  assert.equal(vectorMemoryReadiness(withStoredKeys({ AI: {} }, await storedKeys(storage))).configured, false);
});

test('a missing table or a bad key is explained and nothing is saved', async () => {
  const storage = memory();
  const missing = await saveMemoryDatabase(storage, 'https://abc.supabase.co', TOKEN, async () => new Response('{}', { status: 404 }));
  assert.match(missing.detail, /run the setup script/);
  const bad = await saveMemoryDatabase(storage, 'https://abc.supabase.co', TOKEN, async () => new Response('{}', { status: 401 }));
  assert.match(bad.detail, /service_role key/);
  assert.deepEqual(await storedKeys(storage), {});
});

test('a key that can read but not write (anon behind row-level security) is refused', async () => {
  const storage = memory();
  const fetcher = async (url, init = {}) => new Response(init.method === 'POST' ? '{"code":"42501"}' : '[]', { status: init.method === 'POST' ? 401 : 200 });
  const out = await saveMemoryDatabase(storage, 'https://abc.supabase.co', TOKEN, fetcher);
  assert.equal(out.ok, false);
  assert.match(out.detail, /cannot save memories/);
  assert.deepEqual(await storedKeys(storage), {});
});

test('the connection check writes one marker row and deletes it again', async () => {
  const calls = [];
  const fetcher = async (url, init = {}) => { calls.push({ url, method: init.method || 'GET', body: init.body }); return new Response(null, { status: init.method ? 201 : 200 }); };
  const out = await saveMemoryDatabase(memory(), 'https://abc.supabase.co', TOKEN, fetcher);
  assert.equal(out.ok, true);
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'POST', 'DELETE']);
  const row = JSON.parse(calls[1].body);
  assert.equal(row.embedding.length, 768);
  assert.equal(calls[2].url, `https://abc.supabase.co/rest/v1/che_memory?external_id=eq.${row.external_id}`);
});

test('a database connected through CHE replaces an older Worker secret pair', async () => {
  const storage = memory();
  await saveMemoryDatabase(storage, 'https://new.supabase.co', TOKEN, async (url, init = {}) => new Response(null, { status: init.method ? 201 : 200 }));
  const env = withStoredKeys({ CHE_PGVECTOR_REST_URL: 'https://old.example.com/rest/v1', CHE_PGVECTOR_TOKEN: 'old-token-old-token-old', GROQ_API_KEY: 'secret' }, await storedKeys(storage));
  assert.equal(env.CHE_PGVECTOR_REST_URL, 'https://new.supabase.co/rest/v1');
  assert.equal(env.CHE_PGVECTOR_TOKEN, TOKEN);
  await removeMemoryDatabase(storage);
  assert.equal(withStoredKeys({ CHE_PGVECTOR_REST_URL: 'https://old.example.com/rest/v1' }, await storedKeys(storage)).CHE_PGVECTOR_REST_URL, 'https://old.example.com/rest/v1');
});

test('the engine key check keeps the memory database status', async () => {
  const storage = memory();
  await saveMemoryDatabase(storage, 'https://abc.supabase.co', TOKEN, async (url, init = {}) => new Response(null, { status: init.method ? 201 : 200 }));
  await checkAllKeys({ GROQ_API_KEY: 'gsk_test_key_value' }, storage, async () => new Response('{}', { status: 200 }));
  assert.equal((await storage.get('key_health')).memory.status, 'healthy');
});

test('the setup script is valid dollar-quoted SQL and keeps search off anon roles', () => {
  const sql = readFileSync(new URL('./pgvector_setup.sql', import.meta.url), 'utf8');
  assert.doesNotMatch(sql, /^do \$\s*$/m);
  assert.doesNotMatch(sql, /^\$;\s*$/m);
  assert.match(sql, /^do \$\$$/m);
  assert.match(sql, /from anon/);
  assert.match(sql, /from authenticated/);
});

test('the web app pairs memory connection status with distinct haptics', () => {
  const page = readFileSync(new URL('./web_app.js', import.meta.url), 'utf8');
  assert.match(page, /navigator\.vibrate\(ok \? \[40, 60, 40\] : \[300\]\)/);
  assert.match(page, /Long-term memory is on\.', true\)/);
  assert.match(page, /say\(e\.message, false\)/);
});
