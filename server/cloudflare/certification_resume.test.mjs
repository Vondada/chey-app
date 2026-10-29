// The certification runner: a refused probe (404, a rotated token) is blocked, not graded as a CHE failure; three in a
// row stop the run; and a --resume run keeps the graded answers it already has instead of sending them again.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { grade, runCertification } from '../../tools/certification/run_certification.mjs';

const questions = JSON.parse(readFileSync(new URL('../../tools/certification/questions.json', import.meta.url), 'utf8'));
const items = Array.isArray(questions) ? questions : questions.questions;

test('a refused probe (404) is blocked and not graded as a failure', () => {
  const out = grade(items[0], { status: 404, reply: '' });
  assert.equal(out.verdict, 'blocked');
  assert.match(out.reason, /refused the token/);
});

test('three refused probes in a row stop the run and mark the rest blocked, not failed', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response('{"detail":"Not found."}', { status: 404 }); };
  const report = await runCertification({ url: 'https://x/api/probe/chat', token: 't'.repeat(64), questions: items.slice(0, 8), fetchImpl });
  assert.equal(calls, 3, 'the run stops after three refusals');
  assert.equal(report.summary.fail, 0, 'refusals are never counted as CHE failures');
  assert.equal(report.summary.blocked, 8);
});

test('a resumed run keeps the graded answers it has and sends only the rest', async () => {
  const sent = [];
  const fetchImpl = async (_url, init) => {
    sent.push(JSON.parse(init.body).message);
    return new Response(JSON.stringify({ reply: 'ok', execution_receipts: [] }), { status: 200 });
  };
  const earlier = new Map([[items[0].id, { id: items[0].id, verdict: 'pass', http_status: 200, reply: 'kept', receipts: [] }]]);
  const report = await runCertification({ url: 'https://x/api/probe/chat', token: 't'.repeat(64), questions: items.slice(0, 3), fetchImpl, reuse: earlier });
  assert.equal(sent.length, 2, 'the kept answer is not sent again');
  assert.ok(!sent.includes(items[0].question));
  assert.equal(report.results[0].reply, 'kept');
  assert.equal(report.results[0].reused_from_earlier_run, true);
});
