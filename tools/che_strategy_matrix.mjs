#!/usr/bin/env node
// Strategy Matrix research (Trading Room V3, docs/CHE_TRADING_STRATEGY_V3.md) on REAL public bars fetched on a GitHub
// runner, because CHE's cloud sandbox cannot reach the exchanges or Yahoo. Crypto: Coinbase Exchange public candles
// (BTC-USD, ETH-USD; no account). Futures: CHE's own acquisition loop (trading_research.acquireDataset: Yahoo Finance
// MNQ=F / NQ=F, public and DELAYED, depth limited by Yahoo: about 59 days of 5- and 15-minute bars, about 729 days of
// hourly bars). Every strategy runs through strategy_matrix.researchSeries: costs on every fill, rolling walk-forward
// with targets chosen on training windows only, and the look-ahead audit. Nothing is invented: a fetch that fails is
// recorded as failed with its reason, and a series without bars has no numbers.
//
//   node tools/che_strategy_matrix.mjs --group crypto|futures [--markets BTC,ETH] [--tfs 5m,15m,1h] [--days 5m=90,15m=365,1h=1095]
//        [--out server/cloudflare/strategy_matrix_crypto.js] [--json out.json]
import { appendFileSync, writeFileSync } from 'node:fs';
import { COINS, fetchCoinbaseCandles } from '../server/cloudflare/crypto_markets.js';
import { candleProblems } from '../server/cloudflare/trading_evidence.js';
import { acquireDataset } from '../server/cloudflare/trading_research.js';
import { COST_MODELS, MARKETS, MATRIX_VERSION, researchSeries, sentenceFor } from '../server/cloudflare/strategy_matrix.js';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const group = arg('group', 'crypto');
const markets = arg('markets', group === 'crypto' ? 'BTC,ETH' : 'MNQ,NQ').split(',').filter((m) => MARKETS[m]?.asset === group);
const tfs = arg('tfs', '5m,15m,1h').split(',');
const days = Object.fromEntries(arg('days', '5m=90,15m=365,1h=1095').split(',').map((kv) => kv.split('=')).map(([k, v]) => [k, Number(v)]));
const outModule = arg('out', null);
const outJson = arg('json', null);
const TF_SEC = { '5m': 300, '15m': 900, '1h': 3600 };
const iso = (ms) => new Date(ms).toISOString();

async function coinbaseHistory(coin, tf, now) {
  const g = TF_SEC[tf] * 1000;
  const want = Math.floor((days[tf] * 86400) / TF_SEC[tf]);
  const seen = new Map();
  let end = now - (now % g);
  let failures = 0;
  for (let page = 0; seen.size < want && page < Math.ceil(want / 300) + 5; page++) {
    let rows;
    try { rows = await fetchCoinbaseCandles(coin, tf, { now, end }); failures = 0; }
    catch (e) { if (++failures > 4) throw e; await new Promise((r) => setTimeout(r, 2000)); page--; continue; }
    if (!rows.length) break;
    for (const b of rows) seen.set(b.t, b);
    end = Date.parse(rows[0].t);
    await new Promise((r) => setTimeout(r, 220)); // Coinbase public rate limit
  }
  const bars = [...seen.values()].sort((a, b) => a.t.localeCompare(b.t)).slice(-want);
  const span = bars.length > 1 ? (Date.parse(bars.at(-1).t) - Date.parse(bars[0].t)) / g + 1 : bars.length;
  return { bars, source: `Coinbase Exchange ${COINS[coin].product} ${tf} candles (public API, no account)`, symbol: COINS[coin].product, missing: Math.max(0, Math.round(span - bars.length)), rolls: [] };
}

function memoryStorage() {
  const mem = new Map();
  return {
    async get(k) { return Array.isArray(k) ? new Map(k.filter((x) => mem.has(x)).map((x) => [x, mem.get(x)])) : mem.get(k); },
    async put(k, v) { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) mem.set(a, b); else mem.set(k, v); },
  };
}
async function futuresHistory(market, tf) {
  const data = await acquireDataset(memoryStorage(), { market, tf });
  if (!data.ok) throw new Error(data.reason);
  const m = data.manifest;
  return { bars: data.bars, source: `${m.provider} ${m.symbol} ${tf} bars (public, DELAYED; continuous front month, unadjusted)`, symbol: m.symbol, missing: m.missing?.count ?? m.missing ?? null, rolls: m.roll_dates || [] };
}

const now = Date.now();
const coverage = [];
const rows = [];
for (const market of markets) {
  for (const tf of tfs.filter((t) => MARKETS[market].timeframes.includes(t))) {
    const started = Date.now();
    try {
      const h = group === 'crypto' ? await coinbaseHistory(market, tf, now) : await futuresHistory(market, tf);
      const problems = candleProblems(h.bars);
      if (h.bars.length < 500 || problems.length) {
        coverage.push({ market, tf, ok: false, bars: h.bars.length, reason: problems.length ? `bars refused: ${problems.join('; ')}` : `only ${h.bars.length} bars returned; the research needs at least 500` });
        continue;
      }
      const volume = h.bars.filter((b) => Number(b.v) > 0).length / h.bars.length;
      coverage.push({ market, tf, ok: true, source: h.source, symbol: h.symbol, from: h.bars[0].t, to: h.bars.at(-1).t, bars: h.bars.length, missing_bars: h.missing, roll_dates: h.rolls, volume_share: Math.round(volume * 1000) / 1000,
        sessions: group === 'crypto' ? '24/7 including weekends; the engine\'s daily cutoff (flat by 16:55 New York) applies' : 'CME Globex hours only (Sunday 18:00 to Friday 17:00 New York, daily 17:00–18:00 break)' });
      rows.push(...researchSeries({ market, tf, bars: h.bars, rolls: h.rolls }));
      console.error(`${market} ${tf}: ${h.bars.length} bars ${h.bars[0].t} → ${h.bars.at(-1).t}, researched in ${Math.round((Date.now() - started) / 1000)} s`);
    } catch (e) {
      coverage.push({ market, tf, ok: false, reason: String(e?.message || e).slice(0, 240) });
    }
  }
}

const env = process.env;
const report = {
  group, generated_at: iso(now), engine: MATRIX_VERSION, paper_only: true, live: 'disabled',
  run_id: env.GITHUB_RUN_ID || 'local', run_url: env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null,
  commit: env.GITHUB_SHA || null, ref: env.GITHUB_REF_NAME || null,
  cost_models: Object.fromEntries(markets.map((m) => [m, COST_MODELS[m].text])), coverage, rows,
};
if (outJson) writeFileSync(outJson, JSON.stringify(report, null, 2));
if (outModule && coverage.some((c) => c.ok)) {
  writeFileSync(outModule, `// Strategy Matrix research results (${group}). WRITTEN ONLY BY tools/che_strategy_matrix.mjs on a GitHub runner; never edit by hand.\n// Run ${report.run_id} at ${report.generated_at} on ${report.commit || 'unknown commit'}.\nexport default ${JSON.stringify(report)};\n`);
}

const n = (x, d = 2) => (x == null || !Number.isFinite(x) ? '—' : Number(x).toFixed(d));
const lines = [`## CHE Strategy Matrix (${group}), research and paper only`, '', `Run ${report.run_id}, ${report.generated_at}. Costs on every fill; out-of-sample = rolling walk-forward test windows with the target chosen on training windows only.`, ''];
for (const c of coverage) lines.push(c.ok ? `- ${c.market} ${c.tf}: ${c.source}, ${c.bars} bars, ${c.from} → ${c.to}, missing ${c.missing_bars ?? 'n/a'}` : `- ${c.market} ${c.tf}: NOT RUN: ${c.reason}`);
lines.push('', '| Market | TF | Strategy | Tested | OOS trades | Win % | OOS exp. R | Gross R | Net $ | PF | Max DD R | Folds + | Look-ahead | Confidence |', '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|');
for (const r of rows) {
  if (r.status !== 'ok') { lines.push(`| ${r.market} | ${r.tf} | ${r.name} | — | — | — | — | — | — | — | — | — | — | ${r.reason} |`); continue; }
  lines.push(`| ${r.market} | ${r.tf} | ${r.name} | ${r.trades_tested} | ${r.oos.trades} | ${n(r.oos.win_rate, 1)} | ${n(r.oos.expectancy_r, 3)} | ${n(r.gross_expectancy_r, 3)} | ${n(r.oos.net_pnl)} | ${n(r.oos.profit_factor)} | ${n(r.oos.max_drawdown_r)} | ${r.walk_forward.folds_positive}/${r.walk_forward.folds} | ${r.look_ahead} | ${r.confidence} |`);
}
lines.push('', '### Sentences', ...rows.map((r) => `- ${sentenceFor(r)}`));
const text = lines.join('\n');
console.log(text);
if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
if (!coverage.some((c) => c.ok)) process.exit(2);
