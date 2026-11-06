// Owner, 2026-11-06: "test the wider volatility". params.stop_atr widens a setup's stop to at least m x ATR(14),
// never nearer than its own stop; portfolios without it are unchanged.
import assert from 'node:assert/strict';
import test from 'node:test';
import { intradayContext, newPortfolio, stepPortfolio, widenStop } from './trading_evidence.js';

test('the stop moves out to m ATR on the correct side, on a tick, and never inward', () => {
  assert.deepEqual(widenStop({ side: 'long', ref: 100, stop: 99, why: 'x' }, 2, 1.3).stop, 97.25);
  assert.equal(widenStop({ side: 'short', ref: 100, stop: 101, why: 'x' }, 2, 1.3).stop, 102.75);
  const wide = { side: 'long', ref: 100, stop: 90, why: 'x' };
  assert.equal(widenStop(wide, 2, 1.3), wide, 'a structural stop already wider is kept');
  const sig = { side: 'long', ref: 100, stop: 99, why: 'x' };
  assert.equal(widenStop(sig, undefined, 1.3), sig);
  assert.equal(widenStop(sig, 2, null), sig);
  assert.equal(widenStop(null, 2, 1), null);
});

test('stop_atr is part of the strategy version and widens the trades a portfolio takes', () => {
  // A repeating inside-bar breakout: a 24-point mother bar, an 8-point inside bar, a close above it, then a drift.
  const bars = [];
  let p = 20000;
  const shape = [[0, 12, -12, 4], [4, 8, 0, 3], [3, 14, 2, 13], [13, 20, 8, 10], [10, 30, 6, 25], [25, 26, -5, -2], [-2, 4, -18, -10], [-10, 2, -14, 0]];
  for (let i = 0; i < 480; i++) {
    const [o, h, l, c] = shape[i % shape.length];
    const t = new Date(Date.UTC(2026, 9, 6, 13, 30) + (i % 60) * 300000 + Math.floor(i / 60) * 86400000).toISOString();
    bars.push({ t, o: p + o, h: p + h, l: p + l, c: p + c, v: 100 });
    if (i % shape.length === shape.length - 1) p += 1;
  }
  const ctx = intradayContext(bars);
  const plain = newPortfolio('inside-bar-5m', 'any', { source: 'backtest', resolution: '5m' });
  const wide = newPortfolio('inside-bar-5m', 'any', { source: 'backtest', resolution: '5m', params: { stop_atr: 3 } });
  assert.notEqual(plain.strategy_version, wide.strategy_version);
  const a = stepPortfolio(plain, bars, ctx); const b = stepPortfolio(wide, bars, ctx);
  assert.ok(a.length && b.length, 'both portfolios trade');
  const risk = (ts) => ts.reduce((s, t) => s + t.risk_dollars, 0) / ts.length;
  assert.ok(risk(b) > risk(a), `wider stops risk more per trade (${risk(b)} > ${risk(a)})`);
});
