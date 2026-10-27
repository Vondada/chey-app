// Repeatable simulation of the slow hot paths in the owner's perf report (2026-10-24): market snapshot, market
// candles and the mailbox badge. It replays one request trace against a given markets.js / web_mailbox.js in
// simulated time (node:test mock timers), with a seeded upstream that is usually quick and sometimes hangs until
// the request times out, the way Stooq and GitHub behaved in production. Same seed, same trace, same numbers.
//
//   node perf_hotpaths_sim.mjs            current code vs origin/main (prints p50/p95 and sample sizes)
//   import { simulate } from './perf_hotpaths_sim.mjs'   (perf_hotpaths.test.mjs)
import { mock } from 'node:test';

export function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** A fetcher whose answer time comes from `latency()` (ms, or Infinity for a hang); it honours AbortSignal. */
function slowFetcher(latency, respond) {
  return (url, init = {}) => new Promise((resolve, reject) => {
    const ms = latency(String(url));
    const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (init.signal?.aborted) return abort();
    init.signal?.addEventListener?.('abort', abort);
    if (Number.isFinite(ms)) setTimeout(() => resolve(respond(String(url), init)), ms);
  });
}

const STOOQ_CSV = 'Date,Open,High,Low,Close,Volume\n' + Array.from({ length: 60 }, (_, i) => `2026-08-${String((i % 28) + 1).padStart(2, '0')},${5000 + i},${5010 + i},${4990 + i},${5005 + i},1`).join('\n');
const GECKO = JSON.stringify({ bitcoin: { usd: 65000, usd_24h_change: 1 }, ethereum: { usd: 3000, usd_24h_change: 2 }, solana: { usd: 150, usd_24h_change: 3 } });

function marketUpstream(rand) {
  // Stooq: 75% answer in 250-900 ms, 25% hang until the caller gives up (seen as ~7 s in production).
  // CoinGecko: 85% answer in 150-500 ms, 15% hang.
  return slowFetcher((url) => {
    const r = rand();
    if (url.includes('stooq')) return r < 0.25 ? Infinity : 250 + rand() * 650;
    return r < 0.15 ? Infinity : 150 + rand() * 350;
  }, (url) => new Response(url.includes('stooq') ? STOOQ_CSV : GECKO, { status: 200 }));
}

function githubUpstream(rand) {
  // GitHub contents API: 300-1800 ms per call (directory + one file per peer).
  const files = new Map([['claude.jsonl', JSON.stringify({ id: 'c1', at: '2026-10-24T10:00:00.000Z', from: 'claude', to: 'che', text: 'hello' }) + '\n'],
    ['chatgpt.jsonl', JSON.stringify({ id: 'g1', at: '2026-10-24T11:00:00.000Z', from: 'chatgpt', to: 'che', text: 'status' }) + '\n']]);
  return slowFetcher(() => 300 + rand() * 1500, (url) => {
    const u = new URL(url);
    const reply = (status, data) => new Response(JSON.stringify(data), { status });
    if (u.pathname.endsWith('/contents/mailbox')) return reply(200, [...files.keys()].map((name) => ({ name })));
    const m = /\/contents\/mailbox\/([a-z0-9-]+\.jsonl)$/.exec(u.pathname);
    if (m) return files.has(m[1]) ? reply(200, { content: btoa(files.get(m[1])), sha: 's' }) : reply(404, {});
    return reply(404, {});
  });
}

function memoryStore() {
  const map = new Map();
  return { get: async (k) => map.get(k), put: async (k, v) => { map.set(k, structuredClone(v)); }, delete: async (k) => map.delete(k) };
}

export function pct(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Runs `fn` and advances simulated time in 10 ms steps until it settles; returns its simulated duration. */
async function timed(fn) {
  const t0 = Date.now();
  let done = false;
  let error = null;
  fn().then(() => { done = true; }, (e) => { done = true; error = e; });
  for (let i = 0; !done && i < 10_000; i++) { await settle(); if (!done) mock.timers.tick(10); }
  if (error) throw error;
  return Date.now() - t0;
}

async function advanceTo(t) {
  while (Date.now() < t) { await settle(); mock.timers.tick(Math.min(250, t - Date.now())); }
  await settle();
}

/**
 * The trace: 40 simulated minutes. The ticker polls the snapshot every 30 s (80 requests), the chart asks for one of
 * five symbols' candles every 60 s (40 requests), the badge polls every 5 s (480 requests), and the mailbox sends a
 * message every 5 minutes. CHE's Durable Object is evicted (in-memory caches lost) every 12 minutes.
 * `markets` and `mailbox` are module loaders, so each eviction starts from a fresh module instance.
 */
export async function simulate({ loadMarkets, loadMailbox, seed = 7, useNewOptions = true } = {}) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 9, 24, 12) });
  try {
    const rand = rng(seed);
    const marketFetch = marketUpstream(rand);
    const ghFetch = githubUpstream(rand);
    const store = memoryStore();
    const env = { CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'me/che' };
    const pending = [];
    const opts = useNewOptions ? { store, background: (p) => pending.push(p) } : undefined;
    let markets = await loadMarkets(0);
    let mailbox = await loadMailbox(0);
    const start = Date.now();
    const events = [];
    const symbols = ['^spx', 'aapl.us', 'msft.us', 'nvda.us', 'tsla.us'];
    for (let t = 0; t < 40 * 60_000; t += 5_000) {
      events.push({ t, kind: 'badge' });
      if (t % 30_000 === 0) events.push({ t, kind: 'snapshot' });
      if (t % 60_000 === 0) events.push({ t, kind: 'candles', symbol: symbols[(t / 60_000) % symbols.length] });
      if (t % 300_000 === 150_000) events.push({ t, kind: 'send' });
      if (t > 0 && t % 720_000 === 0) events.push({ t, kind: 'evict' });
    }
    const out = { snapshot: [], candles: [], badge: [] };
    let generation = 0;
    for (const ev of events) {
      await advanceTo(start + ev.t);
      if (ev.kind === 'evict') { generation += 1; markets = await loadMarkets(generation); mailbox = await loadMailbox(generation); continue; }
      if (ev.kind === 'snapshot') out.snapshot.push(await timed(() => markets.snapshot({}, marketFetch, opts)));
      if (ev.kind === 'candles') out.candles.push(await timed(() => markets.candles(ev.symbol, marketFetch, opts)));
      if (ev.kind === 'badge') out.badge.push(await timed(() => mailbox.unreadIncoming(store, env, ghFetch, useNewOptions ? { background: (p) => pending.push(p) } : undefined)));
      if (ev.kind === 'send') await timed(() => mailbox.postWebMail(store, { from: 'gemini', text: 'ping' }, env, async (url, init) => (init?.method === 'PUT' ? new Response('{}', { status: 200 }) : ghFetch(url, init))));
    }
    const summary = {};
    for (const [k, v] of Object.entries(out)) summary[k] = { n: v.length, p50: pct(v, 0.5), p95: pct(v, 0.95), max: Math.max(...v) };
    return summary;
  } finally {
    mock.timers.reset();
  }
}

// CLI: before (origin/main) vs after (this checkout).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { execFileSync } = await import('node:child_process');
  const { writeFileSync, rmSync, mkdtempSync } = await import('node:fs');
  const path = await import('node:path');
  const here = path.dirname(new URL(import.meta.url).pathname);
  const ref = process.argv[2] || 'origin/main';
  const dir = mkdtempSync(path.join(here, '.perf_before_'));
  try {
    for (const f of ['markets.js', 'web_mailbox.js']) writeFileSync(path.join(dir, f), execFileSync('git', ['show', `${ref}:server/cloudflare/${f}`], { cwd: here }));
    // The old web_mailbox imports its siblings from '.'; point them at this checkout's unchanged modules.
    const old = execFileSync('git', ['show', `${ref}:server/cloudflare/web_mailbox.js`], { cwd: here, encoding: 'utf8' }).replace(/from '\.\/([a-z_]+\.js)'/g, (m, f) => `from '../${f}'`);
    writeFileSync(path.join(dir, 'web_mailbox.js'), old);
    const loader = (file) => (g) => import(`${file}?gen=${g}-${Math.random()}`);
    const before = await simulate({ loadMarkets: loader(path.join(dir, 'markets.js')), loadMailbox: loader(path.join(dir, 'web_mailbox.js')), useNewOptions: false });
    const after = await simulate({ loadMarkets: loader(path.join(here, 'markets.js')), loadMailbox: loader(path.join(here, 'web_mailbox.js')), useNewOptions: true });
    console.log(`Simulated trace, seed 7 (simulated ms). before = ${ref}, after = this checkout`);
    for (const k of Object.keys(after)) {
      console.log(`${k.padEnd(9)} n=${String(after[k].n).padStart(3)}  before p50 ${String(before[k].p50).padStart(5)} p95 ${String(before[k].p95).padStart(5)} max ${String(before[k].max).padStart(5)}  |  after p50 ${String(after[k].p50).padStart(5)} p95 ${String(after[k].p95).padStart(5)} max ${String(after[k].max).padStart(5)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
