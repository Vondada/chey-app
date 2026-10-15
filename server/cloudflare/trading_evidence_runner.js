// Runs the forward-paper evidence for NQ/MNQ and answers the owner's questions from
// what was recorded. The engine (trading_evidence.js) does the arithmetic; this module
// fetches candles, keeps the isolated portfolios and the run log, and writes the answer.
// Nothing here calls a model. Trading_lab's own paper book is left as it was.

import { loadCandles } from './trading_lab.js';
import { chicagoDayKey } from './chicago_time.js';
import {
  CANDIDATES, FILTERS, COSTS, MIN_TRADES, candleProblems, causalContext, newPortfolio, stepPortfolio,
  appendTrades, readTrades, summarize, evaluateWalkForward, promotionVerdict, validateTradeRecord,
} from './trading_evidence.js';

export const EVIDENCE_PORTFOLIOS = 'evidence_portfolios';
export const EVIDENCE_RUNS = 'evidence_runs';
export const EVIDENCE_SYMBOL = 'nq.f';
export const PRICE_SERIES = 'Stooq NQ futures, daily history (delayed)';
const RUN_LOG_LIMIT = 50;

const SPEC = { contract: 'MNQ', qty: 1, source: 'paper', resolution: 'daily', priceSeries: PRICE_SERIES };

// Every candidate × filter gets its own portfolio. Saved state is keyed by the portfolio
// key, which includes the strategy version, so a change of rules or costs starts a new one.
export async function readPortfolios(storage) {
  const saved = (await storage.get(EVIDENCE_PORTFOLIOS)) || {};
  const out = [];
  for (const c of Object.keys(CANDIDATES)) {
    for (const f of Object.keys(FILTERS)) {
      const fresh = newPortfolio(c, f, SPEC);
      out.push(saved[fresh.key] || fresh);
    }
  }
  return out;
}

async function savePortfolios(storage, portfolios) {
  const saved = (await storage.get(EVIDENCE_PORTFOLIOS)) || {};
  for (const pf of portfolios) saved[pf.key] = pf;
  await storage.put(EVIDENCE_PORTFOLIOS, saved);
}

// One evidence pass at most hourly. Each run is logged, including failed ones.
// Order matters: trades are journalled before portfolio state is saved. If the save fails,
// the next run rebuilds the same trades, and identical records are skipped as duplicates.
export async function evidenceTick(storage, { fetcher = fetch, now = Date.now(), force = false, load = loadCandles } = {}) {
  const runs = (await storage.get(EVIDENCE_RUNS)) || [];
  const last = runs[runs.length - 1];
  if (!force && last && now - Date.parse(last.at) < 55 * 60_000) return { ...last, skipped: 'ran within the hour' };
  const run = { at: new Date(now).toISOString(), symbol: EVIDENCE_SYMBOL, price_series: PRICE_SERIES, ok: false };
  try {
    const data = await load(EVIDENCE_SYMBOL, { fetcher });
    if (data.error) {
      run.error = data.error;
    } else {
      const problems = candleProblems(data.candles);
      if (problems.length) {
        run.error = `data refused: ${problems.join('; ')}`;
      } else {
        const ctx = causalContext(data.candles);
        const portfolios = await readPortfolios(storage);
        const closed = [];
        for (const pf of portfolios) closed.push(...stepPortfolio(pf, data.candles, ctx));
        // Each trade is checked on its own. A refused trade is logged with its reason, and it never
        // blocks the rest or stops the portfolio state from saving (which would repeat the same failure).
        const valid = [];
        const rejected = [];
        for (const t of closed) {
          const problems = validateTradeRecord(t);
          if (problems.length) rejected.push({ portfolio: t.portfolio, entry: t.entry.time, problems });
          else valid.push(t);
        }
        const journal = await appendTrades(storage, valid);
        await savePortfolios(storage, portfolios);
        Object.assign(run, {
          ok: true,
          bars: data.candles.length,
          last_bar: data.candles[data.candles.length - 1].t,
          closed: closed.length,
          journal,
          rejected: rejected.length,
          rejections: rejected.slice(0, 5),
          open_positions: portfolios.filter((pf) => pf.open).length,
        });
      }
    }
  } catch (error) {
    run.error = String(error?.message || error).slice(0, 200);
  }
  await storage.put(EVIDENCE_RUNS, [...runs, run].slice(-RUN_LOG_LIMIT));
  return run;
}

// The owner's questions, in plain words. Narrow on purpose: a general trading question
// still goes to the existing trading routes.
export function evidenceIntent(message) {
  const text = String(message || '');
  if (!/\b(?:paper|trad\w*|NQ|MNQ|nasdaq|futures|strateg\w*|win rate|profit\w*)\b/i.test(text)) return null;
  const asks = /\bhow many\b[\s\S]{0,40}\btrades?\b|\bwin rate\b|\bwhich\b[\s\S]{0,60}\bstrateg\w*\b|\b(?:consistently|consistent)\b[\s\S]{0,30}\bprofit\w*|\bare you (?:becoming|getting)\b|\bmeasured\b[\s\S]{0,40}\b(?:trades?|results?|win)/i;
  return asks.test(text) ? { kind: 'evidence' } : null;
}

const pct = (x) => (x == null ? 'not measured' : `${x}%`);
const money = (x) => (x == null ? 'not measured' : `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`);
const R = (x) => (x == null ? 'not measured' : `${x.toFixed(2)} R`);

// The answer to "how many paper trades today, what is the measured win rate, which strategy
// performed best, and are you becoming more consistently profitable". Every number comes from
// recorded trades or run logs. Where a number cannot be measured yet, the answer says so.
export async function evidenceReport(storage, { now = Date.now() } = {}) {
  const trades = await readTrades(storage, (t) => t.environment === 'paper');
  const portfolios = await readPortfolios(storage);
  const runs = (await storage.get(EVIDENCE_RUNS)) || [];
  const okRuns = runs.filter((r) => r.ok);
  const lastOk = okRuns[okRuns.length - 1] || null;
  const failed = runs.length - okRuns.length;
  const today = chicagoDayKey(now);
  const takenToday = trades.filter((t) => String(t.entry.time).slice(0, 10) === today);
  const overall = summarize(trades);
  const open = portfolios.filter((pf) => pf.open).length;

  const lines = [];
  if (!runs.length) {
    return 'No trading evidence has been recorded yet, sir. The first evidence pass has not run. I will report only what is recorded.';
  }

  lines.push(`Paper trades, from recorded evidence only (paper, no real money).`);
  lines.push('');
  lines.push(`1. Taken today (${today}): ${takenToday.length}.${takenToday.length ? '' : ' Daily bars are dated by the day a trade entered, and no entry is dated today.'}`);
  lines.push(`   Recorded in total: ${trades.length} (${overall.wins} wins, ${overall.losses} losses, ${overall.flat} flat). Open now: ${open}.`);

  lines.push('');
  lines.push(`2. Measured win rate: ${pct(overall.win_rate)}${overall.win_rate_95ci ? ` (95% range ${pct(overall.win_rate_95ci.low)} to ${pct(overall.win_rate_95ci.high)})` : ''}, from ${overall.trades} trades.`);
  if (overall.sample !== 'adequate') lines.push(`   Sample is ${overall.sample}: ${MIN_TRADES} trades are the minimum before a rate means anything.`);
  lines.push(`   Net after assumed costs: ${money(overall.net_pnl)}. Costs paid: ${money(overall.costs_paid)}. Profit factor: ${overall.profit_factor ?? (overall.trades ? 'no losing trades' : 'not measured')}.`);

  lines.push('');
  const groups = {};
  for (const t of trades) (groups[t.portfolio] ||= []).push(t);
  const ranked = Object.values(groups).map((list) => {
    const s = summarize(list);
    const name = `${CANDIDATES[list[0].strategy].name}, ${FILTERS[list[0].filter].name}`;
    return { name, s };
  }).sort((a, b) => b.s.expectancy_r - a.s.expectancy_r);
  const eligible = ranked.filter((r) => r.s.trades >= MIN_TRADES);
  if (!ranked.length) {
    lines.push('3. Best strategy: none yet. No paper strategy has closed a trade.');
  } else if (eligible.length) {
    const best = eligible[0];
    lines.push(`3. Best strategy so far: ${best.name}, ${best.s.trades} trades, ${R(best.s.expectancy_r)} per trade (95% range ${R(best.s.expectancy_r_95ci.low)} to ${R(best.s.expectancy_r_95ci.high)}), net ${money(best.s.net_pnl)}.`);
  } else {
    const lead = ranked[0];
    lines.push(`3. Best strategy: not decided. No strategy has ${MIN_TRADES} trades yet. Leading so far: ${lead.name}, ${lead.s.trades} trades, ${R(lead.s.expectancy_r)} per trade, which is not a measured result.`);
  }
  for (const r of ranked.slice(0, 3)) lines.push(`   ${r.name}: ${r.s.trades} trades, win rate ${pct(r.s.win_rate)}, net ${money(r.s.net_pnl)}.`);

  lines.push('');
  const wf = evaluateWalkForward(trades, { folds: 4, minTrain: 0.4 });
  const verdict = promotionVerdict(wf.oos, { resolution: 'daily', foldsPositive: wf.folds_positive, folds: wf.folds_total });
  const consistent = verdict.promote;
  lines.push(`4. More consistently profitable? ${consistent ? 'Shown, by the promotion test.' : 'Not shown yet.'}`);
  lines.push(`   Walk-forward folds profitable: ${wf.folds_positive} of ${wf.folds_total}.`);
  for (const reason of verdict.reasons.slice(0, 4)) lines.push(`   - ${reason}.`);

  lines.push('');
  lines.push('Data and assumptions:');
  lines.push(`- Source: ${PRICE_SERIES}. Approximate: fills at the next daily open, stop-first when a bar touches both levels.`);
  lines.push(`- Last successful data: ${lastOk ? `bar ${lastOk.last_bar}, run ${lastOk.at}` : 'none yet'}. Failed runs logged: ${failed}.`);
  lines.push(`- Costs assumed per side: spread ${COSTS.spreadTicks} tick, slippage ${COSTS.slippageTicks} tick, commission $${COSTS.commissionPerSide}, fees $${COSTS.feePerSide} per MNQ contract.`);
  lines.push('- Not connected yet: intraday NQ data, so the 8:30 and 9:30 sessions are not tested.');
  return lines.join('\n');
}
