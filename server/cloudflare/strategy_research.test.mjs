// Strategy research (lane T8, owner 2026-10-23). Every bar is a seeded TEST FIXTURE, never market data: these tests
// prove the research rules, the cost model, the in-sample / out-of-sample split, the comparison and its honest labels,
// not any strategy's edge.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONTRACTS, COSTS, INTRADAY_CANDIDATES, RESEARCH_DAILY_CANDIDATES, RESEARCH_INTRADAY_CANDIDATES, causalContext, etParts, fillEntry, fillExit,
  intradayContext, settleTrade,
} from './trading_evidence.js';
import { COST_PROFILES, aggregateBars, evaluateUnit, importDataset, saveUnit, selectStrategies, strategyDefinitions } from './trading_research.js';
import { liveSpecs } from './trading_live.js';
import { scopeIds } from './trading_controls.js';
import { roundTripCost, marketSpec } from './trading_market_spec.js';
import { compareStrategies, compareUnits, comparisonView, orderFlowReadiness, verdictOf, DATA_SOURCE_FINDINGS } from './strategy_research.js';
import { ENTRIES as RESEARCH_SEEDS, RESEARCH_SOURCES } from './library_seeds/research.js';
import { entryProblems, libraryView } from './strategy_library.js';
import { fixtureBars, fixtureDaily } from './test_fixtures/trading_fixture.mjs';

globalThis.fetch = async (input) => { throw new TypeError(`fetch failed (offline test: ${new URL(String(input?.url || input)).host})`); };

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

const NOW = Date.parse('2024-04-01T00:00:00Z');
const B15 = fixtureBars({ start: '2024-03-03T23:00:00Z', days: 12 });
const BARS5 = aggregateBars(B15, '15s', '5m', { now: NOW });
const DAILY = fixtureDaily({ from: '2010-01-04', years: 12 });
const MAN = (bars) => ({ first: bars[0].t, last: bars.at(-1).t, sha256: 'fixture', roll_dates: [], provider: 'TEST FIXTURE' });
const RESEARCH_IDS = [...Object.keys(RESEARCH_INTRADAY_CANDIDATES), ...Object.keys(RESEARCH_DAILY_CANDIDATES)];
// A 5-minute bar at a New York wall-clock time on 2024-03-12 (EDT, UTC−4).
const at = (hhmm, o, h, l, c) => ({ t: `2024-03-12T${String(Number(hhmm.slice(0, 2)) + 4).padStart(2, '0')}:${hhmm.slice(3)}:00.000Z`, o, h, l, c, v: 100 });

test('R1 cost model: the spec states exactly what fillEntry, fillExit and settleTrade charge', () => {
  for (const contract of ['MNQ', 'NQ']) for (const profile of ['OPTIMISTIC', 'NORMAL', 'STRESS']) {
    const costs = COST_PROFILES[profile];
    const c = CONTRACTS[contract];
    const bar = { t: '2024-03-12T14:00:00.000Z', o: 18000, h: 18010, l: 17990, c: 18005 };
    const entry = fillEntry(bar, c, costs, 'long');
    const exit = fillExit(17980, 'stop', c, costs, 'long');
    const s = settleTrade({ side: 'long', entry, stop: 17980 }, exit, 1, c, costs);
    const charged = s.costs.spread + s.costs.slippage + s.costs.commissions + s.costs.fees;
    assert.equal(roundTripCost(contract, profile, 'stop').total, Math.round(charged * 100) / 100, `${contract} ${profile}`);
    const tgt = settleTrade({ side: 'long', entry, stop: 17980 }, fillExit(18040, 'target', c, costs, 'long'), 1, c, costs);
    assert.equal(roundTripCost(contract, profile, 'target').total, Math.round((tgt.costs.spread + tgt.costs.slippage + tgt.costs.commissions + tgt.costs.fees) * 100) / 100);
  }
  // MNQ normal: 1 tick spread ($0.50) + 2 ticks slippage ($1.00) + 2 × ($1.50 + $0.50) = $5.50, 2.75 points.
  assert.deepEqual([roundTripCost('MNQ').total, roundTripCost('MNQ').points], [5.5, 2.75]);
  const spec = marketSpec(2024);
  assert.equal(spec.contracts.MNQ.tick_value, 0.5);
  assert.equal(spec.contracts.NQ.tick_value, 5);
  assert.ok(spec.holidays.closed.includes('2024-03-29'), 'Good Friday 2024 is closed');
  assert.match(spec.cost_note, /not a broker schedule/);
});

test('R2 research strategies are backtest only: never in the live paper grid, the owner controls or the selector', () => {
  const live = new Set(liveSpecs().map((s) => s.c));
  for (const id of RESEARCH_IDS) {
    assert.ok(!INTRADAY_CANDIDATES[id], `${id} is not a live candidate`);
    assert.ok(!live.has(id), `${id} is not in the live paper grid`);
    assert.ok(!scopeIds('all').includes(id), `${id} is not in the owner controls`);
    const d = strategyDefinitions().find((x) => x.strategy_id === id);
    assert.ok(d?.research && /owner enables/.test(d.paper), id);
  }
  const unit = evaluateUnit({ strategyId: 'squeeze-5m', market: 'MNQ', tf: '5m', bars: BARS5, manifest: MAN(BARS5) });
  assert.ok(unit.ok);
  const forced = { ...unit, all: { ...unit.all, trades: 500 }, oos: { ...unit.oos, trades: 200, expectancy_r: 1 } };
  assert.equal(selectStrategies([forced], { market: 'MNQ', timeframe: '5m' }).ranked.length, 0, 'a research strategy is never selected to trade');
});

test('R3 no look-ahead: each research rule gives the same signal on a series cut at that bar', () => {
  const cases = [['5m', BARS5, intradayContext], ['1D', DAILY, causalContext]];
  for (const [tf, bars, ctxOf] of cases) {
    const table = tf === '5m' ? RESEARCH_INTRADAY_CANDIDATES : RESEARCH_DAILY_CANDIDATES;
    const full = ctxOf(bars);
    for (const [id, cand] of Object.entries(table)) {
      let checked = 0;
      for (let i = 30; i < bars.length && checked < 40; i += Math.max(1, Math.floor(bars.length / 400))) {
        const a = cand.entry(bars, i, full);
        const cut = bars.slice(0, i + 1);
        const b = cand.entry(cut, i, ctxOf(cut));
        assert.deepEqual(a, b, `${id} at bar ${i}`);
        if (a) checked++;
      }
      assert.ok(checked > 0 || id === 'orb5-first-candle-5m' || id === 'rsi2-connors', `${id} fired at least once on the fixture`);
    }
  }
});

test('R4 first 5-minute candle: direction of the 9:30 bar, stop at its other side, 10R target, no trade on a doji', () => {
  const pre = Array.from({ length: 6 }, (_, k) => at(`09:${String(k * 5).padStart(2, '0')}`, 18000, 18002, 17998, 18000));
  const up = [...pre, at('09:30', 18000, 18030, 17990, 18020), at('09:35', 18020, 18025, 18015, 18022)];
  const x = intradayContext(up);
  const sig = RESEARCH_INTRADAY_CANDIDATES['orb5-first-candle-5m'].entry(up, 6, x);
  assert.deepEqual([sig.side, sig.ref, sig.stop, sig.target], ['long', 18020, 17990, 18020 + 10 * 30]);
  const down = [...pre, at('09:30', 18000, 18010, 17970, 17980)];
  const s2 = RESEARCH_INTRADAY_CANDIDATES['orb5-first-candle-5m'].entry(down, 6, intradayContext(down));
  assert.deepEqual([s2.side, s2.stop, s2.target], ['short', 18010, 17980 - 10 * 30]);
  const doji = [...pre, at('09:30', 18000, 18020, 17980, 18000)];
  assert.equal(RESEARCH_INTRADAY_CANDIDATES['orb5-first-candle-5m'].entry(doji, 6, intradayContext(doji)), null);
  assert.equal(RESEARCH_INTRADAY_CANDIDATES['orb5-first-candle-5m'].entry(up, 7, x), null, 'only the 9:30 bar sets it');
});

test('R5 initial balance breakout: known only after 10:30, first close beyond, stop at the middle', () => {
  const bars = [];
  for (let m = 570; m < 630; m += 5) bars.push(at(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`, 18000, 18020, 17980, 18005));
  bars.push(at('10:30', 18005, 18030, 18000, 18025));   // closes above the balance high 18020
  bars.push(at('10:35', 18025, 18040, 18020, 18035));
  const x = intradayContext(bars);
  const ib = RESEARCH_INTRADAY_CANDIDATES['ib-breakout-5m'];
  for (let i = 0; i < 12; i++) assert.equal(ib.entry(bars, i, x), null, 'nothing before the balance is complete');
  const sig = ib.entry(bars, 12, x);
  assert.deepEqual([sig.side, sig.stop], ['long', 18000]);
  assert.equal(ib.entry(bars, 13, x), null, 'only the first close beyond');
});

test('R6 daily rules: RSI(2) needs 200 days and targets the 5-day average; the 20-day breakout fires once per breakout', () => {
  const rsi = RESEARCH_DAILY_CANDIDATES['rsi2-connors'];
  const x = causalContext(DAILY);
  for (let i = 0; i < 200; i++) assert.equal(rsi.entry(DAILY, i, x), null);
  const don = RESEARCH_DAILY_CANDIDATES['donchian-20'];
  for (let i = 23; i < DAILY.length; i++) {
    const s = don.entry(DAILY, i, x);
    if (!s) continue;
    assert.ok(s.stop < s.ref);
    if (i + 1 < DAILY.length) assert.equal(don.entry(DAILY, i + 1, x), null, 'no second signal the next day: the breakout is already above');
  }
});

test('R7 comparison: same dataset only, in-sample + out-of-sample = all, honest verdicts and overfit warnings', () => {
  const cmp = compareStrategies({ market: 'MNQ', tf: '5m', bars: BARS5, manifest: MAN(BARS5) });
  assert.ok(cmp.ok);
  assert.ok(cmp.rows.length >= 10, 'every 5-minute strategy, existing and research, on the same bars');
  assert.ok(cmp.rows.some((r) => r.research) && cmp.rows.some((r) => !r.research));
  for (const r of cmp.rows) {
    assert.equal(r.in_sample.trades + r.out_of_sample.trades, r.all.trades, `${r.strategy_id}: IS + OOS = all, no trade counted twice`);
    assert.equal(r.look_ahead, 'passed');
    assert.ok(r.verdict);
    if (!r.all.trades) assert.equal(r.verdict, 'no trades');
    else if (r.all.trades < 30) assert.match(r.verdict, /insufficient evidence/);
    if (!r.out_of_sample.trades) assert.match(r.overfit_warning, /in-sample only/);
  }
  assert.equal(cmp.same_period.sha256, 'fixture');
  assert.match(cmp.multiple_comparisons, /partly luck/);
  assert.equal(cmp.live_trading, 'disabled');
  assert.ok(cmp.assumptions.cost_profiles.NORMAL);
  // A unit on another dataset is excluded, never mixed in.
  const other = { ...evaluateUnit({ strategyId: 'supertrend-5m', market: 'MNQ', tf: '5m', bars: BARS5, manifest: { ...MAN(BARS5), sha256: 'other' } }) };
  const mixed = compareUnits([...cmp.rows.map(() => null), other, evaluateUnit({ strategyId: 'squeeze-5m', market: 'MNQ', tf: '5m', bars: BARS5, manifest: MAN(BARS5) }), evaluateUnit({ strategyId: 'orb-15m', market: 'MNQ', tf: '5m', bars: BARS5, manifest: MAN(BARS5) })]);
  assert.deepEqual(mixed.excluded.map((e) => e.reason), ['a different dataset or period']);
});

test('R8 verdicts and conditions never claim more than the sample supports', () => {
  assert.match(verdictOf({ trades: 12, expectancy_ci: { low: 0.5, high: 0.9 } }), /insufficient evidence \(12 trades; 30 needed\)/);
  assert.match(verdictOf({ trades: 80, expectancy_ci: { low: -0.1, high: 0.3 } }), /not distinguishable from zero/);
  assert.match(verdictOf({ trades: 80, expectancy_ci: { low: 0.05, high: 0.3 } }), /positive after costs/);
  assert.match(verdictOf({ trades: 80, expectancy_ci: { low: -0.4, high: -0.1 } }), /negative after costs/);
  const cmp = compareStrategies({ market: 'MNQ', tf: '5m', bars: BARS5, manifest: MAN(BARS5) });
  for (const c of cmp.conditions) {
    if (c.best) {
      assert.ok(c.best.trades >= 30 && c.best.ci.low > 0, `${c.dimension}/${c.condition} names a best strategy only with 30+ trades and an interval above zero`);
    } else assert.match(c.answer, /insufficient evidence|no strategy is positive/);
  }
  assert.ok(['session', 'market structure', 'volatility regime'].every((d) => cmp.conditions.some((c) => c.dimension === d)));
});

test('R9 event days: trades bucketed by their New York trade date tags; without a calendar it says so', () => {
  const plain = compareStrategies({ market: 'MNQ', tf: '5m', bars: BARS5, manifest: MAN(BARS5), strategyIds: ['supertrend-5m'] });
  assert.equal(plain.events.available, false);
  const days = [...new Set(BARS5.map((b) => etParts(b.t).day))];
  const tagsByDay = { [days[3]]: ['CPI (fixture tag)'], [days[5]]: ['FOMC (fixture tag)'] };
  const ev = compareStrategies({ market: 'MNQ', tf: '5m', bars: BARS5, manifest: MAN(BARS5), strategyIds: ['supertrend-5m'], tagsByDay });
  const buckets = ev.events.by_strategy[0].buckets;
  const total = buckets.reduce((a, b) => a + b.trades, 0);
  assert.equal(total, ev.rows[0].all.trades, 'every trade lands in exactly one bucket when each day has at most one tag');
  for (const b of buckets) if (b.trades < 30) assert.match(b.verdict, /insufficient evidence/);
});

test('R10 stored comparison view reads only backtests for the asked market and timeframe', async () => {
  const st = memoryStorage();
  for (const id of ['supertrend-5m', 'orb-15m']) await saveUnit(st, evaluateUnit({ strategyId: id, market: 'MNQ', tf: '5m', bars: BARS5, manifest: MAN(BARS5) }));
  await saveUnit(st, evaluateUnit({ strategyId: 'donchian-20', market: 'MNQ', tf: '1D', bars: DAILY, manifest: MAN(DAILY) }));
  const v = await comparisonView(st, { market: 'MNQ', tf: '5m' });
  assert.deepEqual(v.rows.map((r) => r.strategy_id).sort(), ['orb-15m', 'supertrend-5m']);
  const none = await comparisonView(memoryStorage(), { market: 'MNQ', tf: '5m' });
  assert.equal(none.ok, false);
  assert.match(none.reason, /No backtest results/);
});

test('R11 order flow: sessions are counted only from Rithmic bars that carry a real delta', async () => {
  const empty = await orderFlowReadiness(memoryStorage());
  assert.deepEqual([empty.sessions, empty.ready], [0, false]);
  assert.match(empty.status, /No recorded Rithmic order-flow session/);
  const st = memoryStorage();
  const bars = aggregateBars(B15, '15s', '1m', { now: NOW }).map((b, i) => ({ ...b, delta: i % 3 - 1 }));
  await importDataset(st, { market: 'MNQ', tf: '1m', bars, provider: 'Rithmic ticker plant (owner login)' });
  const rec = await orderFlowReadiness(st);
  assert.equal(rec.sessions, new Set(bars.map((b) => etParts(b.t).day)).size);
  assert.match(rec.status, /recorded since/);
  const yahoo = memoryStorage();
  await importDataset(yahoo, { market: 'MNQ', tf: '1m', bars, provider: 'Yahoo Finance (delayed)' });
  assert.equal((await orderFlowReadiness(yahoo)).sessions, 0, 'a delta on non-Rithmic bars is not order flow');
  assert.ok(DATA_SOURCE_FINDINGS.every((d) => d.status), 'every data source says whether it is used');
  assert.ok(DATA_SOURCE_FINDINGS.filter((d) => /paid|account/.test(d.status)).length >= 2, 'paid sources wait for the owner');
});

test('R12 library: research seeds pass the library check, cite sources, and reach the right stage from evidence', async () => {
  for (const e of RESEARCH_SEEDS) assert.deepEqual(entryProblems(e), [], e.id);
  for (const [id, s] of Object.entries(RESEARCH_SOURCES)) {
    assert.ok(RESEARCH_IDS.includes(id), id);
    assert.ok(s.sources.length && s.sources.every((x) => /^https:\/\//.test(x.url) && x.accessed), id);
  }
  const st = memoryStorage();
  await saveUnit(st, evaluateUnit({ strategyId: 'supertrend-5m', market: 'MNQ', tf: '5m', bars: BARS5, manifest: MAN(BARS5) }));
  const view = await libraryView(st);
  const by = Object.fromEntries(view.entries.map((e) => [e.id, e]));
  assert.equal(by['supertrend-5m'].lifecycle, 'backtested');
  assert.equal(by['squeeze-5m'].lifecycle, 'implemented');
  assert.match(by['supertrend-5m'].not_running, /research strategy/);
  assert.ok(by['supertrend-5m'].sources.some((s) => /ta-lib/.test(s.url || '')));
  assert.equal(by['inverse-fvg'].lifecycle, 'discovered');
  assert.equal(by['judas-swing'].lifecycle, 'discovered');
  assert.equal(by['value-area-80-rule'].lifecycle, 'rules_documented');
  assert.equal(by['vix-vxn-regime'].kind, 'market_context');
  for (const id of RESEARCH_IDS) assert.notEqual(by[id].lifecycle, 'paper_active', `${id} never paper trades on its own`);
});
