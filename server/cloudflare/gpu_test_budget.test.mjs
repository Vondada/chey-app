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

test('pruning old records never lowers the lifetime spend: cheap settled jobs past 200 records still count in full', async () => {
  const storage = memoryStorage();
  let accepted = 0;
  // Each job reserves its worst case first, so the loop ends when the next worst case no longer fits the cap.
  for (let i = 0; i < 1000; i += 1) {
    const r = await reserveTestBudget(storage, { label: `job ${i}`, max_usd: TXT2IMG_MAX });
    if (!r.ok) break;
    accepted += 1;
    await settleTestBudget(storage, r.id, { actual_usd: 0.011997, provenance: 'MEASURED_SECONDS_PLUS_OVERHEAD' });
  }
  assert.ok(accepted > 200, `the run must pass the 200-record limit (accepted ${accepted})`);
  const report = await testBudgetReport(storage);
  assert.equal(report.jobs.length, 200, 'only the newest 200 records are kept');
  assert.equal(report.spent_usd, Math.round(accepted * 0.011997 * 1e6) / 1e6, 'every accepted job still counts in full');
  assert.ok(report.spent_usd > 4.8 && report.spent_usd <= 5, 'the spend is under the cap and close to it');
  const refused = await reserveTestBudget(storage, { label: 'after the cap', max_usd: TXT2IMG_MAX });
  assert.equal(refused.ok, false, 'nothing is sent once the lifetime spend is at the cap');
});

test('an open reservation is never pruned to make room', async () => {
  const storage = memoryStorage();
  const first = await reserveTestBudget(storage, { label: 'open', max_usd: TXT2IMG_MAX, id: 'open-one' });
  assert.equal(first.ok, true);
  for (let i = 0; i < 199; i += 1) {
    const r = await reserveTestBudget(storage, { label: `job ${i}`, max_usd: 0.000001 });
    await settleTestBudget(storage, r.id, { actual_usd: 0 });
  }
  await reserveTestBudget(storage, { label: 'one more', max_usd: 0.000001 });
  const report = await testBudgetReport(storage);
  assert.ok(report.jobs.some((j) => j.id === 'open-one' && j.state === 'reserved'), 'the reservation is still open');
  // The open job plus the last tiny reservation: both are still reserved, neither was pruned.
  assert.equal(report.reserved_usd, 0.108495);
});

test('totals with an empty ledger: the whole $5 is left', () => {
  assert.deepEqual(budgetTotals({ jobs: [] }), { cap_usd: 5, spent_usd: 0, reserved_usd: 0, remaining_usd: 5, jobs: 0 });
});
