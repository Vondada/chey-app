#!/usr/bin/env node
// Before/after replay of CHE's forward paper desks on real bars: every forward-paper portfolio (trading_live.liveSpecs
// for MNQ 5m, crypto_markets.cryptoSpecs for BTC/ETH) runs twice on the same bars, once with the rules it traded under
// until 2026-10-28 and once with the trade-quality rules (trading_evidence.QUALITY_RULES: costs at most 0.25 R of the
// risk, a target hit nets at least 1 R, a 30-minute wait after a stop-out). The rules are fixed numbers from the cost
// arithmetic, not fitted to these bars. Results are split into the first 70% and last 30% of the bars so a reader can
// see whether a difference holds in both halves. Paper research only: no order, no account, nothing stored.
// Used by .github/workflows/che-strategy-backtest.yml because hosted runners can reach Yahoo and Coinbase.
//
//   node tools/che_quality_replay.mjs [--json out.json]
import { appendFileSync, writeFileSync } from 'node:fs';
import { acquireDataset } from '../server/cloudflare/trading_research.js';
import { CRYPTO_COSTS, COINS, TIMEFRAMES, cryptoSpecs, fetchCoinbaseCandles } from '../server/cloudflare/crypto_markets.js';
import { liveSpecs } from '../server/cloudflare/trading_live.js';
import { QUALITY_RULES, intradayContext, newPortfolio, stepPortfolio } from '../server/cloudflare/trading_evidence.js';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const out = arg('json', null);
const mem = new Map();
const storage = {
  async get(k) { return Array.isArray(k) ? new Map(k.filter((x) => mem.has(x)).map((x) => [x, mem.get(x)])) : mem.get(k); },
  async put(k, v) { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) mem.set(a, b); else mem.set(k, v); },
};

/** Totals for a list of closed trade records. */
export function tally(trades) {
  const n = trades.length;
  const wins = trades.filter((t) => t.net_pnl > 0).length;
  const net = trades.reduce((s, t) => s + t.net_pnl, 0);
  const r = trades.reduce((s, t) => s + (t.r_net || 0), 0);
  const costs = trades.reduce((s, t) => s + Object.values(t.costs || {}).reduce((a, b) => a + b, 0), 0);
  return { trades: n, wins, win_rate: n ? wins / n : null, net_pnl: Math.round(net * 100) / 100, expectancy_r: n ? r / n : null, costs: Math.round(costs * 100) / 100 };
}

/** Runs one desk's portfolios on the bars with and without the rules; returns totals for both halves. */
export function replay(bars, portfolios) {
  const ctx = intradayContext(bars);
  const cut = bars[Math.floor(bars.length * 0.7)]?.t;
  const result = {};
  for (const variant of ['before', 'after']) {
    const trades = [];
    let skipped = 0;
    for (const make of portfolios) {
      const pf = make(variant === 'after');
      trades.push(...stepPortfolio(pf, bars, ctx));
      skipped += pf.counts.poor_plans || 0;
    }
    result[variant] = {
      all: tally(trades), first_70: tally(trades.filter((t) => t.entry.time < cut)), last_30: tally(trades.filter((t) => t.entry.time >= cut)), skipped_by_rules: skipped,
    };
  }
  return { bars: bars.length, from: bars[0]?.t, to: bars.at(-1)?.t, split_at: cut, ...result };
}

const params = (spec, quality) => ({ target_r: spec.target_r, ...(quality ? { quality: QUALITY_RULES } : {}) });

async function coinbase(coin, tf, want = 3000) {
  const g = TIMEFRAMES[tf] * 1000; const seen = new Map(); const now = Date.now();
  let end = now - (now % g);
  for (let page = 0; seen.size < want && page < Math.ceil(want / 300) + 2; page++) {
    const rows = await fetchCoinbaseCandles(coin, tf, { now, end });
    if (!rows.length) break;
    for (const b of rows) seen.set(b.t, b);
    end = Date.parse(rows[0].t);
    await new Promise((r) => setTimeout(r, 250));
  }
  return [...seen.values()].sort((a, b) => a.t.localeCompare(b.t)).slice(-want);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const desks = [];
  try {
    const data = await acquireDataset(storage, { market: 'MNQ', tf: '5m' });
    if (!data.ok) desks.push({ desk: 'MNQ 5m', ok: false, reason: data.reason });
    else {
      desks.push({ desk: 'MNQ 5m', ok: true, source: 'Yahoo MNQ=F 5-minute (public, delayed)', ...replay(data.bars, liveSpecs().map((spec) => (q) => newPortfolio(spec.c, spec.f, { contract: 'MNQ', qty: 1, source: 'backtest', resolution: '5m', params: params(spec, q) }))) });
    }
  } catch (e) { desks.push({ desk: 'MNQ 5m', ok: false, reason: String(e?.message || e).slice(0, 200) }); }
  for (const coin of Object.keys(COINS)) {
    for (const tf of Object.keys(TIMEFRAMES)) {
      try {
        const bars = await coinbase(coin, tf);
        if (bars.length < 300) { desks.push({ desk: `${coin} ${tf}`, ok: false, reason: `only ${bars.length} candles` }); continue; }
        desks.push({ desk: `${coin} ${tf}`, ok: true, source: `Coinbase Exchange ${COINS[coin].product} ${tf}`, ...replay(bars, cryptoSpecs().map((spec) => (q) => newPortfolio(spec.c, spec.f, { contract: coin, qty: COINS[coin].qty, source: 'backtest', resolution: tf, costs: CRYPTO_COSTS[coin], params: params(spec, q) }))) });
      } catch (e) { desks.push({ desk: `${coin} ${tf}`, ok: false, reason: String(e?.message || e).slice(0, 200) }); }
    }
  }
  const report = { at: new Date().toISOString(), rules: QUALITY_RULES, paper_only: true, desks };
  if (out) writeFileSync(out, JSON.stringify(report, null, 2));
  const f = (x, d = 2) => (x == null || !Number.isFinite(x) ? '—' : Number(x).toFixed(d));
  const row = (label, t) => `| ${label} | ${t.trades} | ${f(t.win_rate == null ? null : 100 * t.win_rate, 1)}% | ${f(t.expectancy_r, 3)} | ${f(t.net_pnl)} | ${f(t.costs)} |`;
  const lines = ['## CHE trade-quality replay (real bars, paper research only)', '',
    `Rules: costs ≤ ${QUALITY_RULES.max_cost_r} R, target nets ≥ ${QUALITY_RULES.min_target_net_r} R, ${QUALITY_RULES.stop_cooldown_min}-minute wait after a stop-out. Not fitted to these bars.`, ''];
  for (const d of desks) {
    lines.push(`### ${d.desk}`);
    if (!d.ok) { lines.push(`Not run: ${d.reason}`, ''); continue; }
    lines.push(`${d.source}: ${d.bars} bars, ${d.from} to ${d.to}; the last 30% starts ${d.split_at}. Setups refused by the rules: ${d.after.skipped_by_rules}.`, '',
      '| Variant | Trades | Win rate | Exp. R | Net $ | Costs $ |', '|---|---|---|---|---|---|',
      row('before, all', d.before.all), row('after, all', d.after.all),
      row('before, first 70%', d.before.first_70), row('after, first 70%', d.after.first_70),
      row('before, last 30%', d.before.last_30), row('after, last 30%', d.after.last_30), '');
  }
  const text = lines.join('\n');
  console.log(text);
  for (const d of desks) if (d.ok) console.log(`replay ${d.desk}: before ${JSON.stringify(d.before.all)} after ${JSON.stringify(d.after.all)} last30 before ${JSON.stringify(d.before.last_30)} after ${JSON.stringify(d.after.last_30)}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}
