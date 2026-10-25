// Owner, 2026-10-25: "Retrieve the current status of coding job f1a27d86, its assigned engine, last execution event
// and GitHub workflow run" was answered "I couldn't finish that answer" (no route took it, so the model failed).
// These tests pin the routing, the named-job answer and the missing-job answer.
import assert from 'node:assert/strict';
import test from 'node:test';
import { codingHistoryIntent } from './code_scout.js';
import { codingHistoryReceipt, jobForShortId, missingJobReply, namedJobAnswer, namedJobId } from './coding_history.js';

const UUID_A = 'f1a27d86-1111-4aaa-8bbb-000000000001';
const UUID_B = 'c0ffee00-2222-4bbb-8ccc-000000000002';
const jobs = [
  { id: UUID_B, kind: 'self_development', status: 'running', created_at: '2026-10-25T12:00:00Z', updated_at: '2026-10-25T12:01:00Z', request: 'newest job' },
  { id: UUID_A, kind: 'self_development', status: 'queued', created_at: '2026-10-25T11:00:00Z', updated_at: '2026-10-25T11:00:00Z', request: 'add a status test' },
];

test('the owner\'s full sentence about one named coding job is a coding-status question', () => {
  assert.equal(codingHistoryIntent('Retrieve the current status of coding job f1a27d86, its assigned engine, last execution event and GitHub workflow run.', []), true);
  assert.equal(codingHistoryIntent('What is the status of coding job f1a27d86?', []), true);
  assert.equal(codingHistoryIntent('coding job f1a27d86 status', []), true);
  assert.equal(codingHistoryIntent('Show the GitHub workflow run for coding job f1a27d86', []), true);
});

test('a request to act on a named coding job is never a status question', () => {
  assert.equal(codingHistoryIntent('Cancel coding job f1a27d86', []), false);
  assert.equal(codingHistoryIntent('Fix the bug in coding job f1a27d86 and redeploy', []), false);
  assert.equal(codingHistoryIntent('Retrieve and redeploy the coding job f1a27d86', []), false);
  assert.equal(codingHistoryIntent('Retrieve the status of coding job f1a27d86 and cancel it', []), false);
});

test('the short ID is read from the message and matched by prefix to the stored UUID', () => {
  assert.equal(namedJobId('What is the status of coding job F1A27D86?'), 'f1a27d86');
  assert.equal(namedJobId('what is the status of the coding job'), '');
  assert.equal(jobForShortId(jobs, 'f1a27d86')?.id, UUID_A);
  assert.equal(jobForShortId(jobs, 'deadbeef'), null, 'an unknown ID matches nothing, never the newest job');
});

test('a named job is answered from its own record, not the newest job', () => {
  const named = namedJobAnswer('What is the status of coding job f1a27d86?', jobs, '');
  assert.equal(named.job.id, UUID_A);
  const text = codingHistoryReceipt({ kind: 'job', job: named.job });
  assert.match(text, /queued/i);
  assert.match(text, /f1a27d86/);
  assert.doesNotMatch(text, /newest job/);
});

test('an ID that matches no stored job says so plainly and starts nothing', () => {
  const missing = namedJobAnswer('What is the status of coding job deadbeef?', jobs, '');
  assert.equal(missing.job, undefined);
  assert.equal(missing.reply, missingJobReply('deadbeef'));
  assert.match(missing.reply, /no coding job deadbeef in my records/);
  assert.match(missing.reply, /Nothing was started or changed/);
});

test('an ID that is the current runtime session is left to the runtime answer', () => {
  assert.deepEqual(namedJobAnswer('What is the status of coding job f1a27d86?', [], 'f1a27d86-session'), {});
});

test('no named job means no change to the existing answer', () => {
  assert.deepEqual(namedJobAnswer('What is the status of the coding job?', jobs, ''), {});
});

test('the job ID alone, without the word coding, is still one named record', () => {
  assert.equal(codingHistoryIntent('What is the status of job f1a27d86, the assigned engine and the GitHub workflow run?'), true);
  assert.equal(codingHistoryIntent('Did coding job f1a27d86 pass or fail?'), true);
  assert.equal(namedJobId('Did job f1a27d86 pass or fail?'), 'f1a27d86');
});

test('an outcome question about a named job never becomes an action on it', () => {
  assert.equal(codingHistoryIntent('Cancel job f1a27d86 and tell me if it passed'), false);
  assert.equal(codingHistoryIntent('Fix coding job f1a27d86 and redeploy when it passes'), false);
  assert.equal(codingHistoryIntent('Rerun job f1a27d86 if it failed'), false);
});
