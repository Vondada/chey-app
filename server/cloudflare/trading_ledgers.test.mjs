// Trade records by name (owner, 2026-10-20). Before this, "what was the last trade the simulator
// took" reached the language model, which invented sim-2023-03-10-001, paper-2023-02-20-001,
// storage keys named simulation_trades and journal_trades, 2023 dates and profits. Every answer
// here comes from the real record sets through the real /api/chat, offline, with no model call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { LEDGERS, ledgerIntent, readLedgers, speakLedgers } from './trading_ledgers.js';
import { SIM_STRATEGIES, STATE_KEY, TRADE_CHUNK } from './strategy_sim.js';
import { RECORD_PREFIX } from './trading_evidence.js';

globalThis.fetch = async (input) => { throw new TypeError(`fetch failed (offline test: ${new URL(String(input?.url || input)).host})`); };

const generated = new URL('./.trading_ledgers.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

function storageFor(saved) {
  return {
    get: async (key) => {
      if (Array.isArray(key)) return new Map(key.filter((k) => saved.has(k)).map((k) => [k, structuredClone(saved.get(k))]));
      return saved.has(key) ? structuredClone(saved.get(key)) : undefined;
    },
    put: async (key, value) => {
      if (typeof key === 'object' && key) for (const [k, v] of Object.entries(key)) saved.set(k, structuredClone(v));
      else saved.set(key, structuredClone(value));
    },
    delete: async (key) => saved.delete(key),
    deleteAll: async () => saved.clear(),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

// ─── Fixtures: the real record shapes, seeded straight into storage ───────

const FAKE = 'I retrieved the records from storage key simulation_trades. The most profitable simulation trade was sim-2023-03-10-001 on 2023-03-10: BTCUSDT breakout, +$412.50. From journal_trades, paper-2023-02-20-001 made +$180 on 2023-02-20. I also ran the lookup tool successfully.';

function simTrade(i, { strategy = SIM_STRATEGIES[0].id, symbol = 'BTCUSDT', r = 0.5 } = {}) {
  const t = `2026-10-19T14:${String(10 + i).padStart(2, '0')}:00.000Z`;
  return {
    id: `${strategy}|${symbol}|${t}`, strategy, symbol, label: 'Bitcoin', params: { signal: 'breakout', trend_filter: 'sma50', target_r: 2 }, why: 'test',
    signal_t: t, signal_price: 100, entry_t: t, entry_raw: 100, entry: 100.1, stop: 99, target: 102, feed: 'LIVE',
    exit_t: t, exit_raw: r > 0 ? 102 : 99, exit: r > 0 ? 101.9 : 98.9, exit_reason: r > 0 ? 'target' : 'stop', r_gross: r > 0 ? 2 : -1, r, cost_r: 0.1,
  };
}

function seedSim(saved, n, { strategies = [SIM_STRATEGIES[0].id] } = {}) {
  const trades = Array.from({ length: n }, (_, i) => simTrade(i, { strategy: strategies[i % strategies.length], r: i % 3 === 2 ? -1 : 0.6 }));
  const chunks = [];
  for (let i = 0; i < trades.length; i += TRADE_CHUNK) chunks.push(trades.slice(i, i + TRADE_CHUNK));
  chunks.forEach((chunk, c) => saved.set(`strategy_sim_trades:${c}`, chunk));
  saved.set(STATE_KEY, {
    version: 1, paused: false, last_tick: '2026-10-19T14:40:00.000Z', ticks: 40, symbols: { BTCUSDT: { first_t: '2026-10-19T13:00:00.000Z', oos_from: '2026-10-19T14:00:00.000Z', last_t: '2026-10-19T14:40:00.000Z', bars: 100 } },
    open: {}, pending: {}, counts: { bars: 100, not_filled: 0, expired: 0, errors: 0 },
    trades: { first: 0, last: chunks.length - 1, tail: chunks[chunks.length - 1]?.length || 0, stored: n, dropped: 0 },
    spend: { ceiling_usd: 0, day: null, spent_usd: 0 },
  });
  return trades;
}

function journalTrade(i, { net = 25 } = {}) {
  const entry = `2026-10-${String(13 + Math.floor(i / 60)).padStart(2, '0')}T15:${String(i % 60).padStart(2, '0')}:00.000Z`;
  return {
    environment: 'paper', source: 'paper', portfolio: 'fvg-retest-5m|any|2', strategy: 'fvg-retest-5m', filter: 'any', params: { target_r: 2 },
    side: 'long', contract: 'MNQ', qty: 1, session: 'ny', entry: { time: entry, raw: 20000, fill: 20000.5 }, stop: 19990, target: 20020,
    exit: { time: entry, fill: net > 0 ? 20020 : 19990, reason: net > 0 ? 'target' : 'stop' }, net_pnl: net, r_net: net > 0 ? 1.9 : -1.05,
    costs: { spread: 0.5, slippage: 0.5, commissions: 0.62, fees: 0.3 }, data: { label: 'DELAYED', resolution: '5m' },
  };
}

function seedJournal(saved, n) {
  for (let i = 0; i < n; i += 1) {
    const t = journalTrade(i, { net: i % 4 === 3 ? -20 : 25 });
    saved.set(`${RECORD_PREFIX}paper:${t.portfolio}:${t.entry.time}`, t);
  }
}

async function owner({ saved = new Map(), model = () => FAKE } = {}) {
  const counter = { calls: 0 };
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async (_m, input) => { counter.calls += 1; return { response: model(input) }; } } };
  const state = new CheState({ storage: storageFor(saved) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '', method = 'POST') => worker.fetch(new Request(`https://che.example${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const say = async (message) => {
    const before = counter.calls;
    const raw = await (await send('/api/chat', { message, history: [] }, token)).text();
    const events = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const done = events.find((e) => e.type === 'done') || {};
    return { reply: events.filter((e) => e.type === 'delta').map((e) => e.delta).join(''), done, route: done.source || (counter.calls > before ? 'model' : 'none'), modelCalls: counter.calls - before };
  };
  const get = async (path, auth = token) => { const res = await send(path, null, auth, 'GET'); return { status: res.status, body: await res.json() }; };
  return { say, get, saved, counter, env };
}

// ─── The question ─────────────────────────────────────────────────────────

test('the owner\'s record questions name their ledger and kind; other trading turns keep their routes', () => {
  const table = [
    ['What was the last trade the simulator took?', 'last', ['strategy_simulation']],
    ["Show me the simulator's best strategy so far.", 'best', ['strategy_simulation']],
    ['Which trade in your strategy simulation was the most profitable, and what did the paper journal show that day?', 'best', ['strategy_simulation', 'forward_paper_journal']],
    ['How many trades have the simulation and the paper journal made so far?', 'count', ['strategy_simulation', 'forward_paper_journal']],
    ['Why does the simulation show 172 trades but the paper journal only 81?', 'compare', ['strategy_simulation', 'forward_paper_journal']],
    ['Read me the newest entry in your paper trading journal.', 'last', ['forward_paper_journal']],
    ['Is 100 trades the sample you need before you call a strategy profitable?', 'rule', []],
    ['Pull the record for sim-2023-03-10-001.', 'record', []],
    ['Which storage key holds the simulation trades?', 'storage', ['strategy_simulation']],
    ['What settings did your most profitable strategy use?', 'settings', []],
    ['What is your last trade?', 'last', []],
  ];
  for (const [message, kind, named] of table) {
    const got = ledgerIntent(message);
    assert.ok(got, message);
    assert.equal(got.kind, kind, message);
    assert.deepEqual(got.named, named, message);
  }
  assert.equal(ledgerIntent('Pull the record for sim-2023-03-10-001.').record_id, 'sim-2023-03-10-001');
  for (const other of [
    'How many paper trades have you won and lost?', 'Which trading strategy is performing best?', 'How is the simulation doing?', 'Strategy simulation status',
    'Pause the strategy simulation', 'Switch to simulation mode', 'Buy 1 MNQ at market', 'How are the trades doing?', 'Check my Alpaca paper orders',
    'Tell me a story about a trader whose journal was lost', 'Fix the bug in the simulation code', 'Ask Claude which strategy is best', 'What is the weather?',
    // Review of PR #373: "record", "position" and a bare "journal" are not trading words.
    'Do you have a record of my dentist appointment?', 'What is the record for the most home runs in a season?', 'How many records do you have about me?',
    'Where do you store your records?', 'What was your last position at the company?', 'Pull up the record of the meeting with Dr. Smith.',
    'Read me your last journal entry.', 'When does my Amazon order order-2026-10-18-0042 ship?', 'is my sample size of 30 trades enough to trust the results',
    'what settings should I use for my best strategy', 'explain the database of trades', 'What is your best profit tip?', 'What is your best idea for profit?',
  ]) assert.equal(ledgerIntent(other), null, other);
});

// ─── The records ──────────────────────────────────────────────────────────

test('empty storage reads as "none recorded" for every record set, never as a number or a record', async () => {
  const ledgers = await readLedgers(storageFor(new Map()));
  assert.deepEqual(ledgers.map((l) => l.id), LEDGERS.map((l) => l.id));
  assert.deepEqual(ledgers.map((l) => l.trades), [0, 0, 0, 0, null]);
  assert.ok(ledgers.every((l) => !l.unavailable && !l.newest));
  const said = speakLedgers(ledgerIntent('What is your last trade?'), ledgers);
  assert.match(said, /no closed trade recorded yet/);
  assert.doesNotMatch(said, /2023|\$\d|sim-|paper-\d/);
});

test('the simulation and the journal are counted separately, each with its own newest and best, never summed', async () => {
  const saved = new Map();
  const sim = seedSim(saved, 172, { strategies: [SIM_STRATEGIES[0].id, SIM_STRATEGIES[1].id] });
  seedJournal(saved, 81);
  const ledgers = await readLedgers(storageFor(saved));
  const [simL, journal] = ledgers;
  assert.equal(simL.trades, 172);
  assert.equal(journal.trades, 81);
  assert.equal(simL.newest.id, sim[171].id);
  assert.equal(journal.newest.strategy, 'fvg-retest-5m');
  assert.ok(simL.best && simL.best.trades > 0);
  assert.equal(journal.best.trades, 81);
  const said = speakLedgers(ledgerIntent('Why does the simulation show 172 trades but the paper journal only 81?'), ledgers);
  assert.match(said, /strategy simulation \(.*\): 172 trades stored/);
  assert.match(said, /forward paper journal \(.*\): 81 trades journalled/);
  assert.match(said, /never summed/);
  assert.doesNotMatch(said, /253/);
  const settings = speakLedgers(ledgerIntent('What settings did your most profitable strategy use?'), ledgers);
  const s0 = SIM_STRATEGIES.find((x) => x.id === ledgers[0].best.strategy);
  assert.match(settings, new RegExp(`Settings: signal ${s0.signal}, trend_filter ${s0.trend_filter}, target_r ${s0.target_r}`));
  assert.match(settings, /Settings: target_r 2, filter any/);
});

test('a record id a model invented is reported as absent; the real keys and the 30-trade rule are named', async () => {
  const saved = new Map();
  seedSim(saved, 3);
  const ledgers = await readLedgers(storageFor(saved));
  const missing = speakLedgers(ledgerIntent('Pull the record for sim-2023-03-10-001.'), ledgers);
  assert.match(missing, /No record named sim-2023-03-10-001 exists/);
  assert.match(missing, /strategy_sim_trades/);
  const keys = speakLedgers(ledgerIntent('Which storage key holds the simulation trades?'), ledgers);
  assert.match(keys, /strategy_sim_state, strategy_sim_trades:<chunk number>/);
  assert.match(keys, /nothing is named simulation_trades or journal_trades/);
  const rule = speakLedgers(ledgerIntent('Is 100 trades the sample you need before you call a strategy profitable?'), ledgers);
  assert.match(rule, /30 out-of-sample trades/);
  assert.match(rule, /no 100-trade requirement/);
});

test('a record set that cannot be read says so and gives no number; the others still answer', async () => {
  const saved = new Map();
  seedJournal(saved, 2);
  const storage = storageFor(saved);
  const realGet = storage.get;
  storage.get = async (key) => { if (key === STATE_KEY) throw new Error('storage read failed'); return realGet(key); };
  const ledgers = await readLedgers(storage);
  assert.equal(ledgers[0].unavailable, true);
  assert.equal(ledgers[0].trades, null);
  assert.equal(ledgers[1].trades, 2);
  const said = speakLedgers(ledgerIntent('How many trades have the simulation and the paper journal made so far?'), ledgers);
  assert.match(said, /strategy simulation: I could not read it just now, so I give no number/);
  assert.doesNotMatch(said, /storage read failed/, 'the exception text is not spoken');
  assert.equal(ledgers[0].error, 'storage read failed');
  assert.match(said, /2 trades journalled/);
});

// ─── Through the real chat route ──────────────────────────────────────────

test('the owner\'s exact questions are answered from the records with no model call and no invented record', async () => {
  const saved = new Map();
  seedSim(saved, 172);
  seedJournal(saved, 81);
  const che = await owner({ saved });
  for (const message of [
    'Which trade in your strategy simulation was the most profitable, and what did the paper journal show that day?',
    'How many trades have the simulation and the paper journal made so far?',
    'What was the last trade the simulator took?',
    "Show me the simulator's best strategy so far.",
    'Is 100 trades the sample you need before you call a strategy profitable?',
    'Pull the record for sim-2023-03-10-001.',
    'Which storage key holds the simulation trades?',
    'What settings did your most profitable strategy use?',
    'Read me the newest entry in your paper trading journal.',
  ]) {
    const out = await che.say(message);
    assert.equal(out.route, 'che_trading_ledgers', message);
    assert.equal(out.modelCalls, 0, message);
    assert.doesNotMatch(out.reply, /paper-2023|\$412|\$180|lookup tool/, message);
    // The invented key names appear only in the denial that nothing is named that way.
    if (/simulation_trades|journal_trades/.test(out.reply)) assert.match(out.reply, /nothing is named simulation_trades or journal_trades/, message);
    // The asked-for id is echoed only to say it does not exist; no other 2023 date appears anywhere.
    if (/sim-2023/.test(message)) assert.match(out.reply, /No record named sim-2023-03-10-001 exists/);
    else assert.doesNotMatch(out.reply, /2023/, message);
  }
  const count = await che.say('How many trades have the simulation and the paper journal made so far?');
  assert.match(count.reply, /172 trades stored/);
  assert.match(count.reply, /81 trades journalled/);
  assert.deepEqual(count.done.ledgers.slice(0, 2), [{ id: 'strategy_simulation', trades: 172, unavailable: false }, { id: 'forward_paper_journal', trades: 81, unavailable: false }]);
  assert.equal(che.counter.calls, 0);
});

test('the existing trading routes keep their turns, and a guest cannot read the records', async () => {
  const che = await owner();
  assert.equal((await che.say('How many paper trades have you won and lost?')).route, 'che_trading_live');
  assert.equal((await che.say('How is the simulation doing?')).route, 'che_strategy_sim');
  assert.equal((await che.say('Pause the strategy simulation')).route, 'che_strategy_sim');
  assert.equal((await che.say('How are the trades doing?')).route, 'che_trading');
  const ledgers = await che.get('/api/trading/ledgers');
  assert.equal(ledgers.status, 200);
  assert.equal(ledgers.body.separate, true);
  assert.deepEqual(ledgers.body.ledgers.map((l) => l.id), LEDGERS.map((l) => l.id));
  assert.equal((await che.get('/api/trading/ledgers', '')).status, 401);
  const unpaired = await worker.fetch(new Request('https://che.example/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'What was the last trade the simulator took?', history: [] }) }), che.env);
  assert.equal(unpaired.status, 401);
});

test('a question with no ledger named that the model would have invented an answer to reads every record set', async () => {
  const che = await owner();
  const out = await che.say('What is your last trade?');
  assert.equal(out.route, 'che_trading_ledgers');
  assert.equal(out.modelCalls, 0);
  assert.match(out.reply, /Separate record sets, sir/);
  assert.match(out.reply, /strategy simulation \(/);
  assert.match(out.reply, /forward paper journal \(/);
  assert.match(out.reply, /no closed trade recorded yet/);
});
