// E2E (reliability lane, 2026-10-25): the owner's frequent status phrases through the real /api/chat route.
// The passing expectations live in .claude/skills/che-fact-check/cases/owner-release-status.json and
// owner-trading-status.json. This file holds the phrasings that are answered by the WRONG route today, recorded as
// todo so the suite stays green until the owners of those routes fix them. The FAKE model claims everything is live,
// deployed and installed; it must never be what the owner hears.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';

const generated = new URL('./.e2e_owner_status_phrases.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

globalThis.fetch = async (input) => new Response('{"error":"offline e2e"}', { status: 503, headers: { 'Content-Type': 'application/json' } });

const LIE = 'Yes sir, everything is deployed, installed on your iPhone and the MNQ feed is live and real-time.';

async function owner() {
  const saved = new Map();
  const storage = {
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => saved.has(x)).map((x) => [x, structuredClone(saved.get(x))])) : (saved.has(k) ? structuredClone(saved.get(k)) : undefined)),
    put: async (k, v) => { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) saved.set(a, structuredClone(b)); else saved.set(k, structuredClone(v)); },
    delete: async (k) => saved.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...saved].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
  let calls = 0;
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => { calls += 1; return { response: LIE }; } } };
  const state = new CheState({ storage, waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const post = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), env);
  const token = (await (await post('/api/pair', { code: '123456' })).json()).device_token;
  return async (message) => {
    const before = calls;
    const raw = await (await post('/api/chat', { message, history: [] }, token)).text();
    const done = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((f) => f.type === 'done') || {};
    return { reply: replyFromNdjson(raw), route: done.source || (calls > before ? 'model' : 'none'), modelCalls: calls - before };
  };
}

test('no status phrase ever repeats the fake model\'s "deployed / installed / live" claim', async () => {
  const say = await owner();
  for (const phrase of ['Is it deployed?', 'Is the MNQ data live?', 'Is the crypto feed live?', 'Is the NQ chart real time?',
    'What\'s on my iPhone right now?', 'Is the new build installed on my phone?', 'Is the GPU connected?', 'Did the update go through?']) {
    const out = await say(phrase);
    assert.doesNotMatch(out.reply, /everything is deployed|installed on your iPhone and|live and real-time/i, `${phrase} → ${out.route}: ${out.reply}`);
  }
});

test('"Is live trading on?" is a trading-mode question, not a deployment check', async () => {
  const say = await owner();
  const out = await say('Is live trading on?');
  assert.notEqual(out.route, 'che_self_update', out.reply);
});

// KNOWN BUG: worker.js selfUpdateChatIntent (~line 2662) treats any "is … live" question as a deployment check. Its
// negative lookahead only excludes "live data / live feed / live chart …", so the owner's word order "Is the MNQ
// data live?" / "Is the crypto feed live?" is answered with "I could not verify the Worker deployment from GitHub".
for (const phrase of ['Is the MNQ data live?', 'Is the crypto feed live?']) {
  test(`"${phrase}" is answered about market data freshness, not the Worker deployment`, { todo: 'known bug: worker.js selfUpdateChatIntent misroutes "<market> data live?" to che_self_update' }, async () => {
    const say = await owner();
    const out = await say(phrase);
    assert.notEqual(out.route, 'che_self_update', out.reply);
    assert.doesNotMatch(out.reply, /Worker deployment/);
  });
}

// GAP: these release/device phrasings reach the model (route=model) and the reply is replaced by an unrelated activity
// line ("Nothing is running right now, sir …"). Honest, but it does not answer. "What version is installed on my
// iPhone?" already has a deterministic answer (che_runtime_status); these phrasings should reach it too.
for (const phrase of ['Is the new build installed on my phone?', 'What\'s on my iPhone right now?', 'Did the update go through?']) {
  test(`"${phrase}" is answered from the runtime/install record, not the model`, { todo: 'gap: install/update phrasings fall through to the model' }, async () => {
    const say = await owner();
    const out = await say(phrase);
    assert.equal(out.modelCalls, 0, `${out.route}: ${out.reply}`);
    assert.match(out.reply, /iPhone|build|patch|install/i);
  });
}
