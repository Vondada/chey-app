import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codingHistoryIntent, currentTurnActionPolicy, repositoryInspectionIntent } from './code_scout.js';
import { codingHistoryReceipt } from './coding_history.js';

// Read-only execution-history questions. Each must be answered from the stored job or runtime
// record, never start a coding job, and never be routed to repository inspection (the 17 Oct
// 2026 EXPLORE failure listed repository file names instead of the run).
const HISTORY = [
  'Inspect her latest coding execution history.',
  'chay, what is the latest coding execution history',
  'Do not start a coding job. What is the latest coding execution history?',
  'How far did Claude get?',
  'Why did that coding job fail?',
  'Explain why the coding job failed.',
  'What happened to the last coding job?',
  'Show me the actual result of the coding run.',
  'Show me the coding job\'s latest result.',
  'What is the state of the coding job?',
  'What files did the coding job change?',
  'Inspect the coding job history and tell me the files.',
  "What's the latest coding job status?",
];

for (const message of HISTORY) {
  test(`history question stays read-only: "${message}"`, () => {
    assert.equal(codingHistoryIntent(message), true);
    assert.equal(repositoryInspectionIntent(message), false, 'never answered by reading repository files');
    const policy = currentTurnActionPolicy(message);
    assert.equal(policy.codingJobAllowed, false, 'a history question never starts a coding job');
    assert.equal(policy.repositoryMutationAllowed, false);
  });
}

const NOT_HISTORY = [
  'Start a new coding job to fix the router.',
  'Fix the coding job.',
  'Explain how you would fix the failed coding job.',
  'Check the code.',
  'Review the coding pipeline.',
  'Show me the latest code for the coding job runner.',
  'Inspect the coding runtime code.',
  'What files should I change for the coding job?',
  'What files would the coding job change if we fixed the router?',
  'Investigate npm:semver@7.7.2 and tell me the coding job history.',
  'Look at https://github.com/example/app and tell me the coding job state.',
  'CHE, investigate why coding jobs produce delayed responses. This is READ-ONLY.',
  'CHE, investigate your coding status bug and report verified findings.',
];

for (const message of NOT_HISTORY) {
  test(`not a history question: "${message}"`, () => {
    assert.equal(codingHistoryIntent(message), false);
  });
}

test('an explicit build instruction in the same turn still wins: history is not a substitute for a fix', () => {
  assert.equal(codingHistoryIntent('Inspect the latest coding execution history and fix the bug.'), false);
});

test('a failed run record is reported with its run, models, error and the limits of the evidence', () => {
  const text = codingHistoryReceipt({
    kind: 'runtime', sessionId: 'ocr-6550098c',
    status: {
      status: 200, state: 'blocked', failure: 'opencode_failed', error: 'quota exhausted',
      run_id: 39031928523, models_tried: ['groq/qwen3', 'openrouter/qwen3-coder'], changed_files: 0,
      files: ['server/cloudflare/worker.js'],
    },
  });
  assert.match(text, /Latest coding run: ocr-6550098c\./);
  assert.match(text, /State: blocked\./);
  assert.match(text, /Failure: opencode_failed - quota exhausted/);
  assert.match(text, /https:\/\/github\.com\/Vondada\/chey-app\/actions\/runs\/39031928523/);
  assert.match(text, /Models tried: groq\/qwen3, openrouter\/qwen3-coder\./);
  assert.match(text, /Files changed: 0\./);
  assert.match(text, /Pull request: none recorded\./);
  assert.match(text, /Tests: not recorded/);
  assert.doesNotMatch(text, /worker\.js/, 'repository file names are never the answer');
});

test('the request that the job was given is shown, so the reply says which job it is', () => {
  const text = codingHistoryReceipt({ kind: 'runtime', sessionId: 'ocr-12345678', request: 'Get the newest CHE IPA onto my iPhone', status: { status: 200, state: 'queued' } });
  assert.match(text, /Request: Get the newest CHE IPA onto my iPhone\./);
});

test('the run link uses the repository the runtime is configured for', () => {
  const text = codingHistoryReceipt({ kind: 'runtime', sessionId: 'ocr-12345678', repo: 'owner/other', status: { status: 200, state: 'blocked', run_id: 7 } });
  assert.match(text, /github\.com\/owner\/other\/actions\/runs\/7/);
});

test('a record without a run, models or a change count names each missing field', () => {
  const text = codingHistoryReceipt({ kind: 'runtime', sessionId: 'ocr-12345678', status: { status: 200, state: 'queued' } });
  assert.match(text, /GitHub run: not recorded\./);
  assert.match(text, /Models tried: not recorded\./);
  assert.match(text, /Files changed: not recorded\./);
});

test('a null change count is not reported as zero', () => {
  const text = codingHistoryReceipt({ kind: 'runtime', sessionId: 'ocr-12345678', status: { status: 200, state: 'blocked', changed_files: null } });
  assert.match(text, /Files changed: not recorded\./);
  assert.doesNotMatch(text, /Files changed: 0/);
});

test('a created pull request is named by number', () => {
  const text = codingHistoryReceipt({ kind: 'runtime', sessionId: 'ocr-12345678', status: { status: 200, state: 'reviewing', changed_files: 2, pr_number: 331 } });
  assert.match(text, /Pull request: #331\./);
  assert.match(text, /Files changed: 2\./);
  assert.match(text, /Tests: passed\./);
});

test('tests are reported only as the runtime states them: failed, passed, running, or not recorded', () => {
  assert.match(codingHistoryReceipt({ kind: 'runtime', sessionId: 'ocr-12345678', status: { status: 200, state: 'tests_failed', pr_number: 9 } }), /Tests: failed\./);
  assert.match(codingHistoryReceipt({ kind: 'runtime', sessionId: 'ocr-12345678', status: { status: 200, state: 'pr_open', pr_number: 9 } }), /Tests: running\./);
  assert.match(codingHistoryReceipt({ kind: 'runtime', sessionId: 'ocr-12345678', status: { status: 200, state: 'implemented' } }), /Tests: not recorded/);
});

test('when GitHub cannot be read, the reply says so and claims no run or result', () => {
  const text = codingHistoryReceipt({ kind: 'runtime', sessionId: 'ocr-12345678', status: { status: 502, detail: 'network' } });
  assert.match(text, /HTTP 502/);
  assert.match(text, /UNVERIFIED/);
  assert.doesNotMatch(text, /actions\/runs/);
  assert.match(codingHistoryReceipt({ kind: 'runtime', sessionId: 'ocr-12345678', status: null }), /GitHub did not answer/);
});

test('a running built-in job with no runtime record is reported as that job, not as nothing', () => {
  const text = codingHistoryReceipt({ kind: 'job', job: { id: 'job-abcdef123456', status: 'running', checkpoint: { step: 2 } } });
  assert.match(text, /built-in job job-abcdef12/);
  assert.match(text, /State: running\./);
  assert.match(text, /recovery checkpoint is saved/);
  assert.doesNotMatch(text, /No coding run is recorded/);
});

test('no coding run recorded is said plainly, not invented', () => {
  assert.equal(codingHistoryReceipt({ kind: 'none' }), 'No coding run is recorded for CHE yet, sir. Nothing is running.');
  assert.equal(codingHistoryReceipt({ kind: 'runtime', sessionId: '', status: null }), 'No coding run is recorded for CHE yet, sir. Nothing is running.');
});

test('an unverified liveness is shown as unverified, never as a confirmed state', () => {
  const text = codingHistoryReceipt({ kind: 'runtime', sessionId: 'ocr-12345678', status: { status: 200, state: 'queued', liveness: 'unverified' } });
  assert.match(text, /Live state: UNVERIFIED/);
});
