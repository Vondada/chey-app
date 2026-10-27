// Service onboarding ("CHE, connect Hugging Face."), through the real Worker
// (/api/chat, /api/onboarding/*, /api/keys) with a fake huggingface.co and a
// fake GitHub. Offline: any other host fails like it does in CI.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';
import { fakeHuggingFace, fakeToken, hfFetch } from '../../tools/fake_huggingface.mjs';
import { blake2b, putRepositorySecret, sealedBox, sealedBoxOpen } from './github_secrets.js';
import nacl from './vendor_tweetnacl.js';
import { fingerprint, hfPermissionCheck, onboardingIntent, outcomeLines, PROVIDERS } from './service_onboarding.js';
import { STORED_KEY_WINS, withStoredKeys } from './resilience.js';

const offline = async (input) => { throw new TypeError(`fetch failed (offline test: ${new URL(String(input?.url || input)).host})`); };
globalThis.fetch = offline;

const generated = new URL('./.service_onboarding.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

function storageFor(saved) {
  return {
    get: async (key) => Array.isArray(key) ? new Map(key.filter((k) => saved.has(k)).map((k) => [k, structuredClone(saved.get(k))])) : saved.has(key) ? structuredClone(saved.get(key)) : undefined,
    put: async (key, value) => {
      if (key && typeof key === 'object') { for (const [k, v] of Object.entries(key)) saved.set(k, structuredClone(v)); return; }
      saved.set(key, structuredClone(value));
    },
    delete: async (key) => saved.delete(key),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {}, deleteAlarm: async () => {},
  };
}

// A paired owner phone plus a fake Hugging Face reachable through global fetch.
async function owner({ env: extra = {}, hf = fakeHuggingFace(), github = null } = {}) {
  const saved = new Map();
  const inputs = [];
  const pending = [];
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', ...extra, AI: { run: async (_m, input) => { inputs.push(input); return { response: 'Here is the answer, sir.' }; } } };
  const state = new CheState({ storage: storageFor(saved), waitUntil: (p) => pending.push(p) }, env);
  env.CHE_STATE = { getByName: () => state };
  globalThis.fetch = hfFetch(hf, github ? (i, o) => (new URL(String(i?.url || i)).host === 'api.github.com' ? github(i, o) : offline(i)) : offline);
  const send = (path, body, token = '', method = 'POST') => worker.fetch(new Request(`https://che.example${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const settle = async () => { while (pending.length) await pending.shift(); };
  const wire = [];
  const say = async (message) => {
    const before = inputs.length;
    const res = await send('/api/chat', { message, history: [] }, token);
    const raw = await res.text();
    await settle();
    wire.push(raw);
    const events = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const done = events.find((e) => e.type === 'done') || {};
    return { raw, done, route: done.source || (inputs.length > before ? 'model' : 'none'), reply: replyFromNdjson(raw), modelCalls: inputs.length - before };
  };
  const post = async (path, body, t = token) => { const res = await send(path, body, t); const text = await res.text(); wire.push(text); return { status: res.status, body: JSON.parse(text) }; };
  const get = async (path) => { const res = await send(path, null, token, 'GET'); const text = await res.text(); wire.push(text); return { status: res.status, body: JSON.parse(text) }; };
  return { say, post, get, send, token, saved, inputs, env, state, hf, wire };
}

// What the device does after "connect": announce the fingerprint, then post the token once.
async function deviceCreatesToken(che, { capability = 'inference', name = 'CHE inference 2026-10-25', permissions = ['Make calls to Inference Providers'] } = {}) {
  const value = che.hf.mint({ name, permissions });
  const fp = await fingerprint(value);
  const ev = await che.post('/api/onboarding/huggingface/event', { capability, kind: 'token_created', fingerprint: fp.fingerprint, last4: fp.last4, name });
  return { value, fp, ev };
}

const everything = (che) => [...che.wire, JSON.stringify([...che.saved.entries()].filter(([k]) => k !== 'provider_keys'))].join('\n');

// ─── Words ────────────────────────────────────────────────────────────────

test('the owner\'s words reach onboarding; other "connect" requests are left to their own routes', () => {
  assert.deepEqual(onboardingIntent('CHE, connect Hugging Face.'), { kind: 'connect', provider: 'huggingface', capability: '' });
  assert.equal(onboardingIntent('connect hugging face for film studio').capability, 'film_space');
  assert.equal(onboardingIntent('Connect my HuggingFace account for GitHub Actions').capability, 'actions');
  assert.equal(onboardingIntent('Is Hugging Face connected?').kind, 'status');
  assert.equal(onboardingIntent('check my hugging face connection').kind, 'status');
  assert.equal(onboardingIntent('connect groq').provider, 'groq');
  assert.deepEqual(onboardingIntent('yes, use vondada on hugging face'), { kind: 'connect', provider: 'huggingface', capability: '', account: 'vondada' });
  for (const other of ['connect my Gmail', 'connect Google Drive', 'connect YouTube', 'connect NinjaTrader', 'connect my calendar', 'what is hugging face?', 'I love hugging face models']) {
    assert.equal(onboardingIntent(other), null, other);
  }
  assert.equal(PROVIDERS.youtube, undefined, 'YouTube stays on Google sign-in');
  assert.equal(PROVIDERS.huggingface.mode, 'device');
  assert.equal(PROVIDERS.groq.mode, 'guided');
});

test('token fingerprints are a sha256 prefix plus the last four characters only', async () => {
  const value = fakeToken(0.42);
  const fp = await fingerprint(value);
  assert.match(fp.fingerprint, /^sha256:[0-9a-f]{12}$/);
  assert.equal(fp.last4, value.slice(-4));
  assert.ok(!fp.fingerprint.includes(value.slice(3, 12)));
});

test('Hugging Face permission checks read the token\'s own description (role and fine-grained scopes)', () => {
  const fg = (perms, user = 'vondada') => ({ name: 'vondada', auth: { accessToken: { role: 'fineGrained', fineGrained: { global: [], scoped: [{ entity: { type: 'user', name: user }, permissions: perms }] } } } });
  assert.equal(hfPermissionCheck(fg(['inference.serverless.write']), ['inference']).ok, true);
  assert.deepEqual(hfPermissionCheck(fg(['repo.content.read']), ['inference']).missing, ['inference']);
  assert.equal(hfPermissionCheck(fg(['inference.serverless.write'], 'someone-else'), ['inference']).ok, false, 'scopes on another account do not count');
  assert.equal(hfPermissionCheck({ auth: { accessToken: { role: 'read' } } }, ['inference']).ok, true);
  assert.equal(hfPermissionCheck({ auth: { accessToken: { role: 'read' } } }, ['repo_write', 'inference']).ok, false);
  assert.equal(hfPermissionCheck({ auth: { accessToken: { role: 'write' } } }, ['repo_write']).ok, true);
  assert.equal(hfPermissionCheck({ auth: {} }, ['inference']).unknown, true);
});

// ─── The command, end to end ─────────────────────────────────────────────

test('"CHE, connect Hugging Face." with nothing connected: no model, a minimum-permission plan for CHE\'s browser, then Connected only after verification', async () => {
  const che = await owner();
  const said = await che.say('CHE, connect Hugging Face.');
  assert.equal(said.route, 'che_onboarding');
  assert.equal(said.modelCalls, 0);
  assert.equal(said.done.open_screen, 'service_onboarding');
  const plan = said.done.onboarding.plan;
  assert.equal(said.done.onboarding.action, 'create_token');
  assert.equal(plan.url, 'https://huggingface.co/settings/tokens/new?tokenType=fineGrained');
  assert.deepEqual(plan.permissions, ['Make calls to Inference Providers']);
  assert.match(plan.token_name, /^CHE inference \d{4}-\d{2}-\d{2}$/);
  assert.match(said.reply, /opening your Hugging Face token page/);
  assert.doesNotMatch(said.reply, /Connected/);

  const { value, fp, ev } = await deviceCreatesToken(che, { name: plan.token_name });
  assert.equal(ev.status, 200);
  assert.equal(ev.body.state, 'token_created');
  assert.equal(ev.body.outcomes.token_created, true);
  assert.equal(ev.body.outcomes.connection_verified, false);

  const stored = await che.post('/api/onboarding/huggingface/secret', { capability: 'inference', token: value });
  assert.equal(stored.status, 200, JSON.stringify(stored.body));
  assert.equal(stored.body.state, 'verified');
  assert.deepEqual(stored.body.outcomes, { token_created: true, secret_configured: ['worker'], connection_verified: true });
  const [tokenLine, secretLine, verifiedLine] = stored.body.lines;
  assert.match(tokenLine, new RegExp(`^Token created: yes, "${plan.token_name}", ending ${fp.last4}\\.$`));
  assert.match(secretLine, /^Secret configured: CHE Worker runtime key store/);
  assert.match(verifiedLine, /^Connection verified: Hugging Face account vondada; token fine-grained, with "Make calls to Inference Providers"; the Hub accepted the token.*; the Inference Providers router accepted the token \(model list; no inference was run, nothing was spent\)\.$/);
  assert.match(stored.body.speech, /^Connected: Hugging Face account vondada, token fine-grained\. I can download public models and use Hugging Face Inference Providers/);

  // The Worker is really connected: the merged env every consumer reads holds the new token.
  assert.equal((che.state.keyEnv || {}).HF_TOKEN, value);
  const keys = (await che.get('/api/keys')).body.providers.find((p) => p.id === 'huggingface');
  assert.deepEqual([keys.status, keys.last4], ['healthy', fp.last4]);
  // Only fingerprints anywhere outside the key store: replies, status, letters, history.
  assert.ok(!everything(che).includes(value), 'the token never comes back or lands outside the key store');
  assert.ok(!everything(che).includes(value.slice(3, 20)));
  const status = await che.say('Is Hugging Face connected?');
  assert.equal(status.route, 'che_onboarding');
  assert.match(status.reply, /^Connected: Hugging Face account vondada/);
  assert.equal(che.hf.state.created.length, 1, 'exactly one token was created');
});

test('a working connection is preserved: nothing is created, nothing is replaced', async () => {
  const hf = fakeHuggingFace();
  const working = hf.mint({ name: 'old', permissions: ['Make calls to Inference Providers'] });
  const che = await owner({ hf, env: { HF_TOKEN: working } });
  const said = await che.say('connect hugging face');
  assert.equal(said.route, 'che_onboarding');
  assert.equal(said.done.onboarding.action, 'none');
  assert.equal(said.done.open_screen, undefined, 'no browser work');
  assert.match(said.reply, /^Connected: Hugging Face account vondada.*It was already working, so I created nothing new\./s);
  assert.match(said.reply, /Token created: no, your existing token already works, so I kept it\./);
  assert.equal(hf.state.created.length, 1, 'only the pre-existing token');
});

test('no duplicate tokens on retries: the outstanding token is reused; a second one is refused until the first is reported lost', async () => {
  const che = await owner();
  await che.say('CHE, connect Hugging Face.');
  const first = await deviceCreatesToken(che);
  // Retry (app restarted before posting): CHE asks for the same token.
  const retry = await che.say('CHE, connect Hugging Face.');
  assert.equal(retry.done.onboarding.action, 'post_held_token');
  assert.equal(retry.done.onboarding.fingerprint, first.fp.fingerprint);
  assert.match(retry.reply, /I'll store that one instead of making another/);
  // A second token is refused, as an event and as a secret.
  const other = fakeToken(0.9);
  const ofp = await fingerprint(other);
  assert.equal((await che.post('/api/onboarding/huggingface/event', { capability: 'inference', kind: 'token_created', fingerprint: ofp.fingerprint, last4: ofp.last4 })).status, 409);
  assert.equal((await che.post('/api/onboarding/huggingface/secret', { capability: 'inference', token: other })).status, 409);
  // The same POST twice: the second reports what already happened.
  const a = await che.post('/api/onboarding/huggingface/secret', { capability: 'inference', token: first.value });
  const b = await che.post('/api/onboarding/huggingface/secret', { capability: 'inference', token: first.value });
  assert.equal(a.body.state, 'verified');
  assert.equal(b.body.duplicate, true);
});

test('a lost token is recorded (revoked or not) and only then is a new one requested, with a new name', async () => {
  const che = await owner();
  await che.say('CHE, connect Hugging Face.');
  const first = await deviceCreatesToken(che);
  assert.equal((await che.post('/api/onboarding/huggingface/start', { capability: 'inference', lost_fingerprint: 'sha256:000000000000' })).status, 409, 'only the outstanding token can be reported lost');
  const again = await che.post('/api/onboarding/huggingface/start', { capability: 'inference', lost_fingerprint: first.fp.fingerprint, revoked: true });
  assert.equal(again.body.action, 'create_token');
  assert.match(again.body.plan.token_name, / #2$/);
  assert.deepEqual(again.body.lost_tokens.map((t) => [t.fingerprint, t.revoked]), [[first.fp.fingerprint, true]]);
});

test('replace only if valid: a bad new token is never stored and the working one stays', async () => {
  const hf = fakeHuggingFace();
  const working = hf.mint({ name: 'old', permissions: ['Make calls to Inference Providers'] });
  const che = await owner({ hf });
  await che.post('/api/keys', { provider: 'huggingface', key: working });
  await che.state.refreshKeyEnv();
  const bad = fakeToken(0.31337); // never minted → 401
  const out = await che.post('/api/onboarding/huggingface/secret', { capability: 'inference', token: bad });
  assert.equal(out.status, 422);
  assert.equal(out.body.state, 'failed');
  assert.match(out.body.failure.detail, /your existing token is unchanged\. Nothing was stored/);
  assert.equal(che.saved.get('provider_keys').HF_TOKEN, working);
  assert.equal(che.state.keyEnv.HF_TOKEN, working);
  assert.doesNotMatch(out.body.speech, /^Connected/);
  // A token without the needed permission is also refused before storing.
  const weak = hf.mint({ name: 'weak', permissions: ['Read access to contents of all public gated repos you can access'] });
  const out2 = await che.post('/api/onboarding/huggingface/secret', { capability: 'inference', token: weak });
  assert.equal(out2.status, 422);
  assert.match(out2.body.lines[2], /missing "Make calls to Inference Providers"/);
  assert.equal(che.saved.get('provider_keys').HF_TOKEN, working);
});

test('a dead deploy-time HF_TOKEN Worker secret cannot shadow the verified replacement', async () => {
  const hf = fakeHuggingFace();
  const dead = fakeToken(0.123); // the Worker secret, refused by Hugging Face
  const che = await owner({ hf, env: { HF_TOKEN: dead } });
  const said = await che.say('CHE, connect Hugging Face.');
  assert.equal(said.done.onboarding.action, 'create_token', 'the broken secret is not "connected"');
  const { value } = await deviceCreatesToken(che);
  const out = await che.post('/api/onboarding/huggingface/secret', { capability: 'inference', token: value });
  assert.equal(out.body.state, 'verified');
  assert.match(out.body.destinations[0].detail, /takes precedence over the old HF_TOKEN Worker secret/);
  assert.deepEqual(che.saved.get('provider_keys')[STORED_KEY_WINS], ['HF_TOKEN']);
  assert.equal(che.state.keyEnv.HF_TOKEN, value);
  // Without the flag a Worker secret still wins, as before.
  assert.equal(withStoredKeys({ HF_TOKEN: 'secret' }, { HF_TOKEN: 'stored' }).HF_TOKEN, 'secret');
  // Removing the key in Keys clears the flag too.
  await che.post('/api/keys', { provider: 'huggingface', remove: true });
  assert.deepEqual(che.saved.get('provider_keys')[STORED_KEY_WINS], []);
});

test('verification is real: a token the router refuses, or a rate-limited identity check, is never "Connected"', async () => {
  const hf = fakeHuggingFace({ routerDown: true });
  const che = await owner({ hf });
  await che.say('CHE, connect Hugging Face.');
  const { value } = await deviceCreatesToken(che);
  const out = await che.post('/api/onboarding/huggingface/secret', { capability: 'inference', token: value });
  assert.equal(out.body.state, 'failed');
  assert.equal(out.body.outcomes.connection_verified, false);
  assert.match(out.body.lines[2], /^Connection verified: no\. the Inference Providers router refused the token \(HTTP 401\)/);
  assert.doesNotMatch(out.body.speech, /Connected:/);

  const limited = await owner({ hf: fakeHuggingFace({ whoamiStatus: 429 }) });
  const v = await limited.post('/api/onboarding/huggingface/secret', { capability: 'inference', token: fakeToken(0.5) });
  assert.equal(v.status, 422);
  assert.match(v.body.lines[2], /rate-limited the identity check/);
});

test('pause and resume: sign-in, captcha and account approval pause with the exact step; "connect" resumes there', async () => {
  const che = await owner();
  await che.say('CHE, connect Hugging Face.');
  const paused = await che.post('/api/onboarding/huggingface/event', { capability: 'inference', kind: 'paused', reason: 'owner_auth', step: 'sign_in', detail: 'Hugging Face needs you to sign in' });
  assert.equal(paused.body.state, 'paused');
  assert.equal(paused.body.pause.resume_state, 'token_requested');
  const status = await che.say('is hugging face connected?');
  assert.match(status.reply, /paused: Hugging Face needs you to sign in\. Say "connect Hugging Face" when you're ready/);
  const resumed = await che.say('connect hugging face');
  assert.equal(resumed.done.onboarding.action, 'create_token');
  assert.equal(resumed.done.onboarding.state, 'token_requested');
  // Unknown account: pause for the owner's yes; a different account than approved fails without creating.
  const seen = await che.post('/api/onboarding/huggingface/event', { capability: 'inference', kind: 'account_seen', username: 'vondada' });
  assert.equal(seen.body.needs_approval, true);
  assert.match(seen.body.pause.detail, /Say "yes, use vondada on Hugging Face" to approve it/);
  assert.doesNotMatch(seen.body.speech, /when you're ready/);
  const yes = await che.say('yes, use vondada on hugging face');
  assert.equal(yes.done.onboarding.plan.expected_account, 'vondada');
  const wrong = await che.post('/api/onboarding/huggingface/event', { capability: 'inference', kind: 'account_seen', username: 'stranger' });
  assert.equal(wrong.status, 409);
  assert.match(wrong.body.failure.detail, /signed in to stranger, not your approved account vondada\. I created nothing/);
});

test('owner-only, lockdown-frozen, and events never carry a secret', async () => {
  const che = await owner();
  const anon = await che.send('/api/onboarding/huggingface/secret', { token: fakeToken(0.2) });
  assert.ok([401, 403].includes(anon.status), `unpaired → ${anon.status}`);
  assert.equal(che.saved.get('provider_keys'), undefined);
  await che.say('CHE, connect Hugging Face.');
  const leak = await che.post('/api/onboarding/huggingface/event', { capability: 'inference', kind: 'paused', reason: 'owner_auth', detail: `here it is ${fakeToken(0.7)}` });
  assert.equal(leak.status, 400);
  assert.equal((await che.post('/api/onboarding/huggingface/event', { capability: 'inference', kind: 'token_created', token: fakeToken(0.7) })).status, 400);
  await che.say('lockdown');
  assert.equal((await che.post('/api/onboarding/huggingface/secret', { capability: 'inference', token: fakeToken(0.2) })).status, 423);
  assert.equal((await che.post('/api/onboarding/huggingface/start', { capability: 'inference' })).status, 423);
});

test('guided providers use the same machine: the owner pastes into the secure field, CHE verifies with a free authenticated call', async () => {
  const groqKey = 'gsk_' + 'a1B2c3D4e5'.repeat(5);
  const che = await owner();
  const said = await che.say('connect groq');
  assert.equal(said.done.onboarding.action, 'guided');
  assert.equal(said.done.onboarding.plan.url, 'https://console.groq.com/keys');
  globalThis.fetch = async (input, init) => new URL(String(input?.url || input)).host === 'api.groq.com' && init.headers.Authorization === `Bearer ${groqKey}` ? new Response('{"data":[]}', { status: 200 }) : new Response('{}', { status: 401 });
  const out = await che.post('/api/onboarding/groq/secret', { token: groqKey });
  assert.equal(out.body.state, 'verified', JSON.stringify(out.body));
  assert.match(out.body.speech, /^Connected: Groq accepted the key/);
  assert.ok(!che.wire.join('').includes(groqKey));
});

// ─── GitHub Actions secret (sealed box) ─────────────────────────────────

test('BLAKE2b and the sealed box match libsodium (RFC 7693 vector and a libsodium-made sealed box)', () => {
  const hex = (u) => Buffer.from(u).toString('hex');
  assert.equal(hex(blake2b('abc', 64)), 'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923');
  assert.equal(hex(blake2b(new Uint8Array(0), 24)), 'ab3b5331a7135ed50d0f182d026e60abdb3646fd51bcf8a3');
  // Made by libsodium 1.0.20 crypto_box_seal (libsodium-wrappers 0.7.15).
  const b = (s) => Uint8Array.from(Buffer.from(s, 'base64'));
  const opened = sealedBoxOpen(b('+Y4MFhgMNtiJPD5j7bhVkk9X7MjFwiAD4+Lo60BipzQ6VJkv8rIBwCTT7zZnX2lldKsnEnfCVYSvbE4ms/00q0agVuw/'), b('l4VWbtQj5A7/qPYEl6WD3gSa06PGSeK0nxE1ZH5I+D8='), b('5/+OqUV8oqkzdgY+1Q0bPLWezPod1hgf9Nl7XO8F4Q8='));
  assert.equal(new TextDecoder().decode(opened), 'CHE sealed box vector');
  const kp = nacl.box.keyPair();
  const sealed = sealedBox('hf_roundtrip', kp.publicKey);
  assert.equal(sealed.length, 48 + 'hf_roundtrip'.length);
  assert.equal(new TextDecoder().decode(sealedBoxOpen(sealed, kp.publicKey, kp.secretKey)), 'hf_roundtrip');
});

function fakeGitHub({ deny = false } = {}) {
  const kp = nacl.box.keyPair();
  const secrets = new Map();
  const handler = async (input, init = {}) => {
    const url = new URL(String(input?.url || input));
    if (deny) return new Response('{"message":"Resource not accessible by personal access token"}', { status: 403, headers: { 'x-accepted-github-permissions': 'secrets=read' } });
    if (url.pathname.endsWith('/actions/secrets/public-key')) return new Response(JSON.stringify({ key_id: 'k1', key: Buffer.from(kp.publicKey).toString('base64') }), { status: 200 });
    const m = /\/actions\/secrets\/([A-Z_]+)$/.exec(url.pathname);
    if (m && init.method === 'PUT') { const body = JSON.parse(init.body); secrets.set(m[1], body); return new Response('', { status: 201 }); }
    return new Response('{}', { status: 404 });
  };
  return { handler, secrets, open: (name) => new TextDecoder().decode(sealedBoxOpen(Uint8Array.from(Buffer.from(secrets.get(name).encrypted_value, 'base64')), kp.publicKey, kp.secretKey)) };
}

test('capability "actions" also writes the GitHub Actions secret HF_TOKEN as ciphertext GitHub can open', async () => {
  const gh = fakeGitHub();
  const che = await owner({ github: gh.handler, env: { CHE_GITHUB_TOKEN: 'ghp_test_only_value', CHE_GITHUB_REPO: 'Vondada/chey-app' } });
  const said = await che.say('connect hugging face for github actions');
  assert.equal(said.done.onboarding.capability, 'actions');
  const { value } = await deviceCreatesToken(che, { capability: 'actions' });
  const out = await che.post('/api/onboarding/huggingface/secret', { capability: 'actions', token: value });
  assert.equal(out.body.state, 'verified');
  assert.deepEqual(out.body.outcomes.secret_configured, ['worker', 'github']);
  assert.match(out.body.lines[1], /GitHub Actions secret HF_TOKEN/);
  assert.equal(gh.secrets.get('HF_TOKEN').key_id, 'k1');
  assert.ok(!gh.secrets.get('HF_TOKEN').encrypted_value.includes(value));
  assert.equal(gh.open('HF_TOKEN'), value);
});

test('without GitHub Secrets permission the GitHub line says so, and the Worker connection still verifies', async () => {
  const gh = fakeGitHub({ deny: true });
  const che = await owner({ github: gh.handler, env: { CHE_GITHUB_TOKEN: 'ghp_test_only_value', CHE_GITHUB_REPO: 'Vondada/chey-app' } });
  await che.say('connect hugging face for github actions');
  const { value } = await deviceCreatesToken(che, { capability: 'actions' });
  const out = await che.post('/api/onboarding/huggingface/secret', { capability: 'actions', token: value });
  assert.equal(out.body.state, 'verified');
  assert.deepEqual(out.body.outcomes.secret_configured, ['worker']);
  assert.match(out.body.lines[1], /Not configured: GitHub Actions secret HF_TOKEN \(GitHub refused \(HTTP 403\)\. CHE_GITHUB_TOKEN needs the repository permission "Secrets: Read and write"/);
  const direct = await putRepositorySecret({ token: '', repo: 'Vondada/chey-app', name: 'HF_TOKEN', value: 'x' });
  assert.equal(direct.status, 'not_configured');
});

test('outcome lines keep the three outcomes separate for partial setups', () => {
  const lines = outcomeLines({ state: 'secret_configured', token: { name: 'CHE inference', last4: 'abcd' }, destinations: [{ id: 'worker', label: 'CHE Worker runtime key store', status: 'configured' }], verification: null }, PROVIDERS.huggingface);
  assert.deepEqual(lines, ['Token created: yes, "CHE inference", ending abcd.', 'Secret configured: CHE Worker runtime key store.', 'Connection verified: not yet.']);
});

test('/connect-service is one Command Center entry that reaches the onboarding route with no model', async () => {
  const che = await owner();
  const out = await che.say('/connect-service Hugging Face');
  assert.equal(out.route, 'che_onboarding');
  assert.equal(out.modelCalls, 0);
  assert.equal(out.done.onboarding.action, 'create_token');
  const unknown = await che.say('/connect-service my toaster');
  assert.equal(unknown.route, 'che_onboarding');
  assert.match(unknown.reply, /I can connect Hugging Face automatically/);
});
