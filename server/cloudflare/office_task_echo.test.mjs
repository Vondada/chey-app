// An Office task line must never be shown as CHE's own words (owner, 2026-10-21), but it must not wipe a correct answer
// to an unrelated question either. Certification runs 17 and 18 lost ten such answers on the quality route: the Brain's
// Office task records were put in the model's context for any question that shared words with a task, the model
// repeated a task line, and the guard replaced the whole reply with the Office notice.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { AGENT_TASK_NOTICE, asksAboutOffice, chatBrainHit, guardAgentTaskReply, isOfficeWorkRecord } from './agent_task_guard.js';
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

async function owner(model) {
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
  saved.set('che', { ...(saved.get('che') || {}), team_tasks: TASKS });
  const store = new CheBrainStore({ ...storage, sql });
  store.init();
  projectLegacyState(store, { team_tasks: TASKS }, { tasks: true });
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
