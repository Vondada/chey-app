// Historical trading intelligence (owner, 2026-10-22): ingestion with checksums, zero look-ahead,
// walk-forward ranking, paper signals and answers from stored tests only. Offline: the provider is faked.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DATASETS, HI_SIGNALS, canonicalBars, configs, dedupeTrades, ingestDataset, intelligenceIntent, intelligenceReport,
  intelligenceView, leakageAudit, loadBars, readState, regimes, sha256Hex, speakIntelligence, startStudy, studyAlarm,
  studyDataset, studyStep, verifyDataset,
} from './historical_intelligence.js';
import { CANDIDATES, causalContext, newPortfolio, stepPortfolio } from './trading_evidence.js';

globalThis.fetch = async (input) => { throw new TypeError(`fetch failed (offline test: ${String(input)})`); };

function storage() {
  const saved = new Map();
  return {
    saved,
    get: async (key) => (Array.isArray(key) ? new Map(key.filter((k) => saved.has(k)).map((k) => [k, saved.get(k)])) : saved.get(key)),
    put: async (key, value) => {
      if (typeof key === 'object') for (const [k, v] of Object.entries(key)) saved.set(k, v);
      else saved.set(key, value);
    },
    delete: async (keys) => { for (const k of [].concat(keys)) saved.delete(k); },
    list: async ({ prefix = '' } = {}) => new Map([...saved.keys()].filter((k) => k.startsWith(prefix)).sort().map((k) => [k, saved.get(k)])),
  };
}

// A seeded random walk on weekdays: the same seed always gives the same bars.
function bars(n, { seed = 7, start = '2019-05-06', price = 7500 } = {}) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const out = [];
  let t = Date.parse(`${start}T04:00:00Z`);
  let c = price;
  while (out.length < n) {
    const day = new Date(t).getUTCDay();
    if (day !== 0 && day !== 6) {
      const o = c * (1 + (rnd() - 0.5) * 0.01);
      const move = (rnd() - 0.48) * 0.03;
      const close = o * (1 + move);
      const h = Math.max(o, close) * (1 + rnd() * 0.01);
      const l = Math.min(o, close) * (1 - rnd() * 0.01);
      out.push({ t: new Date(t).toISOString(), o: +o.toFixed(2), h: +h.toFixed(2), l: +l.toFixed(2), c: +close.toFixed(2), v: 1000 });
      c = close;
    }
    t += 86_400_000;
  }
  return out;
}

const yahooJson = (candles) => ({
  chart: { result: [{
    meta: { regularMarketTime: Math.floor(Date.parse(candles.at(-1).t) / 1000) + 2 * 86400 },
    timestamp: candles.map((b) => Date.parse(b.t) / 1000),
    indicators: { quote: [{ open: candles.map((b) => b.o), high: candles.map((b) => b.h), low: candles.map((b) => b.l), close: candles.map((b) => b.c), volume: candles.map((b) => b.v) }] },
  }] },
});

const NOW = Date.parse('2026-10-22T12:00:00Z');
const series = { 'MNQ=F': bars(1500, { seed: 3 }), 'NQ=F': bars(2500, { seed: 5, start: '2000-09-18', price: 3800 }), '^NDX': bars(3000, { seed: 9, start: '1985-10-01', price: 110 }) };
const fakeFetch = async (url) => {
  const sym = decodeURIComponent(String(url).split('/chart/')[1].split('?')[0]);
  return { ok: true, json: async () => yahooJson(series[sym]) };
};

test('a dataset records provider, contract, range, adjustment, resolution, time zone, gaps and a reproducible checksum', async () => {
  const candles = bars(300);
  candles[150] = { ...candles[150], o: candles[149].c * 1.08, h: Math.max(candles[150].h, candles[149].c * 1.08) };   // a roll-sized jump
  const gapped = [...candles.slice(0, 100), ...candles.slice(106)];                                                      // a missing week
  const m = await verifyDataset(DATASETS.NQ, gapped, { now: NOW });
  assert.equal(m.ok, true);
  for (const field of ['provider', 'provider_symbol', 'contract', 'from', 'to', 'adjustment', 'resolution', 'timezone', 'checksum_sha256']) assert.ok(m[field], field);
  assert.equal(m.checksum_sha256, await sha256Hex(canonicalBars(gapped)));
  assert.ok(m.gaps.count >= 1, 'the missing week is recorded');
  assert.ok(m.jumps.count >= 1, 'the opening jump is recorded, never removed');
  assert.match(m.start_note, /not covered by this dataset and nothing was filled in/, 'NQ from 1999: the uncovered span is said, not invented');
  const bad = [...candles.slice(0, 10), candles[5]];
  const refused = await verifyDataset(DATASETS.NQ, bad, { now: NOW });
  assert.equal(refused.ok, false, 'an out-of-order or repeated bar refuses the dataset');
});

test('the NDX index is labelled as a proxy, and MNQ and NQ are separate datasets', () => {
  assert.match(DATASETS.NDX.proxy, /not tradable/);
  assert.equal(DATASETS.MNQ.proxy, null);
  assert.equal(DATASETS.NQ.requested_from, '1999-06-21');
  assert.equal(DATASETS.NDX.requested_from, '1985-10-01');
});

test('ingestion stores the bars and reads them back with the same checksum', async () => {
  const st = storage();
  const m = await ingestDataset(st, 'MNQ', { fetcher: fakeFetch, now: NOW });
  assert.equal(m.ok, true, m.error);
  assert.equal(m.bars, 1500);
  const back = await loadBars(st, 'MNQ');
  assert.equal(await sha256Hex(canonicalBars(back)), m.checksum_sha256);
  const failed = await ingestDataset(st, 'NQ', { fetcher: async () => ({ ok: false, status: 403 }), now: NOW });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /HTTP 403/, 'a refused provider is reported with its reason, nothing invented');
});

test('every existing daily rule passes the look-ahead audit', () => {
  const candles = bars(800);
  for (const c of Object.keys(CANDIDATES)) {
    const run = (b) => stepPortfolio(newPortfolio(c, 'any', { source: 'backtest' }), b, causalContext(b));
    const audit = leakageAudit(candles, run);
    assert.equal(audit.ok, true, `${c}: ${audit.reason}`);
  }
});

test('the leakage audit catches a rule that peeks at the next bar', () => {
  const candles = bars(400);
  // Buys the day before a rise: it reads bar i + 1.
  const peeking = (b) => {
    const out = [];
    for (let i = 1; i + 1 < b.length; i++) {
      if (b[i + 1].c > b[i].c) out.push({ side: 'long', entry: { time: b[i].t, fill: b[i].c }, exit: { time: b[i + 1].t, fill: b[i + 1].c, reason: 'time' } });
    }
    return out;
  };
  const audit = leakageAudit(candles, peeking);
  assert.equal(audit.ok, false);
  assert.match(audit.reason, /reads the future/);
});

test('trades fill at the next bar open, ranking uses out-of-sample results only, and nothing is promoted', () => {
  const candles = bars(2500, { seed: 11 });
  const manifest = { provider: 'test', provider_symbol: 'NQ=F', from: candles[0].t, to: candles.at(-1).t, checksum_sha256: 'x'.repeat(64) };
  const r = studyDataset(DATASETS.NQ, manifest, candles, { recentYear: 2026 });
  assert.equal(r.configs, configs().length);
  assert.equal(r.rows.length, 30);
  for (const row of r.rows) {
    assert.equal(row.promotable, false, 'daily evidence never promotes');
    assert.ok(row.verdict_reasons.some((x) => /daily bars/.test(x)));
  }
  const ranked = r.ranking.map((k) => r.rows.find((x) => x.key === k));
  for (const row of ranked) assert.ok(row.oos.trades >= 30 && row.leakage_ok);
  for (let i = 1; i < ranked.length; i++) assert.ok(ranked[i - 1].oos.expectancy_r_95ci.low >= ranked[i].oos.expectancy_r_95ci.low);
  const byTime = new Map(candles.map((b, i) => [b.t, i]));
  for (const list of Object.values(r.trades)) {
    for (const t of list.slice(0, 20)) {
      const i = byTime.get(t.signal);
      assert.equal(candles[i + 1].t, t.entry, 'entry is the bar after the signal');
    }
  }
});

test('regimes use only the bar and earlier bars', () => {
  const candles = bars(600);
  const full = regimes(candles);
  const cut = regimes(candles.slice(0, 400));
  assert.deepEqual(full.slice(0, 400), cut);
});

test('paper trades are counted once, even when recorded twice', () => {
  const t = { environment: 'paper', strategy: 'fvg-retest', filter: 'any', side: 'long', entry: { time: '2026-03-02T14:30:00Z' } };
  const { trades, duplicates } = dedupeTrades([t, { ...t }, { ...t, side: 'short' }]);
  assert.equal(trades.length, 2);
  assert.equal(duplicates, 1);
});

test('a full study runs in resumable steps, journals paper signals once, and refreshes itself daily', async () => {
  const st = storage();
  assert.equal(await studyAlarm(st, { fetcher: fakeFetch, now: NOW }), null, 'nothing starts until the owner starts it');
  await startStudy(st, { now: NOW });
  let state = await studyStep(st, { fetcher: fakeFetch, now: NOW, budgetMs: 0 });
  assert.equal(state.status, 'running');
  assert.equal(state.done.length, 1, 'one step even with no time budget, then it resumes');
  state = await studyStep(st, { fetcher: fakeFetch, now: NOW });
  assert.equal(state.status, 'complete', JSON.stringify(state.errors));
  assert.deepEqual(state.errors, []);
  const view = await intelligenceView(st);
  assert.equal(view.results.length, 3);
  assert.ok(view.datasets.every((d) => d.ok && d.checksum_sha256));
  const report = await intelligenceReport(st);
  assert.match(report.method.ranking, /Out-of-sample only/);
  assert.match(report.safety, /No order is sent/);
  const signals = (await st.get(HI_SIGNALS)) || [];
  for (const s of signals) assert.match(s.status, /no order is placed/);
  // The same day again: nothing is re-run.
  assert.equal(await studyAlarm(st, { fetcher: fakeFetch, now: NOW + 3600_000 }), null);
  // A day later the study refreshes on the same bars: no signal is journalled twice.
  const again = await studyAlarm(st, { fetcher: fakeFetch, now: NOW + 25 * 3600_000 });
  assert.ok(['running', 'complete'].includes(again.status));
  while ((await readState(st)).status === 'running') await studyStep(st, { fetcher: fakeFetch, now: NOW + 25 * 3600_000 });
  const after = (await st.get(HI_SIGNALS)) || [];
  assert.equal(new Set(after.map((s) => s.id)).size, after.length);
  assert.equal(after.length, signals.length);
  const spoken = speakIntelligence(await intelligenceView(st));
  assert.match(spoken, /configurations tested/);
  assert.match(spoken, /nothing is traded with real money/);
  assert.doesNotMatch(spoken, /winning strategy/i);
});

test('the owner\'s questions are recognised narrowly; other trading phrases keep their routes', () => {
  assert.deepEqual(intelligenceIntent('How did your strategies do historically on NQ since 1999?'), { kind: 'summary' });
  assert.deepEqual(intelligenceIntent('Run the historical strategy study'), { kind: 'run' });
  assert.deepEqual(intelligenceIntent('Show the historical trading intelligence report'), { kind: 'report' });
  assert.deepEqual(intelligenceIntent('Which of your strategies works in each market regime?'), { kind: 'regimes' });
  assert.equal(intelligenceIntent('is walk forward testing better than a single out of sample split for my futures strategy'), null, 'a general question stays with the Knowledge Atlas');
  assert.deepEqual(intelligenceIntent('Test Dirty Trez on MNQ'), { kind: 'dirty' });
  assert.deepEqual(intelligenceIntent('Any historical paper signals today?'), { kind: 'signals' });
  assert.equal(intelligenceIntent('Backtest NQ'), null, 'the existing backtest command keeps its route');
  assert.equal(intelligenceIntent('Tell me the history of Rome'), null);
  assert.equal(intelligenceIntent('How many paper trades today?'), null);
});

test('before any study, CHE says so instead of inventing results; Dirty Trez is not guessed', async () => {
  const view = await intelligenceView(storage());
  assert.match(speakIntelligence(view), /No historical study has run yet/);
  assert.match(speakIntelligence(view, 'dirty'), /no written rules for Dirty Trez/);
});
