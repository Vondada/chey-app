// Knowledge Atlas calculators (owner issue #346, trading lane): pure functions that show their
// work, so CHE can say exactly how a number was reached. Each returns
//   { ok, name, value, values, formula, inputs, units, assumptions, steps }
// where `value` is the headline number (or an object of numbers) and `steps` is the arithmetic in
// words. A calculator that cannot answer returns { ok: false, error } and never a guess.
//
// Nothing here reads storage, a clock or the network. The statistics CHE's evidence engine
// already owns are reused (wilsonInterval, etParts, tradeDayOf from trading_evidence.js; swings
// from trading_lab.js), and the tests check the rest against independent computations.
import { etParts, tradeDayOf, wilsonInterval } from './trading_evidence.js';
import { swings } from './trading_lab.js';

// ─── Contract specs: one table ───────────────────────────────────────────

/** Where the specs come from. Read from CME's published pages, not fetched by CHE at run time. */
export const SPEC_SOURCE = Object.freeze({
  title: 'CME Group equity index futures contract specifications',
  url: 'https://www.cmegroup.com/markets/equities.html',
  caveat: 'Verify against the exchange; specs can change.',
});
const spec = (symbol, name, index, pointValue, url) => Object.freeze({ symbol, name, index, pointValue, tick: 0.25, tickValue: 0.25 * pointValue, url });
export const FUTURES_SPECS = Object.freeze({
  NQ: spec('NQ', 'E-mini Nasdaq-100', 'Nasdaq-100', 20, 'https://www.cmegroup.com/markets/equities/nasdaq/e-mini-nasdaq-100.contractSpecs.html'),
  MNQ: spec('MNQ', 'Micro E-mini Nasdaq-100', 'Nasdaq-100', 2, 'https://www.cmegroup.com/markets/equities/nasdaq/micro-e-mini-nasdaq-100.contractSpecs.html'),
  ES: spec('ES', 'E-mini S&P 500', 'S&P 500', 50, 'https://www.cmegroup.com/markets/equities/sp/e-mini-sandp500.contractSpecs.html'),
  MES: spec('MES', 'Micro E-mini S&P 500', 'S&P 500', 5, 'https://www.cmegroup.com/markets/equities/sp/micro-e-mini-sandp-500.contractSpecs.html'),
});
export const specOf = (symbol) => FUTURES_SPECS[String(symbol || '').toUpperCase()] || null;
/** A standard equity option controls 100 shares. */
export const OPTION_MULTIPLIER = 100;

// ─── Formatting: the same words in every step ────────────────────────────

const EPS = 1e-9;
// Prices are decimals: 50.10 − 50.09 is 0.010000000000005 in binary, so distances are rounded to 1e-8
// and a whole count is floored with a little room, or 0.01 a share would buy one share too few.
const tidy = (x) => Math.round(x * 1e8) / 1e8;
const wholeFit = (budget, per) => Math.floor((budget / per) * (1 + 1e-12) + EPS);
const fin = Number.isFinite;
const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;
/** A plain number with thousands separators and at most `dp` decimals: 18,000 or 0.25. */
export const num = (x, dp = 2) => Number(x).toLocaleString('en-US', { maximumFractionDigits: dp });
/** Dollars and cents: $48.00, −$20.00. */
export const usd = (x) => `${x < 0 ? '−' : ''}$${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const pct = (x, dp = 1) => `${(100 * x).toFixed(dp)}%`;
const signedR = (x) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(2)}R`;
const plural = (n, word) => `${num(n)} ${word}${n === 1 ? '' : 's'}`;
const pts = (n) => plural(n, 'point');

const done = (name, fields) => ({ ok: true, name, ...fields });
const refuse = (name, error, inputs = {}) => ({ ok: false, name, error, inputs, value: null, steps: [] });

function stopDistance({ entry, stop, stopPoints, stopTicks }, tick) {
  if (fin(stopPoints)) return { points: Math.abs(stopPoints), from: 'points' };
  if (fin(stopTicks)) return { points: tidy(Math.abs(stopTicks) * tick), from: 'ticks' };
  if (fin(entry) && fin(stop)) return { points: tidy(Math.abs(entry - stop)), from: 'prices' };
  return { points: NaN, from: '' };
}

function budgetOf({ riskDollars, riskPercent, account }) {
  if (fin(riskDollars) && riskDollars > 0) return { budget: riskDollars, step: '' };
  if (fin(riskPercent) && riskPercent > 0 && fin(account) && account > 0) {
    const budget = (account * riskPercent) / 100;
    return { budget, step: `risk budget = ${num(riskPercent)}% of ${usd(account)} = ${usd(budget)}` };
  }
  return { budget: NaN, step: '' };
}

// ─── Futures ─────────────────────────────────────────────────────────────

/** Dollar risk of a futures position from its stop distance (points, ticks, or entry and stop prices). */
export function futuresRisk(inputs = {}) {
  const { symbol = 'MNQ', contracts = 1, roundTripFees } = inputs;
  const s = specOf(symbol);
  if (!s) return refuse('futuresRisk', `there is no contract spec for ${symbol}; the table has ${Object.keys(FUTURES_SPECS).join(', ')}`, inputs);
  if (!(Number.isInteger(contracts) && contracts >= 1)) return refuse('futuresRisk', 'the number of contracts must be a whole number of 1 or more', inputs);
  const { points, from } = stopDistance(inputs, s.tick);
  if (!(points > 0)) return refuse('futuresRisk', 'a stop distance above zero is needed: points, ticks, or an entry and a stop price', inputs);
  const ticks = points / s.tick;
  const perContract = points * s.pointValue;
  const total = perContract * contracts;
  const costs = fin(roundTripFees) && roundTripFees >= 0 ? roundTripFees * contracts : null;
  const steps = [];
  if (from === 'prices') steps.push(`stop distance = |${num(inputs.entry)} − ${num(inputs.stop)}| = ${num(points)} points`);
  steps.push(from === 'ticks' ? `${num(ticks)} ticks × ${s.tick} points = ${num(points)} points` : `${num(points)} points ÷ ${s.tick} = ${num(ticks)} ticks of ${usd(s.tickValue)}`);
  if (Math.abs(ticks - Math.round(ticks)) > EPS) steps.push(`note: ${num(points)} points is not a whole number of ${s.tick}-point ticks, so a real stop would sit on the nearest tick`);
  steps.push(`risk per contract = ${num(points)} points × ${usd(s.pointValue)} a point = ${usd(perContract)}`);
  steps.push(`total risk = ${usd(perContract)} × ${plural(contracts, 'contract')} = ${usd(total)}`);
  steps.push(costs == null
    ? 'before commissions and fees: you gave none, so none are assumed'
    : `with your round-trip costs of ${usd(roundTripFees)} a contract: ${usd(total)} + ${usd(costs)} = ${usd(total + costs)}`);
  return done('futuresRisk', {
    value: r2(total),
    values: { points, ticks, perContract: r2(perContract), total: r2(total), costs: costs == null ? null : r2(costs), totalWithCosts: costs == null ? null : r2(total + costs) },
    formula: 'risk = stop distance in points × point value × contracts (+ round-trip costs × contracts, when given)',
    inputs: { ...inputs, symbol: s.symbol, contracts }, units: '$', spec: s,
    assumptions: 'The stop fills at its price; a gap or slippage through the stop makes the loss bigger. Commissions and fees are added only when you give them.',
    steps,
  });
}

/** Contracts that fit a risk budget ($, or % of an account): rounded down, never up. */
export function positionSize(inputs = {}) {
  const { symbol = 'MNQ', roundTripFees } = inputs;
  const s = specOf(symbol);
  if (!s) return refuse('positionSize', `there is no contract spec for ${symbol}`, inputs);
  const { points } = stopDistance(inputs, s.tick);
  if (!(points > 0)) return refuse('positionSize', 'a stop distance above zero is needed', inputs);
  const { budget, step } = budgetOf(inputs);
  if (!(budget > 0)) return refuse('positionSize', 'a risk budget is needed: dollars, or a percent of an account size', inputs);
  const fee = fin(roundTripFees) && roundTripFees >= 0 ? roundTripFees : 0;
  const perContract = points * s.pointValue + fee;
  const contracts = wholeFit(budget, perContract);
  const steps = [];
  if (step) steps.push(step);
  steps.push(`risk per contract = ${num(points)} points × ${usd(s.pointValue)}${fee ? ` + ${usd(fee)} round-trip costs` : ''} = ${usd(perContract)}`);
  steps.push(`${usd(budget)} ÷ ${usd(perContract)} = ${num(budget / perContract, 4)}, rounded down = ${plural(contracts, 'contract')}`);
  if (contracts > 0) steps.push(`check: ${contracts} × ${usd(perContract)} = ${usd(contracts * perContract)}, within ${usd(budget)}; one more would risk ${usd((contracts + 1) * perContract)}`);
  else steps.push(`even 1 contract risks ${usd(perContract)}, more than ${usd(budget)}, so the trade does not fit this budget${s.symbol === 'NQ' ? ' (one MNQ risks a tenth as much)' : s.symbol === 'ES' ? ' (one MES risks a tenth as much)' : ''}`);
  if (!fee) steps.push('before commissions and fees: you gave none, so none are assumed');
  return done('positionSize', {
    value: contracts,
    values: { contracts, budget: r2(budget), perContract: r2(perContract), used: r2(contracts * perContract) },
    formula: 'contracts = floor(risk budget ÷ (stop points × point value + round-trip costs))',
    inputs: { ...inputs, symbol: s.symbol }, units: 'contracts', spec: s,
    assumptions: 'The stop fills at its price; gaps and slippage can make the real loss bigger. Rounding down keeps the risk inside the budget.',
    steps,
  });
}

/** Risk, reward and reward-to-risk of a planned trade, with the win rate it needs to break even. */
export function rewardRisk(inputs = {}) {
  const { symbol = '', side = 'long', entry, stop, target, contracts = 1, roundTripFees } = inputs;
  if (![entry, stop, target].every(fin)) return refuse('rewardRisk', 'an entry, a stop and a target price are needed', inputs);
  const long = side !== 'short';
  const risk = long ? entry - stop : stop - entry;
  const reward = long ? target - entry : entry - target;
  if (!(risk > 0)) return refuse('rewardRisk', `for a ${long ? 'long the stop must be below' : 'short the stop must be above'} the entry`, inputs);
  if (!(reward > 0)) return refuse('rewardRisk', `for a ${long ? 'long the target must be above' : 'short the target must be below'} the entry`, inputs);
  const ratio = reward / risk;
  const s = symbol ? specOf(symbol) : null;
  const steps = [
    `risk = ${long ? `${num(entry)} − ${num(stop)}` : `${num(stop)} − ${num(entry)}`} = ${pts(risk)}`,
    `reward = ${long ? `${num(target)} − ${num(entry)}` : `${num(entry)} − ${num(target)}`} = ${pts(reward)}`,
    `reward to risk = ${num(reward)} ÷ ${num(risk)} = ${num(ratio)} to 1`,
  ];
  const values = { riskPoints: risk, rewardPoints: reward, ratio, breakevenWinRate: risk / (risk + reward) };
  if (s) {
    const riskD = risk * s.pointValue * contracts;
    const rewardD = reward * s.pointValue * contracts;
    Object.assign(values, { riskDollars: r2(riskD), rewardDollars: r2(rewardD) });
    steps.push(`in dollars on ${contracts} ${s.symbol}: risk ${num(risk)} × ${usd(s.pointValue)} × ${contracts} = ${usd(riskD)}, reward ${num(reward)} × ${usd(s.pointValue)} × ${contracts} = ${usd(rewardD)}`);
    if (fin(roundTripFees) && roundTripFees >= 0) {
      const f = roundTripFees * contracts;
      values.breakevenWinRateAfterCosts = (riskD + f) / (riskD + rewardD);
      steps.push(`win rate needed to break even after your ${usd(roundTripFees)} round-trip costs: (${usd(riskD)} + ${usd(f)}) ÷ (${usd(riskD)} + ${usd(rewardD)}) = ${pct(values.breakevenWinRateAfterCosts)}`);
    }
  }
  steps.push(`win rate needed to break even before costs = ${num(risk)} ÷ (${num(risk)} + ${num(reward)}) = ${pct(values.breakevenWinRate)}`);
  return done('rewardRisk', {
    value: ratio, values,
    formula: 'reward-to-risk = |target − entry| ÷ |entry − stop|;  break-even win rate = risk ÷ (risk + reward)',
    inputs, units: 'ratio', spec: s,
    assumptions: 'Fills exactly at entry, stop and target; the trade ends at one of them. Slippage and costs raise the break-even win rate.',
    steps,
  });
}

// ─── Stocks and options ──────────────────────────────────────────────────

/** Shares that fit a risk budget, from the per-share distance between entry and stop. */
export function stockShares(inputs = {}) {
  const { entry, stop, stopDistance: given } = inputs;
  const priced = fin(entry) && fin(stop);
  const perShare = priced ? tidy(Math.abs(entry - stop)) : fin(given) ? Math.abs(given) : NaN;
  if (!(perShare > 0)) return refuse('stockShares', 'an entry and a different stop price, or the dollars between them, are needed', inputs);
  const { budget, step } = budgetOf(inputs);
  if (!(budget > 0)) return refuse('stockShares', 'a risk budget is needed: dollars, or a percent of an account size', inputs);
  const shares = wholeFit(budget, perShare);
  const steps = [];
  if (step) steps.push(step);
  steps.push(priced ? `risk per share = |${num(entry)} − ${num(stop)}| = ${usd(perShare)}` : `risk per share = ${usd(perShare)}, the distance you gave`);
  steps.push(`${usd(budget)} ÷ ${usd(perShare)} = ${num(budget / perShare, 4)}, rounded down = ${plural(shares, 'share')}`);
  if (fin(entry)) steps.push(`capital to buy them = ${num(shares)} × ${usd(entry)} = ${usd(shares * entry)}; the risk is ${usd(shares * perShare)}, not the whole amount`);
  return done('stockShares', {
    value: shares,
    values: { shares, perShare: r4(perShare), risk: r2(shares * perShare), capital: fin(entry) ? r2(shares * entry) : null, budget: r2(budget) },
    formula: 'shares = floor(risk budget ÷ |entry − stop|)',
    inputs, units: 'shares',
    assumptions: 'The stop fills at its price; an overnight gap can open far beyond it. Commissions are not included.',
    steps,
  });
}

/** The R-multiple of a closed trade: what it made, in units of what it risked. */
export function rMultiple(inputs = {}) {
  const { entry, stop, exit, side = 'long' } = inputs;
  if (![entry, stop, exit].every(fin)) return refuse('rMultiple', 'an entry, a stop and an exit price are needed', inputs);
  const long = side !== 'short';
  const risk = long ? entry - stop : stop - entry;
  if (!(risk > 0)) return refuse('rMultiple', 'the stop must be on the losing side of the entry', inputs);
  const gain = long ? exit - entry : entry - exit;
  const r = gain / risk;
  return done('rMultiple', {
    value: r, values: { risk, gain, r },
    formula: long ? 'R = (exit − entry) ÷ (entry − stop)' : 'R = (entry − exit) ÷ (stop − entry)',
    inputs, units: 'R', assumptions: 'The initial stop, fixed at entry, defines 1R.',
    steps: [`risk = ${num(risk)} per unit`, `result = ${num(gain)} per unit`, `R = ${num(gain)} ÷ ${num(risk)} = ${signedR(r)}`],
  });
}

/** A call or put held to expiry: intrinsic value, breakeven, most it can lose and gain. */
export function optionAtExpiry(inputs = {}) {
  const { type = 'call', position = 'long', strike, premium, underlying, contracts = 1, multiplier = OPTION_MULTIPLIER } = inputs;
  if (!['call', 'put'].includes(type) || !['long', 'short'].includes(position)) return refuse('optionAtExpiry', 'say a call or a put, bought (long) or sold (short)', inputs);
  if (!(strike > 0) || !(premium >= 0) || !(Number.isInteger(contracts) && contracts >= 1)) return refuse('optionAtExpiry', 'a strike, a premium and a whole number of contracts are needed', inputs);
  const call = type === 'call';
  const long = position === 'long';
  const scale = multiplier * contracts;
  const breakeven = call ? strike + premium : strike - premium;
  const premiumTotal = premium * scale;
  const putFloor = (strike - premium) * scale;
  const maxLoss = long ? premiumTotal : call ? null : putFloor;
  const maxGain = long ? (call ? null : putFloor) : premiumTotal;
  const values = { breakeven, maxLoss: maxLoss == null ? null : r2(maxLoss), maxGain: maxGain == null ? null : r2(maxGain), premiumTotal: r2(premiumTotal) };
  const steps = [
    `breakeven at expiry = strike ${call ? '+' : '−'} premium = ${num(strike)} ${call ? '+' : '−'} ${num(premium)} = ${num(breakeven)}`,
    `premium in dollars = ${num(premium)} × ${multiplier} shares × ${plural(contracts, 'contract')} = ${usd(premiumTotal)}`,
    `most it can lose = ${maxLoss == null ? 'unlimited, because the price can keep rising' : usd(maxLoss)}`,
    `most it can gain = ${maxGain == null ? 'unlimited, because the price can keep rising' : usd(maxGain)}${!call && maxGain != null && long ? ', if the price went to zero' : ''}`,
  ];
  if (fin(underlying)) {
    const intrinsic = call ? Math.max(0, underlying - strike) : Math.max(0, strike - underlying);
    const pnl = (intrinsic - premium) * scale * (long ? 1 : -1);
    Object.assign(values, { intrinsic, pnl: r2(pnl) });
    steps.push(`intrinsic value at ${num(underlying)} = ${call ? `max(0, ${num(underlying)} − ${num(strike)})` : `max(0, ${num(strike)} − ${num(underlying)})`} = ${num(intrinsic)}`);
    steps.push(`profit or loss at expiry = (${num(intrinsic)} − ${num(premium)}) × ${scale}${long ? '' : ' × −1 for the seller'} = ${usd(pnl)}`);
  }
  return done('optionAtExpiry', {
    value: values, values,
    formula: call ? 'call: intrinsic = max(0, S − K); breakeven = K + premium' : 'put: intrinsic = max(0, K − S); breakeven = K − premium',
    inputs, units: '$ and price',
    assumptions: 'At expiry only, with no early exercise, before commissions; before expiry an option also has time value, which needs a pricing model and live quotes CHE does not have.',
    steps,
  });
}

/** A market order filled against the levels of an order book: average price and slippage. */
export function bookFill(inputs = {}) {
  const { side = 'buy', qty, levels = [], symbol = 'MNQ' } = inputs;
  const s = specOf(symbol);
  if (!s || !(Number.isInteger(qty) && qty >= 1) || !Array.isArray(levels) || !levels.length) return refuse('bookFill', 'a contract, a whole quantity and the book levels on the side being hit are needed', inputs);
  let left = qty; let cost = 0; let worst = null;
  const steps = [];
  for (const lv of levels) {
    if (left <= 0) break;
    const take = Math.min(left, lv.size);
    cost += take * lv.price; left -= take; worst = lv.price;
    steps.push(`${take} at ${num(lv.price)}`);
  }
  if (left > 0) return refuse('bookFill', `the levels shown hold only ${qty - left} of the ${qty} contracts`, inputs);
  const avg = cost / qty;
  const best = levels[0].price;
  const slip = side === 'sell' ? best - avg : avg - best;
  const dollars = slip * s.pointValue * qty;
  return done('bookFill', {
    value: { avgPrice: avg, slippagePoints: slip, slippageDollars: r2(dollars) },
    values: { avgPrice: avg, slippagePoints: slip, slippageDollars: r2(dollars), worstPrice: worst, bestPrice: best },
    formula: 'average fill = Σ(price × size taken) ÷ quantity;  slippage = |average fill − best price| × point value × quantity',
    inputs, units: 'price and $', spec: s,
    assumptions: 'The book stays still while the order fills; in a fast market it moves, and hidden orders can change the result.',
    steps: [`fills: ${steps.join(', ')}`, `average = ${num(cost, 2)} ÷ ${qty} = ${num(avg, 4)}`, `slippage = ${num(Math.abs(slip), 4)} points × ${usd(s.pointValue)} × ${qty} = ${usd(Math.abs(dollars))} against the best price ${num(best)}`],
  });
}

/** Crossing the spread and paying slippage, as a cost per trade in R. */
export function costInR(inputs = {}) {
  const { grossR, roundTripCost, riskDollars } = inputs;
  if (![grossR, roundTripCost, riskDollars].every(fin) || !(riskDollars > 0) || roundTripCost < 0) return refuse('costInR', 'a gross expectancy in R, a round-trip cost and the dollars risked per trade are needed', inputs);
  const cost = roundTripCost / riskDollars;
  const net = grossR - cost;
  return done('costInR', {
    value: { costR: cost, netR: net }, values: { costR: cost, netR: net },
    formula: 'net expectancy = gross expectancy − round-trip cost ÷ dollars risked',
    inputs, units: 'R', assumptions: 'The same cost on every trade; real slippage varies and is worst when the market is fast.',
    steps: [`cost per trade = ${usd(roundTripCost)} ÷ ${usd(riskDollars)} = ${num(cost, 4)}R`, `net = ${signedR(grossR)} − ${num(cost, 4)}R = ${signedR(net)}`],
  });
}

// ─── Sessions, VWAP and the opening range (America/New_York, DST-correct) ─

const RTH_OPEN_MIN = 9 * 60 + 30;
const RTH_CLOSE_MIN = 16 * 60;
const time = (b) => Date.parse(b?.t);

/** The instant of 9:30 a.m. New York time on a calendar day (YYYY-MM-DD), daylight saving included. */
export function rthOpenOf(day) {
  // New York is UTC−4 in daylight time and UTC−5 in standard time; the time zone database decides.
  for (const utc of ['13:30', '14:30']) {
    const at = `${day}T${utc}:00.000Z`;
    const p = etParts(at);
    if (p.day === day && p.mins === RTH_OPEN_MIN) return at;
  }
  return null;
}

const barMinutes = (bars) => {
  const gaps = [];
  for (let i = 1; i < bars.length; i += 1) gaps.push((time(bars[i]) - time(bars[i - 1])) / 60_000);
  const sorted = gaps.filter((g) => g > 0).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};

/** The latest regular-hours session (9:30–16:00 New York) the bars reach, and whether they cover its open. */
export function latestRthSession(bars = []) {
  const rows = (Array.isArray(bars) ? bars : []).filter((b) => b && fin(time(b)) && [b.h, b.l, b.c].every(fin)).sort((a, b) => time(a) - time(b));
  const inRth = (b) => { const m = etParts(b.t).mins; return m >= RTH_OPEN_MIN && m < RTH_CLOSE_MIN; };
  const last = [...rows].reverse().find(inRth);
  if (!last) return { ok: false, error: 'none of the bars falls inside regular hours, 9:30 a.m. to 4 p.m. New York time', bars: [] };
  const day = etParts(last.t).day;
  const open = rthOpenOf(day);
  const session = rows.filter((b) => inRth(b) && etParts(b.t).day === day);
  const step = barMinutes(rows) || barMinutes(session);
  return {
    ok: true, day, open, bars: session, barMinutes: step,
    coversOpen: session.length > 0 && time(session[0]) === Date.parse(open),
    complete: step > 0 && time(session[session.length - 1]) + step * 60_000 >= Date.parse(open) + (RTH_CLOSE_MIN - RTH_OPEN_MIN) * 60_000,
  };
}

/**
 * VWAP from bars, with volume-weighted standard-deviation bands at 1, 2 and 3σ. `anchor` is 'rth'
 * (the latest regular-hours session, from its 9:30 New York open), 'all' (every bar given) or an
 * ISO time (an anchored VWAP from that bar on). Bars without volume carry no weight and are counted.
 */
export function vwapBands(inputs = {}) {
  const { bars = [], anchor = 'all' } = inputs;
  let rows = (Array.isArray(bars) ? bars : []).filter((b) => b && [b.h, b.l, b.c].every(fin));
  let session = null;
  if (anchor === 'rth') {
    session = latestRthSession(rows);
    if (!session.ok) return refuse('vwapBands', session.error, { anchor });
    if (!session.coversOpen) return refuse('vwapBands', `the bars for ${session.day} start at ${session.bars[0].t}, after the 9:30 New York open, so a session VWAP from them would be wrong`, { anchor });
    rows = session.bars;
  } else if (anchor !== 'all') {
    const from = Date.parse(anchor);
    if (!fin(from)) return refuse('vwapBands', 'the anchor must be rth, all, or a time', { anchor });
    rows = rows.filter((b) => time(b) >= from);
  }
  const weighted = rows.filter((b) => fin(b.v) && b.v > 0);
  const volume = weighted.reduce((s, b) => s + b.v, 0);
  if (!(volume > 0)) return refuse('vwapBands', rows.length ? 'the bars carry no volume, so there is no VWAP' : 'there are no bars to compute from', { anchor });
  const tp = (b) => (b.h + b.l + b.c) / 3;
  const pv = weighted.reduce((s, b) => s + tp(b) * b.v, 0);
  const vwap = pv / volume;
  // Two passes: the variance is taken around the finished VWAP, which keeps rounding error small.
  const variance = weighted.reduce((s, b) => s + b.v * (tp(b) - vwap) ** 2, 0) / volume;
  const sd = Math.sqrt(variance);
  const value = { vwap, sd };
  for (const k of [1, 2, 3]) { value[`upper${k}`] = vwap + k * sd; value[`lower${k}`] = vwap - k * sd; }
  const steps = [];
  if (session) steps.push(`session: ${session.day}, from the 9:30 New York open (${session.open}), ${plural(rows.length, 'bar')}${session.complete ? '' : ', session not finished in these bars'}`);
  if (weighted.length <= 6) {
    steps.push(`typical prices (high + low + close) ÷ 3: ${weighted.map((b) => num(tp(b), 4)).join(', ')}`);
    steps.push(`price × volume: ${weighted.map((b) => num(tp(b) * b.v, 2)).join(' + ')} = ${num(pv, 2)}`);
  } else {
    steps.push(`Σ typical price × volume over ${weighted.length} bars = ${num(pv, 2)}`);
  }
  steps.push(`volume: ${num(volume)}`);
  steps.push(`VWAP = ${num(pv, 2)} ÷ ${num(volume)} = ${num(vwap, 4)}`);
  steps.push(`σ = √(Σ volume × (typical price − VWAP)² ÷ Σ volume) = ${num(sd, 4)}`);
  steps.push(`bands: 1σ ${num(value.lower1, 2)} to ${num(value.upper1, 2)}; 2σ ${num(value.lower2, 2)} to ${num(value.upper2, 2)}; 3σ ${num(value.lower3, 2)} to ${num(value.upper3, 2)}`);
  if (rows.length > weighted.length) steps.push(`${plural(rows.length - weighted.length, 'bar')} without volume carried no weight`);
  return done('vwapBands', {
    value, values: { ...value, bars: rows.length, weightedBars: weighted.length, volume, from: rows[0]?.t || null, to: rows[rows.length - 1]?.t || null },
    formula: 'VWAP = Σ(TP × V) ÷ ΣV;  σ² = Σ V × (TP − VWAP)² ÷ ΣV;  bands = VWAP ± k × σ, k = 1, 2, 3;  TP = (H + L + C) ÷ 3',
    inputs: { anchor, bars: rows.length }, units: 'price', session,
    assumptions: 'Bar typical prices approximate the trade-by-trade VWAP; the bands describe how spread out volume was, not where price must go.',
    steps,
  });
}

/** High and low of the first `minutes` of regular hours (9:30 New York) in the latest session the bars reach. */
export function openingRange(inputs = {}) {
  const { bars = [], minutes = 15 } = inputs;
  if (!(Number.isInteger(minutes) && minutes > 0 && minutes <= 390)) return refuse('openingRange', 'the opening range must be a whole number of minutes, up to the whole session', inputs);
  const session = latestRthSession(bars);
  if (!session.ok) return refuse('openingRange', session.error, { minutes });
  if (!session.coversOpen) return refuse('openingRange', `the bars for ${session.day} start after the 9:30 New York open, so the opening range is not in them`, { minutes });
  const open = Date.parse(session.open);
  const window = session.bars.filter((b) => time(b) < open + minutes * 60_000);
  const step = session.barMinutes;
  const complete = step > 0 && time(window[window.length - 1]) + step * 60_000 >= open + minutes * 60_000;
  const high = Math.max(...window.map((b) => b.h));
  const low = Math.min(...window.map((b) => b.l));
  return done('openingRange', {
    value: { high, low, range: high - low },
    values: { high, low, range: high - low, bars: window.length, complete, day: session.day, open: session.open },
    formula: 'opening range = highest high and lowest low of the bars from 9:30 New York to 9:30 + N minutes',
    inputs: { minutes }, units: 'price',
    assumptions: `Bars are labelled by their start time; the range is final only once the ${minutes}-minute window has closed.`,
    steps: [
      `session ${session.day}, open ${session.open} (9:30 New York)`,
      `${plural(window.length, 'bar')} in the first ${minutes} minutes${complete ? '' : ', window not finished yet'}`,
      `high = ${num(high)}, low = ${num(low)}, range = ${pts(high - low)}`,
    ],
  });
}

const SESSION_WINDOWS = Object.freeze([
  // Conventions, not exchange definitions: traders draw these windows in different places.
  { id: 'asia', name: 'Asia', from: 20 * 60, to: 24 * 60 },
  { id: 'london', name: 'London', from: 2 * 60, to: 5 * 60 },
  { id: 'ny', name: 'New York regular hours', from: RTH_OPEN_MIN, to: RTH_CLOSE_MIN },
]);
export { SESSION_WINDOWS };

/** Asia, London and New York highs and lows of the latest CME day in the bars, and the previous day's high and low. */
export function sessionLevels(inputs = {}) {
  const rows = (Array.isArray(inputs.bars) ? inputs.bars : []).filter((b) => b && fin(time(b)) && [b.h, b.l].every(fin)).sort((a, b) => time(a) - time(b));
  if (!rows.length) return refuse('sessionLevels', 'there are no bars to read', {});
  const days = [...new Set(rows.map((b) => tradeDayOf(b.t)))];
  const today = days[days.length - 1];
  const hiLo = (list) => (list.length ? { high: Math.max(...list.map((b) => b.h)), low: Math.min(...list.map((b) => b.l)), bars: list.length } : null);
  const ofDay = rows.filter((b) => tradeDayOf(b.t) === today);
  const levels = {};
  for (const w of SESSION_WINDOWS) levels[w.id] = hiLo(ofDay.filter((b) => { const m = etParts(b.t).mins; return m >= w.from && m < w.to; }));
  const prev = days.length > 1 ? hiLo(rows.filter((b) => tradeDayOf(b.t) === days[days.length - 2])) : null;
  const steps = [`CME trading day ${today} (it opens at 6 p.m. New York the evening before)`];
  for (const w of SESSION_WINDOWS) steps.push(`${w.name}: ${levels[w.id] ? `high ${num(levels[w.id].high)}, low ${num(levels[w.id].low)}` : 'no bars'}`);
  steps.push(prev ? `previous day ${days[days.length - 2]}: high ${num(prev.high)}, low ${num(prev.low)}` : 'previous day: not in these bars');
  return done('sessionLevels', {
    value: { pdh: prev?.high ?? null, pdl: prev?.low ?? null, ...Object.fromEntries(Object.entries(levels).flatMap(([k, v]) => [[`${k}High`, v?.high ?? null], [`${k}Low`, v?.low ?? null]])) },
    values: { day: today, previousDay: days.length > 1 ? days[days.length - 2] : null, ...levels, previous: prev },
    formula: 'session high / low = highest high and lowest low of the bars inside the session window, New York time',
    inputs: { bars: rows.length }, units: 'price',
    assumptions: 'Asia 8 p.m. to midnight, London 2 to 5 a.m., New York 9:30 a.m. to 4 p.m., New York time: common conventions, not exchange definitions. The previous day is the CME day, 6 p.m. to 5 p.m.',
    steps,
  });
}

// ─── Price action: candles, gaps, structure, sweeps, blocks, zones ───────

/** A candle's anatomy and its volume against the average of the bars before it. */
export function candleAnatomy(inputs = {}) {
  const { o, h, l, c, v, priorVolumes = [] } = inputs;
  if (![o, h, l, c].every(fin) || h < Math.max(o, c) || l > Math.min(o, c)) return refuse('candleAnatomy', 'an open, high, low and close with the high on top and the low at the bottom are needed', inputs);
  const range = h - l;
  const body = Math.abs(c - o);
  const upper = h - Math.max(o, c);
  const lower = Math.min(o, c) - l;
  const values = { range, body, upperWick: upper, lowerWick: lower, bodyShare: range ? body / range : 0 };
  const steps = [`range = ${num(h)} − ${num(l)} = ${num(range)}`, `body = |${num(c)} − ${num(o)}| = ${num(body)}, ${pct(values.bodyShare)} of the range`, `upper wick = ${num(upper)}, lower wick = ${num(lower)}`];
  const prior = priorVolumes.filter(fin);
  if (fin(v) && prior.length) {
    const avg = prior.reduce((s, x) => s + x, 0) / prior.length;
    values.relativeVolume = avg > 0 ? v / avg : null;
    steps.push(`relative volume = ${num(v)} ÷ average ${num(avg)} of the ${prior.length} bars before = ${values.relativeVolume == null ? 'not defined' : num(values.relativeVolume, 2)}`);
  }
  return done('candleAnatomy', {
    value: values, values,
    formula: 'body = |close − open|;  upper wick = high − max(open, close);  lower wick = min(open, close) − low;  relative volume = volume ÷ average prior volume',
    inputs, units: 'price and ratio', assumptions: 'One bar of one time frame; the same move looks different on another bar size.',
    steps,
  });
}

/** Three-bar fair value gaps: bar 1's high below bar 3's low (bullish), or bar 1's low above bar 3's high (bearish). */
export function fairValueGaps(inputs = {}) {
  const { bars = [], minGap = 0 } = inputs;
  const rows = (Array.isArray(bars) ? bars : []).filter((b) => b && [b.h, b.l].every(fin));
  if (rows.length < 3) return refuse('fairValueGaps', 'a fair value gap needs at least three bars', inputs);
  const gaps = [];
  for (let j = 0; j + 2 < rows.length; j += 1) {
    const [a, , cBar] = [rows[j], rows[j + 1], rows[j + 2]];
    let gap = null;
    if (a.h < cBar.l && cBar.l - a.h >= minGap) gap = { side: 'bullish', bottom: a.h, top: cBar.l };
    else if (a.l > cBar.h && a.l - cBar.h >= minGap) gap = { side: 'bearish', bottom: cBar.h, top: a.l };
    if (!gap) continue;
    const later = rows.slice(j + 3);
    const touched = later.some((b) => (gap.side === 'bullish' ? b.l <= gap.top : b.h >= gap.bottom));
    const filled = later.some((b) => (gap.side === 'bullish' ? b.l <= gap.bottom : b.h >= gap.top));
    gaps.push({ ...gap, bar: j + 1, size: gap.top - gap.bottom, mid: (gap.top + gap.bottom) / 2, touched, filled });
  }
  const steps = gaps.length
    ? gaps.map((g) => `bars ${g.bar} to ${g.bar + 2}: ${g.side} gap from ${num(g.bottom)} to ${num(g.top)}, ${pts(g.size)}, midpoint ${num(g.mid)}; ${g.filled ? 'later filled' : g.touched ? 'later touched, not filled' : 'not touched since'}`)
    : ['no three-bar gap in these bars'];
  const first = gaps[0] || null;
  return done('fairValueGaps', {
    value: { count: gaps.length, bottom: first?.bottom ?? null, top: first?.top ?? null },
    values: { gaps },
    formula: 'bullish FVG: high of bar 1 < low of bar 3, gap = (high₁, low₃);  bearish FVG: low of bar 1 > high of bar 3, gap = (high₃, low₁)',
    inputs: { bars: rows.length, minGap }, units: 'price',
    assumptions: 'Bars in time order on one time frame; "touched" means a later bar traded into the gap, "filled" that it traded through the far side.',
    steps,
  });
}

/**
 * Breaks of structure: a close beyond the last confirmed swing high or low. A break in the
 * direction of the trend is a BOS; the first break against it is a CHOCH (change of character).
 * A swing is confirmed only `n` bars after it, so no break uses a bar that had not closed yet.
 */
export function structureBreaks(inputs = {}) {
  const { bars = [], n = 2 } = inputs;
  const rows = (Array.isArray(bars) ? bars : []).filter((b) => b && [b.h, b.l, b.c].every(fin));
  if (rows.length < 2 * n + 2) return refuse('structureBreaks', `structure needs at least ${2 * n + 2} bars at a swing size of ${n}`, inputs);
  const { highs, lows } = swings(rows, n);
  const events = [];
  let trend = 'none';
  let swingHigh = null; let swingLow = null;
  for (let i = 0; i < rows.length; i += 1) {
    // Swings confirmed by the close of bar i: the swing bar plus n bars after it.
    const h = highs.find((x) => x.i + n === i);
    const l = lows.find((x) => x.i + n === i);
    if (h) swingHigh = { price: h.price, at: h.i, broken: false };
    if (l) swingLow = { price: l.price, at: l.i, broken: false };
    const c = rows[i].c;
    if (swingHigh && !swingHigh.broken && c > swingHigh.price) {
      events.push({ bar: i + 1, type: trend === 'down' ? 'CHOCH' : 'BOS', direction: 'up', level: swingHigh.price, close: c });
      swingHigh.broken = true; trend = 'up';
    } else if (swingLow && !swingLow.broken && c < swingLow.price) {
      events.push({ bar: i + 1, type: trend === 'up' ? 'CHOCH' : 'BOS', direction: 'down', level: swingLow.price, close: c });
      swingLow.broken = true; trend = 'down';
    }
  }
  const steps = [`swing highs at ${highs.map((x) => `bar ${x.i + 1} (${num(x.price)})`).join(', ') || 'none'}; swing lows at ${lows.map((x) => `bar ${x.i + 1} (${num(x.price)})`).join(', ') || 'none'}; each confirmed ${n} bar${n === 1 ? '' : 's'} later`];
  for (const e of events) steps.push(`bar ${e.bar} closed at ${num(e.close)}, ${e.direction === 'up' ? 'above the swing high' : 'below the swing low'} ${num(e.level)}: ${e.type}${e.type === 'CHOCH' ? ', the first break against the trend' : ''}`);
  if (!events.length) steps.push('no close broke a confirmed swing');
  return done('structureBreaks', {
    value: { bos: events.filter((e) => e.type === 'BOS').length, choch: events.filter((e) => e.type === 'CHOCH').length },
    values: { events, trend, highs, lows },
    formula: 'BOS = a close beyond the last confirmed swing in the trend\'s direction;  CHOCH = the first such close against the trend',
    inputs: { bars: rows.length, n }, units: 'events',
    assumptions: `A swing high is the highest high of ${n} bars on each side (trading_lab.js swings); a close, not a wick, counts as a break; the first break, with no trend yet, counts as a BOS.`,
    steps,
  });
}

/** Sweeps of a level: a bar trades beyond it and closes back on the near side. */
export function liquiditySweeps(inputs = {}) {
  const { bars = [], level, side = 'buy' } = inputs;
  const rows = (Array.isArray(bars) ? bars : []).filter((b) => b && [b.h, b.l, b.c].every(fin));
  if (!fin(level) || !rows.length) return refuse('liquiditySweeps', 'bars and a level are needed', inputs);
  const buySide = side !== 'sell';
  const hits = [];
  rows.forEach((b, i) => {
    if (buySide ? b.h > level && b.c < level : b.l < level && b.c > level) hits.push({ bar: i + 1, extreme: buySide ? b.h : b.l, close: b.c });
  });
  const breaks = rows.filter((b) => (buySide ? b.c > level : b.c < level)).length;
  return done('liquiditySweeps', {
    value: { sweeps: hits.length, firstBar: hits[0]?.bar ?? null }, values: { hits, closesBeyond: breaks },
    formula: buySide ? 'buy-side sweep: high > level and close < level' : 'sell-side sweep: low < level and close > level',
    inputs: { level, side: buySide ? 'buy' : 'sell', bars: rows.length }, units: 'bars',
    assumptions: 'A sweep only describes what price did; whether stops were really resting there is not visible in bar data.',
    steps: hits.length
      ? hits.map((x) => `bar ${x.bar}: traded to ${num(x.extreme)}, ${buySide ? 'above' : 'below'} ${num(level)}, and closed back at ${num(x.close)}: a ${buySide ? 'buy' : 'sell'}-side sweep`)
      : [`no bar traded ${buySide ? 'above' : 'below'} ${num(level)} and closed back`],
  });
}

/** The last opposite candle before a displacement candle: its range is the order block, its middle the mean threshold. */
export function orderBlock(inputs = {}) {
  const { bars = [], minBody } = inputs;
  const rows = (Array.isArray(bars) ? bars : []).filter((b) => b && [b.o, b.h, b.l, b.c].every(fin));
  if (!(minBody > 0) || rows.length < 2) return refuse('orderBlock', 'bars and the body size that counts as a displacement are needed', inputs);
  for (let i = rows.length - 1; i >= 1; i -= 1) {
    const d = rows[i];
    if (Math.abs(d.c - d.o) < minBody) continue;
    const up = d.c > d.o;
    for (let j = i - 1; j >= 0; j -= 1) {
      const b = rows[j];
      if (up ? b.c < b.o : b.c > b.o) {
        const mid = (b.h + b.l) / 2;
        return done('orderBlock', {
          value: { high: b.h, low: b.l, mid }, values: { side: up ? 'bullish' : 'bearish', blockBar: j + 1, displacementBar: i + 1, high: b.h, low: b.l, mid },
          formula: 'order block = the range of the last opposite candle before a displacement;  mean threshold = (high + low) ÷ 2',
          inputs: { minBody, bars: rows.length }, units: 'price',
          assumptions: 'One of several definitions in use; the displacement size is a choice, and the zone is a hypothesis about where orders sat, not a record of them.',
          steps: [
            `bar ${i + 1} is the displacement: body ${pts(Math.abs(d.c - d.o))} ${up ? 'up' : 'down'}, at least ${num(minBody)}`,
            `the last ${up ? 'down' : 'up'} candle before it is bar ${j + 1}: high ${num(b.h)}, low ${num(b.l)}`,
            `${up ? 'bullish' : 'bearish'} order block ${num(b.l)} to ${num(b.h)}; mean threshold (${num(b.h)} + ${num(b.l)}) ÷ 2 = ${num(mid)}`,
          ],
        });
      }
    }
  }
  return refuse('orderBlock', 'no displacement candle with an opposite candle before it', inputs);
}

/** Premium and discount halves of a swing leg, and the 62%, 70.5% and 79% retracement levels (OTE). */
export function premiumDiscount(inputs = {}) {
  const { low, high, price, direction = 'up' } = inputs;
  if (!fin(low) || !fin(high) || !(high > low)) return refuse('premiumDiscount', 'a swing low and a higher swing high are needed', inputs);
  const range = high - low;
  const eq = low + range / 2;
  const up = direction !== 'down';
  // A leg up retraces down from its high; a leg down retraces up from its low.
  const level = (r) => (up ? high - r * range : low + r * range);
  const value = { equilibrium: eq, ote62: level(0.62), ote705: level(0.705), ote79: level(0.79) };
  const steps = [
    `leg ${num(low)} to ${num(high)}: ${pts(range)}`,
    `equilibrium = (${num(low)} + ${num(high)}) ÷ 2 = ${num(eq)}; above it is premium, below it is discount`,
    `${up ? 'leg up, retracing down from the high' : 'leg down, retracing up from the low'}: 62% = ${num(value.ote62)}, 70.5% = ${num(value.ote705)}, 79% = ${num(value.ote79)}`,
  ];
  if (fin(price)) {
    value.position = (price - low) / range;
    steps.push(`${num(price)} sits at ${pct(value.position)} of the leg: ${price > eq ? 'premium' : price < eq ? 'discount' : 'equilibrium'}`);
  }
  return done('premiumDiscount', {
    value, values: { ...value, zone: fin(price) ? (price > eq ? 'premium' : price < eq ? 'discount' : 'equilibrium') : null },
    formula: 'equilibrium = (low + high) ÷ 2;  leg up: level(r) = high − r × (high − low);  leg down: level(r) = low + r × (high − low);  OTE r = 0.62 to 0.79',
    inputs, units: 'price',
    assumptions: 'Which swing high and low anchor the leg is a judgement; a different pair gives different levels. The ratios are conventions, not measured edges.',
    steps,
  });
}

// ─── Statistics ──────────────────────────────────────────────────────────

const Z = Object.freeze({ 0.8: 1.2816, 0.9: 1.6449, 0.95: 1.96, 0.98: 2.3263, 0.99: 2.5758 });
/** z for a two-sided confidence level CHE knows, or null. */
export const zFor = (confidence) => Z[confidence] ?? null;

/** Wilson score interval of a win rate (95% by default; z configurable), from trading_evidence.js. */
export function winRateInterval(inputs = {}) {
  const { wins, n } = inputs;
  const z = fin(inputs.z) ? inputs.z : zFor(inputs.confidence ?? 0.95);
  if (!(Number.isInteger(n) && n >= 1 && Number.isInteger(wins) && wins >= 0 && wins <= n) || !(z > 0)) return refuse('winRateInterval', 'whole numbers of wins and trades, wins at most trades, and a confidence level are needed', inputs);
  const ci = wilsonInterval(wins, n, z);
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return done('winRateInterval', {
    value: { low: ci.low, high: ci.high }, values: { p, centre, half, low: ci.low, high: ci.high, z },
    formula: 'centre = (p̂ + z²/2n) ÷ (1 + z²/n);  half-width = z·√(p̂(1 − p̂)/n + z²/4n²) ÷ (1 + z²/n)',
    inputs: { wins, n, z }, units: 'win probability',
    assumptions: 'Independent trades with one fixed win probability; a regime change or clustered trades break that.',
    steps: [
      `p̂ = ${wins} ÷ ${n} = ${num(p, 4)}`,
      `z = ${z}${z === 1.96 ? ' for 95%' : ''}`,
      `centre = (${num(p, 4)} + ${num((z * z) / (2 * n), 4)}) ÷ ${num(d, 4)} = ${num(centre, 4)}`,
      `half-width = ${z} × √(${num((p * (1 - p)) / n, 5)} + ${num((z * z) / (4 * n * n), 5)}) ÷ ${num(d, 4)} = ${num(half, 4)}`,
      `range = ${pct(ci.low)} to ${pct(ci.high)}`,
    ],
  });
}

// Student's t distribution, for a mean's interval on a small sample (Numerical Recipes' incomplete beta).
function lnGamma(x) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x; const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (const c of g) ser += c / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}
function betaCf(a, b, x) {
  let c = 1; let d = 1 - ((a + b) * x) / (a + 1);
  d = 1 / (Math.abs(d) < 1e-300 ? 1e-300 : d);
  let h = d;
  for (let m = 1; m <= 300; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d; d = 1 / (Math.abs(d) < 1e-300 ? 1e-300 : d); c = 1 + aa / c; c = Math.abs(c) < 1e-300 ? 1e-300 : c; h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d; d = 1 / (Math.abs(d) < 1e-300 ? 1e-300 : d); c = 1 + aa / c; c = Math.abs(c) < 1e-300 ? 1e-300 : c;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < 3e-16) break;
  }
  return h;
}
function incBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betaCf(a, b, x)) / a : 1 - (bt * betaCf(b, a, 1 - x)) / b;
}
/** P(T ≤ t) for Student's t with `df` degrees of freedom. */
export function studentTCdf(t, df) {
  const tail = 0.5 * incBeta(df / (df + t * t), df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}
/** The t value with P(T ≤ t) = p, by bisection on the distribution (p above 0.5). */
export function tQuantile(p, df) {
  let lo = 0; let hi = 1e4;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    if (studentTCdf(mid, df) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Expectancy two ways, which must agree: win rate × average win − loss rate × average loss, and
 * the mean R. From a list of R-multiples it also gives a Student-t interval of the mean; from
 * rates alone there is no list, so no interval.
 */
export function expectancyStats(inputs = {}) {
  const { rs, confidence = 0.95 } = inputs;
  if (Array.isArray(rs)) {
    const list = rs.filter(fin);
    const n = list.length;
    if (n < 2) return refuse('expectancyStats', 'at least two trades are needed for a mean and its range', inputs);
    const wins = list.filter((x) => x > 0); const losses = list.filter((x) => x < 0);
    const W = wins.length / n; const L = losses.length / n;
    const avgWin = wins.length ? wins.reduce((s, x) => s + x, 0) / wins.length : 0;
    const avgLoss = losses.length ? -losses.reduce((s, x) => s + x, 0) / losses.length : 0;
    const formA = W * avgWin - L * avgLoss;
    const mean = list.reduce((s, x) => s + x, 0) / n;
    const sd = Math.sqrt(list.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
    const t = tQuantile(1 - (1 - confidence) / 2, n - 1);
    const half = (t * sd) / Math.sqrt(n);
    return done('expectancyStats', {
      value: { expectancy: mean, low: mean - half, high: mean + half },
      values: { n, wins: wins.length, losses: losses.length, flat: n - wins.length - losses.length, winRate: W, lossRate: L, avgWin, avgLoss, formA, mean, sd, t, half, low: mean - half, high: mean + half, method: 'Student t-interval' },
      formula: 'E = W × average win − L × average loss = mean R;  range = mean ± t(n − 1) × s ÷ √n',
      inputs: { n, confidence }, units: 'R',
      assumptions: `Student t-interval of the mean at ${Math.round(confidence * 100)}%: independent trades from one unchanging strategy; with skewed results and few trades the range is only approximate.`,
      steps: [
        `${n} trades: ${wins.length} wins, ${losses.length} losses${n - wins.length - losses.length ? `, ${n - wins.length - losses.length} flat` : ''}`,
        `form 1: W × average win − L × average loss = ${num(W, 4)} × ${num(avgWin, 4)} − ${num(L, 4)} × ${num(avgLoss, 4)} = ${signedR(formA)}`,
        `form 2: mean R = ${num(list.reduce((s, x) => s + x, 0), 4)} ÷ ${n} = ${signedR(mean)}; the two forms agree`,
        `s = ${num(sd, 4)}R; t for ${n - 1} degrees of freedom = ${num(t, 4)}`,
        `range = ${signedR(mean)} ± ${num(t, 4)} × ${num(sd, 4)} ÷ √${n} = ${signedR(mean - half)} to ${signedR(mean + half)}`,
      ],
    });
  }
  const { winRate, avgWin, avgLoss } = inputs;
  if (!(winRate >= 0 && winRate <= 1) || !(avgWin >= 0) || !(avgLoss >= 0)) return refuse('expectancyStats', 'a win rate from 0 to 1 and an average win and loss are needed', inputs);
  const e = winRate * avgWin - (1 - winRate) * avgLoss;
  return done('expectancyStats', {
    value: { expectancy: e }, values: { expectancy: e, method: 'none: no trade list, so no range' },
    formula: 'E = W × average win − (1 − W) × average loss', inputs, units: 'R or $',
    assumptions: 'No breakeven trades; a range needs the individual trades.',
    steps: [`wins: ${num(winRate, 4)} × ${num(avgWin, 4)} = ${num(winRate * avgWin, 4)}`, `losses: ${num(1 - winRate, 4)} × ${num(avgLoss, 4)} = ${num((1 - winRate) * avgLoss, 4)}`, `expectancy = ${num(e, 4)} per trade`],
  });
}

/** Gross profit ÷ gross loss of a list of trade results. */
export function profitFactor(inputs = {}) {
  const pnl = (Array.isArray(inputs.pnl) ? inputs.pnl : []).filter(fin);
  if (!pnl.length) return refuse('profitFactor', 'a list of trade results is needed', inputs);
  const won = pnl.filter((x) => x > 0).reduce((s, x) => s + x, 0);
  const lost = -pnl.filter((x) => x < 0).reduce((s, x) => s + x, 0);
  const pf = lost > 0 ? won / lost : null;
  return done('profitFactor', {
    value: pf, values: { grossProfit: won, grossLoss: lost, profitFactor: pf },
    formula: 'PF = gross profit ÷ gross loss', inputs: { trades: pnl.length }, units: 'ratio',
    assumptions: 'After costs; not defined when no trade lost.',
    steps: [`gross profit = ${usd(won)}`, `gross loss = ${usd(lost)}`, pf == null ? 'no losing trade, so the profit factor is not defined' : `profit factor = ${num(won)} ÷ ${num(lost)} = ${num(pf, 4)}`],
  });
}

/** Peak-to-trough fall of the equity curve, in dollars and, from a starting balance, in percent. */
export function maxDrawdown(inputs = {}) {
  const pnl = (Array.isArray(inputs.pnl) ? inputs.pnl : []).filter(fin);
  const start = fin(inputs.start) ? inputs.start : 0;
  if (!pnl.length) return refuse('maxDrawdown', 'a list of trade results in time order is needed', inputs);
  let equity = start; let peak = start; let worst = 0; let worstPct = 0; let at = { peak: start, trough: start };
  const curve = [];
  for (const x of pnl) {
    equity += x; curve.push(equity);
    peak = Math.max(peak, equity);
    if (peak - equity > worst) { worst = peak - equity; at = { peak, trough: equity }; }
    if (peak > 0) worstPct = Math.max(worstPct, (peak - equity) / peak);
  }
  const steps = [`equity from ${usd(start)}: ${curve.map((e) => num(e)).join(', ')}`, `largest fall: from the peak ${usd(at.peak)} to ${usd(at.trough)} = ${usd(worst)}`];
  if (start > 0) steps.push(`largest fall in percent of the peak = ${pct(worstPct, 2)}${worst > 0 ? '' : ''}`);
  return done('maxDrawdown', {
    value: start > 0 ? { dollars: worst, percent: worstPct } : { dollars: worst },
    values: { dollars: worst, percent: start > 0 ? worstPct : null, curve, peak: at.peak, trough: at.trough },
    formula: 'MDD = max over t of (peak equity up to t − equity at t);  MDD% = max over t of that fall ÷ the peak',
    inputs: { trades: pnl.length, start }, units: '$ and %',
    assumptions: 'Closed trades in time order; swings while a trade is open can make the real drawdown deeper. The deepest dollar fall and the deepest percent fall can be at different places.',
    steps,
  });
}

/** The number of trades for a win-rate margin of ±margin at confidence z (normal approximation). */
export function sampleSizeForMargin(inputs = {}) {
  const { margin, p = 0.5 } = inputs;
  const z = fin(inputs.z) ? inputs.z : zFor(inputs.confidence ?? 0.95);
  if (!(margin > 0 && margin < 1) || !(p > 0 && p < 1) || !(z > 0)) return refuse('sampleSizeForMargin', 'a margin between 0 and 1, such as 0.05 for ±5 points, is needed', inputs);
  const exact = (z * z * p * (1 - p)) / (margin * margin);
  const n = Math.ceil(exact - EPS);
  return done('sampleSizeForMargin', {
    value: n, values: { n, exact, z, p, margin },
    formula: 'n = z² × p(1 − p) ÷ margin², rounded up', inputs: { margin, p, z }, units: 'trades',
    assumptions: 'The normal approximation, with p = 0.5 as the worst case when the win rate is unknown; independent trades.',
    steps: [`n = ${z}² × ${p} × ${num(1 - p, 4)} ÷ ${margin}² = ${num(exact, 2)}`, `rounded up: ${plural(n, 'trade')} for a margin of ±${num(margin * 100)} percentage points`],
  });
}

// ─── Seeded simulation ───────────────────────────────────────────────────

/** mulberry32: a small 32-bit generator; the same seed gives the same numbers on every machine. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Nearest-rank percentile of a sorted list. */
export const percentile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];

/**
 * Monte Carlo of trade order: each path draws the trades with replacement (bootstrap) or reshuffles
 * them (replace: false), and records its equity and its maximum drawdown. Seeded, so repeatable.
 */
export function monteCarlo(inputs = {}) {
  const { seed = 1, paths = 1000, start = 0, replace = true } = inputs;
  const list = (Array.isArray(inputs.results) ? inputs.results : []).filter(fin);
  const trades = Number.isInteger(inputs.trades) && inputs.trades > 0 ? inputs.trades : list.length;
  if (list.length < 2 || !(Number.isInteger(paths) && paths >= 10 && paths <= 100000) || trades * paths > 5e6) return refuse('monteCarlo', 'at least two trade results and 10 to 100,000 paths are needed', inputs);
  if (!replace && trades !== list.length) return refuse('monteCarlo', 'a reshuffle uses every trade once, so trades must equal the list length', inputs);
  const rand = mulberry32(seed);
  const finals = []; const dds = [];
  const byStep = Array.from({ length: trades }, () => new Float64Array(paths));
  for (let p = 0; p < paths; p += 1) {
    const order = replace ? null : [...list];
    if (order) for (let i = order.length - 1; i > 0; i -= 1) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    let eq = start; let peak = start; let dd = 0;
    for (let k = 0; k < trades; k += 1) {
      eq += order ? order[k] : list[Math.floor(rand() * list.length)];
      peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq);
      byStep[k][p] = eq;
    }
    finals.push(eq); dds.push(dd);
  }
  finals.sort((a, b) => a - b); dds.sort((a, b) => a - b);
  const qs = [0.05, 0.25, 0.5, 0.75, 0.95];
  const bands = Object.fromEntries(qs.map((q) => [`p${Math.round(q * 100)}`, byStep.map((col) => percentile(Float64Array.from(col).sort(), q))]));
  const value = { finalP5: percentile(finals, 0.05), finalP50: percentile(finals, 0.5), finalP95: percentile(finals, 0.95), ddP50: percentile(dds, 0.5), ddP95: percentile(dds, 0.95) };
  return done('monteCarlo', {
    value, values: { ...value, ddMax: dds[dds.length - 1], lossPaths: finals.filter((x) => x < start).length / paths, bands, paths, trades, seed, method: replace ? 'bootstrap, with replacement' : 'reshuffle, without replacement' },
    formula: 'for each path: draw trades from the record, add them up in order, keep the final equity and the largest peak-to-trough fall; report nearest-rank percentiles',
    inputs: { results: list.length, trades, paths, seed, start, replace }, units: 'same as the results',
    assumptions: `Seeded mulberry32 generator, seed ${seed}; trades independent and drawn from the record itself, so the simulation cannot show anything the record did not contain, such as a new regime.`,
    steps: [
      `${num(paths)} paths of ${trades} trades, ${replace ? 'drawn with replacement' : 'reshuffled'} from ${list.length} results, seed ${seed}`,
      `final result: 5th percentile ${num(value.finalP5, 2)}, median ${num(value.finalP50, 2)}, 95th percentile ${num(value.finalP95, 2)}`,
      `maximum drawdown: median ${num(value.ddP50, 2)}, 95th percentile ${num(value.ddP95, 2)}, worst path ${num(dds[dds.length - 1], 2)}`,
      `${pct(finals.filter((x) => x < start).length / paths)} of paths ended below the start`,
    ],
  });
}

/**
 * Risk of ruin by seeded Monte Carlo, with a fixed dollar risk per trade: a path is ruined when its
 * equity falls to `ruinAt` within `trades` trades. With equal win and loss sizes the classic
 * gambler's-ruin formula, (q ÷ p)^units over an endless horizon, is given beside it.
 */
export function riskOfRuin(inputs = {}) {
  const { winRate, avgWinR = 1, avgLossR = 1, riskPerTrade, account, ruinAt = 0, trades = 1000, paths = 10000, seed = 1 } = inputs;
  if (!(winRate > 0 && winRate < 1) || !(avgWinR > 0) || !(avgLossR > 0) || !(riskPerTrade > 0) || !(account > ruinAt) || !(trades * paths <= 2e7)) {
    return refuse('riskOfRuin', 'a win rate between 0 and 1, win and loss sizes in R, a dollar risk per trade and an account above the ruin level are needed', inputs);
  }
  const rand = mulberry32(seed);
  let ruined = 0;
  for (let p = 0; p < paths; p += 1) {
    let eq = account;
    for (let k = 0; k < trades; k += 1) {
      eq += rand() < winRate ? avgWinR * riskPerTrade : -avgLossR * riskPerTrade;
      if (eq <= ruinAt + EPS) { ruined += 1; break; }
    }
  }
  const prob = ruined / paths;
  const se = Math.sqrt((prob * (1 - prob)) / paths);
  const units = (account - ruinAt) / riskPerTrade;
  const even = Math.abs(avgWinR - avgLossR) < EPS;
  const q = 1 - winRate;
  const classic = even ? (winRate > q ? (q / winRate) ** Math.ceil(units / avgLossR - EPS) : 1) : null;
  const steps = [
    `${num(paths)} paths of up to ${num(trades)} trades, seed ${seed}: win ${pct(winRate)} of the time for +${num(avgWinR)}R, lose ${pct(q)} for −${num(avgLossR)}R, ${usd(riskPerTrade)} a trade`,
    `ruin = equity at or below ${usd(ruinAt)}, starting from ${usd(account)}: ${num(units, 2)} losing trades of room`,
    `${num(ruined)} of ${num(paths)} paths were ruined = ${pct(prob, 2)}, give or take ${pct(1.96 * se, 2)} from simulation noise`,
  ];
  if (even) steps.push(`check, gambler's ruin with an endless horizon: (${num(q, 4)} ÷ ${num(winRate, 4)})^${Math.ceil(units / avgLossR - EPS)} = ${pct(classic, 2)}`);
  return done('riskOfRuin', {
    value: even ? { probability: prob, classic } : { probability: prob }, values: { probability: prob, standardError: se, classic, units, ruined, paths, trades, seed },
    formula: 'risk of ruin ≈ ruined paths ÷ all paths;  with equal wins and losses: (q ÷ p)^units',
    inputs: { winRate, avgWinR, avgLossR, riskPerTrade, account, ruinAt, trades, paths, seed }, units: 'probability',
    assumptions: 'Fixed dollar risk on every trade, independent trades with one fixed win rate and fixed win and loss sizes, no costs; real results vary more, so treat this as a lower bound.',
    steps,
  });
}

// ─── Verdicts: explicit criteria, one place ──────────────────────────────

/** The criteria CHE applies before calling a record of trades good or bad. */
export const VERDICT_RULES = Object.freeze({
  minTrades: 30,
  minProfitFactor: 1.2,
  text: 'Good needs at least 30 closed trades, a 95% expectancy range wholly above zero, and a profit factor above 1.2 after costs. Bad needs at least 30 trades and either a range wholly below zero, or a mean at or below zero with a profit factor under 1. Anything else is unsupported: too few trades, missing data, or a range that still includes zero.',
});

/** good, bad or unsupported for a record's statistics (from expectancyStats and profitFactor). */
export function strategyVerdict({ trades = 0, low = null, high = null, mean = null, profitFactor: pf = null } = {}) {
  const reasons = [];
  if (!(trades >= VERDICT_RULES.minTrades)) {
    reasons.push(trades ? `only ${trades} closed trades; ${VERDICT_RULES.minTrades} are the minimum` : 'no closed trades');
    return { verdict: 'unsupported', reasons };
  }
  if (fin(high) && high < 0) return { verdict: 'bad', reasons: ['the whole 95% expectancy range is below zero'] };
  if (fin(mean) && mean <= 0 && pf != null && pf < 1) return { verdict: 'bad', reasons: [`the mean is ${signedR(mean)} and the profit factor ${num(pf)} is under 1`] };
  if (fin(low) && low > 0 && pf != null && pf > VERDICT_RULES.minProfitFactor) return { verdict: 'good', reasons: [`the 95% expectancy range is above zero and the profit factor ${num(pf)} is above ${VERDICT_RULES.minProfitFactor}`] };
  if (fin(low) && low <= 0) reasons.push('the 95% expectancy range includes zero');
  if (!(pf > VERDICT_RULES.minProfitFactor)) reasons.push(`the profit factor is ${pf == null ? 'not defined' : num(pf)}, not above ${VERDICT_RULES.minProfitFactor}`);
  return { verdict: 'unsupported', reasons };
}
