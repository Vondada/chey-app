// Hard testing budget for paid GPU jobs (owner, 2026-10-29: "a maximum of $5 total for CHE's GPU rendering tests").
//
// Before a paid job is sent, its WORST-CASE cost is reserved: the Modal call timeout, plus cold start and the idle
// scale-down, at the published T4 price. A reservation that would take the total past the cap is refused, so the job
// is never sent. When the job ends, the reservation is settled to its actual cost if Modal reports the seconds, or else
// kept at the reserved maximum (the conservative figure). A job that never started is released (no cost).
//
// The cap is a constant in this file and is not read from the environment, so it cannot be raised by a setting. Raising
// it is a code change in a PR that the owner approves. Pure except for the storage calls; the ledger is one record.

import { PAID_GPU_PRICES } from './compute_budget.js';

export const TEST_BUDGET_USD = 5;
export const TEST_BUDGET_KEY = 'che:gpu_test_budget';
export const T4_USD_PER_S = PAID_GPU_PRICES.modal.gpus.find((g) => g.id === 'T4').usd_hr / 3600;
export const TXT2IMG_CALL_TIMEOUT_S = 600;   // modal app: txt2img timeout=600
export const COLD_START_S = 60;              // modal_gpu.js MODAL_STARTUP_S
export const IDLE_SCALEDOWN_S = 2;           // modal app txt2img: scaledown_window=TXT2IMG_SCALEDOWN_S (2 s)

/** The worst case of one text-to-image job: 600 s call, 60 s cold start, 2 s idle. */
const round6 = (n) => Math.round(n * 1e6) / 1e6;

/** Worst-case cost of one job: its maximum runtime plus cold start and idle time, at the T4 price. */
export function maxJobUsd({ timeout_s, startup_s = COLD_START_S, idle_s = IDLE_SCALEDOWN_S } = {}) {
  return round6((timeout_s + startup_s + idle_s) * T4_USD_PER_S);
}

export const TXT2IMG_WORST_CASE_USD = maxJobUsd({ timeout_s: TXT2IMG_CALL_TIMEOUT_S, startup_s: COLD_START_S, idle_s: IDLE_SCALEDOWN_S });

// The ledger keeps at most this many job records. Older settled or released records are folded into `archived_usd`, so the
// lifetime spend never falls when records are pruned. An open reservation is never pruned.
const MAX_JOB_RECORDS = 200;

/** Totals for the ledger: settled spend (actual, or the reserved maximum when no actual is known) plus open reservations. */
export function budgetTotals(ledger) {
  const jobs = Array.isArray(ledger?.jobs) ? ledger.jobs : [];
  const settled = jobs.filter((j) => j.state === 'settled');
  const open = jobs.filter((j) => j.state === 'reserved');
  const spent = (Number(ledger?.archived_usd) || 0) + settled.reduce((s, j) => s + (j.actual_usd ?? j.max_usd), 0);
  const reserved = open.reduce((s, j) => s + j.max_usd, 0);
  return {
    cap_usd: TEST_BUDGET_USD,
    spent_usd: round6(spent),
    reserved_usd: round6(reserved),
    remaining_usd: round6(TEST_BUDGET_USD - spent - reserved),
    jobs: jobs.length,
  };
}

/** Bound the record list: fold the oldest settled or released records into archived spend, never a reservation. */
function boundedLedger(ledger, jobs) {
  let archived = Number(ledger.archived_usd) || 0;
  const kept = [...jobs];
  while (kept.length > MAX_JOB_RECORDS) {
    const i = kept.findIndex((j) => j.state !== 'reserved');
    if (i < 0) break;
    const [old] = kept.splice(i, 1);
    if (old.state === 'settled') archived += old.actual_usd ?? old.max_usd;
  }
  return { ...ledger, cap_usd: TEST_BUDGET_USD, archived_usd: round6(archived), jobs: kept };
}

const load = async (storage) => (await storage.get(TEST_BUDGET_KEY)) || { cap_usd: TEST_BUDGET_USD, jobs: [] };

/**
 * Reserve the worst case of one job before sending it. Refused, with the reason, when the reservation would take the total
 * past the cap. Returns { ok, id, remaining_usd, reason }.
 */
export async function reserveTestBudget(storage, { label, max_usd, id = `gpu_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, now = Date.now() }) {
  if (!(max_usd > 0)) return { ok: false, reason: 'The job has no cost estimate, so it was not sent.', remaining_usd: null };
  const ledger = await load(storage);
  const totals = budgetTotals(ledger);
  if (max_usd > totals.remaining_usd + 1e-9) {
    return { ok: false, remaining_usd: totals.remaining_usd, reason: `The GPU test budget is $${TEST_BUDGET_USD}. It has $${totals.remaining_usd.toFixed(4)} left, and this job could cost up to $${max_usd.toFixed(4)}, so nothing was sent. Raising the budget is a change you approve.` };
  }
  const job = { id, label: String(label || '').slice(0, 80), state: 'reserved', max_usd, actual_usd: null, actual_provenance: null, reserved_at: now };
  const next = boundedLedger(ledger, [...(ledger.jobs || []), job]);
  await storage.put(TEST_BUDGET_KEY, next);
  return { ok: true, id, remaining_usd: round6(totals.remaining_usd - max_usd) };
}

/** Settle a reservation when its job ends with a measured or conservative cost. */
export async function settleTestBudget(storage, id, { actual_usd, provenance, now = Date.now() }) {
  const ledger = await load(storage);
  const jobs = (ledger.jobs || []).map((j) => (j.id === id && j.state === 'reserved'
    ? { ...j, state: 'settled', actual_usd: actual_usd == null ? j.max_usd : round6(actual_usd), actual_provenance: provenance || (actual_usd == null ? 'RESERVED_MAXIMUM' : 'MEASURED'), settled_at: now }
    : j));
  const next = boundedLedger(ledger, jobs);
  await storage.put(TEST_BUDGET_KEY, next);
  return budgetTotals(next);
}

/** Release a reservation for a job that was never started (no cost). */
export async function releaseTestBudget(storage, id, reason, now = Date.now()) {
  const ledger = await load(storage);
  const jobs = (ledger.jobs || []).map((j) => (j.id === id && j.state === 'reserved'
    ? { ...j, state: 'released', actual_usd: 0, actual_provenance: 'NOT_STARTED', released_reason: String(reason || '').slice(0, 200), settled_at: now }
    : j));
  const next = boundedLedger(ledger, jobs);
  await storage.put(TEST_BUDGET_KEY, next);
  return budgetTotals(next);
}

/** The ledger as the owner sees it: the cap, the totals and each job with its cost and where the figure came from. */
export async function testBudgetReport(storage) {
  const ledger = await load(storage);
  return { ...budgetTotals(ledger), jobs: (ledger.jobs || []).map(({ id, label, state, max_usd, actual_usd, actual_provenance }) => ({ id, label, state, max_usd, actual_usd, actual_provenance })) };
}
