import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codingHistoryIntent, currentTurnActionPolicy, repositoryInspectionIntent } from './code_scout.js';
import { codingHistoryReceipt } from './coding_history.js';

// Read-only execution-history questions. Each one must be answered from the stored
// runtime record, must never start a coding job, and must never be routed to a
// repository inspection (the 17 Oct 2026 EXPLORE failure returned file names).
const HISTORY = [
  'Inspect her latest coding execution history.',
  'chay, what is the latest coding execution history',
  'How far did Claude get?',
  'Why did that coding job fail?',
  'What happened to the last coding job?',
  'Show me the actual result of the coding run.',
  'What files did the coding job change?',
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
    sessionId: 'ocr-6550098c',
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

test('a record without a run, models or a change count names each missing field', () => {
  const text = codingHistoryReceipt({ sessionId: 'ocr-12345678', status: { status: 200, state: 'queued' } });
  assert.match(text, /GitHub run: not recorded\./);
  assert.match(text, /Models tried: not recorded\./);
  assert.match(text, /Files changed: not recorded\./);
});

test('a created pull request is named by number', () => {
  const text = codingHistoryReceipt({ sessionId: 'ocr-12345678', status: { status: 200, state: 'implemented', changed_files: 2, pr_number: 331 } });
  assert.match(text, /Pull request: #331\./);
  assert.match(text, /Files changed: 2\./);
});

test('when GitHub cannot be read, the reply says so and claims no run or result', () => {
  const text = codingHistoryReceipt({ sessionId: 'ocr-12345678', status: { status: 502, detail: 'network' } });
  assert.match(text, /HTTP 502/);
  assert.match(text, /UNVERIFIED/);
  assert.doesNotMatch(text, /actions\/runs/);
});

test('no coding run recorded is said plainly, not invented', () => {
  assert.equal(codingHistoryReceipt({ sessionId: '', status: null }), 'No coding run is recorded for CHE yet, sir. Nothing is running.');
});

test('an unverified liveness is shown as unverified, never as a confirmed state', () => {
  const text = codingHistoryReceipt({ sessionId: 'ocr-12345678', status: { status: 200, state: 'queued', liveness: 'unverified' } });
  assert.match(text, /Live state: UNVERIFIED/);
});
