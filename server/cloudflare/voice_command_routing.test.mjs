// Voice command routing (reliability lane rel-infra-app, 2026-10-25). The owner speaks; iOS speech recognition hands
// CHE lowercase words with no punctuation, often with the wake word in front ("chay ...") and "please" or "sir" around
// them. Each command must reach the same route by voice as typed, through the real /api/chat, with no model call: a
// status or control route answered by the model can invent a result. Phone-side routes (screen edits, UI, vault,
// navigation) are covered in test/che_voice_route_order_test.dart; the version phrases in version_truth.test.mjs.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';

globalThis.fetch = async () => new Response('{"error":"offline test"}', { status: 503, headers: { 'Content-Type': 'application/json' } });

const generated = new URL('./.voice_command_routing.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

const MODEL = 'MODEL: yes sir, all done, deployed, cancelled and live.';

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
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => { calls += 1; return { response: MODEL }; } } };
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

// Route → the owner's phrasings: typed, as speech recognition delivers it, and with the wake word.
const ROUTES = {
  che_command_center: ['What commands do you have?', 'what commands do you have', 'chay what commands do you have'],
  che_coding_cancel: ['/che-cancel-job', 'Cancel the coding job.', 'cancel the coding job', 'Chay, cancel the coding job.', 'stop the coding job please'],
  che_coding_history: ['Coding status', 'coding status', 'hey chey whats the coding status', 'how is the coding job going', 'is the coding job done',
    // Reached the model before 2026-10-25 (code_scout.js codingHistoryIntent had no "what is … doing" form).
    'what is the coding job doing', 'What is the coding job doing right now?', 'chay what is my coding job working on', 'where is the coding job at'],
  che_mission_status: ['Mission status', 'mission status', 'chay mission status'],
  che_runtime_status: ['What version of CHE am I running?', 'what version of che am i running', 'is the new build installed on my phone', 'did the update go through', 'chay whats on my iphone right now'],
  che_self_update: ['What was the last deploy?', 'what was the last deploy', 'did the latest deployment succeed'],
  che_app_build: ['App build status', 'app build status'],
  che_strategy_sim: ['Pause the strategy simulation.', 'pause the strategy simulation', 'chay pause the strategy simulation', 'resume the strategy simulation'],
  che_trading_desk: ['What are my trading connections?', 'what are my trading connections', 'Trading status', 'trading status'],
  che_command_workflow: ['run a workflow to che memory my business then che plan a report'],
};

for (const [route, phrases] of Object.entries(ROUTES)) {
  test(`voice and typed forms reach ${route} with no model call`, async () => {
    for (const phrase of phrases) {
      const say = await owner(); // a fresh CHE per phrase: no turn leans on the one before
      const out = await say(phrase);
      assert.equal(out.route, route, `"${phrase}" → ${out.route}: ${out.reply.slice(0, 160)}`);
      assert.equal(out.modelCalls, 0, `"${phrase}" asked the model`);
      assert.doesNotMatch(out.reply, /^MODEL:/, phrase);
    }
  });
}

test('ordinary conversation that mentions command words still goes to the model', async () => {
  for (const phrase of ['write an essay about why deploying on fridays is risky', 'tell me a joke', 'what is a coding job', 'explain how a mission status page should look']) {
    const say = await owner();
    const out = await say(phrase);
    assert.notEqual(out.route, 'che_coding_cancel', phrase);
    assert.notEqual(out.route, 'che_coding_history', phrase);
    assert.notEqual(out.route, 'che_mission_status', phrase);
    assert.notEqual(out.route, 'che_self_update', phrase);
  }
});

// The owner's word order "is the MNQ data live" / "is the crypto feed live": a deterministic answer from the feed
// records (trading_connections.speakFeedLive, Trading Room v3), never the model. With nothing recorded it says so;
// it never calls signing in, or a delayed bar, live.
for (const [phrase, words] of [['is the mnq data live', /no Rithmic minute has been recorded/], ['is the crypto feed live', /Coinbase/], ['chay is the btc chart real time', /Coinbase/], ['is the rithmic feed live', /Rithmic/]]) {
  test(`"${phrase}" is answered from the market feed record, not the model`, async () => {
    const say = await owner();
    const out = await say(phrase);
    assert.equal(out.modelCalls, 0, `${out.route}: ${out.reply}`);
    assert.equal(out.route, 'che_trading_desk', out.reply);
    assert.match(out.reply, words);
    assert.doesNotMatch(out.reply, /^Yes, sir: live/);
  });
}
