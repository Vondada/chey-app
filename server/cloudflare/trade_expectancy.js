// Hypothetical trading expectancy: the owner gives the trade figures in the message ("70 wins averaging $4 and 30 losses
// averaging $15"), and CHE calculates from those figures alone. It never reads the paper journal for them, and it never
// stands in for the owner's real results. A message about "my" or "our" trades, or the journal, is not hypothetical.
//
// Expectancy per trade = win rate x average win - loss rate x average loss. A win rate on its own says nothing about
// profit: the average size of the wins and losses decides it, so the break-even win rate is shown next to the win rate.

import { evaluate, formatRational, parseDecimal } from './arithmetic.js';

// Words that mean the message asks about the owner's own records, not about figures it supplies.
const OWN_RECORDS = /\b(?:my|our|mine|ours|CHE'?s|the journal|paper journal|the evidence pass|evidence pass|so far|right now|today|recorded|actual|real results?)\b/i;

const AMOUNT = '\\$?(\\d+(?:\\.\\d+)?)';

/** Reads the figures the message gives. A figure that is not stated stays null; nothing is inferred. */
export function parseTradeFigures(text = '') {
  const s = String(text).replace(/,(?=\d{3}\b)/g, '').replace(/’/g, "'");
  const figure = (re) => { const m = re.exec(s); return m ? m : null; };
  const trades = figure(/\b(\d+)\s+(?:paper\s+|hypothetical\s+|simulated\s+)?trades?\b/i);
  // "70 wins averaging $4 each", "30 losses at $15 each", "45 winning trades averaging $10"
  const winCount = figure(new RegExp(`\\b(\\d+)\\s+(?:winning trades?|wins?|winners?)\\b[^.;]{0,40}?\\b(?:averag\\w*|at|of|each of|worth)\\s+${AMOUNT}`, 'i'));
  const lossCount = figure(new RegExp(`\\b(\\d+)\\s+(?:losing trades?|losses?|losers?)\\b[^.;]{0,40}?\\b(?:averag\\w*|at|of|each of|worth)\\s+${AMOUNT}`, 'i'));
  // "wins $4 and loses $15", "a $4 average win"
  const winAmount = figure(new RegExp(`\\bwins?\\b[^.;$]{0,30}?${AMOUNT}|${AMOUNT}\\s+(?:average\\s+)?wins?\\b`, 'i'));
  const lossAmount = figure(new RegExp(`\\b(?:loses?|losses?|losing|loss)\\b[^.;$]{0,30}?${AMOUNT}|${AMOUNT}\\s+(?:average\\s+)?(?:losses?|losing)\\b`, 'i'));
  const rate = figure(/(\d+(?:\.\d+)?)\s*%\s*(?:win rate|win-rate|win ratio|winning trades)|win[- ]rate\s*(?:of|is|at|:)?\s*(\d+(?:\.\d+)?)\s*%/i);
  const num = (m, i = 1) => (m && m[i] != null ? Number(m[i]) : null);
  return {
    trades: num(trades),
    winCount: num(winCount),
    winAvg: winCount ? Number(winCount[2]) : num(winAmount),
    lossCount: num(lossCount),
    lossAvg: lossCount ? Number(lossCount[2]) : num(lossAmount),
    winRatePct: rate ? Number(rate[1] ?? rate[2]) : null,
  };
}

/** A decimal when it reads back to the same exact value, else the fraction. Nothing is rounded. */
function show(r) {
  if (r.d === 1n) return r.n.toString();
  const shown = formatRational(r);
  try {
    const back = parseDecimal(shown);
    if (back.n === r.n && back.d === r.d) return shown;
  } catch (_) { /* not a plain decimal */ }
  return `${r.n}/${r.d}`;
}

const approx = (n, d) => (Number(n) / Number(d)).toFixed(2);

/** Dollars to the cent when the value is a whole number of cents; otherwise a rounded figure with the exact fraction. */
function money(r) {
  const neg = r.n < 0n ? '-' : '';
  const n = r.n < 0n ? -r.n : r.n;
  if ((n * 100n) % r.d === 0n) {
    const cents = (n * 100n) / r.d;
    return `${neg}$${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
  }
  return `${neg}$${approx(n, r.d)} (exactly ${neg}${n}/${r.d} dollars)`;
}

/** A percentage: exact when it terminates, else rounded to two places with the exact fraction. */
function percent(r) {
  const shown = show(r);
  return /\//.test(shown) ? `${approx(r.n, r.d)}% (exactly ${shown}%)` : `${shown}%`;
}

/**
 * The expectancy of the figures the message gives, or null when the message is not a hypothetical trade calculation.
 * Returns { status, ... }:
 *   verified      the figures are complete and consistent; expectancy, total and break-even are exact
 *   needs_inputs  a trade figure is missing (the answer names it); no figure is invented
 *   conflict      the figures contradict each other (counts that do not add up, or a stated win rate that differs)
 */
export function tradeExpectancy(text = '') {
  const s = String(text);
  if (OWN_RECORDS.test(s)) return null;
  const f = parseTradeFigures(s);
  const winSide = f.winCount != null || f.winAvg != null;
  const lossSide = f.lossCount != null || f.lossAvg != null;
  const asksProfit = /\b(?:expect\w*|profit\w*|keep running|keep (?:it|this|that) running|worth (?:running|keeping)|break ?even|win rate|should i)\b/i.test(s);
  // A hypothetical needs figures on both sides, or a win rate with both amounts; a bare "win rate" question stays elsewhere.
  if (!(winSide && lossSide) && !(f.winRatePct != null && (f.winAvg != null || f.lossAvg != null)) || !asksProfit) return null;

  const missing = [];
  if (f.winAvg == null) missing.push('the average win in dollars');
  if (f.lossAvg == null) missing.push('the average loss in dollars');
  if (f.winCount == null && f.winRatePct == null) missing.push('how many trades were wins (or the win rate)');
  if (f.lossCount == null && f.winRatePct == null) missing.push('how many trades were losses (or the win rate)');
  if (missing.length) {
    return { status: 'needs_inputs', missing, text: `To calculate the expectancy I need ${missing.join(', ')}, sir. I will not guess them, and I will not use the paper journal for a hypothetical.` };
  }

  // Counts win/loss directly. A win rate alone is enough when the counts are not given.
  let wins = f.winCount;
  let losses = f.lossCount;
  let trades = f.trades ?? (wins != null && losses != null ? wins + losses : null);
  if (wins != null && losses != null) {
    if (trades != null && wins + losses !== trades) {
      return { status: 'conflict', text: `The figures conflict, sir: ${wins} wins and ${losses} losses make ${wins + losses} trades, not ${trades}. I will not calculate until the counts agree.` };
    }
    if (f.winRatePct != null && Math.abs((100 * wins) / (wins + losses) - f.winRatePct) > 0.05) {
      return { status: 'conflict', text: `The figures conflict, sir: ${wins} wins out of ${wins + losses} is ${(100 * wins / (wins + losses)).toFixed(1)}%, not the ${f.winRatePct}% stated. I will not calculate until they agree.` };
    }
  }

  const expression = wins != null && losses != null
    ? `(${wins}*${f.winAvg}-${losses}*${f.lossAvg})/${wins + losses}`
    : `(${f.winRatePct}/100)*${f.winAvg}-(1-${f.winRatePct}/100)*${f.lossAvg}`;
  const per = evaluate(expression);
  const winRate = wins != null && losses != null
    ? evaluate(`${wins}*100/${wins + losses}`)
    : evaluate(`${f.winRatePct}`);
  const breakEvenPct = evaluate(`${f.lossAvg}*100/(${f.winAvg}+${f.lossAvg})`);
  const total = trades != null ? evaluate(`(${expression})*${trades}`) : null;
  const profitable = per.n > 0n;

  const summary = [
    `Expected profit per trade: ${money(per)}${per.n < 0n ? ' (a loss)' : ''} before any costs.`,
    total ? `Over ${trades} trades that is ${money(total)} (${wins != null ? `${wins}×$${f.winAvg} − ${losses}×$${f.lossAvg}` : `${trades} × ${money(per)}`}).` : null,
    `The win rate is ${percent(winRate)}, and it does not decide profit: each win averages $${f.winAvg} and each loss averages $${f.lossAvg}.`,
    `The break-even win rate at these sizes is ${percent(breakEvenPct)} (loss ÷ (win + loss)). The strategy ${profitable ? 'clears it' : `needs ${percent(breakEvenPct)} or more to break even`}.`,
    `Keep running it? ${profitable ? 'Not on these figures alone: the expectancy is positive, but it still needs costs and out-of-sample evidence.' : 'Not on these figures: it loses money on average, and a higher win rate would not fix it unless the payoff changes.'}`,
    'What the win rate hides: the size of the losses against the wins, the costs and slippage (not in these figures), how many trades the average is based on, and the period it covers.',
    'Evidence still needed: each trade result with its costs; the spread (standard deviation) of results, so the expectancy has a range, not a single number; an out-of-sample period the rule was not tuned on; and the largest run of losses (drawdown).',
  ].filter(Boolean).join(' ');
  return { status: 'verified', expectancy: money(per), total: total ? money(total) : null, win_rate_pct: percent(winRate), break_even_pct: percent(breakEvenPct), profitable, text: summary };
}
