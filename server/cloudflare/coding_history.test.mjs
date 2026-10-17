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
  'Check your recent coding runs on GitHub Actions and tell me the run IDs, results, model errors, file changes and PRs.',
  'Look at your recent coding executions and tell me what happened.',
  'Show me the GitHub Actions runs for your coding jobs.',
  'Show me the files the coding job changed.',
  "Explain the coding job's status.",
  "Explain the coding job's history.",
  'Inspect that coding job.',
  'Did the coding job fail?',
  'Why did the coding run stop?',
  // Third review: the old "coding status" phrases, and owner wordings it found missed.
  'coding status',
  'coding status?',
  'What is the status of the coding job?',
  "How's the coding job going?",
  'What happened to my coding job?',
  'check the coding logs',
  'whats the status on ur coding job',
  "Did the coding job open a pull request? What's its status?",
  'Is the coding job still running?',
  'Tell me how far the coding job got',
  "Shay, why'd the coding job fail?",
  'chay how did the coding job go',
  'Which files did you change in the coding job? Don\'t touch anything.',
  'Check the status of the workflow run for the coding job.',
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
  'Review the GitHub Actions workflow for the coding runtime.',
  'Retry the last coding job.',
  // Second review: investigations, change instructions and other kinds of job keep their routes.
  'Investigate npm semver 7.7.2 and tell me the coding job history.',
  'Investigate "https://github.com/example/app" and tell me the coding job history.',
  'Study the reference repo and compare its coding job history with yours.',
  'Inspect the code for the coding job history bug.',
  'Build a dashboard of the coding job history.',
  'Please improve the coding job history view.',
  "Fix the coding job's history and tell me the latest coding run.",
  "What's the status of the YouTube upload job?",
  'Stop.',
  // Third review: Command Center exploration and questions about the code, a library or a course.
  '/che-explore the coding job status',
  '/che-explore how coding history is answered',
  'Inspect your codebase and explain how the coding job status works, with file paths. Read-only, change nothing.',
  'CHE, investigate why coding jobs produce delayed responses. This is READ-ONLY. Do not start a coding job, create a PR, modify files, or merge anything.',
  'Explain how the coding status route works.',
  'Which file handles the coding status?',
  'Where is the coding status code?',
  "What's causing the coding status bug?",
  'Which coding files have tests?',
  'What files did you add to the Coding Library?',
  'How is my coding progress in the Python course?',
  'Show me the code that reports coding status.',
  'How far is it to get to Phoenix?',
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
  assert.match(text, /State: opencode failed\./, 'the stored "blocked" lifecycle is named the way runtimeState normalizes it');
  assert.match(text, /The OpenCode attempt failed with no files changed yet after trying 2 models/);
  assert.match(text, /Failure: opencode_failed - quota exhausted\./);
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

test('when the record cannot be read, the reply gives the real reason and claims no run or result', () => {
  const text = codingHistoryReceipt({ kind: 'runtime', sessionId: 'ocr-12345678', status: { status: 502, detail: 'Could not read OpenCode runtime status (network).' } });
  assert.match(text, /I could not read its record: Could not read OpenCode runtime status \(network\)\./);
  assert.match(text, /UNVERIFIED/);
  assert.doesNotMatch(text, /actions\/runs/);
  assert.doesNotMatch(text, /GitHub answered/, 'a malformed id or record is not a GitHub answer');
  assert.match(codingHistoryReceipt({ kind: 'runtime', sessionId: 'ocr-12345678', status: { status: 503 } }), /I could not read its record \(HTTP 503\)/);
  assert.match(codingHistoryReceipt({ kind: 'runtime', sessionId: 'ocr-12345678', status: null }), /I could not read its record\. Its state, run and result are UNVERIFIED\./);
});

test('a running built-in job with no runtime record is reported as that job, not as nothing', () => {
  const text = codingHistoryReceipt({ kind: 'job', job: { id: 'job-abcdef123456', status: 'running', checkpoint: { step: 2 } } });
  assert.match(text, /^The latest coding job is running, sir\. Its recovery checkpoint is saved\./);
  assert.match(text, /Built-in job: job-abcdef12\./);
  assert.doesNotMatch(text, /No coding job has started/);
});

test('a running built-in job that stopped reporting progress is not reported as running', () => {
  const text = codingHistoryReceipt({ kind: 'job', stale: true, job: { id: 'job-abcdef123456', status: 'running' } });
  assert.match(text, /stopped reporting progress and is not confirmed running, sir\. It saved no checkpoint/);
  assert.doesNotMatch(text, /is running, sir/);
});

test('a queued built-in job with retries is retrying automatically, as "coding status" always said', () => {
  const text = codingHistoryReceipt({ kind: 'job', job: { id: 'job-abcdef123456', status: 'queued', retry_count: 2 } });
  assert.match(text, /^The latest coding job is retrying automatically, sir\./);
});

test('a finished built-in job reads back its own result and error, and never denies a pull request or test result it holds', () => {
  const done = codingHistoryReceipt({ kind: 'job', job: { id: 'job-done00000000', status: 'complete', request: 'Fix the failover', result: 'My team built it. I opened pull request #412. CI is running' } });
  assert.match(done, /The latest coding job status is complete, sir\./);
  assert.match(done, /Request: Fix the failover\./);
  assert.match(done, /Result: My team built it\. I opened pull request #412\. CI is running\./);
  assert.doesNotMatch(done, /no (?:GitHub run, models tried, files changed, )?pull request|test results/i);
  const failed = codingHistoryReceipt({ kind: 'job', job: { id: 'job-fail00000000', status: 'failed', error: 'Tests failed: 3 failing' } });
  assert.match(failed, /The latest coding job status is failed, sir\./);
  assert.match(failed, /Error: Tests failed: 3 failing\./);
});

test('a newer run whose record cannot be read is named beside the active built-in job', () => {
  const text = codingHistoryReceipt({ kind: 'job', job: { id: 'job-abcdef123456', status: 'running' }, unreadRun: { sessionId: 'ocr-12345678', status: { status: 502, detail: 'OpenCode runtime result is not valid compact JSON.' } } });
  assert.match(text, /The latest coding job is running, sir\./);
  assert.match(text, /A newer coding run, ocr-12345678, exists, but I could not read its record: OpenCode runtime result is not valid compact JSON\.; its state is UNVERIFIED\./);
});

test('a pending resume is spoken with its time and attempt, and the failure that caused it stays visible', () => {
  const text = codingHistoryReceipt({ kind: 'runtime', sessionId: 'ocr-6550098c', status: { status: 200, state: 'waiting_capacity', failure: 'opencode_failed', error: 'quota exhausted', failure_kind: 'quota', resume_at: '2026-10-17T20:51:00Z', resume_attempt: 1, resume_limit: 3 } });
  assert.match(text, /State: waiting capacity\./);
  assert.match(text, /will resume it from that checkpoint at 20:51 UTC, attempt 1 of 3/);
  assert.match(text, /Last failure: opencode_failed - quota exhausted\./);
});

test('a run GitHub confirms is still live is not called unverified', () => {
  const text = codingHistoryReceipt({ kind: 'runtime', sessionId: 'ocr-12345678', status: { status: 200, state: 'running', heartbeat: 'stale', run_id: 5 } });
  assert.match(text, /GitHub shows the run is still live, but it has not reported progress recently\./);
  assert.doesNotMatch(text, /UNVERIFIED/);
});

test('no coding run recorded is said plainly, not invented', () => {
  assert.equal(codingHistoryReceipt({ kind: 'none' }), 'No coding job has started yet, sir. Nothing is running.');
  assert.equal(codingHistoryReceipt({ kind: 'runtime', sessionId: '', status: null }), 'No coding job has started yet, sir. Nothing is running.');
});

test('an unverified liveness is shown as unverified, never as a confirmed state', () => {
  const text = codingHistoryReceipt({ kind: 'runtime', sessionId: 'ocr-12345678', status: { status: 200, state: 'running', heartbeat: 'stale', liveness: 'unverified', run_id: 5 } });
  assert.match(text, /State: UNVERIFIED, last recorded as running\./);
  assert.match(text, /could not confirm with GitHub whether it is still running/);
  assert.doesNotMatch(text, /State: running|currently running|GitHub shows the run is still live/);
});
