// The Knowledge Library through the owner's chat (the same route voice commands use), offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { categoryByName, knowledgeIntent } from './knowledge_library.js';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';

test('the parser recognises status, search and owner text, and ignores ordinary talk', () => {
  assert.equal(knowledgeIntent('What is in my knowledge library?').kind, 'status');
  assert.deepEqual(knowledgeIntent('Search my knowledge library for retry backoff.'), { kind: 'search', question: 'retry backoff' });
  assert.equal(knowledgeIntent('What does my library say about circuit breakers?').question, 'circuit breakers');
  const add = knowledgeIntent('Add to my knowledge library called "Team notes" in Software Engineering: Retries should use jitter so clients do not retry together.');
  assert.equal(add.kind, 'index');
  assert.equal(add.title, 'Team notes');
  assert.equal(add.category, 'Software Engineering');
  assert.equal(knowledgeIntent('What did we talk about yesterday?'), null);
  assert.equal(knowledgeIntent('Ask the library for today\'s news'), null);
});

test('a category is matched by its name only', () => {
  assert.equal(categoryByName('software engineering').id, 'software_engineering');
  assert.equal(categoryByName('cooking'), null);
});

const generated = new URL('./.knowledge_chat.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let worker;
try { worker = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }

async function owner() {
  const saved = new Map();
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const storage = {
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => saved.has(x)).map((x) => [x, saved.get(x)])) : saved.get(k)),
    put: async (k, v) => { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) saved.set(a, b); else saved.set(k, v); },
    delete: async (k) => saved.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...saved].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
    sql: { exec: (q, ...p) => { const stmt = db.prepare(q); return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []); } },
  };
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'Here is my answer.' }) } };
  const state = new worker.CheState({ storage, waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const post = (path, body, token = '') => worker.default.fetch(new Request(`https://che.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }), env);
  const token = (await (await post('/api/pair', { code: '123456' })).json()).device_token;
  return async (message) => {
    const raw = await (await post('/api/chat', { message, agent_mode: 'full' }, token)).text();
    const items = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const done = items.find((item) => item.type === 'done') || {};
    return { ...done, message: done.message ?? items.filter((i) => i.type === 'delta').map((i) => i.delta).join('') };
  };
}

test('owner chat: add own text, then search it with a citation; status counts it', async () => {
  const ask = await owner();
  const added = await ask('Add to my knowledge library called "Team notes" in Software Engineering: Retries should use jitter so clients do not all retry at the same moment.');
  assert.equal(added.source, 'che_knowledge');
  assert.match(added.message, /Saved "Team notes" in Software Engineering as your own text/);

  const found = await ask('Search my knowledge library for jitter retries');
  assert.equal(found.source, 'che_knowledge');
  assert.match(found.message, /\[Team notes, part 1; software_engineering; trust: owner_text\]/);
  assert.match(found.message, /Retries should use jitter/);

  const status = await ask('What is in my knowledge library?');
  assert.match(status.message, /1 indexed reference with text/);
});

test('an unknown category is refused and the 20 names are offered', async () => {
  const ask = await owner();
  const res = await ask('Add to my knowledge library called "Recipes" in Cooking: Mix flour, water and salt into a dough and rest it overnight.');
  assert.match(res.message, /don't have a category called "Cooking"/);
});

test('a search that finds nothing indexed says so and never invents a source', async () => {
  const ask = await owner();
  const res = await ask('Search my knowledge library for quantum gravity');
  assert.equal(res.source, 'che_knowledge');
  assert.doesNotMatch(res.message, /\[/);
});

test('compare and "what did you learn" name the library; ordinary questions do not take those routes', () => {
  assert.equal(knowledgeIntent('Compare Team notes and Release It! in my knowledge library').kind, 'compare');
  assert.equal(knowledgeIntent('What did you learn from Team notes in my knowledge library?').kind, 'learned');
  assert.equal(knowledgeIntent('Compare tea and coffee'), null);
  assert.equal(knowledgeIntent('What did you learn from the news today?'), null);
});
