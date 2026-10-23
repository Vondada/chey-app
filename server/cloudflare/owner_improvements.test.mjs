// Owner Improvements (owner, 2026-10-23): the owner's exact sentences through the real /api/chat route, the
// ledger, read-back verification, the iPhone's apply receipt, undo, recurring complaints and coding delegation.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';
import { IMPROVEMENTS_KEY, UI_CONFIG, handleImprovement, improvementIntent, loadImprovements, recordApplied } from './owner_improvements.js';

const generated = new URL('./.owner_improvements.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

globalThis.fetch = async (input) => {
  throw new TypeError(`fetch failed (owner_improvements tests are offline: ${new URL(String(input?.url || input)).host})`);
};

function storageFor(saved) {
  return {
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => saved.set(key, structuredClone(value)),
    delete: async (key) => saved.delete(key),
    deleteAll: async () => saved.clear(),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

async function owner({ saved = new Map(), model = () => 'Understood, sir.' } = {}) {
  const counter = { calls: 0 };
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async (_model, input) => { counter.calls += 1; return { response: model(input) }; } },
  };
  const state = new CheState({ storage: storageFor(saved) }, env);
  env.CHE_STATE = { getByName: () => state };
  const call = (path, body, token = '', method = 'POST') => worker.fetch(new Request(`https://che.example${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  }), env);
  const token = (await (await call('/api/pair', { code: '123456' })).json()).device_token;
  const say = async (message, extra = {}) => {
    const before = counter.calls;
    const raw = await (await call('/api/chat', { message, history: [], ...extra }, token)).text();
    const done = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((item) => item.type === 'done') || {};
    return { reply: replyFromNdjson(raw), meta: done, modelCalls: counter.calls - before };
  };
  const get = async (path) => (await call(path, null, token, 'GET')).json();
  const post = async (path, body) => { const r = await call(path, body, token); return { status: r.status, body: await r.json() }; };
  return { say, get, post, saved };
}

test('acceptance: "This page is too cramped" on a supported screen is applied, read back, confirmed by the iPhone and remembered', async () => {
  const che = await owner();
  const out = await che.say('This page is too cramped.', { active_screen: 'Trading Room' });
  assert.equal(out.meta.source, 'che_owner_improvement');
  assert.equal(out.modelCalls, 0);
  assert.match(out.reply, /from comfortable to spacious/);
  assert.match(out.reply, /I read it back: spacious/);
  assert.match(out.reply, /undo that/);
  assert.equal(out.meta.ui_config.values['layout.density'], 'spacious');
  assert.equal(out.meta.improvement_status, 'testing', 'not verified until the iPhone confirms');
  const id = out.meta.improvement_id;
  assert.match(id, /^imp-\d{8}-\d{3}$/);

  // The iPhone applies it and reports the value it now uses.
  const applied = await che.post(`/api/owner/improvements/${id}/applied`, { applied: { 'layout.density': 'spacious' }, build: '1.4.0+patch 9' });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.status, 'verified');
  const view = await che.get('/api/owner/improvements');
  const task = view.tasks.find((t) => t.id === id);
  assert.equal(task.status, 'verified');
  assert.deepEqual(task.history.map((h) => h.status), ['requested', 'configuring', 'testing', 'verified']);
  assert.ok(task.evidence.some((e) => /iPhone applied layout.density = spacious/.test(e)));
  // Remembered: the preference survives and the app reads it on startup.
  assert.equal((await che.get('/api/owner/ui-config')).values['layout.density'], 'spacious');
});

test('the owner\'s sentences each become a traceable task', async () => {
  const che = await owner();
  const chart = await che.say('Make the chart smaller.');
  assert.match(chart.reply, /chart size from standard to compact/);
  assert.equal(chart.meta.ui_config.values['chart.height'], 'compact');

  const green = await che.say('Use chrome green for successful actions.');
  assert.match(green.reply, /success color from mint to chrome green/);

  const portrait = await che.say('Remember that I prefer portrait charts.');
  assert.match(portrait.reply, /chart shape from following the iPhone to portrait/);
  assert.match(portrait.reply, /saved it as your preference/);

  const ids = [chart, green, portrait].map((o) => o.meta.improvement_id);
  assert.equal(new Set(ids).size, 3);
  const view = await che.get('/api/owner/improvements');
  assert.deepEqual(view.tasks.map((t) => t.id).sort(), [...ids].sort());
  assert.ok(view.schema['chart.height'], 'the app reads the allow-list');
});

test('a setting that cannot move further is not repeated: it becomes a coding task with the history', async () => {
  const che = await owner();
  await che.say('Make the chart smaller.');
  const again = await che.say('Make the chart smaller.');
  assert.match(again.reply, /Chart size is already compact, the smallest setting/);
  assert.match(again.reply, /You raised this once before: imp-\d{8}-001, where I changed chart size from standard to compact/);
  assert.match(again.reply, /needs a code change/);
  const state = await loadImprovements({ get: async (k) => che.saved.get(k) });
  const task = state.tasks[0];
  assert.equal(task.kind, 'code');
  assert.ok(task.related.includes(state.tasks[1].id));
  assert.match(task.brief, /Earlier attempts, do not repeat them: imp-\d{8}-001 \(testing\) changed chart.height standard→compact/);
  assert.ok(task.acceptance.length >= 3);
  // No GitHub here, so no job may be claimed.
  assert.equal(task.job_id, null);
  assert.doesNotMatch(again.reply, /sent it to my engineers as job/);
});

test('code work: no screen → CHE asks which; with a screen it goes to the real coding pipeline and records its answer', async () => {
  const che = await owner();
  const ask = await che.say('Stop showing repeated information.');
  assert.match(ask.reply, /Which screen is it on\?/);
  assert.equal(ask.meta.improvement_status, 'requested');

  const nav = await che.say('Fix this navigation problem.', { active_screen: 'Brain Room' });
  assert.equal(nav.meta.source, 'che_owner_improvement');
  const state = await loadImprovements({ get: async (k) => che.saved.get(k) });
  const task = state.tasks.find((t) => t.id === nav.meta.improvement_id);
  assert.equal(task.screen, 'Brain Room');
  assert.match(task.brief, /^Update your code: Fix this navigation problem\. \(owner was on the Brain Room screen\)/);
  // The coding pipeline has no GitHub connection in this test: the task says what it answered and claims no job.
  assert.equal(task.job_id, null);
  assert.equal(task.status, 'failed', 'no job id: blocked, never shown as coding');
  assert.ok(task.evidence.some((e) => /^Coding pipeline answered:/.test(e)));
  assert.doesNotMatch(nav.reply, /as job [0-9a-f]{8}/);

  // "Start coding task" on the logged one goes through the same pipeline.
  const start = await che.say(`Start coding task ${ask.meta.improvement_id}`);
  assert.equal(start.meta.source, 'che_owner_improvement');
  assert.equal(start.meta.improvement_action, 'start');
});

test('a density complaint on a screen that does not read density is not "fixed" by a setting', async () => {
  const che = await owner();
  const out = await che.say('This page is too cramped.', { active_screen: 'Brain Room' });
  assert.match(out.reply, /The Brain Room screen does not read the layout density setting yet/);
  assert.equal(out.meta.ui_config, undefined, 'nothing was changed');
});

test('undo puts the previous value back, reads it back, and the dashboard button does the same', async () => {
  const che = await owner();
  await che.say('Make the chart smaller.');
  const undo = await che.say('Undo that.');
  assert.match(undo.reply, /Undone\. The chart size is back to standard from compact; I read it back/);
  assert.equal(undo.meta.ui_config.values['chart.height'], 'standard');

  const green = await che.say('Use chrome green for successful actions.');
  const button = await che.post(`/api/owner/improvements/${green.meta.improvement_id}/undo`, {});
  assert.equal(button.status, 200);
  assert.equal(button.body.ui_config.values['status.success_color'], 'mint');
  const again = await che.post(`/api/owner/improvements/${green.meta.improvement_id}/undo`, {});
  assert.equal(again.status, 409, 'an undone change cannot be undone twice');
});

test('an iPhone that applied something else fails the task and reverts the stored value', async () => {
  const che = await owner();
  const out = await che.say('Make the chart smaller.');
  const r = await che.post(`/api/owner/improvements/${out.meta.improvement_id}/applied`, { applied: { 'chart.height': 'standard' } });
  assert.equal(r.body.status, 'failed');
  assert.equal(r.body.ui_config.values['chart.height'], 'standard');
});

test('unsupported options are never pretended', async () => {
  const che = await owner();
  const out = await che.say('Use green for the buttons.');
  assert.match(out.reply, /^That isn't configurable yet/);
  assert.match(out.reply, /I can open a coding task for it: say "start coding task imp-/);
  assert.equal(out.meta.ui_config, undefined);
  const red = await che.say('Use red for successful actions.');
  assert.match(red.reply, /success can be mint, chrome green, ice or silver/);
});

test('"why does this feature keep failing?" reads the real history and never claims a cause', async () => {
  const che = await owner();
  const first = await che.say('Why does this feature keep failing?', { active_screen: 'Home' });
  assert.match(first.reply, /no recorded failure for that on Home yet, so I won't guess/);
  const second = await che.say('Why does this feature keep failing?', { active_screen: 'Home' });
  assert.match(second.reply, /You raised this once before: imp-/);
  assert.match(second.reply, /I have not verified a root cause yet, so I won't call it fixed/);
  assert.equal(second.meta.improvement_status, 'investigating');
});

test('high-impact requests are logged but never started or applied automatically', async () => {
  const saved = new Map();
  const delegated = [];
  const out = await handleImprovement(storageFor(saved), { kind: 'code', area: 'navigation', words: 'Stop showing the delete button and remove the Face ID prompt' },
    { screen: 'Security', delegate: async (b) => { delegated.push(b); return { ok: true, job_id: 'x' }; } });
  assert.equal(out.task.status, 'awaiting_approval');
  assert.equal(delegated.length, 0);
  assert.match(out.text, /never change automatically/);
});

test('a reachable coding pipeline: the task keeps the job id it returned', async () => {
  const saved = new Map();
  const out = await handleImprovement(storageFor(saved), { kind: 'code', area: 'repetition', words: 'Stop showing repeated information.' },
    { screen: 'Trading Room', delegate: async () => ({ ok: true, job_id: 'abcdef12-3456', text: 'I accepted coding job abcdef12, sir. It is queued, not running yet.' }) });
  assert.equal(out.task.status, 'coding');
  assert.equal(out.task.job_id, 'abcdef12-3456');
  assert.match(out.text, /sent it to my engineers as job abcdef12/);
  assert.match(out.text, /only call it done after its checks pass and it is deployed/);
});

test('ordinary sentences are not improvement requests', () => {
  for (const s of [
    'My room is too cramped.', 'My home is too cramped.', 'The subway is too crowded.', 'Why does my car keep failing inspection?',
    'Why does it keep raining?', 'I prefer coffee.', 'I want a pizza.', 'Make a chart of my expenses.', 'Stop repeating yourself.',
    'Show me the chart.', 'Make the text bigger.', 'Undo the trading settings change.', 'The market is too busy today.',
    'Use the speaker.', 'What is on my screen?', 'Remember that my favorite drink is Sprite.', 'Draw a line at 21450.',
  ]) assert.equal(improvementIntent(s), null, s);
  assert.equal(improvementIntent('Undo that', { visualOpen: true }), null, 'Visual Studio owns undo while a project is open');
});

test('the allow-list only names settings the iPhone app consumes', () => {
  const dart = readFileSync(new URL('../../lib/che_ui/che_ui_preferences.dart', import.meta.url), 'utf8');
  for (const [key, spec] of Object.entries(UI_CONFIG)) {
    assert.ok(dart.includes(`'${key}'`), `${key} is read by CheUiPreferences.applyOwnerConfig`);
    for (const v of spec.values) assert.ok(dart.includes(`'${v}'`) || new RegExp(`\\b${v}\\b`).test(dart), `${key}=${v} is handled in Dart`);
  }
  assert.equal(IMPROVEMENTS_KEY, 'owner_improvements');
});

test('a guest device cannot read or change owner improvements', async () => {
  const saved = new Map();
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1' };
  const state = new CheState({ storage: storageFor(saved) }, env);
  env.CHE_STATE = { getByName: () => state };
  const r = await worker.fetch(new Request('https://che.example/api/owner/improvements'), env);
  assert.ok([401, 403].includes(r.status));
  await recordApplied(storageFor(saved), 'imp-20261023-001', { applied: {} }).then((out) => assert.equal(out.status, 404));
});
