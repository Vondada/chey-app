// Regression tests for the owner's trading and memory status questions (owner, 2026-10-27). CHE answered "Is your
// trading live?" with a ticker error. Each question must reach a status route, and each reply must come from stored
// records: the feed, the journal, the Rithmic candle store and the memory store. Nothing may be invented.
import assert from 'node:assert/strict';
import test from 'node:test';
import { rithmicStatus } from './rithmic_dataset.js';
import { gatherTradingStatus, tradingStatusIntent, tradingStatusReply } from './trading_answers.js';
import { tradingIntent } from './trading_lab.js';

// Minimal Durable-Object-style storage: get (one key or a list), put, and list by prefix, newest first when asked.
function fakeStorage(entries = []) {
  const m = new Map(entries);
  return {
    async get(k) {
      if (Array.isArray(k)) return new Map(k.filter((x) => m.has(x)).map((x) => [x, m.get(x)]));
      return m.get(k);
    },
    async put(k, v) { m.set(k, v); },
    async list({ prefix = '', reverse = false, limit = Infinity } = {}) {
      const keys = [...m.keys()].filter((k) => k.startsWith(prefix)).sort();
      if (reverse) keys.reverse();
      return new Map(keys.slice(0, limit).map((k) => [k, m.get(k)]));
    },
  };
}

const liveDash = {
  feed: { status: 'LIVE', authenticated: true, subscription_verified: true, provider: 'tradovate', provider_symbol: 'MNQZ6', contract: 'MNQZ6', latency_s: 4, last_bar_time: '2026-10-27T20:00:00.000Z', checked_at: '2026-10-27T20:00:05.000Z' },
  feed_blocker: '',
  session: { state: 'open' },
  state: { enabled: true, started_at: '2026-10-18T14:00:00.000Z' },
  broker: { live_orders: 'disabled' },
  positions: [],
  trades: [],
  learning: { daily_report: 'Strategy A leads on closed paper trades. Nothing is ranked as reliable yet.', strategies: [] },
};
const delayedDash = { ...liveDash, feed: { ...liveDash.feed, status: 'DELAYED', latency_s: 900 } };
const noFeedDash = { ...liveDash, feed: null, feed_blocker: 'No Tradovate market feed is connected.' };
const noMemory = { count: 0, latest_at: null };
const memoryOn = { count: 3, latest_at: '2026-10-27T19:30:00.000Z' };
const noRithmic = { symbols: [] };
const rithmicOn = { symbols: [{ symbol: 'MNQZ6', hours: 2, latest_t: '2026-10-27T20:01:00.000Z', received_at: '2026-10-27T20:01:30.000Z' }] };

test('the six owner questions reach a status route, not the ticker lookup', () => {
  assert.equal(tradingStatusIntent('Is your trading live?')?.kind, 'live');
  assert.equal(tradingStatusIntent('Are you receiving real-time market data?')?.kind, 'live');
  assert.equal(tradingStatusIntent('Show your latest paper trade.')?.kind, 'latest');
  assert.equal(tradingStatusIntent('Is Rithmic connected?')?.kind, 'rithmic');
  assert.equal(tradingStatusIntent('What have you learned from your trading?')?.kind, 'learning');
  assert.equal(tradingStatusIntent('Is your long-term memory working?')?.kind, 'memory');
});

test('the classifier that caused the bug no longer turns "show your latest paper trade" into a watch on no symbol', () => {
  assert.notEqual(tradingIntent('Show your latest paper trade.')?.kind, 'watch');
});

test('a real ticker still reaches the ticker route, and an ordinary sentence reaches no status route', () => {
  assert.equal(tradingStatusIntent('Watch AAPL on paper trading'), null);
  assert.equal(tradingStatusIntent('What is the weather in Dallas today?'), null);
  assert.equal(tradingStatusIntent('My memory of the trip is fuzzy, can you help me write it down?'), null, 'memory is a status only with a status word');
});

test('an overlong turn is never a status question', () => {
  assert.equal(tradingStatusIntent(`Is your trading live? ${'x'.repeat(500)}`), null);
});

test('"Is your trading live?" answers with paper state, the feed record and the real-money state', () => {
  const reply = tradingStatusReply('live', { dash: liveDash, rithmic: noRithmic, memory: noMemory });
  assert.match(reply, /Paper trading is on, sir/);
  assert.match(reply, /Market data: LIVE from tradovate MNQZ6 \(MNQZ6\)\./);
  assert.match(reply, /That is real-time data\./);
  assert.match(reply, /Real-money orders are disabled\./);
  assert.doesNotMatch(reply, /did not recognize|ticker/i);
});

test('"Are you receiving real-time market data?" says delayed data is not real-time', () => {
  const reply = tradingStatusReply('live', { dash: delayedDash, rithmic: noRithmic, memory: noMemory });
  assert.match(reply, /Market data: DELAYED/);
  assert.match(reply, /delayed data: research only, not execution evidence/);
  assert.doesNotMatch(reply, /That is real-time data/);
});

test('with no stored feed record, the reply says so and never claims real-time data', () => {
  const reply = tradingStatusReply('live', { dash: noFeedDash, rithmic: noRithmic, memory: noMemory });
  assert.match(reply, /No market data has been read yet, sir\. No Tradovate market feed is connected\./);
  assert.doesNotMatch(reply, /LIVE|real-time data/);
});

test('"Show your latest paper trade." with no closed trade says none closed, and never invents one', () => {
  const reply = tradingStatusReply('latest', { dash: liveDash, rithmic: noRithmic, memory: noMemory });
  assert.match(reply, /No paper trade has closed yet, sir\. 0 open\./);
  assert.doesNotMatch(reply, /Latest closed paper trade/);
});

test('"Show your latest paper trade." reads the newest stored trade, with its prices and times', () => {
  const trade = {
    side: 'long', qty: 1, contract: 'MNQZ6', strategy: 'EMA pullback', net_pnl: 12.5,
    entry: { fill: 21000.25, time: '2026-10-27T15:00:00.000Z' },
    exit: { fill: 21012.75, reason: 'target', time: '2026-10-27T15:20:00.000Z' },
  };
  const reply = tradingStatusReply('latest', { dash: { ...liveDash, trades: [trade] }, rithmic: noRithmic, memory: noMemory });
  assert.match(reply, /Latest closed paper trade: long 1 MNQZ6, EMA pullback, entered 21000\.25/);
  assert.match(reply, /exited 21012\.75 on target/);
  assert.match(reply, /net \$12\.50/);
});

test('"Is Rithmic connected?" says the login is on the iPhone and the server cannot see the connection, with no stored candles', () => {
  const reply = tradingStatusReply('rithmic', { dash: liveDash, rithmic: noRithmic, memory: noMemory });
  assert.match(reply, /No Rithmic candles have reached this server yet/);
  assert.match(reply, /cannot see whether the phone is connected right now/);
  assert.doesNotMatch(reply, /connected\./);
});

test('"Is Rithmic connected?" reports stored candles by contract, hours and times, and calls them a record, not a live check', () => {
  const reply = tradingStatusReply('rithmic', { dash: liveDash, rithmic: rithmicOn, memory: noMemory });
  assert.match(reply, /MNQZ6: 2 hours recorded/);
  assert.match(reply, /not a live connection check/);
});

test('"What have you learned from your trading?" reads the stored learning report, never a guess', () => {
  const reply = tradingStatusReply('learning', { dash: liveDash, rithmic: noRithmic, memory: noMemory });
  assert.match(reply, /Strategy A leads on closed paper trades/);
  assert.match(reply, /Nothing is ranked as reliable yet/);
});

test('"Is your long-term memory working?" reports the stored count and newest time, and says no recall test ran', () => {
  const reply = tradingStatusReply('memory', { dash: liveDash, rithmic: noRithmic, memory: memoryOn });
  assert.match(reply, /Long-term memory is storing: 3 conversation memories/);
  assert.match(reply, /I did not run a recall test just now/);
});

test('with no stored memories, memory says nothing is stored and never claims recall works', () => {
  const reply = tradingStatusReply('memory', { dash: liveDash, rithmic: noRithmic, memory: noMemory });
  assert.match(reply, /No conversation memories are stored yet/);
  assert.doesNotMatch(reply, /is storing/);
});

test('gatherTradingStatus reads the memory count, the newest memory time and the Rithmic store from storage', async () => {
  const storage = fakeStorage([
    ['brainmem_count', 3],
    [`brainmem:${String(Date.parse('2026-10-27T19:30:00.000Z')).padStart(15, '0')}`, { id: 'a', at: '2026-10-27T19:30:00.000Z', title: 'x', body: 'y', tokens: [] }],
    ['rithmic_1m_index:MNQZ6', ['2026-10-27T19', '2026-10-27T20']],
    ['rithmic_1m:MNQZ6:2026-10-27T20', { symbol: 'MNQZ6', candles: { 0: { t: '2026-10-27T20:00:00.000Z', received_at: '2026-10-27T20:00:30.000Z' }, 1: { t: '2026-10-27T20:01:00.000Z', received_at: '2026-10-27T20:01:30.000Z' } } }],
  ]);
  const facts = await gatherTradingStatus(storage, liveDash);
  assert.deepEqual(facts.memory, { count: 3, latest_at: '2026-10-27T19:30:00.000Z' });
  assert.deepEqual(facts.rithmic, { symbols: [{ symbol: 'MNQZ6', hours: 2, latest_t: '2026-10-27T20:01:00.000Z', received_at: '2026-10-27T20:01:30.000Z' }] });
});

test('rithmicStatus is empty when no candles were ever stored, and ignores a malformed contract name', async () => {
  assert.deepEqual(await rithmicStatus(fakeStorage()), { symbols: [] });
  const storage = fakeStorage([['rithmic_1m_index:not-a-contract', ['2026-10-27T20']]]);
  assert.deepEqual(await rithmicStatus(storage), { symbols: [] });
});

test('"Replay my last trade" is left to the evidence route, not answered as a status', () => {
  assert.equal(tradingStatusIntent('Replay my last trade'), null);
});

test('"Place a paper trade" with no market asks which one; it is never a ticker lookup', async () => {
  const { tradingIntent } = await import('./trading_lab.js');
  const intent = tradingIntent('Place a paper trade, not live.');
  assert.equal(intent.kind, 'clarify');
  assert.match(intent.question, /Which market should I paper trade/);
});
