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
// `failGet(key, reads)` true makes a read of that key throw (`reads`: how many reads of it came before).
function storageMap({ failPut = () => false, dropPut = () => false, failGet = () => false } = {}) {
  const saved = new Map();
  const reads = new Map();
  let alarm = null;
  const get1 = (x) => {
    const n = reads.get(x) || 0;
    reads.set(x, n + 1);
    if (failGet(x, n)) throw new Error('storage read refused');
    return saved.has(x) ? structuredClone(saved.get(x)) : undefined;
  };
  const put1 = (k, v) => {
    if (failPut(k)) throw new Error('storage write refused');
    if (!dropPut(k)) saved.set(k, structuredClone(v));
  };
  return {
    saved,
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => saved.has(x)).map((x) => [x, get1(x)])) : get1(k)),
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
    'Add Bob to the mailing list.', 'Tell me more.', 'Next song please.', 'Continue the story.', 'Keep going.', 'Read my last note in notes.', 'Open the Notes app.', 'Add it to my list.', 'Note that the meeting moved to 3pm.', 'How do I share my notes?',
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

test('a write that throws reports a failed receipt and says nothing changed', async () => {
  const thrown = await che({ failPut: (k) => k === LISTS_KEY });
  const out = await thrown.say('Add milk to my shopping list.');
  assert.equal(out.done.execution_receipt.status, 'failed');
  assert.equal(out.done.execution_receipt.error, 'write_failed');
  assert.match(out.reply, /^I did not save it, sir: the write to CHE's server failed\. Nothing was added/);
  assert.doesNotMatch(out.reply, /Added milk/);
  assert.equal(thrown.storage.saved.get(LISTS_KEY), undefined);
});

// Codex review on #887: a write that went through but could not be read back must not be reported as "nothing was added".
test('a write that went through but cannot be read back is reported as unconfirmed, never as nothing changed', async () => {
  // The read before the write works; the read-back after it throws. The item IS stored.
  const readBackThrows = await che({ failGet: (k, n) => k === LISTS_KEY && n >= 1 });
  const out = await readBackThrows.say('Pop some coffee filters onto my shopping list');
  assert.deepEqual(items(readBackThrows.storage, LISTS_KEY, 'shopping'), ['some coffee filters'], 'the write went through');
  assert.ok(!out.done.execution_receipt, 'an unconfirmed change is not sent as an executed one');
  assert.equal(out.done.unconfirmed_receipt.status, 'unverified');
  assert.equal(out.done.unconfirmed_receipt.error, 'read_back_failed');
  assert.match(out.reply, /^I wrote that addition to CHE's server, sir, but could not read your shopping list back to confirm it/);
  assert.doesNotMatch(out.reply, /Nothing was added|did not save|Added/);

  // A write that vanished (the read-back shows something else) is unconfirmed too: no claim either way.
  const lost = await che({ dropPut: (k) => k === LISTS_KEY });
  const note = await lost.say('Make a note: renew the passport');
  assert.ok(!note.done.execution_receipt);
  assert.equal(note.done.unconfirmed_receipt.error, 'read_back_mismatch');
  assert.match(note.reply, /could not read your notes back to confirm it/);
  assert.doesNotMatch(note.reply, /Note saved/);
});

test('a removal whose write throws leaves the list as it was; one that cannot be read back is unconfirmed', async () => {
  let refuse = false;
  let breakReads = false;
  const c = await che({ failPut: (k) => refuse && k === LISTS_KEY, failGet: (k) => breakReads && k === LISTS_KEY });
  await c.say('Add milk, eggs and bread to my shopping list.');
  refuse = true;
  await c.say('Remove the eggs from my shopping list');
  const failed = await c.say('yes');
  assert.equal(failed.done.execution_receipt.status, 'failed');
  assert.match(failed.reply, /^I did not remove it, sir: the write to CHE's server failed\. Your shopping list is unchanged\./);
  assert.deepEqual(items(c.storage, LISTS_KEY, 'shopping'), ['milk', 'eggs', 'bread']);

  refuse = false;
  await c.say('Remove the eggs from my shopping list');
  // Reads break only after the yes has loaded the list, so the write runs and the read-back fails.
  const orig = c.storage.put;
  c.storage.put = async (k, v) => { await orig(k, v); if (k === LISTS_KEY) breakReads = true; };
  const unconfirmed = await c.say('yes');
  breakReads = false;
  assert.deepEqual(items(c.storage, LISTS_KEY, 'shopping'), ['milk', 'bread'], 'the removal went through');
  assert.ok(!unconfirmed.done.execution_receipt);
  assert.equal(unconfirmed.done.unconfirmed_receipt.status, 'unverified');
  assert.match(unconfirmed.reply, /could not read your shopping list back to confirm it, so I can't say for sure it took effect/);
  assert.doesNotMatch(unconfirmed.reply, /unchanged|still there/);
});

// Codex review on #887: long reads were cut at 10 notes or 25 items with no way to reach the rest.
test('long reads stay short for voice, say how many are left, and every note and item can be reached', async () => {
  const saved = new Map();
  const storage = { get: async (k) => structuredClone(saved.get(k)), put: async (k, v) => { saved.set(k, structuredClone(v)); } };
  let now = Date.parse('2026-11-02T10:00:00Z');
  const turn = (m) => listChatTurn(storage, m, { now: (now += 1000) });
  for (let n = 1; n <= 23; n += 1) await turn(`Jot down: idea ${n}`);

  const first = await turn('Show my notes');
  assert.match(first.text, /^You have 23 notes, sir\. The latest 10: 14\. idea 14 .* 23\. idea 23 13 older notes not read; say "older notes"/);
  const older = await turn('Read me the older notes');
  assert.match(older.text, /^Notes 4 to 13, sir: 4\. idea 4 .* 13\. idea 13 3 older notes not read/);
  const more = await turn('more');
  assert.match(more.text, /^Notes 1 to 3, sir: 1\. idea 1 2\. idea 2 3\. idea 3$/);
  // The end was reached, so a later bare "more" is ordinary chat again.
  assert.equal(await turn('more'), null);
  assert.match((await turn('Read note 12')).text, /^Note 12 of 23, sir: idea 12$/);
  assert.match((await turn("What's the first note?")).text, /^Note 1 of 23, sir: idea 1$/);
  assert.match((await turn('Read my last note')).text, /^Note 23 of 23, sir: idea 23$/);
  assert.match((await turn('Read note 40')).text, /there is no note 40/);
  const all = await turn('Show all my notes');
  assert.match(all.text, /all of them: 1\. idea 1 .* 23\. idea 23$/);
  assert.equal(all.meta.execution_receipt.shown, 23);

  for (let n = 1; n <= 30; n += 1) await turn(`Add part ${n} to my hardware list`);
  const list = await turn('Read me my hardware list');
  assert.match(list.text, /^Your hardware list has 30 items, sir: part 1, .*part 25\. 5 more not read; say "more items" or "read my whole hardware list"\.$/);
  assert.equal(list.meta.execution_receipt.shown, 25);
  const rest = await turn('Read me the rest of my hardware list');
  assert.match(rest.text, /^Items 26 to 30 of your hardware list, sir: part 26, part 27, part 28, part 29 and part 30\.$/);
  const whole = await turn('Read my whole hardware list');
  assert.match(whole.text, /has 30 items, sir, all of them: part 1, .*part 29 and part 30\.$/);
  // Without a long read just before, a bare "more" is not a list request.
  assert.equal(await listChatTurn({ get: async () => undefined, put: async () => {} }, 'more', { now }), null);
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
