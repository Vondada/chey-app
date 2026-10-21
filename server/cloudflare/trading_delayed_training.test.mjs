import test from 'node:test';
import assert from 'node:assert/strict';
import { newPortfolio } from './trading_evidence.js';
import { defaultControls } from './trading_controls.js';
import {
  DELAYED_PORTFOLIOS, DELAYED_INDEX, DELAYED_AUDIT, DELAYED_RECORD_PREFIX,
  rankDelayedTraining, runDelayedTraining, readDelayedTraining, resetDelayedTraining,
} from './trading_delayed_training.js';

function store() {
  const data = new Map();
  return {
    data,
    get: async (key) => data.get(key),
    put: async (key, value) => { data.set(key, structuredClone(value)); },
  };
}
const portfolio = (filter) => newPortfolio('ema-pullback-5m', filter, {
  source: 'paper', resolution: '5m', params: { target_r: 2 },
});
const sample = (pf, n, positive = true) => Array.from({ length: n }, (_, i) => ({
  key: pf.key, version: pf.strategy_version, strategy: pf.candidate, filter: pf.filter,
  feed: 'DELAYED', time: new Date(Date.UTC(2026, 9, 1) + i * 300000).toISOString(),
  exit_time: new Date(Date.UTC(2026, 9, 1) + i * 300000).toISOString(),
  net_pnl: positive ? (i % 14 === 0 ? -3 : 15) : (i % 6 === 0 ? 8 : -15),
  r_net: positive ? (i % 14 === 0 ? -0.1 : 0.6) : (i % 6 === 0 ? 0.3 : -0.7),
  result: positive ? (i % 14 === 0 ? 'loss' : 'win') : (i % 6 === 0 ? 'win' : 'loss'),
}));
const bars = (count) => {
  const start = Date.UTC(2026, 9, 21, 0, 0);
  return Array.from({ length: count }, (_, i) => {
    const p = 28000 + i * 0.7;
    return { t: new Date(start + i * 300000).toISOString(), o: p, h: p + 4, l: p - 4, c: p + 1, v: 100 + i };
  });
};
const feed = { status: 'DELAYED', provider: 'Yahoo Finance chart (public)', provider_symbol: 'MNQ=F',
  contract: 'MNQZ6', authenticated: false, subscription_verified: false, latency_s: 600 };

test('focus remains balanced under 30 trades or with a losing expectancy', () => {
  const [a, b] = [portfolio('any'), portfolio('trend')];
  for (const list of [[], sample(a, 20, true), [...sample(a, 40, false), ...sample(b, 40, false)]]) {
    const r = rankDelayedTraining(list, [a, b]);
    assert.equal(r.leader, null);
    assert.equal(r.rows.find((x) => x.portfolio === a.key)?.focus_share, 0.5);
    assert.equal(r.execution_allowed, false);
  }
});
test('strong risk-adjusted paper research gets extra focus but losing candidates still receive exploration', () => {
  const [a, b] = [portfolio('any'), portfolio('trend')];
  const r = rankDelayedTraining([...sample(a, 40, true), ...sample(b, 40, false)], [a, b]);
  assert.equal(r.leader, a.key);
  assert.equal(r.rows.find((x) => x.portfolio === a.key).focus_share, 0.75);
  assert.equal(r.rows.find((x) => x.portfolio === b.key).focus_share, 0.25);
  assert.equal(r.rows.find((x) => x.portfolio === b.key).stage, 'unproven_or_losing');
});
test('delayed track starts from the newest bar and never backfills history as new research', async () => {
  const storage = store();
  const firstBars = bars(70);
  const at = Date.parse(firstBars.at(-1).t) + 15 * 60_000;
  const spec = [{ c: 'ema-pullback-5m', f: 'any', target_r: 2 }];
  const call = (series, now = at) => runDelayedTraining(storage, {
    feed, bars: series, now, specs: spec, controls: defaultControls(),
  });
  const first = await call(firstBars);
  assert.equal(first.ok, true);
  assert.equal(first.observed_new_closed_trades, 0);
  const initialized = await storage.get(DELAYED_PORTFOLIOS);
  const key = Object.keys(initialized)[0];
  assert.equal(initialized[key].last_bar_time, firstBars.at(-1).t);
  assert.equal(initialized[key].counts.bars, 0);
  await call(firstBars);
  assert.equal((await storage.get(DELAYED_PORTFOLIOS))[key].counts.bars, 0);
  const next = bars(71);
  const second = await call(next, at + 300000);
  assert.equal(second.ok, true);
  assert.equal((await storage.get(DELAYED_PORTFOLIOS))[key].counts.bars, 1);
  await call(next, at + 300000);
  assert.equal((await storage.get(DELAYED_PORTFOLIOS))[key].counts.bars, 1);
  assert.equal((await storage.get(DELAYED_INDEX))?.length || 0, 0);
  assert.equal([...storage.data.keys()].filter((k) => k.startsWith(DELAYED_RECORD_PREFIX)).length, 0);
  const view = await readDelayedTraining(storage, { enabled: true });
  assert.equal(view.active, true);
  assert.equal(view.verified_forward_trades, 0);
  assert.match(view.note, /never actual timely fills/);
  await resetDelayedTraining(storage, { now: at + 400000 });
  await call(bars(72), at + 600000);
  assert.equal((await storage.get(DELAYED_PORTFOLIOS))[key].counts.bars, 1, 'restart does not replay earlier bars');
});
test('LIVE, unavailable and implausibly stale feeds do not enter delayed training or write research', async () => {
  const storage = store();
  const series = bars(70), now = Date.parse(series.at(-1).t) + 15 * 60000;
  for (const status of ['LIVE', 'UNAVAILABLE', 'REPLAY']) {
    const out = await runDelayedTraining(storage, { feed: { ...feed, status }, bars: series, now,
      specs: [{ c: 'ema-pullback-5m', f: 'any', target_r: 2 }], controls: defaultControls() });
    assert.equal(out.skipped, 'not delayed research data');
  }
  const stale = await runDelayedTraining(storage, { feed, bars: series, now: now + 50 * 60000,
    specs: [{ c: 'ema-pullback-5m', f: 'any', target_r: 2 }], controls: defaultControls() });
  assert.equal(stale.skipped, 'delayed research feed too old or inconsistent');
  assert.equal(await storage.get(DELAYED_PORTFOLIOS), undefined);
  assert.equal(await storage.get(DELAYED_AUDIT), undefined);
});
