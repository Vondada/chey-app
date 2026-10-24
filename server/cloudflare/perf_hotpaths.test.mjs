// Hot-path latency (owner perf report, 2026-10-24): market snapshot and candles p95 ~7 s, mailbox badge p95 ~1.9 s.
// These tests pin the fixes in markets.js and web_mailbox.js, then replay the simulated trace in perf_hotpaths_sim.mjs
// and hold its p95 under the 800 ms GET budget. Simulated time: no real waiting, same numbers every run.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { simulate } from './perf_hotpaths_sim.mjs';

const fresh = (file) => import(`./${file}?t=${Math.random()}`);
const settle = () => new Promise((resolve) => setImmediate(resolve));
async function run(promise, stepMs = 10, limit = 2000) {
  let done = false;
  let value;
  promise.then((v) => { done = true; value = v; });
  for (let i = 0; !done && i < limit; i++) { await settle(); if (!done) mock.timers.tick(stepMs); }
  return value;
}
const csv = 'Date,Open,High,Low,Close\n2026-10-22,1,2,0.5,1.5\n2026-10-23,1.5,2.5,1,2';
function store() {
  const m = new Map();
  return { m, get: async (k) => m.get(k), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async (k) => m.delete(k) };
}

test('a stale good quote answers at once, labelled with when it was fetched, while one refresh runs', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  try {
    const markets = await fresh('markets.js');
    let calls = 0;
    const fetcher = async () => { calls += 1; return new Response(csv, { status: 200 }); };
    const first = await run(markets.candles('^spx', fetcher));
    assert.equal(first.candles.length, 2);
    assert.equal(first.stale, false);
    assert.equal(first.fetched_at, new Date(1_000_000).toISOString());
    mock.timers.tick(11 * 60_000);   // past the 10-minute freshness window
    const slow = () => new Promise(() => {});   // the source now hangs
    const bg = [];
    const t0 = Date.now();
    const again = await markets.candles('^spx', slow, { background: (p) => bg.push(p) });
    assert.equal(Date.now() - t0, 0, 'answered without waiting for the source');
    assert.equal(again.stale, true);
    assert.equal(again.fetched_at, new Date(1_000_000).toISOString(), 'the original fetch time, not now');
    assert.deepEqual(again.candles.map((c) => c.date), ['2026-10-22', '2026-10-23'], 'dates untouched');
    assert.equal(bg.length, 1, 'one background refresh');
    assert.equal(calls, 1);
  } finally { mock.timers.reset(); }
});

test('concurrent callers share one upstream request', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2_000_000 });
  try {
    const markets = await fresh('markets.js');
    let calls = 0;
    const fetcher = () => { calls += 1; return new Promise((resolve) => setTimeout(() => resolve(new Response(csv, { status: 200 })), 400)); };
    const all = await run(Promise.all(Array.from({ length: 5 }, () => markets.candles('aapl.us', fetcher))));
    assert.equal(calls, 1);
    assert.ok(all.every((r) => r.candles.length === 2));
  } finally { mock.timers.reset(); }
});

test('with nothing cached, a hung source costs at most COLD_WAIT_MS and says it is still loading', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 3_000_000 });
  try {
    const markets = await fresh('markets.js');
    const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const t0 = Date.now();
    const out = await run(markets.candles('msft.us', hang));
    assert.equal(Date.now() - t0, markets.COLD_WAIT_MS);
    assert.equal(out.loading, true);
    assert.deepEqual(out.candles, []);
    assert.match(out.error, /still loading/);
  } finally { mock.timers.reset(); }
});

test('a failed refresh never replaces the last good value, and a dead source is not retried on every poll', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 4_000_000 });
  try {
    const markets = await fresh('markets.js');
    await run(markets.candles('nvda.us', async () => new Response(csv, { status: 200 })));
    mock.timers.tick(11 * 60_000);
    let calls = 0;
    const down = async () => { calls += 1; return new Response('', { status: 503 }); };
    await run(markets.candles('nvda.us', down));
    await run(settle());
    const after = await run(markets.candles('nvda.us', down));
    assert.equal(after.candles.length, 2, 'still the last good candles');
    assert.equal(after.stale, true);
    assert.equal(calls, 1, 'the failure is remembered for a minute');
  } finally { mock.timers.reset(); }
});

test('the last good snapshot survives an isolate restart through the Durable Object store', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 5_000_000 });
  try {
    const s = store();
    const ok = async (url) => new Response(String(url).includes('stooq') ? csv : JSON.stringify({ bitcoin: { usd: 1 }, ethereum: { usd: 2 }, solana: { usd: 3 } }), { status: 200 });
    const before = await fresh('markets.js');
    const first = await run(before.snapshot({}, ok, { store: s }));
    assert.ok(first.quotes.some((q) => q.status === 'delayed'));
    const restarted = await fresh('markets.js');   // new isolate: empty memory cache
    const hang = () => new Promise(() => {});
    mock.timers.tick(2 * 60_000);
    const t0 = Date.now();
    const again = await restarted.snapshot({}, hang, { store: s, background: () => {} });
    assert.equal(Date.now() - t0, 0);
    assert.equal(again.stale, true);
    assert.deepEqual(again.quotes, first.quotes, 'the same prices and as-of dates');
  } finally { mock.timers.reset(); }
});

test('a snapshot built from stale candles stays stale and keeps the candles\' fetch time (Codex P2 on #518)', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 6_000_000 });
  try {
    const markets = await fresh('markets.js');
    const ok = async (url) => new Response(String(url).includes('stooq') ? csv : JSON.stringify({ bitcoin: { usd: 1 }, ethereum: { usd: 2 }, solana: { usd: 3 } }), { status: 200 });
    const first = await run(markets.snapshot({}, ok));
    assert.equal(first.stale, false);
    mock.timers.tick(11 * 60_000);   // candles and snapshot both expired
    const down = async () => new Response('', { status: 503 });
    const later = await run(markets.snapshot({}, down, { background: () => {} }));
    await run(settle());
    const again = await run(markets.snapshot({}, down));
    for (const snap of [later, again]) {
      assert.equal(snap.stale, true, 'never reported fresh while the index prices are old');
      assert.equal(snap.fetched_at, new Date(6_000_000).toISOString());
      assert.ok(snap.age_s >= 660);
      assert.ok(!('source_fetched_ms' in snap));
    }
    const spx = again.quotes.find((q) => q.symbol === '^spx');
    assert.equal(spx.stale, true);
    assert.equal(spx.as_of, '2026-10-23');
  } finally { mock.timers.reset(); }
});

test('the badge answers from the last GitHub read while a slow refresh runs in the background', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 9, 24, 12) });
  try {
    const mailbox = await fresh('web_mailbox.js');
    const s = store();
    const env = { CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'me/che' };
    let delay = 0;
    let reads = 0;
    const gh = (url) => new Promise((resolve) => setTimeout(() => {
      reads += 1;
      const u = new URL(url);
      const reply = (status, data) => new Response(JSON.stringify(data), { status });
      if (u.pathname.endsWith('/contents/mailbox')) resolve(reply(200, [{ name: 'claude.jsonl' }]));
      else resolve(reply(200, { content: btoa(JSON.stringify({ id: 'c1', at: '2026-10-24T10:00:00.000Z', from: 'claude', to: 'che', text: 'hi' }) + '\n'), sha: 's' }));
    }, delay));
    const first = await run(mailbox.unreadIncoming(s, env, gh));
    assert.equal(first.count, 1);
    mock.timers.tick(60_000);   // the 20 s cache is stale
    delay = 1800;               // GitHub is slow now
    const bg = [];
    const t0 = Date.now();
    const badge = await run(mailbox.unreadIncoming(s, env, gh, { background: (p) => bg.push(p) }));
    assert.equal(Date.now() - t0, 0, 'no wait for GitHub');
    assert.equal(badge.count, 1);
    assert.equal(bg.length, 1);
    const readsBefore = reads;
    await run(Promise.all(bg));
    assert.ok(reads > readsBefore, 'the background refresh really read GitHub');
    // A caller without `background` (the board itself) still waits for a fresh read, so nothing just sent is missing.
    mock.timers.tick(60_000);
    const t1 = Date.now();
    await run(mailbox.readWebMail(s, 50, env, gh));
    assert.ok(Date.now() - t1 >= 1800);
  } finally { mock.timers.reset(); }
});

test('simulated production trace: snapshot, candles and badge p95 within the 800 ms GET budget', async () => {
  const loader = (file) => (g) => import(`./${file}?sim=${g}-${Math.random()}`);
  const r = await simulate({ loadMarkets: loader('markets.js'), loadMailbox: loader('web_mailbox.js') });
  for (const [route, s] of Object.entries(r)) assert.ok(s.p95 <= 800, `${route} p95 ${s.p95} ms (n=${s.n})`);
  // Cold starts (nothing cached at all) are bounded too.
  assert.ok(r.snapshot.max <= 2600 && r.candles.max <= 2600, JSON.stringify(r));
});
