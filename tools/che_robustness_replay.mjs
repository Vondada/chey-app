#!/usr/bin/env node
// Robustness battery for the hourly volatility test (owner, 2026-11-06: "I need it to be determined faster: Che should
// have enough backtesting and market knowledge"). Forward paper needs months; this asks the history harder questions now.
// For inside bar and previous-day sweep on 1-hour bars with 2 ATR stops:
//   1. six equal time folds (an edge should hold in most of them, not just two halves);
//   2. neighbouring settings (stop 1.5 / 2 / 2.5 ATR, target 1.5 / 2 / 2.5 R);
//   3. cost stress (costs x1.5, and one more tick of slippage);
//   4. bootstrap of the trade results (how often the average R is above zero);
//   5. random entries with the same stop and target rules and frequency (does the setup beat chance?);
//   6. the same rules on other index futures (ES, YM, RTY), their bars scaled to the MNQ price so the point-based rules
//      and MNQ costs apply unchanged (a pattern test, labelled as such).
// The verdict rules are written here before the run. Research only: no order, no account, nothing stored.
//
//   node tools/che_robustness_replay.mjs
import { appendFileSync } from 'node:fs';
import { acquireDataset } from '../server/cloudflare/trading_research.js';
import { COSTS, INTRADAY_CANDIDATES, QUALITY_RULES, candleProblems, intradayContext, newPortfolio, stepPortfolio } from '../server/cloudflare/trading_evidence.js';

const SETUPS = ['inside-bar-5m', 'pdhl-sweep-5m'];
const mem = new Map();
const storage = {
  async get(k) { return Array.isArray(k) ? new Map(k.filter((x) => mem.has(x)).map((x) => [x, mem.get(x)])) : mem.get(k); },
  async put(k, v) { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) mem.set(a, b); else mem.set(k, v); },
};
const f = (x, d = 3) => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(d));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
// A seeded generator, so a rerun on the same bars gives the same numbers.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}

function run(bars, c, { stop_atr = 2, target_r = 2, costs = {} } = {}) {
  const pf = newPortfolio(c, 'any', { contract: 'MNQ', qty: 1, source: 'backtest', resolution: '1h', costs, params: { target_r, quality: QUALITY_RULES, stop_atr } });
  return stepPortfolio(pf, bars, intradayContext(bars));
}
const rOf = (ts) => ts.map((t) => t.r_net || 0);

async function yahoo60(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=60m&range=730d&includePrePost=true`;
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Yahoo ${symbol} HTTP ${res.status}`);
  const r = (await res.json()).chart?.result?.[0];
  const q = r?.indicators?.quote?.[0] || {};
  const out = [];
  (r?.timestamp || []).forEach((ts, i) => {
    const b = { t: new Date(ts * 1000).toISOString(), o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 };
    if ([b.o, b.h, b.l, b.c].every(Number.isFinite) && (ts * 1000) % 3_600_000 === 0 && ts * 1000 + 3_600_000 <= Date.now()) out.push(b);
  });
  return out;
}

const lines = ['## CHE robustness battery (hourly volatility test, real bars, research only)', ''];
const say = (s) => { console.log(s); lines.push(s); };

const data = await acquireDataset(storage, { market: 'MNQ', tf: '1h' });
if (!data.ok) { console.log(`Not run: ${data.reason}`); process.exit(0); }
const bars = data.bars;
say(`MNQ 1h: ${bars.length} bars, ${bars[0].t} to ${bars.at(-1).t}.`);
const verdict = {};

for (const c of SETUPS) {
  say('');
  say(`### ${c} (1-hour, 2 ATR stop, 2 R target)`);
  const base = run(bars, c);
  const R = rOf(base);
  say(`base: ${base.length} trades, ${f(mean(R))} R per trade, win rate ${f((100 * base.filter((t) => t.net_pnl > 0).length) / base.length, 1)}%, net $${f(base.reduce((s, t) => s + t.net_pnl, 0), 0)}`);

  // 1. six folds
  const edges = [0, 1, 2, 3, 4, 5].map((k) => bars[Math.floor((bars.length * k) / 6)].t);
  const folds = edges.map((start, k) => rOf(base.filter((t) => t.entry.time >= start && (k === 5 || t.entry.time < edges[k + 1]))));
  const positiveFolds = folds.filter((x) => x.length && mean(x) > 0).length;
  say(`folds: ${folds.map((x, k) => `${k + 1}: ${x.length} trades ${f(mean(x))} R`).join(' | ')}; positive ${positiveFolds}/6`);

  // 2. neighbouring settings
  const grid = [];
  for (const stop_atr of [1.5, 2, 2.5]) {
    for (const target_r of [1.5, 2, 2.5]) {
      const r = rOf(run(bars, c, { stop_atr, target_r }));
      grid.push({ stop_atr, target_r, n: r.length, r: mean(r) });
    }
  }
  const positiveNeighbours = grid.filter((g) => g.r > 0).length;
  say(`neighbours: ${grid.map((g) => `${g.stop_atr}ATR/${g.target_r}R ${f(g.r)}`).join(' | ')}; positive ${positiveNeighbours}/9`);

  // 3. cost stress
  const x15 = rOf(run(bars, c, { costs: { commissionPerSide: COSTS.commissionPerSide * 1.5, feePerSide: COSTS.feePerSide * 1.5, spreadTicks: COSTS.spreadTicks * 1.5, slippageTicks: COSTS.slippageTicks * 1.5 } }));
  const slip = rOf(run(bars, c, { costs: { slippageTicks: COSTS.slippageTicks + 1 } }));
  say(`cost stress: costs x1.5 ${f(mean(x15))} R per trade; one more tick of slippage ${f(mean(slip))} R per trade`);

  // 4. bootstrap
  const rb = rng(42);
  let above = 0;
  const means = [];
  for (let b = 0; b < 5000; b++) {
    let s = 0;
    for (let i = 0; i < R.length; i++) s += R[Math.floor(rb() * R.length)];
    means.push(s / R.length);
    if (s > 0) above += 1;
  }
  means.sort((a, b) => a - b);
  const pAbove = above / 5000;
  say(`bootstrap: average R above zero in ${f(100 * pAbove, 1)}% of 5000 resamples; 90% range ${f(means[250])} to ${f(means[4749])} R`);

  // 5. random entries: a random side at random bars, at about the setup's rate; the stop starts 6 points away (the
  // smallest the engine allows) and is widened to 2 ATR by the same stop_atr rule, with the same 2 R target and
  // quality rules. The setup's entry rule is restored afterwards.
  const real = INTRADAY_CANDIDATES[c].entry;
  const rate = (2 * base.length) / bars.length;
  const rr = rng(7);
  const randomMeans = [];
  try {
    for (let k = 0; k < 200; k++) {
      INTRADAY_CANDIDATES[c].entry = (cs, i) => {
        if (i < 20 || rr() >= rate) return null;
        const side = rr() < 0.5 ? 'long' : 'short';
        return { side, ref: cs[i].c, stop: side === 'short' ? cs[i].c + 6 : cs[i].c - 6, why: 'random entry' };
      };
      randomMeans.push(mean(rOf(run(bars, c))) ?? 0);
    }
  } finally { INTRADAY_CANDIDATES[c].entry = real; }
  randomMeans.sort((a, b) => a - b);
  const beat = randomMeans.filter((m) => mean(R) > m).length / randomMeans.length;
  say(`random entries (200 runs): median ${f(randomMeans[100])} R, 95th percentile ${f(randomMeans[189])} R; the setup beats ${f(100 * beat, 1)}% of them`);

  verdict[c] = { trades: base.length, r: mean(R), positiveFolds, positiveNeighbours, x15: mean(x15), slip: mean(slip), pAbove, beat, markets: {} };
}

// 6. other index futures, scaled to the MNQ price level
say('');
say('### Other index futures (bars scaled to the MNQ price; a pattern test with MNQ rules and costs)');
const level = bars.at(-1).c;
for (const sym of ['ES=F', 'YM=F', 'RTY=F']) {
  try {
    const raw = await yahoo60(sym);
    const k = level / raw.at(-1).c;
    const scaled = raw.map((b) => ({ ...b, o: b.o * k, h: b.h * k, l: b.l * k, c: b.c * k }));
    const problems = candleProblems(scaled);
    if (problems.length) { say(`${sym}: refused (${problems[0]})`); continue; }
    for (const c of SETUPS) {
      const r = rOf(run(scaled, c));
      verdict[c].markets[sym] = mean(r);
      say(`${sym} ${c}: ${scaled.length} bars, ${r.length} trades, ${f(mean(r))} R per trade`);
    }
  } catch (e) { say(`${sym}: not run (${String(e?.message || e).slice(0, 120)})`); }
}

// Verdict, by rules fixed before the run.
say('');
say('### Verdict (rules fixed before the run)');
say('A pass needs all of: at least 4 of 6 folds positive; at least 6 of 9 neighbouring settings positive; positive after costs x1.5; average R above zero in at least 90% of bootstrap resamples; better than at least 95% of random-entry runs; positive on at least 2 of the 3 other index futures.');
for (const c of SETUPS) {
  const v = verdict[c];
  const otherPositive = Object.values(v.markets).filter((x) => x > 0).length;
  const checks = { folds: v.positiveFolds >= 4, neighbours: v.positiveNeighbours >= 6, costs: v.x15 > 0, bootstrap: v.pAbove >= 0.9, random: v.beat >= 0.95, markets: otherPositive >= 2 };
  const passed = Object.values(checks).every(Boolean);
  say(`verdict ${c}: ${passed ? 'PASS' : 'FAIL'} (${Object.entries(checks).map(([k, ok]) => `${k} ${ok ? 'yes' : 'no'}`).join(', ')}; other markets positive ${otherPositive}/3)`);
}
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
