// The deep trading audit (trading_audit.js) and the simulation's stop and reset through the Worker (owner, 2026-10-24).
// Read only: every check recomputes from the stored fields, and the stored records are never changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { auditJournal, auditResearchUnits, auditSimTrades, auditSummaryLine, dayAudit, deepTradeAudit, recompute, speakDeepAudit } from './trading_audit.js';
import { CONTRACTS, COSTS, settleTrade } from './trading_evidence.js';
import { STATE_KEY } from './strategy_sim.js';

globalThis.fetch = async (input) => { throw new TypeError(`fetch failed (offline test: ${new URL(String(input?.url || input)).host})`); };

const generated = new URL('./.trading_audit.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';", 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'), 'utf8');
let mod;
try { mod = await import(`${generated.href}?t=${Date.now()}`); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

const memStorage = (m = new Map()) => ({
  saved: m,
  get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => m.has(x)).map((x) => [x, structuredClone(m.get(x))])) : structuredClone(m.get(k))),
  put: async (k, v) => { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) m.set(a, structuredClone(b)); else m.set(k, structuredClone(v)); },
  delete: async (k) => (Array.isArray(k) ? k.filter((x) => m.delete(x)).length : m.delete(k)),
  list: async ({ prefix = '' } = {}) => new Map([...m].filter(([k]) => String(k).startsWith(prefix))),
  setAlarm: async () => {}, deleteAlarm: async () => {}, getAlarm: async () => null,
});

// A simulation trade as strategy_sim.closeTrade stores it, with BTC's real cost model (0.6% a side, 0.02% slippage).
function simTrade({ id, symbol = 'BTC-USD', entryRaw = 100000, stop = 99900, exitRaw = 99900, signal = '2026-10-20T10:00:00.000Z', entry = '2026-10-20T10:01:00.000Z', exit = '2026-10-20T10:05:00.000Z' }) {
  const slip = 0.0002; const fee = 0.006;
  const entryPx = entryRaw + entryRaw * slip; const exitPx = exitRaw - exitRaw * slip;
  const risk = entryRaw - stop; const fees = entryPx * fee + exitPx * fee;
  const rGross = (exitRaw - entryRaw) / risk; const r = (exitPx - entryPx - fees) / risk;
  return { id: id || `channel-20|any|2|${symbol}|${entry}`, strategy: 'channel-20|any|2', symbol, signal_t: signal, entry_t: entry, entry_raw: entryRaw, entry: entryPx, stop, target: entryRaw + 2 * risk, exit_t: exit, exit_raw: exitRaw, exit: exitPx, exit_reason: 'stop', r_gross: rGross, r, cost_r: rGross - r };
}

// A journal record built with the journal's own settleTrade, so its stored numbers are consistent.
function journalRecord({ env = 'paper', entry = '2026-09-22T14:00:00.000Z', exit = '2026-09-22T15:00:00.000Z', raw = 20000, exitRaw = 19990, stop = 19990, portfolio = 'orb|any@v1|2' } = {}) {
  const contract = CONTRACTS.MNQ;
  const half = 0.125; const slip = 0.25;
  const pos = { side: 'long', entry: { raw, spread: half, slippage: slip }, stop };
  const settled = settleTrade(pos, { raw: exitRaw, spread: half, slippage: slip }, 1, contract, COSTS, 'stop');
  return {
    source: env === 'paper' ? 'paper' : 'backtest', environment: env, portfolio, symbol: 'MNQ', contract: 'MNQ', qty: 1, strategy: 'orb-5m', strategy_version: 'v1', side: 'long', session: 'open',
    signal: { time: '2026-09-22T13:55:00.000Z', why: 'test', ref: raw }, entry: { time: entry, raw, fill: raw + half + slip, spread: half, slippage: slip, basis: 'next_bar_open' },
    stop, target: raw + 20, exit: { time: exit, raw: exitRaw, fill: exitRaw - half - slip, reason: 'stop' }, ...settled,
    mfe_points: 0, mae_points: 10, data: { resolution: '5m', label: 'intraday 5m bars, fills at the next open' }, cost_assumptions: { ...COSTS }, params: {},
  };
}

test('simulation: total R splits into price moves and costs, and trades whose costs exceed their risk are named', () => {
  const now = Date.parse('2026-10-24T00:00:00Z');
  // A 0.1% BTC stop: costs alone are about 12 R. A 5% stop: costs are a quarter of a R.
  const tiny = simTrade({});
  const wide = simTrade({ id: 'wide', stop: 95000, exitRaw: 110000, exit: '2026-10-20T11:00:00.000Z' });
  const a = auditSimTrades([tiny, wide], { now });
  assert.equal(a.closed, 2);
  assert.ok(Math.abs(a.total_r - (a.gross_r_before_costs - a.costs_r)) < 0.02, 'total = gross minus costs');
  assert.equal(a.trades_with_costs_over_risk, 1);
  assert.ok(a.r_from_those_trades < -12, `the tiny stop lost ${a.r_from_those_trades} R, almost all of it costs`);
  assert.ok(tiny.cost_r > 12);
  assert.equal(a.by_symbol['BTC-USD'].round_trip_cost_pct, 1.24);
  for (const p of Object.values(a.problems)) assert.equal(p.count, 0, 'consistent records have no problems');
});

test('simulation: a duplicate id, a future time, a fill that is not the next minute and a wrong stored R are each caught', () => {
  const now = Date.parse('2026-10-24T00:00:00Z');
  const ok = simTrade({});
  const late = simTrade({ id: 'late', entry: '2026-10-20T10:03:00.000Z' });
  const future = simTrade({ id: 'future', exit: '2026-10-25T00:00:00.000Z' });
  const wrong = { ...simTrade({ id: 'wrong' }), r_gross: 5 };
  const a = auditSimTrades([ok, ok, late, future, wrong], { now });
  assert.equal(a.problems.duplicate_ids.count, 1);
  assert.equal(a.problems.fill_not_next_minute.count, 1);
  assert.equal(a.problems.future.count, 1);
  assert.equal(a.problems.r_gross_mismatch.count, 1);
  assert.match(a.not_checkable, /bars/, 'fills inside the bar need the bars, and the report says so');
});

test('journal: P&L and R are recomputed from prices and costs; a tampered value is flagged and the record is not changed', () => {
  const good = journalRecord();
  const x = recompute(good);
  assert.equal(x.net, good.net_pnl);
  assert.equal(x.r_net, good.r_net);
  const tampered = { ...journalRecord({ portfolio: 'other|any@v1|2' }), net_pnl: -1018 };
  const before = JSON.stringify(tampered);
  const a = auditJournal([good, tampered], { now: Date.parse('2026-10-24T00:00:00Z') });
  assert.equal(a.groups['paper:futures'].records, 2);
  assert.equal(a.groups['paper:futures'].problems.pnl_from_prices_mismatch.count, 1);
  assert.match(a.groups['paper:futures'].problems.pnl_from_prices_mismatch.examples[0], /stored -1018 recomputed/);
  assert.equal(JSON.stringify(tampered), before, 'the audit never rewrites a record');
});

test('journal: costs larger than a tiny stop are flagged, and backtest records stay apart from paper', () => {
  const tiny = journalRecord({ stop: 19999, exitRaw: 19999 });
  const bt = journalRecord({ env: 'backtest' });
  const a = auditJournal([tiny, bt], { now: Date.parse('2026-10-24T00:00:00Z') });
  assert.equal(a.groups['paper:futures'].problems.costs_over_risk.count, 1);
  assert.equal(a.groups['backtest:futures'].records, 1);
  assert.equal(a.day.utc_date.records, 1, 'a day\'s P&L counts paper records only');
});

test('one day three ways: an evening exit is Sept 22 in New York but Sept 23 in UTC and on the CME trade day', () => {
  const evening = journalRecord({ entry: '2026-09-23T00:30:00.000Z', exit: '2026-09-23T01:30:00.000Z', portfolio: 'evening' });
  const midday = journalRecord({ portfolio: 'midday' });
  const d = dayAudit([evening, midday], '2026-09-22');
  assert.equal(d.new_york_date.records, 2, '21:30 New York is still Sept 22 on the calendar');
  assert.equal(d.utc_date.records, 1);
  assert.equal(d.cme_trade_day.records, 1, 'after 18:00 New York the CME day is already Sept 23');
  assert.equal(d.new_york_date.net_pnl, Math.round((evening.net_pnl + midday.net_pnl) * 100) / 100);
  assert.ok(d.new_york_date.rows.every((r) => r.portfolio && r.exit), 'every row is named');
});

test('research units: fixtures, missing data hashes and failed look-ahead audits are counted, with the backtest trade total', () => {
  const unit = (o) => ({ ok: true, strategy_id: 's', market: 'MNQ', timeframe: '5m', mode: 'BACKTEST', all: { trades: 100 }, dataset: { sha256: 'a'.repeat(64), provider: 'Yahoo Finance chart (public, free, delayed)' }, look_ahead: 'passed', ...o });
  const a = auditResearchUnits([unit({}), unit({ dataset: { sha256: null, provider: 'TEST FIXTURE (not market data): x' }, all: { trades: 15 } }), unit({ look_ahead: 'FAILED', all: { trades: 7 } })]);
  assert.equal(a.units, 3);
  assert.equal(a.backtest_trades, 122);
  assert.equal(a.from_test_fixtures.count, 1);
  assert.equal(a.from_test_fixtures.trades, 15);
  assert.equal(a.without_dataset_hash.count, 1);
  assert.equal(a.look_ahead.failed.count, 1);
});

test('the whole audit reads storage only, keeps each record set apart, and its deploy line carries counts only', async () => {
  const m = new Map();
  const storage = memStorage(m);
  const trades = [simTrade({})];
  m.set(STATE_KEY, { trades: { first: 0, last: 0, tail: 1, stored: 1, dropped: 0 }, symbols: {}, open: { 'k|BTCUSDT': { strategy: 'k', symbol: 'BTCUSDT', entry_t: '2026-10-01T00:00:00.000Z' } }, pending: {}, counts: { too_costly: 3 } });
  m.set('strategy_sim_trades:0', trades);
  m.set('evr:paper:orb|any@v1|2:2026-09-22T14:00:00.000Z', journalRecord());
  const before = JSON.stringify([...m]);
  const a = await deepTradeAudit(storage, { now: Date.parse('2026-10-24T00:00:00Z') });
  assert.equal(JSON.stringify([...m]), before, 'nothing written');
  assert.equal(a.read_only, true);
  assert.equal(a.simulation.closed, 1);
  assert.deepEqual(a.simulation.open.on_retired_feeds, ['k|BTCUSDT|2026-10-01T00:00:00.000Z'], 'an open Binance position can never close by itself');
  assert.equal(a.simulation.cost_gate.skipped_since_gate, 3);
  assert.equal(a.journal.groups['paper:futures'].records, 1);
  const line = auditSummaryLine(a);
  assert.match(line, /simulation 1 closed, 1 open \(1 on retired feeds\)/);
  assert.match(line, /day 2026-09-22: UTC/);
  assert.doesNotMatch(line, /20000|19990/, 'no prices in the deploy line');
  assert.match(speakDeepAudit(a), /costs larger than their whole risk/);
});

// ─── Through the Worker ───────────────────────────────────────────────────

async function che(extraEnv = {}) {
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', ...extraEnv, AI: { run: async () => ({ response: 'model' }) } };
  const saved = new Map();
  const state = new CheState({ storage: memStorage(saved), waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const call = (path, method = 'GET', body, token = '', headers = {}) => worker.fetch(new Request(`https://che.example${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }), env);
  const token = (await (await call('/api/pair', 'POST', { code: '123456' })).json()).device_token;
  const chat = async (message) => {
    const raw = await (await call('/api/chat', 'POST', { message, history: [] }, token)).text();
    const events = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    return { reply: events.filter((e) => e.type === 'delta').map((e) => e.delta).join(''), route: (events.find((e) => e.type === 'done') || {}).source };
  };
  return { saved, call, token, chat };
}

test('Worker: the audit view carries the deep audit; stop and reset (asked first, archived) work by route and by voice', async () => {
  const { saved, call, token, chat } = await che();
  saved.set('strategy_sim_trades:0', [simTrade({})]);
  saved.set(STATE_KEY, { trades: { first: 0, last: 0, tail: 1, stored: 1, dropped: 0 }, symbols: {}, open: {}, pending: { 'p|MNQ': { strategy: 'p', symbol: 'MNQ' } }, counts: {} });
  const audit = await (await call('/api/trading/visual?view=audit', 'GET', null, token)).json();
  assert.equal(audit.deep.simulation.trades_with_costs_over_risk, 1);
  assert.match(audit.spoken, /Deeper checks/);
  const spoken = await chat('Audit the trades');
  assert.equal(spoken.route, 'che_trading_visual');
  assert.match(spoken.reply, /costs larger than their whole risk/);

  const stopped = await chat('Stop the strategy simulation');
  assert.equal(stopped.route, 'che_strategy_sim');
  assert.match(stopped.reply, /Stopped the strategy simulation, sir: 1 waiting signal cancelled/);

  const asked = await chat('Reset the strategy simulation');
  assert.match(asked.reply, /Say "yes, reset the simulation"/);
  assert.ok(saved.has('strategy_sim_trades:0'), 'nothing changed before the yes');
  const refused = await (await call('/api/trading/sim', 'POST', { action: 'reset' }, token)).json();
  assert.equal(refused.needs_confirmation, true);
  const done = await chat('Yes, reset the strategy simulation');
  assert.match(done.reply, /Reset the strategy simulation, sir\. The previous run \(1 trades\) is archived/);
  const archive = saved.get('strategy_sim_archives');
  assert.equal(archive.length, 1);
  assert.equal(saved.get(`strategy_sim_archive:${archive[0].id}:trades:0`).length, 1, 'the trade is in the archive');

  const guest = await (await call('/api/trading/sim', 'POST', { action: 'stop' })).status;
  assert.ok([401, 403].includes(guest), 'no device, no control');
});

test('Worker: the deploy audit route opens only with this deploy\'s probe token and returns counts', async () => {
  const probeToken = 'f'.repeat(64);
  const { call } = await che({ CHE_VOICE_PROBE_TOKEN: probeToken });
  assert.equal((await call('/api/trading/audit/probe', 'POST')).status, 404);
  assert.equal((await call('/api/trading/audit/probe', 'POST', null, 'e'.repeat(64))).status, 404);
  const out = await (await call('/api/trading/audit/probe', 'POST', null, probeToken)).json();
  assert.equal(out.ok, true);
  assert.match(out.summary, /simulation 0 closed/);
});
