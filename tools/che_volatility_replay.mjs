#!/usr/bin/env node
// Wider, volatility-based stops (owner, 2026-11-06: "test the wider volatility so she can take winning trades").
// Each setup's primary copy (no filter, its default target) runs on real Yahoo MNQ=F bars at 5m, 15m and 1h with its own
// structural stop and with the stop at least 1, 2 or 3 ATR(14) away (trading_evidence.widenStop), the trade-quality
// rules on, at two cost schedules: CHE's planning costs (COSTS) and a low-fee estimate. The pass rule is fixed before
// the run: at least 30 trades in each half and a positive average R after the planning costs in both the first 70% and
// the last 30% of the bars. Every combination tried is counted, because one pass in many tries can be luck.
// Research only: no order, no account, nothing stored.
//
//   node tools/che_volatility_replay.mjs
import { appendFileSync } from 'node:fs';
import { acquireDataset } from '../server/cloudflare/trading_research.js';
import { INTRADAY_CANDIDATES, QUALITY_RULES, intradayContext, newPortfolio, stepPortfolio } from '../server/cloudflare/trading_evidence.js';

const defaultTarget = (c) => (c === 'rsi-revert-5m' ? 1.5 : 2);
// Estimate from public pages (a micro commission of about $0.35-0.39 a side, CME and NFA fees of about $0.40-0.64 a
// side); not a broker statement.
const COST_SETS = { planning: {}, low_fee: { commissionPerSide: 0.39, feePerSide: 0.64 } };
const STOPS = [null, 1, 2, 3];
const TFS = ['5m', '15m', '1h'];
const MIN_HALF = 30;

const mem = new Map();
const storage = {
  async get(k) { return Array.isArray(k) ? new Map(k.filter((x) => mem.has(x)).map((x) => [x, mem.get(x)])) : mem.get(k); },
  async put(k, v) { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) mem.set(a, b); else mem.set(k, v); },
};
const tally = (list) => {
  const n = list.length;
  return { n, r: n ? list.reduce((s, t) => s + (t.r_net || 0), 0) / n : null, net: list.reduce((s, t) => s + t.net_pnl, 0), win: n ? list.filter((t) => t.net_pnl > 0).length / n : null };
};
const f = (x, d = 3) => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(d));

const rows = [];
for (const tf of TFS) {
  const data = await acquireDataset(storage, { market: 'MNQ', tf });
  if (!data.ok) { console.log(`tf ${tf}: not run: ${data.reason}`); continue; }
  const bars = data.bars;
  const ctx = intradayContext(bars);
  const cut = bars[Math.floor(bars.length * 0.7)].t;
  console.log(`tf ${tf}: ${bars.length} bars ${bars[0].t} to ${bars.at(-1).t}, last 30% from ${cut}`);
  for (const c of Object.keys(INTRADAY_CANDIDATES)) {
    for (const stop_atr of STOPS) {
      const res = {};
      for (const [costName, costs] of Object.entries(COST_SETS)) {
        const params = { target_r: defaultTarget(c), quality: QUALITY_RULES, ...(stop_atr ? { stop_atr } : {}) };
        const pf = newPortfolio(c, 'any', { contract: 'MNQ', qty: 1, source: 'backtest', resolution: tf, costs, params });
        const trades = stepPortfolio(pf, bars, ctx);
        res[costName] = { all: tally(trades), first: tally(trades.filter((t) => t.entry.time < cut)), last: tally(trades.filter((t) => t.entry.time >= cut)) };
      }
      const p = res.planning;
      const pass = p.first.n >= MIN_HALF && p.last.n >= MIN_HALF && p.first.r > 0 && p.last.r > 0;
      rows.push({ tf, c, stop_atr, pass, ...res });
      console.log(`row ${tf} ${c} stop=${stop_atr ?? 'structural'}: planning n=${p.all.n} R=${f(p.all.r)} first=${p.first.n}/${f(p.first.r)} last=${p.last.n}/${f(p.last.r)} net=${f(p.all.net, 0)} | low_fee R=${f(res.low_fee.all.r)} first=${f(res.low_fee.first.r)} last=${f(res.low_fee.last.r)} net=${f(res.low_fee.all.net, 0)}${pass ? ' PASS' : ''}`);
    }
  }
}
const tried = rows.filter((r) => r.planning.all.n > 0).length;
const passed = rows.filter((r) => r.pass);
console.log(`summary: ${tried} combinations with trades; ${passed.length} pass (>= ${MIN_HALF} trades and positive R after planning costs in both halves)`);
for (const r of passed) console.log(`pass ${r.tf} ${r.c} stop=${r.stop_atr ?? 'structural'} first=${f(r.planning.first.r)} last=${f(r.planning.last.r)} n=${r.planning.all.n}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  const lines = ['## CHE volatility-stop replay (real MNQ bars, paper research only)', '', `${tried} combinations with trades; ${passed.length} pass the fixed rule.`, '',
    '| TF | Setup | Stop | Trades | R (planning) | First 70% R | Last 30% R | R (low fee) | Pass |', '|---|---|---|---|---|---|---|---|---|'];
  for (const r of rows) if (r.planning.all.n) lines.push(`| ${r.tf} | ${r.c} | ${r.stop_atr ? `${r.stop_atr} ATR` : 'structural'} | ${r.planning.all.n} | ${f(r.planning.all.r)} | ${f(r.planning.first.r)} | ${f(r.planning.last.r)} | ${f(r.low_fee.all.r)} | ${r.pass ? 'yes' : ''} |`);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}
