// Environment guard: every trading run belongs to exactly one environment, and only an
// order that passes guardSubmit can reach a broker. Backtests and paper runs never submit.
// A simulation run may submit only to an account the broker reports as simulated. A funded
// order needs an owner approval for that exact order, explicit risk limits, and a person
// present; it is never unattended. Refusals say why, so CHE can report them aloud.
//
// LIVE KILL SWITCH (owner rule, AGENTS.md): no real-money trades. Live trading stays off until
// the owner separately approves it AND it is verified. LIVE_TRADING_ENABLED is false in code, so
// every funded/live order is refused here and again right before each broker's live network
// call. Turning it on takes both a reviewed code change that sets the constant to true AND the
// Worker env flag CHE_LIVE_TRADING_APPROVED = 'owner-approved-YYYY-MM-DD'. Nothing else does.
export const LIVE_TRADING_ENABLED = false;
export const LIVE_TRADING_OFF = 'Live trading is turned off in CHE\'s code until you separately approve it and it is verified; nothing was sent.';
const LIVE_APPROVAL = /^owner-approved-\d{4}-\d{2}-\d{2}$/;

/** True only when the code constant is on and the Worker env carries the owner's dated approval. */
export function liveTradingEnabled(env = null) {
  return LIVE_TRADING_ENABLED === true && LIVE_APPROVAL.test(String(env?.CHE_LIVE_TRADING_APPROVED || ''));
}

/** The refusal to say before any live order or live switch, or null when live trading is on. */
export function liveOrderBlock(env = null) {
  return liveTradingEnabled(env) ? null : LIVE_TRADING_OFF;
}

/** What a screen shows for live orders; it reads the switch, never a hard-coded claim. */
export function liveOrdersStatus(env = null) {
  return liveTradingEnabled(env) ? 'each order needs your approval of that exact order' : 'disabled';
}

/** The same, as a sentence to show or speak. */
export function liveOrdersNote(env = null) {
  return liveTradingEnabled(env) ? 'Live orders need your approval of each exact order.' : 'Live orders are disabled.';
}

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
export function guardSubmit(environment, order = {}, { approval = null, unattended = false, limits = null, now = Date.now(), env: workerEnv = null } = {}) {
  // The kill switch comes first: no approval, limit or account kind can open a live order.
  if ((environment === 'funded' || environment === 'live') && !liveTradingEnabled(workerEnv)) return refuse(LIVE_TRADING_OFF);
  const env = ENVIRONMENTS[environment];
  if (!env) return refuse(`unknown environment ${environment}`);
  if (!env.submitsOrders) return refuse(`${env.label} never submits orders to a broker`);
  if (environment === 'broker_sim') {
    if (order.account_kind !== 'simulation') return refuse('a simulation run may submit only to a simulation account');
    return allow('simulation account');
  }
  return fundedOrderCheck(order, { approval, unattended, limits, now });
}

// The per-order checks a funded order must also pass once live trading is on. It never sends
// anything and never overrides the kill switch above; guardSubmit is the only caller that matters.
export function fundedOrderCheck(order = {}, { approval = null, unattended = false, limits = null, now = Date.now() } = {}) {
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
