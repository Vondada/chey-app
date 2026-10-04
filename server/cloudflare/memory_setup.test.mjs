import assert from 'node:assert/strict';
import test from 'node:test';
import { memorySetupIntent, memorySetupSteps, normalizeMemoryUrl, removeMemoryDatabase, saveMemoryDatabase, storedKeys, withStoredKeys } from './resilience.js';
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
