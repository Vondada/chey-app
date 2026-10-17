import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityReceipt, activityStatusIntent } from './activity_status.js';

const NOW = Date.parse('2026-10-17T20:00:00Z');
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();

test('whole status questions are recognised, with wake words and casual spelling', () => {
  for (const q of ['What are you doing?', 'chay what r u doing right now', "What's running?", 'what’s in progress', 'Is anything running?', 'CHE, what are you working on?', 'What are you up to?']) {
    assert.equal(activityStatusIntent(q), 'active', q);
  }
  for (const q of ["What's finished?", 'What did you finish today?', 'What have you completed?', "What's done?", 'What got done?']) {
    assert.equal(activityStatusIntent(q), 'finished', q);
  }
});

test('questions that only start the same way keep their own meaning', () => {
  for (const q of ['What are you doing tonight?', 'What is running on port 8080?', 'What are you doing about the router bug, and can you fix it?', 'Stop what you are doing.', "What's done is done, let's move on."]) {
    assert.equal(activityStatusIntent(q), '', q);
  }
});

test('nothing running is said plainly, with the count of what finished', () => {
  assert.equal(activityReceipt({ jobs: [], now: NOW }), 'Nothing is running or queued right now, sir.');
  const text = activityReceipt({ jobs: [{ title: 'Merge PR #9 when CI passes', status: 'complete', updated_at: at(30) }], now: NOW });
  assert.match(text, /Nothing is running or queued right now, sir\. 1 finished in the last day/);
});

test('running, waiting and missions are listed from the records', () => {
  const text = activityReceipt({
    now: NOW,
    staleMs: () => 30 * 60_000,
    jobs: [
      { title: 'Verify iPhone build', kind: 'verify_app_build', status: 'running', updated_at: at(2) },
      { title: 'Merge PR #9 when CI passes', kind: 'merge_pr', status: 'blocked', updated_at: at(5) },
    ],
    objectives: [{ objective: 'Ship the video', status: 'running', nodes: [{ status: 'complete' }, { status: 'running' }] }],
  });
  assert.match(text, /Running or queued: Verify iPhone build \(running\)\./);
  assert.match(text, /Waiting or blocked: Merge PR #9 when CI passes \(blocked\)\./);
  assert.match(text, /Missions: Ship the video/);
});

test('a running job that stopped reporting progress is not called running', () => {
  const text = activityReceipt({ now: NOW, staleMs: () => 30 * 60_000, jobs: [{ title: 'Study build', status: 'running', updated_at: at(180) }] });
  assert.match(text, /Stopped reporting progress, not confirmed running: Study build\./);
  assert.doesNotMatch(text, /Running or queued/);
});

test('the latest coding run is shown live, finished, or UNVERIFIED, never guessed', () => {
  assert.match(activityReceipt({ now: NOW, runtime: { sessionId: 'ocr-1234abcd', state: 'running' } }), /Coding run ocr-1234abcd: running\./);
  assert.match(activityReceipt({ mode: 'finished', now: NOW, runtime: { sessionId: 'ocr-1234abcd', state: 'blocked' } }), /coding run ocr-1234abcd \(blocked\)/);
  const unread = activityReceipt({ now: NOW, runtime: { sessionId: 'ocr-1234abcd', unread: true } });
  assert.match(unread, /state UNVERIFIED, GitHub could not be read/);
  assert.doesNotMatch(unread, /Nothing is running/);
});

test('what finished lists the last day only, newest first, with dead letters named', () => {
  const text = activityReceipt({
    mode: 'finished', now: NOW,
    jobs: [
      { title: 'Old study', status: 'complete', updated_at: at(60 * 30) },
      { title: 'Merge PR #9', status: 'complete', updated_at: at(90) },
      { title: 'Video render', status: 'failed', dead_letter: true, updated_at: at(10) },
      { title: 'Verify deploy', status: 'running', updated_at: at(1) },
    ],
  });
  assert.equal(text, 'Finished in the last day: Video render (dead letter); Merge PR #9 (complete). 1 still running or queued.');
  assert.equal(activityReceipt({ mode: 'finished', now: NOW, jobs: [] }), 'Nothing finished in the last day, sir.');
});
