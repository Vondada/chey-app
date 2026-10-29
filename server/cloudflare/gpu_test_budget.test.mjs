// The $5 GPU testing budget: reservations before a paid job, refusal past the cap, settlement, release.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TEST_BUDGET_USD, TXT2IMG_CALL_TIMEOUT_S, maxJobUsd, reserveTestBudget, settleTestBudget, releaseTestBudget,
  testBudgetReport, budgetTotals,
} from './gpu_test_budget.js';

// A storage double with the two calls the budget makes (get and put), in memory.
function memoryStorage() {
  const map = new Map();
  return { get: async (k) => map.get(k), put: async (k, v) => { map.set(k, JSON.parse(JSON.stringify(v))); } };
}

const TXT2IMG_MAX = maxJobUsd({ timeout_s: TXT2IMG_CALL_TIMEOUT_S, startup_s: 60, idle_s: 2 });

test('the cap is $5 and is a constant, not read from the environment', () => {
  assert.equal(TEST_BUDGET_USD, 5);
});

test('one text-to-image job, at its worst case, costs about $0.1085 on a T4', () => {
  // (600 s call + 60 s cold start + 2 s idle) at $0.59/hr
  assert.equal(TXT2IMG_MAX, 0.108494);
});

test('reservations stop before the cap: 46 worst-case jobs fit, the 47th is refused and nothing is sent', async () => {
  const storage = memoryStorage();
  let accepted = 0;
  for (let i = 0; i < 46; i += 1) {
    const r = await reserveTestBudget(storage, { label: `job ${i}`, max_usd: TXT2IMG_MAX });
    assert.equal(r.ok, true, `job ${i} should fit`);
    accepted += 1;
  }
  const refused = await reserveTestBudget(storage, { label: 'job 46', max_usd: TXT2IMG_MAX });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /nothing was sent/);
  assert.equal(accepted, 46);
  assert.equal((await testBudgetReport(storage)).jobs.length, 46, 'a refused reservation is not written');
});

test('a settled job counts at its actual cost, which frees the rest of its reservation', async () => {
  const storage = memoryStorage();
  const r = await reserveTestBudget(storage, { label: 'picture', max_usd: TXT2IMG_MAX });
  assert.equal(r.ok, true);
  const before = (await testBudgetReport(storage)).remaining_usd;
  await settleTestBudget(storage, r.id, { actual_usd: 0.002, provenance: 'MEASURED' });
  const after = await testBudgetReport(storage);
  assert.equal(after.spent_usd, 0.002);
  assert.equal(after.reserved_usd, 0);
  assert.ok(after.remaining_usd > before, 'the unused reservation returns to the budget');
  assert.equal(after.jobs[0].actual_provenance, 'MEASURED');
});

test('a settled job with no measured cost keeps its reserved maximum, labelled as such', async () => {
  const storage = memoryStorage();
  const r = await reserveTestBudget(storage, { label: 'picture', max_usd: TXT2IMG_MAX });
  await settleTestBudget(storage, r.id, { actual_usd: null });
  const report = await testBudgetReport(storage);
  assert.equal(report.spent_usd, TXT2IMG_MAX);
  assert.equal(report.jobs[0].actual_provenance, 'RESERVED_MAXIMUM');
});

test('a released job (never started) costs nothing and frees its reservation', async () => {
  const storage = memoryStorage();
  const r = await reserveTestBudget(storage, { label: 'picture', max_usd: TXT2IMG_MAX });
  await releaseTestBudget(storage, r.id, 'Modal refused the call');
  const report = await testBudgetReport(storage);
  assert.equal(report.reserved_usd, 0);
  assert.equal(report.spent_usd, 0);
  assert.equal(report.jobs[0].state, 'released');
});

test('a job with no cost estimate is refused and nothing is written', async () => {
  const storage = memoryStorage();
  const r = await reserveTestBudget(storage, { label: 'unknown', max_usd: 0 });
  assert.equal(r.ok, false);
  assert.equal((await testBudgetReport(storage)).jobs.length, 0);
});

test('settling or releasing an unknown job changes nothing', async () => {
  const storage = memoryStorage();
  await reserveTestBudget(storage, { label: 'picture', max_usd: TXT2IMG_MAX, id: 'known' });
  const before = JSON.stringify(await testBudgetReport(storage));
  await settleTestBudget(storage, 'missing', { actual_usd: 1 });
  await releaseTestBudget(storage, 'missing', 'x');
  assert.equal(JSON.stringify(await testBudgetReport(storage)), before);
});

test('totals with an empty ledger: the whole $5 is left', () => {
  assert.deepEqual(budgetTotals({ jobs: [] }), { cap_usd: 5, spent_usd: 0, reserved_usd: 0, remaining_usd: 5, jobs: 0 });
});
