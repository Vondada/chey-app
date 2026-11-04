// Multi-tool turns (multi_tool.js). Certification run 24 (41491194768): ter-36 "Use the image tool, the email tool and the
// timer tool at the same time" was taken by the timer gate, and ter-50 "Chain five tools: weather, news, calendar, email
// and timer" got five invented results from the model. Unit tests with a recording turn runner, then the real
// /api/chat: each tool runs as its own turn of the owner's route and is reported with that turn's receipts, or none.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { multiToolRequest, multiToolTurn, toolOutcome, TOOL_REQUESTS } from './multi_tool.js';

const tool = (id) => TOOL_REQUESTS.find((t) => t.id === id);
const frames = async (res) => (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('a multi-tool request lists the named tools in the owner\'s order; one tool or a plain question is not one', () => {
  assert.deepEqual(multiToolRequest('Use the image tool, the email tool and the timer tool at the same time.').tools.map((t) => t.id), ['image', 'email', 'timer']);
  assert.equal(multiToolRequest('Use the image tool, the email tool and the timer tool at the same time.').together, true);
  assert.deepEqual(multiToolRequest('Chain five tools: weather, news, calendar, email and timer. Report each outcome with its receipt.').tools.map((t) => t.id), ['weather', 'news', 'calendar', 'email', 'timer']);
  for (const q of ["What's the weather and the news today?", 'Use the timer tool.', 'Which tools do you have for weather and news?', "Don't use the email and calendar tools."]) assert.equal(multiToolRequest(q), null, q);
});

test('each outcome is what its own turn returned: a success receipt, blocked, answered without a receipt, or not run', () => {
  assert.equal(toolOutcome(tool('timer'), { ok: true, reply: 'Timer set.', receipts: [{ status: 'success' }] }).status, 'success');
  assert.equal(toolOutcome(tool('email'), { ok: true, reply: 'Gmail is not connected, sir. Nothing was done.', receipts: [] }).status, 'blocked');
  assert.equal(toolOutcome(tool('weather'), { ok: true, reply: 'It is 12 degrees.', receipts: [] }).status, 'no_receipt');
  assert.equal(toolOutcome(tool('news'), { ok: false, reply: '', receipts: [] }).status, 'failed');
});

test('one report: every tool in order, nothing invented, an image without a subject is not run, receipts per step', async () => {
  const asked = [];
  const replies = {
    "What's the weather today?": { ok: true, reply: 'Paris is 12 degrees and cloudy. More later.', done: { source: 'model' }, receipts: [{ tool: 'weather', operation: 'forecast', status: 'success' }] },
    'Read my latest email.': { ok: true, reply: 'Gmail is not connected, sir. Say connect my Gmail. Nothing was done.', done: { source: 'che_google' }, receipts: [] },
    'What timers do I have?': { ok: true, reply: 'You have no timers or reminders, sir. Nothing is running.', done: { source: 'che_timer' }, receipts: [] },
  };
  const ask = multiToolRequest('Use the weather tool, the image tool, the email tool and the timer tool at the same time.');
  const out = await frames(await multiToolTurn(ask, { runTurn: async (text) => { asked.push(text); return replies[text]; }, now: 0 }));
  assert.deepEqual(asked, ["What's the weather today?", 'Read my latest email.', 'What timers do I have?'], 'the image tool is not run without a subject');
  const text = out[0].delta;
  assert.match(text, /^I ran them one after another in this turn, not in parallel\. 1 of 4 tools finished with a receipt, sir\./);
  assert.match(text, /1\. Weather \(done, with a receipt\): Paris is 12 degrees and cloudy\. More later\./);
  assert.match(text, /2\. Image \(not run\): Not run: tell me what the picture should show\./);
  assert.match(text, /3\. Email \(blocked\): Gmail is not connected, sir\./);
  assert.match(text, /4\. Timer \(answered, but with no receipt\): You have no timers or reminders, sir\. Nothing is running\./);
  const done = out[1];
  assert.equal(done.source, 'che_multi_tool');
  assert.deepEqual(done.execution_receipts.map((r) => [r.chain_step, r.status]), [['weather', 'success'], ['image', 'not_run'], ['email', 'failed'], ['timer', 'not_run']]);
});

// Through the real /api/chat.
const generated = new URL('./.multi_tool.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;
globalThis.fetch = async () => new Response('{"error":"offline test"}', { status: 503, headers: { 'Content-Type': 'application/json' } });

function storageMap() {
  const saved = new Map();
  let alarm = null;
  return {
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => saved.has(x)).map((x) => [x, structuredClone(saved.get(x))])) : (saved.has(k) ? structuredClone(saved.get(k)) : undefined)),
    put: async (k, v) => { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) saved.set(a, structuredClone(b)); else saved.set(k, structuredClone(v)); },
    delete: async (k) => saved.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...saved].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async (t) => { alarm = t; }, getAlarm: async () => alarm, deleteAlarm: async () => { alarm = null; },
  };
}

test('/api/chat: ter-36 and ter-50 run each tool through its own route and report every step', async () => {
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'MODEL TEXT' }) } };
  const storage = storageMap();
  const state = new CheState({ storage, waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const post = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), env);
  const token = (await (await post('/api/pair', { code: '123456' })).json()).device_token;
  const ask = async (message) => frames(await post('/api/chat', { message, history: [] }, token));
  const t36 = await ask('Use the image tool, the email tool and the timer tool at the same time.');
  const d36 = t36.find((f) => f.type === 'done');
  assert.equal(d36.source, 'che_multi_tool');
  assert.deepEqual(d36.tools.map((t) => [t.id, t.route]), [['image', 'none'], ['email', 'che_google'], ['timer', 'che_timer']]);
  const t50 = await ask('Chain five tools: weather, news, calendar, email and timer. Report each outcome with its receipt.');
  const d50 = t50.find((f) => f.type === 'done');
  assert.deepEqual(d50.tools.map((t) => t.id), ['weather', 'news', 'calendar', 'email', 'timer']);
  assert.equal(d50.execution_receipts.length >= 5, true);
  assert.match(t50.filter((f) => f.type === 'delta').map((f) => f.delta).join(''), /3\. Calendar \(blocked\): Google Calendar is not connected, sir\./);
  // A certification probe turn runs the same steps as probe turns.
  const probe = await state.probeChat({ message: 'Use the image tool, the email tool and the timer tool at the same time.' });
  assert.match(probe.reply, /0 of 3 tools finished with a receipt, sir\./);
});
