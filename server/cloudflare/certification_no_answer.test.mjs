// An error frame (empty_after_checks: CHE's truth checks removed the whole reply) is CHE's own outcome, a fail that is
// named, not an empty reply to retry. Resume keeps every other real answer, and --rerun asks again the classes it names.
import assert from 'node:assert/strict';
import test from 'node:test';
import { classificationOf, grade, parseReplyBody, reuseFrom } from '../../tools/certification/run_certification.mjs';
import { readFileSync } from 'node:fs';

const item = { id: 'q-1', category: 'memory_recall', difficulty: 'easy', question: 'q', expected: { criteria: 'c', must_contain_any: ['Paris'], must_not_contain: [] }, receipt_required: false };

test('an empty reply with an empty_after_checks error is no_answer (a fail), and names the rules', () => {
  const g = grade(item, { status: 200, reply: '', error: { category: 'empty_after_checks', rules: ['sourced', 'attribution'] } });
  assert.equal(g.classification, 'no_answer');
  assert.equal(g.verdict, 'fail');
  assert.equal(g.reason, "CHE's checks removed the whole reply (sourced, attribution)");
});

test('an empty reply with no explanation stays no_valid_response (blocked, asked again)', () => {
  const g = grade(item, { status: 200, reply: '', error: null });
  assert.equal(g.classification, 'no_valid_response');
  assert.equal(g.verdict, 'blocked');
});

test('the NDJSON error frame and the probe JSON both keep the error', () => {
  const ndjson = '{"type":"error","category":"empty_after_checks","rules":["sourced"]}\n{"type":"done"}\n';
  assert.deepEqual(parseReplyBody(ndjson).error, { category: 'empty_after_checks', rules: ['sourced'] });
  const probe = JSON.stringify({ ok: true, status: 200, reply: '', error: { category: 'empty_after_checks', rules: ['sourced'] } });
  assert.deepEqual(parseReplyBody(probe).error, { category: 'empty_after_checks', rules: ['sourced'] });
  assert.equal(parseReplyBody('{"reply":"Paris"}').error, null);
});

test('an old row with the same reason is classed no_answer, so it is not asked again by default', () => {
  assert.equal(classificationOf({ verdict: 'fail', reason: "CHE's checks removed the whole reply (sourced)" }), 'no_answer');
  const rows = [
    { id: 'a', verdict: 'pass', classification: 'pass' },
    { id: 'b', verdict: 'fail', classification: 'incorrect' },
    { id: 'c', verdict: 'fail', classification: 'no_answer' },
    { id: 'd', verdict: 'blocked', classification: 'infrastructure' },
  ];
  assert.deepEqual([...reuseFrom(rows).keys()], ['a', 'b', 'c']);
  assert.deepEqual([...reuseFrom(rows, new Set(['incorrect'])).keys()], ['a', 'c']);
  assert.deepEqual([...reuseFrom(rows, new Set(['no_answer', 'incorrect'])).keys()], ['a']);
});

test('the Worker names the rules in the empty_after_checks frame, and the probe returns the error frame', () => {
  const worker = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
  assert.match(worker, /category: 'empty_after_checks',\n\s+retryable: true,\n\s+request_id: requestId,\n\s+rules,/);
  const reader = readFileSync(new URL('./probe_reply.js', import.meta.url), 'utf8');
  assert.match(reader, /const frame = events\.find\(\(event\) => event\.type === 'error'\)/);
  assert.match(worker, /const \{ reply, done, receipts, error \} = parseProbeChatBody\(raw\);/);
  assert.match(worker, /return \{ ok: response\.ok, status: response\.status, reply, done, execution_receipts: receipts, error \};/);
});
