// Character Studio by voice: owner sentences become settings patches, upgrade requests or an open-screen route,
// never a tool grant; unrelated sentences are not studio requests.
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleStudio, studioIntent } from './character_studio.js';

test('spoken animation requests become per-agent settings patches', () => {
  const walk = studioIntent('CHE, make your walking more natural.');
  assert.equal(walk.kind, 'patch'); assert.equal(walk.agent, 'che');
  assert.equal(walk.patch.walk, 'graceful'); assert.ok(walk.patch.fluidity > 0);
  const less = studioIntent('Atlas, gesture less when you talk');
  assert.equal(less.agent, 'atlas'); assert.ok(less.patch.gesture < 0);
  const preset = studioIntent('use the professional preset');
  assert.equal(preset.patch.preset, 'professional');
  const stiff = studioIntent('you look stiff and robotic, be smoother');
  assert.ok(stiff.patch.fluidity > 0, 'smoother wins over the stiffness complaint');
  const slow = studioIntent('move a bit slower');
  assert.ok(slow.patch.speed < 0);
  const eyes = studioIntent('Nova, make more eye contact');
  assert.equal(eyes.agent, 'nova'); assert.ok(eyes.patch.eyeContact > 0);
});

test('a look that needs new assets is an upgrade request, and unrelated sentences are not studio requests', async () => {
  const up = studioIntent('give Mira a new outfit');
  assert.equal(up.kind, 'upgrade'); assert.equal(up.agent, 'mira');
  const filed = await handleStudio(up, { queueUpgrade: async () => ({ id: 'job-12345678' }) });
  assert.match(filed.text, /upgrade job job-1234/); assert.match(filed.text, /nothing has changed yet/i);
  const none = await handleStudio(up, {});
  assert.equal(none.ok, false); assert.match(none.text, /Nothing has changed/);
  for (const s of ['what is the weather', 'walk me through the trading plan', 'open the office', 'be honest with me', 'make the report more natural sounding']) {
    assert.equal(studioIntent(s), null, s);
  }
  assert.equal(studioIntent('open character studio').kind, 'open');
});

test('the reply names what changed and the fields carry only presentation settings', async () => {
  const out = await handleStudio(studioIntent('CHE, be more expressive and gesture more'));
  assert.match(out.text, /facial expressiveness up/); assert.match(out.text, /gesture intensity up/);
  assert.equal(out.fields.source, 'che_character_studio');
  assert.deepEqual(Object.keys(out.fields.studio_patch).sort(), ['expressiveness', 'gesture']);
  assert.ok(!('permissions' in out.fields) && !('tools' in out.fields));
});

// ─── Through the real /api/chat: the route answers with 0 model calls and only presentation fields ───────────
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { replyFromNdjson } from './brain_memory.js';
const generated = new URL('./.character_studio.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;
globalThis.fetch = async () => { throw new TypeError('offline'); };

test('Worker: "make your walking more natural" is answered from the studio parser, saved patch only, no model', async () => {
  const saved = new Map();
  const storage = { get: async (k) => (saved.has(k) ? structuredClone(saved.get(k)) : undefined), put: async (k, v) => saved.set(k, structuredClone(v)), delete: async (k) => saved.delete(k), deleteAll: async () => saved.clear(), list: async () => new Map(), setAlarm: async () => {}, deleteAlarm: async () => {} };
  let calls = 0;
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => { calls += 1; return { response: 'I changed your outfit to red.' }; } } };
  const state = new CheState({ storage, waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const post = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }), env);
  const token = (await (await post('/api/pair', { code: '123456' })).json()).device_token;
  const raw = await (await post('/api/chat', { message: 'CHE, make your walking more natural.', history: [] }, token)).text();
  const done = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((i) => i.type === 'done');
  assert.equal(done.source, 'che_character_studio');
  assert.equal(done.studio_agent, 'che');
  assert.equal(done.studio_patch.walk, 'graceful');
  assert.equal(calls, 0, 'no model call');
  assert.match(replyFromNdjson(raw), /graceful walk/);
  // A new outfit is an upgrade job, reported honestly, never a claimed change.
  const up = await (await post('/api/chat', { message: 'Give Mira a new outfit.', history: [] }, token)).text();
  const upDone = up.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((i) => i.type === 'done');
  assert.equal(upDone.source, 'che_character_studio');
  assert.ok(upDone.studio_upgrade?.id, 'an upgrade job was filed');
  assert.match(replyFromNdjson(up), /nothing has changed yet/i);
  assert.equal(calls, 0);
});
