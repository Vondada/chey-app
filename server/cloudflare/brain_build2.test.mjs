// Build 2 (owner, 2026-10-20): the whole app in CHE's Brain. Every room records what happens there, at the
// moment it happens, with its source, status and time; asked by voice or in chat, CHE answers what happened in
// any room from those records, newest first, with no model call. Runs through the real Worker offline with an
// in-memory SQLite Brain; the rooms are fed by their real producers (endpoints, receipts, the Office loop).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { CheBrainStore } from './brain_store.js';
import {
  PHONE_ROOM_KINDS, ROOM_EVENTS_KEY, controlChangeEvent, meetingEvent, officeTaskEvent, paperOrderRefusedEvent, peekRoomEvents, phoneRoomEvent,
  queueRoomEvent, researchEvent,
} from './room_events.js';
import { ROOMS, activityIntent, answerCrossRoom, crossRoomIntent, drainRoomEvents, roomActivity } from './brain_rooms.js';
import { recordReceipt } from './truth_layer.js';
import { processAgentWork, queueAgentTask } from './agent_runtime.js';

const generated = new URL('./.brain_build2.test.generated.mjs', import.meta.url);
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

// Offline: the one allowed request is a fake vision connector, so "look at my screen" can be read.
const VISION_URL = 'https://vision.example/analyze';
let visionSummary = '';
globalThis.fetch = async (input) => {
  const url = String(input?.url || input);
  if (url === VISION_URL && visionSummary) return new Response(JSON.stringify({ summary: visionSummary }), { status: 200, headers: { 'content-type': 'application/json' } });
  throw new TypeError(`fetch failed (brain_build2 tests are offline: ${url})`);
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

// The Office's model: drafts, an approving review and a War Room synthesis. Only the Office loop calls it.
const officeModel = (opts = {}) => {
  const system = String((opts.messages || []).find((m) => m.role === 'system')?.content || '');
  if (/Return ONLY JSON/.test(system)) return JSON.stringify({ decisions: ['Launch the Music Room playlist feature first'], conflicts: [], recommendations: ['Test with the owner'], final_plan: '1. Nova builds the playlist view.' });
  if (/First line must be exactly APPROVED/.test(system)) return 'APPROVED\nSolid and sourced.';
  return 'Findings: jazz playlists keep listeners longer. Source: https://example.org/jazz-study';
};

async function owner({ env: extra = {} } = {}) {
  let calls = 0;
  const pending = [];
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', ...extra, AI: { run: async (_model, opts = {}) => { calls += 1; return { response: officeModel(opts) }; } } };
  const saved = new Map();
  const storage = storageFor(saved);
  const state = new CheState({ storage, waitUntil: (p) => pending.push(p) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '', method = 'POST') => worker.fetch(new Request(`https://che.example${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const say = async (message, more = {}) => {
    const before = calls;
    const raw = await (await send('/api/chat', { message, history: [], ...more }, token)).text();
    while (pending.length) await pending.shift();
    const events = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const done = events.find((e) => e.type === 'done') || {};
    return { reply: events.filter((e) => e.type === 'delta').map((e) => e.delta).join(''), done, route: done.source || (calls > before ? 'model' : 'none'), modelCalls: calls - before };
  };
  const post = async (path, body, as = token) => { const res = await send(path, body, as); return { status: res.status, body: await res.json().catch(() => ({})) }; };
  // The alarm's Office loop, wired exactly as worker.js wires it (roomEvent queues into the same storage).
  const officeLoop = (budget = 8) => processAgentWork({
    env, load: () => state.loadData(), save: (value) => storage.put('che', value), notify: () => {}, models: { fast: 'fast', strong: 'strong' },
    roomEvent: (event) => queueRoomEvent(storage, event),
  }, budget);
  return { say, post, send, token, storage, saved, state, env, officeLoop, brain: () => new CheBrainStore(storage), modelCalls: () => calls };
}

const DATED = /\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/;

// ─── The builders: honest status, stable keys, nothing private ────────────

test('room event builders: honest statuses, stable keys, and a placed paper order is left to its receipt', () => {
  const refused = paperOrderRefusedEvent({ symbol: 'aapl', qty: 2, side: 'buy', client_order_id: 'abc12345' }, { ok: false, detail: 'Alpaca paper is not set up yet, sir, so no order was sent.' });
  assert.equal(refused.room, 'trading'); assert.equal(refused.status, 'verified'); assert.equal(refused.key, 'paper_refused:abc12345');
  assert.match(refused.title, /Alpaca PAPER order not placed: buy 2 AAPL/);
  assert.equal(paperOrderRefusedEvent({ client_order_id: 'x' }, { ok: false, unclear: true, detail: 'unclear' }).status, 'unknown', 'an unconfirmed order is never "verified not placed"');
  assert.equal(paperOrderRefusedEvent({}, { ok: true, receipt: { id: '1' } }), null, 'a placed order is recorded once, from its receipt');
  assert.equal(paperOrderRefusedEvent({}, { ok: true, repeated: true }), null);
  const stop = controlChangeEvent({ at: '2026-10-20T10:00:00.000Z', who: 'owner', action: 'emergency_stop', summary: 'Emergency Stop on.' }, { halted: { alpaca: { state: 'verified', cancelled: [{}, {}] } } });
  assert.equal(stop.title, 'Emergency Stop turned on'); assert.match(stop.body, /Alpaca PAPER orders cancelled: 2/); assert.equal(stop.key, 'control:2026-10-20T10:00:00.000Z:emergency_stop');
  assert.equal(controlChangeEvent({}), null);
  const meeting = { id: 'm-1', objective: 'Plan the launch', participants: [{ name: 'Nova' }], decisions: ['Ship it'], created_at: '2026-10-20T09:00:00Z', updated_at: '2026-10-20T09:30:00Z' };
  assert.equal(meetingEvent(meeting, 'convened').at, '2026-10-20T09:00:00Z');
  assert.match(meetingEvent(meeting).body, /model output, not verified/);
  assert.notEqual(meetingEvent(meeting).key, meetingEvent(meeting, 'convened').key);
  assert.equal(officeTaskEvent({ id: 't', task: 'x' }, { verified: false }).status, 'observed', 'an unreviewed result is only observed');
  assert.equal(officeTaskEvent({ id: 't', task: 'x' }, { verified: true }).status, 'verified');
  assert.equal(officeTaskEvent({ id: 't', task: 'x' }, { outcome: 'failed' }).kind, 'task_failed');
  assert.equal(researchEvent({ title: 'x', sources: ['https://a.example'] }).status, 'observed');
  assert.equal(researchEvent({ title: 'x', sources: ['https://a.example'], sourcesRead: false }).status, 'inferred', 'an agent\'s cited page was not necessarily opened');
  assert.equal(researchEvent({ title: '' }), null);
  assert.deepEqual(Object.keys(PHONE_ROOM_KINDS), ['music', 'help', 'screen']);
  for (const room of ['meetings', 'help']) assert.ok(ROOMS[room]?.label && ROOMS[room].region, room);
});

test('the phone event: allowlisted rooms and kinds, a stable key, bounded safe text, and a screen keeps only its name', () => {
  const safe = (t) => !/password/i.test(t);
  assert.match(phoneRoomEvent({ room: 'kitchen', kind: 'played', key: 'k-0001', title: 'x' }).error, /music, help or screen/);
  assert.match(phoneRoomEvent({ room: 'music', kind: 'deleted', key: 'k-0001', title: 'x' }).error, /played, paused, liked/);
  assert.match(phoneRoomEvent({ room: 'music', kind: 'played', key: 'a b', title: 'x' }).error, /stable key/);
  assert.match(phoneRoomEvent({ room: 'music', kind: 'played', key: 'k-0001', title: 'x'.repeat(201) }).error, /at most 200/);
  assert.match(phoneRoomEvent({ room: 'help', kind: 'explained', key: 'k-0001', title: 'Login', detail: 'my password is hunter2' }, { isSafe: safe }).error, /sensitive/);
  const screen = phoneRoomEvent({ room: 'screen', kind: 'observed', key: 'k-0001', title: 'Trading Room', detail: 'MNQ 21450 account 99881234', text: 'secret page text' }, { now: Date.parse('2026-10-20T12:00:00Z') });
  assert.equal(screen.title, 'Looked at Trading Room');
  assert.doesNotMatch(JSON.stringify(screen), /21450|99881234|secret page text/, 'a screen event keeps no screen text');
  assert.equal(screen.at, '2026-10-20T12:00:00.000Z');
  assert.equal(phoneRoomEvent({ room: 'music', kind: 'played', key: 'k-0001', title: 'Blue in Green' }).key, 'played:k-0001');
});

// ─── The question: what happened in a room ────────────────────────────────

test('"what happened in the X room" names one room by its name; ordinary sentences and the existing questions do not change', () => {
  const table = [
    ['What happened in the Music Room today?', 'music', 'today'],
    ['What did I do in the Trading Room?', 'trading', 'recent'],
    ['What did CHE do in the Office lately?', 'office', 'recent'],
    ['What did I ask help about?', 'help', 'recent'],
    ['What was on my screen earlier?', 'screen', 'recent'],
    ['What happened in the Meeting Room?', 'meetings', 'recent'],
    ['What did the Research Room find?', 'research', 'recent'],
    ['What happened in the Coding Room?', 'coding', 'recent'],
    ['CHE, what happened in the War Room yesterday?', 'meetings', 'yesterday'],
    ["What's new in the Help Center?", 'help', 'recent'],
    ['What screens did I look at today?', 'screen', 'today'],
  ];
  for (const [message, room, when] of table) {
    const got = crossRoomIntent(message);
    assert.ok(got, message); assert.equal(got.kind, 'activity', message); assert.deepEqual(got.rooms, [room], message); assert.equal(got.when, when, message);
  }
  for (const other of [
    'What happened today?', 'What did I do yesterday?', 'What happened in my office today?', 'What did I do in the office this morning?',
    'What happened in the Office of the President?', 'What happened in the meeting with Bob?', 'Help me find a meeting room near me', 'I need help',
    'What is on my screen?', "What's on my screen right now?", 'What was on TV earlier?', 'What did the doctor find?', 'What did the research find?',
    'Help me with the screen', 'What happened in the war in Ukraine?', 'What did I ask you about yesterday?', 'Can you help me with my music?',
    // The existing counter-cases still hold (review, 2026-10-20).
    'What does the agent know about visas to Japan?', 'Does my office have information on the lease?', 'Tell me about the trading room',
  ]) {
    assert.equal(crossRoomIntent(other), null, other);
  }
  assert.equal(activityIntent('What happened in the Brain Room?'), null, 'the Brain is the coordinator, not a room with its own activity');
});

test('answers list the room\'s records newest first with status and time, filter "today", and say so honestly when there are none', sqlite, async () => {
  const storage = storageFor();
  const store = new CheBrainStore(storage);
  const now = Date.parse('2026-10-20T18:00:00Z');
  for (const [key, title, at] of [['a', 'Played: Kind of Blue', '2026-10-18T15:00:00Z'], ['b', 'Played: So What', '2026-10-20T14:00:00Z'], ['c', 'Liked: Blue in Green', '2026-10-20T15:30:00Z']]) {
    await queueRoomEvent(storage, { room: 'music', kind: 'played', key, title, body: 'x', status: 'observed', at });
  }
  await drainRoomEvents(storage, store, { now });
  const all = roomActivity(store, 'music', { now });
  assert.deepEqual(all.records.map((r) => r.title), ['Liked: Blue in Green', 'Played: So What', 'Played: Kind of Blue'], 'newest first');
  const today = await answerCrossRoom({ store, storage, intent: { kind: 'activity', rooms: ['music'], when: 'today' }, now });
  assert.match(today.text, /What the Music Room recorded today, sir, newest first/);
  assert.match(today.text, /1\. Liked: Blue in Green \(Music Room; observed, not verified; 2026-10-20 15:30 UTC\)\n2\. Played: So What/);
  assert.doesNotMatch(today.text, /Kind of Blue/, 'two days ago is not today');
  const none = await answerCrossRoom({ store, storage, intent: { kind: 'activity', rooms: ['help'], when: 'recent' }, now });
  assert.match(none.text, /Nothing is recorded in the Help Center yet, sir\. Activity is recorded as it happens; I will not guess\./);
  const yesterday = await answerCrossRoom({ store, storage, intent: { kind: 'activity', rooms: ['music'], when: 'yesterday' }, now });
  assert.match(yesterday.text, /Nothing is recorded in the Music Room yesterday, sir\. The most recent Music Room record is from 2026-10-20 15:30 UTC: Liked: Blue in Green/);
});

// ─── The whole app, through the real /api/chat ────────────────────────────

test('every room records its activity through its real producer, and CHE answers each room by name, sourced, with no model call', sqlite, async () => {
  const che = await owner();

  // Trading Room: a strategy pause, an Emergency Stop, and an Alpaca PAPER order that was refused (no paper keys).
  const paused = await che.post('/api/trading/controls', { change: { kind: 'pause', scope: 'all' } });
  assert.equal(paused.status, 200, JSON.stringify(paused.body));
  const stopped = await che.post('/api/trading/controls', { change: { kind: 'emergency_stop' } });
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
  const order = { symbol: 'AAPL', qty: 1, side: 'buy', type: 'market', client_order_id: 'build2-order-0001' };
  assert.equal((await che.post('/api/trading/alpaca/order', order)).status, 400);
  assert.equal((await che.post('/api/trading/alpaca/order', order)).status, 400, 'a retry of the same request');

  // Coding Room: a receipt, as the self-update pipeline writes it.
  await recordReceipt(che.storage, { kind: 'pr_opened', key: 'pr:401', number: 401, summary: 'Build 2: the whole app in the Brain', url: 'https://github.com/Vondada/chey-app/pull/401' });

  // Meeting Room: a War Room meeting convened through the real endpoint, then concluded by the Office loop.
  const convened = await che.post('/api/meetings', { objective: 'Plan the Music Room playlist launch' });
  assert.equal(convened.status, 200, JSON.stringify(convened.body));

  // Office and Research: a research task delegated to an agent, done by the Office loop (with CHE's review), and a
  // task whose agent left the Office (a real failure).
  const data = await che.state.loadData();
  data.autonomy = true;
  const researcher = data.team.find((a) => /Research/.test(a.role)) || data.team[0];
  assert.ok(researcher, 'the War Room staffed a research partner');
  queueAgentTask(data, researcher, 'Research which jazz playlists keep listeners longest', 'owner');
  queueAgentTask(data, { id: 'gone', name: 'Old Agent', role: 'Helper' }, 'Tidy the old notes', 'owner');
  await che.storage.put('che', data);
  await che.officeLoop(12);
  const after = await che.state.loadData();
  assert.equal(after.meetings[0].status, 'complete', 'the meeting concluded');
  assert.ok(after.team_tasks.some((t) => t.status === 'complete'), 'the research task completed');
  assert.ok(after.team_tasks.some((t) => t.status === 'failed'), 'the orphaned task failed');

  // Music, Help and Screen: what the phone reports.
  for (const event of [
    { room: 'music', kind: 'played', key: 'music-0001', title: 'Blue in Green, Miles Davis', detail: 'CHE opened a YouTube search for it in her browser.' },
    { room: 'help', kind: 'explained', key: 'help-0001', title: 'What does Emergency Stop do?', detail: 'CHE explained the Emergency Stop button on the Trading Room.' },
    { room: 'help', kind: 'walkthrough', key: 'help-0002', title: 'Walkthrough of the Trading Room' },
    { room: 'screen', kind: 'observed', key: 'screen-0001', title: 'Trading Room', detail: 'MNQ 21450, account 99881234' },
  ]) {
    const res = await che.post('/api/brain/room-event', event);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.queued, true);
  }
  const repeat = await che.post('/api/brain/room-event', { room: 'music', kind: 'played', key: 'music-0001', title: 'Blue in Green, Miles Davis' });
  assert.equal(repeat.status, 200); assert.equal(repeat.body.queued, false, 'a retry with the same key is not queued twice');

  const before = che.modelCalls();
  const asks = [
    ['What did I do in the Trading Room?', 'trading', 'Trading Room', [/Emergency Stop turned on \(Trading Room; verified; /, /Strategies paused \(Trading Room; verified; /, /Alpaca PAPER order not placed: buy 1 AAPL \(Trading Room; verified; /, /Live ledgers: /]],
    ['What happened in the Coding Room?', 'coding', 'Coding Room', [/Pull request #401 opened: Build 2: the whole app in the Brain \(Coding Room; verified; /]],
    ['What happened in the Meeting Room?', 'meetings', 'Meeting Room', [/1\. Meeting concluded: Plan the Music Room playlist launch \(Meeting Room; verified; /, /2\. Meeting convened: Plan the Music Room playlist launch \(Meeting Room; verified; /]],
    ['What happened in the Music Room today?', 'music', 'Music Room', [/Played: Blue in Green, Miles Davis \(Music Room; observed, not verified; /]],
    ['What did the Research Room find?', 'research', 'Research Room', [/Research: .*\(Research Room; inferred, not verified; /]],
    ['What did CHE do in the Office lately?', 'office', 'Office', [/finished: Research which jazz playlists keep listeners longest \(Office; verified; /, /Old Agent could not finish: Tidy the old notes \(Office; verified; /]],
    ['What did I ask help about?', 'help', 'Help Center', [/1\. Help walkthrough: Walkthrough of the Trading Room \(Help Center; observed, not verified; /, /2\. Help explained: What does Emergency Stop do\? \(Help Center; observed, not verified; /]],
    ['What was on my screen earlier?', 'screen', 'Screen room', [/Looked at Trading Room \(Screen room; observed, not verified; /]],
  ];
  for (const [question, room, label, expected] of asks) {
    const out = await che.say(question);
    assert.equal(out.route, 'che_brain_rooms', `${question} -> ${JSON.stringify(out.done)} ${out.reply.slice(0, 300)}`);
    assert.equal(out.done.source, 'che_brain_rooms', question);
    assert.equal(out.modelCalls, 0, question);
    assert.deepEqual(out.done.rooms, [room], question);
    assert.equal(out.done.kind, 'activity', question);
    assert.ok(out.done.hits > 0, question);
    assert.match(out.reply, new RegExp(`^What the ${label} recorded`), question);
    assert.match(out.reply, DATED, `${question}: each record has its time`);
    for (const re of expected) assert.match(out.reply, re, question);
  }
  assert.equal(che.modelCalls(), before, 'no answer called a model');

  // Duplicates: one record per activity, however often it was reported or retried.
  const store = che.brain();
  const count = (room, re) => roomActivity(store, room, { limit: 50 }).records.filter((r) => re.test(r.title)).length;
  assert.equal(count('trading', /order not placed/), 1);
  assert.equal(count('music', /Blue in Green/), 1);
  // Provenance: every room record names its room, status, evidence and time.
  for (const room of ['trading', 'coding', 'meetings', 'music', 'research', 'office', 'help', 'screen']) {
    const records = roomActivity(store, room, { limit: 50 }).records;
    assert.ok(records.length, room);
    for (const r of records) {
      assert.equal(r.source.kind, 'room_event', `${room}: ${r.title}`);
      assert.equal(r.source.room, room);
      assert.ok(r.source.evidence.length, `${room}: ${r.title} has evidence`);
      assert.match(r.body, /Source room: .+\. Recorded \d{4}-\d{2}-\d{2}T/);
    }
  }
  // The screen record keeps only the screen's name and time, never what was on it.
  const screen = roomActivity(store, 'screen', { limit: 5 }).records[0];
  assert.doesNotMatch(JSON.stringify(screen), /21450|99881234/);
  assert.equal((await peekRoomEvents(che.storage)).length, 0, 'every queued event was written');
});

test('/api/brain/room-event: a guest, a private (non-owner) device and unsafe text are refused; nothing is queued', sqlite, async () => {
  const che = await owner();
  const event = { room: 'music', kind: 'played', key: 'music-0009', title: 'So What' };
  const guest = await che.post('/api/brain/room-event', event, '');
  assert.ok([401, 403].includes(guest.status), `guest: ${guest.status}`);
  // A device enrolled into another tenant with private access is not the owner's device.
  const tenant = (await (await che.send('/api/platform/tenants', { name: 'Family CHE', role: 'parental_guidance' }, che.token)).json()).tenant;
  const invite = (await (await che.send('/api/platform/enrollments', { tenant_id: tenant.id, access: 'private', ttl_minutes: 10 }, che.token)).json()).enrollment;
  const family = (await (await che.send('/api/enroll', { enrollment_token: invite.token, device_name: 'Family phone' })).json()).device_token;
  assert.ok(family, 'the family phone enrolled');
  const notOwner = await che.post('/api/brain/room-event', event, family);
  assert.ok([401, 403].includes(notOwner.status), `private device: ${notOwner.status}`);
  const unsafe = await che.post('/api/brain/room-event', { room: 'help', kind: 'explained', key: 'help-0009', title: 'Sign in', detail: 'My password is hunter2hunter2' });
  assert.equal(unsafe.status, 400); assert.match(unsafe.body.detail, /sensitive/);
  const wrongKind = await che.post('/api/brain/room-event', { room: 'trading', kind: 'order', key: 'trade-0009', title: 'Buy 100 TSLA' });
  assert.equal(wrongKind.status, 400, 'the phone cannot write Trading Room records');
  assert.deepEqual(((await che.storage.get(ROOM_EVENTS_KEY)) || []).filter((e) => ['music', 'help', 'trading'].includes(e.room)), [], 'nothing was queued');
  // And a guest cannot ask what happened in a room.
  const res = await worker.fetch(new Request('https://che.example/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'What happened in the Music Room today?', history: [] }) }), che.env);
  assert.equal(res.status, 401);
});

test('"look at my screen" read by vision records only which screen and when in the Screen room; the summary stays temporary', sqlite, async () => {
  visionSummary = 'CHE Trading Room: MNQ chart, account 99881234, two paper positions and a Stop button.';
  const che = await owner({ env: { CHE_MULTIMODAL_URL: VISION_URL } });
  await che.say('CHE, look at my screen', {
    attachment: { name: 'che-screen.png', media_type: 'image', base64: 'aGVsbG8=' },
    screen_context: 'The owner asked CHE to look at his screen. Page report: You are on Trading Room, Controls tab.',
  });
  await che.say('CHE, look at my screen', {
    attachment: { name:'che-screen.png', media_type:'image', base64:'aGVsbG8=' },
    screen_context:'You are on Music Room, Library tab.',
  });
  // An ordinary photo is not a screen.
  await che.say('What is in this photo?', { attachment: { name: 'IMG_0001.jpg', media_type: 'image/jpeg', base64: 'aGVsbG8=' } });
  visionSummary = '';
  const out = await che.say('What was on my screen earlier?');
  assert.equal(out.route, 'che_brain_rooms'); assert.equal(out.modelCalls, 0);
  assert.match(out.reply, /2\. Looked at Trading Room \(Screen room; observed, not verified; \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\)/);
  assert.match(out.reply, /2\./, 'two observations within a minute are distinct');
  const records = roomActivity(che.brain(), 'screen', { limit: 10 }).records;
  assert.equal(records.length, 2);
  assert.doesNotMatch(JSON.stringify(records), /MNQ chart|99881234|aGVsbG8=/, 'no screen text or image in the Brain');
  assert.match(records[0].source.evidence[0], /look at my screen, read by /);
});


test('yesterday uses the previous Chicago calendar date across daylight saving', sqlite, async () => {
  const che = await owner();
  const store = che.brain();
  for (const [key, at] of [['previous', '2026-10-31T18:00:00Z'], ['current', '2026-11-01T18:00:00Z']]) {
    await queueRoomEvent(che.storage, phoneRoomEvent({room:'music', kind:'requested', key, title:key}, { now: Date.parse(at) }));
  }
  await drainRoomEvents(che.storage, store);
  const result = roomActivity(store, 'music', { when:'yesterday', now:Date.parse('2026-11-02T05:30:00Z') });
  assert.equal(result.records.length, 1);
  assert.match(result.records[0].title, /previous/);
});
