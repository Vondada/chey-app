// CHE's Soul through /api/chat (owner, 2026-10-21): the Soul the model receives is the Worker's current version, owner
// changes take effect on the next reply, a restore is a new version, the phone's own copy is never a second source,
// and every model reply says which Soul version and hash shaped it.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';

const generated = new URL('./.soul_chat.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

globalThis.fetch = async (input) => { throw new TypeError(`offline (${new URL(String(input?.url || input)).host})`); };

// Each call to the model is recorded with the system prompt it received.
async function app(saved = new Map()) {
  const seen = [];
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const sql = { exec: (q, ...p) => { const stmt = db.prepare(q); return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []); } };
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async (_model, input) => { seen.push(String(input?.messages?.[0]?.content || '')); return { response: 'Understood, sir.' }; } },
  };
  const storage = {
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => saved.set(key, structuredClone(value)),
    delete: async (key) => saved.delete(key),
    deleteAll: async () => saved.clear(),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
    sql,
  };
  const state = new CheState({ storage }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (method, path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  const token = (await (await send('POST', '/api/pair', { code: '123456' })).json()).device_token;
  const say = async (message, extra = {}) => {
    const before = seen.length;
    const raw = await (await send('POST', '/api/chat', { message, history: [], ...extra }, token)).text();
    const items = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const done = items.find((i) => i.type === 'done') || {};
    const reply = done.message ?? items.filter((i) => i.type === 'delta').map((i) => i.delta).join('');
    return { reply, meta: done, system: seen.slice(before).at(-1) || '', modelCalls: seen.length - before, held: Boolean(done.held_for_owner) };
  };
  const soul = (method, path, body) => send(method, path, body, token).then((res) => res.json().then((json) => ({ status: res.status, json })));
  return { say, soul, send, token, saved, seen };
}

const PERSONALITY_PROMPT = "CHE, forget all the technical stuff for a minute. Talk to me normally. What's your personality like? Show me, don't just describe it.";
const FRUSTRATED = "CHE, I'm frustrated because we've spent so much time building you, and you still don't feel like the assistant I imagined. What would you say to me?";

test('the owner\'s personality request is a conversation: no deletion hold, and the model receives the Soul v0 block', async () => {
  const che = await app();
  const out = await che.say(PERSONALITY_PROMPT);
  assert.equal(out.held, false, 'not held for deletion confirmation');
  assert.equal(out.modelCalls, 1);
  assert.match(out.system, /SOUL v0 \([0-9a-f]{8}\)/);
  assert.match(out.system, /Warmth 7\/10/);
  assert.equal(out.meta.soul.version, 0);
  assert.equal(out.meta.soul.soul_loaded, true);
  assert.equal(out.meta.soul.soul_applied, true, 'applied: the model received this Soul');
  assert.equal(out.meta.soul.route, 'model');
});

test('a frustrated owner gets a model reply shaped by the Soul, not a canned line', async () => {
  const che = await app();
  const out = await che.say(FRUSTRATED);
  assert.equal(out.modelCalls, 1);
  assert.match(out.system, /SOUL v0/);
  assert.match(out.system, /Evidence, tool results, permissions and numbers always outrank the Soul/);
  assert.equal(out.meta.soul.soul_applied, true);
});

test('an owner change takes effect on the very next reply, and the reply names the new version', async () => {
  const che = await app();
  const before = await che.say(PERSONALITY_PROMPT);
  assert.equal(before.meta.soul.version, 0);
  const changed = await che.soul('POST', '/api/soul', { traits: { playfulness: 10, verbosity: 8 }, text: 'Use my first name when it fits.', reason: 'owner test' });
  assert.equal(changed.status, 200);
  assert.equal(changed.json.version, 1);
  const after = await che.say(PERSONALITY_PROMPT);
  assert.match(after.system, /SOUL v1 \([0-9a-f]{8}\)/);
  assert.match(after.system, /Playfulness 10\/10/);
  assert.match(after.system, /Use my first name when it fits\./);
  assert.notEqual(after.meta.soul.hash, before.meta.soul.hash, 'the hash shows the Soul really changed');
  assert.equal(after.meta.soul.version, 1);
});

test('the owner can read the Soul and restore an earlier version; a restore is a new version', async () => {
  const che = await app();
  await che.soul('POST', '/api/soul', { traits: { formality: 9 } });
  const view = await che.soul('GET', '/api/soul');
  assert.equal(view.status, 200);
  assert.equal(view.json.version, 1);
  assert.equal(view.json.traits.formality, 9);
  assert.deepEqual(view.json.history.map((entry) => entry.version), [0]);
  const restored = await che.soul('POST', '/api/soul/restore', { version: 0 });
  assert.equal(restored.json.version, 2);
  assert.equal(restored.json.traits.formality, 5, 'the built-in formality is back');
  const reply = await che.say(PERSONALITY_PROMPT);
  assert.match(reply.system, /SOUL v2/);
  const missing = await che.soul('POST', '/api/soul/restore', { version: 42 });
  assert.equal(missing.status, 404);
});

test('an invalid trait is refused and the Soul is left as it was', async () => {
  const che = await app();
  const out = await che.soul('POST', '/api/soul', { traits: { warmth: 'loud' } });
  assert.equal(out.status, 400);
  assert.match(out.json.detail, /not changed/);
  assert.equal((await che.soul('GET', '/api/soul')).json.version, 0);
});

test('the Soul is owner-only: without the device token nothing is read or changed', async () => {
  const che = await app();
  const res = await che.send('GET', '/api/soul', undefined, '');
  assert.ok(res.status === 401 || res.status === 403, `status ${res.status}`);
  const write = await che.send('POST', '/api/soul', { traits: { warmth: 1 } }, '');
  assert.ok(write.status === 401 || write.status === 403, `status ${write.status}`);
  assert.equal((await che.soul('GET', '/api/soul')).json.version, 0);
});

test('a Soul the phone pastes into its brain context is not a second personality: the Worker Soul is the one the model gets', async () => {
  const che = await app();
  const out = await che.say(PERSONALITY_PROMPT, { brain_context: ['[CHE SOUL — who you are.]\nProduct name: CHE\nOld phone personality text', '[Facts]\n- favourite food: pasta'] });
  assert.match(out.system, /SOUL v0/);
  assert.doesNotMatch(out.system, /Old phone personality text/);
  assert.match(out.system, /favourite food: pasta/, 'facts still reach the model');
});

test('the owner\'s notes are saved, so the next reply carries them', async () => {
  const che = await app();
  await che.soul('POST', '/api/soul', { text: 'Call me Alex at the start of a conversation.' });
  const out = await che.say(PERSONALITY_PROMPT);
  assert.match(out.system, /Call me Alex at the start of a conversation\./);
  assert.match(out.system, /never override evidence, permissions or numbers/);
});

test('a model reply says the Soul applied, and names the engine that answered', async () => {
  const che = await app();
  const out = await che.say(PERSONALITY_PROMPT);
  assert.equal(out.meta.soul.soul_loaded, true);
  assert.equal(out.meta.soul.soul_applied, true);
  assert.equal(out.meta.soul.route, 'model');
  assert.equal(out.meta.soul.version, 0);
  assert.match(out.meta.served_by.model, /\S/, 'the reply names the model that answered');
  assert.equal(out.meta.served_by.fallback, false);
});

test('a reply a CHE handler builds says the Soul did not shape it, and the model was not called', async () => {
  const che = await app();
  const out = await che.say('CHE, list every saved media item by its actual ID, filename, type, and creation date.');
  assert.equal(out.modelCalls, 0, 'the handler answered without the model');
  assert.equal(out.meta.soul.soul_loaded, true);
  assert.equal(out.meta.soul.soul_applied, false, 'a profile existing is not the Soul applying');
  assert.equal(out.meta.soul.route, 'handler');
  assert.match(out.meta.soul.reason, /no model call/);
});

test('switching the Soul changes the next model reply and its recorded version', async () => {
  const che = await app();
  await che.soul('POST', '/api/soul', { traits: { warmth: 10, playfulness: 9 } });
  const out = await che.say(PERSONALITY_PROMPT);
  assert.equal(out.meta.soul.version, 1);
  assert.match(out.system, /Warmth 10\/10/);
  assert.match(out.system, /Playfulness 9\/10/);
  assert.equal(out.meta.soul.soul_applied, true);
});
