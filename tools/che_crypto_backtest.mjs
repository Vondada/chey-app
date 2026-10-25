#!/usr/bin/env node
// Backtest CHE's crypto paper strategies (crypto_markets.backtestSeries) on real Coinbase Exchange candles fetched on
// the GitHub runner, because Coinbase and Kraken refuse the cloud dev sandbox. The same engine the Worker's research
// step runs: Coinbase fees and slippage on every fill, a 70/30 out-of-sample split, walk-forward folds and the
// look-ahead (leakage) audit. Nothing is invented: a fetch that fails is reported as such, and no number is printed
// for a series without bars. Used by .github/workflows/che-crypto-backtest.yml (informational, never gates a merge).
//
//   node tools/che_crypto_backtest.mjs [--coins BTC,ETH] [--tfs 5m,15m,1h] [--bars 3000] [--json out.json]
import { appendFileSync, writeFileSync } from 'node:fs';
import { COINS, TIMEFRAMES, backtestSeries, fetchCoinbaseCandles } from '../server/cloudflare/crypto_markets.js';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const coins = arg('coins', Object.keys(COINS).join(',')).split(',').filter((c) => COINS[c]);
const tfs = arg('tfs', Object.keys(TIMEFRAMES).join(',')).split(',').filter((t) => TIMEFRAMES[t]);
const want = Number(arg('bars', '3000'));
const out = arg('json', null);
const PAGE = 300;

/** Up to [want] closed candles, newest page first, joined oldest first with duplicates removed. */
async function history(coin, tf, now) {
  const g = TIMEFRAMES[tf] * 1000;
  const seen = new Map();
  let end = now - (now % g);
  for (let page = 0; seen.size < want && page < Math.ceil(want / PAGE) + 2; page++) {
    const rows = await fetchCoinbaseCandles(coin, tf, { now, end });
    if (!rows.length) break;
    for (const b of rows) seen.set(b.t, b);
    end = Date.parse(rows[0].t);
    await new Promise((r) => setTimeout(r, 250)); // Coinbase's public rate limit
  }
  return [...seen.values()].sort((a, b) => a.t.localeCompare(b.t)).slice(-want);
}

const now = Date.now();
const results = [];
for (const coin of coins) {
  for (const tf of tfs) {
    try {
      const bars = await history(coin, tf, now);
      if (bars.length < 300) { results.push({ coin, tf, ok: false, bars: bars.length, reason: `only ${bars.length} candles returned; the research needs at least 300` }); continue; }
      results.push({ coin, tf, ok: true, source: `Coinbase Exchange ${COINS[coin].product} ${tf} candles (public, no account)`, bars: bars.length, from: bars[0].t, to: bars.at(-1).t, strategies: backtestSeries(coin, tf, bars) });
    } catch (e) {
      results.push({ coin, tf, ok: false, reason: String(e?.message || e).slice(0, 200) });
    }
  }
}

const report = { at: new Date(now).toISOString(), engine: 'crypto_markets.backtestSeries', costs: 'Coinbase taker fees and slippage on every fill (as the paper journal)', paper_only: true, results };
if (out) writeFileSync(out, JSON.stringify(report, null, 2));

const n = (x, d = 2) => (x == null || !Number.isFinite(x) ? '—' : Number(x).toFixed(d));
const lines = ['## CHE crypto backtest (real Coinbase candles, paper research only)', '',
  'Fees and slippage on every fill; out-of-sample is the last 30% of the bars; look-ahead audited. No profit is promised.', ''];
for (const r of results) {
  lines.push(`### ${r.coin} ${r.tf}`);
  if (!r.ok) { lines.push(`Not run: ${r.reason}`, ''); continue; }
  lines.push(`${r.source}: ${r.bars} candles, ${r.from} to ${r.to}.`, '',
    '| Strategy | Trades | Exp. R | PF | Net $ | Costs $ | OOS trades | OOS exp. R | Folds + | Look-ahead |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const s of r.strategies) lines.push(`| ${s.name} | ${s.trades} | ${n(s.expectancy_r, 3)} | ${n(s.profit_factor)} | ${n(s.net_pnl)} | ${n(s.costs_paid)} | ${s.oos_trades} | ${n(s.oos_expectancy_r, 3)} | ${s.folds_positive}/${s.folds} | ${s.look_ahead} |`);
  lines.push('');
}
const text = lines.join('\n');
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
if (!results.some((r) => r.ok)) process.exit(2);
