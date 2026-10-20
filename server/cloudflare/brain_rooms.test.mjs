// The Brain as the coordinator of CHE's rooms (owner, 2026-10-20): a room's verified event reaches the
// Brain with its source and status, a question from Chat that names a room is answered from those
// records by source with no model call, and the owner's screen is remembered only as a temporary
// observation. Everything runs through the real Worker offline with an in-memory SQLite Brain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { BRAIN_REGIONS, CheBrainStore } from './brain_store.js';
import { EVENT_STATUSES, ROOM_EVENTS_KEY, peekRoomEvents, queueRoomEvent, receiptEvent } from './room_events.js';
import {
  LAST_SCREEN_KEY, ROOMS, answerCrossRoom, crossRoomIntent, drainRoomEvents, linkRelated, publishRoomEvent, recentScreen, rememberScreen,
  roomEventRecord, screenDeictic, screenFollowUp, screenRoomFor, statusLabel,
} from './brain_rooms.js';
import { recordReceipt } from './truth_layer.js';
import { asksAboutScreen } from './speech_intent.js';

const generated = new URL('./.brain_rooms.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch (_) { DatabaseSync = null; }
const sqlite = { skip: DatabaseSync ? false : 'node:sqlite unavailable' };

// Offline: the one allowed request is a fake vision connector, so a real image analysis can be simulated.
const VISION_URL = 'https://vision.example/analyze';
let visionSummary = '';
globalThis.fetch = async (input) => {
  const url = String(input?.url || input);
  if (url === VISION_URL && visionSummary) return new Response(JSON.stringify({ summary: visionSummary }), { status: 200, headers: { 'content-type': 'application/json' } });
  throw new TypeError(`fetch failed (brain_rooms tests are offline: ${new URL(url).host})`);
};

function storageFor(saved = new Map()) {
  const db = new DatabaseSync(':memory:');
  return {
    sql: { exec: (q, ...p) => { const stmt = db.prepare(q); return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []); } },
    get: async (key) => (Array.isArray(key)
      ? new Map(key.filter((k) => saved.has(k)).map((k) => [k, structuredClone(saved.get(k))]))
      : (saved.has(key) ? structuredClone(saved.get(key)) : undefined)),
    put: async (key, value) => {
      if (key && typeof key === 'object') for (const [k, v] of Object.entries(key)) saved.set(k, structuredClone(v));
      else saved.set(key, structuredClone(value));
    },
    delete: async (key) => (Array.isArray(key) ? key.filter((k) => saved.delete(k)).length : saved.delete(key)),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => String(k).startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

async function owner({ model = () => 'Here is the answer, sir.', env: extra = {} } = {}) {
  let calls = 0;
  const prompts = [];
  const pending = [];
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', ...extra,
    AI: { run: async (_model, opts = {}) => {
      calls += 1;
      const system = (opts.messages || []).find((m) => m.role === 'system');
      if (system) prompts.push(String(system.content || ''));
      return { response: model(opts) };
    } },
  };
  const saved = new Map();
  const storage = storageFor(saved);
  const state = new CheState({ storage, waitUntil: (p) => pending.push(p) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '', method = 'POST') => worker.fetch(new Request(`https://che.example${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const say = async (message, extra2 = {}) => {
    const before = calls;
    const promptsBefore = prompts.length;
    const raw = await (await send('/api/chat', { message, history: [], ...extra2 }, token)).text();
    while (pending.length) await pending.shift();
    const events = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const done = events.find((e) => e.type === 'done') || {};
    return { reply: events.filter((e) => e.type === 'delta').map((e) => e.delta).join(''), done, route: done.source || (calls > before ? 'model' : 'none'), modelCalls: calls - before, prompts: prompts.slice(promptsBefore) };
  };
  const get = async (path) => { const res = await send(path, null, token, 'GET'); return { status: res.status, body: await res.json() }; };
  return { say, get, storage, saved, brain: () => new CheBrainStore(storage), state };
}

// ─── Records and events ───────────────────────────────────────────────────

test('a room event becomes one Brain record with its room, status, evidence and verification', () => {
  const record = roomEventRecord({ room: 'trading', kind: 'journal_trades', key: 'journal:2026-10-20T10:00:00Z', title: '2 forward paper trades closed', body: 'Read the ledger.', status: 'verified', evidence: ['live_paper_runs 2026-10-20T10:00:00Z'], refs: { ledger: 'forward_paper_journal' }, at: '2026-10-20T10:00:00Z' });
  assert.equal(record.id, 'room:trading:journal:2026-10-20T10:00:00Z');
  assert.equal(record.region, BRAIN_REGIONS.trading);
  assert.equal(record.verification, 'verified_source');
  assert.equal(record.source.room, 'trading');
  assert.match(record.body, /Status: verified\./);
  assert.match(record.body, /Evidence: live_paper_runs/);
  assert.match(record.body, /Source room: Trading Room/);
  for (const [status, verification] of [['derived', 'derived'], ['observed', 'observed'], ['inferred', 'inferred'], ['hypothesis', 'hypothesis'], ['proposed', 'proposed'], ['unknown', 'unknown']]) {
    assert.equal(roomEventRecord({ room: 'rea', title: 't', status, at: '2026-10-20T10:00:00Z' }).verification, verification, status);
  }
  assert.equal(roomEventRecord({ room: 'rea', title: 't', status: 'made-up' }).verification, 'unknown', 'an unknown status never reads as verified');
  assert.match(roomEventRecord({ room: 'kitchen', title: 't' }).error, /unknown room/);
  assert.deepEqual(EVENT_STATUSES, ['verified', 'derived', 'observed', 'inferred', 'hypothesis', 'proposed', 'unknown', 'superseded', 'contradicted']);
  for (const room of Object.keys(ROOMS)) assert.ok(ROOMS[room].label && ROOMS[room].owns, room);
});

test('publishing is deduplicated by key, links related records across rooms, and supersedes or contradicts by id', sqlite, () => {
  const store = new CheBrainStore(storageFor());
  const first = publishRoomEvent(store, { room: 'trading', kind: 'journal_trades', key: 'k1', title: 'Breakout strategy closed 3 MNQ trades', body: 'x', status: 'verified', at: '2026-10-20T10:00:00Z' });
  assert.equal(first.outcome, 'created');
  assert.equal(publishRoomEvent(store, { room: 'trading', kind: 'journal_trades', key: 'k1', title: 'Breakout strategy closed 3 MNQ trades', body: 'x', status: 'verified' }).outcome, 'present');
  const rea = publishRoomEvent(store, { room: 'rea', kind: 'investigation', key: 'k2', title: 'REA investigation complete: breakout strategy tool for MNQ traders', body: 'y', status: 'verified', at: '2026-10-20T10:01:00Z' });
  assert.equal(rea.outcome, 'created');
  assert.ok(rea.links.some((l) => l.to === first.id && l.type === 'related_to'), 'the REA record links to the trading record it shares words with');
  const linked = store.get(rea.id);
  assert.ok(linked.links.some((l) => l.to === first.id));
  assert.deepEqual(linked.source.related_rooms, ['trading']);
  const newer = publishRoomEvent(store, { room: 'trading', kind: 'journal_trades', key: 'k3', title: 'Breakout strategy closed 5 MNQ trades (corrected count)', body: 'z', status: 'verified', supersedes: first.id, at: '2026-10-20T10:02:00Z' });
  assert.equal(store.get(first.id).verification, 'superseded');
  assert.ok(store.get(first.id).links.some((l) => l.type === 'superseded_by' && l.to === newer.id));
  const dispute = publishRoomEvent(store, { room: 'research', kind: 'note', key: 'k4', title: 'Source says the breakout count differs', body: 'w', status: 'hypothesis', contradicts: newer.id, at: '2026-10-20T10:03:00Z' });
  assert.equal(store.get(newer.id).verification, 'contradicted');
  assert.ok(store.get(dispute.id).links.some((l) => l.type === 'contradicts' && l.to === newer.id));
  assert.equal(publishRoomEvent(store, { room: 'memory', title: 'My password is hunter2', body: 'password hunter2', status: 'verified' }).outcome, 'rejected', 'sensitive text never enters the Brain');
  assert.equal(linkRelated(store, { id: 'x', title: 'one', source: {}, links: [] }).length, 0);
});

test('receipts map to coding, trading and office events; the queue drains into the Brain and is empty after', sqlite, async () => {
  assert.equal(receiptEvent({ kind: 'tool_execution', invocation_id: 'x' }), null);
  const pr = receiptEvent({ kind: 'pr_opened', number: 374, summary: 'Trading Room ledgers', url: 'https://github.com/Vondada/chey-app/pull/374', at: '2026-10-20T10:00:00Z' });
  assert.equal(pr.room, 'coding'); assert.equal(pr.status, 'verified'); assert.match(pr.title, /Pull request #374 opened/);
  assert.equal(receiptEvent({ kind: 'proposal_ready', number: 9 }).status, 'proposed');
  assert.equal(receiptEvent({ kind: 'paper_order_placed', symbol: 'AAPL' }).room, 'trading');
  assert.equal(receiptEvent({ kind: 'mail_received', peer: 'codex' }).status, 'observed');
  assert.match(receiptEvent({ kind: 'mail_received', peer: 'codex' }).title, /from codex/);
  assert.match(receiptEvent({ kind: 'mail_sent', peer: 'chatgpt' }).title, /to chatgpt/);
  assert.match(receiptEvent({ kind: 'study_started', repos: ['vercel/ai', 'sveltejs/svelte'] }).title, /vercel\/ai, sveltejs\/svelte/);
  assert.match(receiptEvent({ kind: 'study_complete', repos: ['vercel/ai'], findings: 3 }).body, /3 findings/);
  assert.match(receiptEvent({ kind: 'job_started', job_id: 'abcdef1234567', job_kind: 'self_development', topic: 'routing' }).title, /\(self_development\)/);
  const storage = storageFor();
  await recordReceipt(storage, { kind: 'merged', key: 'merged:374', number: 374, sha: 'abcdef1234567890', at: '2026-10-20T10:05:00Z' });
  assert.equal(((await storage.get(ROOM_EVENTS_KEY)) || []).length, 1, 'the receipt queued one event');
  const store = new CheBrainStore(storage);
  const drained = await drainRoomEvents(storage, store);
  assert.equal(drained.taken, 1); assert.equal(drained.written, 1);
  assert.deepEqual(await peekRoomEvents(storage), [], 'a handled event leaves the queue');
  assert.equal((await drainRoomEvents(storage, store)).taken, 0, 'a repeat drain finds nothing');
  const hit = store.search('pull request 374 merged', { limit: 3 })[0];
  assert.ok(hit && hit.source.room === 'coding' && hit.verification === 'verified_source');
  assert.equal(await queueRoomEvent(storage, { room: 'trading', title: 'dup', key: 'd' }), true);
  assert.equal(await queueRoomEvent(storage, { room: 'trading', title: 'dup', key: 'd' }), false, 'the same key is queued once');
});

// ─── The question that names a room ───────────────────────────────────────

test('cross-room questions name their rooms and kinds; ordinary sentences do not', () => {
  const table = [
    ['What does the Trading Room know about MNQ?', 'know', ['trading'], 'MNQ'],
    ['what does your brain know about this', 'know', [], 'this'],
    ['Did we learn anything about the breakout strategy in another room?', 'learned', [], 'the breakout strategy'],
    ['Does the Music Room have related information?', 'know', ['music'], 'this'],
    ['Does the Trading Room have any records on MNQ?', 'know', ['trading'], 'MNQ'],
    ['Connect this to the Brain.', 'connect', [], 'this'],
    ['CHE, connect this to what we already know', 'connect', [], 'this'],
    ['What do you already know about the REA investigation of semver?', 'know', ['rea'], 'the REA investigation of semver'],
  ];
  for (const [message, kind, rooms, topic] of table) {
    const got = crossRoomIntent(message);
    assert.ok(got, message); assert.equal(got.kind, kind, message); assert.deepEqual(got.rooms, rooms, message); assert.equal(got.topic, topic, message);
  }
  for (const other of ['What is MNQ?', 'Tell me about the trading room', 'What do you know about Paris?', 'How many trades have you made?', 'Connect to the music service', 'Do you know what time it is?',
    // Bare words name no room (review, 2026-10-20): these are ordinary questions.
    'What does the agent know about visas to Japan?', 'Does my office have information on the lease?', 'Does the research team have data about this drug?', 'Do the workers know the answer to my question?', 'What do the agents know about cooking?']) {
    assert.equal(crossRoomIntent(other), null, other);
  }
});

test('from Chat, a question about the Trading Room is answered from the Brain and the live ledgers, by source, with no model call (Test D, G)', sqlite, async () => {
  const che = await owner();
  // A verified room event arrives (a journalled trade) and a coding receipt; no restart, no projection run.
  await queueRoomEvent(che.storage, { room: 'trading', kind: 'journal_trades', key: 'journal:1', title: '2 forward paper trades closed on MNQ breakout', body: 'Read the ledger.', status: 'verified', evidence: ['live_paper_runs 2026-10-20T10:00:00Z'], at: '2026-10-20T10:00:00Z' });
  await recordReceipt(che.storage, { kind: 'pr_opened', key: 'pr:374', number: 374, summary: 'Trading Room: trade records by source (MNQ ledgers)', url: 'https://github.com/Vondada/chey-app/pull/374', at: '2026-10-20T10:01:00Z' });
  const out = await che.say('What does the Trading Room know about MNQ?');
  assert.equal(out.route, 'che_brain_rooms');
  assert.equal(out.modelCalls, 0);
  assert.match(out.reply, /Trading Room: 2 forward paper trades closed on MNQ breakout \(verified, 2026-10-20\)/);
  assert.match(out.reply, /Live ledgers: strategy simulation 0 closed trades/);
  assert.doesNotMatch(out.reply, /Pull request/, 'the Coding Room\'s record is not reported as the Trading Room\'s');
  assert.deepEqual(out.done.rooms, ['trading']);
  const learned = await che.say('Did we learn anything about MNQ in another room?');
  assert.equal(learned.route, 'che_brain_rooms');
  assert.match(learned.reply, /Trading Room: 2 forward paper trades/);
  assert.match(learned.reply, /Coding Room: Pull request #374 opened/);
  const nothing = await che.say('What does the Music Room know about MNQ?');
  assert.equal(nothing.route, 'che_brain_rooms');
  assert.match(nothing.reply, /Nothing recorded about "MNQ" in the Music Room/);
  assert.match(nothing.reply, /I will not guess/);
  // The same records reach the model's context on an ordinary question, labelled by room and status.
  const plain = await che.say('Tell me something about MNQ breakouts today.');
  assert.equal(plain.route, 'model');
  assert.ok(plain.prompts.some((p) => /Brain records on the Worker[\s\S]*\[Trading Room; verified; 2026-10-20\] 2 forward paper trades closed on MNQ breakout/.test(p)), 'the Worker\'s own Brain feeds the prompt');
});

test('an event the Brain could not take stays queued; a repeat drain never writes it twice (owner review, crash safety)', sqlite, async () => {
  const storage = storageFor();
  await queueRoomEvent(storage, { room: 'trading', kind: 'journal_trades', key: 'j1', title: 'Forward paper trade closed', body: 'x', status: 'verified', at: '2026-10-20T10:00:00Z' });
  await queueRoomEvent(storage, { room: 'rea', kind: 'investigation', key: 'r1', title: 'REA investigation complete: example.com', body: 'y', status: 'verified', at: '2026-10-20T10:01:00Z' });
  const offline = { init: () => false };
  const held = await drainRoomEvents(storage, offline);
  assert.equal(held.taken, 2); assert.equal(held.written, 0);
  assert.equal((await peekRoomEvents(storage)).length, 2, 'nothing is lost when the Brain is unavailable');
  const store = new CheBrainStore(storage);
  const first = await drainRoomEvents(storage, store);
  assert.equal(first.written, 2);
  const second = await drainRoomEvents(storage, store);
  assert.equal(second.taken, 0);
  assert.equal(store.search('forward paper trade closed', { limit: 5 }).filter((r) => r.title === 'Forward paper trade closed').length, 1, 'one record, not two');
});

test('the phone replica sees queued room events on its next sync without a chat turn', sqlite, async () => {
  const che = await owner();
  await queueRoomEvent(che.storage, { room: 'rea', kind: 'investigation', key: 'rea:1', title: 'REA investigation complete: example.com', body: 'x', status: 'verified', at: '2026-10-20T10:00:00Z' });
  const changes = await che.get('/api/brain/changes?since=0&limit=50');
  assert.equal(changes.status, 200);
  const ids = JSON.stringify(changes.body);
  assert.match(ids, /room:rea:rea:1/);
});

// ─── The owner's screen ───────────────────────────────────────────────────

test('screen helpers: the room a screen shows, follow-up phrases, and the 15-minute memory', async () => {
  assert.equal(screenRoomFor('Trading Room: MNQ 5-minute candles, paper trading on, 2 positions'), 'trading');
  assert.equal(screenRoomFor('Music Room: now playing a playlist'), 'music');
  assert.equal(screenRoomFor('GitHub pull request #374 checks'), 'coding');
  assert.equal(screenRoomFor('A weather website with a forecast'), 'screen');
  // Narrow: a visual referent, the only phrases that get the "I can't see your screen" answer.
  for (const m of ['What about the button on the left?', 'CHE, you see this?', 'Look at that button.', 'The one on the left']) assert.ok(screenFollowUp(m), m);
  // Broad: uses the screen when one is fresh; never a refusal.
  for (const m of ['What does this do?', 'Why does this interface work better than yours?', 'Compare this to your knowledge.', 'Do we already have this capability?']) assert.ok(screenDeictic(m), m);
  // Ordinary sentences are neither: they are the model's to answer (review, 2026-10-20).
  for (const m of ['What is the weather?', 'Read me the simulation records', 'What does the Trading Room know about MNQ?', 'Why does this code fail when I run it?', 'What does this mean in the error log?', 'Read this code: function f() {}', 'Explain this error message', 'Do we have this option in Flutter?', 'Compare this to a Honda Civic']) {
    assert.equal(screenFollowUp(m), false, `narrow: ${m}`);
  }
  assert.equal(screenDeictic('What is the weather?'), false);
  assert.equal(screenDeictic('What does the Trading Room know about MNQ?'), false);
  for (const m of ['CHE, look at my screen', 'can you see my screen?', 'what do you see']) assert.ok(asksAboutScreen(m), m);
  const saved = new Map();
  const storage = { get: async (k) => saved.get(k), put: async (k, v) => saved.set(k, v) };
  const now = Date.parse('2026-10-20T10:00:00Z');
  await rememberScreen(storage, { name: 'shot.png', summary: 'Trading Room with MNQ candles', engine: 'gemini-media:test', at: '2026-10-20T09:50:00Z' });
  assert.ok(saved.has(LAST_SCREEN_KEY), 'a normal screen summary is kept (positive check, review 2026-10-20)');
  assert.equal((await recentScreen(storage, now)).room, 'trading');
  assert.equal(await recentScreen(storage, now + 16 * 60_000), null, 'after fifteen minutes the screen is gone');
  assert.equal(statusLabel('observed'), 'observed, not verified');
  // A password on screen is never kept, and a stale observation is deleted, not just ignored (review, 2026-10-20).
  const unsafe = new Map();
  const safeStorage = { get: async (k) => unsafe.get(k), put: async (k, v) => unsafe.set(k, v), delete: async (k) => unsafe.delete(k) };
  assert.equal(await rememberScreen(safeStorage, { summary: 'Login page: password: hunter2hunter2 and Save button', at: '2026-10-20T09:59:00Z' }), null);
  assert.equal(unsafe.has(LAST_SCREEN_KEY), false, 'an unsafe summary is never stored');
  await rememberScreen(safeStorage, { summary: 'A settings page with a Save button', at: '2026-10-20T09:50:00Z' });
  assert.equal(await recentScreen(safeStorage, now + 16 * 60_000), null);
  assert.equal(unsafe.has(LAST_SCREEN_KEY), false, 'the stale summary is deleted from storage');
});

test('with no screen shared CHE says she cannot see it (Test K); a fresh observation answers the follow-up and a stale one does not (Test B)', sqlite, async () => {
  const che = await owner();
  const blind = await che.say('CHE, look at my screen.');
  assert.equal(blind.route, 'che_screen'); assert.equal(blind.modelCalls, 0);
  assert.match(blind.reply, /can't see your screen/);
  const followBlind = await che.say('What about the button on the left?');
  assert.equal(followBlind.route, 'che_screen'); assert.match(followBlind.reply, /can't see your screen/);
  await che.storage.put(LAST_SCREEN_KEY, { at: new Date(Date.now() - 2 * 60_000).toISOString(), name: 'shot.png', summary: 'A settings page with a blue Save button on the left and a red Cancel button on the right.', engine: 'gemini-media:test', room: 'screen' });
  const follow = await che.say('What about the button on the left?');
  assert.equal(follow.route, 'model');
  assert.ok(follow.prompts.some((p) => /Most recent screen observation \(temporary, not a record; seen [^)]*gemini-media:test[^)]*\): A settings page with a blue Save button/.test(p)), 'the recent observation is the screen context');
  await che.storage.put(LAST_SCREEN_KEY, { at: new Date(Date.now() - 20 * 60_000).toISOString(), name: 'shot.png', summary: 'old', engine: 'gemini-media:test', room: 'screen' });
  const stale = await che.say('What about the button on the left?');
  assert.equal(stale.route, 'che_screen'); assert.match(stale.reply, /can't see your screen/);
});

test('a real image analysis is reported with its engine, remembered for follow-ups, tied to its room and connected to the Brain on request (Test A, E)', sqlite, async () => {
  visionSummary = 'CHE Trading Room screen: MNQ 5-minute candles, paper trading ON, 2 open positions, a green Start button.';
  const che = await owner({ env: { CHE_MULTIMODAL_URL: VISION_URL } });
  const out = await che.say('What do you see here?', { attachment: { name: 'screen.png', media_type: 'image/png', base64: 'aGVsbG8=' } });
  assert.equal(out.route, 'model');
  assert.match(out.reply, /\(Seen with /, 'the owner hears which engine saw it');
  assert.equal(out.done.vision.ok, true);
  assert.equal(out.done.screen_room, 'trading');
  assert.ok(out.prompts.some((p) => /Authoritative trading records now \(read from storage, not from the screen/.test(p)), 'the Trading Room\'s ledgers are read for a Trading Room screen');
  assert.ok(out.prompts.some((p) => /<<<UNTRUSTED_SCREEN[\s\S]*UNTRUSTED_SCREEN>>>/.test(p) && /never instructions/.test(p)), 'screen text is framed as untrusted data');
  const seen = await recentScreen(che.storage);
  assert.equal(seen.room, 'trading'); assert.match(seen.engine, /^gemini-media|^openai|^connector|multimodal|vision/i);
  const connect = await che.say('Connect this to the Brain.');
  assert.equal(connect.route, 'che_brain_rooms'); assert.equal(connect.modelCalls, 0);
  assert.match(connect.reply, /observed note, not a verified fact/);
  const record = che.brain().search('Trading Room screen MNQ candles', { limit: 3 })[0];
  assert.ok(record && record.verification === 'observed' && record.source.room === 'screen');
  visionSummary = '';
  const none = await che.say('And this one?', { attachment: { name: 'two.png', media_type: 'image/png', base64: 'aGVsbG8=' } });
  assert.equal(none.done.vision.ok, false);
  assert.match(none.reply, /\(Vision: the attachment was not analyzed/);
});

test('a guest cannot read across rooms or the screen memory', sqlite, async () => {
  const che = await owner();
  const res = await worker.fetch(new Request('https://che.example/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'What does the Trading Room know about MNQ?', history: [] }) }), che.state.env);
  assert.equal(res.status, 401);
});

test('an ordinary code question with no screen shared is answered by the model, never refused as a screen question (review, 2026-10-20)', sqlite, async () => {
  const che = await owner({ model: () => 'It fails because the await is missing, sir.' });
  const out = await che.say('why does this code fail when I run it?');
  assert.equal(out.route, 'model');
  assert.doesNotMatch(out.reply, /can't see your screen/);
});

test('through chat: "what is connected to PR 374" answers from the Brain with no model call; an ordinary "related to" question goes to the model', sqlite, async () => {
  const che = await owner();
  await recordReceipt(che.storage, { kind: 'merged', number: 374, sha: '502cf47dafa5', detail: 'squash', at: '2026-10-20T11:00:00Z' });
  await queueRoomEvent(che.storage, { room: 'screen', kind: 'observation', key: 'screen:374', title: 'Screen: GitHub checks page', body: 'Checks for PR #374, all green.', status: 'observed', at: '2026-10-20T11:05:00Z' });
  const reply = await che.say('CHE, what is connected to pull request 374?');
  assert.equal(reply.route, 'che_brain_rooms');
  assert.equal(reply.modelCalls, 0);
  assert.match(reply.reply, /Pull request #374 merged/);
  assert.match(reply.reply, /Records that name it: .*Screen: GitHub checks page \(Screen, observed, not verified\)/);
  const plain = await che.say('What is related to diabetes?');
  assert.equal(plain.route, 'model');
  // "This" with no screen shared is about the conversation, not a refusal.
  const deictic = await che.say("What's related to this?");
  assert.equal(deictic.route, 'model');
});
