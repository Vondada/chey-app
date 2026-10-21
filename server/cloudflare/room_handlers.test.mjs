// Each room action reaches its handler and reports the handler's real result. An action with no handler, or a
// handler that fails, says so; nothing is reported that did not happen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { roomExecutor } from './room_handlers.js';
import { runRoomWorkflow } from './agent_rooms.js';

const ok = (extra) => ({ ok: true, ...extra });
const NEWEST = { id: 'm1', from: 'Ana <ana@example.org>', subject: 'Lunch?', date: 'Tue', snippet: '' };

function fakes(over = {}) {
  const calls = [];
  const record = (name, value) => async (...args) => { calls.push({ name, args }); return typeof value === 'function' ? value(...args) : value; };
  return {
    calls,
    handlers: {
      gmailList: record('gmailList', ok({ messages: [NEWEST], total: 1, approximate: false })),
      gmailRead: record('gmailRead', ok({ from: NEWEST.from, subject: NEWEST.subject, date: 'Tue', body: 'Lunch at noon?' })),
      gmailSend: record('gmailSend', ok({})),
      driveList: record('driveList', ok({ files: [{ id: 'f1', name: 'Plan.doc' }] })),
      driveCreateDoc: record('driveCreateDoc', ok({})),
      calendarList: record('calendarList', ok({ events: [{ summary: 'Dentist', start: 'x', end: 'y' }] })),
      calendarCreate: record('calendarCreate', ok({})),
      youtubeUploads: () => [{ title: 'Shorts 1', link: 'https://youtu.be/x' }],
      readLedgers: async () => ({ strategy_simulation: { open: 2, trades: 40 } }),
      ...over,
    },
  };
}

test('reading unread email reports the newest message the Gmail handler returned', async () => {
  const f = fakes();
  const run = roomExecutor({ handlers: f.handlers, env: {}, data: {} });
  const r = await runRoomWorkflow('gmail_newest_unread', { executor: run, grants: ['Gmail'] });
  assert.equal(r.status, 'completed');
  assert.match(r.receipts[0].summary, /Newest: "Lunch\?" from Ana/);
  assert.match(r.receipts[1].summary, /Lunch at noon\?/);
  assert.equal(f.calls.filter((c) => c.name === 'gmailList').length, 2, 'the list is read for the list step and again to find the message to open');
});

test('a Gmail failure stops the workflow and the failure is what the owner hears', async () => {
  const f = fakes({ gmailList: async () => ({ ok: false, error: 'Gmail is not connected' }) });
  const r = await runRoomWorkflow('gmail_newest_unread', { executor: roomExecutor({ handlers: f.handlers }), grants: ['Gmail'] });
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /Gmail is not connected/);
});

test('sending an email reaches the Gmail send handler with the owner\'s words', async () => {
  const f = fakes();
  const run = roomExecutor({ handlers: f.handlers });
  const out = await run('gmail', 'send_email', { to: 'ana@example.org', subject: 'Hi', body: 'See you.' });
  assert.equal(out.ok, true);
  assert.deepEqual(f.calls[0].args[2], { to: 'ana@example.org', subject: 'Hi', body: 'See you.' });
  assert.equal(out.summary, 'Sent to ana@example.org: "Hi".');
});

test('calendar lists the next seven days, and reports what the handler found', async () => {
  const f = fakes();
  const now = Date.UTC(2026, 9, 21, 12, 0);
  const r = await roomExecutor({ handlers: f.handlers, now })('calendar', 'list_events', { limit: 5 });
  assert.equal(r.summary, '1 upcoming: Dentist.');
  const window = f.calls[0].args[2];
  assert.equal(new Date(window.timeMax).getTime() - new Date(window.timeMin).getTime(), 7 * 24 * 60 * 60 * 1000);
});

test('trading status reads the real ledgers and reports the simulation counts', async () => {
  const f = fakes();
  const r = await roomExecutor({ handlers: f.handlers, storage: {} })('trading', 'show_positions', {});
  assert.equal(r.summary, 'Strategy simulation: 2 open, 40 trades stored.');
});

test('an action with no handler says it is not connected, and runs nothing', async () => {
  const f = fakes();
  const r = await roomExecutor({ handlers: f.handlers })('drive', 'read_file', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /not connected yet/);
  const unknown = await roomExecutor({ handlers: f.handlers })('drive', 'teleport', {});
  assert.equal(unknown.ok, false);
});

test('placing a paper order is not claimed: the room reports it cannot yet', async () => {
  const r = await roomExecutor({ handlers: fakes().handlers })('trading', 'place_paper_order', {});
  assert.equal(r.ok, false);
});

test('a thrown handler error becomes a failed step in the workflow, not a crash', async () => {
  const f = fakes({ calendarList: async () => { throw new Error('network down'); } });
  const r = await runRoomWorkflow('calendar_next', { executor: roomExecutor({ handlers: f.handlers }), grants: ['Google Calendar'] });
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /network down/);
});
