import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EVIDENCE_PORTFOLIOS, EVIDENCE_RUNS, evidenceIntent, evidenceReport, evidenceTick, readPortfolios,
} from './trading_evidence_runner.js';
import { readTrades } from './trading_evidence.js';

const day = (i) => new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10);
const bars = (rows) => rows.map(([o, h, l, c], i) => ({ t: day(i), o, h, l, c }));

// The setup from trading_evidence.test.mjs: a pdh-break signal on bar 2, entry at bar 3's open.
const SETUP = [
  [100, 101, 99, 100],
  [100, 100.5, 99.5, 100.2],
  [100.2, 102, 100, 101.5],
  [101.6, 102, 101, 101.8],
];
const WIN_BAR = [101.8, 105.5, 101.7, 105.2];

function memStore() {
  const m = new Map();
  return {
    m,
    async get(keys) {
      if (!Array.isArray(keys)) return m.get(keys);
      const out = new Map();
      for (const k of keys) if (m.has(k)) out.set(k, structuredClone(m.get(k)));
      return out;
    },
    async put(a, b) {
      if (typeof a === 'string') { m.set(a, structuredClone(b)); return; }
      for (const [k, v] of Object.entries(a)) m.set(k, structuredClone(v));
    },
    async list({ prefix }) {
      const out = new Map();
      for (const k of [...m.keys()].filter((x) => x.startsWith(prefix)).sort()) out.set(k, structuredClone(m.get(k)));
      return out;
    },
  };
}

// A load function that returns fixed candles, so tests never touch the network or the cache.
const feed = (candles) => async () => ({ symbol: 'nq.f', candles, live: false, data: 'test feed' });
const feedError = () => async () => ({ error: 'The free data source did not answer.' });

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
const r2 = (x) => Math.round(x * 100) / 100;
function walk(n, seed) {
  const r = rng(seed);
  let p = 100;
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = r2(p);
    const c = r2(Math.max(50, p + (r() - 0.48) * 6));
    out.push({ t: day(i), o, h: r2(Math.max(o, c) + r() * 2 + 0.01), l: r2(Math.min(o, c) - r() * 2 - 0.01), c });
    p = c;
  }
  return out;
}

const HOUR = 60 * 60_000;
const T0 = Date.UTC(2026, 9, 15, 15, 0, 0);

test('a tick records its run, journals the closed trade, and a repeat in the hour is skipped', async () => {
  const store = memStore();
  const candles = bars([...SETUP, WIN_BAR]);
  const run = await evidenceTick(store, { now: T0, load: feed(candles) });
  assert.equal(run.ok, true);
  assert.equal(run.closed, 1);
  assert.equal(run.journal.written, 1);
  assert.equal(run.bars, 5);
  assert.equal(run.last_bar, day(4));
  assert.equal((await readTrades(store)).length, 1);
  const again = await evidenceTick(store, { now: T0 + 10 * 60_000, load: feed(candles) });
  assert.match(again.skipped, /within the hour/);
  assert.equal((await readTrades(store)).length, 1);
});

test('a forced repeat on the same bars adds nothing: trades are never recorded twice', async () => {
  const store = memStore();
  const candles = bars([...SETUP, WIN_BAR]);
  await evidenceTick(store, { now: T0, load: feed(candles) });
  const forced = await evidenceTick(store, { now: T0 + HOUR, force: true, load: feed(candles) });
  assert.equal(forced.closed, 0);
  assert.equal(forced.journal.written, 0);
  assert.equal((await readTrades(store)).length, 1);
});

test('portfolio state carries across ticks: a signal on one tick fills on the next', async () => {
  const store = memStore();
  const full = bars([...SETUP, WIN_BAR]);
  const first = await evidenceTick(store, { now: T0, load: feed(full.slice(0, 3)) });
  assert.equal(first.closed, 0);
  const portfolios = await readPortfolios(store);
  const pdh = portfolios.find((pf) => pf.candidate === 'pdh-break' && pf.filter === 'any');
  assert.ok(pdh.pending, 'the signal from bar 2 waits for the next bar');
  await evidenceTick(store, { now: T0 + HOUR, load: feed(full) });
  const trades = await readTrades(store);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].entry.raw, 101.6, 'filled at the next open after the tick boundary');
});

test('a failed data pull is logged as a failed run and records nothing', async () => {
  const store = memStore();
  const run = await evidenceTick(store, { now: T0, load: feedError() });
  assert.equal(run.ok, false);
  assert.match(run.error, /did not answer/);
  const runs = await store.get(EVIDENCE_RUNS);
  assert.equal(runs.length, 1, 'the failure is in the run log');
  assert.equal((await readTrades(store)).length, 0);
});

test('bad candles are refused as a data problem, not traded on', async () => {
  const store = memStore();
  const bad = bars([...SETUP, WIN_BAR]);
  bad[2] = { ...bad[2], h: 90 };
  const run = await evidenceTick(store, { now: T0, load: feed(bad) });
  assert.equal(run.ok, false);
  assert.match(run.error, /data refused/);
  assert.equal((await readTrades(store)).length, 0);
});

test('the run log keeps only the latest runs', async () => {
  const store = memStore();
  for (let i = 0; i < 55; i++) await evidenceTick(store, { now: T0 + i * HOUR, force: true, load: feedError() });
  assert.equal((await store.get(EVIDENCE_RUNS)).length, 50);
});

test('an empty record answers plainly and claims nothing', async () => {
  const text = await evidenceReport(memStore(), { now: T0 });
  assert.match(text, /No trading evidence has been recorded yet/);
});

test('every trade the engine produces over a long walk passes validation, so none is refused', async () => {
  const store = memStore();
  const candles = walk(1500, 11);
  let written = 0;
  for (let end = 300; end <= candles.length; end += 300) {
    const run = await evidenceTick(store, { now: T0 + (end / 300) * HOUR, force: true, load: feed(candles.slice(0, end)) });
    assert.equal(run.ok, true, run.error);
    assert.equal(run.rejected, 0, JSON.stringify(run.rejections));
    written += run.journal.written;
  }
  assert.ok(written > 0);
  assert.equal((await readTrades(store)).length, written);
});

test('the report answers from records: today, total, win rate with range, best strategy, and what is not shown', async () => {
  const store = memStore();
  await evidenceTick(store, { now: T0, load: feed(bars([...SETUP, WIN_BAR])) });
  const text = await evidenceReport(store, { now: T0 });
  assert.match(text, /Taken today \(2026-10-15\): 0/, 'the trade is dated by its entry bar, not today');
  assert.match(text, /Recorded in total: 1 \(1 wins, 0 losses, 0 flat\)/);
  assert.match(text, /Sample is insufficient/);
  assert.match(text, /No strategy has 30 trades yet/);
  assert.match(text, /4\. More consistently profitable\? Not shown yet\./);
  assert.match(text, /approximate/i);
  assert.match(text, /Not connected yet: intraday NQ data/);
});

test('with enough recorded trades the report names a best strategy and its measured range', async () => {
  const store = memStore();
  const candles = walk(1500, 11);
  for (let end = 300; end <= candles.length; end += 300) await evidenceTick(store, { now: T0 + (end / 300) * HOUR, force: true, load: feed(candles.slice(0, end)) });
  const trades = await readTrades(store);
  const text = await evidenceReport(store, { now: T0 + 10 * HOUR });
  assert.match(text, new RegExp(`Recorded in total: ${trades.length} `));
  if (trades.length >= 30) assert.match(text, /Best strategy so far: .*trades, .* R per trade \(95% range/);
  else assert.match(text, /No strategy has 30 trades yet/);
  assert.match(text, /Not shown yet/, 'daily evidence can never show consistent profitability');
});

test('evidence questions are recognised; general trading talk still goes to the old routes', () => {
  for (const q of [
    'CHE, how many paper trades did you take today?',
    "what's your actual measured win rate",
    'which NQ strategy performed best',
    'are you becoming more consistently profitable',
  ]) assert.deepEqual(evidenceIntent(q), { kind: 'evidence' }, q);
  for (const q of ["how's trading going", 'backtest bitcoin', 'hello CHE', 'how many emails do I have']) {
    assert.equal(evidenceIntent(q), null, q);
  }
});

test('portfolios are isolated per candidate and filter, and every one is present on a fresh store', async () => {
  const portfolios = await readPortfolios(memStore());
  assert.equal(portfolios.length, 10);
  assert.equal(new Set(portfolios.map((pf) => pf.key)).size, 10);
  assert.ok(portfolios.every((pf) => pf.source === 'paper' && pf.resolution === 'daily' && pf.contract === 'MNQ'));
  assert.equal(EVIDENCE_PORTFOLIOS, 'evidence_portfolios');
});
