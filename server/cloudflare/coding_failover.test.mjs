import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyModelFailure, resumeDecision, unsafeCodingPaths, progressPrompt, RESUME_LIMIT, RESUME_BACKOFF_MS } from './coding_failover.mjs';

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
