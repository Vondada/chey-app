// Environment guard: every trading run belongs to exactly one environment, and only an
// order that passes guardSubmit can reach a broker. Backtests and paper runs never submit.
// A simulation run may submit only to an account the broker reports as simulated. A funded
// order needs an owner approval for that exact order, explicit risk limits, and a person
// present; it is never unattended. Refusals say why, so CHE can report them aloud.

export const ENVIRONMENTS = Object.freeze({
  backtest: { label: 'Backtest (historical replay)', submitsOrders: false, moneyAtRisk: false },
  paper: { label: 'Paper (simulated fills, no broker)', submitsOrders: false, moneyAtRisk: false },
  broker_sim: { label: 'Broker simulation account', submitsOrders: true, moneyAtRisk: false },
  funded: { label: 'Funded live account', submitsOrders: true, moneyAtRisk: true },
});

const refuse = (reason) => ({ allowed: false, reason });
const allow = (reason) => ({ allowed: true, reason });

// The ledger a research source writes to. Simulated orders never write to a research ledger.
export function ledgerFor(source) {
  if (source === 'backtest' || source === 'paper') return source;
  throw new Error(`no research ledger for ${source}`);
}

// Owner risk limits must be set explicitly. Without them, funded orders are refused.
export function fundedLimitsProblems(limits) {
  if (!limits) return ['owner has not set funded risk limits'];
  const problems = [];
  if (!(limits.maxContracts > 0)) problems.push('maxContracts must be set');
  if (!(limits.maxRiskDollars > 0)) problems.push('maxRiskDollars must be set');
  return problems;
}

// order: { account_kind: 'simulation' | 'funded', account, contract, qty, entry, stop, target, pointValue }
// approval: { account, contract, qty, entry, stop, target, expires_at } from the owner, for this exact order
export function guardSubmit(environment, order = {}, { approval = null, unattended = false, limits = null, now = Date.now() } = {}) {
  const env = ENVIRONMENTS[environment];
  if (!env) return refuse(`unknown environment ${environment}`);
  if (!env.submitsOrders) return refuse(`${env.label} never submits orders to a broker`);
  if (environment === 'broker_sim') {
    if (order.account_kind !== 'simulation') return refuse('a simulation run may submit only to a simulation account');
    return allow('simulation account');
  }
  // funded
  if (order.account_kind !== 'funded') return refuse('a funded run may submit only to a funded account');
  if (unattended) return refuse('funded orders are never unattended');
  const limitProblems = fundedLimitsProblems(limits);
  if (limitProblems.length) return refuse(limitProblems.join('; '));
  if (!approval) return refuse('no owner approval for this order');
  if (!(approval.expires_at > now)) return refuse('owner approval has expired');
  for (const key of ['account', 'contract', 'qty', 'entry', 'stop', 'target']) {
    if (approval[key] !== order[key]) return refuse(`owner approval does not match this order (${key})`);
  }
  if (!(order.qty <= limits.maxContracts)) return refuse(`quantity ${order.qty} is above the owner limit of ${limits.maxContracts}`);
  const riskDollars = Math.abs(order.entry - order.stop) * (order.pointValue || 0) * order.qty;
  if (!(riskDollars <= limits.maxRiskDollars)) return refuse(`risk $${riskDollars.toFixed(2)} is above the owner limit of $${limits.maxRiskDollars}`);
  return allow('approved by the owner for this exact order, within limits');
}
