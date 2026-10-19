import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attemptReceipt, classifyModelFailure, resumeDecision, resumeAction, newMissionAction, unsafeCodingPaths, progressPrompt, RESUME_LIMIT, RESUME_BACKOFF_MS } from './coding_failover.mjs';

test('quota, rate limit and timeout are capacity failures that may resume; access and size are not', () => {
  assert.deepEqual(
    classifyModelFailure({ text: 'You exceeded your current quota, please check your plan' }).resumable, true);
  assert.equal(classifyModelFailure({ text: '{"statusCode": 429, "message": "Too Many Requests"}' }).kind, 'rate_limit');
  assert.equal(classifyModelFailure({ text: 'rate limit reached', exitCode: 1 }).resumable, true);
  assert.equal(classifyModelFailure({ text: 'something', exitCode: 124 }).kind, 'timeout');
  assert.equal(classifyModelFailure({ text: 'timed out after 300s' }).resumable, true);
  assert.equal(classifyModelFailure({ text: 'model does not exist or you do not have access' }).kind, 'access');
  assert.equal(classifyModelFailure({ text: 'statusCode": 403' }).resumable, false);
  assert.equal(classifyModelFailure({ text: 'ContextOverflowError: prompt is too long' }).kind, 'too_large');
  assert.equal(classifyModelFailure({ text: 'ContextOverflowError' }).resumable, false, 'a too-large request cannot succeed by waiting');
});

test('a Groq request-too-large error is too_large even though it names tokens per minute', () => {
  const groq = 'Request too large for model `llama` on tokens per minute (TPM): Limit 7000, Requested 10182';
  const result = classifyModelFailure({ text: groq });
  assert.equal(result.kind, 'too_large');
  assert.equal(result.resumable, false);
});

test('an unknown failure is neither retried in place nor resumed', () => {
  assert.deepEqual(classifyModelFailure({ text: 'weird', exitCode: 1 }), { kind: 'unknown', resumable: false, words: '' });
});

test('resumes are bounded: backoff grows, then the job is handed to CHE\'s own team', () => {
  const now = Date.parse('2026-10-17T12:00:00Z');
  const first = resumeDecision({ resumable: true, resumeCount: 0, now });
  assert.equal(first.resume, true);
  assert.equal(first.attempt, 1);
  assert.equal(first.at, new Date(now + RESUME_BACKOFF_MS[0]).toISOString());
  const last = resumeDecision({ resumable: true, resumeCount: RESUME_LIMIT - 1, now });
  assert.equal(last.resume, true);
  assert.equal(last.at, new Date(now + RESUME_BACKOFF_MS[RESUME_LIMIT - 1]).toISOString());
  const spent = resumeDecision({ resumable: true, resumeCount: RESUME_LIMIT, now });
  assert.deepEqual(spent, { resume: false, reason: 'limit_reached' });
  assert.deepEqual(resumeDecision({ resumable: false, resumeCount: 0, now }), { resume: false, reason: 'not_capacity' });
});

test('backoff is strictly increasing so retries never spin', () => {
  for (let i = 1; i < RESUME_BACKOFF_MS.length; i += 1) assert.ok(RESUME_BACKOFF_MS[i] > RESUME_BACKOFF_MS[i - 1]);
  assert.equal(RESUME_BACKOFF_MS.length, RESUME_LIMIT);
});

test('unsafe paths match the final patch rules: workflows, git, secrets, signing, platform config', () => {
  const bad = ['.github/workflows/x.yml', '.git/config', 'config/.env', 'lib/secrets.dart', 'ios/Runner/Info.plist',
    'android/app/build.gradle', 'pubspec.yaml', 'server/cloudflare/wrangler.jsonc', 'certs/app.p12'];
  assert.deepEqual(unsafeCodingPaths(bad), bad);
  assert.deepEqual(unsafeCodingPaths(['server/cloudflare/agent_runtime.js', 'lib/main.dart', 'test/a_test.dart']), []);
});

test('the next model is told what is verified, so it continues instead of rereading or redoing', () => {
  const prompt = progressPrompt({
    basePrompt: 'Add a retry to the runner.',
    files: ['server/cloudflare/agent_runtime.js', 'tools/x.mjs'],
    additions: 12,
    deletions: 3,
    attempt: 2,
  });
  assert.match(prompt, /^Add a retry to the runner\./);
  assert.match(prompt, /VERIFIED PROGRESS \(attempt 2; do not redo or revert it\)/);
  assert.match(prompt, /server\/cloudflare\/agent_runtime\.js, tools\/x\.mjs \(\+12\/-3\)/);
  assert.match(progressPrompt({ basePrompt: 'x', files: [] }), /No files are changed yet/);
});

test('the coding tools and the gate are unsafe paths: an attempt can never change the code that judges it', () => {
  const tools = ['tools/che_coding_paid_gate.mjs', 'tools/che_coding_checkpoint.mjs', 'server/cloudflare/coding_failover.mjs', '.opencode/config.json'];
  assert.deepEqual(unsafeCodingPaths(tools), tools);
  assert.deepEqual(unsafeCodingPaths(['server/cloudflare/coding_runtime.js', 'tools/che_video_render.py']), []);
});

test('a pending resume waits for its backoff, dispatches once, then waits for a claim, is claimed, or is given up only with no live run', () => {
  const now = Date.parse('2026-10-17T12:00:00Z');
  const pending = { next_at: new Date(now + 60_000).toISOString(), resume_count: 1 };
  assert.equal(resumeAction({ pending, now }), 'wait_backoff');
  assert.equal(resumeAction({ pending: { ...pending, next_at: new Date(now - 1).toISOString() }, now }), 'dispatch');
  const dispatched = { ...pending, dispatched_at: new Date(now - 60_000).toISOString() };
  assert.equal(resumeAction({ pending: dispatched, status: { resume_count: 2 }, runAlive: 'dead', now }), 'claimed');
  assert.equal(resumeAction({ pending: dispatched, status: { resume_count: 2 }, now }), 'claimed', 'a claim counts whether or not the run is listed');
  assert.equal(resumeAction({ pending: dispatched, status: { resume_count: 2 }, runAlive: 'dead', now }), 'claimed');
  assert.equal(resumeAction({ pending: dispatched, status: { resume_count: 0 }, runAlive: 'alive', now }), 'wait_claim');
  assert.equal(resumeAction({ pending: dispatched, status: { resume_count: 0 }, runAlive: 'unknown', now }), 'wait_claim', 'an unknown run is never treated as dead');
  assert.equal(resumeAction({ pending: dispatched, status: { resume_count: 0 }, runAlive: 'dead', now }), 'give_up');
});

test('a new owner mission starts unless a dispatched resume may still be running', () => {
  assert.equal(newMissionAction({ pending: null }), 'start');
  assert.equal(newMissionAction({ pending: { dispatched_at: '' }, runAlive: 'alive' }), 'abandon', 'a resume still waiting for its backoff has no runner');
  assert.equal(newMissionAction({ pending: { dispatched_at: 'x' }, runAlive: 'alive' }), 'refuse');
  assert.equal(newMissionAction({ pending: { dispatched_at: 'x' }, runAlive: 'unknown' }), 'refuse');
  assert.equal(newMissionAction({ pending: { dispatched_at: 'x' }, runAlive: 'dead' }), 'abandon');
});

test('each model attempt keeps its own receipt: kind, resumability, time against its cap, and what happened to its edits', () => {
  const quota = attemptReceipt({ model: 'google/gemini-2.5-pro', exitCode: 75, text: 'You exceeded your current quota', seconds: 3, capSeconds: 120, progress: 'none' });
  assert.deepEqual(quota, {
    model: 'google/gemini-2.5-pro', exit_code: 75, kind: 'quota', resumable: true,
    seconds: 3, cap_seconds: 120, progress: 'none', error: 'You exceeded your current quota',
  });
  const tooLarge = attemptReceipt({ model: 'groq/qwen/qwen3.8-27b', exitCode: 1, text: 'ContextOverflowError: Request too large for model', seconds: 9, capSeconds: 120, progress: 'reverted' });
  assert.equal(tooLarge.kind, 'too_large');
  assert.equal(tooLarge.resumable, false, 'a too-large request cannot succeed by waiting');
  assert.equal(tooLarge.progress, 'reverted');
  const timedOut = attemptReceipt({ model: 'openrouter/qwen/qwen3.8-27b:free', exitCode: 124, text: '', seconds: 120, capSeconds: 120, progress: 'none' });
  assert.equal(timedOut.kind, 'timeout');
  assert.equal(timedOut.resumable, true);
  assert.equal(timedOut.error, '', 'an empty error stays empty, never invented');
  const delivered = attemptReceipt({ model: 'groq/qwen/qwen3.8-27b', exitCode: 0, text: 'ignored text', seconds: 42, capSeconds: 120, progress: 'delivered' });
  assert.equal(delivered.kind, 'success');
  assert.equal(delivered.resumable, false);
  assert.equal(delivered.error, '', 'a successful attempt carries no error text');
});

test('a receipt never carries a provider key, is one line, and is bounded in size', () => {
  const secret = 'gsk_abcdefghijklmnop1234 and sk-or-abcdefghijklmnopqrstu and AIzaSyD-abcdefghijklmnopqrstuvwx';
  const receipt = attemptReceipt({ model: 'groq/x', exitCode: 1, text: `{\n"message": "invalid ${secret}"\n}${'x'.repeat(900)}`, seconds: 1, capSeconds: 120 });
  assert.doesNotMatch(receipt.error, /gsk_|sk-or-|AIza/, 'keys are redacted before a receipt is stored');
  assert.match(receipt.error, /\[key\]/);
  assert.doesNotMatch(receipt.error, /\n/, 'one line only, so the step output and record stay readable');
  assert.ok(receipt.error.length <= 300, 'the excerpt is bounded');
});
