// Knowledge Atlas calculators (issue #346, trading lane). Every calculator is checked against
// numbers worked out by hand here, and against an independent computation: brute force, a
// different algorithm, CHE's own evidence engine, or a rule written out separately in the test
// (US daylight saving). Offline and deterministic.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FUTURES_SPECS, VERDICT_RULES, bookFill, candleAnatomy, costInR, expectancyStats, fairValueGaps, futuresRisk, latestRthSession,
  liquiditySweeps, maxDrawdown, monteCarlo, mulberry32, openingRange, optionAtExpiry, orderBlock, percentile, positionSize,
  premiumDiscount, profitFactor, rMultiple, rewardRisk, riskOfRuin, rthOpenOf, sampleSizeForMargin, sessionLevels, stockShares,
  strategyVerdict, structureBreaks, studentTCdf, tQuantile, vwapBands, winRateInterval,
} from './atlas_math.js';
import { FORMULAS } from './knowledge_atlas.js';
import { CONTRACTS, INTRADAY_CANDIDATES, intradayContext, summarize, wilsonInterval } from './trading_evidence.js';
import { POINT_VALUE } from './trading_lab.js';

globalThis.fetch = async () => { throw new TypeError('atlas_math tests are offline'); };

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const rng = mulberry32(20261019);
const randInt = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

// ─── Contract specs ───────────────────────────────────────────────────────

test('one spec table, matching CME\'s published values and CHE\'s engine and lab', () => {
  const cme = { NQ: [20, 5], MNQ: [2, 0.5], ES: [50, 12.5], MES: [5, 1.25] };
  for (const [sym, [pv, tickValue]] of Object.entries(cme)) {
    assert.equal(FUTURES_SPECS[sym].pointValue, pv, sym);
    assert.equal(FUTURES_SPECS[sym].tick, 0.25, sym);
    assert.equal(FUTURES_SPECS[sym].tickValue, tickValue, sym);
    assert.match(FUTURES_SPECS[sym].url, /^https:\/\/www\.cmegroup\.com\//, sym);
  }
  for (const sym of ['NQ', 'MNQ']) {
    assert.equal(FUTURES_SPECS[sym].pointValue, CONTRACTS[sym].pointValue, `${sym} matches trading_evidence.js`);
    assert.equal(FUTURES_SPECS[sym].tick, CONTRACTS[sym].tick);
  }
  assert.equal(FUTURES_SPECS.ES.pointValue, POINT_VALUE['es.f'].full);
  assert.equal(FUTURES_SPECS.MES.pointValue, POINT_VALUE['es.f'].micro);
  assert.equal(FUTURES_SPECS.NQ.pointValue, POINT_VALUE['nq.f'].full);
  assert.equal(FUTURES_SPECS.MNQ.pointValue, POINT_VALUE['nq.f'].micro);
});

// ─── Futures, stocks, R and options ───────────────────────────────────────

test('futures risk: hand-worked values, ticks, prices and costs, and brute force by ticks', () => {
  const r = futuresRisk({ symbol: 'MNQ', contracts: 2, stopPoints: 12 });
  assert.equal(r.value, 48, '2 × 12 × $2');
  assert.deepEqual(r.steps.slice(1, 3), ['risk per contract = 12 points × $2.00 a point = $24.00', 'total risk = $24.00 × 2 contracts = $48.00']);
  assert.match(r.steps.at(-1), /you gave none, so none are assumed/, 'no default fee is presented as fact');
  assert.equal(futuresRisk({ symbol: 'NQ', stopPoints: 10 }).value, 200);
  assert.equal(futuresRisk({ symbol: 'ES', contracts: 2, stopPoints: 4 }).value, 400);
  assert.equal(futuresRisk({ symbol: 'MES', contracts: 3, stopPoints: 8 }).value, 120);
  assert.equal(futuresRisk({ symbol: 'mnq', stopTicks: 40 }).value, 20, '40 ticks = 10 points');
  assert.equal(futuresRisk({ symbol: 'MNQ', entry: 21000, stop: 20987.5 }).values.points, 12.5);
  const fees = futuresRisk({ symbol: 'MNQ', contracts: 2, stopPoints: 12, roundTripFees: 5 });
  assert.equal(fees.values.totalWithCosts, 58);
  assert.match(futuresRisk({ symbol: 'MNQ', stopPoints: 12.1 }).steps.join(' '), /not a whole number of 0\.25-point ticks/);
  for (let i = 0; i < 300; i += 1) {
    const sym = ['NQ', 'MNQ', 'ES', 'MES'][i % 4];
    const ticks = randInt(1, 400); const n = randInt(1, 10);
    // Independent: ticks × dollars per tick × contracts, in cents to stay exact.
    const cents = ticks * Math.round(FUTURES_SPECS[sym].tickValue * 100) * n;
    assert.equal(Math.round(futuresRisk({ symbol: sym, contracts: n, stopTicks: ticks }).value * 100), cents, `${sym} ${ticks} ticks × ${n}`);
  }
  for (const bad of [{ symbol: 'CL', stopPoints: 1 }, { symbol: 'MNQ', stopPoints: 0 }, { symbol: 'MNQ', contracts: 1.5, stopPoints: 2 }, { symbol: 'MNQ' }]) {
    const out = futuresRisk(bad);
    assert.equal(out.ok, false, JSON.stringify(bad));
    assert.equal(out.value, null, 'a refusal carries no number');
  }
});

test('position size: the largest whole number of contracts inside the budget, by brute force', () => {
  assert.equal(positionSize({ symbol: 'MNQ', riskDollars: 200, stopPoints: 10 }).value, 10, '$200 ÷ (10 × $2)');
  assert.equal(positionSize({ symbol: 'MNQ', riskPercent: 1, account: 25000, stopPoints: 12 }).value, 10, '$250 ÷ $24 = 10.4');
  assert.equal(positionSize({ symbol: 'MNQ', riskDollars: 200, stopPoints: 10, roundTripFees: 5 }).value, 8, '$200 ÷ $25');
  const none = positionSize({ symbol: 'NQ', riskDollars: 150, stopPoints: 10 });
  assert.equal(none.value, 0);
  assert.match(none.steps.join(' '), /even 1 contract risks \$200\.00, more than \$150\.00.*one MNQ risks a tenth as much/);
  for (let i = 0; i < 500; i += 1) {
    const sym = ['NQ', 'MNQ', 'ES', 'MES'][i % 4];
    const budget = randInt(1, 5000); const stopTicks = randInt(1, 200);
    const per = stopTicks * FUTURES_SPECS[sym].tickValue;
    let k = 0;
    while ((k + 1) * per <= budget + 1e-9) k += 1;
    assert.equal(positionSize({ symbol: sym, riskDollars: budget, stopTicks }).value, k, `${sym} $${budget} ${stopTicks} ticks`);
  }
  assert.equal(positionSize({ symbol: 'MNQ', stopPoints: 10 }).ok, false, 'no budget, no size');
  // The phase-1 formula is the same rule.
  assert.equal(positionSize({ symbol: 'MNQ', riskDollars: 100, stopPoints: 10 }).value, FORMULAS.positionSize({ risk: 100, stopPoints: 10, pointValue: 2 }));
});

test('reward to risk and the break-even win rate, which makes the expected value zero', () => {
  const plan = rewardRisk({ symbol: 'MNQ', side: 'long', entry: 18000, stop: 17990, target: 18030 });
  assert.equal(plan.value, 3);
  assert.deepEqual([plan.values.riskDollars, plan.values.rewardDollars, plan.values.breakevenWinRate], [20, 60, 0.25]);
  const short = rewardRisk({ side: 'short', entry: 100, stop: 102, target: 94 });
  assert.equal(short.value, 3);
  assert.equal(rewardRisk({ side: 'long', entry: 100, stop: 101, target: 105 }).ok, false, 'a long\'s stop above its entry is refused');
  assert.equal(rewardRisk({ side: 'short', entry: 100, stop: 102, target: 103 }).ok, false);
  const costs = rewardRisk({ symbol: 'MNQ', entry: 18000, stop: 17990, target: 18030, roundTripFees: 5 });
  assert.equal(costs.values.breakevenWinRateAfterCosts, 25 / 80);
  // Independent: at the break-even win rate the expected dollars, after costs, are zero.
  for (let i = 0; i < 200; i += 1) {
    const risk = randInt(1, 80); const reward = randInt(1, 200); const fee = randInt(0, 10); const n = randInt(1, 5);
    const out = rewardRisk({ symbol: 'MNQ', entry: 20000, stop: 20000 - risk, target: 20000 + reward, contracts: n, roundTripFees: fee });
    const p = out.values.breakevenWinRateAfterCosts;
    const ev = p * (reward * 2 * n - fee * n) - (1 - p) * (risk * 2 * n + fee * n);
    assert.ok(close(ev, 0, 1e-7), `EV at break-even is 0 (${risk}, ${reward}, ${fee})`);
  }
});

test('shares from risk and the R-multiple agree with brute force and the phase-1 formula', () => {
  assert.equal(stockShares({ entry: 50, stop: 48, riskDollars: 100 }).value, 50);
  assert.equal(stockShares({ entry: 20, stop: 19.5, riskDollars: 75 }).value, 150);
  assert.equal(stockShares({ stopDistance: 2, riskDollars: 100 }).value, 50, 'a dollar distance alone is enough');
  assert.equal(stockShares({ entry: 50, stop: 48, riskPercent: 2, account: 10000 }).value, 100);
  for (let i = 0; i < 300; i += 1) {
    const cents = randInt(1, 500); const budget = randInt(1, 2000);
    let k = 0;
    while ((k + 1) * cents <= budget * 100) k += 1;
    assert.equal(stockShares({ entry: 100, stop: 100 - cents / 100, riskDollars: budget }).value, k, `${cents}¢ $${budget}`);
  }
  for (const [entry, stop, exit, side] of [[100, 98, 105, 'long'], [50, 48, 54, 'long'], [100, 103, 94, 'short'], [21000, 20990, 20985, 'long']]) {
    assert.ok(close(rMultiple({ entry, stop, exit, side }).value, FORMULAS.rMultiple({ entry, stop, exit, side })));
  }
});

test('options at expiry: breakeven, worst and best cases match a brute-force payoff scan', () => {
  const c = optionAtExpiry({ type: 'call', position: 'long', strike: 100, premium: 3, underlying: 110 });
  assert.deepEqual([c.value.breakeven, c.value.maxLoss, c.value.intrinsic, c.value.pnl, c.value.maxGain], [103, 300, 10, 700, null]);
  const p = optionAtExpiry({ type: 'put', position: 'long', strike: 50, premium: 2, underlying: 45 });
  assert.deepEqual([p.value.breakeven, p.value.maxLoss, p.value.maxGain, p.value.pnl], [48, 200, 4800, 300]);
  // Independent: scan the payoff at expiry over prices from 0 to 4 × strike, in cents.
  for (const type of ['call', 'put']) {
    for (const position of ['long', 'short']) {
      for (let i = 0; i < 20; i += 1) {
        const K = randInt(10, 300); const prem = randInt(1, 30) / 2; const n = randInt(1, 3);
        const out = optionAtExpiry({ type, position, strike: K, premium: prem, contracts: n });
        const pnlAt = (S) => ((type === 'call' ? Math.max(0, S - K) : Math.max(0, K - S)) - prem) * 100 * n * (position === 'long' ? 1 : -1);
        const grid = Array.from({ length: 4 * K * 100 + 1 }, (_, j) => j / 100);
        const values = grid.map(pnlAt);
        assert.ok(close(pnlAt(out.value.breakeven), 0, 1e-6), `${position} ${type}: zero at breakeven`);
        const unbounded = pnlAt(1e9) - pnlAt(1e8);
        if (out.value.maxLoss == null) assert.ok(unbounded < 0, 'unlimited loss keeps growing');
        else assert.ok(close(-Math.min(...values), out.value.maxLoss, 1e-6), `${position} ${type} max loss`);
        if (out.value.maxGain == null) assert.ok(unbounded > 0, 'unlimited gain keeps growing');
        else assert.ok(close(Math.max(...values), out.value.maxGain, 1e-6), `${position} ${type} max gain`);
      }
    }
  }
  assert.equal(optionAtExpiry({ type: 'straddle', strike: 1, premium: 1 }).ok, false);
});

test('a market order through the book, and cost drag in R', () => {
  const fill = bookFill({ side: 'buy', qty: 10, symbol: 'MNQ', levels: [{ price: 21000.25, size: 4 }, { price: 21000.5, size: 3 }, { price: 21000.75, size: 5 }] });
  assert.ok(close(fill.value.avgPrice, 21000.475, 1e-9));
  assert.ok(close(fill.value.slippagePoints, 0.225, 1e-9));
  assert.equal(fill.value.slippageDollars, 4.5);
  const sell = bookFill({ side: 'sell', qty: 3, symbol: 'NQ', levels: [{ price: 100, size: 1 }, { price: 99.75, size: 5 }] });
  assert.ok(close(sell.value.avgPrice, (100 + 99.75 * 2) / 3));
  assert.ok(close(sell.value.slippageDollars, (100 - sell.value.avgPrice) * 20 * 3, 0.01));
  assert.equal(bookFill({ side: 'buy', qty: 20, symbol: 'MNQ', levels: [{ price: 1, size: 3 }] }).ok, false, 'a book too thin is said, not guessed');
  const drag = costInR({ grossR: 0.15, roundTripCost: 5.5, riskDollars: 40 });
  assert.ok(close(drag.value.costR, 0.1375) && close(drag.value.netR, 0.0125));
});

// ─── Sessions: New York time, daylight saving included ────────────────────

// US daylight saving, written out separately: from the second Sunday of March to the first Sunday of November.
function usDaylight(day) {
  const [y, m, d] = day.split('-').map(Number);
  const nthSunday = (month, nth) => { const first = new Date(Date.UTC(y, month - 1, 1)).getUTCDay(); return 1 + ((7 - first) % 7) + 7 * (nth - 1); };
  if (m < 3 || m > 11) return false;
  if (m > 3 && m < 11) return true;
  return m === 3 ? d >= nthSunday(3, 2) : d < nthSunday(11, 1);
}

test('the 9:30 New York open in UTC follows daylight saving on every day of 2024 to 2027', () => {
  assert.equal(rthOpenOf('2026-03-06'), '2026-03-06T14:30:00.000Z', 'Friday before the change: standard time');
  assert.equal(rthOpenOf('2026-03-08'), '2026-03-08T13:30:00.000Z', 'the change day itself: daylight from 2 a.m.');
  assert.equal(rthOpenOf('2026-03-09'), '2026-03-09T13:30:00.000Z', 'Monday after: daylight time');
  assert.equal(rthOpenOf('2026-10-30'), '2026-10-30T13:30:00.000Z');
  assert.equal(rthOpenOf('2026-11-01'), '2026-11-01T14:30:00.000Z', 'back to standard time from 2 a.m.');
  assert.equal(rthOpenOf('2026-11-02'), '2026-11-02T14:30:00.000Z');
  for (let t = Date.UTC(2024, 0, 1); t < Date.UTC(2028, 0, 1); t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    assert.equal(rthOpenOf(day), `${day}T${usDaylight(day) ? '13' : '14'}:30:00.000Z`, day);
  }
});

const fiveMinute = (startIso, count, f) => Array.from({ length: count }, (_, i) => {
  const t = new Date(Date.parse(startIso) + i * 300_000).toISOString();
  const { o, h, l, c, v } = f(i);
  return { t, o, h, l, c, v };
});
const wave = (i) => { const m = 100 + 3 * Math.sin(i / 3) + i * 0.1; return { o: m, h: m + 1 + (i % 3) * 0.25, l: m - 1 - (i % 2) * 0.5, c: m + 0.25, v: 100 + (i * 37) % 250 }; };

test('VWAP and its bands: hand-worked, equal to an expanded plain average, and to CHE\'s engine', () => {
  const card = vwapBands({ anchor: 'all', bars: [{ h: 101, l: 99, c: 100, v: 100 }, { h: 104, l: 100, c: 102, v: 200 }, { h: 103, l: 98, c: 99, v: 100 }] });
  assert.deepEqual(card.value, { vwap: 101, sd: 1, upper1: 102, lower1: 100, upper2: 103, lower2: 99, upper3: 104, lower3: 98 });
  // Independent: repeat each bar's typical price once per unit of volume; the plain mean and the
  // population standard deviation of that list are the VWAP and σ.
  for (let k = 0; k < 20; k += 1) {
    const bars = Array.from({ length: randInt(2, 12) }, () => { const l = randInt(90, 110); return { h: l + randInt(0, 6), l, c: l + randInt(0, 6), v: randInt(0, 40) }; })
      .map((b) => ({ ...b, c: Math.min(b.c, b.h) }));
    if (!bars.some((b) => b.v > 0)) bars[0].v = 5;
    const list = bars.flatMap((b) => Array(b.v).fill((b.h + b.l + b.c) / 3));
    const mean = list.reduce((s, x) => s + x, 0) / list.length;
    const sd = Math.sqrt(list.reduce((s, x) => s + (x - mean) ** 2, 0) / list.length);
    const out = vwapBands({ bars, anchor: 'all' });
    assert.ok(close(out.value.vwap, mean, 1e-9) && close(out.value.sd, sd, 1e-9), `case ${k}`);
    assert.ok(close(out.value.upper2 - out.value.vwap, 2 * sd, 1e-9) && close(out.value.vwap - out.value.lower3, 3 * sd, 1e-9));
  }
  // CHE's engine sums VWAP and σ from the CME day's start (intradayContext); over the same bars it agrees.
  const day = fiveMinute('2026-10-15T22:00:00Z', 60, wave);
  const ctx = intradayContext(day);
  const mine = vwapBands({ bars: day, anchor: day[0].t });
  assert.ok(close(mine.value.vwap, ctx.vwap.at(-1), 1e-9));
  assert.ok(close(mine.value.sd, ctx.vwapSd.at(-1), 1e-6));
  assert.match(vwapBands({ bars: [{ h: 1, l: 1, c: 1, v: 0 }] }).error, /no volume/);
  assert.match(vwapBands({ bars: [] }).error, /no bars/);
});

test('session VWAP anchors at 9:30 New York on both sides of a daylight-saving change', () => {
  // Friday 2026-03-06 is standard time (9:30 = 14:30 UTC); Monday 2026-03-09 is daylight time (13:30 UTC).
  for (const [day, openUtc] of [['2026-03-06', '14:30'], ['2026-03-09', '13:30'], ['2026-10-30', '13:30'], ['2026-11-02', '14:30']]) {
    const bars = fiveMinute(`${day}T12:30:00Z`, 36, wave); // 12:30 to 15:25 UTC
    const s = latestRthSession(bars);
    assert.equal(s.open, `${day}T${openUtc}:00.000Z`, day);
    assert.equal(s.bars[0].t, `${day}T${openUtc}:00.000Z`, `${day}: no pre-open bar is counted`);
    assert.ok(s.coversOpen, day);
    const inSession = bars.filter((b) => b.t >= s.open);
    assert.equal(s.bars.length, inSession.length);
    const out = vwapBands({ bars, anchor: 'rth' });
    assert.ok(close(out.value.vwap, vwapBands({ bars: inSession, anchor: 'all' }).value.vwap), day);
  }
  // With both days stored, the latest session is used.
  const two = [...fiveMinute('2026-03-06T14:30:00Z', 6, wave), ...fiveMinute('2026-03-09T13:30:00Z', 6, wave)];
  assert.equal(latestRthSession(two).day, '2026-03-09');
  // Bars that start after the open are refused: a session VWAP from them would be wrong.
  const late = fiveMinute('2026-03-09T14:15:00Z', 6, wave);
  assert.match(vwapBands({ bars: late, anchor: 'rth' }).error, /after the 9:30 New York open/);
  assert.match(vwapBands({ bars: fiveMinute('2026-03-09T03:00:00Z', 6, wave), anchor: 'rth' }).error, /none of the bars falls inside regular hours/);
});

test('opening range: hand-worked, daylight saving, and the same as CHE\'s engine\'s 9:30 to 9:45 range', () => {
  const card = openingRange({ minutes: 15, bars: [
    { t: '2026-10-16T13:30:00Z', h: 101, l: 99, c: 100.5, v: 500 }, { t: '2026-10-16T13:35:00Z', h: 102, l: 100, c: 101.5, v: 400 },
    { t: '2026-10-16T13:40:00Z', h: 101.5, l: 98.5, c: 99, v: 450 }, { t: '2026-10-16T13:45:00Z', h: 104, l: 99, c: 103.5, v: 600 }] });
  assert.deepEqual(card.value, { high: 102, low: 98.5, range: 3.5 });
  assert.equal(card.values.complete, true);
  for (const [day, openUtc] of [['2026-03-06', '14:30'], ['2026-03-09', '13:30']]) {
    const bars = fiveMinute(`${day}T12:00:00Z`, 48, wave);
    const window = bars.filter((b) => b.t >= `${day}T${openUtc}` && Date.parse(b.t) < Date.parse(`${day}T${openUtc}:00Z`) + 15 * 60_000);
    assert.equal(window.length, 3);
    const out = openingRange({ bars, minutes: 15 });
    assert.deepEqual([out.value.high, out.value.low], [Math.max(...window.map((b) => b.h)), Math.min(...window.map((b) => b.l))], day);
    const ctx = intradayContext(bars);
    const after = bars.findIndex((b) => Date.parse(b.t) >= Date.parse(`${day}T${openUtc}:00Z`) + 15 * 60_000);
    assert.deepEqual([ctx.orHigh[after], ctx.orLow[after]], [out.value.high, out.value.low], `${day} matches intradayContext`);
  }
  const partial = openingRange({ minutes: 30, bars: fiveMinute('2026-03-09T13:30:00Z', 3, wave) });
  assert.equal(partial.values.complete, false, 'a window still open is said to be unfinished');
});

test('session levels: hand-worked, and the previous day high and low match CHE\'s engine', () => {
  const b = (t, h, l) => ({ t, o: l, h, l, c: h, v: 1 });
  const out = sessionLevels({ bars: [b('2026-10-15T14:00:00Z', 110, 100), b('2026-10-15T18:00:00Z', 112, 105), b('2026-10-16T00:30:00Z', 108, 104), b('2026-10-16T02:00:00Z', 109, 103), b('2026-10-16T07:00:00Z', 111, 106), b('2026-10-16T14:00:00Z', 115, 107), b('2026-10-16T19:00:00Z', 114, 108)] });
  assert.deepEqual(out.value, { pdh: 112, pdl: 100, asiaHigh: 109, asiaLow: 103, londonHigh: 111, londonLow: 106, nyHigh: 115, nyLow: 107 });
  const bars = fiveMinute('2026-10-14T22:00:00Z', 600, wave);
  const ctx = intradayContext(bars);
  const levels = sessionLevels({ bars });
  assert.deepEqual([levels.value.pdh, levels.value.pdl], [ctx.pdh.at(-1), ctx.pdl.at(-1)]);
});

// ─── Price action ─────────────────────────────────────────────────────────

test('candles, gaps, sweeps, order blocks and premium/discount: hand-worked values', () => {
  assert.deepEqual(candleAnatomy({ o: 100, h: 106, l: 98, c: 104, v: 3000, priorVolumes: [1000, 1500, 2000, 1500] }).value, { range: 8, body: 4, upperWick: 2, lowerWick: 2, bodyShare: 0.5, relativeVolume: 2 });
  assert.equal(candleAnatomy({ o: 100, h: 99, l: 98, c: 101 }).ok, false, 'a high below the body is refused');
  const ohlc = (o, h, l, c) => ({ o, h, l, c });
  const gaps = fairValueGaps({ bars: [ohlc(100, 101, 99, 100.8), ohlc(100.8, 105, 100.5, 104.5), ohlc(104.5, 106, 102, 105.5), ohlc(105.5, 107, 103.5, 106)] });
  assert.deepEqual(gaps.value, { count: 1, bottom: 101, top: 102 });
  assert.equal(gaps.values.gaps[0].touched, false);
  const bear = fairValueGaps({ bars: [ohlc(10, 11, 9, 9.2), ohlc(9.2, 9.3, 7, 7.2), ohlc(7.2, 8, 6.5, 7), ohlc(7, 9.5, 6.8, 9.4)] });
  assert.deepEqual([bear.values.gaps[0].side, bear.value.bottom, bear.value.top, bear.values.gaps[0].touched, bear.values.gaps[0].filled], ['bearish', 8, 9, true, true]);
  assert.deepEqual(liquiditySweeps({ level: 100, side: 'buy', bars: [ohlc(99, 99.5, 98, 99), ohlc(99, 100.75, 99, 99.5), ohlc(99.5, 99.8, 97.5, 98)] }).value, { sweeps: 1, firstBar: 2 });
  assert.deepEqual(liquiditySweeps({ level: 100, side: 'sell', bars: [ohlc(101, 102, 99.5, 100.5), ohlc(100.5, 101, 98, 99)] }).value, { sweeps: 1, firstBar: 1 }, 'a close below is a break, not a sweep');
  const ob = orderBlock({ minBody: 3, bars: [ohlc(100, 101, 99, 100.5), ohlc(100.5, 100.8, 98.5, 99), ohlc(99, 104, 98.8, 103.5)] });
  assert.ok(close(ob.value.high, 100.8) && close(ob.value.low, 98.5) && close(ob.value.mid, 99.65));
  assert.equal(orderBlock({ minBody: 10, bars: [ohlc(1, 2, 0, 1.5), ohlc(1.5, 3, 1, 2.5)] }).ok, false);
  assert.deepEqual(premiumDiscount({ low: 100, high: 200, price: 130 }).value, { equilibrium: 150, ote62: 138, ote705: 129.5, ote79: 121, position: 0.3 });
  const down = premiumDiscount({ low: 100, high: 200, direction: 'down' }).value;
  assert.ok(close(down.ote62, 162) && close(down.ote79, 179), 'a leg down retraces up from its low');
});

test('fair value gaps follow the same definition as CHE\'s fvg-retest strategy', () => {
  const ohlc = (o, h, l, c) => ({ o, h, l, c });
  const bars = [ohlc(95, 100, 94, 99), ohlc(99, 110, 98, 109), ohlc(109, 112, 104, 111), ohlc(111, 113, 106, 112), ohlc(104.5, 108, 103, 107)];
  const mine = fairValueGaps({ bars });
  assert.deepEqual([mine.value.bottom, mine.value.top, mine.values.gaps[0].touched, mine.values.gaps[0].filled], [100, 104, true, false]);
  const signal = INTRADAY_CANDIDATES['fvg-retest-5m'].entry(bars, 4);
  assert.equal(signal.side, 'long');
  assert.equal(signal.stop, mine.value.bottom - 0.25, 'the engine stops 1 tick under the same gap');
  assert.match(signal.why, /bullish gap 100–104/);
  // Brute force on random bars: every pair (j, j + 2) is checked directly.
  for (let k = 0; k < 50; k += 1) {
    const rows = Array.from({ length: 12 }, () => { const l = randInt(90, 110); return { h: l + randInt(0, 5), l }; });
    const expected = [];
    for (let j = 0; j + 2 < rows.length; j += 1) {
      if (rows[j].h < rows[j + 2].l) expected.push(['bullish', rows[j].h, rows[j + 2].l]);
      else if (rows[j].l > rows[j + 2].h) expected.push(['bearish', rows[j + 2].h, rows[j].l]);
    }
    assert.deepEqual(fairValueGaps({ bars: rows }).values.gaps.map((g) => [g.side, g.bottom, g.top]), expected);
  }
});

test('BOS and CHOCH: hand-worked labels, and no label ever changes when later bars arrive', () => {
  const ohlc = (o, h, l, c) => ({ o, h, l, c });
  const bars = [ohlc(100, 101, 99, 100), ohlc(100, 103, 100, 102.5), ohlc(102.5, 102, 100.5, 101), ohlc(101, 101.5, 99.5, 100), ohlc(100, 102.5, 100, 102), ohlc(102, 104, 101.5, 103.8), ohlc(103.8, 104.5, 102, 102.5), ohlc(102.5, 103, 98, 98.5), ohlc(98.5, 100, 97, 99.5), ohlc(99.5, 99.8, 97.5, 98), ohlc(98, 98.5, 95.5, 96)];
  const out = structureBreaks({ bars, n: 1 });
  assert.deepEqual(out.values.events.map((e) => [e.bar, e.type, e.direction, e.level]), [[6, 'BOS', 'up', 103], [8, 'CHOCH', 'down', 99.5], [11, 'BOS', 'down', 97]]);
  assert.deepEqual(out.value, { bos: 2, choch: 1 });
  // Causal: the events seen on the first k bars are exactly the full run's events up to bar k.
  let p = 100;
  const walk = Array.from({ length: 120 }, () => { const o = p; p += (rng() - 0.5) * 4; const c = p; return { o, h: Math.max(o, c) + rng(), l: Math.min(o, c) - rng(), c }; });
  const full = structureBreaks({ bars: walk, n: 2 }).values.events;
  for (let k = 10; k <= walk.length; k += 7) {
    assert.deepEqual(structureBreaks({ bars: walk.slice(0, k), n: 2 }).values.events, full.filter((e) => e.bar <= k), `prefix ${k}`);
  }
});

// ─── Statistics ───────────────────────────────────────────────────────────

test('Wilson interval: CHE\'s engine, the phase-1 formula, a configurable z, and its defining equation', () => {
  for (const [wins, n] of [[12, 20], [6, 10], [0, 30], [30, 30], [517, 1000], [1, 3]]) {
    const out = winRateInterval({ wins, n });
    const engine = wilsonInterval(wins, n);
    assert.ok(close(out.value.low, engine.low, 1e-15) && close(out.value.high, engine.high, 1e-15));
    const phase1 = FORMULAS.wilson({ wins, n });
    assert.ok(close(out.value.low, phase1.low) && close(out.value.high, phase1.high));
    // Independent: each bound p solves (p̂ − p)² = z² p(1 − p) / n.
    const ph = wins / n; const z = 1.96;
    for (const b of [out.value.low, out.value.high]) {
      if (b > 0 && b < 1) assert.ok(close((ph - b) ** 2, (z * z * b * (1 - b)) / n, 1e-12), `${wins}/${n} bound ${b}`);
    }
  }
  const narrow = winRateInterval({ wins: 12, n: 20, confidence: 0.9 });
  assert.equal(narrow.values.z, 1.6449);
  assert.ok(narrow.value.high - narrow.value.low < winRateInterval({ wins: 12, n: 20 }).value.high - winRateInterval({ wins: 12, n: 20 }).value.low);
  assert.equal(winRateInterval({ wins: 12, n: 20, z: 2.5758 }).values.z, 2.5758);
  assert.equal(winRateInterval({ wins: 5, n: 3 }).ok, false);
});

test('Student\'s t: published table values, and the distribution against numerical integration', () => {
  const table = [[1, 12.7062], [2, 4.3027], [5, 2.5706], [7, 2.3646], [10, 2.2281], [29, 2.0452], [30, 2.0423], [100, 1.9840]];
  for (const [df, t] of table) assert.ok(close(tQuantile(0.975, df), t, 1e-4), `t(0.975, ${df})`);
  assert.ok(close(tQuantile(0.95, 10), 1.8125, 1e-4));
  // Independent: Simpson's rule on the density from 0 to x, plus one half.
  const density = (x, v) => Math.exp(lgamma((v + 1) / 2) - lgamma(v / 2)) / Math.sqrt(v * Math.PI) * (1 + (x * x) / v) ** (-(v + 1) / 2);
  function lgamma(z) { let x = 0; while (z < 7) { x -= Math.log(z); z += 1; } return x + (z - 0.5) * Math.log(z) - z + 0.5 * Math.log(2 * Math.PI) + 1 / (12 * z) - 1 / (360 * z ** 3); }
  for (const v of [1, 3, 8, 25]) {
    for (const x of [0.5, 1.2, 2.5, 4]) {
      const steps = 4000; const h = x / steps;
      let sum = density(0, v) + density(x, v);
      for (let i = 1; i < steps; i += 1) sum += (i % 2 ? 4 : 2) * density(i * h, v);
      assert.ok(close(studentTCdf(x, v), 0.5 + (sum * h) / 3, 1e-7), `CDF(${x}, ${v})`);
      assert.ok(close(studentTCdf(-x, v), 1 - studentTCdf(x, v), 1e-12));
    }
  }
});

// Journal trades in the evidence engine's record shape, so summarize() can be compared.
const asTrades = (rs, dollarsPerR = 20) => rs.map((r, i) => ({ net_pnl: r * dollarsPerR, r_net: r, side: 'long', entry: { time: String(i) }, costs: { spread: 0, slippage: 0, commissions: 0, fees: 0 } }));

test('expectancy: both forms agree, the mean is the engine\'s, and the t-interval is hand-worked', () => {
  const card = expectancyStats({ rs: [2, -1, -1, 2, -1, 1.5, -1, 2] });
  // mean 3.5 / 8; s² = 16.71875 / 7; t(0.975, 7) = 2.364624.
  const s = Math.sqrt(16.71875 / 7); const half = (2.364624 * s) / Math.sqrt(8);
  assert.equal(card.value.expectancy, 0.4375);
  assert.ok(close(card.value.low, 0.4375 - half, 1e-5) && close(card.value.high, 0.4375 + half, 1e-5));
  assert.match(card.assumptions, /Student t-interval/, 'the method is stated');
  for (let k = 0; k < 100; k += 1) {
    const rs = Array.from({ length: randInt(2, 60) }, () => [randInt(-2, 4), 0, -1][randInt(0, 2)] + randInt(0, 3) / 4);
    const out = expectancyStats({ rs });
    assert.ok(close(out.values.formA, out.values.mean, 1e-12), 'W × average win − L × average loss = mean R');
    assert.ok(close(out.value.expectancy, summarize(asTrades(rs)).expectancy_r, 1e-4), 'the engine\'s expectancy');
  }
  // With many trades t approaches 1.96, so the range approaches the engine's normal range.
  const many = Array.from({ length: 400 }, (_, i) => (i % 5 === 0 ? 2.5 : i % 2 ? -1 : 0.5));
  const t = expectancyStats({ rs: many });
  const e = summarize(asTrades(many)).expectancy_r_95ci;
  assert.ok(close((t.value.high - t.value.low) / (e.high - e.low), t.values.t / 1.96, 1e-3));
  assert.ok(close(expectancyStats({ winRate: 0.4, avgWin: 2, avgLoss: 1 }).value.expectancy, 0.2, 1e-12));
  assert.equal(expectancyStats({ rs: [1] }).ok, false, 'one trade has no range');
});

test('profit factor and drawdown: the engine\'s values, and percent drawdown by brute force', () => {
  for (let k = 0; k < 60; k += 1) {
    const rs = Array.from({ length: randInt(1, 40) }, () => randInt(-3, 4));
    const trades = asTrades(rs);
    const pnl = trades.map((t) => t.net_pnl);
    const s = summarize(trades);
    const pf = profitFactor({ pnl }).value;
    assert.equal(pf == null ? null : Math.round(pf * 100) / 100, s.profit_factor, `profit factor ${rs}`);
    assert.equal(maxDrawdown({ pnl }).value.dollars, s.max_drawdown, `drawdown ${rs}`);
    assert.equal(maxDrawdown({ pnl }).value.dollars, FORMULAS.maxDrawdown({ pnl }));
    // Percent: the largest (equity at i − equity at j) ÷ equity at i over every i before j, from a start balance.
    const start = 1000; const eq = [start]; for (const x of pnl) eq.push(eq.at(-1) + x);
    let worst = 0;
    for (let i = 0; i < eq.length; i += 1) for (let j = i; j < eq.length; j += 1) if (eq[i] > 0) worst = Math.max(worst, (eq[i] - eq[j]) / eq[i]);
    assert.ok(close(maxDrawdown({ pnl, start }).value.percent, worst, 1e-12), `percent ${rs}`);
  }
  const card = maxDrawdown({ pnl: [200, -150, -250, 300, -100], start: 10000 });
  assert.equal(card.value.dollars, 400);
  assert.ok(close(card.value.percent, 400 / 10200));
  assert.equal(profitFactor({ pnl: [5, 10] }).value, null, 'no losing trade: not defined');
});

test('sample size for a win-rate margin is the smallest n that reaches it', () => {
  assert.equal(sampleSizeForMargin({ margin: 0.05 }).value, 385);
  assert.equal(sampleSizeForMargin({ margin: 0.1 }).value, 97);
  assert.equal(sampleSizeForMargin({ margin: 0.05, confidence: 0.99 }).value, 664);
  for (const [margin, p] of [[0.03, 0.5], [0.05, 0.4], [0.02, 0.3], [0.1, 0.6], [0.07, 0.55]]) {
    const n = sampleSizeForMargin({ margin, p }).value;
    const half = (k) => 1.96 * Math.sqrt((p * (1 - p)) / k);
    assert.ok(half(n) <= margin + 1e-12 && half(n - 1) > margin, `n = ${n} for ±${margin} at p = ${p}`);
  }
});

// ─── Seeded simulation ────────────────────────────────────────────────────

test('Monte Carlo is the same for the same seed, and a reshuffle matches the exact permutations', () => {
  const results = [2, -1, -1, 2, -1];
  const a = monteCarlo({ results, paths: 500, seed: 42 });
  const b = monteCarlo({ results, paths: 500, seed: 42 });
  assert.deepEqual(a, b, 'the same seed gives the same result');
  assert.notDeepEqual(monteCarlo({ results, paths: 500, seed: 43 }).values.bands, a.values.bands, 'another seed differs');
  assert.deepEqual([mulberry32(1)(), mulberry32(1)()], [mulberry32(1)(), mulberry32(1)()]);
  // Every order of the five trades, computed exactly.
  const perms = (list) => (list.length <= 1 ? [list] : list.flatMap((x, i) => perms([...list.slice(0, i), ...list.slice(i + 1)]).map((p) => [x, ...p])));
  const dd = (order) => { let eq = 0; let peak = 0; let w = 0; for (const x of order) { eq += x; peak = Math.max(peak, eq); w = Math.max(w, peak - eq); } return w; };
  const exact = perms(results).map(dd).sort((x, y) => x - y);
  const shuffled = monteCarlo({ results, paths: 20000, seed: 7, replace: false });
  assert.deepEqual([shuffled.value.finalP5, shuffled.value.finalP50, shuffled.value.finalP95], [1, 1, 1], 'a reshuffle never changes the total');
  assert.ok(exact.includes(shuffled.value.ddP50) && exact.includes(shuffled.value.ddP95) && shuffled.values.ddMax === exact.at(-1), 'every drawdown is one a real order has');
  assert.equal(shuffled.value.ddP50, percentile(exact, 0.5), 'the simulated median drawdown is the exact one');
  // A bootstrap's median final result tends to n × the mean.
  const boot = monteCarlo({ results, paths: 20000, seed: 9, trades: 100 });
  assert.ok(Math.abs(boot.value.finalP50 - 100 * 0.2) <= 3, `median ${boot.value.finalP50}`);
  assert.equal(boot.values.bands.p50.length, 100, 'a percentile path for every step');
  assert.equal(monteCarlo({ results: [1], paths: 100 }).ok, false);
});

test('risk of ruin: the seeded simulation agrees with the gambler\'s-ruin formula', () => {
  const out = riskOfRuin({ winRate: 0.55, riskPerTrade: 100, account: 1000, trades: 3000, paths: 6000, seed: 11 });
  const classic = (0.45 / 0.55) ** 10;
  assert.ok(close(out.value.classic, classic, 1e-12));
  assert.ok(Math.abs(out.value.probability - classic) <= 3 * out.values.standardError + 0.005, `${out.value.probability} vs ${classic}`);
  assert.deepEqual(riskOfRuin({ winRate: 0.55, riskPerTrade: 100, account: 1000, trades: 200, paths: 500, seed: 3 }), riskOfRuin({ winRate: 0.55, riskPerTrade: 100, account: 1000, trades: 200, paths: 500, seed: 3 }));
  assert.equal(riskOfRuin({ winRate: 0.45, riskPerTrade: 100, account: 500, trades: 100, paths: 100 }).value.classic, 1, 'no edge: ruin is certain over an endless run');
  assert.equal(riskOfRuin({ winRate: 0.5, avgWinR: 2, riskPerTrade: 1, account: 10, trades: 10, paths: 10 }).value.classic, undefined, 'the formula is only for equal wins and losses');
  assert.equal(riskOfRuin({ winRate: 0.6, riskPerTrade: 100, account: 100, ruinAt: 200 }).ok, false);
});

test('verdicts follow the written criteria exactly', () => {
  assert.equal(VERDICT_RULES.minTrades, 30);
  const v = (x) => strategyVerdict(x).verdict;
  assert.equal(v({ trades: 0 }), 'unsupported');
  assert.equal(v({ trades: 29, low: 0.5, high: 1, mean: 0.7, profitFactor: 3 }), 'unsupported', 'too few trades, however good they look');
  assert.equal(v({ trades: 30, low: 0.01, high: 0.5, mean: 0.25, profitFactor: 1.3 }), 'good');
  assert.equal(v({ trades: 30, low: 0.01, high: 0.5, mean: 0.25, profitFactor: 1.2 }), 'unsupported', 'a profit factor of exactly 1.2 is not above it');
  assert.equal(v({ trades: 50, low: -0.1, high: 0.4, mean: 0.15, profitFactor: 1.5 }), 'unsupported', 'a range that includes zero');
  assert.equal(v({ trades: 50, low: -0.6, high: -0.05, mean: -0.3, profitFactor: 0.7 }), 'bad');
  assert.equal(v({ trades: 80, low: -0.3, high: 0.1, mean: -0.1, profitFactor: 0.9 }), 'bad', 'a loss on an adequate sample');
});
