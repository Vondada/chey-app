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
  // Fourth review: wordings missed on main too.
  'Chay, coding status',
  'any updates on the coding job',
  'how far along is the coding job',
  'Do not start anything. Why did the coding job stop?',
  "Don't change anything, just tell me the status of the last coding run.",
  'Did the coding job fix the bug?',
  'Why did the coding job fail to merge the PR?',
  // Fifth review: the question may carry time words, the record, or a plain read request.
  'Why did the coding job fail last night?',
  'Latest coding execution history?',
  'Did the coding run pass its tests?',
  'What files did the coding job change? Tell me the paths.',
  // Sixth review: a separate sentence about the same record still belongs to the question.
  'Why did the coding job fail? Tell me.',
  'Why did the coding job fail? Show me the error.',
  "Did the coding job open a pull request? What's its status?",
  'What happened to my coding job? Did it pass?',
  'Why did the coding job fail? What happened with it?',
  "What's the latest coding run? Which model did it use?",
  'Tell me: what happened to the coding job?',
  'What is the latest coding run? Show me the run link and the files.',
  'Why did the coding job fail? Show me the error details.',
  'What happened to my coding job? Did it pass the tests?',
  'What files did the coding job change? Tell me the paths.',
  // Seventh review: the same record asked about in other words, and prohibitions as asides.
  'hows the coding job',
  'how is the coding job doing',
  'whats going on with the coding job',
  'did the coding job crash',
  'did the coding job time out',
  'which model did the coding job use',
  'what model did the coding job run on',
  'how long did the coding job take',
  'when did the coding job start',
  'is the coding job retrying',
  'did the coding job pass or fail',
  'how did my last coding job go',
  'status of the coding job',
  'whats the latest on the coding job',
  'coding job state',
  'Did the coding job open a pull request?',
  "Don't change anything. What happened to the coding job?",
  "coding status. don't touch anything",
  'What happened to the coding job the other day?',
  // Eighth review: prohibitions that cover their whole clause stay asides.
  'Do not start a coding job. What is the latest coding execution history?',
  'coding status. do not under any circumstances retry',
  'is the coding job still retrying',
  'did the coding job crash or time out',
  'when did the coding job start running',
  'how long did the coding job take in total',
  'did the coding job pass or fail in the end',
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
  // Fourth review: turns other routes own (email, memory, handoff, deployment, inspection) ...
  'Email me the latest coding run status',
  'Email Claude the latest coding run status',
  'Remember that the last coding job failed because of quota',
  "Continue Claude's task on the latest coding run",
  "Pick up Codex's handoff for the last coding job",
  'Is the last coding job deployed?',
  'Is the latest coding run live in production?',
  'Did the last coding job get deployed?',
  'How does the coding job report its status?',
  'How does CHE decide the coding job status?',
  'What function computes the coding job status?',
  'Explain the code path for coding job status.',
  'Read coding_history.js and explain the coding job status receipt.',
  // ... actions, which a status receipt would seem to confirm ...
  'Revert the last coding job.',
  'Roll back the latest coding run.',
  'Deploy the last coding job.',
  'merge the latest coding run',
  'Close the pull request from the last coding job.',
  'Abort the current coding job.',
  'Kill the current coding job.',
  'Pause the current coding job.',
  'can u fix the last coding job',
  'Latest coding run failed: fix the failover tests.',
  'che why did the coding job fail retry it',
  'Summarize the latest coding run and email it to me',
  'Text my wife the latest coding run status',
  'Remind me tomorrow to check the latest coding run',
  // ... other jobs, other subjects, and coding jobs in general.
  'How far did it get with the YouTube upload?',
  'How far did che get on my essay?',
  'Find the latest coding jobs near me.',
  'What time was my last coding session on my calendar?',
  'How much did the last coding run cost?',
  'What states can a coding job be in?',
  'Why do coding jobs fail so often? Look at the code.',
  "Just answer from memory, don't check anything: why did the coding job fail?",
  // A second request with no punctuation, and records other routes keep.
  'whats the latest coding run fix whatever failed',
  'Show me my recent coding sessions in the course',
  'How many tokens did the latest coding run use?',
  "What's the status of the coding task in my objectives?",
  'Did the iPhone build from the latest coding run finish?',
  "What's the status of my coding job application?",
  // Fifth review: a second request after the question, punctuated or spoken without punctuation ...
  'Why did the last coding job fail? Recover it.',
  'Why did the coding job fail? Debug it.',
  'Why did the coding job stop? Kick it off again.',
  'What files did the coding job change? Put them back.',
  'Is the coding job still running? Switch it to Claude.',
  'Why did the coding job fail? Learn from it.',
  'why did the coding job fail cancel it',
  'why did the coding job fail rerun the tests',
  'why did the coding job fail tell claude',
  'did the coding job pass approve it',
  'did the coding job finish open a PR',
  'what files did the coding job change roll them back',
  'what happened to the coding job resume',
  'how far did claude get finish it',
  'che how far did claude get pick up where he left off',
  'how far did claude get do claude\'s handoff',
  'what is the status of the coding job terminate it',
  // ... messages to or about another AI ...
  'Can you tell Claude the latest coding run failed?',
  'hey che tell claude the latest coding run failed',
  'Did Claude reply about the last coding run?',
  'What did Claude say about the last coding job?',
  'Has Codex answered about the latest coding run?',
  // ... and statements that ask for a change.
  'the latest coding run status needs to be fixed',
  'the coding job status should be shorter',
  'the coding job status should say the PR number',
  'your coding history needs improving',
  'latest coding run status is too long',
  // Sixth review: a second sentence that starts with a read verb or asks about something else is
  // another request; the turn goes to its own route instead of a receipt that drops it.
  'Why did the coding job fail? Give it another go.',
  'Why did the coding job fail? Have another go.',
  'Why did the coding job fail? How about another try?',
  'Why did the coding job fail? What about trying again?',
  'why did the coding job fail and give it another go',
  'Did the coding job pass? Give it the green light.',
  'Did the coding job pass? Check it in.',
  'Why did the coding job fail? Show me a fix and apply it.',
  'Why did the coding job fail? Tell me, then get it working.',
  'Which files did the coding job change? Give them back the old code.',
  'How far did Claude get? Give it to Codex.',
  'How far did Claude get? Tell me and hand off to Codex.',
  "What's the coding status? Show it to Claude.",
  "What's the coding status? Tell me and Claude.",
  'Why did the coding job fail? Explain it to Codex.',
  'Did the coding job pass? Tell Mom.',
  'whats the coding status and tell mom',
  "What's the coding status? Give me a reminder in an hour.",
  'Why did the coding job fail? Look into it.',
  'Why did the coding job fail? Do what you suggested.',
  'What is the latest coding run? How are my trades doing?',
  'coding status and how are the trades doing',
  'coding status. how are my trades?',
  "What's the coding status? How did the backtest go?",
  "What's the coding status? And what's the weather?",
  "What's the coding status? Also what time is it?",
  // A bare "show me" or "tell me" is a follow-up only when nothing but the record's fields follows.
  'coding status? show me my letters',
  "What's the coding status? Show me my paper trades.",
  "What's the coding status? Show me your avatar.",
  "What's the coding status? Show me your installed skills.",
  "What's the coding status? Show me the trading lab.",
  'whats the coding status and tell me when its done',
  'Why did the coding job fail? Show me the failing test file.',
  // Seventh review: "don't forget to…" and "never do that again" ask for something; only a
  // prohibition on CHE's own actions ("don't change anything") is an aside.
  "coding status. Don't forget to remind me about the dentist.",
  "Coding status. Don't forget to remind me to call the bank at 3.",
  "Don't forget to pick up milk; coding status?",
  "don't forget to call mom, what's the coding status",
  'coding status. don\'t forget to book the dentist',
  "What's the coding status? Don't forget my 3pm meeting.",
  "Why did the coding job fail? Don't let it happen again.",
  'Why did the coding job fail? Never do that again.',
  // A noun phrase after the question is another subject, not filler.
  'coding status my trades',
  'coding status then my trades',
  'whats the coding status my trades',
  'coding status the weather',
  'coding status the time',
  'coding status your reliability',
  'what happened to the coding job my trades',
  'coding status and tell dad the coding job failed',
  // Eighth review: a request riding in a prohibition clause is still a request, and "my tasks"
  // or "my jobs" are the owner's own items, not the coding record.
  "coding status. don't retry but do tell mom",
  "coding status. don't rerun remind me about the dentist",
  "coding status. don't retry how are my trades",
  "coding status. don't retry what's the weather",
  "coding status. don't retry stop all jobs",
  "coding status. don't retry pause autonomy",
  "coding status. don't retry remember im on vacation next week",
  'coding status. no need to rerun i fixed it so note it down',
  "did the coding job pass. don't merge but do open an issue",
  "coding status. don't rerun hand it to claude",
  "coding status. don't make me ask again message me when its done",
  "coding status. don't start another job but keep me posted",
  "coding status. don't retry buy the dip",
  'never retry tell dad. coding status',
  "don't do anything else tell mom i love her. whats the coding status",
  "coding status. don't stop until it passes",
  "coding status. what's the status of my tasks",
  'coding status and tell me the status of my tasks',
  'coding status and tell me everything about my tasks',
  'what happened to the coding job? status of my jobs',
  'why is the coding app stuck',
  'why did the coding stream stop',
  'why did my coding test fail',
  'coding status to post',
  'coding status to forward',
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
  assert.match(text, /I could not read its record: Could not read OpenCode runtime status \(network\)\. Its state/);
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
  assert.match(text, /A newer coding run, ocr-12345678, exists, but I could not read its record: OpenCode runtime result is not valid compact JSON; its state is UNVERIFIED\./);
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
  // Other kinds of job may be running, so the reply says nothing about them (fourth review).
  assert.equal(codingHistoryReceipt({ kind: 'none' }), 'No coding job has started yet, sir.');
  assert.equal(codingHistoryReceipt({ kind: 'runtime', sessionId: '', status: null }), 'No coding job has started yet, sir.');
});

test('odd record fields never reach the spoken state sentence', () => {
  const run = codingHistoryReceipt({ kind: 'runtime', sessionId: 'ocr-12345678', status: { status: 200, state: 'blocked', failure: 'opencode_failed', error: 'x', models_tried: [{ id: 'm' }, 'gemini'], changed_files: 1, additions: 'lots', deletions: null } });
  assert.doesNotMatch(run, /\[object Object\]|NaN/);
  assert.match(run, /failed with 1 file changed after trying 1 model \(gemini\)/, 'no line counts the record does not hold');
  const odd = codingHistoryReceipt({ kind: 'runtime', sessionId: 'ocr-12345678', status: { status: 200, state: 'review_rejected', failure: { code: 1 }, error: 'x', review: { notes: 'y' } } });
  assert.doesNotMatch(odd, /\[object Object\]/);
  assert.match(odd, /Failure: x\./);
  assert.match(odd, /my reviewer rejected it\. I did not merge\./);
});

test('an older job still active is named beside the newest job, not hidden behind it or in front of it', () => {
  const text = codingHistoryReceipt({ kind: 'job', job: { id: 'job-newfail00001', status: 'failed', error: 'Tests failed: 3 failing' }, olderActive: { id: 'job-oldqueue0001', status: 'queued', retry_count: 2 } });
  assert.match(text, /^The latest coding job status is failed, sir\./);
  assert.match(text, /An older coding job, job-oldqueue, is still retrying\./);
});

test('odd record contents are never spoken as made-up values', () => {
  const job = codingHistoryReceipt({ kind: 'job', job: { id: 'job-odd000000001', result: { pr: 1 }, error: ['x'] } });
  assert.match(job, /^The latest coding job status is unknown, sir\./, 'a job with no status is not called queued');
  assert.doesNotMatch(job, /\[object Object\]|Result:|Error:/);
  const run = codingHistoryReceipt({ kind: 'runtime', sessionId: 'ocr-12345678', status: { status: 200, state: 'tests_failed', pr_number: '412', changed_files: '3', models_tried: [{ id: 'm' }, 'groq/qwen3'], model: { id: 'm' } } });
  assert.match(run, /Tests failed on pull request 412/);
  assert.match(run, /Pull request: #412\./);
  assert.match(run, /Files changed: 3\./);
  assert.match(run, /Models tried: groq\/qwen3, plus 1 entry I could not read\./);
  assert.doesNotMatch(run, /\[object Object\]/);
});

test('an unverified liveness is shown as unverified, never as a confirmed state', () => {
  const text = codingHistoryReceipt({ kind: 'runtime', sessionId: 'ocr-12345678', status: { status: 200, state: 'running', heartbeat: 'stale', liveness: 'unverified', run_id: 5 } });
  assert.match(text, /State: UNVERIFIED, last recorded as running\./);
  assert.match(text, /could not confirm with GitHub whether it is still running/);
  assert.doesNotMatch(text, /State: running|currently running|GitHub shows the run is still live/);
});
