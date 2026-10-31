// Refusal-aware fallback policy: each failure is named, a legitimate request may move to another engine, a hard-stop
// request never does, side effects are not repeated, and every request has a bounded number of attempts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { FAILURES, MAX_ENGINE_ATTEMPTS, classifyFailure, decideFallback, fallbackRecord } from './refusal_fallback.js';

test('a provider content refusal is a refusal, not a technical error', () => {
  assert.equal(classifyFailure({ answer: { refused: true, response: 'I can\'t help with that.' } }), FAILURES.REFUSAL);
  assert.equal(classifyFailure({ error: new Error('upstream closed') }), FAILURES.TECHNICAL);
});

test('each failure kind is named from the error or the answer', () => {
  assert.equal(classifyFailure({ error: { quota: true } }), FAILURES.QUOTA);
  assert.equal(classifyFailure({ error: { status: 401 } }), FAILURES.PERMISSION);
  assert.equal(classifyFailure({ error: { status: 403 } }), FAILURES.PERMISSION);
  assert.equal(classifyFailure({ error: { capability: true } }), FAILURES.CAPABILITY);
  assert.equal(classifyFailure({ error: { name: 'AbortError' } }), FAILURES.TIMEOUT);
  assert.equal(classifyFailure({ error: { status: 504 } }), FAILURES.TIMEOUT);
  assert.equal(classifyFailure({}), FAILURES.NONE);
});

test('a legitimate ordinary request moves to the next compatible engine after a technical failure', () => {
  const d = decideFallback({ requestClass: 'ordinary', failure: FAILURES.TECHNICAL, attemptsMade: 1 });
  assert.equal(d.next, true);
});

test('an ordinary request may move past a plain refusal in conversation', () => {
  assert.equal(decideFallback({ requestClass: 'ordinary', failure: FAILURES.REFUSAL, attemptsMade: 1 }).next, true);
});

test('adult fiction may move to an engine authorised for it, and nothing else changes', () => {
  const d = decideFallback({ requestClass: 'adult_fiction', failure: FAILURES.REFUSAL, attemptsMade: 1 });
  assert.equal(d.next, true);
  assert.match(d.reason, /authorised for it/);
});

test('a hard-stop request never moves to another engine, whatever failed', () => {
  for (const failure of [FAILURES.REFUSAL, FAILURES.TECHNICAL, FAILURES.TIMEOUT, FAILURES.CAPABILITY]) {
    const d = decideFallback({ requestClass: 'hard_stop', failure, attemptsMade: 1 });
    assert.equal(d.next, false, failure);
    assert.match(d.reason, /safety rule/);
  }
});

test('an unknown or missing request class fails closed as hard stop', () => {
  assert.equal(decideFallback({ requestClass: 'whatever', failure: FAILURES.TECHNICAL }).next, false);
  assert.equal(decideFallback({ failure: FAILURES.TECHNICAL }).next, false);
});

test('a refused action with a side effect is not retried elsewhere', () => {
  const d = decideFallback({ requestClass: 'ordinary', failure: FAILURES.REFUSAL, sideEffect: true, attemptsMade: 1 });
  assert.equal(d.next, false);
  assert.match(d.reason, /the owner decides/);
});

test('a billable or external action that already ran is never repeated', () => {
  const d = decideFallback({ requestClass: 'ordinary', failure: FAILURES.TIMEOUT, sideEffect: true, jobAlreadyRan: true, attemptsMade: 1 });
  assert.equal(d.next, false);
  assert.match(d.reason, /not repeated/);
});

test('retries are bounded: the attempt limit stops the loop', () => {
  assert.equal(MAX_ENGINE_ATTEMPTS, 3);
  assert.equal(decideFallback({ requestClass: 'ordinary', failure: FAILURES.TECHNICAL, attemptsMade: 2 }).next, true);
  const stop = decideFallback({ requestClass: 'ordinary', failure: FAILURES.TECHNICAL, attemptsMade: 3 });
  assert.equal(stop.next, false);
  assert.match(stop.reason, /limit of 3/);
});

test('quota and permission stop every fallback, even for ordinary requests', () => {
  assert.equal(decideFallback({ requestClass: 'ordinary', failure: FAILURES.QUOTA }).next, false);
  assert.equal(decideFallback({ requestClass: 'ordinary', failure: FAILURES.PERMISSION }).next, false);
});

test('the Details record lists the original, the attempts, the final engine and the costs, and invents nothing', () => {
  const record = fallbackRecord({
    original: 'engine-a',
    attempts: [
      { model: 'engine-a', failure: FAILURES.TIMEOUT, reason: 'timeout' },
      { model: 'engine-b', failure: FAILURES.NONE, reason: 'the attempt succeeded' },
    ],
    final: 'engine-b',
    tools: [{ name: 'office.open', receipt: 'rcpt-1' }],
    costs: [{ engine: 'engine-b', usd: 0 }],
  });
  assert.equal(record.original_model, 'engine-a');
  assert.equal(record.final_model, 'engine-b');
  assert.equal(record.fallback_used, true);
  assert.equal(record.completed, true);
  assert.equal(record.attempts.length, 2);
  assert.equal(record.tools_executed[0].receipt, 'rcpt-1');
});

test('when no engine completes the request, the record says so and never names a final engine', () => {
  const record = fallbackRecord({ original: 'engine-a', attempts: [{ model: 'engine-a', failure: FAILURES.REFUSAL }] });
  assert.equal(record.completed, false);
  assert.equal(record.final_model, null);
  assert.equal(record.fallback_used, false);
});
