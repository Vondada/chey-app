// Notes and lists CHE really keeps (owner_lists.js), end to end through the real /api/chat, offline (fake model, no
// network). Checks receipts and stored state: a change is written, read back, and receipted from the read-back; a
// removal waits for the owner's yes; probe turns use their own key; a failed write says nothing changed; and questions or
// writing requests that only mention a list never reach the lists.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { LISTS_KEY, PROBE_LISTS_KEY, listChatTurn, listIntent, listName } from './owner_lists.js';

globalThis.fetch = async () => new Response('{"error":"offline test"}', { status: 503 });

const generated = new URL('./.owner_lists.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

// `failPut(key)` true makes a write of that key throw; `dropPut(key)` true makes it vanish without an error.
function storageMap({ failPut = () => false, dropPut = () => false } = {}) {
  const saved = new Map();
  let alarm = null;
  const put1 = (k, v) => {
    if (failPut(k)) throw new Error('storage write refused');
    if (!dropPut(k)) saved.set(k, structuredClone(v));
  };
  return {
    saved,
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => saved.has(x)).map((x) => [x, structuredClone(saved.get(x))])) : (saved.has(k) ? structuredClone(saved.get(k)) : undefined)),
    put: async (k, v) => { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) put1(a, b); else put1(k, v); },
    delete: async (k) => saved.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...saved].filter(([key]) => key.startsWith(prefix))),
    setAlarm: async (at) => { alarm = at; },
    getAlarm: async () => alarm,
    deleteAlarm: async () => { alarm = null; },
  };
}

const PROBE = 'probe-token-0123456789abcdef0123456789';

async function che(storageOptions) {
  const storage = storageMap(storageOptions);
  let modelCalls = 0;
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', CHE_TIMEZONE: 'UTC', CHE_VOICE_PROBE_TOKEN: PROBE,
    AI: { run: async () => { modelCalls += 1; return { response: 'Sure thing, sir.' }; } } };
  const state = new CheState({ storage, waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const post = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), env);
  const token = (await (await post('/api/pair', { code: '123456' })).json()).device_token;
  const say = async (message) => {
    const raw = await (await post('/api/chat', { message, history: [] }, token)).text();
    const frames = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return {}; } });
    const done = frames.find((f) => f.type === 'done') || (frames.length === 1 ? frames[0] : {});
    return { done, reply: frames.filter((f) => f.type === 'delta').map((f) => f.delta).join('') || done.reply || '' };
  };
  const probe = async (message) => (await post('/api/probe/chat', { message }, PROBE)).json();
  return { say, probe, storage, models: () => modelCalls };
}

const items = (storage, key, list) => (storage.saved.get(key)?.lists?.[list]?.items || []).map((i) => i.text);

test('requests are read for their list and items; questions and writing requests are not list requests', () => {
  assert.deepEqual(listIntent('Could you put oat milk and bananas on our groceries list please'), { action: 'add', list: 'shopping', unnamed: false, mine: true, items: ['oat milk', 'bananas'] });
  assert.deepEqual(listIntent('Jot down: the gate code is 4412'), { action: 'note', list: 'notes', unnamed: false, mine: true, items: ['the gate code is 4412'] });
  assert.deepEqual(listIntent('Make a note to call the dentist'), { action: 'note', list: 'notes', unnamed: false, mine: true, items: ['call the dentist'] });
  assert.equal(listIntent('Read me my todo list').action, 'read');
  assert.equal(listIntent('Take the batteries off my packing list').action, 'remove');
  assert.equal(listIntent('Empty my to-do list').action, 'clear');
  assert.equal(listIntent('Remove everything from my reading list').action, 'clear');
  assert.equal(listName('groceries'), 'shopping');
  assert.equal(listName('to do'), 'to-do');
  for (const ask of [
    'What is a shopping list?', 'Give me three reasons to keep a grocery list.', 'List three ways to save money.',
    'Make a list of five fruits.', 'Show me the list of supported models.', 'Add a retry step to the list of checks.',
    'Add error handling to the to-do list in the README.', 'Write a note to my teacher saying I am sick.',
    'Add Bob to the mailing list.', 'Read my last note in notes.', 'Open the Notes app.', 'Add it to my list.', 'Note that the meeting moved to 3pm.', 'How do I share my notes?',
  ]) assert.equal(listIntent(ask), null, ask);
});

test('adds, notes and reads run for real: stored, read back, receipted, no model call', async () => {
  const c = await che();
  const before = c.models();
  const add = await c.say('Could you put oat milk and bananas on our groceries list please');
  assert.equal(add.done.source, 'che_lists');
  const receipt = add.done.execution_receipt;
  assert.equal(receipt.status, 'success');
  assert.equal(receipt.verified, 'read_back');
  assert.equal(receipt.operation, 'add');
  assert.equal(receipt.list, 'shopping');
  assert.deepEqual(receipt.items, ['oat milk', 'bananas']);
  assert.equal(receipt.before_count, 0);
  assert.equal(receipt.after_count, 2);
  assert.deepEqual(receipt.stored, items(c.storage, LISTS_KEY, 'shopping'));
  assert.match(add.reply, /Added oat milk and bananas to your shopping list, sir\./);
  assert.ok(c.storage.saved.get('che_receipts').some((r) => r.kind === 'list_changed' && r.list === 'shopping'));

  const more = await c.say('Hey CHE, add eggs to my shopping list.');
  assert.equal(more.done.execution_receipt.before_count, 2);
  assert.equal(more.done.execution_receipt.after_count, 3);
  const again = await c.say('Add eggs to my grocery list');
  assert.match(again.reply, /already on your shopping list/);
  assert.ok(!again.done.execution_receipt, 'nothing changed, so no change receipt');
  assert.equal(items(c.storage, LISTS_KEY, 'shopping').length, 3);

  const note = await c.say('Jot down: the gate code is 4412');
  assert.equal(note.done.execution_receipt.operation, 'note');
  assert.equal(note.done.execution_receipt.status, 'success');
  assert.deepEqual(items(c.storage, LISTS_KEY, 'notes'), ['the gate code is 4412']);

  const read = await c.say('Read me my shopping list.');
  assert.equal(read.done.source, 'che_lists');
  assert.equal(read.done.execution_receipt.operation, 'read');
  assert.match(read.reply, /3 items, sir: oat milk, bananas and eggs/);
  const notes = await c.say('What notes do I have?');
  assert.match(notes.reply, /1 note, sir: 1\. the gate code is 4412/);
  const none = await c.say('Show me my packing list');
  assert.match(none.reply, /no packing list yet/);
  assert.equal(c.models(), before, 'no model call for any list turn');
});

test('removing waits for the owner\'s yes, then runs and is read back; clearing all goes through the owner gate', async () => {
  const c = await che();
  await c.say('Add milk, eggs and bread to my shopping list.');
  // "Take ... off" is not a word the owner gate holds; the list connector holds it itself.
  const held = await c.say('Take the eggs off my grocery list');
  assert.match(held.reply, /need your yes/);
  assert.ok(!held.done.execution_receipt);
  assert.deepEqual(items(c.storage, LISTS_KEY, 'shopping'), ['milk', 'eggs', 'bread'], 'nothing removed before the yes');
  const done = await c.say('yes');
  assert.equal(done.done.execution_receipt.operation, 'remove');
  assert.equal(done.done.execution_receipt.status, 'success');
  assert.deepEqual(done.done.execution_receipt.items, ['eggs']);
  assert.equal(done.done.execution_receipt.after_count, 2);
  assert.deepEqual(items(c.storage, LISTS_KEY, 'shopping'), ['milk', 'bread']);

  // A "no" (anything but a yes) releases nothing.
  await c.say('Delete my shopping list');
  await c.say('actually never mind');
  assert.deepEqual(items(c.storage, LISTS_KEY, 'shopping'), ['milk', 'bread']);

  await c.say('Wipe my shopping list.');
  const cleared = await c.say('yes');
  assert.equal(cleared.done.execution_receipt.operation, 'clear');
  assert.equal(cleared.done.execution_receipt.after_count, 0);
  assert.equal(c.storage.saved.get(LISTS_KEY).lists.shopping, undefined);
});

test('a certification probe gets a real receipt under its own key and never touches the owner\'s lists or receipt log', async () => {
  const c = await che();
  await c.say('Add milk to my shopping list.');
  const ownerBefore = JSON.stringify(c.storage.saved.get(LISTS_KEY));
  const receiptsBefore = (c.storage.saved.get('che_receipts') || []).length;
  const add = await c.probe('Put stamps on my shopping list.');
  assert.equal(add.done.source, 'che_lists');
  assert.equal(add.execution_receipts[0].status, 'success');
  assert.equal(add.execution_receipts[0].verified, 'read_back');
  assert.deepEqual(items(c.storage, PROBE_LISTS_KEY, 'shopping'), ['stamps']);
  const note = await c.probe('Create a note that says: probe note');
  assert.equal(note.execution_receipts[0].operation, 'note');
  const read = await c.probe('What is on my shopping list?');
  assert.match(read.reply, /stamps/);
  assert.doesNotMatch(read.reply, /milk/);
  assert.equal(JSON.stringify(c.storage.saved.get(LISTS_KEY)), ownerBefore, 'the owner\'s lists are untouched');
  assert.equal((c.storage.saved.get('che_receipts') || []).length, receiptsBefore, 'nothing added to the owner\'s receipt log');
  const owner = await c.say('Show my notes');
  assert.match(owner.reply, /no notes saved/);
});

test('a write that fails or does not read back reports a failed receipt and claims nothing', async () => {
  const thrown = await che({ failPut: (k) => k === LISTS_KEY });
  const out = await thrown.say('Add milk to my shopping list.');
  assert.equal(out.done.execution_receipt.status, 'failed');
  assert.equal(out.done.execution_receipt.error, 'write_failed');
  assert.match(out.reply, /^I did not save it, sir: the write to CHE's server failed\. Nothing was added/);
  assert.doesNotMatch(out.reply, /Added milk/);

  const lost = await che({ dropPut: (k) => k === LISTS_KEY });
  const note = await lost.say('Make a note: renew the passport');
  assert.equal(note.done.execution_receipt.status, 'failed');
  assert.equal(note.done.execution_receipt.error, 'not_verified');
  assert.match(note.reply, /could not read it back/);
  assert.equal(lost.storage.saved.get(LISTS_KEY), undefined);
});

test('questions and writing requests that mention a list do not reach the lists', async () => {
  const c = await che();
  for (const ask of ['What is a shopping list?', 'List three ways to save money.', 'Make a list of five fruits.', 'Show me the list of supported models.']) {
    const out = await c.say(ask);
    assert.notEqual(out.done.source, 'che_lists', ask);
    assert.ok(!out.done.execution_receipt, ask);
  }
  assert.equal(c.storage.saved.get(LISTS_KEY), undefined);
  // A list request the connector does not keep (a mailing list) is answered honestly by the connector gate.
  const vague = await c.say('Add Bob to my mailing list.');
  assert.equal(vague.done.source, 'che_connector_gate');
  assert.match(vague.reply, /nothing was saved or removed/);
});

test('only the owner\'s device reads or changes the lists', async () => {
  const saved = new Map();
  const storage = { get: async (k) => structuredClone(saved.get(k)), put: async (k, v) => { saved.set(k, structuredClone(v)); } };
  const out = await listChatTurn(storage, 'Show my notes', { owner: false });
  assert.match(out.text, /owner's/);
  assert.equal(saved.size, 0);
});

test('probe items expire, so the next certification run adds for real instead of "already on your list"', async () => {
  const saved = new Map();
  const storage = { get: async (k) => structuredClone(saved.get(k)), put: async (k, v) => { saved.set(k, structuredClone(v)); } };
  const t0 = Date.parse('2026-11-02T10:00:00Z');
  const first = await listChatTurn(storage, 'Add milk to my shopping list.', { probe: true, now: t0 });
  assert.equal(first.meta.execution_receipt.status, 'success');
  const same = await listChatTurn(storage, 'Add milk to my shopping list.', { probe: true, now: t0 + 60_000 });
  assert.match(same.text, /already on your shopping list/);
  const nextRun = await listChatTurn(storage, 'Add milk to my shopping list.', { probe: true, now: t0 + 7 * 3600_000 });
  assert.equal(nextRun.meta.execution_receipt.status, 'success');
  assert.equal(nextRun.meta.execution_receipt.before_count, 0);
  assert.equal(saved.get(LISTS_KEY), undefined);
});
