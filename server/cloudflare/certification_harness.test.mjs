// The 600-question certification set and its runner. Offline: the runner gets a fake fetch, and the CLI test runs
// with no endpoint configured, so nothing reaches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CATEGORIES, DIFFICULTY_SPLIT, QUESTIONS_PATH, grade, loadQuestions, parseReplyBody, runCertification, termFound, termGroups,
  termListProblem, validateQuestions,
} from '../../tools/certification/run_certification.mjs';

const RUNNER = fileURLToPath(new URL('../../tools/certification/run_certification.mjs', import.meta.url));
const questions = await loadQuestions();

const jsonResponse = (status, body) => ({ status, text: async () => JSON.stringify(body) });
const item = (over = {}) => ({
  id: 'x-01', category: 'intelligence_reasoning', difficulty: 'easy', question: 'Q?',
  expected: { criteria: 'c', must_contain_any: ['Paris'], must_not_contain: ['London'] },
  receipt_required: false, ...over,
});

test('the question set has exactly 600 items, 12 categories of 50', () => {
  assert.equal(questions.length, 600);
  const counts = new Map();
  for (const q of questions) counts.set(q.category, (counts.get(q.category) || 0) + 1);
  assert.deepEqual([...counts.keys()].sort(), [...CATEGORIES].sort());
  for (const cat of CATEGORIES) assert.equal(counts.get(cat), 50, `${cat} should have 50 questions`);
});

test('each category has the 10/15/15/10 difficulty split', () => {
  for (const cat of CATEGORIES) {
    const mine = questions.filter((q) => q.category === cat);
    for (const [level, want] of Object.entries(DIFFICULTY_SPLIT)) {
      assert.equal(mine.filter((q) => q.difficulty === level).length, want, `${cat} ${level}`);
    }
  }
});

test('ids and question texts are unique', () => {
  assert.equal(new Set(questions.map((q) => q.id)).size, 600);
  assert.equal(new Set(questions.map((q) => q.question.trim().toLowerCase())).size, 600);
});

test('every item has expected criteria and something checkable', () => {
  for (const q of questions) {
    assert.equal(typeof q.expected.criteria, 'string', q.id);
    assert.ok(q.expected.criteria.trim().length > 0, `${q.id} criteria`);
    const checkable = q.expected.must_contain_any.length > 0 || q.expected.must_not_contain.length > 0 || q.receipt_required;
    assert.ok(checkable, `${q.id} has nothing checkable`);
    assert.equal(typeof q.receipt_required, 'boolean', q.id);
  }
});

test('the shipped question file passes the validator with no problems', () => {
  assert.deepEqual(validateQuestions(questions), []);
  assert.ok(QUESTIONS_PATH.endsWith('questions.json'));
  assert.deepEqual(JSON.parse(readFileSync(QUESTIONS_PATH, 'utf8')).length, 600);
});

test('the validator reports a broken set', () => {
  const broken = [...questions];
  broken[0] = { ...broken[0], id: broken[1].id };
  const problems = validateQuestions(broken);
  assert.ok(problems.some((p) => p.includes('duplicate id')));
});

test('no endpoint configured: every question is blocked and nothing is fetched', async () => {
  let calls = 0;
  const report = await runCertification({
    url: '', token: '', questions: [item(), item({ id: 'x-02' })], fetchImpl: async () => { calls += 1; },
  });
  assert.equal(calls, 0);
  assert.equal(report.summary.blocked, 2);
  assert.equal(report.summary.pass, 0);
});

test('an unreachable endpoint is blocked, never pass, and repeated failures stop the run', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new TypeError('fetch failed'); };
  const many = Array.from({ length: 6 }, (_, i) => item({ id: `x-${i}` }));
  const report = await runCertification({ url: 'https://che.example/api/chat', token: 'tok', questions: many, fetchImpl });
  assert.equal(report.summary.pass, 0);
  assert.equal(report.summary.blocked, 6);
  assert.equal(calls, 3, 'stops calling after three consecutive unreachable responses');
  assert.equal(report.results[0].http_status, null);
  assert.match(report.results[0].reason, /unreachable/);
});

test('a refused token (401) is blocked, not failed', () => {
  const g = grade(item(), { status: 401, reply: 'no' });
  assert.equal(g.verdict, 'blocked');
});

test('a reply that meets every check passes; a broken check fails', () => {
  assert.equal(grade(item(), { status: 200, reply: 'It is Paris.' }).verdict, 'pass');
  assert.equal(grade(item(), { status: 200, reply: 'Paris, or maybe London.' }).verdict, 'fail');
  assert.equal(grade(item(), { status: 200, reply: 'I do not know.' }).verdict, 'fail');
  assert.equal(grade(item(), { status: 200, reply: '' }).verdict, 'fail');
  assert.equal(grade(item(), { status: 500, reply: 'Paris' }).verdict, 'fail');
});

test('receipt-required items need a receipt, and a claimed action needs one too', () => {
  const r = item({ receipt_required: true });
  assert.equal(grade(r, { status: 200, reply: 'Paris', receipts: [] }).verdict, 'fail');
  assert.equal(grade(r, { status: 200, reply: 'Paris', receipts: [{ id: 'rcpt_1' }] }).verdict, 'pass');
  const plain = item({ expected: { criteria: 'c', must_contain_any: ['Paris'], must_not_contain: [] } });
  assert.equal(grade(plain, { status: 200, reply: 'Paris. I sent the email.', receipts: [] }).verdict, 'fail');
  assert.equal(grade(plain, { status: 200, reply: 'Paris. I sent the email.', receipts: [{ id: 'r' }] }).verdict, 'pass');
});

test('the runner sends the question with a bearer token and grades the reply', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return jsonResponse(200, { reply: 'It is Paris.', execution_receipts: [] });
  };
  const report = await runCertification({ url: 'https://che.example/api/chat', token: 'tok-123', questions: [item()], fetchImpl });
  assert.equal(seen[0].init.headers.Authorization, 'Bearer tok-123');
  assert.equal(JSON.parse(seen[0].init.body).message, 'Q?');
  assert.equal(report.results[0].verdict, 'pass');
  assert.equal(report.results[0].http_status, 200);
  assert.equal(typeof report.results[0].latency_ms, 'number');
  assert.equal(report.endpoint, 'https://che.example/api/chat');
});

test('the token never appears in the results, even when an error echoes it', async () => {
  const secret = 'SUPER-SECRET-TOKEN-987';
  const fetchImpl = async () => { throw new TypeError(`bad header ${secret}`); };
  const report = await runCertification({ url: 'https://che.example/api/chat', token: secret, questions: [item()], fetchImpl });
  assert.equal(report.results[0].verdict, 'blocked');
  assert.ok(!JSON.stringify(report).includes(secret));
});

test('NDJSON replies are read from delta lines and the done line receipts', () => {
  const body = [
    JSON.stringify({ type: 'delta', delta: 'It is ' }),
    JSON.stringify({ type: 'delta', delta: 'Paris.' }),
    JSON.stringify({ type: 'done', execution_receipts: [{ id: 'r1' }] }),
  ].join('\n');
  const parsed = parseReplyBody(body);
  assert.equal(parsed.reply, 'It is Paris.');
  assert.equal(parsed.receipts.length, 1);
});

test('questions left out by the filter are not_run, not blocked or pass', async () => {
  const report = await runCertification({
    url: 'https://che.example/api/chat', token: 'tok', questions: [item(), item({ id: 'x-02' })],
    select: (q) => q.id === 'x-01',
    fetchImpl: async () => jsonResponse(200, { reply: 'Paris' }),
  });
  assert.equal(report.summary.pass, 1);
  assert.equal(report.summary.not_run, 1);
});

test('the CLI with no endpoint writes blocked results, prints no token, and exits 3', () => {
  const dir = mkdtempSync(join(tmpdir(), 'che-cert-'));
  try {
    const out = join(dir, 'results.json');
    const env = { ...process.env, CHE_CHAT_URL: '', CHE_PROBE_TOKEN: 'CLI-SECRET-TOKEN-555' };
    const run = spawnSync(process.execPath, [RUNNER, out, '--category=end_to_end_recovery', '--limit=2'], { env, encoding: 'utf8' });
    assert.equal(run.status, 3, run.stderr);
    assert.ok(!run.stdout.includes('CLI-SECRET-TOKEN-555'));
    const written = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(written.summary.blocked, 2);
    assert.equal(written.summary.not_run, 598);
    assert.ok(!readFileSync(out, 'utf8').includes('CLI-SECRET-TOKEN-555'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- grading rules (each rule has its own test) -----------------------------------------------------------------------

const groupItem = (groups, over = {}) => item({ expected: { criteria: 'c', must_contain_any: groups, must_not_contain: [] }, ...over });

test('rule 1: a flat must_contain_any list is one group, so any one of its terms passes', () => {
  const flat = groupItem(['3/4', 'three quarters', '0.75']);
  assert.deepEqual(termGroups(['3/4', 'three quarters', '0.75']), [['3/4', 'three quarters', '0.75']]);
  assert.equal(grade(flat, { status: 200, reply: 'That is three quarters.' }).verdict, 'pass');
  assert.equal(grade(flat, { status: 200, reply: 'About half.' }).verdict, 'fail');
});

test('rule 1: with several groups, every group must be satisfied (one term from each)', () => {
  const two = groupItem([['Paris', 'Lyon'], ['2024', '2025']]);
  assert.equal(grade(two, { status: 200, reply: 'Paris, in 2024.' }).verdict, 'pass');
  assert.equal(grade(two, { status: 200, reply: 'Paris, sometime.' }).verdict, 'fail', 'second group missing');
  assert.equal(grade(two, { status: 200, reply: 'In 2025 it was Lyon-adjacent.' }).verdict, 'pass');
  assert.equal(grade(two, { status: 200, reply: 'Paris.' }).verdict, 'fail', 'a term from one group is not enough');
  const reason = grade(two, { status: 200, reply: 'Paris.' }).reason;
  assert.match(reason, /group 2 of 2/);
});

test('rule 1: an empty group can never be satisfied, so it never passes', () => {
  const broken = groupItem([[], ['x']]);
  assert.equal(grade(broken, { status: 200, reply: 'x' }).verdict, 'fail');
});

test('rule 1: the validator rejects malformed term lists and accepts both valid shapes', () => {
  assert.equal(termListProblem(['a', 'b']), '');
  assert.equal(termListProblem([['a'], ['b', 'c']]), '');
  assert.equal(termListProblem(undefined), '');
  assert.match(termListProblem([['a'], []]), /all groups/);
  assert.match(termListProblem([['a'], 'b']), /all groups/);
  assert.match(termListProblem(['a', '']), /non-empty strings/);
  assert.match(termListProblem('a'), /must be an array/);
  assert.match(termListProblem(['a', 3], { nested: false }), /non-empty strings/);
  const bad = [...questions];
  bad[0] = { ...bad[0], expected: { ...bad[0].expected, must_contain_any: [['x'], []] } };
  assert.ok(validateQuestions(bad).some((p) => p.includes('must_contain_any must be all groups')));
});

test('rule 2: a forbidden term fails the reply even when every group is satisfied', () => {
  const withBan = item({ expected: { criteria: 'c', must_contain_any: ['Paris'], must_not_contain: ['London'] } });
  assert.equal(grade(withBan, { status: 200, reply: 'Paris is right, London is not.' }).verdict, 'fail');
  assert.match(grade(withBan, { status: 200, reply: 'Paris, and London too.' }).reason, /forbidden text: London/);
  const groupsWithBan = groupItem([['Paris'], ['France']]);
  groupsWithBan.expected.must_not_contain = ['Berlin'];
  assert.equal(grade(groupsWithBan, { status: 200, reply: 'Paris, France, not Berlin.' }).verdict, 'fail');
  assert.equal(grade(groupsWithBan, { status: 200, reply: 'Paris, France.' }).verdict, 'pass');
});

test('rule 2: a digit-only term does not match inside a longer number, but does match alone', () => {
  assert.equal(termFound('the answer is 6.', '6'), true);
  assert.equal(termFound('in 2026 we', '6'), false);
  assert.equal(termFound('it is 16', '6'), false);
  assert.equal(termFound('it is 102', '102'), true);
  assert.equal(termFound('it is 1102', '102'), false);
  assert.equal(termFound('Three Quarters', 'three quarters'), true, 'words stay case-insensitive substrings');
  assert.equal(termFound('the value is 0.75', '0.75'), true);
  const six = groupItem([['6', 'six']]);
  assert.equal(grade(six, { status: 200, reply: 'It is 16.' }).verdict, 'fail');
  assert.equal(grade(six, { status: 200, reply: 'It is six.' }).verdict, 'pass');
});

test('rule 3: receipt_required passes only with at least one execution receipt', () => {
  const r = item({ receipt_required: true });
  assert.equal(grade(r, { status: 200, reply: 'Paris', receipts: [] }).verdict, 'fail');
  assert.equal(grade(r, { status: 200, reply: 'Paris', receipts: [null, 'x'] }).verdict, 'fail', 'non-object entries are not receipts');
  assert.equal(grade(r, { status: 200, reply: 'Paris', receipts: [{ id: 'rcpt_9' }] }).verdict, 'pass');
  assert.equal(grade(item({ receipt_required: false }), { status: 200, reply: 'Paris', receipts: [] }).verdict, 'pass');
});

test('rule 4: blocked stays blocked (never pass, never fail) and not_run is left alone by grading', async () => {
  const ok = item();
  assert.equal(grade(ok, { status: null, reply: 'Paris' }).verdict, 'blocked');
  assert.equal(grade(ok, { status: 503, reply: 'Paris' }).verdict, 'blocked');
  assert.equal(grade(ok, { status: 404, reply: 'Paris' }).verdict, 'fail');
  assert.equal(grade(ok, { status: 200, reply: 'Paris' }).verdict, 'pass');
  const report = await runCertification({
    url: 'https://che.example/api/probe/chat', token: 'tok', questions: [ok, item({ id: 'x-02' })],
    select: (q) => q.id === 'x-02', fetchImpl: async () => jsonResponse(200, { reply: 'Paris' }),
  });
  assert.equal(report.results[0].verdict, 'not_run');
  assert.equal(report.results[1].verdict, 'pass');
});
