// Visual trading evidence (owner, 2026-10-23): daily evidence per strategy, timeframe and day; the
// daily P&L; replay with no look-ahead; historical vs today; responsible ranking and the leader; the
// journal; the audit; the history chart with provenance; and the owner's words through /api/chat.
// Every number is computed from stored records; nothing is invented and nothing is written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import {
  auditTrades, compareWindows, currentLeader, dailyEvidence, dailyPnl, filterTrades, fromEvidence, historyChart, journalView, metricsOf,
  rankStrategies, readVisualTrades, replayFrame, tradingVisualIntent as visualIntent,
} from './trading_visual.js';
import { recordKey } from './trading_evidence.js';
import { chartView } from './trading_chart.js';

const generated = new URL('./.trading_visual.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch (_) { DatabaseSync = null; }
const sqlite = { skip: DatabaseSync ? false : 'node:sqlite unavailable' };

globalThis.fetch = async (input) => { throw new TypeError(`fetch failed (offline test: ${new URL(String(input?.url || input)).host})`); };

function storageFor(saved = new Map()) {
  const db = new DatabaseSync(':memory:');
  return {
    sql: { exec: (q, ...p) => { const stmt = db.prepare(q); return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []); } },
    get: async (key) => (Array.isArray(key)
      ? new Map(key.filter((k) => saved.has(k)).map((k) => [k, structuredClone(saved.get(k))]))
      : (saved.has(key) ? structuredClone(saved.get(key)) : undefined)),
    put: async (key, value) => {
      if (key && typeof key === 'object') for (const [k, v] of Object.entries(key)) saved.set(k, structuredClone(v));
      else saved.set(key, structuredClone(value));
    },
    delete: async (key) => (Array.isArray(key) ? key.filter((k) => saved.delete(k)).length : saved.delete(key)),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => String(k).startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

async function owner({ model = () => 'Here is the answer, sir.', env: extraEnv = {} } = {}) {
  let calls = 0;
  const pending = [];
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', ...extraEnv,
    AI: { run: async (_model, opts = {}) => { calls += 1; return { response: model(opts) }; } },
  };
  const saved = new Map();
  const storage = storageFor(saved);
  const state = new CheState({ storage, waitUntil: (p) => pending.push(p) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const history = [];
  // RAGDBG=1 prints each turn (route and reply) while measuring before/after.
  const say = async (message, { as = token } = {}) => { const r = await say0(message, { as }); if (process.env.RAGDBG) console.error("DBG", JSON.stringify({ message, route: r.route, reply: r.reply.slice(0, 900) })); return r; };
  const say0 = async (message, { as = token } = {}) => {
    const before = calls;
    const res = await send('/api/chat', { message, history: history.slice(-8) }, as);
    const raw = await res.text();
    while (pending.length) await pending.shift();
    const events = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const done = events.find((e) => e.type === 'done') || {};
    const reply = events.filter((e) => e.type === 'delta').map((e) => e.delta).join('');
    history.push({ role: 'user', content: message }, { role: 'assistant', content: reply });
    return { status: res.status, raw, reply, done, route: done.source || (calls > before ? 'model' : 'none'), modelCalls: calls - before };
  };
  const seedMemory = async (records) => {
    await say('Hello CHE.');
    const data = saved.get('che');
    data.memory_records = [...(data.memory_records || []), ...records];
    saved.set('che', data);
  };
  const api = async (path, method = 'GET', payload) => (await worker.fetch(new Request(`https://che.example${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(payload ? { body: JSON.stringify(payload) } : {}) }), env)).json();
  const raw = (path, method, payload, as = token) => worker.fetch(new Request(`https://che.example${path}`, { method, headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${as}` } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}) }), env);
  // A guest: a private device enrolled into a family tenant by the owner, so it reaches routing but is not the owner.
  let guestToken = '';
  const guest = async (message) => {
    if (!guestToken) {
      const tenant = await (await send('/api/platform/tenants', { name: 'Guest', role: 'family' }, token)).json();
      const invite = await (await send('/api/platform/enrollments', { access: 'private', tenant_id: tenant.tenant.id }, token)).json();
      guestToken = (await (await send('/api/enroll', { enrollment_token: invite.enrollment.token, device_name: 'guest' })).json()).device_token;
    }
    const res = await send('/api/chat', { message, history: [] }, guestToken);
    const text = await res.text();
    while (pending.length) await pending.shift();
    const events = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const done = events.find((e) => e.type === 'done') || {};
    return { status: res.status, raw: text, reply: events.filter((e) => e.type === 'delta').map((e) => e.delta).join('') || (events[0]?.reply ?? ''), done, route: done.source || 'none' };
  };
  return { say, seedMemory, saved, api, raw, guest };
}




const memStorage = (m = new Map()) => ({
  saved: m,
  get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => m.has(x)).map((x) => [x, structuredClone(m.get(x))])) : structuredClone(m.get(k))),
  put: async (k, v) => { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) m.set(a, structuredClone(b)); else m.set(k, structuredClone(v)); },
  delete: async (k) => m.delete(k),
  list: async ({ prefix = '' } = {}) => new Map([...m].filter(([k]) => String(k).startsWith(prefix))),
});

// A record shaped like trading_evidence closeAt: long MNQ, 1 contract, costs stated on the record.
function rec({ strategy = 'ema-pullback-5m', env = 'paper', res = '5m', signal, entry, exit, raw = 21000, exitRaw = 21010, side = 'long', filter = 'any', target_r = 2, reason = 'target', session = 'mid-morning' }) {
  const pv = 2; const half = 0.125; const slip = 0.25;
  const dir = side === 'short' ? -1 : 1;
  const gross = Math.round(dir * (exitRaw - raw) * pv * 100) / 100;
  const costs = { spread: (half * 2) * pv, slippage: (slip + (reason === 'target' ? 0 : slip)) * pv, commissions: 3, fees: 1 };
  const net = Math.round((gross - costs.spread - costs.slippage - costs.commissions - costs.fees) * 100) / 100;
  return {
    source: env === 'paper' ? 'paper' : 'backtest', environment: env, portfolio: `${strategy}|${filter}@v1|${target_r}`, symbol: 'MNQ', contract: 'MNQ', qty: 1,
    strategy, filter, strategy_version: 'v1', params: { target_r }, side, session,
    signal: { time: signal, why: 'pullback to the 20 EMA', ref: raw }, condition: 'trend',
    entry: { time: entry, raw, fill: raw + dir * (half + slip), spread: half, slippage: slip, basis: 'next_bar_open' },
    stop: side === 'short' ? raw + 10 : raw - 10, target: side === 'short' ? raw - 20 : raw + 20, risk_points: 10,
    exit: { time: exit, raw: exitRaw, fill: exitRaw - dir * half, reason },
    gross_before_costs: gross, costs, net_pnl: net, r_net: Math.round((net / (10 * pv)) * 10000) / 10000, risk_dollars: 20,
    mfe_points: 10, mae_points: 2, data: { resolution: res, price_series: 'Yahoo MNQ=F (DELAYED)', label: `intraday ${res} bars, fills at the next open` },
    cost_assumptions: {}, result: net > 0 ? 'win' : net < 0 ? 'loss' : 'flat',
  };
}
const bar = (t, c = 21000) => ({ t, o: c, h: c + 5, l: c - 5, c, v: 1 });
const five = (start, n, c = 21000) => Array.from({ length: n }, (_, i) => bar(new Date(Date.parse(start) + i * 300_000).toISOString(), c + i));

test('daily evidence: one row per strategy, timeframe, execution type and day, with the full metrics and an honest 30-trade target', () => {
  const trades = [
    rec({ signal: '2026-10-21T14:00:00Z', entry: '2026-10-21T14:05:00Z', exit: '2026-10-21T14:30:00Z', exitRaw: 21020 }),
    rec({ signal: '2026-10-21T15:00:00Z', entry: '2026-10-21T15:05:00Z', exit: '2026-10-21T15:20:00Z', exitRaw: 20990, reason: 'stop' }),
    rec({ signal: '2026-10-22T14:00:00Z', entry: '2026-10-22T14:05:00Z', exit: '2026-10-22T14:40:00Z', exitRaw: 21020 }),
    rec({ env: 'backtest', signal: '2026-09-01T14:00:00Z', entry: '2026-09-01T14:05:00Z', exit: '2026-09-01T14:40:00Z', exitRaw: 21020 }),
  ].map((t) => fromEvidence(t, t.environment === 'backtest' ? 'historical_backtest' : 'forward_paper'));
  const skips = [{ strategy: 'ema-pullback-5m', timeframe: '5m', time: '2026-10-21T16:00:00Z', trade_day: '2026-10-21', reason: 'the stop was too close to the entry' }];
  const rows = dailyEvidence(trades, { skips, today: '2026-10-22' });
  assert.deepEqual(rows.map((r) => [r.trade_day, r.execution_type, r.trades, r.status]),
    [['2026-10-22', 'forward_paper', 1, 'partial'], ['2026-10-21', 'forward_paper', 2, 'complete'], ['2026-09-01', 'historical_backtest', 1, 'complete']]);
  const day = rows[1];
  assert.equal(day.wins, 1); assert.equal(day.losses, 1); assert.equal(day.win_rate, 50);
  for (const k of ['gross', 'commissions', 'slippage', 'net', 'max_drawdown', 'expectancy_r', 'expectancy_dollars', 'profit_factor']) assert.ok(day[k] !== undefined, k);
  assert.equal(day.unit, 'USD');
  assert.equal(day.net, Math.round((trades[0].net + trades[1].net) * 100) / 100, 'net is the sum of the two recorded trades');
  assert.equal(day.target.reached, false);
  assert.match(day.target.reason, /2 trades met the rules; 1 recorded setups were skipped \(1 × the stop was too close to the entry\)/);
  assert.match(rows[0].target.reason, /session is still open/);
  assert.ok(day.provisional, 'under 30 trades is provisional');
});

test('daily P&L: realized from closed trades, unrealized marked at the last stored bar, no invented balance', () => {
  const trades = [
    rec({ signal: '2026-10-22T13:00:00Z', entry: '2026-10-22T13:05:00Z', exit: '2026-10-22T13:30:00Z', exitRaw: 21020 }),
    rec({ signal: '2026-10-22T15:00:00Z', entry: '2026-10-22T15:05:00Z', exit: '2026-10-22T15:20:00Z', exitRaw: 20990, reason: 'stop' }),
    rec({ signal: '2026-10-21T15:00:00Z', entry: '2026-10-21T15:05:00Z', exit: '2026-10-21T15:20:00Z', exitRaw: 21020 }),
  ].map((t) => fromEvidence(t, 'forward_paper'));
  const positions = [{ contract: 'MNQ', qty: 1, side: 'long', entry_price: 21000.375, strategy: 'vwap-revert-5m' }];
  const p = dailyPnl({ trades, positions, lastBar: bar('2026-10-22T16:00:00Z', 21005), day: '2026-10-22' });
  assert.equal(p.trades_closed, 2);
  assert.equal(p.realized, Math.round((trades[0].net + trades[1].net) * 100) / 100);
  assert.equal(p.unrealized, Math.round((21005 - 21000.375) * 2 * 100) / 100);
  assert.equal(p.net, Math.round((p.realized + p.unrealized) * 100) / 100);
  assert.equal(p.balance, null);
  assert.match(p.balance_note, /keeps no account balance/);
  assert.equal(p.curve.length, 3, 'one point per closed trade plus the open mark');
  assert.equal(p.compare.previous_day, '2026-10-21');
  const none = dailyPnl({ trades, positions, lastBar: null, day: '2026-10-22' });
  assert.equal(none.unrealized, null, 'no bar to mark: unrealized is not known');
  assert.equal(none.net, null);
});

test('replay: nothing after the cursor is ever visible, and a trade appears only as far as it had happened', () => {
  const bars = five('2026-10-22T14:00:00Z', 12);
  const t = fromEvidence(rec({ signal: '2026-10-22T14:10:00Z', entry: '2026-10-22T14:15:00Z', exit: '2026-10-22T14:35:00Z' }), 'forward_paper');
  for (let i = 0; i <= 13; i++) {
    const cursor = new Date(Date.parse('2026-10-22T14:00:00Z') + i * 300_000).toISOString();
    const f = replayFrame({ bars, trades: [t], cursor, timeframe: '5m' });
    const at = Date.parse(cursor);
    assert.ok(f.knew.bars.every((b) => Date.parse(b.t) + 300_000 <= at), `no forming or future bar at ${cursor}`);
    assert.equal(f.knew.bars.length, Math.min(12, i), 'exactly the bars closed by the cursor');
    const text = JSON.stringify({ knew: f.knew, decided: f.decided, executed: f.executed, happened: f.happened });
    for (const b of bars.filter((x) => Date.parse(x.t) + 300_000 > at)) assert.ok(!text.includes(b.t) || [t.signal_time, t.entry_time, t.exit_time].includes(b.t) && Date.parse(b.t) <= at, `future bar ${b.t} leaked at ${cursor}`);
    if (at < Date.parse('2026-10-22T14:15:00Z')) assert.equal(f.decided.length, 0, 'the signal bar has not closed');
    if (at < Date.parse('2026-10-22T14:15:00Z')) assert.equal(f.executed.length, 0);
    if (at >= Date.parse('2026-10-22T14:15:00Z')) assert.equal(f.executed.length, 1);
    if (at < Date.parse('2026-10-22T14:40:00Z')) { assert.equal(f.happened.length, 0, 'the exit is not known before its bar closes'); assert.ok(!text.includes('"exit_price"')); }
    else assert.equal(f.happened.length, 1);
  }
  assert.equal(replayFrame({ bars, trades: [], cursor: 'nope' }).ok, false);
});

test('ranking never uses win rate alone; no verified leader without forward and historical evidence', () => {
  const many = (n, opts) => Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.parse('2026-09-01T14:00:00Z') + i * 86_400_000);
    const at = (m) => new Date(d.getTime() + m * 60_000).toISOString();
    return rec({ ...opts, signal: at(0), entry: at(5), exit: at(30), exitRaw: opts.exitAt(i) });
  });
  // High win rate, losing expectancy: 9 small wins and 1 big loss per 10.
  const hiWin = many(40, { strategy: 'vwap-revert-5m', exitAt: (i) => (i % 10 === 9 ? 20900 : 21004) }).map((t) => fromEvidence(t, 'forward_paper'));
  const steady = many(40, { strategy: 'ema-pullback-5m', exitAt: (i) => (i % 3 === 2 ? 20995 : 21020) }).map((t) => fromEvidence(t, 'forward_paper'));
  const ranked = rankStrategies([...hiWin, ...steady]);
  assert.ok(metricsOf(hiWin).win_rate > metricsOf(steady).win_rate, 'the setup: vwap has the higher win rate');
  assert.equal(ranked[0].strategy, 'ema-pullback-5m', 'ranked by the lower expectancy bound, not win rate');
  const noHistory = currentLeader([...hiWin, ...steady]);
  assert.equal(noHistory.leader, null);
  assert.equal(noHistory.headline, 'No verified leader yet.');
  assert.match(noHistory.provisional.missing.join(' '), /no historical backtest/);
  const hist = many(40, { env: 'backtest', strategy: 'ema-pullback-5m', exitAt: (i) => (i % 3 === 2 ? 20995 : 21020) }).map((t) => fromEvidence(t, 'historical_backtest'));
  const verified = currentLeader([...hiWin, ...steady, ...hist]);
  assert.equal(verified.leader.strategy, 'ema-pullback-5m');
  assert.equal(verified.paper_track.trades, 40);
  assert.equal(currentLeader([]).headline, 'No verified leader yet.');
});

test('historical vs today: years, YTD, last 30 days, latest session, today, weekdays and sessions, each labelled', () => {
  const trades = [
    rec({ env: 'backtest', signal: '2025-03-03T14:00:00Z', entry: '2025-03-03T14:05:00Z', exit: '2025-03-03T14:30:00Z' }),
    rec({ signal: '2026-10-21T14:00:00Z', entry: '2026-10-21T14:05:00Z', exit: '2026-10-21T14:30:00Z' }),
    rec({ signal: '2026-10-22T14:00:00Z', entry: '2026-10-22T14:05:00Z', exit: '2026-10-22T14:30:00Z' }),
  ].map((t) => fromEvidence(t, t.environment === 'backtest' ? 'historical_backtest' : 'forward_paper'));
  const w = compareWindows(trades, { now: Date.parse('2026-10-22T18:00:00Z') });
  const get = (id) => w.find((x) => x.id === id);
  assert.equal(get('year:2025').trades, 1);
  assert.equal(get('ytd').trades, 2);
  assert.equal(get('last_30_days').trades, 2);
  assert.equal(get('latest_session').trades, 1);
  assert.match(get('latest_session').label, /2026-10-21/);
  assert.equal(get('today').trades, 1);
  assert.equal(get('weekday:1').trades, 1, '2025-03-03 was a Monday');
  assert.deepEqual(get('year:2025').execution_types, ['historical_backtest']);
  assert.ok(get('ytd').data_quality.length > 0);
});

test('journal: filters, recorded skips, newest first; audit: real counts, nothing altered', () => {
  const a = rec({ signal: '2026-10-22T14:00:00Z', entry: '2026-10-22T14:05:00Z', exit: '2026-10-22T14:30:00Z' });
  const b = rec({ signal: '2026-10-22T14:00:00Z', entry: '2026-10-22T14:05:00Z', exit: '2026-10-22T14:30:00Z', filter: 'trend' });
  const ahead = rec({ signal: '2026-10-22T15:05:00Z', entry: '2026-10-22T15:05:00Z', exit: '2026-10-22T15:30:00Z', strategy: 'sweep-mss-5m' });
  const badFill = rec({ signal: '2026-10-22T16:00:00Z', entry: '2026-10-22T16:05:00Z', exit: '2026-10-22T16:30:00Z' });
  badFill.entry.fill += 3;
  const badPnl = rec({ signal: '2026-10-22T17:00:00Z', entry: '2026-10-22T17:05:00Z', exit: '2026-10-22T17:30:00Z' });
  badPnl.net_pnl += 5;
  const unlabelled = rec({ signal: '2026-10-22T18:00:00Z', entry: '2026-10-22T18:05:00Z', exit: '2026-10-22T18:30:00Z' });
  delete unlabelled.data.label;
  const trades = [a, a, b, ahead, badFill, badPnl, unlabelled].map((t) => fromEvidence(t, 'forward_paper'));
  const before = JSON.stringify(trades);
  const audit = auditTrades(trades);
  assert.equal(JSON.stringify(trades), before, 'the audit changes nothing');
  assert.equal(audit.totals.records, 7);
  assert.equal(audit.checks.exact_duplicates.count, 1);
  assert.equal(audit.checks.correlated_entries.count, 1, 'the same entry bar traded by two filter variants');
  assert.equal(audit.checks.look_ahead.count, 1);
  assert.equal(audit.checks.fill_mismatch.count, 1);
  assert.equal(audit.checks.pnl_mismatch.count, 1);
  assert.equal(audit.checks.missing_labels.count, 1);
  assert.equal(audit.altered, 0);
  const skips = [{ strategy: 'ema-pullback-5m', timeframe: '5m', time: '2026-10-22T19:00:00Z', trade_day: '2026-10-22', reason: 'blocked: daily loss limit' }];
  const j = journalView(trades, skips, { strategy: 'ema' });
  assert.equal(j.entries[0].kind, 'skipped', 'newest first, skips included');
  assert.ok(j.entries.every((e) => e.strategy.startsWith('ema')));
  assert.ok(!('_raw' in j.entries[1]), 'raw records stay on the Worker');
  assert.equal(journalView(trades, skips, { execution_type: 'historical_backtest' }).total, 0);
  assert.equal(filterTrades(trades, { strategy: 'sweep' }).length, 1);
});

test('history chart: stored research candles with provenance and gaps, trades as markers, honest empty states', async () => {
  const storage = memStorage();
  const bars = five('2026-10-20T14:00:00Z', 20);
  await storage.put('trd_ds:NQ:5m', { market: 'NQ', timeframe: '5m', provider: 'Yahoo Finance chart (public, free, delayed)', symbol: 'NQ=F', first: bars[0].t, last: bars.at(-1).t, bars: 20, missing: 0, sha256: 'abc123', fetched_at: '2026-10-20T16:00:00Z', confidence: 'public delayed data', chunks: 1 });
  await storage.put('trd_ds:NQ:5m:0', bars);
  const t = rec({ env: 'backtest', signal: '2026-10-20T14:10:00Z', entry: '2026-10-20T14:15:00Z', exit: '2026-10-20T14:40:00Z' });
  t.symbol = 'NQ'; t.contract = 'NQ';
  await storage.put(recordKey(t), t);
  const view = await chartView(storage, {}, { account: 'futures_history', symbol: 'NQ', tf: '5m' });
  assert.equal(view.state, 'verified');
  assert.deepEqual(view.timeframes, ['5m']);
  assert.equal(view.bars.length, 20);
  assert.equal(view.provenance.data_type, 'historical');
  assert.equal(view.provenance.gaps, 0);
  assert.equal(view.provenance.checksum, 'abc123');
  assert.deepEqual(view.markers.map((m) => [m.kind, m.source, m.execution_type]), [['entry', 'che_backtest', 'historical_backtest'], ['exit', 'che_backtest', 'historical_backtest']]);
  assert.equal(view.entries_allowed, false);
  const sec = await chartView(storage, {}, { account: 'futures_history', symbol: 'NQ', tf: '15s' });
  assert.equal(sec.state, 'no_data');
  assert.deepEqual(sec.bars, []);
  assert.match(sec.error, /No 15-second history/);
  const daily = await historyChart(storage, { market: 'NQ', tf: '1D' });
  assert.equal(daily.state, 'no_data');
  assert.match(daily.error, /No stored 1D NQ dataset yet/);
  const read = await readVisualTrades(storage);
  assert.deepEqual(read.sources.find((s) => s.execution_type === 'live'), { execution_type: 'live', label: 'Live', read: true, trades: 0, note: 'Live orders are disabled.' });
});

test('voice words', () => {
  assert.deepEqual(visualIntent("CHE, show today's P&L"), { kind: 'pnl' });
  assert.deepEqual(visualIntent('How much am I up today?'), { kind: 'pnl' });
  assert.deepEqual(visualIntent('Who is the current leader?'), { kind: 'leader' });
  assert.deepEqual(visualIntent('Audit the trades'), { kind: 'audit' });
  assert.deepEqual(visualIntent('Show daily evidence'), { kind: 'evidence' });
  for (const s of ['What is the leader of France?', 'Audit my expenses', 'Show me my Alpaca trades', 'Show strategy progress']) assert.equal(visualIntent(s), null, s);
});

test('the owner\'s words through /api/chat reach the records with no model call; a guest is refused', sqlite, async () => {
  const che = await owner();
  const pnl = await che.say("CHE, show today's P&L.");
  assert.equal(pnl.route, 'che_trading_visual', pnl.reply);
  assert.equal(pnl.modelCalls, 0);
  assert.match(pnl.reply, /realized \$0\.00 from 0 closed trades[\s\S]*live orders are disabled/);
  assert.equal(pnl.done.open_view, 'trading_visual');
  const leader = await che.say('Who is the current leader?');
  assert.equal(leader.route, 'che_trading_visual');
  assert.match(leader.reply, /^No verified leader yet\./);
  const audit = await che.say('Audit the trades.');
  assert.match(audit.reply, /I audited 0 stored trade records[\s\S]*Nothing was changed\./);
  const view = await che.api('/api/trading/visual?view=evidence');
  assert.equal(view.ok, true);
  assert.deepEqual(view.rows, []);
  assert.equal(view.live_orders, 'disabled');
  const g = await che.guest("Show today's P&L");
  assert.notEqual(g.route, 'che_trading_visual', 'a guest never reaches the records');
  assert.doesNotMatch(g.reply, /realized|unrealized/);
});
