// The owner's recording (2026-10-24): an ETH-USD simulation trade is listed on the chart, and opening its replay
// said "No CHE trade has the ID ...". The chart marker carried the simulation's own record id
// ("strategy|symbol|time"), not the ledger ID Trade Replay looks up. Each marker now carries the ledger ID, an
// older build's record id still resolves to the same trade, and an ETH-USD trade draws the exchange's real
// 1-minute candles around it, or says exactly why it cannot. Nothing here invents a candle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chartMarkers } from './trading_chart.js';
import { STATE_KEY } from './strategy_sim.js';
import { NO_DATA, readTradeEvidence } from './trade_evidence.js';
import { readVisualTrades } from './trading_visual.js';

function memStorage() {
  const m = new Map();
  return {
    m,
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => m.has(x)).map((x) => [x, structuredClone(m.get(x))])) : (m.has(k) ? structuredClone(m.get(k)) : undefined)),
    put: async (k, v) => { m.set(k, structuredClone(v)); },
    delete: async (k) => m.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...m].filter(([k]) => String(k).startsWith(prefix))),
  };
}

// A closed ETH-USD simulation trade exactly as strategy_sim.js closeTrade() stores it.
const ETH = {
  id: 'ema-pullback-1m|ETH-USD|2026-10-24T14:31:00.000Z', strategy: 'ema-pullback-1m', symbol: 'ETH-USD', label: 'ETH/USD (Coinbase Exchange spot)',
  params: { signal: 'ema_pullback', trend_filter: 'any', target_r: 2 }, why: 'pullback to the 20 EMA', signal_t: '2026-10-24T14:30:00.000Z', signal_price: 2501.5,
  entry_t: '2026-10-24T14:31:00.000Z', entry_raw: 2501.2, entry: 2501.45, stop: 2496.2, target: 2511.2, feed: 'LIVE',
  exit_t: '2026-10-24T14:52:00.000Z', exit_raw: 2511.2, exit: 2510.95, exit_reason: 'target', r_gross: 2, r: 1.84, cost_r: 0.16,
};

async function seeded() {
  const storage = memStorage();
  await storage.put(STATE_KEY, { version: 1, trades: { first: 0, last: 0, tail: 1, stored: 1, dropped: 0 }, symbols: {} });
  await storage.put('strategy_sim_trades:0', [ETH]);
  return storage;
}

// Coinbase's real answer shape: [time, low, high, open, close, volume], newest first.
function coinbase(fromIso, minutes) {
  const t0 = Date.parse(fromIso) / 1000;
  return Array.from({ length: minutes }, (_, i) => { const p = 2490 + i * 0.4; return [t0 + i * 60, p - 1, p + 1, p, p + 0.2, 10 + i]; }).reverse();
}

test('regression: opening the replay of an ETH-USD simulation trade from its chart marker finds the trade', async () => {
  const storage = await seeded();
  const fetcher = async () => new Response(JSON.stringify(coinbase('2026-10-24T13:40:00Z', 90)));
  const markers = chartMarkers({ simTrades: [ETH], symbol: 'ETH-USD' });
  const exit = markers.find((m) => m.kind === 'exit');
  const { trades } = await readVisualTrades(storage);
  assert.equal(trades.length, 1);
  // The marker names the ledger ID, which is what Trade Replay opens.
  assert.equal(exit.trade_id, trades[0].id);
  assert.match(exit.trade_id, /^T[0-9A-Z]{13}$/);
  const e = await readTradeEvidence(storage, exit.trade_id, { fetcher, now: Date.parse('2026-10-24T16:00:00Z') });
  assert.equal(e.ok, true, e.error);
  assert.equal(e.label, 'SIMULATION');
  assert.deepEqual([e.symbol, e.strategy, e.side, e.entry.time, e.exit.time, e.stop, e.target, e.outcome.r], ['ETH-USD', ETH.strategy, 'long', ETH.entry_t, ETH.exit_t, ETH.stop, ETH.target, ETH.r]);
  // The installed app sent the marker's own id: the exact failure in the recording. It now resolves to the same trade.
  const legacy = await readTradeEvidence(storage, exit.id, { fetcher, now: Date.parse('2026-10-24T16:00:00Z') });
  assert.equal(legacy.ok, true, legacy.error);
  assert.equal(legacy.id, e.id);
  // An ID that names no record still finds nothing; nothing is guessed.
  const none = await readTradeEvidence(storage, 'ema-pullback-1m|ETH-USD|2026-01-01T00:00:00.000Z', { fetcher });
  assert.equal(none.ok, false);
  assert.match(none.error, /^No CHE trade has the ID /);
});

test('an ETH-USD trade draws Coinbase\'s real minutes around it, kept for the next replay', async () => {
  const storage = await seeded();
  const calls = [];
  const fetcher = async (url) => { calls.push(String(url)); return new Response(JSON.stringify(coinbase('2026-10-24T13:40:00Z', 90))); };
  const now = Date.parse('2026-10-24T16:00:00Z');
  const { trades } = await readVisualTrades(storage);
  const e = await readTradeEvidence(storage, trades[0].id, { fetcher, now });
  assert.equal(e.bars_source.kind, 'exchange_history');
  assert.match(e.bars_source.label, /^Coinbase Exchange ETH-USD 1-minute candles/);
  assert.equal(e.replay.supported, true);
  assert.ok(e.bars.some((b) => b.t === ETH.entry_t), 'the entry bar is drawn');
  assert.ok(e.bars.at(-1).t >= ETH.exit_t, 'the window reaches the exit');
  assert.match(calls[0], /^https:\/\/api\.exchange\.coinbase\.com\/products\/ETH-USD\/candles\?granularity=60&start=2026-10-24T13:50:00\.000Z&end=/);
  const before = calls.length;
  const again = await readTradeEvidence(storage, trades[0].id, { fetcher, now });
  assert.equal(calls.length, before, 'the stored minutes are reused');
  assert.deepEqual(again.bars, e.bars);
});

test('when no exchange answers, the replay says why and draws nothing', async () => {
  const storage = await seeded();
  const fetcher = async (url) => (String(url).includes('coinbase') ? new Response('{"message":"busy"}', { status: 503 }) : new Response(JSON.stringify({ error: ['EGeneral:Too many requests'] })));
  const { trades } = await readVisualTrades(storage);
  const e = await readTradeEvidence(storage, trades[0].id, { fetcher, now: Date.parse('2026-10-24T16:00:00Z') });
  assert.equal(e.ok, true);
  assert.deepEqual(e.bars, []);
  assert.equal(e.no_data, NO_DATA);
  assert.match(e.no_data_reason, /Coinbase: Coinbase answered HTTP 503; Kraken: Kraken answered EGeneral:Too many requests\. No candle was made up\./);
  assert.equal(e.replay.supported, false);
  assert.equal(storage.m.has(`trade_bars:${trades[0].id}`), false, 'a failure is never cached');
});

test('a forward paper marker carries the ledger ID too; an open simulation trade carries none', () => {
  const open = { ...ETH, exit_t: undefined, exit_raw: undefined, exit: undefined, r: undefined };
  const [entry] = chartMarkers({ simTrades: [open], symbol: 'ETH-USD' });
  assert.equal(entry.trade_id, undefined);
  const journal = [{ environment: 'paper', data: { resolution: '5m' }, portfolio: 'ema|any@v1|2', strategy: 'ema', symbol: 'MNQ', side: 'long',
    entry: { time: '2026-10-22T14:15:00Z', raw: 21000, fill: 21000.375 }, exit: { time: '2026-10-22T14:35:00Z', raw: 21010, fill: 21009.875 }, stop: 20990, target: 21020, net_pnl: 10, r_net: 0.5 }];
  const ms = chartMarkers({ journal, symbol: 'MNQ' });
  assert.equal(ms.length, 2);
  assert.ok(ms.every((m) => /^T[0-9A-Z]{13}$/.test(m.trade_id) && m.trade_id === ms[0].trade_id));
});
