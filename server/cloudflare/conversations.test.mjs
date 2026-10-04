import assert from 'node:assert/strict';
import test from 'node:test';
import { CREW_THREADS_KEY, conversationThreads, recordCrewThread } from './conversations.js';

test('War Room, Office and crew conversations become group-chat threads, newest first, from real records only', async () => {
  const saved = new Map();
  const storage = { get: async (k) => saved.get(k), put: async (k, v) => { saved.set(k, v); } };
  await recordCrewThread(storage, { request: 'Update your code: friendlier banner', outcome: 'Reviewed change ready', discussion: [{ from: 'Atlas', msg: 'Plan: banner' }, { from: 'Sage', msg: 'APPROVE' }] });
  await recordCrewThread(storage, { request: 'x', discussion: [] });
  assert.equal(saved.get(CREW_THREADS_KEY).length, 1, 'empty discussions are not saved');
  const threads = conversationThreads({
    meetings: [{ id: 'm1', title: 'Launch plan', status: 'done', board: [
      { from: 'CHE', kind: 'brief', text: 'Goal: launch', at: '2026-10-04T01:00:00Z' },
      { from: 'Nova', to: 'Knox', kind: 'critique', text: 'Your draft misses pricing', at: '2026-10-04T01:05:00Z' },
    ] }, { id: 'm2', board: [] }],
    agents: [{ id: 'a1', name: 'Iris', messages: [{ from: 'CHE', to: 'Iris', text: 'Redo the banner', at: '2026-10-03T00:00:00Z' }] }, { id: 'a2', name: 'Quiet', messages: [] }],
  }, saved.get(CREW_THREADS_KEY));
  assert.deepEqual(threads.map((t) => t.kind), ['crew', 'war_room', 'office']);
  const room = threads.find((t) => t.kind === 'war_room');
  assert.equal(room.title, 'Launch plan');
  assert.deepEqual(room.participants, ['CHE', 'Nova']);
  assert.deepEqual(room.messages[1], { from: 'Nova', to: 'Knox', kind: 'critique', text: 'Your draft misses pricing', at: '2026-10-04T01:05:00Z' });
  assert.equal(threads[0].title, 'friendlier banner');
  assert.equal(threads.find((t) => t.kind === 'office').messages[0].to, 'Iris');
  assert.equal(threads.length, 3, 'no empty threads');
});

test('Office threads come from real team tasks; War Room titles use the objective', () => {
  const threads = conversationThreads({
    meetings: [{ id: 'm1', objective: 'Pick the MES plan', board: [{ from: 'Atlas', text: 'Breakout.', at: '2026-10-04T10:00:00Z' }] }],
    team_tasks: [{
      partner_id: 'a1', partner_name: 'Mira', task: 'Review the trading lab', created_at: '2026-10-04T09:00:00Z',
      steering: [{ text: 'Focus on MES', at: '2026-10-04T09:05:00Z' }],
      result: 'Reviewed: two bugs found.', review_feedback: 'Good, fix the first.', updated_at: '2026-10-04T09:30:00Z',
    }],
  });
  assert.equal(threads.find((t) => t.kind === 'war_room').title, 'Pick the MES plan');
  const office = threads.find((t) => t.id === 'agent:a1');
  assert.deepEqual(office.messages.map((m) => `${m.from}:${m.kind}`), ['CHE:task', 'CHE:steering', 'Mira:result', 'CHE:review']);
});
