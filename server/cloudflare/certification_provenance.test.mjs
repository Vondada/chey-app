// Each certification row records which engine answered (provider, model, fallback) and how long it took; the summary
// breaks the score down by engine and latency, and a run can be compared with an earlier one (regression alert).
// Offline: the runner gets a fake fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareRuns, engineLabel, runCertification } from '../../tools/certification/run_certification.mjs';

const ndjson = (...lines) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
const item = (id, terms = ['Paris']) => ({
  id, category: 'intelligence_reasoning', difficulty: 'easy', question: 'Capital of France?',
  expected: { criteria: 'c', must_contain_any: terms, must_not_contain: [] }, receipt_required: false,
});

test('a row records the engine that answered, its model calls and latency; the summary groups by engine', async () => {
  const bodies = {
    'p-01': ndjson({ type: 'delta', delta: 'Paris, sir.' }, { type: 'done', source: 'model', model_calls: 1, served_by: { provider: 'groq', model: 'llama-3.3-70b', route: 'fast', fallback: false } }),
    'p-02': ndjson({ type: 'delta', delta: 'Lyon.' }, { type: 'done', source: 'model', model_calls: 2, served_by: { provider: 'workers-ai', model: '@cf/meta/llama-3.1-8b', route: 'fast', fallback: true } }),
    'p-03': ndjson({ type: 'delta', delta: 'Paris.' }, { type: 'done', source: 'che_arithmetic' }),
  };
  let current = '';
  const fetchImpl = async (_url, init) => {
    current = JSON.parse(init.body).message;
    return { status: 200, text: async () => bodies[current] };
  };
  const questions = ['p-01', 'p-02', 'p-03'].map((id) => ({ ...item(id), question: id }));
  const report = await runCertification({ url: 'https://che.test/api/probe/chat', token: 't', questions, fetchImpl });
  const [a, b, c] = report.results;
  assert.deepEqual(a.served_by, { provider: 'groq', model: 'llama-3.3-70b', route: 'fast', fallback: false });
  assert.equal(a.model_calls, 1);
  assert.ok(Number.isFinite(a.latency_ms));
  assert.equal(engineLabel(b), 'workers-ai/@cf/meta/llama-3.1-8b+fallback');
  assert.equal(c.served_by, null);
  assert.equal(engineLabel(c), 'handler:che_arithmetic');
  assert.deepEqual(report.summary.by_engine['groq/llama-3.3-70b'], { pass: 1, fail: 0, blocked: 0, not_run: 0 });
  assert.deepEqual(report.summary.by_engine['workers-ai/@cf/meta/llama-3.1-8b+fallback'], { pass: 0, fail: 1, blocked: 0, not_run: 0 });
  assert.ok(report.summary.latency_ms && report.summary.latency_ms.p50 >= 0);
});

test('compareRuns names the questions that flipped and flags a drop of 20 or more passes as a regression', () => {
  const run = (verdicts) => ({ results: Object.entries(verdicts).map(([id, verdict]) => ({ id, verdict })) });
  const base = run({ a: 'pass', b: 'pass', c: 'fail', d: 'blocked' });
  const cmp = compareRuns(run({ a: 'fail', b: 'pass', c: 'pass', d: 'pass' }), base);
  assert.deepEqual(cmp.lost, ['a']);
  assert.deepEqual(cmp.gained, ['c']);
  assert.equal(cmp.delta, 1);
  assert.equal(cmp.regression, false);
  const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`q${i}`, 'pass']));
  const worse = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`q${i}`, i < 20 ? 'fail' : 'pass']));
  assert.equal(compareRuns(run(worse), run(many)).regression, true);
  assert.equal(compareRuns(run(worse), run(many), { threshold: 21 }).regression, false);
});

test('only a full, fresh run of the current question set qualifies as a baseline', async () => {
  const { baselineProblem } = await import('../../tools/certification/run_certification.mjs');
  const questions = [{ id: 'a-1' }, { id: 'a-2' }];
  const row = (id, extra = {}) => ({ id, verdict: 'pass', ...extra });
  assert.equal(baselineProblem({ results: [row('a-1'), row('a-2', { verdict: 'fail' })] }, questions), null);
  assert.match(baselineProblem({ results: [row('a-1'), row('a-2', { verdict: 'not_run' })] }, questions), /partial/);
  assert.match(baselineProblem({ results: [row('a-1'), row('a-2', { reused_from_earlier_run: true })] }, questions), /resumed/);
  assert.match(baselineProblem({ results: [row('a-1'), row('b-9')] }, questions), /different question set/);
  assert.match(baselineProblem({ results: [] }, questions), /no results/);
});
