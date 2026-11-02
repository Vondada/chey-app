// An Office task line must never be shown as CHE's own words (owner, 2026-10-21), but it must not wipe a correct answer
// to an unrelated question either. Certification runs 17 and 18 lost ten such answers on the quality route: the Brain's
// Office task records were put in the model's context for any question that shared words with a task, the model
// repeated a task line, and the guard replaced the whole reply with the Office notice.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { AGENT_TASK_NOTICE, asksAboutAgentWork, asksAboutOffice, chatBrainHit, guardAgentTaskReply, isOfficeWorkRecord } from './agent_task_guard.js';
import { CheBrainStore, projectLegacyState } from './brain_store.js';

const TASK = 'Cross-check every figure in the quarterly newsletter draft against the original survey spreadsheet before it goes out';
const TASKS = [{ id: 'tk1', task: TASK, partner_name: 'Iris', status: 'running' }];

// ── The guard is proportionate ──────────────────────────────────────────────

test('an answer that quotes a task line loses that line and keeps its other sentences', () => {
  const reply = `Start with the primary source and read the full passage around the claim. ${TASK}. Then compare the wording with a second independent record, and note any differences you find.`;
  const out = guardAgentTaskReply(reply, TASKS);
  assert.doesNotMatch(out.text, /quarterly newsletter/);
  assert.match(out.text, /^Start with the primary source/);
  assert.match(out.text, /second independent record/);
  assert.notEqual(out.text, AGENT_TASK_NOTICE);
  assert.equal(out.removed.length, 1);
});

test('a task line inside a numbered list is removed with its item number; the other items stay', () => {
  const reply = `Here is how I would do it, sir:\n1. Find the earliest published version of the claim.\n2. ${TASK}.\n3. Ask the original author or publisher to confirm the figure.`;
  const out = guardAgentTaskReply(reply, TASKS);
  assert.doesNotMatch(out.text, /newsletter/);
  assert.doesNotMatch(out.text, /^2\.\s*$/m);
  assert.match(out.text, /1\. Find the earliest/);
  assert.match(out.text, /3\. Ask the original author/);
});

test('a reply that is only the task line gets the Office notice', () => {
  assert.equal(guardAgentTaskReply(TASK, TASKS).text, AGENT_TASK_NOTICE);
  assert.equal(guardAgentTaskReply(`"${TASK}."`, TASKS).text, AGENT_TASK_NOTICE);
  assert.equal(guardAgentTaskReply(`Sure, sir. ${TASK}.`, TASKS).text, AGENT_TASK_NOTICE, 'under eight words remain');
});

test('a long verbatim piece of a task line is still caught', () => {
  const out = guardAgentTaskReply('Good question. Every figure in the quarterly newsletter draft against the original survey. That is the plan for today and tomorrow morning, sir.', TASKS);
  assert.doesNotMatch(out.text, /quarterly newsletter/);
  assert.match(out.text, /That is the plan/);
});

test('an unrelated answer that only shares a common phrase with a task is untouched', () => {
  const reply = 'Before you share a chart, cross-check every figure against its source. Look for the original survey, its sample size and its date, and say where you could not confirm a number.';
  const out = guardAgentTaskReply(reply, TASKS);
  assert.equal(out.text, reply);
  assert.deepEqual(out.removed, []);
});

test('no tasks, or tasks too short to count, leave the reply alone', () => {
  assert.equal(guardAgentTaskReply('Anything at all, sir.', []).text, 'Anything at all, sir.');
  assert.equal(guardAgentTaskReply('Ship it today.', [{ task: 'Ship it' }]).text, 'Ship it today.');
});

// ── Task lines stay out of the model's context for unrelated questions ──────

test('Office work records are grounding only when the owner asks about the Office or its tasks', () => {
  const task = { kind: 'task', region: 'Active and Historical Tasks', title: TASK, body: 'Status: running', source: { kind: 'team_task' } };
  const note = { kind: 'memory', region: 'Personal Memory', title: 'Survey habits', body: 'The owner checks survey dates.' };
  assert.equal(isOfficeWorkRecord(task), true);
  assert.equal(isOfficeWorkRecord(note), false);
  assert.equal(asksAboutOffice('How do I check the figures in a survey before I quote them?'), false);
  assert.equal(asksAboutOffice('What is Iris working on?'), true);
  assert.equal(asksAboutOffice('Recap the open tasks in the office'), true);
  // A generic work noun alone is not the Office (certification run 19, eer-30); work in progress or the owner's list is.
  assert.equal(asksAboutOffice('Two invoice records disagree on whether a refund job ran. How should I reconcile them?'), false);
  assert.equal(asksAboutOffice('Is a background job the same thing as a cron task?'), false);
  assert.equal(asksAboutOffice('What jobs are running right now?'), true);
  assert.equal(asksAboutOffice('Show me my tasks'), true);
  assert.equal(asksAboutOffice('How is my quarterly newsletter task going?'), true);
  assert.equal(asksAboutOffice('How long is the job queue?'), true);
  assert.equal(asksAboutOffice('Have the research desk take this'), true);
  assert.deepEqual([task, note].filter(chatBrainHit('How do I check the figures in a survey before I quote them?')), [note]);
  assert.deepEqual([task, note].filter(chatBrainHit('What tasks are open in the office?')), [task, note]);
});

const generated = new URL('./.office_task_echo.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;
globalThis.fetch = async (input) => { throw new TypeError(`offline (${new URL(String(input?.url || input)).host})`); };

async function owner(model, tasks = TASKS) {
  const saved = new Map();
  const storage = {
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => saved.set(key, structuredClone(value)),
    delete: async (key) => saved.delete(key),
    deleteAll: async () => saved.clear(),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const sql = { exec: (q, ...p) => { const stmt = db.prepare(q); return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []); } };
  const inputs = [];
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async (_m, input) => { inputs.push(input); return { response: model(input) }; } },
  };
  const state = new CheState({ storage: { ...storage, sql } }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  saved.set('che', { ...(saved.get('che') || {}), team_tasks: tasks });
  const store = new CheBrainStore({ ...storage, sql });
  store.init();
  projectLegacyState(store, { team_tasks: tasks }, { tasks: true });
  const say = async (message) => {
    const raw = await (await send('/api/chat', { message, history: [] }, token)).text();
    const items = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const done = items.find((i) => i.type === 'done') || {};
    return done.message ?? items.filter((i) => i.type === 'delta').map((i) => i.delta).join('');
  };
  return { say, inputs, store };
}

const QUESTION = 'What is a sensible way to cross-check the figures in a survey before I quote them in a newsletter?';

test('an unrelated question never carries an Office task line into the model context', async () => {
  const che = await owner(() => 'Find the original survey, check its sample size and date, and compare each figure you quote with the published table.');
  assert.ok(che.store.search(QUESTION, { limit: 6 }).some((r) => r.kind === 'task'), 'the Brain does hold a matching task record');
  const reply = await che.say(QUESTION);
  assert.ok(che.inputs.length >= 1, 'the model answered');
  assert.doesNotMatch(JSON.stringify(che.inputs), /quarterly newsletter draft/);
  assert.match(reply, /original survey/);
});

test('through /api/chat, a reply that quotes a task line keeps the rest of the answer', async () => {
  const che = await owner(() => `Find the original survey and check its sample size and date. ${TASK}. Then compare each figure you quote with the published table, sir.`);
  const reply = await che.say(QUESTION);
  assert.doesNotMatch(reply, /quarterly newsletter draft/);
  assert.match(reply, /published table/);
  assert.doesNotMatch(reply, /internal Office task/);
});

// ── The owner's own words are never an Office leak (certification run 20) ──
// A desk that advises on a chat answer is stored as an `advisory` task whose line is the owner's message. A reply that
// restated the question then lost everything to the Office notice. The wording below is not from the question bank.

const ASK = 'Pass the half-finished ticket to a fresh worker when the old one stalls, and confirm it picked up.';

test('restating the owner\'s message is not a leak, whether it is an advisory record or the current request', () => {
  const reply = `${ASK} I would check its saved state first.`;
  const advisory = [{ id: 'a1', task: ASK, status: 'advisory', partner_name: 'Atlas' }];
  assert.deepEqual(guardAgentTaskReply(reply, advisory), { text: reply, removed: [] }, 'an advisory line is the owner\'s words');
  const running = [{ id: 'r1', task: ASK, status: 'running', partner_name: 'Atlas' }];
  assert.deepEqual(guardAgentTaskReply(reply, running, ASK), { text: reply, removed: [] }, 'the request being answered now');
  assert.equal(guardAgentTaskReply(reply, running).text, AGENT_TASK_NOTICE, 'with no owner message the old rule holds');
});

test('a sentence quoting the owner\'s message stays, while a real task line in the same reply is removed', () => {
  const msg = 'Get sign-off from the four regional leads at once and log every reply they send back.';
  const reply = `Get sign-off from the four regional leads at once. ${TASK}. I would send all four requests together and log each reply with its time.`;
  const out = guardAgentTaskReply(reply, TASKS, msg);
  assert.match(out.text, /^Get sign-off from the four regional leads at once\./);
  assert.doesNotMatch(out.text, /quarterly newsletter/);
  assert.equal(out.removed.length, 1);
});

test('on a question about agent work, a short answer left after a leaked line stays instead of the notice', () => {
  const msg = 'Can one desk overrule the scheduler and start every job at the same time?';
  const out = guardAgentTaskReply(`No, sir: order matters. ${TASK}.`, TASKS, msg);
  assert.equal(out.text, 'No, sir: order matters.');
  assert.equal(guardAgentTaskReply(TASK, TASKS, msg).text, AGENT_TASK_NOTICE, 'nothing left is still the notice');
  assert.equal(guardAgentTaskReply(`Sure, sir. ${TASK}.`, TASKS, 'Give me a quick recap of the branch.').text, AGENT_TASK_NOTICE);
  assert.equal(asksAboutAgentWork('Who should approve the vendor change, and in what order?'), true);
  assert.equal(asksAboutAgentWork('Hand the draft over to the second reviewer.'), true);
  assert.equal(asksAboutAgentWork('What is the capital of Peru?'), false);
  assert.equal(asksAboutOffice('Who should approve the vendor change, and in what order?'), false, 'grounding stays narrow');
});

test('through /api/chat, an advisory record of the owner\'s question does not hide the answer', async () => {
  const msg = 'Line up approvals from the three site leads in parallel and keep a note of each verdict.';
  const che = await owner(() => `${msg} I would ask all three at once and note each verdict with its time.`,
    [...TASKS, { id: 'a2', task: msg, status: 'advisory', partner_name: 'Nova' }]);
  const reply = await che.say(msg);
  assert.doesNotMatch(reply, /internal Office task/);
  assert.match(reply, /note each verdict/);
});

// ── A bare continuation never gets the Office notice (certification run 23, vcc-24) ──
// "Keep going." has no topic, so a reply that only repeated a task line used to become "That is an internal Office
// task". The notice answers a question nobody asked; the honest answer says what can be continued. Not bank wording.

test('a bare continuation that leaked only a task line is answered honestly, not with the Office notice', async () => {
  const none = guardAgentTaskReply(`Sure, sir. ${TASK}.`, TASKS, 'Carry on, please.');
  assert.equal(none.text, 'I don\'t have anything in progress to continue, sir. What should I pick up?');
  assert.equal(none.removed[0].rule, 'office_task_reply', 'the removal is still recorded');
  const talk = guardAgentTaskReply(TASK, TASKS, 'Okay, go on.', { history: [{ role: 'user', content: 'Plan my week.' }, { role: 'assistant', content: 'Monday is free.' }] });
  assert.equal(talk.text, 'I lost the thread there, sir. What should I continue with?');
  const kept = `Here is the next step, sir: read the second chapter and write down the three questions it raises. ${TASK}.`;
  assert.doesNotMatch(guardAgentTaskReply(kept, TASKS, 'Go on.').text, /quarterly newsletter|Office/, 'a real answer left over still stays');
  assert.equal(guardAgentTaskReply(TASK, TASKS, 'Carry on with the newsletter check.').text, AGENT_TASK_NOTICE, 'a turn with a topic keeps the old rule');
  const che = await owner(() => TASK);
  const reply = await che.say('Alright, carry on.');
  assert.doesNotMatch(reply, /internal Office task|quarterly newsletter/);
  assert.match(reply, /continue/);
});
