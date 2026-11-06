#!/usr/bin/env node
// Which trading session CHE's forward paper loses in (owner's recording, 2026-11-06: every loss after the unpause was a
// long in the overnight "pre-open" session). Replays exactly what the MNQ desk now trades (each setup's primary copy, the
// learned exclusions skipped, the trade-quality rules on) on real Yahoo MNQ=F 5-minute bars, and splits the closed
// trades by session (trading_evidence.sessionOf) and by the first 70% / last 30% of the bars. Research only.
//
//   node tools/che_session_replay.mjs
import { appendFileSync } from 'node:fs';
import { acquireDataset } from '../server/cloudflare/trading_research.js';
import { liveSpecs } from '../server/cloudflare/trading_live.js';
import { LEARNED_EXCLUSIONS } from '../server/cloudflare/strategy_governor.js';
import { QUALITY_RULES, intradayContext, newPortfolio, stepPortfolio } from '../server/cloudflare/trading_evidence.js';

// The desk's primary copy (trading_live.isPrimaryVariant, #943): no filter, default target.
const isPrimaryVariant = (pf) => pf.filter === 'any' && (pf.params?.target_r ?? 2) === (pf.candidate === 'rsi-revert-5m' ? 1.5 : 2);
const mem = new Map();
const storage = {
  async get(k) { return Array.isArray(k) ? new Map(k.filter((x) => mem.has(x)).map((x) => [x, mem.get(x)])) : mem.get(k); },
  async put(k, v) { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) mem.set(a, b); else mem.set(k, v); },
};
const tally = (list) => {
  const n = list.length;
  return { n, win: n ? list.filter((t) => t.net_pnl > 0).length / n : null, r: n ? list.reduce((s, t) => s + (t.r_net || 0), 0) / n : null, net: list.reduce((s, t) => s + t.net_pnl, 0) };
};

const data = await acquireDataset(storage, { market: 'MNQ', tf: '5m' });
if (!data.ok) { console.log(`Not run: ${data.reason}`); process.exit(0); }
const bars = data.bars;
const ctx = intradayContext(bars);
const cut = bars[Math.floor(bars.length * 0.7)].t;
const specs = liveSpecs().filter((s) => !LEARNED_EXCLUSIONS[s.c]);
const trades = [];
for (const spec of specs) {
  const pf = newPortfolio(spec.c, spec.f, { contract: 'MNQ', qty: 1, source: 'backtest', resolution: '5m', params: { target_r: spec.target_r, quality: QUALITY_RULES } });
  if (!isPrimaryVariant(pf)) continue;
  trades.push(...stepPortfolio(pf, bars, ctx));
}
const sessions = [...new Set(trades.map((t) => t.session))].sort();
const f = (x, d = 3) => (x == null ? '—' : x.toFixed(d));
const lines = ['## CHE session replay (what the MNQ desk trades now, real bars)', '',
  `${bars.length} bars, ${bars[0].t} to ${bars.at(-1).t}; the last 30% starts ${cut}. Setups: ${[...new Set(trades.map((t) => t.strategy))].join(', ')}.`, '',
  '| Session | All n | All R | First 70% n | First 70% R | Last 30% n | Last 30% R | Win % | Net $ |', '|---|---|---|---|---|---|---|---|---|'];
for (const s of [...sessions, 'ALL']) {
  const list = s === 'ALL' ? trades : trades.filter((t) => t.session === s);
  const a = tally(list); const p = tally(list.filter((t) => t.entry.time < cut)); const q = tally(list.filter((t) => t.entry.time >= cut));
  lines.push(`| ${s} | ${a.n} | ${f(a.r)} | ${p.n} | ${f(p.r)} | ${q.n} | ${f(q.r)} | ${f(a.win == null ? null : 100 * a.win, 1)} | ${f(a.net, 2)} |`);
  console.log(`session ${s}: all n=${a.n} R=${f(a.r)} first70 n=${p.n} R=${f(p.r)} last30 n=${q.n} R=${f(q.r)} win=${f(a.win == null ? null : 100 * a.win, 1)}% net=${f(a.net, 2)}`);
}
for (const side of ['long', 'short']) {
  for (const s of sessions) {
    const list = trades.filter((t) => t.session === s && t.side === side);
    const a = tally(list);
    if (a.n) console.log(`side ${side} ${s}: n=${a.n} R=${f(a.r)} net=${f(a.net, 2)}`);
  }
}
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);

// The owner's question (2026-11-06): "since she's able to lose that much, flip it so she wins that much". The exact
// opposite trade (other side, its stop at the original target, its target at the original stop) exits on the same
// prices, so its result before costs is the negative of the original's and it pays the same costs again:
// flipped net = -(gross) - costs. Measured per setup on every copy the desk has run (excluded setups included, since
// October's losses came from them), in both halves of the bars. Research only.
const allTrades = [];
for (const spec of liveSpecs()) {
  const pf = newPortfolio(spec.c, spec.f, { contract: 'MNQ', qty: 1, source: 'backtest', resolution: '5m', params: { target_r: spec.target_r } });
  if (!isPrimaryVariant(pf)) continue;
  allTrades.push(...stepPortfolio(pf, bars, ctx));
}
const flipTally = (list) => {
  const n = list.length;
  const cost = list.reduce((s, t) => s + (t.gross_before_costs - t.net_pnl), 0);
  const asIs = list.reduce((s, t) => s + t.net_pnl, 0);
  const flipped = list.reduce((s, t) => s - t.gross_before_costs - (t.gross_before_costs - t.net_pnl), 0);
  const flipWins = list.filter((t) => -t.gross_before_costs - (t.gross_before_costs - t.net_pnl) > 0).length;
  return { n, as_is: asIs, flipped, costs: cost, flip_win: n ? flipWins / n : null };
};
const flipLines = ['', '## Flipped trades (the exact opposite of each trade, same bars, same costs)', '',
  '| Setup | Trades | As traded $ | Flipped $ | Flipped win % | Flipped first 70% $ | Flipped last 30% $ | Costs $ |', '|---|---|---|---|---|---|---|---|'];
for (const s of [...new Set(allTrades.map((t) => t.strategy)), 'ALL']) {
  const list = s === 'ALL' ? allTrades : allTrades.filter((t) => t.strategy === s);
  const a = flipTally(list); const p = flipTally(list.filter((t) => t.entry.time < cut)); const q = flipTally(list.filter((t) => t.entry.time >= cut));
  flipLines.push(`| ${s} | ${a.n} | ${f(a.as_is, 0)} | ${f(a.flipped, 0)} | ${f(a.flip_win == null ? null : 100 * a.flip_win, 1)} | ${f(p.flipped, 0)} | ${f(q.flipped, 0)} | ${f(a.costs, 0)} |`);
  console.log(`flip ${s}: n=${a.n} as_is=${f(a.as_is, 0)} flipped=${f(a.flipped, 0)} flip_win=${f(a.flip_win == null ? null : 100 * a.flip_win, 1)}% first70=${f(p.flipped, 0)} last30=${f(q.flipped, 0)} costs=${f(a.costs, 0)}`);
}
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${flipLines.join('\n')}\n`);
