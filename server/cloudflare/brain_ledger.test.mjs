// Brain Population Ledger (owner, 2026-10-22): what entered CHE's brain, when, in which category, from where, what it
// became, and whether it is usable yet. 24 tests: categories, timestamps, write-path coverage, states, batches,
// dedupe, corrections, removal, privacy, capability/workflow links, the owner's spoken questions and the API.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import {
  BrainLedger, CATEGORIES, PROGRESSION, STATES, WRITE_PATHS, answerLedger, categorize, categoryCards, categoryView, decidePending,
  displayTime, eventDetail, fromLibrary, fullTime, installBrainLedger, ledgerApi, ledgerIntent, statusWord, workflowsFor,
} from './brain_ledger.js';
import { BRAIN_REGIONS, CheBrainStore } from './brain_store.js';
import { KnowledgeLibrary } from './knowledge_library.js';
import { KnowledgeItems, populate } from './capability_engine.js';
import { emptyRegistry, register, recordCheck, promote, saveRegistry, PROMOTION_CHECKS } from './capability_registry.js';
import { replyFromNdjson } from './brain_memory.js';

globalThis.fetch = async (input) => { throw new TypeError(`fetch failed (offline test: ${new URL(String(input?.url || input)).host})`); };

async function storage() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const kv = new Map();
  return {
    sql: { exec: (q, ...p) => { const stmt = db.prepare(q); return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []); } },
    get: async (k) => (kv.has(k) ? structuredClone(kv.get(k)) : undefined),
    put: async (k, v) => {
      if (k && typeof k === 'object') { for (const [a, b] of Object.entries(k)) kv.set(a, structuredClone(b)); return; }
      kv.set(k, structuredClone(v));
    },
    delete: async (k) => kv.delete(k),
    kv,
  };
}

const NOW = Date.parse('2026-10-22T21:31:18Z'); // 4:31:18 PM Central
const record = (over = {}) => ({ id: 'n:1', kind: 'note', region: BRAIN_REGIONS.learned, path: '', title: 'A note', body: 'A note with enough words to keep.', verification: 'unknown', created_at: '2026-10-22T12:00:00Z', ...over });

// ─── Categories and time ────────────────────────────────────────────────────

test('category first: every event lands in one known category and subcategory, from the write path, then the words', () => {
  assert.deepEqual(categorize('EMA crossover on MNQ'), ['Trading', 'EMA']);
  assert.deepEqual(categorize('How to master a track to -14 LUFS'), ['Music', 'Mastering']);
  assert.deepEqual(categorize('anything', { region: BRAIN_REGIONS.coding }), ['Coding', 'CHE Code']);
  assert.deepEqual(categorize('quarantine the ransomware sample'), ['Security', 'Malware']);
  assert.deepEqual(categorize('nothing specific here'), ['General Knowledge', 'Research']);
  for (const [cat, subs] of Object.entries(CATEGORIES)) assert.ok(subs.length > 0, `${cat} has subcategories`);
});

test('every event carries an exact ISO timestamp and is shown in the owner\'s zone (Today · time, full date with zone)', async () => {
  const s = await storage();
  const e = new BrainLedger(s).record({ title: 'VWAP reclaim rule', event_type: 'KNOWLEDGE_SAVED' }, new Date(NOW));
  assert.equal(e.timestamp, '2026-10-22T21:31:18.000Z');
  assert.equal(displayTime(e.ms, 'America/Chicago', NOW), 'Today · 4:31 PM');
  assert.equal(displayTime(e.ms - 86_400_000, 'America/Chicago', NOW), 'Yesterday · 4:31 PM');
  assert.equal(fullTime(e.ms, 'America/Chicago'), 'October 22, 2026 · 4:31:18 PM Central');
});

test('category cards count knowledge, procedures and verified capabilities separately, newest category first', async () => {
  const s = await storage();
  const l = new BrainLedger(s);
  l.record({ title: 'ORB first 15 minutes', category: 'Trading', subcategory: 'ORB', record_id: 'a' }, new Date(NOW - 5000));
  l.record({ title: 'ORB entry procedure', category: 'Trading', subcategory: 'ORB', knowledge_type: 'procedure', record_id: 'b', event_type: 'PROCEDURE_CREATED' }, new Date(NOW - 4000));
  l.record({ title: 'Convert CSV', category: 'Coding', knowledge_type: 'capability', new_state: 'AVAILABLE', capability_id: 'c1', record_id: 'cap:c1', event_type: 'CAPABILITY_VERIFIED' }, new Date(NOW));
  const cards = await categoryCards(s, { now: NOW });
  assert.equal(cards[0].category, 'Coding');
  const trading = cards.find((c) => c.category === 'Trading');
  assert.equal(trading.items, 1);
  assert.equal(trading.procedures, 1);
  assert.equal(trading.capabilities, 0);
  assert.equal(cards[0].capabilities, 1);
  assert.equal(cards.find((c) => c.category === 'Legal').last_populated_label, 'Nothing yet');
});

// ─── No silent population: every write path leaves a record ─────────────────

test('a Brain record write (create, update, same content again) leaves saved → updated → strengthened events', async () => {
  const s = await storage();
  const brain = new CheBrainStore(s);
  brain.put(record({ id: 'k:1', region: BRAIN_REGIONS.trading, title: 'Silver backtest', body: 'The silver momentum backtest lost 3 percent over 2024.' }));
  brain.put(record({ id: 'k:1', region: BRAIN_REGIONS.trading, title: 'Silver backtest', body: 'The silver momentum backtest lost 4 percent over 2024.' }));
  const events = (await new BrainLedger(s).query({ record_id: 'k:1' })).reverse();
  assert.deepEqual(events.map((e) => e.event_type), ['KNOWLEDGE_SAVED', 'KNOWLEDGE_UPDATED']);
  assert.ok(events.every((e) => e.category === 'Trading'));
});

test('the Knowledge Library logs NOT READ on catalog, INDEXED on index and FAILED when nothing was readable', async () => {
  const s = await storage();
  const kl = new KnowledgeLibrary(s);
  const ref = kl.catalog({ title: 'Mixing Secrets', category: 'creative_writing', kind: 'book', license: 'owner', creator: 'M. Senior' });
  kl.index(ref.id, 'x');
  kl.index(ref.id, 'Use a high-pass filter on every track that does not need low end. Check mono compatibility often.');
  const events = (await new BrainLedger(s).query({ text: 'Mixing Secrets' })).reverse();
  assert.deepEqual(events.map((e) => e.event_type), ['SOURCE_DISCOVERED', 'SOURCE_FAILED', 'SOURCE_INDEXED']);
  assert.equal(events[0].source_type, 'BOOK');
  assert.equal(statusWord(events[2]), 'Indexed information');
});

test('capability-engine knowledge items log each layer (source → indexed knowledge → procedure) as its own event', async () => {
  const s = await storage();
  populate(s, { title: 'CSV primer', text: 'A CSV file is a table.\nTo convert CSV to JSON:\n1. Split the text into lines.\n2. Split each line by comma.\n3. Output as JSON.\nExample input: a,b\\n1,2\nExpected output: [{"a":1,"b":2}]', license: 'owner' });
  const types = new Set((await new BrainLedger(s).all()).map((e) => e.event_type));
  assert.ok(types.has('SOURCE_INDEXED'));
  assert.ok(types.has('KNOWLEDGE_EXTRACTED'));
  assert.ok(types.has('PROCEDURE_CREATED'));
});

test('key-value write paths (owner memories, capability registry, workflow candidates, closed trades) are recorded; the first sight is a baseline, not a flood', async () => {
  const s = installBrainLedger(await storage());
  await s.put('che', { memory_records: [{ id: 'm1', text: 'I live in Austin', source: 'owner' }] });
  assert.equal((await new BrainLedger(s).all()).length, 0, 'first sight is a baseline');
  await s.put('che', { memory_records: [{ id: 'm1', text: 'I live in Austin', source: 'owner' }, { id: 'm2', text: 'I prefer dark mode', source: 'owner' }] });
  await s.put('che:workflow_engine', { learned: [], candidates: [] });
  await s.put('che:workflow_engine', { learned: [], candidates: [{ id: 'cand1', name: 'Morning trading check', reason: 'Seen 3 times' }] });
  await s.put({ 'evr:paper:p1:1': { strategy: 'ORB', timeframe: '5m', environment: 'paper', portfolio: 'p1', entry: { time: 1 }, exit: { reason: 'target' }, r_multiple: 2 } });
  const all = await new BrainLedger(s).all();
  assert.ok(all.some((e) => e.event_type === 'OWNER_PREFERENCE_SAVED' && e.category === 'Owner Preferences'));
  assert.ok(all.some((e) => e.event_type === 'PENDING' && e.category === 'Workflows'));
  assert.ok(all.some((e) => e.event_type === 'EVIDENCE_UPDATED' && e.subcategory === 'ORB'));
  assert.ok(all.some((e) => e.event_type === 'BATCH_RECEIPT'));
});

test('the documented write paths are exactly the ones the hooks cover', () => {
  assert.deepEqual([...WRITE_PATHS].sort(), ['brain_store.write', 'capability_engine.KnowledgeItems.put', 'knowledge_library.catalog', 'knowledge_library.index', 'knowledge_library.index_failed', 'storage.put:backtest_matrix', 'storage.put:che.memory_records', 'storage.put:che:capabilities_v1', 'storage.put:che:workflow_engine', 'storage.put:evidence_runs', 'storage.put:evr:*'].sort());
});

// ─── States ─────────────────────────────────────────────────────────────────

test('states: DISCOVERED … AVAILABLE in order, plus the PENDING / REJECTED / CORRECTED side states', () => {
  assert.deepEqual(PROGRESSION, ['DISCOVERED', 'INDEXED', 'UNDERSTOOD', 'PROCEDURE', 'IMPLEMENTED', 'TESTED', 'VERIFIED', 'AVAILABLE']);
  for (const s of ['PENDING', 'REJECTED', 'CORRECTED', 'FAILED', 'REMOVED']) assert.ok(STATES.includes(s));
});

test('a capability moving through the registry leaves tested → verified events; only VERIFIED/AVAILABLE is called a capability', async () => {
  const s = installBrainLedger(await storage());
  const reg = emptyRegistry();
  await saveRegistry(s, reg);
  const cap = register(reg, { capability_id: 'caption_timer', name: 'Caption timer', description: 'times captions', category: 'video', implementation_location: 'internal' });
  await saveRegistry(s, reg);
  for (const c of PROMOTION_CHECKS) recordCheck(reg, cap.capability_id, c, { ok: true, evidence: 'ok' });
  promote(reg, cap.capability_id);
  await saveRegistry(s, reg);
  const events = (await new BrainLedger(s).query({ record_id: `cap:${cap.capability_id}` })).reverse();
  assert.ok(events.length >= 2);
  const last = events[events.length - 1];
  assert.equal(last.event_type, 'CAPABILITY_VERIFIED');
  assert.equal(statusWord(last), 'Verified capability');
  assert.match(statusWord(events[0]), /not available/);
});

test('pending items are not learned until the owner commits; reject keeps only "Not retained"', async () => {
  const s = await storage();
  const l = new BrainLedger(s);
  l.record({ event_type: 'PENDING', title: 'Ask before every ORB trade', record_id: 'p1', new_state: 'PENDING', category: 'Trading' });
  l.record({ event_type: 'PENDING', title: 'Private draft notes', record_id: 'p2', new_state: 'PENDING', category: 'Projects' });
  assert.match((await answerLedger(s, { kind: 'pending' }, { now: NOW })).text, /2 items are still pending/);
  assert.equal((await decidePending(s, 'p1', 'commit')).ok, true);
  const rejected = await decidePending(s, 'p2', 'reject');
  assert.equal(rejected.ok, true);
  assert.ok((await l.query({ record_id: 'p2' })).every((e) => !/Private draft/.test(e.title)), 'rejected text is scrubbed');
  assert.equal((await decidePending(s, 'p1', 'reject')).ok, false, 'only a pending item can be decided');
  assert.match((await answerLedger(s, { kind: 'pending' }, { now: NOW })).text, /Nothing is pending/);
});

// ─── Batches and dedupe ─────────────────────────────────────────────────────

test('a batch shows as one grouped entry in its category, and every member stays reachable', async () => {
  const s = installBrainLedger(await storage());
  await s.put({
    'evr:paper:p:1': { strategy: 'ORB', environment: 'paper', portfolio: 'p', entry: { time: 1 } },
    'evr:paper:p:2': { strategy: 'ORB', environment: 'paper', portfolio: 'p', entry: { time: 2 } },
    'evr:paper:p:3': { strategy: 'VWAP', environment: 'paper', portfolio: 'p', entry: { time: 3 } },
  });
  const view = await categoryView(s, 'Trading', { now: NOW });
  assert.equal(view.length, 1);
  assert.equal(view[0].kind, 'batch');
  assert.equal(view[0].items, 3);
  const members = await ledgerApi(s, new URLSearchParams({ batch: view[0].batch_id }), { now: NOW });
  assert.equal(members.events.filter((e) => e.event_type !== 'BATCH_RECEIPT').length, 3);
});

test('dedupe: the same knowledge arriving again is "evidence strengthened" on the same item, never a second item', async () => {
  const s = await storage();
  const items = new KnowledgeItems(s);
  const item = { id: 'ki1', key: 'k', layer: 'indexed', kind: 'fact', title: 'RSI over 70', body: 'RSI above 70 is overbought.', domain: 'trading', scope: 'owner-global', provenance: { owner: true }, confidence: 0.9, applicability: {}, status: 'active', version: 1, conflicts: [], links: [], freshness: {}, steps: [], created: '2026-10-22T00:00:00Z', updated: '2026-10-22T00:00:00Z' };
  items.put(item);
  items.put({ ...item, updated: '2026-10-22T01:00:00Z' });
  const events = (await new BrainLedger(s).query({ record_id: 'ki1' })).reverse();
  assert.deepEqual(events.map((e) => e.event_type), ['KNOWLEDGE_EXTRACTED', 'EVIDENCE_STRENGTHENED']);
  const cards = await categoryCards(s, { now: NOW });
  assert.equal(cards.find((c) => c.category === 'Trading').items, 1);
});

// ─── Corrections, removal, privacy ──────────────────────────────────────────

test('a correction keeps the original and the corrected statement side by side', async () => {
  const s = installBrainLedger(await storage());
  await s.put('che', { memory_records: [{ id: 'm1', text: 'My studio is in Dallas', source: 'owner' }] });
  await s.put('che', { memory_records: [{ id: 'm1', text: 'My studio is in Dallas', source: 'owner', active: false, superseded_by: 'My studio is in Houston' }] });
  const [e] = await new BrainLedger(s).query({ types: ['CORRECTION'] });
  assert.equal(e.new_state, 'CORRECTED');
  assert.deepEqual(e.detail, { original: 'My studio is in Dallas', corrected: 'My studio is in Houston' });
});

test('removing a Brain record keeps metadata only and scrubs the item\'s earlier ledger text', async () => {
  const s = await storage();
  const brain = new CheBrainStore(s);
  brain.put(record({ id: 'n:secret-plan', title: 'Album rollout plan', body: 'Release the album on Friday with three singles first.' }));
  brain.apply({ type: 'delete', id: 'n:secret-plan' }, { origin: 'owner' });
  const events = await new BrainLedger(s).query({ record_id: 'n:secret-plan' });
  assert.ok(events.some((e) => e.event_type === 'REMOVED'));
  assert.ok(events.every((e) => !/Album rollout|three singles/.test(`${e.title} ${e.summary}`)));
});

test('privacy: credential-shaped text never enters the ledger; a safe label is shown instead', async () => {
  const s = await storage();
  const e = new BrainLedger(s).record({ title: 'key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefGHIJ', summary: 'password: hunter2hunter2', category: 'Security' });
  assert.doesNotMatch(JSON.stringify(e), /sk-ant|hunter2/);
  assert.equal(e.title, 'Security item');
  const row = [...s.sql.exec('SELECT * FROM brain_ledger')][0];
  assert.doesNotMatch(JSON.stringify(row), /sk-ant|hunter2/);
});

test('a project-scoped knowledge item is filed under Projects with its project id, never as owner-global', async () => {
  const s = await storage();
  new KnowledgeItems(s).put({ id: 'pk', key: 'pk', layer: 'project', kind: 'fact', title: 'Acme launch codename', body: 'The Acme launch is codenamed Bluebird.', domain: '', scope: 'project-only', project_id: 'acme', provenance: { owner: true }, confidence: 0.9, applicability: {}, status: 'active', version: 1, conflicts: [], links: [], freshness: {}, steps: [], created: '2026-10-22T00:00:00Z', updated: '2026-10-22T00:00:00Z' });
  const [e] = await new BrainLedger(s).query({ record_id: 'pk' });
  assert.equal(e.category, 'Projects');
  assert.equal(e.project_id, 'acme');
  assert.equal(e.knowledge_scope, 'project-only');
});

// ─── Links ──────────────────────────────────────────────────────────────────

test('event detail links the capability (with its real registry status) and the workflows that use the category', async () => {
  const s = await storage();
  const e = new BrainLedger(s).record({ title: 'Caption timer', category: 'Video', knowledge_type: 'capability', capability_id: 'cap_x', record_id: 'cap:cap_x', new_state: 'AVAILABLE', event_type: 'CAPABILITY_VERIFIED' });
  const registry = { capabilities: { cap_x: { capability_id: 'cap_x', name: 'Caption timer', status: 'AVAILABLE', last_verified: '2026-10-22T20:00:00Z' } } };
  const d = await eventDetail(s, e.brain_event_id, { registry, now: NOW });
  assert.equal(d.capability.usable, true);
  assert.ok(d.used_by.some((w) => w.id === 'media_create'));
  assert.ok(workflowsFor('Trading').some((w) => w.id === 'trading_desk'));
  assert.equal(d.history.length, 1);
});

// ─── The owner's questions ──────────────────────────────────────────────────

test('spoken and typed questions route to the ledger with the same intent (wake word and punctuation ignored)', () => {
  assert.deepEqual(ledgerIntent('CHE, what entered your brain today?'), { kind: 'today' });
  assert.deepEqual(ledgerIntent('what populated your brain today'), { kind: 'today' });
  assert.deepEqual(ledgerIntent('What entered your trading brain?'), { kind: 'category', category: 'Trading' });
  assert.deepEqual(ledgerIntent('what did you learn about music'), { kind: 'category', category: 'Music' });
  assert.deepEqual(ledgerIntent('What knowledge is still pending?'), { kind: 'pending' });
  assert.deepEqual(ledgerIntent('When did you learn that?'), { kind: 'when' });
  assert.deepEqual(ledgerIntent('Where did you learn this?'), { kind: 'where' });
  assert.equal(ledgerIntent('what did you learn about CSV to JSON'), null, 'topic questions stay with the Capability Engine');
  assert.equal(ledgerIntent('what is the weather'), null);
});

test('"what entered your brain today" answers from today\'s ledger only, with counts per category', async () => {
  const s = await storage();
  const l = new BrainLedger(s);
  l.record({ title: 'Yesterday item', category: 'Music' }, new Date(NOW - 2 * 86_400_000));
  l.record({ title: 'EMA pullback rule', category: 'Trading', subcategory: 'EMA' }, new Date(NOW - 60_000));
  l.record({ title: 'Mono check', category: 'Music', subcategory: 'Mixing' }, new Date(NOW - 30_000));
  const a = await answerLedger(s, { kind: 'today' }, { now: NOW, zone: 'America/Chicago' });
  assert.match(a.text, /^Today 2 items entered my brain: /);
  assert.doesNotMatch(a.text, /Yesterday item/);
  assert.equal((await answerLedger(await storage(), { kind: 'today' }, { now: NOW })).text, 'Nothing entered my brain today, sir.');
});

test('"do you know X" separates information, indexed knowledge, a procedure and a verified capability', async () => {
  const s = await storage();
  const l = new BrainLedger(s);
  l.record({ title: 'Ableton sidechain article', event_type: 'SOURCE_DISCOVERED', knowledge_type: 'source' });
  assert.equal((await answerLedger(s, { kind: 'know', text: 'sidechain' })).level, 'information');
  l.record({ title: 'Sidechain compression basics', event_type: 'KNOWLEDGE_EXTRACTED' });
  assert.equal((await answerLedger(s, { kind: 'know', text: 'sidechain' })).level, 'knowledge');
  l.record({ title: 'Sidechain procedure', event_type: 'PROCEDURE_CREATED', knowledge_type: 'procedure' });
  assert.equal((await answerLedger(s, { kind: 'know', text: 'sidechain' })).level, 'procedure');
  const registry = { capabilities: { c: { capability_id: 'c', name: 'Sidechain ducker', description: 'sidechain', status: 'AVAILABLE' } } };
  assert.equal((await answerLedger(s, { kind: 'know', text: 'sidechain' }, { registry })).level, 'capability');
  assert.equal((await answerLedger(s, { kind: 'know', text: 'theremin' })).level, 'none');
});

test('"when/where did you learn that" never guesses: no record means it says so', async () => {
  const s = await storage();
  new BrainLedger(s).record({ title: 'VWAP reclaim rule', category: 'Trading', source_type: 'BOOK', source_reference: 'Trading book', reason_saved: 'You asked me to read it' }, new Date(NOW));
  assert.match((await answerLedger(s, { kind: 'when', text: 'vwap reclaim' }, { zone: 'America/Chicago' })).text, /first entered my brain October 22, 2026 · 4:31:18 PM Central, under Trading/);
  assert.match((await answerLedger(s, { kind: 'where' }, { lastSubject: 'vwap reclaim' })).text, /source book \(Trading book\); saved because You asked me to read it/);
  assert.match((await answerLedger(s, { kind: 'when', text: 'quantum chess' })).text, /I have no ledger record for quantum chess/);
});

// ─── Through the real Worker ────────────────────────────────────────────────

const generated = new URL('./.brain_ledger.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace("import { DurableObject } from 'cloudflare:workers';", 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }

async function owner() {
  const st = await storage();
  const pending = [];
  let modelCalls = 0;
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => { modelCalls++; return { response: 'A model answer.' }; } } };
  const ctx = { storage: { ...st, list: async () => new Map(), setAlarm: async () => {}, deleteAlarm: async () => {}, getAlarm: async () => null }, waitUntil: (p) => pending.push(p) };
  const state = new mod.CheState(ctx, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '', method = 'POST') => mod.default.fetch(new Request(`https://che.example${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  return {
    st: ctx.storage, token, send, calls: () => modelCalls,
    say: async (message) => {
      const before = modelCalls;
      const raw = await (await send('/api/chat', { message, history: [] }, token)).text();
      while (pending.length) await pending.shift();
      let done = {};
      try { done = raw.trim().split('\n').map((l) => JSON.parse(l)).find((l) => l.type === 'done') || JSON.parse(raw); } catch (_) { done = {}; }
      return { reply: replyFromNdjson(raw) || done.reply || '', route: done.source, done, model_calls: modelCalls - before };
    },
    get: async (p, t = token) => { const r = await send(p, null, t, 'GET'); return { status: r.status, body: await r.json() }; },
    post: async (p, b, t = token) => { const r = await send(p, b, t); return { status: r.status, body: await r.json() }; },
  };
}

test('Worker: "what entered your brain today" answers from the ledger with no model call', async () => {
  const che = await owner();
  new BrainLedger(che.st).record({ title: 'ORB first 15 minutes', category: 'Trading', subcategory: 'ORB' });
  const r = await che.say('CHE, what entered your brain today?');
  assert.equal(r.route, 'che_brain_ledger');
  assert.equal(r.model_calls, 0);
  assert.match(r.reply, /Trading 1/);
  assert.match(r.reply, /ORB first 15 minutes/);
});

test('Worker: /api/brain/ledger is owner-only and returns category cards, totals and the write paths', async () => {
  const che = await owner();
  const anon = await che.get('/api/brain/ledger', '');
  assert.ok([401, 403].includes(anon.status), 'a guest cannot read the ledger');
  new BrainLedger(che.st).record({ title: 'Mono check', category: 'Music', subcategory: 'Mixing' });
  const view = await che.get('/api/brain/ledger');
  assert.equal(view.status, 200);
  assert.equal(view.body.categories.length, Object.keys(CATEGORIES).length);
  assert.equal(view.body.totals.knowledge, 1);
  assert.ok(view.body.write_paths.includes('brain_store.write'));
  const cat = await che.get('/api/brain/ledger?category=Music');
  assert.equal(cat.body.events[0].title, 'Mono check');
  assert.match(cat.body.events[0].spoken, /^Music\. Mono check\. Knowledge saved at /);
});

test('Worker: the owner commits or rejects a pending item through /api/brain/ledger/decide', async () => {
  const che = await owner();
  new BrainLedger(che.st).record({ event_type: 'PENDING', title: 'Keep risk at 1R', record_id: 'pend:1', new_state: 'PENDING', category: 'Trading' });
  assert.equal((await che.post('/api/brain/ledger/decide', { record_id: 'pend:1', decision: 'maybe' })).status, 400);
  const ok = await che.post('/api/brain/ledger/decide', { record_id: 'pend:1', decision: 'commit' });
  assert.equal(ok.status, 200);
  assert.match(ok.body.said, /Committed, sir: Keep risk at 1R/);
  assert.equal((await che.post('/api/brain/ledger/decide', { record_id: 'pend:1', decision: 'commit' })).status, 409);
});
