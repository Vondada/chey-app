// The rooms as workflows: every action passes the owner's rules, and a workflow reports only what really ran.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRoomActionMayRun, runRoomWorkflow, WORKFLOWS, ROOMS } from './agent_rooms.js';

const ALL = Object.values(ROOMS).map((r) => r.app);

test('reading and sending in a granted room run now; sending is reported, as the owner allowed', () => {
  assert.deepEqual(assertRoomActionMayRun('gmail', 'list_unread', { grants: ['Gmail'] }), { held: false, kind: 'read' });
  assert.deepEqual(assertRoomActionMayRun('gmail', 'send_email', { grants: ['Gmail'] }), { held: false, kind: 'send' });
  assert.deepEqual(assertRoomActionMayRun('calendar', 'create_event', { grants: ['Google Calendar'] }), { held: false, kind: 'create' });
});

test('deleting, paper orders and publishing wait for the owner\'s yes', () => {
  assert.equal(assertRoomActionMayRun('gmail', 'trash', { grants: ['Gmail'] }).held, true);
  assert.equal(assertRoomActionMayRun('drive', 'delete_file', { grants: ['Google Drive'] }).held, true);
  assert.equal(assertRoomActionMayRun('trading', 'place_paper_order', { grants: ['Trading Room'] }).held, true);
  assert.equal(assertRoomActionMayRun('youtube', 'publish_video', { grants: ['YouTube'] }).held, true);
  assert.equal(assertRoomActionMayRun('trading', 'place_paper_order', { grants: ['Trading Room'], ownerConfirmed: true }).held, false);
});

test('a live order is never allowed, even with the owner\'s yes', () => {
  assert.throws(() => assertRoomActionMayRun('trading', 'place_live_order', { grants: ['Trading Room'], ownerConfirmed: true }), /Live trading is not allowed/);
});

test('an unknown room or action, or a room the owner has not granted, is refused', () => {
  assert.throws(() => assertRoomActionMayRun('tiktok', 'post', { grants: ALL }), /no "post" action/);
  assert.throws(() => assertRoomActionMayRun('gmail', 'fly', { grants: ['Gmail'] }), /no "fly" action/);
  assert.throws(() => assertRoomActionMayRun('gmail', 'list_unread', { grants: ['Calendar'] }), /no permission to act in Gmail/);
});

test('a workflow runs each step in order and reports the real receipts', async () => {
  const seen = [];
  const executor = async (room, action) => {
    seen.push(`${room}.${action}`);
    return { ok: true, summary: `${action} done`, data: { n: seen.length } };
  };
  const r = await runRoomWorkflow('gmail_newest_unread', { executor, grants: ['Gmail'] });
  assert.equal(r.status, 'completed');
  assert.deepEqual(seen, ['gmail.list_unread', 'gmail.read_message']);
  assert.equal(r.receipts.length, 2);
  assert.equal(r.receipts[1].summary, 'read_message done');
});

test('a step that fails stops the workflow, and no answer is made up for the rest', async () => {
  const seen = [];
  const executor = async (room, action) => {
    seen.push(action);
    return action === 'list_unread' ? { ok: false, error: 'Gmail is not connected' } : { ok: true };
  };
  const r = await runRoomWorkflow('gmail_newest_unread', { executor, grants: ['Gmail'] });
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /Gmail is not connected/);
  assert.deepEqual(seen, ['list_unread'], 'the later step never ran');
});

test('a thrown error from the connector is a failed step, not a crash', async () => {
  const r = await runRoomWorkflow('calendar_next', { executor: async () => { throw new Error('timeout'); }, grants: ['Google Calendar'] });
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /timeout/);
});

test('a workflow holds at a step that needs the owner, and the steps after it do not run', async () => {
  const wf = { ops: { room: 'drive', name: 'x', steps: [{ action: 'list_files' }, { action: 'delete_file', input: { id: 'f1' } }, { action: 'read_file' }] } };
  const seen = [];
  const r = await runRoomWorkflow('ops', { workflows: wf, executor: async (room, action) => { seen.push(action); return { ok: true }; }, grants: ['Google Drive'] });
  assert.equal(r.status, 'held');
  assert.equal(r.kind, 'delete');
  assert.deepEqual(seen, ['list_files']);
});

test('a workflow for a room the owner has not granted is refused before anything runs', async () => {
  let ran = false;
  const r = await runRoomWorkflow('trading_status', { executor: async () => { ran = true; return { ok: true }; }, grants: ['Gmail'] });
  assert.equal(r.status, 'refused');
  assert.equal(ran, false);
});

test('every workflow names a real room and only real actions', () => {
  for (const [id, wf] of Object.entries(WORKFLOWS)) {
    assert.ok(ROOMS[wf.room], `${id} names a real room`);
    for (const step of wf.steps) assert.ok(ROOMS[wf.room].actions[step.action], `${id} uses a real action ${step.action}`);
  }
});

test('no room has a live-trading action that can run', () => {
  for (const room of Object.values(ROOMS)) {
    for (const [id, action] of Object.entries(room.actions)) {
      if (action.kind === 'live_trade') assert.throws(() => assertRoomActionMayRun(room.id, id, { grants: [room.app], ownerConfirmed: true }));
    }
  }
});
