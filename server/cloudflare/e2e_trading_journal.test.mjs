// E2E (reliability lane, 2026-10-25): one recorded MNQ forward-paper trade goes through the whole trade-evidence path.
//   recorded trade (validated and journalled by trading_evidence.appendTrades) + recorded 5-minute bars
//   (trading_research.importDataset, labelled TEST FIXTURE) → GET /api/trading/visual through the real Worker:
//   journal, trade list, one trade's evidence and the replay frame.
// Every P&L number is recomputed here by hand from the raw prices and the cost assumptions, not by calling the
// production settlement code, so a change to the arithmetic or to how a view copies it is caught.
// Offline: no market site is asked; the bars and the trade are TEST FIXTURES, never market data.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { COSTS, CONTRACTS, appendTrades, fillEntry, fillExit, settleTrade, strategyVersion } from './trading_evidence.js';
import { importDataset } from './trading_research.js';

const generated = new URL('./.e2e_trading_journal.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

const refused = [];
globalThis.fetch = async (input) => {
  const host = new URL(String(input?.url || input)).host;
  refused.push(host);
  throw new TypeError(`fetch failed (e2e tests are offline: ${host})`);
};

function memStorage() {
  const saved = new Map();
  return {
    saved,
    get: async (k) => (Array.isArray(k)
      ? new Map(k.filter((key) => saved.has(key)).map((key) => [key, structuredClone(saved.get(key))]))
      : (saved.has(k) ? structuredClone(saved.get(k)) : undefined)),
    put: async (k, v) => {
      if (k && typeof k === 'object') for (const [key, value] of Object.entries(k)) saved.set(key, structuredClone(value));
      else saved.set(k, structuredClone(v));
    },
    delete: async (k) => (Array.isArray(k) ? k.filter((key) => saved.delete(key)).length : saved.delete(k)),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([key]) => key.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

async function ownerPhone(storage, { owner = true } = {}) {
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'Understood, sir.' }) } };
  const state = new CheState({ storage, waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const call = (path, { method = 'GET', body, token = '' } = {}) => worker.fetch(new Request(`https://che.example${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body || {}) }),
  }), env);
  const token = owner ? (await (await call('/api/pair', { method: 'POST', body: { code: '123456' } })).json()).device_token : '';
  return async (path) => { const r = await call(path, { token }); return { status: r.status, body: await r.json() }; };
}

// ─── TEST FIXTURE: 5-minute MNQ bars on 2026-10-20 (UTC), a steady climb. Not market data. ───
const T0 = Date.parse('2026-10-20T13:00:00Z');
const at = (i) => new Date(T0 + i * 300_000).toISOString();
const BARS = Array.from({ length: 40 }, (_, i) => {
  const o = 19962 + 2 * i;
  return { t: at(i), o, h: o + 6, l: o - 3, c: o + 2, v: 100 + i };
});
const ENTRY_I = 19; // 14:35Z, opens at 20000
const EXIT_I = 26; // 15:10Z, opens at 20014 and its high reaches 20020
const QTY = 2;
const STOP = 19990;
const TARGET = 20020;

// TEST FIXTURE: the record a forward-paper portfolio writes when this trade closes at its target. The production
// fill and settlement functions build it exactly as trading_evidence.closeAt does.
function recordedTrade() {
  const contract = CONTRACTS.MNQ;
  const params = { target_r: 2 };
  const version = strategyVersion('fvg-retest-5m', 'any', { ...params, contract: 'MNQ', qty: QTY, costs: COSTS });
  const entry = fillEntry(BARS[ENTRY_I], contract, COSTS, 'long');
  const exit = fillExit(TARGET, 'target', contract, COSTS, 'long');
  const position = { side: 'long', entry, stop: STOP };
  const settled = settleTrade(position, exit, QTY, contract, COSTS, 'target');
  return {
    source: 'paper', environment: 'paper', portfolio: `fvg-retest-5m|any@${version}`, symbol: 'MNQ', contract: 'MNQ', qty: QTY,
    strategy: 'fvg-retest-5m', filter: 'any', strategy_version: version, params, side: 'long', session: 'ny_am',
    signal: { time: at(ENTRY_I - 1), why: 'TEST FIXTURE: bullish gap retest', ref: BARS[ENTRY_I - 1].c },
    condition: null,
    entry: { time: at(ENTRY_I), raw: entry.raw, fill: entry.price, spread: entry.spread, slippage: entry.slippage, basis: 'next_bar_open' },
    stop: STOP, target: TARGET, risk_points: entry.raw - STOP,
    exit: { time: at(EXIT_I), raw: exit.raw, fill: exit.price, reason: 'target' },
    same_bar_both_touched: false,
    ...settled,
    mfe_points: 20, mae_points: 3, mfe_r: 2, mae_r: 0.3,
    data: { resolution: '5m', price_series: '5m', label: 'TEST FIXTURE: intraday 5m bars, fills at the next open', entry_feed: null },
    cost_assumptions: { ...COSTS },
    result: settled.net_pnl > 0 ? 'win' : settled.net_pnl < 0 ? 'loss' : 'flat',
  };
}

// The arithmetic, by hand: MNQ is $2 a point, a tick is 0.25; one tick of spread (half on each side), one tick of
// slippage on the market entry and none on the resting target; $1.50 commission and $0.50 fees per contract per side.
const HAND = (() => {
  const pv = 2 * QTY; // dollars per point for 2 contracts
  const entryFill = 20000 + 0.125 + 0.25; // 20000.375
  const exitFill = 20020 - 0.125; // 20019.875
  const gross = (20020 - 20000) * pv; // 80
  const spread = (0.125 + 0.125) * pv; // 1
  const slippage = (0.25 + 0) * pv; // 1
  const commissions = 2 * QTY * 1.5; // 6
  const fees = 2 * QTY * 0.5; // 2
  const net = gross - spread - slippage - commissions - fees; // 70
  const risk = (20000 - STOP) * pv; // 40
  return { entryFill, exitFill, gross, spread, slippage, commissions, fees, net, r: net / risk };
})();

async function seeded() {
  const storage = memStorage();
  const journal = await appendTrades(storage, [recordedTrade()]);
  assert.deepEqual(journal, { written: 1, duplicates: 0, conflicts: [] }, 'the fixture trade passes the journal validation');
  const ds = await importDataset(storage, { market: 'MNQ', tf: '5m', bars: BARS, provider: 'reliability e2e', fixture: true }, { now: Date.parse('2026-10-21T00:00:00Z') });
  assert.equal(ds.ok, true, ds.reason);
  return storage;
}

test('hand arithmetic for the fixture (sanity of the test itself)', () => {
  assert.deepEqual(HAND, { entryFill: 20000.375, exitFill: 20019.875, gross: 80, spread: 1, slippage: 1, commissions: 6, fees: 2, net: 70, r: 1.75 });
});

test('e2e trading: journal → trade evidence → replay show the recorded entry, exit and the hand-computed P&L', async () => {
  const storage = await seeded();
  const get = await ownerPhone(storage);

  // Journal: the one trade, as recorded.
  const journal = await get('/api/trading/visual?view=journal&instrument=MNQ');
  assert.equal(journal.status, 200);
  assert.equal(journal.body.paper_only, true);
  const rows = journal.body.entries.filter((e) => e.kind === 'trade');
  assert.equal(rows.length, 1, 'exactly the recorded trade, nothing invented');
  const row = rows[0];
  assert.equal(row.execution_type, 'forward_paper');
  assert.equal(row.symbol, 'MNQ');
  assert.equal(row.entry_time, at(ENTRY_I));
  assert.equal(row.exit_time, at(EXIT_I));
  assert.equal(row.entry_price, HAND.entryFill);
  assert.equal(row.exit_price, HAND.exitFill);
  assert.equal(row.gross, HAND.gross);
  assert.equal(row.commissions, HAND.commissions + HAND.fees, 'commissions in the journal include exchange fees');
  assert.equal(row.slippage, HAND.slippage + HAND.spread, 'slippage in the journal includes the spread');
  assert.equal(row.net, HAND.net);
  assert.equal(row.r, HAND.r);
  assert.equal(row.result, 'win');
  assert.equal(row.net, row.gross - row.commissions - row.slippage, 'net = gross − commissions − slippage, as shown');
  assert.match(row.id, /^T[0-9A-Z]{13}$/, 'a stable trade ID the replay can open');

  // The same trade's evidence by its ID: entry and exit markers, outcome, and bars from the labelled fixture.
  const one = await get(`/api/trading/visual?view=trade&id=${row.id}`);
  assert.equal(one.status, 200);
  const e = one.body.trade;
  assert.equal(e.ok, true, e.error);
  assert.equal(e.label, 'FORWARD PAPER');
  assert.deepEqual([e.entry.time, e.entry.price, e.entry.raw], [at(ENTRY_I), HAND.entryFill, 20000]);
  assert.deepEqual([e.exit.time, e.exit.price, e.exit.raw, e.exit.reason], [at(EXIT_I), HAND.exitFill, 20020, 'target']);
  assert.deepEqual([e.outcome.result, e.outcome.net, e.outcome.gross, e.outcome.r, e.outcome.unit], ['win', HAND.net, HAND.gross, HAND.r, 'USD']);
  assert.ok(e.bars.length > 0, e.no_data_reason || 'bars around the trade');
  assert.equal(e.bars_source?.kind, 'research_dataset');
  assert.match(e.bars_source.label, /TEST FIXTURE/, 'fixture bars are never labelled as market data');
  assert.ok(e.bars.some((b) => b.t === at(ENTRY_I)) && e.bars.some((b) => b.t === at(EXIT_I)), 'the entry and exit bars are drawn');

  // Replay frame after the exit bar closed: the entry executed and the exit happened, with the same P&L.
  const cursor = new Date(Date.parse(at(EXIT_I)) + 300_000).toISOString();
  const replay = await get(`/api/trading/visual?view=replay&instrument=MNQ&timeframe=5m&cursor=${encodeURIComponent(cursor)}`);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.ok, true, replay.body.error);
  const entry = replay.body.executed.find((x) => x.id === row.id);
  const exit = replay.body.happened.find((x) => x.id === row.id);
  assert.ok(entry, 'entry marker in the replay');
  assert.ok(exit, 'exit marker in the replay');
  assert.deepEqual([entry.entry_time, entry.entry_price, entry.status], [at(ENTRY_I), HAND.entryFill, 'closed']);
  assert.deepEqual([exit.exit_time, exit.exit_price, exit.exit_reason, exit.net, exit.r], [at(EXIT_I), HAND.exitFill, 'target', HAND.net, HAND.r]);
  assert.ok(replay.body.knew.bars.every((b) => Date.parse(b.t) + 300_000 <= Date.parse(cursor)), 'no bar after the cursor is shown');
  assert.match(String(replay.body.provenance?.source || JSON.stringify(replay.body.provenance)), /TEST FIXTURE/);

  // Before the exit bar closes the replay must not reveal the exit (no look-ahead).
  const early = await get(`/api/trading/visual?view=replay&instrument=MNQ&timeframe=5m&cursor=${encodeURIComponent(at(EXIT_I))}`);
  assert.ok(early.body.executed.some((x) => x.id === row.id && x.status === 'open'));
  assert.equal(early.body.happened.some((x) => x.id === row.id), false, 'the exit is hidden until its bar has closed');

  // Totals over the one trade agree with the hand arithmetic, and no live order path exists.
  const summary = await get('/api/trading/visual?view=summary&instrument=MNQ&execution_type=forward_paper');
  assert.equal(summary.body.totals.trades, 1);
  assert.equal(summary.body.totals.net, HAND.net);
  assert.equal(refused.length, 0, `no network was attempted (${refused.join(', ')})`);
});

test('e2e trading: an unknown trade ID is refused honestly and a guest cannot read the journal', async () => {
  const storage = await seeded();
  const get = await ownerPhone(storage);
  const missing = await get('/api/trading/visual?view=trade&id=T0000000000000');
  assert.equal(missing.body.ok, false);
  assert.match(missing.body.error, /No CHE trade has the ID T0000000000000/);
  const guest = await ownerPhone(storage, { owner: false });
  const denied = await guest('/api/trading/visual?view=journal');
  assert.notEqual(denied.status, 200, 'trading records are owner-only');
});
