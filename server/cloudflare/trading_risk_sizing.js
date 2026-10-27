// Read-only futures risk calculator. No broker access, orders or persisted positions.
// Contract values are imported from CHE's existing journal rules when available.
import { CONTRACTS } from './trading_evidence.js';

const SPECS = Object.freeze({
  ...CONTRACTS,
  MES: Object.freeze({ name: 'MES', tick: 0.25, pointValue: 5 }),
  ES: Object.freeze({ name: 'ES', tick: 0.25, pointValue: 50 }),
});

function positive(v) { return typeof v === 'number' && Number.isFinite(v) && v > 0; }
function nonnegative(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0; }

/**
 * Compute maximum whole contracts under a risk budget, including round-trip estimated
 * friction. Assumptions must be supplied by the caller; no brokerage fees are inferred.
 * Prices must be tick-aligned, and stop must be on the correct side of entry.
 */
export function planFuturesRisk({
  symbol, side, entry, stop, accountEquity, riskPercent, maxRiskDollars,
  commissionRoundTrip = 0, feesRoundTrip = 0, slippageTicksRoundTrip = 0,
  spreadTicksRoundTrip = 0,
} = {}) {
  const spec = SPECS[symbol];
  if (!spec) return { ok: false, reason: 'Unsupported futures contract' };
  if (!['long', 'short'].includes(side)) return { ok: false, reason: 'Invalid side' };
  if (![entry, stop, accountEquity, riskPercent].every(positive)) return { ok: false, reason: 'Invalid price, equity or risk percentage' };
  if (riskPercent > 100) return { ok: false, reason: 'Risk percentage exceeds 100' };
  if (maxRiskDollars !== undefined && !positive(maxRiskDollars)) return { ok: false, reason: 'Invalid risk cap' };
  if (![commissionRoundTrip, feesRoundTrip, slippageTicksRoundTrip, spreadTicksRoundTrip].every(nonnegative)) return { ok: false, reason: 'Invalid cost assumption' };
  const tickAligned = (p) => Math.abs(p / spec.tick - Math.round(p / spec.tick)) < 1e-7;
  if (!tickAligned(entry) || !tickAligned(stop)) return { ok: false, reason: 'Prices must align to contract ticks' };
  if ((side === 'long' && stop >= entry) || (side === 'short' && stop <= entry)) return { ok: false, reason: 'Stop must be beyond entry in the loss direction' };
  const stopTicks = Math.round(Math.abs(entry - stop) / spec.tick);
  const stopRiskPerContract = stopTicks * spec.tick * spec.pointValue;
  const frictionPerContract = commissionRoundTrip + feesRoundTrip + (slippageTicksRoundTrip + spreadTicksRoundTrip) * spec.tick * spec.pointValue;
  const riskPerContract = stopRiskPerContract + frictionPerContract;
  const riskBudget = Math.min(accountEquity * riskPercent / 100, maxRiskDollars ?? Infinity);
  const maxContracts = Math.floor(riskBudget / riskPerContract);
  return {
    ok: true, mode: 'PAPER_PLANNING_ONLY', symbol, side, stopTicks,
    pointValue: spec.pointValue, tickValue: spec.tick * spec.pointValue,
    stopRiskPerContract, frictionPerContract, riskPerContract, riskBudget,
    maxContracts, estimatedRiskAtMax: maxContracts * riskPerContract,
    blocked: maxContracts === 0,
    note: 'Estimated planning risk, not a guaranteed maximum loss. Gaps and adverse fills can exceed the stop and estimates.',
  };
}
