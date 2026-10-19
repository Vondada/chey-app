import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityReceipt, activityStatusIntent } from './activity_status.js';

const NOW = Date.parse('2026-10-17T20:00:00Z');
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();

test('whole status questions are recognised, with wake words and casual spelling', () => {
  for (const q of ['What are you doing?', 'chay what r u doing right now', "What's running?", 'what’s in progress', 'Is anything running?', 'CHE, what are you working on?', 'What are you up to?']) {
    assert.equal(activityStatusIntent(q), 'active', q);
  }
  for (const q of ["What's finished?", 'What did you finish today?', 'What have you completed?', "What's done?"]) {
    assert.equal(activityStatusIntent(q), 'finished', q);
  }
});

test('questions that only start the same way keep their own meaning', () => {
  for (const q of ['What are you doing tonight?', 'What is running on port 8080?', 'What are you doing about the router bug, and can you fix it?', 'Stop what you are doing.', "What's done is done, let's move on.",
    // Review of #336: news, a chart or a photo, and a chat action CHE just took, are not the job queue.
    "What's happening?", "What's happening today?", 'What have you done?', 'What did you get done?', 'What got done?', 'What are you doing today?']) {
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
  assert.match(activityReceipt({ now: NOW, runtime: { sessionId: 'ocr-1234abcd', state: 'running', stateClass: 'active' } }), /Coding run ocr-1234abcd: running\./);
  assert.match(activityReceipt({ mode: 'finished', now: NOW, runtime: { sessionId: 'ocr-1234abcd', state: 'opencode_failed', stateClass: 'failed' } }), /coding run ocr-1234abcd \(opencode failed\)/);
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

test('a coding run with a PR open, in review or waiting on capacity is current work, not finished', () => {
  for (const [state, stateClass] of [['pr_open', 'progress'], ['reviewing', 'progress'], ['approved_waiting_owner', 'progress'], ['waiting_capacity', 'active'], ['resuming', 'active']]) {
    const runtime = { sessionId: 'ocr-1234abcd', state, stateClass };
    assert.match(activityReceipt({ now: NOW, runtime }), new RegExp(`Coding run ocr-1234abcd: ${state.replace(/_/g, ' ')}\\.`), state);
    assert.doesNotMatch(activityReceipt({ now: NOW, runtime }), /Nothing is running/, state);
    assert.match(activityReceipt({ mode: 'finished', now: NOW, runtime }), /Nothing finished in the last day, sir\. 1 still running or queued|Nothing finished/, state);
    assert.doesNotMatch(activityReceipt({ mode: 'finished', now: NOW, runtime }), /ocr-1234abcd \(/, state);
  }
});

test('a run GitHub could not confirm is UNVERIFIED, never plain "queued"', () => {
  const text = activityReceipt({ now: NOW, runtime: { sessionId: 'ocr-1234abcd', state: 'queued', stateClass: 'active', unverified: true } });
  assert.match(text, /state UNVERIFIED, last recorded as queued/);
});

test('paused autonomy is said beside queued work', () => {
  const jobs = [{ title: 'Draft the report', status: 'queued', updated_at: at(3) }];
  assert.match(activityReceipt({ now: NOW, jobs, paused: true }), /Autonomy is paused, so queued work will not start until you resume it\./);
  assert.doesNotMatch(activityReceipt({ now: NOW, jobs, paused: false }), /Autonomy is paused/);
  assert.doesNotMatch(activityReceipt({ now: NOW, jobs: [], paused: true }), /Autonomy is paused/);
});

test('comprehension audit: "is any coding job running right now?" reads the job records', () => {
  assert.equal(activityStatusIntent('Is any coding job running right now?'), 'active');
  assert.equal(activityStatusIntent('are there any jobs running'), 'active');
  assert.equal(activityStatusIntent('Is a job interview running late?'), '');
});
