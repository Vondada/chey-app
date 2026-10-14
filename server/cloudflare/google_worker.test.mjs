// Google connections through the real Worker, offline: readiness on
// /api/commands, spoken owner requests in /api/chat (no model), the shared
// callback, and the owner-only routes. Same harness approach as command_center.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { sealToken } from './youtube_connection.js';

globalThis.fetch = async (input) => { throw new TypeError(`fetch failed (offline test: ${new URL(String(input?.url || input)).host})`); };

const generated = new URL('./.google_worker.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

const OAUTH_ENV = {
  CHE_OAUTH_SECRET: 'x'.repeat(40),
  CHE_YOUTUBE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  CHE_YOUTUBE_CLIENT_SECRET: 'client-secret-value',
};

function storageFor(saved) {
  return {
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => saved.set(key, structuredClone(value)),
    delete: async (key) => saved.delete(key),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

// A paired owner phone against the real Worker. `saved` is the owner's stored
// data, so a test can seed a grant the way a finished sign-in leaves it.
async function owner() {
  const inputs = [];
  const pending = [];
  const saved = new Map();
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', CHE_TIMEZONE: 'America/Chicago', ...OAUTH_ENV,
    AI: { run: async (_model, input) => { inputs.push(input); return { response: 'Model answer, sir.' }; } },
  };
  const state = new CheState({ storage: storageFor(saved), waitUntil: (p) => pending.push(p) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '', method = 'POST') => worker.fetch(new Request(`https://che.example${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const settle = async () => { while (pending.length) await pending.shift(); };
  const data = () => saved.get('che');
  const setData = (mutate) => { const d = structuredClone(saved.get('che')); mutate(d); saved.set('che', d); };
  return {
    token, env, saved, data, setData,
    async say(message) {
      const before = inputs.length;
      const res = await send('/api/chat', { message, history: [] }, token);
      const raw = await res.text();
      await settle();
      const events = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
      const done = events.find((e) => e.type === 'done') || {};
      return { raw, done, modelCalls: inputs.length - before, status: res.status };
    },
    async get(path) { const res = await send(path, null, token, 'GET'); return { status: res.status, body: await res.json().catch(() => ({})) }; },
    async post(path, body, bearer = token) { const res = await send(path, body, bearer); return { status: res.status, body: await res.json().catch(() => ({})) }; },
    send,
  };
}

// A fresh, valid grant sealed with the same secret the Worker reads.
async function liveGrant() {
  return {
    status: 'connected', account: 'owner@example.com', scopes: [], connected_at: new Date().toISOString(),
    refresh: await sealToken(OAUTH_ENV, 'live-refresh-token'),
    access: await sealToken(OAUTH_ENV, 'live-access-token'),
    access_expires_at: Date.now() + 3600_000,
  };
}

test('the Command Center lists Gmail, Drive, Calendar and Google Ads as not connected until signed in', async () => {
  const me = await owner();
  const commands = (await me.get('/api/commands')).body;
  for (const id of ['gmail', 'drive', 'calendar', 'google_ads']) {
    assert.equal(commands.connectors[id].state, 'not_connected', id);
    assert.ok(commands.connectors[id].label, `${id} has a label`);
  }
});

test('"check my email" before Gmail is connected says so, runs nothing and never reaches a model', async () => {
  const me = await owner();
  const r = await me.say('check my email');
  assert.equal(r.done.source, 'che_google');
  assert.equal(r.done.model_calls, 0);
  assert.equal(r.modelCalls, 0);
  assert.match(r.raw, /Gmail is not connected, sir/);
});

test('"check my email" with a live Gmail grant calls Google and reports its real failure, with no model', async () => {
  const me = await owner();
  // The grant needs sealing, which is async, so it is built before the turn.
  const grant = await liveGrant();
  me.setData((d) => { d.google_connections = { gmail: grant }; });
  const r = await me.say('check my email');
  assert.equal(r.done.source, 'che_google');
  assert.equal(r.modelCalls, 0);
  assert.match(r.raw, /I could not read your email, sir/, 'the failed Google call is reported, not invented');
});

test('the shared callback sends Gmail\'s sign-in to Gmail, names the service, and uses the sign-in once', async () => {
  const me = await owner();
  me.setData((d) => { d.google_oauth = { service: 'gmail', state: 'gmail-state-value', verifier: 'v'.repeat(48), created_at: Date.now() }; });
  const res = await me.send('/api/youtube/callback?state=gmail-state-value&error=access_denied', null, '', 'GET');
  const html = await res.text();
  assert.equal(res.status, 400);
  assert.match(html, /Gmail not connected/, 'the page names the service, not YouTube');
  assert.match(html, /did not approve/);
  assert.equal(me.data().google_oauth, undefined, 'the one-time sign-in is used up');
});

test('the owner-only Google routes refuse a request without the owner\'s device', async () => {
  const me = await owner();
  const status = await me.send('/api/google/status', null, '', 'GET');
  assert.equal(status.status, 401, 'no device token is not the owner');
  const start = await me.post('/api/google/connect/start', { service: 'gmail' }, '');
  assert.ok(start.status >= 400);
});

test('the owner can start a Gmail sign-in and gets a Google address with only Gmail\'s scopes', async () => {
  const me = await owner();
  const r = await me.post('/api/google/connect/start', { service: 'gmail' });
  assert.equal(r.status, 200);
  const url = new URL(r.body.url);
  assert.equal(url.hostname, 'accounts.google.com');
  assert.equal(url.searchParams.get('scope'),
    'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send');
});

test('a Google sign-in for an unknown service is refused with the owner\'s words', async () => {
  const me = await owner();
  const r = await me.post('/api/google/connect/start', { service: 'bank' });
  assert.equal(r.status, 400);
  assert.match(r.body.detail, /cannot connect that Google service/);
});

test('Gmail shows as Connected on the Command Center once a grant is stored', async () => {
  const me = await owner();
  const grant = await liveGrant();
  me.setData((d) => { d.google_connections = { gmail: grant }; });
  const commands = (await me.get('/api/commands')).body;
  assert.equal(commands.connectors.gmail.state, 'ready');
  assert.equal(commands.connectors.gmail.detail, 'owner@example.com');
  const status = (await me.get('/api/google/status')).body;
  assert.equal(status.services.gmail.connected, true);
  assert.equal(JSON.stringify(status).includes('live-refresh-token'), false, 'no token in the status reply');
});
