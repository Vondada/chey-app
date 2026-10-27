// Prop firm evaluation rules as machine-readable constraints. Every rule carries its verification: a
// rule without an official source and a verification date is "unverified" and must not be enforced
// as fact. The math is pure; nothing here fetches a firm's website.

export const DRAWDOWN_TYPES = Object.freeze(['static', 'trailing_eod', 'trailing_intraday']);

// Registry of programs. A new firm or size is one more entry; there is no firm limit in code.
export const PROGRAMS = [
  {
    id: 'fundyouredge-prime-25k',
    firm: 'FundYourEdge',
    program: 'Prime',
    account_size: 25000,
    profit_target: 1500,
    max_loss: 1000,
    drawdown_type: 'trailing_eod',
    daily_loss_limit: null,
    min_trading_days: null,
    consistency_rule: null,
    allowed_instruments: null,
    verification: {
      status: 'unverified',
      source_url: 'https://fundyouredge.com/',
      method: 'search-result snippet of the homepage; the page itself was not fetched',
      verified_at: null,
      conflicts: ['another search snippet lists a daily loss limit for the 50K Prime plan; the 25K entry lists none'],
    },
  },
];

export function findProgram(id) {
  return PROGRAMS.find((p) => p.id === id) || null;
}

/** Remaining drawdown room. A static limit is measured from the starting balance; a trailing limit from the highest balance reached (end-of-day or intraday). */
export function drawdownRoom(program, { balance, peak = balance, starting_balance = program.account_size, day_low = null } = {}) {
  const floorStatic = starting_balance - program.max_loss;
  let floor = floorStatic;
  if (program.drawdown_type === 'trailing_eod') floor = Math.max(floorStatic, peak - program.max_loss);
  if (program.drawdown_type === 'trailing_intraday') floor = Math.max(floorStatic, (day_low ?? peak) - program.max_loss);
  return { floor, room: Math.round((balance - floor) * 100) / 100, floor_basis: program.drawdown_type };
}

/** Today's loss allowance, when the program sets a daily limit. */
export function dailyAllowance(program, { day_pnl = 0 } = {}) {
  if (program.daily_loss_limit == null) return { limited: false, allowance: null, left: null };
  const left = Math.round((program.daily_loss_limit + Math.min(0, day_pnl)) * 100) / 100;
  return { limited: true, allowance: program.daily_loss_limit, left };
}

/** Evaluation progress: the profit still needed, and whether the rules allow trading now. */
export function evaluationState(program, state = {}) {
  const profit = (state.balance ?? program.account_size) - program.account_size;
  const remaining = Math.max(0, program.profit_target - profit);
  const dd = drawdownRoom(program, state);
  const daily = dailyAllowance(program, state);
  const blockers = [];
  if (dd.room <= 0) blockers.push('the drawdown limit was reached: the evaluation is failed');
  if (daily.limited && daily.left <= 0) blockers.push('the daily loss limit was reached for today');
  const passed = remaining === 0 && blockers.length === 0 && (program.min_trading_days == null || (state.trading_days || 0) >= program.min_trading_days);
  return { profit, profit_target_remaining: remaining, drawdown: dd, daily, passed, trading_allowed: blockers.length === 0 && !passed, blockers, verification: program.verification.status };
}

/** A new order is refused when it could breach the drawdown room or the daily allowance if it lost its full stop. */
export function orderAllowed(program, state, { risk_dollars = 0 } = {}) {
  const e = evaluationState(program, state);
  if (!e.trading_allowed) return { ok: false, reason: e.blockers[0] || 'the evaluation is over' };
  if (risk_dollars > e.drawdown.room) return { ok: false, reason: `a $${risk_dollars} stop is more than the $${e.drawdown.room} drawdown room` };
  if (e.daily.limited && risk_dollars > e.daily.left) return { ok: false, reason: `a $${risk_dollars} stop is more than today's $${e.daily.left} left` };
  return { ok: true, reason: '' };
}
