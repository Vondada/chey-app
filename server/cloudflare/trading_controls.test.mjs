// Strategy Control Center (owner, 2026-10-20): the owner's limits are enforced where entries
// happen. The default is 30 entries a day per strategy; raising risk needs a confirmation with its
// impact; every change is audited and can be restored; pause, stopped entries and Emergency Stop
// block new entries in the real liveTick; a quota is a ceiling and never forces a trade.
import assert from 'node:assert/strict';
import test from 'node:test';
import { INTRADAY_CANDIDATES, readTrades } from './trading_evidence.js';
import { LIVE_EXCLUDED, LIVE_PORTFOLIOS, haltLivePaper, liveTick, readLivePortfolios, setLivePaper } from './trading_live.js';
import { applyControlChange, controlsView, readControls, scopeIds, stockOrderProblem } from './trading_controls.js';

function memoryStorage(saved = new Map()) {
  return {
    saved,
    get: async (key) => {
      if (Array.isArray(key)) return new Map(key.filter((k) => saved.has(k)).map((k) => [k, structuredClone(saved.get(k))]));
      return saved.has(key) ? structuredClone(saved.get(key)) : undefined;
    },
    put: async (key, value) => {
      if (typeof key === 'object') { for (const [k, v] of Object.entries(key)) saved.set(k, structuredClone(v)); return; }
      saved.set(key, structuredClone(value));
    },
    delete: async (key) => saved.delete(key),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

// Five 1-minute bars that add up to one 5-minute bar {o, h, l, c}.
function minutesOf(t0, { o, h, l, c }) {
  const at = (k) => new Date(Date.parse(t0) + k * 60_000).toISOString();
  return [
    { t: at(0), o, h: o, l, c: l, v: 10 },
    { t: at(1), o: l, h, l, c: h, v: 10 },
    { t: at(2), o: h, h, l: c, c, v: 10 },
    { t: at(3), o: c, h: c, l: c, c, v: 10 },
    { t: at(4), o: c, h: c, l: c, c, v: 10 },
  ];
}
const five = (start, k) => new Date(Date.parse(start) + k * 300_000).toISOString();
// CME day 1 (opens 18:00 New York = 22:00 UTC): quiet bars with a low of 19990.
const DAY1 = Array.from({ length: 12 }, (_, k) => ({ t: five('2026-10-19T22:00:00Z', k), o: 20000, h: 20004, l: k === 5 ? 19990 : 19996, c: 20000 }));
// CME day 2: the first bar sweeps the previous day low and closes back above it; the next rallies.
const DAY2 = [
  { t: five('2026-10-20T22:00:00Z', 0), o: 20000, h: 20002, l: 19980, c: 19995 },
  { t: five('2026-10-20T22:00:00Z', 1), o: 19996, h: 20030, l: 19992, c: 20028 },
  { t: five('2026-10-20T22:00:00Z', 2), o: 20028, h: 20031, l: 20020, c: 20025 },
];
const oneMinute = (bars) => bars.flatMap((b) => minutesOf(b.t, b));
// Verified real-time delivery (PR #383): only such a feed may open forward-paper entries, so the
// controls are exercised on it; a delayed feed is blocked before the controls are asked.
const feedOf = (bars) => async () => ({ status: 'LIVE', authenticated: true, subscription_verified: true, provider: 'test feed', provider_symbol: 'MNQ=F', contract: 'MNQZ6', candles: oneMinute(bars), latency_s: 0, last_bar_time: bars.at(-1).t, checked_at: new Date().toISOString() });
const after = (bars) => Date.parse(bars.at(-1).t) + 6 * 60_000;

const paperTrades = (storage) => readTrades(storage, (t) => t.data?.resolution === '5m');
const sweepTrade = async (storage) => (await paperTrades(storage)).find((t) => t.strategy === 'pdhl-sweep-5m' && t.filter === 'any');
async function run(storage, bars = [...DAY1, ...DAY2]) {
  await setLivePaper(storage, true, Date.parse('2026-10-19T21:59:00Z'));
  await liveTick(storage, { force: true, load: feedOf(DAY1), now: after(DAY1) });
  return liveTick(storage, { force: true, load: feedOf(bars), now: after(bars) });
}

test('every strategy starts at 30 entries a day; lowering applies at once, raising returns its impact first', async () => {
  const storage = memoryStorage();
  const c = await readControls(storage);
  assert.deepEqual(Object.keys(c.strategies), Object.keys(INTRADAY_CANDIDATES));
  assert.ok(Object.values(c.strategies).every((s) => s.max_per_day === 30 && s.qty === 1 && !s.paused));
  const same = await applyControlChange(storage, { kind: 'set', scope: 'all', field: 'max_per_day', value: 30 });
  assert.equal(same.ok, false);
  assert.match(same.error, /already have maximum trades per day 30/);
  const down = await applyControlChange(storage, { kind: 'set', scope: 'ema-pullback-5m', field: 'max_per_day', value: 10 }, { who: 'owner (iPhone)' });
  assert.equal(down.ok, true);
  assert.equal(down.controls.strategies['ema-pullback-5m'].max_per_day, 10);
  assert.equal(down.record.who, 'owner (iPhone)');
  assert.match(down.record.summary, /trend pullback to the 20 EMA: maximum trades per day 30 → 10/);
  const up = await applyControlChange(storage, { kind: 'set', scope: 'ema-pullback-5m', field: 'max_per_day', value: 40 });
  assert.equal(up.ok, false);
  assert.equal(up.needs_confirmation, true);
  assert.match(up.impact.join(' '), /up to 30 more paper entries a day \(10 → 40\)/);
  assert.equal((await readControls(storage)).strategies['ema-pullback-5m'].max_per_day, 10, 'nothing is saved before the confirmation');
  const size = await applyControlChange(storage, { kind: 'set', scope: 'ema-pullback-5m', field: 'qty', value: 2 });
  assert.match(size.impact.join(' '), /2 times larger/);
  const yes = await applyControlChange(storage, { kind: 'set', scope: 'ema-pullback-5m', field: 'max_per_day', value: 40 }, { confirm: true });
  assert.equal(yes.ok, true);
  assert.equal(yes.record.raised_risk, true);
  const back = await applyControlChange(storage, { kind: 'restore' });
  assert.equal(back.ok, true, 'restoring a lower limit lowers risk, so it needs no confirmation');
  assert.equal(back.controls.strategies['ema-pullback-5m'].max_per_day, 10);
  const audit = (await readControls(storage)).audit;
  assert.deepEqual(audit.map((r) => r.action), ['set', 'set', 'restore'], 'one audit record per applied change, none for refused or unconfirmed ones');
  assert.ok(audit.every((r) => r.at && r.who && r.summary));
  const bad = await applyControlChange(storage, { kind: 'set', scope: 'all', field: 'max_per_day', value: 999 });
  assert.match(bad.error, /from 0 to 200/);
});

test('the ICT group is the strategies whose rules are ICT concepts', () => {
  assert.deepEqual(scopeIds('family:ICT').sort(), ['fvg-retest-5m', 'order-block-5m', 'pdhl-sweep-5m', 'silver-bullet-5m', 'sweep-mss-5m', 'sweep-reclaim-5m']);
  assert.ok(!scopeIds('family:ICT').includes('ema-pullback-5m'));
  assert.deepEqual(scopeIds('nope'), []);
});

test('a valid signal trades once with the default limit: the quota is a ceiling, never a target', async () => {
  const storage = memoryStorage();
  await run(storage);
  const trades = (await paperTrades(storage)).filter((t) => t.strategy === 'pdhl-sweep-5m' && t.filter === 'any');
  assert.equal(trades.length, 1, 'one valid signal, one trade, even though 29 more were allowed');
  const view = controlsView(await readControls(storage), await readLivePortfolios(storage), after(DAY2));
  const row = view.find((r) => r.id === 'pdhl-sweep-5m');
  assert.equal(row.max_per_day, 30);
  assert.ok(row.entries_today >= 1);
  assert.equal(row.state, 'running');
});

test('pausing a strategy blocks its entries in the real tick and records why; others still trade', async () => {
  const storage = memoryStorage();
  await applyControlChange(storage, { kind: 'pause', scope: 'pdhl-sweep-5m' });
  await run(storage);
  assert.equal(await sweepTrade(storage), undefined, 'the paused strategy did not enter');
  const pf = (await readLivePortfolios(storage)).find((p) => p.candidate === 'pdhl-sweep-5m' && p.filter === 'any');
  assert.match(pf.skips.map((s) => s.reason).join(' | '), /blocked: this strategy is paused/);
  assert.equal(pf.counts.skipped, 1);
  const view = controlsView(await readControls(storage), await readLivePortfolios(storage));
  assert.equal(view.find((r) => r.id === 'pdhl-sweep-5m').state, 'paused');
  assert.match(view.find((r) => r.id === 'pdhl-sweep-5m').recent_skips[0].reason, /paused/);
  const resume = await applyControlChange(storage, { kind: 'resume', scope: 'pdhl-sweep-5m' });
  assert.equal(resume.needs_confirmation, true, 'resuming lets it trade again, so it is confirmed first');
});

test('a daily maximum of 0 blocks the entry; pausing the ICT group pauses every ICT strategy', async () => {
  const storage = memoryStorage();
  await applyControlChange(storage, { kind: 'set', scope: 'pdhl-sweep-5m', field: 'max_per_day', value: 0 });
  await run(storage);
  assert.equal(await sweepTrade(storage), undefined);
  const pf = (await readLivePortfolios(storage)).find((p) => p.candidate === 'pdhl-sweep-5m' && p.filter === 'any');
  assert.match(pf.skips.at(-1).reason, /daily maximum of 0 entries was reached/);
  const ict = await applyControlChange(storage, { kind: 'pause', scope: 'family:ICT' });
  assert.equal(ict.ok, true);
  assert.equal(ict.record.effect.length, 6);
  assert.ok(scopeIds('family:ICT').every((id) => ict.controls.strategies[id].paused));
  assert.equal(ict.controls.strategies['ema-pullback-5m'].paused, false);
});

test('Emergency Stop cancels the unfilled order, blocks new entries everywhere, keeps records and lists what stays open', async () => {
  const storage = memoryStorage();
  // The sweep bar has formed: its order waits for the next bar's open.
  await run(storage, [...DAY1, DAY2[0]]);
  const pending = (await readLivePortfolios(storage)).filter((p) => p.pending);
  assert.ok(pending.some((p) => p.candidate === 'pdhl-sweep-5m'), 'an order is waiting to fill');
  const stop = await applyControlChange(storage, { kind: 'emergency_stop' }, { who: 'owner (voice)' });
  assert.equal(stop.ok, true, 'Emergency Stop acts at once, with no confirmation');
  const halted = await haltLivePaper(storage);
  assert.equal(halted.cancelled, pending.length);
  assert.deepEqual(halted.open, []);
  const kept = storage.saved.get(LIVE_EXCLUDED);
  assert.ok(kept.some((r) => r.kind === 'cancelled' && r.strategy === 'pdhl-sweep-5m' && /Emergency Stop/.test(r.reason)), 'the cancelled order is kept with its reason');
  await liveTick(storage, { force: true, load: feedOf([...DAY1, ...DAY2]), now: after(DAY2) });
  assert.equal(await sweepTrade(storage), undefined, 'nothing filled after the Emergency Stop');
  assert.equal((await paperTrades(storage)).length, 0, 'no strategy entered');
  const view = controlsView(await readControls(storage), await readLivePortfolios(storage));
  assert.ok(view.every((r) => r.state === 'emergency stop'), 'every strategy shows the Emergency Stop');
  const clear = await applyControlChange(storage, { kind: 'allow_entries' });
  assert.equal(clear.needs_confirmation, true);
  assert.ok(storage.saved.get(LIVE_PORTFOLIOS));
});

test('a paper stock order is checked against the controls before Alpaca: stop, size, repeat, buying power', async () => {
  const storage = memoryStorage();
  const c = await readControls(storage);
  const now = Date.parse('2026-10-20T15:00:00Z');
  assert.equal(stockOrderProblem(c, { symbol: 'AAPL', side: 'buy', qty: 5 }, { now }), '');
  assert.match(stockOrderProblem(c, { symbol: 'AAPL', side: 'buy', qty: 500 }, { now }), /above your maximum order size of 100/);
  const journal = [{ symbol: 'AAPL', side: 'buy', qty: 5, recorded_at: new Date(now - 20_000).toISOString() }];
  assert.match(stockOrderProblem(c, { symbol: 'AAPL', side: 'buy', qty: 5 }, { journal, now }), /less than a minute ago/);
  assert.equal(stockOrderProblem(c, { symbol: 'AAPL', side: 'buy', qty: 5 }, { journal, now: now + 120_000 }), '');
  assert.match(stockOrderProblem(c, { symbol: 'AAPL', side: 'buy', qty: 10, limit_price: 200 }, { buyingPower: 1500, now }), /buying power/);
  const stopped = (await applyControlChange(storage, { kind: 'stop_entries' })).controls;
  assert.match(stockOrderProblem(stopped, { symbol: 'AAPL', side: 'buy', qty: 1 }, { now }), /New entries are stopped/);
});

test('both entry gates apply: delayed paper entries follow the controls, and a waiting order is cancelled when the feed becomes unusable', async () => {
  const delayed = (bars) => async () => ({ ...await feedOf(bars)(), status: 'DELAYED', latency_s: 600 });
  const storage = memoryStorage();
  const controls = await readControls(storage);
  assert.ok(Object.values(controls.strategies).every((s) => !s.paused && s.max_per_day === 30), 'the controls allow every strategy');
  await setLivePaper(storage, true, Date.parse('2026-10-19T21:59:00Z'));
  await liveTick(storage, { force: true, load: delayed(DAY1), now: after(DAY1) });
  const allowed = await liveTick(storage, { force: true, load: delayed([...DAY1, ...DAY2]), now: after(DAY2) });
  assert.equal(allowed.entries_allowed, true, 'delayed paper entries are allowed (owner, 2026-10-21)');
  assert.equal(allowed.entry_quality, 'delayed');
  assert.ok((await paperTrades(storage)).length >= 1, 'the delayed setup is a paper trade');
  // A real-time order waiting to fill is cancelled, with its reason, when the feed becomes unusable (here: stale).
  const waiting = memoryStorage();
  await run(waiting, [...DAY1, DAY2[0]]);
  assert.ok((await readLivePortfolios(waiting)).some((p) => p.candidate === 'pdhl-sweep-5m' && p.pending), 'an order is waiting to fill');
  await liveTick(waiting, { force: true, load: async () => ({ ...await feedOf([...DAY1, ...DAY2])(), status: 'STALE' }), now: after(DAY2) });
  assert.equal(await sweepTrade(waiting), undefined, 'the waiting order never filled on stale data');
  const pf = (await readLivePortfolios(waiting)).find((p) => p.candidate === 'pdhl-sweep-5m' && p.filter === 'any');
  assert.equal(pf.pending, null);
  assert.equal(pf.counts.blocked_entries, 1);
  assert.match(pf.skips.map((x) => x.reason).join(' | '), /no verified real-time market data/);
});
