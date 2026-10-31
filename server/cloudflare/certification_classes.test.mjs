// Every certification row has one class. Only real CHE answers count toward the score, and only those are kept when a run
// resumes: infrastructure, auth and empty-reply rows are asked again.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  classificationOf, grade, reuseFrom, runCertification, VALID_ANSWER_CLASSES,
} from '../../tools/certification/run_certification.mjs';

const questions = JSON.parse(readFileSync(new URL('../../tools/certification/questions.json', import.meta.url), 'utf8'));
const items = Array.isArray(questions) ? questions : questions.questions;
const item = (over = {}) => ({
  id: 'q-1', category: 'memory_recall', difficulty: 'easy', question: 'Capital of France?',
  expected: { criteria: 'c', must_contain_any: ['Paris'], must_not_contain: [] }, receipt_required: false, ...over,
});

test('each outcome gets its class and verdict', () => {
  assert.deepEqual(grade(item(), { status: 200, reply: 'It is Paris.' }), { verdict: 'pass', classification: 'pass', reason: 'all checks met' });
  assert.equal(grade(item(), { status: 200, reply: 'I do not know.' }).classification, 'incorrect');
  assert.equal(grade(item({ receipt_required: true }), { status: 200, reply: 'Paris', receipts: [] }).classification, 'unverified');
  assert.equal(grade(item(), { status: 200, reply: 'Paris. I sent the email.', receipts: [] }).classification, 'incorrect');
  assert.equal(grade(item(), { status: 200, reply: '' }).classification, 'no_valid_response');
  assert.equal(grade(item(), { status: 500, reply: 'Paris' }).classification, 'infrastructure');
  assert.equal(grade(item(), { status: null, reply: '' }).classification, 'infrastructure');
  assert.equal(grade(item(), { status: 401, reply: '' }).classification, 'auth');
  assert.equal(grade(item(), { status: 403, reply: '' }).classification, 'auth');
  assert.equal(grade(item(), { status: 404, reply: '' }).classification, 'auth');
});

test('the verdict follows the class: answers are pass or fail, everything else is blocked', () => {
  for (const [status, reply] of [[200, 'Paris'], [200, 'no'], [200, ''], [500, ''], [404, ''], [null, '']]) {
    const g = grade(item(), { status, reply });
    const expected = g.classification === 'pass' ? 'pass' : (VALID_ANSWER_CLASSES.has(g.classification) ? 'fail' : 'blocked');
    assert.equal(g.verdict, expected, `${status} ${reply}`);
  }
});

test('rows from before classes are classified from their reason', () => {
  assert.equal(classificationOf({ verdict: 'pass', reason: 'all checks met' }), 'pass');
  assert.equal(classificationOf({ verdict: 'fail', reason: 'reply lacks every term of required group 1 of 1' }), 'incorrect');
  assert.equal(classificationOf({ verdict: 'fail', reason: 'receipt required but no execution receipt returned' }), 'unverified');
  assert.equal(classificationOf({ verdict: 'fail', reason: 'empty reply' }), 'no_valid_response');
  assert.equal(classificationOf({ verdict: 'fail', reason: 'HTTP 500' }), 'infrastructure');
  assert.equal(classificationOf({ verdict: 'blocked', reason: 'HTTP 404: the probe route refused the token' }), 'auth');
  assert.equal(classificationOf({ verdict: 'blocked', reason: 'endpoint unreachable: socket hang up' }), 'infrastructure');
});

test('the score counts only real CHE answers', async () => {
  const replies = { 'q-1': 'Paris', 'q-2': 'no idea', 'q-3': '', 'q-4': 'Paris' };
  const fake = async (url, init) => {
    const id = JSON.parse(init.body).message;
    if (id === 'boom') return new Response('', { status: 500 });
    return new Response(JSON.stringify({ reply: replies[id] ?? '', execution_receipts: [] }), { status: 200 });
  };
  const qs = [
    item({ id: 'q-1', question: 'q-1' }), item({ id: 'q-2', question: 'q-2' }),
    item({ id: 'q-3', question: 'q-3' }), item({ id: 'q-4', question: 'boom' }),
  ];
  const report = await runCertification({ url: 'https://x.test/api/probe/chat', token: 't'.repeat(64), questions: qs, fetchImpl: fake });
  const s = report.summary;
  assert.equal(s.pass, 1);
  assert.equal(s.fail, 1, 'only the incorrect answer is a fail');
  assert.equal(s.blocked, 2, 'empty reply and server error are blocked, not graded');
  assert.equal(s.valid_answers, 2);
  assert.equal(s.score, 0.5);
  assert.deepEqual(s.by_classification, { pass: 1, incorrect: 1, no_valid_response: 1, infrastructure: 1 });
});

test('resume keeps only real answers and asks the rest again', async () => {
  const earlier = new Map([
    ['a', { id: 'a', verdict: 'pass', classification: 'pass' }],
    ['b', { id: 'b', verdict: 'fail', classification: 'incorrect' }],
    ['c', { id: 'c', verdict: 'blocked', classification: 'infrastructure' }],
  ]);
  const asked = [];
  const fake = async (url, init) => {
    asked.push(JSON.parse(init.body).message);
    return new Response(JSON.stringify({ reply: 'Paris', execution_receipts: [] }), { status: 200 });
  };
  const qs = ['a', 'b', 'c'].map((id) => item({ id, question: id }));
  const report = await runCertification({
    url: 'https://x.test/api/probe/chat', token: 't'.repeat(64), questions: qs, fetchImpl: fake, reuse: reuseFrom([...earlier.values()]),
  });
  assert.deepEqual(asked, ['c'], 'only the infrastructure row is asked again');
  assert.equal(report.results[0].reused_from_earlier_run, true);
  assert.equal(report.results[2].classification, 'pass');
});

test('the question set still has 600 checkable items', () => {
  assert.equal(items.length, 600);
});
