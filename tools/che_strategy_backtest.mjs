#!/usr/bin/env node
// Backtest every written intraday strategy on the same real bars and print one comparison table.
// The bars come from CHE's own acquisition loop (trading_research.acquireDataset: Yahoo Finance, public, DELAYED);
// nothing is invented, and the data's coverage is printed with the results. Used by
// .github/workflows/che-strategy-backtest.yml because hosted runners can reach the data sources.
//
//   node tools/che_strategy_backtest.mjs [--market MNQ] [--tf 5m] [--json out.json]
import { writeFileSync, appendFileSync } from 'node:fs';
import { acquireDataset, evaluateUnit, runEngine, strategyDefinitions } from '../server/cloudflare/trading_research.js';
import { intradayContext, overnightStats, p2p86Plan } from '../server/cloudflare/trading_evidence.js';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const market = arg('market', 'MNQ'); const tf = arg('tf', '5m'); const out = arg('json', null);

// The Durable Object storage calls the research module uses: put(object), get(key) and get([keys]) → Map.
const mem = new Map();
const storage = {
  async get(k) { return Array.isArray(k) ? new Map(k.filter((x) => mem.has(x)).map((x) => [x, mem.get(x)])) : mem.get(k); },
  async put(k, v) { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) mem.set(a, b); else mem.set(k, v); },
};

const data = await acquireDataset(storage, { market, tf });
if (!data.ok) { console.error(`No data: ${data.reason}`); process.exit(2); }
const { manifest, bars } = data;
const rows = [];
for (const def of strategyDefinitions().filter((d) => d.timeframes.includes(tf))) {
  const unit = evaluateUnit({ strategyId: def.strategy_id, market, tf, bars, manifest });
  if (!unit.ok) continue;
  const raw = runEngine(def.strategy_id, bars, tf, { market });
  const net = raw.reduce((a, t) => a + (t.net_pnl || 0), 0);
  rows.push({ id: def.strategy_id, name: def.name, ...unit.all, oos_trades: unit.oos.trades, oos_expectancy_r: unit.oos.expectancy_r, net_usd: Math.round(net * 100) / 100, look_ahead: unit.look_ahead });
}
rows.sort((a, b) => (b.expectancy_r ?? -99) - (a.expectancy_r ?? -99));
const on = overnightStats(bars);
// Why the 86-style approximation did or did not trade each day: its stage and reason on the first bar where the
// day's setup resolved (or at 11:00), counted, so a rule that rarely fires shows where it stops.
const x = intradayContext(bars);
const outcome = new Map();
for (let i = 1; i < bars.length; i++) {
  if (outcome.has(x.day[i]) || x.et[i] < 9 * 60 + 35 || x.et[i] > 11 * 60) continue;
  const p = p2p86Plan(bars, i, x);
  if (['triggered', 'invalidated', 'target_taken', 'expired', 'no_bias'].includes(p.stage)) {
    const why = p.stage === 'triggered' ? (p.signal ? 'triggered: traded' : `triggered, skipped: ${/1R/.test(p.reason) ? 'target under 1R' : 'risk outside 6–60 points'}`) : p.stage;
    outcome.set(x.day[i], why);
  }
}
const why86 = {};
for (const v of outcome.values()) why86[v] = (why86[v] || 0) + 1;
const fmt = (v, d = 2) => (v == null ? '—' : typeof v === 'number' ? v.toFixed(d) : String(v));
const lines = [
  `## ${market} ${tf} backtest on real bars`,
  '',
  `Data: ${manifest.provider} (${manifest.symbol}), ${manifest.first} → ${manifest.last}, ${bars.length} bars, sha256 ${String(manifest.sha256).slice(0, 12)}. DELAYED public data; costs: CHE NORMAL profile (spread, slippage, commission, fees). 1 contract.`,
  '',
  '| Strategy | Trades | Win rate | Expectancy (R) | Profit factor | Max DD (R) | Net $ | OOS trades | OOS exp. (R) | Look-ahead audit |',
  '|---|---:|---:|---:|---:|---:|---:|---:|---:|---|',
  ...rows.map((r) => `| ${r.name}${r.trades < 30 ? ' *(under 30 trades: not evidence)*' : ''} | ${r.trades} | ${r.win_rate == null ? '—' : `${(r.win_rate * 100).toFixed(1)}%`} | ${fmt(r.expectancy_r, 3)} | ${fmt(r.pf)} | ${fmt(r.max_dd_r)} | ${fmt(r.net_usd)} | ${r.oos_trades} | ${fmt(r.oos_expectancy_r, 3)} | ${r.look_ahead} |`),
  '',
  `### ${on.label}`,
  `Full New York sessions: ${on.days}${on.enough ? '' : ' (under 30: not evidence)'}. New York took an overnight extreme: ${on.ny_took_either.count}/${on.ny_took_either.of} (${fmt(on.ny_took_either.pct, 1)}%). The 86-style bias side first: ${on.bias_side_first.count}/${on.bias_side_first.of} (${fmt(on.bias_side_first.pct, 1)}%). Both in one bar (order unknown): ${on.same_bar_both}. Second side after the first: ${on.second_side_after_first.count}/${on.second_side_after_first.of} (${fmt(on.second_side_after_first.pct, 1)}%).`,
];
lines.push('', `86-style approximation, how each of ${outcome.size} days resolved (9:35–11:00 New York): ${Object.entries(why86).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join('; ')}.`);
console.log(lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
if (out) writeFileSync(out, JSON.stringify({ market, tf, manifest, rows, overnight: on, p2p86_days: why86 }, null, 2));
