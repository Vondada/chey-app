// Private Mode (owner, 2026-10-27): no outside AI or voice company receives the owner's conversations by default.
// Network-level: every request CHE's Worker makes is recorded at the fetch layer, with a key for every outside engine
// configured, and a planted canary memory must never appear in anything sent to an outside company.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { privacyIntent, privacyProbe, providerFor } from './privacy_mode.js';

// Recorded below the Worker's egress guard: the guard wraps this fetch, so a request only lands here if it was let out.
const outbound = [];
globalThis.fetch = async (input, init = {}) => {
  const url = String(input?.url || input);
  outbound.push({ url, host: new URL(url).hostname, body: typeof init.body === 'string' ? init.body : '' });
  if (/api\.openai\.com\/v1\/realtime/.test(url)) return new Response(JSON.stringify({ value: 'ek-test', expires_at: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (providerFor(new URL(url).hostname)) return new Response(JSON.stringify({ choices: [{ message: { content: 'outside engine answer' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  return new Response('{"error":"offline test"}', { status: 503, headers: { 'Content-Type': 'application/json' } });
};

const generated = new URL('./.privacy_mode.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

const KEYED_ENV = {
  GROQ_API_KEY: 'gsk-test', GEMINI_API_KEY: 'gem-test', CEREBRAS_API_KEY: 'cb-test', MISTRAL_API_KEY: 'mi-test',
  OPENROUTER_API_KEY: 'or-test', SAMBANOVA_API_KEY: 'sn-test', HF_TOKEN: 'hf-test', GITHUB_MODELS_TOKEN: 'gh-test',
  CHE_OPENAI_API_KEY: 'sk-test', XAI_API_KEY: 'xai-test', ANTHROPIC_API_KEY: 'ant-test', CHE_ALLOW_PAID_AI: '1',
  ELEVENLABS_API_KEY: 'el-test', FISH_AUDIO_API_KEY: 'fish-test',
};
const CANARY = 'Zorabelle Quintavus';

function storageMap() {
  const saved = new Map();
  return {
    saved,
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => saved.has(x)).map((x) => [x, structuredClone(saved.get(x))])) : (saved.has(k) ? structuredClone(saved.get(k)) : undefined)),
    put: async (k, v) => { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) saved.set(a, structuredClone(b)); else saved.set(k, structuredClone(v)); },
    delete: async (k) => saved.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...saved].filter(([key]) => key.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

// aiDown: CHE's own Workers AI fails, the moment a router would fall back to an outside engine.
async function che(storage = storageMap(), { aiDown = false } = {}) {
  const modelInputs = [];
  const env = { ...KEYED_ENV, CHE_PAIR_CODE: '123456', AI: { run: async (_m, input) => { modelInputs.push(JSON.stringify(input)); if (aiDown) throw new Error('Workers AI unavailable (test)'); return { response: 'Here you go, sir.' }; } } };
  const state = new CheState({ storage, waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const post = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), env);
  const token = (await (await post('/api/pair', { code: '123456', device_name: 'Owner iPhone' })).json()).device_token;
  const say = async (message, history = []) => {
    const raw = await (await post('/api/chat', { message, history }, token)).text();
    const frames = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return {}; } });
    return { done: frames.find((f) => f.type === 'done') || {}, reply: frames.filter((f) => f.type === 'delta').map((f) => f.delta).join('') };
  };
  return { say, post, token, storage, env, modelInputs };
}

const toProviders = () => outbound.filter((r) => providerFor(r.host));

test('Test 1 and 4: by default no outside AI company is called, even with every key configured, and the canary never leaves', async () => {
  outbound.length = 0;
  const c = await che();
  await c.say(`Remember that my favorite aunt is named ${CANARY}.`);
  const recall = await c.say('What is my favorite aunt called?');
  assert.ok(recall.reply, 'CHE still answered');
  const { reply } = await c.say('Write me a two-line poem about my favorite aunt.');
  assert.ok(reply, 'CHE still answered through her own model');
  assert.deepEqual(toProviders().map((r) => r.host), [], 'no request reached an outside AI or voice company');
  assert.ok(outbound.every((r) => !r.body.includes(CANARY)), 'the canary memory is in no outbound request body at all');
  // Honest about where it did go: CHE's own Workers AI (Cloudflare) got the prompt.
  assert.ok(c.modelInputs.length > 0);
  const ledger = c.storage.saved.get('che:egress_ledger') || [];
  assert.ok(ledger.some((e) => e.outcome === 'blocked'), 'blocked attempts are in Knox\'s ledger');
  assert.ok(ledger.every((e) => !JSON.stringify(e).includes(CANARY) && !('body' in e)), 'the ledger holds metadata, never content');
  // No silent cloud fallback: with CHE's own model down, still nothing goes to an outside company.
  const down = await che(c.storage, { aiDown: true });
  outbound.length = 0;
  await down.say('Write me a two-line poem about my favorite aunt.');
  assert.deepEqual(toProviders().map((r) => r.host), [], 'a failing local model never falls back to an outside engine');
});

test('live voice: OpenAI Realtime is refused in Private Mode, so the phone uses its own recognizer', async () => {
  outbound.length = 0;
  const c = await che();
  const res = await c.post('/api/live/token', { guarded_output: true }, c.token);
  assert.equal(res.status, 503);
  assert.match((await res.json()).detail, /Private Mode is on/);
  assert.deepEqual(toProviders(), []);
});

test('Knox answers from records: what left today, who can read the brain, anything suspicious', async () => {
  outbound.length = 0;
  const c = await che(undefined, { aiDown: true });
  await c.say('Tell me something fun.');
  let r = await c.say('Knox, has anything private left CHE today?');
  assert.equal(r.done.source, 'che_knox_privacy');
  assert.equal(r.done.model_calls, 0);
  assert.match(r.reply, /Nothing went to an outside AI or voice company today/);
  assert.match(r.reply, /I blocked \d+ request/);
  r = await c.say("Knox, who's accessing CHE's brain?");
  assert.match(r.reply, /1 signed-in device can read CHE's brain/);
  assert.match(r.reply, /Owner iPhone/);
  assert.match(r.reply, /I don't record individual memory reads/);
  const security = c.storage.saved.get('che:security_v1') || { events: [] };
  security.events = [{ id: 'e1', at: new Date().toISOString(), type: 'revoked_device_use', severity: 'medium', classification: 'suspicious', evidence: 'A revoked device tried to connect 2 time(s) in the last day; it was refused.' }, ...(security.events || [])];
  c.storage.saved.set('che:security_v1', security);
  r = await c.say('Knox, is anything suspicious happening?');
  assert.match(r.reply, /SUSPICIOUS ACTIVITY: 1 event/);
  assert.match(r.reply, /A revoked device tried to connect/);
  assert.match(r.reply, /INSUFFICIENT EVIDENCE for anything outside CHE/);
});

test('a permission opens exactly one company, for a limited time; turning Private Mode off is explicit; both survive a restart', async () => {
  outbound.length = 0;
  const storage = storageMap();
  let c = await che(storage, { aiDown: true });
  let r = await c.say('Let Claude help with this for an hour.');
  assert.match(r.reply, /Just to confirm, sir: that would let Anthropic \(Claude\) receive what you send it for 1 hour/);
  outbound.length = 0;
  await c.say('Write a short toast for my uncle\'s wedding.');
  assert.deepEqual(toProviders(), [], 'nothing opens before he confirms');
  r = await c.say('Yes');
  assert.match(r.reply, /Anthropic \(Claude\) is allowed until/);
  outbound.length = 0;
  await c.say('Write a short toast for my brother\'s wedding.');
  assert.ok(toProviders().length > 0 && toProviders().every((x) => x.host === 'api.anthropic.com'), `only Anthropic can be reached: ${toProviders().map((x) => x.host)}`);
  r = await c.say('Revoke all permissions.');
  assert.match(r.reply, /closed 1 open permission/);
  outbound.length = 0;
  await c.say('Write a short toast for my sister\'s wedding.');
  assert.deepEqual(toProviders(), []);
  r = await c.say('Turn off private mode.');
  assert.match(r.reply, /Just to confirm/);
  r = await c.say('no');
  assert.match(r.reply, /Nothing changed/);
  r = await c.say('Turn off private mode.');
  r = await c.say('yes, do it');
  assert.match(r.reply, /Private Mode is off/);
  c = await che(storage, { aiDown: true }); // restart: a new CheState over the same storage
  outbound.length = 0;
  await c.say('Write a short toast for my cousin\'s wedding.');
  assert.ok(toProviders().length > 0, 'connected mode really opens outside engines (the gate is not a no-op)');
  await c.say('Turn on private mode.');
  c = await che(storage, { aiDown: true });
  outbound.length = 0;
  await c.say('Write a short toast for my friend\'s wedding.');
  assert.deepEqual(toProviders(), [], 'Private Mode survives a restart');
  r = await c.say('Is private mode on?');
  assert.match(r.reply, /Private Mode is on/);
});

test('the owner\'s words, without rigid keywords; hypotheticals change nothing', () => {
  assert.equal(privacyIntent('Knox, who is accessing your brain?')?.action, 'access');
  assert.equal(privacyIntent('has anything private left CHE today?')?.action, 'egress');
  assert.equal(privacyIntent('Knox is anything suspicious happening')?.action, 'suspicious');
  assert.equal(privacyIntent('let ChatGPT see this for 2 hours')?.provider, 'openai');
  assert.equal(privacyIntent('let ChatGPT see this for 2 hours')?.ms, 2 * 3_600_000);
  assert.equal(privacyIntent('allow Gemini to help')?.provider, 'google');
  assert.equal(privacyIntent('let my mom help'), null, 'not a provider');
  assert.equal(privacyIntent('what if I turned off private mode'), null);
  assert.equal(privacyIntent('Tell me about privacy laws'), null);
  assert.equal(providerFor('che-gpu--x.modal.run'), 'modal');
  assert.equal(providerFor('api.github.com'), null);
});

test('the live check passes against this code and fails when an outside company was reached', async () => {
  const run = async (connected) => {
    const storage = storageMap();
    const env = { ...KEYED_ENV, CHE_PAIR_CODE: '123456', CHE_VOICE_PROBE_TOKEN: 'probe-token-0123456789abcdef', AI: { run: async () => ({ response: 'A line for your aunt, sir.' }) } };
    const state = new CheState({ storage, waitUntil: () => {} }, env);
    env.CHE_STATE = { getByName: () => state };
    if (connected) storage.saved.set('che:egress_ledger', [{ at: new Date().toISOString(), provider: 'groq', host: 'api.groq.com', outcome: 'sent', basis: 'connected mode', bytes: 900, fingerprint: 'ab' }]);
    return privacyProbe(env, new Request('https://che.example/api/privacy/probe', { method: 'POST', headers: { Authorization: 'Bearer probe-token-0123456789abcdef' } }), 'memory-truth-probe');
  };
  const good = await run(false);
  assert.equal(good.ok, true, JSON.stringify(good.steps.filter((s) => !s.pass)));
  assert.equal(good.total, 7);
  const leaked = await run(true);
  assert.equal(leaked.ok, false);
  assert.deepEqual(leaked.steps.filter((s) => !s.pass).map((s) => s.name), ['Test 1/4: nothing went to an outside AI or voice company (fetch-layer ledger)']);
  assert.equal(privacyIntent('always let ElevenLabs speak')?.standing, true);
  assert.equal(privacyIntent('let fish audio speak for me from now on')?.provider, 'fish');
});

test('Codex review: two CHE objects in one isolate keep their own policy and ledger; daily totals survive a trimmed ledger', async () => {
  const owner = storageMap();
  const other = storageMap();
  other.saved.set('che:privacy_mode', { level: 'connected', grants: [] });
  const a = await che(owner, { aiDown: true });
  const b = await che(other, { aiDown: true });
  outbound.length = 0;
  // Interleaved: the connected object's request runs while the owner's is in flight.
  await Promise.all([a.say('Write a short toast for my aunt.'), b.say('Write a short toast for my uncle.')]);
  const ownerLedger = owner.saved.get('che:egress_ledger') || [];
  const otherLedger = other.saved.get('che:egress_ledger') || [];
  assert.ok(ownerLedger.length && ownerLedger.every((e) => e.outcome === 'blocked'), 'the owner object never sent anything');
  assert.ok(otherLedger.some((e) => e.outcome === 'sent'), `the connected object did: ${JSON.stringify(otherLedger)} ${JSON.stringify(toProviders().map((x) => x.host))}`);
  const sentHosts = toProviders().map((r) => r.host);
  assert.ok(sentHosts.length > 0);
  // 600 blocked entries after one sent one: the detail list keeps 500, the daily total still counts the send.
  const today = new Date().toISOString().slice(0, 10);
  owner.saved.set('che:egress_ledger', Array.from({ length: 500 }, () => ({ at: new Date().toISOString(), provider: 'groq', host: 'api.groq.com', outcome: 'blocked' })));
  owner.saved.set('che:egress_daily', { [today]: { sent: 1, blocked: 600, bytes: 1200, providers: { openai: 1 } } });
  const r = await a.say('Knox, has anything private left CHE today?');
  assert.match(r.reply, /1 request went out today, to OpenAI \(ChatGPT\), 1200 bytes in all/);
  assert.match(r.reply, /I blocked 600 requests/);
});
