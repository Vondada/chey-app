// CHE 86-style overnight range model (independent approximation — not the P2P indicator).
// Every bar below is a SYNTHETIC test fixture built to exercise one rule; none is market data.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INTRADAY_CANDIDATES, P86_NAME, intradayContext, newPortfolio, overnightLevels, overnightStats, p2p86Plan, stepPortfolio,
} from './trading_evidence.js';
import { definitionOf, strategyDefinitions } from './trading_research.js';
import { ICT_CONCEPTS, scopeFromWords, strategyRegistry } from './trading_controls.js';

const ID = 'p2p86-style-5m';
const DAY = 86400000;
// The UTC instant of a New York wall-clock time; `offset` is hours behind UTC (5 in winter, 4 in summer).
const at = (date, mins, offset) => Date.parse(`${date}T00:00:00Z`) + (mins + offset * 60) * 60000;
const iso = (ms) => new Date(ms).toISOString();
const bar = (t, o, h, l, c) => ({ t: iso(t), o, h, l, c, v: 100 });

/**
 * One CME day ending on `date`: overnight bars from 18:00 the evening before to 9:25 (one bar touches `onHigh`,
 * one touches `onLow`, the rest sit at `base`), then the given New York bars from 9:30, then flat bars at the
 * last close until 16:00.
 */
function cmeDay(date, offset, { onHigh, onLow, base, ny }) {
  const out = [];
  const prev = new Date(Date.parse(`${date}T00:00:00Z`) - DAY).toISOString().slice(0, 10);
  let k = 0;
  for (let m = 18 * 60; m < 24 * 60; m += 5, k++) out.push(bar(at(prev, m, offset), base, base + 1, base - 1, base));
  for (let m = 0; m < 9 * 60 + 30; m += 5, k++) {
    const hi = k === 100 ? onHigh : base + 1; const lo = k === 150 ? onLow : base - 1;
    out.push(bar(at(date, m, offset), base, hi, lo, base));
  }
  let m = 9 * 60 + 30;
  for (const [o, h, l, c] of ny) { out.push(bar(at(date, m, offset), o, h, l, c)); m += 5; }
  const last = ny.at(-1)[3];
  for (; m < 16 * 60; m += 5) out.push(bar(at(date, m, offset), last, last + 0.5, last - 0.5, last));
  return out;
}
const etIndex = (bars, x, mins) => bars.findIndex((_, i) => x.et[i] === mins);

// Overnight 100–140 (mid 120). New York opens at 125 (above the mid: bias toward the overnight high 140).
const LONG_DAY = { onHigh: 140, onLow: 100, base: 120, ny: [
  [125, 126, 120.5, 125.5], // 9:30
  [125.5, 126, 124.75, 125.25], // 9:35 forming: closes above the open but not above the prior high
  [125.25, 127.5, 125, 127], // 9:40 trigger: above the open 125 and the prior high 126
  [127, 131, 126.5, 130.5], [130.5, 135, 130, 134.5], [134.5, 140.5, 134, 139], // target taken at 9:55
] };

test('the overnight range is 18:00–9:30 New York and is known only from the 9:30 bar', () => {
  const bars = cmeDay('2026-03-10', 4, LONG_DAY);
  const x = intradayContext(bars);
  const i930 = etIndex(bars, x, 570);
  assert.equal(x.onHigh[i930 - 1], null, 'not known before 9:30');
  assert.equal(x.onHigh[i930], 140);
  assert.equal(x.onLow[i930], 100);
  assert.equal(x.nyOpen[i930], 125);
  assert.equal(x.nyOpen.at(-1), 125, 'the 9:30 open stays the day\'s reference');
});

test('daylight saving: the same New York schedule in a winter and a summer week gives the same levels', () => {
  for (const [date, offset] of [['2026-03-06', 5], ['2026-03-10', 4], ['2026-11-02', 5], ['2026-10-30', 4]]) {
    const bars = cmeDay(date, offset, LONG_DAY);
    const x = intradayContext(bars);
    const i = etIndex(bars, x, 570);
    assert.ok(i > 0, `${date}: a 9:30 New York bar exists`);
    assert.equal(new Date(bars[i].t).getUTCHours(), 9 + offset, `${date}: 9:30 New York is ${9 + offset}:30 UTC`);
    assert.deepEqual([x.onHigh[i], x.onLow[i], x.nyOpen[i]], [140, 100, 125], date);
  }
});

test('bias, forming, trigger, stop and target follow the written rules', () => {
  const bars = cmeDay('2026-03-10', 4, LONG_DAY);
  const x = intradayContext(bars);
  const at930 = p2p86Plan(bars, etIndex(bars, x, 570), x);
  assert.equal(at930.stage, 'watching');
  assert.match(at930.bias, /overnight high/);
  const forming = p2p86Plan(bars, etIndex(bars, x, 575), x);
  assert.equal(forming.stage, 'forming');
  const fired = p2p86Plan(bars, etIndex(bars, x, 580), x);
  assert.equal(fired.stage, 'triggered');
  assert.deepEqual({ side: fired.signal.side, ref: fired.signal.ref, stop: fired.signal.stop, target: fired.signal.target },
    { side: 'long', ref: 127, stop: 120.25, target: 140 }, 'stop 1 tick below the New York low 120.5; target the overnight high');
  assert.equal(p2p86Plan(bars, etIndex(bars, x, 585), x).stage, 'triggered_earlier', 'one setup per day');
});

test('the short side mirrors: open below the midpoint aims at the overnight low', () => {
  const day = { onHigh: 140, onLow: 100, base: 120, ny: [[115, 119.5, 114, 114.5], [114.5, 115, 112.5, 113]] };
  const bars = cmeDay('2026-03-10', 4, day);
  const x = intradayContext(bars);
  const p = p2p86Plan(bars, etIndex(bars, x, 575), x);
  assert.equal(p.stage, 'triggered');
  assert.deepEqual([p.signal.side, p.signal.stop, p.signal.target], ['short', 119.75, 100]);
});

test('invalidation, target taken first, expiry, no bias and the 1R floor give no trade', () => {
  const invalid = cmeDay('2026-03-10', 4, { ...LONG_DAY, ny: [[125, 126, 99, 101], [101, 110, 100.5, 109]] });
  let x = intradayContext(invalid);
  assert.equal(p2p86Plan(invalid, etIndex(invalid, x, 575), x).stage, 'invalidated', 'the overnight low went first');

  const taken = cmeDay('2026-03-10', 4, { ...LONG_DAY, ny: [[125, 141, 124, 139], [139, 140, 138, 139.5]] });
  x = intradayContext(taken);
  assert.equal(p2p86Plan(taken, etIndex(taken, x, 575), x).stage, 'target_taken');

  const quiet = cmeDay('2026-03-10', 4, { ...LONG_DAY, ny: [[125, 125.5, 124.5, 125]] });
  x = intradayContext(quiet);
  assert.equal(p2p86Plan(quiet, etIndex(quiet, x, 660), x).stage, 'expired', 'no entry by 11:00');

  const mid = cmeDay('2026-03-10', 4, { ...LONG_DAY, ny: [[120, 121, 119, 120], [120, 122, 119.5, 121.5]] });
  x = intradayContext(mid);
  assert.equal(p2p86Plan(mid, etIndex(mid, x, 575), x).stage, 'no_bias');

  // Overnight 100–128: the high is 1 point away from a 127 entry with a 3.25-point stop: under 1R, skipped.
  const near = cmeDay('2026-03-10', 4, { ...LONG_DAY, onHigh: 128, ny: LONG_DAY.ny.slice(0, 3) });
  x = intradayContext(near);
  const p = p2p86Plan(near, etIndex(near, x, 580), x);
  assert.equal(p.signal, null);
  assert.match(p.reason, /under 1R/);
});

test('no look-ahead: every bar\'s plan is the same when later bars do not exist yet', () => {
  const bars = [...cmeDay('2026-03-09', 4, LONG_DAY), ...cmeDay('2026-03-10', 4, { ...LONG_DAY, ny: [[115, 116, 114, 114.5], [114.5, 115, 112.5, 113]] })];
  const full = intradayContext(bars);
  for (let i = 0; i < bars.length; i += 7) {
    const cut = bars.slice(0, i + 1);
    const a = p2p86Plan(bars, i, full); const b = p2p86Plan(cut, i, intradayContext(cut));
    assert.deepEqual(a, b, `bar ${i} (${bars[i].t})`);
  }
});

test('the backtest engine fills at the next open, exits at the overnight high and records CHE\'s rule text', () => {
  const bars = cmeDay('2026-03-10', 4, LONG_DAY);
  const pf = newPortfolio(ID, 'any', { contract: 'MNQ', qty: 1, source: 'backtest', resolution: '5m', priceSeries: '5m', params: { target_r: 2 } });
  const trades = stepPortfolio(pf, bars, intradayContext(bars));
  assert.equal(trades.length, 1);
  const t = trades[0];
  assert.equal(t.side, 'long');
  assert.equal(t.exit.reason, 'target');
  assert.match(t.signal.why, /86-style approximation/);
});

test('labels: an independent approximation everywhere, never the original indicator', () => {
  assert.equal(INTRADAY_CANDIDATES[ID].name, P86_NAME);
  assert.match(P86_NAME, /independent approximation — not the P2P indicator/);
  assert.match(INTRADAY_CANDIDATES[ID].rules, /not published and not copied/);
  const def = definitionOf(ID);
  assert.deepEqual(def.timeframes, ['15s', '30s', '1m', '2m', '5m', '15m'], 'only bars that close exactly at 9:30');
  assert.match(def.target_rule, /overnight high or low/);
  assert.ok(strategyDefinitions().some((d) => d.strategy_id === ID));
  const reg = strategyRegistry({})[ID];
  assert.match(reg.approximation, /not the original closed-source indicator/);
  assert.ok(ICT_CONCEPTS.find((k) => k.id === 'overnight_range').strategies.includes(ID));
  assert.equal(scopeFromWords('disable the 86 model'), ID);
  assert.equal(scopeFromWords('enable p2p'), ID);
});

test('chart levels and measured frequencies are CHE\'s own, with their sample size', () => {
  const bars = cmeDay('2026-03-10', 4, LONG_DAY);
  const lv = overnightLevels(bars.slice(0, bars.findIndex((b) => b.t === iso(at('2026-03-10', 580, 4))) + 1));
  assert.equal(lv.label, P86_NAME);
  assert.deepEqual([lv.onHigh, lv.onLow, lv.mid, lv.stage], [140, 100, 120, 'triggered']);
  assert.deepEqual(lv.signal, { side: 'long', ref: 127, stop: 120.25, target: 140 });
  const days = [
    ...cmeDay('2026-03-09', 4, LONG_DAY), // high first, low never
    ...cmeDay('2026-03-10', 4, { ...LONG_DAY, ny: [[125, 126, 99, 101], [101, 141, 100.5, 139]] }), // low first, then high
  ];
  const s = overnightStats(days);
  assert.match(s.label, /not the P2P indicator/);
  assert.equal(s.days, 2);
  assert.deepEqual(s.ny_took_either, { count: 2, of: 2, pct: 100 });
  assert.deepEqual(s.bias_side_first, { count: 1, of: 2, pct: 50 });
  assert.deepEqual(s.second_side_after_first, { count: 1, of: 2, pct: 50 });
  assert.equal(s.enough, false, 'two days are not evidence');
});
