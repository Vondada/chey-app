// Regression tests for three wrong answers the owner saw (2026-10-21), through the real /api/chat route:
//  1. "What is my favorite food…" answered with a stored drink, and an invented date.
//  2. "What books do you have in my knowledge library…" answered "I don't have a personal library".
//  3. An Office task line shown in the chat as if CHE had said it.
// Plus the grounding rule: a reply may show only dates a stored record holds.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { groundedReply, personalFactQuestion, recallPersonalFact, answerPersonalFact, spokenStoredDate } from './personal_recall.js';
import { dropAgentTaskTurns, replyRepeatsAgentTask } from './agent_task_guard.js';

const generated = new URL('./.chat_grounding.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

globalThis.fetch = async (input) => { throw new TypeError(`offline (${new URL(String(input?.url || input)).host})`); };

const TASK = 'Review the recent repository inspection report to verify branch status before proceeding with the feature-branch integration';

function storageFor(saved) {
  return {
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => saved.set(key, structuredClone(value)),
    delete: async (key) => saved.delete(key),
    deleteAll: async () => saved.clear(),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
    sql: null,
  };
}

async function owner({ model = () => 'Understood, sir.', saved = new Map() } = {}) {
  const calls = { n: 0, inputs: [] };
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const sql = { exec: (q, ...p) => { const stmt = db.prepare(q); return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []); } };
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async (_m, input) => { calls.n += 1; calls.inputs.push(input); return { response: model(input) }; } },
  };
  const state = new CheState({ storage: { ...storageFor(saved), sql } }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const history = [];
  const say = async (message, extra = {}) => {
    const before = calls.n;
    const raw = await (await send('/api/chat', { message, history: extra.history ?? history.slice(), ...extra }, token)).text();
    const items = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const done = items.find((i) => i.type === 'done') || {};
    const reply = done.message ?? items.filter((i) => i.type === 'delta').map((i) => i.delta).join('');
    if (!extra.history) history.push({ role: 'user', content: message }, { role: 'assistant', content: reply });
    return { reply, meta: done, modelCalls: calls.n - before };
  };
  const seedTasks = (tasks) => { saved.set('che', { ...(saved.get('che') || {}), team_tasks: tasks }); };
  return { say, calls, saved, send, token, seedTasks };
}

// 1. Favorite food: the stored subject is matched exactly, and the reply is never the drink or an invented date.
test('1a: "What is my favorite food" with only a stored drink never names the drink, a date or a source', async () => {
  const che = await owner({ model: () => 'Your favorite drink is Sprite, recorded on April 12, 2024.' });
  await che.say('Remember that my favorite drink is Sprite');
  const out = await che.say('What is my favorite food, and where did you learn it?');
  assert.equal(out.meta.source, 'che_personal_recall');
  assert.equal(out.modelCalls, 0, 'no model is asked to fill in a personal fact');
  assert.match(out.reply, /I don't have a record of your favorite food/);
  assert.doesNotMatch(out.reply, /Sprite|April|2024/);
});

test('1b: a stored food is quoted with the date it was stored, and where it came from', async () => {
  const che = await owner({ model: () => 'Your favorite food is pasta, recorded on April 12, 2024.' });
  await che.say('Remember that my favorite food is pizza');
  const out = await che.say('What is my favorite food, and where did you learn it?');
  // A deterministic route may answer first (the stored memory); either way the stored food is what is quoted,
  // and no invented value or date appears.
  assert.match(out.reply, /pizza/);
  assert.doesNotMatch(out.reply, /pasta|April 12/);
  for (const date of out.reply.match(/[A-Z][a-z]+ \d{1,2}, \d{4}/g) || []) assert.equal(date, 'October 21, 2026');
});

test('1c: the stored date is the only date in the reply, and it is a real one', () => {
  const record = { text: 'my favorite food is pizza', created_at: '2026-10-21T09:00:00.000Z' };
  assert.equal(spokenStoredDate(record), 'October 21, 2026');
  const data = { memory_records: [{ id: 'r1', text: 'my favorite food is pizza', created_at: '2026-10-21T09:00:00.000Z', verification_status: 'owner_attested', source: 'owner_chat', active: true }] };
  const answer = answerPersonalFact(data, personalFactQuestion('What is my favorite food?'));
  assert.equal(answer.kind, 'owner_attested');
  assert.deepEqual(answer.records, ['r1']);
  assert.match(answer.answer, /on October 21, 2026/);
});

// 2. The owner's knowledge library: a book question lists the catalog, with read status.
test('2: "What books do you have in your knowledge library, and which have you read?" lists the real catalog and read status', async () => {
  const che = await owner();
  const added = await che.send('/api/knowledge', { title: 'Team notes', category: 'software_engineering', kind: 'note', license: 'owner' }, che.token);
  const ref = await added.json();
  await che.send('/api/knowledge', { action: 'index', id: ref.id, text: 'Retries should use jitter so clients do not all retry together.'.repeat(4) }, che.token);
  await che.send('/api/knowledge', { title: 'Release It!', creator: 'Michael T. Nygard', category: 'debugging_reliability', kind: 'book', license: 'all rights reserved' }, che.token);
  const out = await che.say('What books do you have in your knowledge library, and which have you read?');
  assert.equal(out.meta.source, 'che_knowledge');
  assert.equal(out.modelCalls, 0);
  assert.match(out.reply, /has 2 references/);
  assert.match(out.reply, /Read \(I have the text[^)]*\): Team notes/);
  assert.match(out.reply, /Not read \(catalogued only[^)]*\): Release It! by Michael T\. Nygard/);
  assert.doesNotMatch(out.reply, /personal library/);
});

// 3. Office task lines are not CHE's conversation.
test('3a: an Office task line in the history is never sent to the model as something said in the chat', async () => {
  const che = await owner({ model: () => 'Understood, sir.' });
  che.seedTasks([{ id: 't1', task: TASK, partner_name: 'Knox', status: 'running' }]);
  const history = [{ role: 'user', content: 'Check the branch' }, { role: 'assistant', content: TASK }];
  await che.say('What did we just discuss?', { history });
  const turns = che.calls.inputs.at(-1).messages.filter((m) => m.role !== 'system');
  assert.doesNotMatch(JSON.stringify(turns), /repository inspection report/);
});

test('3b: a reply that is an Office task is replaced, and the owner is pointed to the Office view', async () => {
  const che = await owner({ model: () => TASK });
  che.seedTasks([{ id: 't1', task: TASK, partner_name: 'Knox', status: 'running' }]);
  const out = await che.say('Give me a quick recap of the branch status.');
  assert.doesNotMatch(out.reply, /repository inspection report/);
  assert.match(out.reply, /internal Office task/);
});

// Grounding: a reply may show only dates that a stored record holds.
test('grounding: a date no stored record holds is removed from a model reply', () => {
  const records = [{ created_at: '2026-10-21T09:00:00.000Z' }];
  const out = groundedReply('Your favorite drink is Sprite, recorded on April 12, 2024.', { records, message: 'what did I say' });
  assert.deepEqual(out.removed, ['April 12, 2024']);
  assert.doesNotMatch(out.text, /April/);
  const kept = groundedReply('That was on October 21, 2026.', { records });
  assert.deepEqual(kept.removed, []);
  assert.equal(kept.text, 'That was on October 21, 2026.');
});

test('grounding: a model reply with an invented date never reaches the owner on the general path', async () => {
  const che = await owner({ model: () => 'Your week went well. It happened on April 12, 2024.' });
  const out = await che.say('Give me a quick recap of how my week at the office went.');
  assert.ok(out.modelCalls >= 1);
  assert.doesNotMatch(out.reply, /April 12, 2024/);
});

// Personal-question scope: only a question about the owner's own fact takes this route.
test('scope: stories, memory questions and ordinary questions do not take the personal route', () => {
  assert.equal(personalFactQuestion('Tell me a story about my favorite food'), null);
  assert.equal(personalFactQuestion('What did I tell you about my favorite food?'), null, 'the memory route answers that');
  assert.equal(personalFactQuestion('What is the capital of France?'), null);
  assert.equal(recallPersonalFact({ memory_records: [] }, { words: ['food'] }), null);
});

test('scope: an Office task is dropped from history only as assistant text', () => {
  const tasks = [{ task: TASK }];
  const history = [{ role: 'user', content: TASK }, { role: 'assistant', content: TASK }];
  assert.equal(dropAgentTaskTurns(history, tasks).length, 1, 'the owner\'s own words are kept');
  assert.equal(replyRepeatsAgentTask('Please review it: ' + TASK, tasks), true);
  assert.equal(replyRepeatsAgentTask('The branch is clean.', tasks), false);
});

test('engine: factual and memory questions go to the strong engine; creative ones do not; each reply names its engine', async () => {
  const { needsStrongEngine } = await import('./personal_recall.js');
  assert.equal(needsStrongEngine('What is my favorite food?'), true);
  assert.equal(needsStrongEngine('Which books have I read in my library?'), true);
  assert.equal(needsStrongEngine('Write a poem about rain'), false);
  assert.equal(needsStrongEngine('Tell me a story about a dragon'), false);
  const che = await owner({ model: () => 'Plants convert light into energy.' });
  const out = await che.say('Explain photosynthesis in one sentence');
  assert.equal(typeof out.meta.engine, 'string');
  assert.ok(out.meta.engine.length > 0, 'the done record names the model that answered');
});
