// Trading Room V3, items 5–7 (owner, 2026-10-25): Strategy Matrix research, smart paper selection, demotion rules,
// sessions, duplicates, the route and the voice answers. docs/CHE_TRADING_STRATEGY_V3.md.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import {
  COST_MODELS, MATRIX_STRATEGIES, chooseTarget, confidenceOf, researchSeries, researchStrategy, rollingWindows, sentenceFor,
  speakStrategyMatrix, strategyMatrixIntent, strategyMatrixView,
} from './strategy_matrix.js';
import {
  DEMOTE_MAX_DD_R, MIN_SAMPLE, PAPER_LIMITS, buildPaperPlan, demotion, prioritize, rankStrategies, selectionGate, sessionAllows,
} from './paper_selection.js';
import { V3_CANDIDATES, intradayContext, newPortfolio, stepPortfolio } from './trading_evidence.js';
import { replyFromNdjson } from './brain_memory.js';

function memoryStorage() {
  const m = new Map();
  return {
    m,
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => m.has(x)).map((x) => [x, structuredClone(m.get(x))])) : m.has(k) ? structuredClone(m.get(k)) : undefined),
    put: async (k, v) => { if (k && typeof k === 'object') { for (const [a, b] of Object.entries(k)) m.set(a, structuredClone(b)); return; } m.set(k, structuredClone(v)); },
    delete: async (k) => m.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...m.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])),
  };
}

// A constructed research row: only the fields the ranking reads, set explicitly.
function row({ strategy = 'ema20-pullback', market = 'BTC', tf = '15m', trades = 120, win = 50, exp = 0.1, lo = null, hi = null, pf = 1.2, dd = 5, rr = 1.2, stability = 1, recent = 0.1, look = 'passed' } = {}) {
  return {
    strategy, candidate: MATRIX_STRATEGIES.find((s) => s.key === strategy)?.candidate, market, tf, name: strategy, status: 'ok', asset: ['BTC', 'ETH'].includes(market) ? 'crypto' : 'futures', trades_tested: trades * 2, qualified_samples: trades,
    oos: { trades, win_rate: win, avg_winner: 50, avg_loser: -40, risk_reward: rr, net_pnl: exp * trades * 40, expectancy_dollars: exp * 40, expectancy_r: exp,
      expectancy_r_95ci: { low: lo ?? exp - 0.1, high: hi ?? exp + 0.1 }, profit_factor: pf, max_drawdown: dd * 40, max_drawdown_r: dd, costs_paid: 100 },
    walk_forward: { folds: 5, folds_positive: 3, windows: [] }, hours: { best: { hour: 10, trades: 20, expectancy_r: 0.3 }, worst: { hour: 3, trades: 12, expectancy_r: -0.2 } },
    regimes: [], regime_stability: stability, recent_oos: { trades: 30, expectancy_r: recent }, look_ahead: look, confidence: 'moderate',
  };
}

test('ranking: a high win-rate strategy with negative expectancy ranks below a lower win-rate one with positive expectancy', () => {
  const scalper = row({ strategy: 'range-rejection', win: 82, exp: -0.06, lo: -0.15, hi: 0.03, pf: 0.9, rr: 0.2, recent: -0.05 });
  const trend = row({ strategy: 'breakout-retest', win: 36, exp: 0.14, pf: 1.3, rr: 2.4 });
  const ranked = rankStrategies([scalper, trend]);
  assert.equal(ranked[0].row.strategy, 'breakout-retest');
  assert.equal(ranked[0].priority, 1);
  assert.ok(ranked[1].priority > ranked[0].priority);
  assert.ok(ranked[0].reasons.some((r) => /reward:risk needs/.test(r)), 'win rate is judged against its reward:risk');
  // Even with an extreme win rate and a better score elsewhere, a non-positive expectancy never outranks a positive one.
  const shiny = row({ strategy: 'vwap-reversion', win: 95, exp: -0.001, lo: -0.002, hi: 0.0001, pf: 0.99, rr: 0.05, dd: 0, stability: 1, recent: 0.2, trades: 1000 });
  assert.equal(rankStrategies([shiny, trend])[0].row.strategy, 'breakout-retest');
});

test('ranking: a tiny sample is never promoted, however good it looks', () => {
  const tiny = row({ strategy: 'momentum-continuation', trades: 9, win: 89, exp: 1.8, pf: 9 });
  const solid = row({ strategy: 'ema20-pullback', trades: 140, exp: 0.05, pf: 1.1 });
  const ranked = rankStrategies([tiny, solid]);
  assert.equal(ranked[0].row.strategy, 'ema20-pullback');
  const t = ranked.find((r) => r.row.strategy === 'momentum-continuation');
  assert.equal(t.tier, 'insufficient sample');
  assert.equal(t.score, null);
  assert.match(t.reasons[0], new RegExp(`9 out-of-sample trades; ${MIN_SAMPLE} are needed`));
  assert.equal(sentenceFor(tiny).includes('insufficient sample'), true);
  assert.equal(confidenceOf(tiny), 'insufficient sample');
});

test('demotion follows the written statistical rules only', () => {
  assert.equal(demotion(row({ trades: 60, exp: -0.2, lo: -0.35, hi: -0.05 })).demoted, true, 'CI upper bound below zero');
  assert.equal(demotion(row({ trades: 20, exp: -0.9, lo: -1.4, hi: -0.4 })).demoted, false, 'a small sample never demotes');
  assert.equal(demotion(row({ trades: 60, exp: -0.05, lo: -0.2, hi: 0.1 })).demoted, false, 'negative but not significant');
  assert.match(demotion(row({ trades: 60, exp: 0.05, dd: DEMOTE_MAX_DD_R + 1 })).reasons[0], /drawdown/);
  assert.equal(demotion(row({ trades: 321, exp: 0.12, lo: -0.05, hi: 0.29, dd: 16.3 })).demoted, false, 'the drawdown limit scales with the sample (32.1R at 321 trades)');
  assert.equal(demotion(row({ trades: 321, exp: -0.03, dd: 34.8 })).demoted, true);
  assert.match(demotion(row({ look: 'FAILED' })).reasons[0], /look-ahead/);
  assert.equal(demotion(row(), { trades: 25, expectancy_r: -0.4, expectancy_r_95ci: { low: -0.7, high: -0.1 } }).demoted, true, 'forward paper can demote');
  assert.equal(demotion(row(), { trades: 10, expectancy_r: -0.4, expectancy_r_95ci: { low: -0.9, high: -0.1 } }).demoted, false);
  const ranked = rankStrategies([row({ trades: 60, exp: -0.2, lo: -0.35, hi: -0.05 })]);
  assert.equal(ranked[0].tier, 'demoted');
  assert.equal(ranked[0].priority, null);
});

test('walk-forward: rolling windows never overlap train and test, and the target is chosen on training trades only', () => {
  const times = Array.from({ length: 800 }, (_, i) => new Date(Date.UTC(2026, 0, 1) + i * 300000).toISOString());
  const w = rollingWindows(times);
  assert.equal(w.length, 5);
  for (const x of w) {
    assert.ok(x.train_from < x.train_to && x.train_to === x.test_from, 'train ends where test starts');
    if (x.test_to) assert.ok(x.test_from < x.test_to);
  }
  for (let i = 1; i < w.length; i++) assert.ok(w[i].test_from >= w[i - 1].test_to, 'test windows do not overlap each other');
  // 1.5R is best on training trades, 3R only in the test window: the choice must be 1.5R.
  const trade = (entry, exit, r) => ({ entry: { time: times[entry] }, exit: { time: times[exit] }, r_net: r });
  const win = w[0];
  const trainIdx = Array.from({ length: 12 }, (_, k) => 10 + k * 20);
  const byTarget = {
    1.5: trainIdx.map((i) => trade(i, i + 2, 0.4)),
    2: trainIdx.map((i) => trade(i, i + 2, 0.1)),
    3: [...trainIdx.map((i) => trade(i, i + 2, -0.3)), ...Array.from({ length: 20 }, (_, k) => trade(310 + k, 311 + k, 5))],
  };
  assert.equal(chooseTarget(byTarget, win), 1.5);
  // A trade that opens in training but closes inside the test window is purged from training.
  const straddle = { 1.5: [trade(295, 305, -9), ...trainIdx.map((i) => trade(i, i + 2, 0.4))], 2: [], 3: [] };
  assert.equal(chooseTarget(straddle, win), 1.5);
});

// 5-minute bars with real timestamps (CME hours are irrelevant to crypto; this fixture is a crypto series).
function walk(n = 6000, { start = '2026-02-01T00:00:00Z', volume = true, price = 60000 } = {}) {
  const t0 = Date.parse(start); const out = []; let p = price; let seed = 11;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < n; i++) {
    const burst = i % 240 === 120 ? (rnd() < 0.5 ? 1 : -1) * 0.012 : 0; // an occasional displacement bar
    const o = p; const c = o * (1 + (rnd() - 0.5) * 0.008 + Math.sin(i / 60) * 0.0008 + burst);
    const wick = burst ? 0.0002 : 0.002;
    out.push({ t: new Date(t0 + i * 300000).toISOString(), o, h: Math.max(o, c) * (1 + rnd() * wick), l: Math.min(o, c) * (1 - rnd() * wick), c, v: volume ? 1 + rnd() * 5 : 0 });
    p = c;
  }
  return out;
}

test('research: every V3 strategy row carries rules, costs, walk-forward, hours and an honest status', () => {
  const bars = walk(5000);
  const rows = researchSeries({ market: 'BTC', tf: '5m', bars });
  assert.equal(rows.length, MATRIX_STRATEGIES.length);
  for (const r of rows) {
    assert.equal(r.status, 'ok', r.strategy);
    assert.ok(r.rules.length > 40, `${r.strategy} names its exact rules`);
    assert.equal(r.look_ahead, 'passed', `${r.strategy} passes the look-ahead audit`);
    assert.ok(r.walk_forward.windows.every((w) => w.train_to === w.test_from));
    assert.ok(['high', 'moderate', 'low', 'insufficient sample'].includes(r.confidence));
    if (r.oos.trades) assert.ok(r.oos.costs_paid > 0, 'costs are paid on every trade');
  }
  // No volume → no VWAP; ORB is not defined on hourly bars.
  const noVol = researchStrategy(MATRIX_STRATEGIES.find((s) => s.key === 'vwap-reversion'), { market: 'BTC', tf: '5m', bars: walk(1500, { volume: false }), audit: false });
  assert.equal(noVol.status, 'not_applicable');
  assert.match(noVol.reason, /real traded volume/);
  const orb1h = researchStrategy(MATRIX_STRATEGIES.find((s) => s.key === 'opening-range-breakout'), { market: 'MNQ', tf: '1h', bars: walk(1500, { price: 20000 }), audit: false });
  assert.equal(orb1h.status, 'not_applicable');
  assert.match(COST_MODELS.MNQ.text, /commission/);
  assert.match(COST_MODELS.BTC.text, /taker/);
});

test('every V3 strategy produces real signals on a moving market', () => {
  const bars = walk(8000, { price: 3000 });
  const x = intradayContext(bars);
  for (const id of Object.keys(V3_CANDIDATES)) {
    const pf = newPortfolio(id, 'any', { contract: 'MNQ', qty: 1, source: 'backtest', resolution: '5m', costs: { spreadTicks: 0, slippageTicks: 0, commissionPerSide: 0, feePerSide: 0 } });
    stepPortfolio(pf, bars, x);
    assert.ok(pf.counts.signals > 0, `${id} signalled at least once (${pf.counts.signals})`);
  }
});

test('sessions: crypto paper continues on weekends; futures paper pauses outside CME hours', () => {
  const saturday = Date.parse('2026-10-24T15:00:00Z');
  const wednesdayBreak = Date.parse('2026-10-21T21:30:00Z'); // 5:30 PM New York, the CME daily break
  const sundayOpen = Date.parse('2026-10-25T22:30:00Z');     // 6:30 PM New York Sunday
  const tuesday = Date.parse('2026-10-20T14:00:00Z');
  assert.equal(sessionAllows('BTC', saturday).ok, true);
  assert.equal(sessionAllows('ETH', wednesdayBreak).ok, true);
  assert.equal(sessionAllows('MNQ', saturday).ok, false);
  assert.equal(sessionAllows('NQ', wednesdayBreak).ok, false);
  assert.equal(sessionAllows('MNQ', sundayOpen).ok, true);
  assert.equal(sessionAllows('MNQ', tuesday).ok, true);
  assert.equal(sessionAllows('MNQ', Date.parse('2026-12-25T15:00:00Z')).ok, false, 'Christmas: CME closed');
  const log = [];
  const gate = selectionGate(null, { log });
  assert.equal(gate({ candidate: 'ema-pullback-5m', contract: 'BTC', resolution: '5m', key: 'a' }, { stage: 'signal', time: new Date(saturday).toISOString() }), null);
  assert.match(gate({ candidate: 'ema-pullback-5m', contract: 'MNQ', resolution: '5m', key: 'b' }, { stage: 'signal', time: new Date(saturday).toISOString() }), /outside CME hours/);
  assert.deepEqual(log.map((l) => l.decision), ['allowed', 'refused']);
});

test('selection: duplicates, exposure caps, demoted rows and priority order, every decision logged with a reason', () => {
  const plan = buildPaperPlan([{ rows: [
    row({ strategy: 'breakout-retest', market: 'BTC', tf: '5m', exp: 0.2 }),
    row({ strategy: 'ema20-pullback', market: 'BTC', tf: '5m', trades: 60, exp: -0.3, lo: -0.5, hi: -0.1 }),
  ] }]);
  // The plan is keyed by the engine candidate the paper portfolios carry.
  assert.ok(plan.entries['breakout-retest-5m|BTC|5m'] && plan.entries['ema-pullback-5m|BTC|5m']);
  const p = plan;
  const log = [];
  const gate = selectionGate(null, { plan: p, open: { BTC: 0 }, log });
  const at = '2026-10-24T15:00:00.000Z';
  const pf = (candidate, contract = 'BTC', key = candidate) => ({ candidate, contract, resolution: '5m', key });
  assert.equal(gate(pf('breakout-retest-5m'), { stage: 'signal', time: at }), null);
  assert.match(gate(pf('breakout-retest-5m', 'BTC', 'other-target'), { stage: 'signal', time: at }), /duplicate/);
  assert.match(gate(pf('ema-pullback-5m'), { stage: 'signal', time: at }), /demoted by the written rules/);
  assert.equal(gate(pf('sweep-reclaim-5m'), { stage: 'signal', time: at }), null, 'not researched yet: lowest priority, still learning');
  assert.match(gate(pf('rsi-revert-5m'), { stage: 'signal', time: at }), new RegExp(`${PAPER_LIMITS.per_market} paper positions already open on BTC`));
  assert.equal(gate(pf('rsi-revert-5m', 'ETH'), { stage: 'signal', time: at }), null);
  assert.equal(gate(pf('orb-15m', 'ETH'), { stage: 'signal', time: at }), null);
  assert.match(gate(pf('fvg-retest-5m', 'ETH'), { stage: 'signal', time: '2026-10-24T15:05:00.000Z' }), /paper positions already open/);
  assert.equal(gate(pf('fvg-retest-5m', 'ETH'), { stage: 'fill', time: at }), null, 'fills pass through');
  assert.ok(log.length >= 8 && log.every((l) => l.decision && l.reason && l.strategy && l.market));
  const ordered = prioritize([pf('sweep-reclaim-5m'), pf('breakout-retest-5m')], p, '5m');
  assert.equal(ordered[0].candidate, 'breakout-retest-5m', 'best supported is stepped first');
  // The total cap holds across markets.
  const g2 = selectionGate(null, { open: { BTC: 1, ETH: 2, MNQ: 1 }, log: [] });
  assert.match(g2(pf('orb-15m', 'BTC'), { stage: 'signal', time: at }), new RegExp(`${PAPER_LIMITS.total} paper positions already open in total`));
});

test('selection never reaches an order, broker or network path', async () => {
  for (const file of ['paper_selection.js', 'strategy_matrix.js']) {
    const src = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    const imports = [...src.matchAll(/from '\.\/([^']+)'/g)].map((m) => m[1]);
    for (const banned of [/alpaca/, /tradovate/, /rithmic/, /broker/, /order/, /trading_desk/, /trading_live/, /ninja/]) {
      assert.ok(!imports.some((i) => banned.test(i)), `${file} imports nothing matching ${banned}`);
    }
    assert.ok(!/\bfetch\s*\(/.test(src), `${file} makes no network call`);
  }
  const real = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network used'); };
  try {
    const gate = selectionGate(null, {});
    gate({ candidate: 'ema-pullback-5m', contract: 'BTC', resolution: '5m', key: 'k' }, { stage: 'signal', time: '2026-10-24T15:00:00Z' });
    const view = await strategyMatrixView(memoryStorage(), { sets: [{ rows: [row()] }, null] });
    assert.equal(view.live, 'disabled');
  } finally { globalThis.fetch = real; }
});

test('matrix view: shape, live disabled, pending groups and a sentence built from the row\'s own numbers', async () => {
  const r = row({ strategy: 'breakout-retest', market: 'ETH', tf: '1h', trades: 77, win: 41.56, exp: 0.1234 });
  r.oos.avg_winner = 61.25; r.oos.avg_loser = -33.5; r.oos.net_pnl = 950.4; r.oos.profit_factor = 1.37; r.oos.max_drawdown = 210.75;
  r.name = 'Trend breakout and retest';
  const set = { generated_at: new Date().toISOString(), run_id: '123', run_url: 'https://github.com/x/y/actions/runs/123', commit: 'abc', engine: 'matrix-v3.1', coverage: [{ market: 'ETH', tf: '1h', ok: true }], rows: [r] };
  const view = await strategyMatrixView(memoryStorage(), { sets: [set, null] });
  for (const k of ['version', 'paper_only', 'live', 'groups', 'cost_models', 'strategies', 'limits', 'best', 'rows', 'selection_log']) assert.ok(k in view, k);
  assert.equal(view.live, 'disabled');
  assert.equal(view.groups[0].run.run_id, '123');
  assert.equal(view.groups[0].freshness.state, 'fresh');
  assert.equal(view.groups[1].pending, true);
  assert.equal(view.strategies.length, 8);
  const out = view.rows[0];
  assert.equal(out.status_detail.live, 'disabled');
  assert.equal(out.tier, 'ranked');
  assert.equal(view.best.ETH, 'breakout-retest|ETH|1h');
  for (const piece of ['77 out-of-sample trades', '41.56% winners', '$61.25', '$33.50', '$950.40', '0.1234R', '1.37', '$210.75', '10 AM', '3 AM', 'Confidence moderate']) {
    assert.ok(out.sentence.includes(piece), `${piece} in: ${out.sentence}`);
  }
  r.oos.net_pnl = 12.5;
  assert.ok(sentenceFor(r).includes('$12.50') && !sentenceFor(r).includes('$950.40'), 'the sentence follows the numbers');
});

test('voice: best strategy per market and explain a strategy, answered from the matrix only', async () => {
  assert.deepEqual(strategyMatrixIntent("What's the best strategy for BTC?"), { kind: 'best', market: 'BTC' });
  assert.deepEqual(strategyMatrixIntent('Which strategy works best on MNQ'), { kind: 'best', market: 'MNQ' });
  assert.deepEqual(strategyMatrixIntent('best strategy for crypto'), { kind: 'best', group: 'crypto' });
  assert.equal(strategyMatrixIntent('Explain the EMA 20 pullback').key, 'ema20-pullback');
  assert.equal(strategyMatrixIntent('how does the liquidity sweep and reclaim work?').key, 'sweep-reclaim');
  assert.equal(strategyMatrixIntent('Read the strategy matrix').kind, 'summary');
  for (const other of ['Explain expectancy like I\'m a beginner', "What's the formula for VWAP?", 'Which strategy is best right now?', 'What is the price of bitcoin?', 'explain recursion']) {
    assert.equal(strategyMatrixIntent(other), null, other);
  }
  const empty = await strategyMatrixView(null, { sets: [null, null] });
  assert.match(speakStrategyMatrix({ kind: 'best', market: 'BTC' }, empty), /No real research run has finished for BTC/);
  const r = row({ strategy: 'ema20-pullback', market: 'BTC', tf: '15m', exp: 0.12 });
  r.name = 'EMA 20 pullback';
  const view = await strategyMatrixView(null, { sets: [{ generated_at: new Date().toISOString(), run_id: '9', rows: [r, row({ strategy: 'range-rejection', market: 'BTC', trades: 5 })] }, null] });
  const best = speakStrategyMatrix({ kind: 'best', market: 'BTC' }, view);
  assert.match(best, /1\. EMA 20 pullback on BTC 15-minute bars: 120 out-of-sample trades/);
  assert.match(best, /not win rate/);
  assert.match(best, /live trading is disabled/);
  const ex = speakStrategyMatrix({ kind: 'explain', key: 'ema20-pullback' }, view);
  assert.match(ex, /^EMA 20 pullback\. Rules: Long: 20 EMA above the 50 EMA/);
});

// The real Worker: owner-only route and the chat answers with no model call.
const generated = new URL('./.strategy_matrix.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace("import { DurableObject } from 'cloudflare:workers';", 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
async function owner() {
  const s = memoryStorage();
  s.setAlarm = async () => {}; s.deleteAlarm = async () => {}; s.getAlarm = async () => null;
  let calls = 0;
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => { calls++; return { response: 'model' }; } } };
  const state = new mod.CheState({ storage: s, waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '', method = 'POST') => mod.default.fetch(new Request(`https://che.example${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  return {
    send, token,
    get: async (p) => { const r = await send(p, null, token, 'GET'); return { status: r.status, body: await r.json() }; },
    say: async (message) => { const before = calls; const raw = await (await send('/api/chat', { message, history: [] }, token)).text(); const done = raw.trim().split('\n').map((l) => JSON.parse(l)).find((l) => l.type === 'done') || {}; return { reply: replyFromNdjson(raw), done, model_calls: calls - before }; },
  };
}

test('Worker: GET /api/trading/strategy-matrix is owner-only; voice answers come from the matrix with no model call', async () => {
  const che = await owner();
  assert.notEqual((await che.send('/api/trading/strategy-matrix', null, '', 'GET')).status, 200, 'a guest gets nothing');
  const v = await che.get('/api/trading/strategy-matrix');
  assert.equal(v.status, 200);
  assert.equal(v.body.live, 'disabled');
  assert.equal(v.body.strategies.length, 8);
  assert.equal(v.body.groups.length, 2);
  const best = await che.say("What's the best strategy for BTC?");
  assert.equal(best.done.source, 'che_strategy_matrix');
  assert.equal(best.model_calls, 0);
  assert.ok(best.reply.length > 20);
  const ex = await che.say('Explain the EMA 20 pullback');
  assert.equal(ex.done.source, 'che_strategy_matrix');
  assert.match(ex.reply, /EMA 20 pullback\. Rules:/);
  assert.equal(ex.model_calls, 0);
});
