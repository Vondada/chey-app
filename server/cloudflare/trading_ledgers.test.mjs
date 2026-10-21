// Trade records by name (owner, 2026-10-20). Before this, "what was the last trade the simulator
// took" reached the language model, which invented sim-2023-03-10-001, paper-2023-02-20-001,
// storage keys named simulation_trades and journal_trades, 2023 dates and profits. Every answer
// here comes from the real record sets through the real /api/chat, offline, with no model call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { LEDGER_SOURCE, LEDGERS, ledgerIntent, readLedgers, speakLedgers } from './trading_ledgers.js';
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

function journalTrade(i, { net = 25, strategy = 'fvg-retest-5m' } = {}) {
  const entry = `2026-10-${String(13 + Math.floor(i / 60)).padStart(2, '0')}T15:${String(i % 60).padStart(2, '0')}:00.000Z`;
  return {
    environment: 'paper', source: 'paper', portfolio: `${strategy}|any@version1`, strategy, filter: 'any', params: { target_r: 2 },
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
  // The dashboard fields: per-strategy rows, feed health and one equity curve per set, each in its own unit.
  assert.equal(simL.equity.unit, 'R');
  assert.equal(simL.equity.trades, 172);
  assert.ok(simL.equity.points.length <= 240 && simL.equity.points.length >= 2);
  assert.equal(simL.equity.points[simL.equity.points.length - 1].v, Math.round(sim.reduce((a, t) => a + t.r, 0) * 1000) / 1000);
  assert.equal(simL.by_strategy.length, 10);
  // One unit for the owner: the headline and the rows both say percent, and a strategy with no trade says nothing.
  assert.equal(simL.best.win_rate, simL.by_strategy[0].win_rate);
  assert.ok(simL.best.win_rate > 1 && simL.best.win_rate <= 100);
  assert.ok(simL.by_strategy.filter((r) => r.trades === 0).every((r) => r.win_rate === null && r.expectancy_r === null));
  assert.deepEqual(simL.feeds.map((f) => f.symbol), ['BTCUSDT', 'ETHUSDT', 'MNQ']);
  assert.equal(journal.equity.unit, '$');
  assert.equal(journal.equity.trades, 81);
  assert.ok(journal.by_strategy[0].trades === 81 && journal.by_strategy[0].name);
  assert.equal(ledgers[4].equity, null);
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

// Owner, 2026-10-20: after the iPhone update the EMA strategy comparison still answered "The sample rules,
// sir", because "out-of-sample" (a metric the owner asked for) was read as a sample-rule question and
// "forward-paper" with a hyphen was not recognized. EMA_QUESTION is the comparison under test.
const EMA_QUESTION = 'Compare the EMA strategies in forward-paper trading on MNQ: which one performs best, with win rate, profit factor and out-of-sample expectancy for each?';
test('the EMA strategy comparison is answered strategy by strategy from the forward-paper records, never with the sample rules', async () => {
  const saved = new Map();
  for (let i = 0; i < 6; i += 1) { const t = journalTrade(i, { strategy: 'ema-pullback-5m', net: i % 3 === 2 ? -20 : 25 }); saved.set(`${RECORD_PREFIX}paper:${t.portfolio}:${t.entry.time}`, t); }
  for (let i = 6; i < 10; i += 1) { const t = journalTrade(i, { strategy: 'fvg-retest-5m', net: 25 }); saved.set(`${RECORD_PREFIX}paper:${t.portfolio}:${t.entry.time}`, t); }
  const che = await owner({ saved });
  const out = await che.say(EMA_QUESTION);
  assert.equal(out.route, LEDGER_SOURCE);
  assert.equal(out.modelCalls, 0);
  assert.equal(out.done.kind, 'strategies');
  assert.doesNotMatch(out.reply, /sample rules/i, 'a requested metric is never taken for the main objective');
  assert.match(out.reply, /^Strategy by strategy, sir, from the forward paper journal, EMA strategies:/i);
  assert.match(out.reply, /1\. trend pullback to the 20 EMA \(any\): 6 trades, 4 won, 2 lost, win rate 66\.67%, expectancy 0\.9167 R per trade, net \$60\.00/);
  assert.doesNotMatch(out.reply, /fair value gap/i, 'only the EMA strategies the owner asked about');
  // Codex review of #379: the journal's profit factor is computed by summarize(), so it is reported, not called missing.
  assert.match(out.reply, /net \$60\.00, profit factor 2\.5/);
  assert.match(out.reply, /Not recorded for this set, so not reported: out-of-sample results\./);
  // The same question without a hyphen, and the plain sample-rule question still keeps its own answer.
  const spaced = await che.say(EMA_QUESTION.replace('forward-paper', 'forward paper'));
  assert.equal(spaced.done.kind, 'strategies');
  for (const q of ['Rank the EMA strategies by profit factor.', 'How do your EMA strategies stack up?']) assert.equal((await che.say(q)).done.kind, 'strategies', q);
  const rule = await che.say('How many out-of-sample trades do you need before you rank a strategy?');
  assert.match(rule.reply, /sample rules/);
});

// Owner, 2026-10-20: this exact question fell to the model, which failed with "I couldn't complete that
// request just now, sir" (che_errors retryable_provider_error / temporary_cloud_unavailable): no route read
// the journal. Now it is answered from the forward paper journal, by session and across the two variants.
const SESSION_OVERLAP_QUESTION = "Compare EMA Pullback's New York morning versus overnight performance and determine whether the any and trend variants contain identical trades.";
function emaTrade(entry, { filter = 'any', net = 25, side = 'long', exit = null } = {}) {
  return {
    environment: 'paper', source: 'paper', portfolio: `ema-pullback-5m|${filter}@version1`, strategy: 'ema-pullback-5m', filter, params: { target_r: 2 },
    side, contract: 'MNQ', qty: 1, entry: { time: entry, raw: 20000, fill: 20000.5 }, stop: 19990, target: 20020,
    exit: { time: exit || entry.replace(/:00\.000Z$/, ':30.000Z'), fill: net > 0 ? 20020 : 19990, reason: net > 0 ? 'target' : 'stop' }, net_pnl: net, r_net: net > 0 ? 1.9 : -1.05,
    costs: { spread: 0.5, slippage: 0.5, commissions: 0.62, fees: 0.3 }, data: { label: 'DELAYED', resolution: '5m' },
  };
}
test('the EMA Pullback session and variant-overlap question is answered from the journal, counting shared entries once', async () => {
  const saved = new Map();
  const put = (t) => saved.set(`${RECORD_PREFIX}paper:${t.portfolio}:${t.entry.time}`, t);
  // New York morning (14:00-16:00 UTC = 10:00-12:00 ET in October) and overnight (02:00 UTC = 22:00 ET).
  const morning = ['2026-10-14T14:05:00.000Z', '2026-10-14T15:10:00.000Z', '2026-10-15T14:20:00.000Z'];
  const overnight = ['2026-10-15T02:05:00.000Z', '2026-10-16T02:35:00.000Z'];
  morning.forEach((at, i) => put(emaTrade(at, { net: i === 2 ? -20 : 25 })));
  overnight.forEach((at) => put(emaTrade(at, { net: -20 })));
  // The trend variant took two of the same morning entries (identical) and one entry of its own.
  put(emaTrade(morning[0], { filter: 'trend' }));
  put(emaTrade(morning[1], { filter: 'trend' }));
  put(emaTrade('2026-10-16T15:00:00.000Z', { filter: 'trend', net: 25 }));
  const before = [...saved.keys()].length;
  const che = await owner({ saved });
  const out = await che.say(SESSION_OVERLAP_QUESTION);
  assert.equal(out.route, 'che_trading_analysis');
  assert.equal(out.modelCalls, 0);
  assert.doesNotMatch(out.reply, /couldn't complete/);
  assert.match(out.reply, /Recorded: 8 closed trades across 2 variants \(any, 2R target: 5; trend, 2R target: 3\), which are 6 distinct market entries\./);
  // Unique entries only: morning has 4 distinct entries (3 any + 1 trend-only), overnight 2.
  assert.match(out.reply, /New York morning \(9:30 AM to 1:00 PM ET\): 4 trades: 3 won, 1 lost, net \$55\.00, expectancy 1\.1625 R per trade \(sample of 4/);
  assert.match(out.reply, /overnight \(4:00 PM to 9:30 AM ET[^)]*\): 2 trades: 0 won, 2 lost, net minus \$40\.00, expectancy -1\.05 R per trade/);
  assert.match(out.reply, /any, 2R target alone: 3 trades: 2 won, 1 lost/);
  assert.match(out.reply, /2 identical market entries \(same side and entry bar\), 2 of them with the same exit too; 3 only in the first, 1 only in the second\. Partly:/);
  assert.match(out.reply, /never added together/);
  assert.equal([...saved.keys()].length >= before, true, 'no paper trade was removed');
});

test('the earlier EMA comparison and the new session question each keep their own route', async () => {
  const che = await owner();
  assert.equal((await che.say(EMA_QUESTION)).route, LEDGER_SOURCE);
  assert.equal((await che.say(SESSION_OVERLAP_QUESTION)).route, 'che_trading_analysis');
});

// The owner's exact questions, 2026-10-20 (typed on the iPhone after #379 was merged).
const OWNER_Q1 = 'CHE, analyze your EMA Pullback 5-minute strategy from your actual forward-paper trading ledger. Compare it against every other MNQ strategy. Show the number of trades, wins, losses, net profit, profit factor, expectancy, maximum drawdown, and out-of-sample results where available. Tell me if EMA is truly the most profitable or only has the most recent winning trades. Use real records, not guesses.';
const OWNER_Q2 = 'CHE, show the performance of your EMA Pullback strategy during New York morning trading versus overnight trading. Show actual wins, losses, net profit, and expectancy for each session. Also tell me whether the EMA any and trend versions contain the same trades';
function ownerLedger() {
  const saved = new Map();
  const put = (t) => saved.set(`${RECORD_PREFIX}paper:${t.portfolio}:${t.entry.time}`, t);
  // EMA Pullback (any): three early losses overnight, then five newer New York morning wins.
  ['2026-10-14T02:05:00.000Z', '2026-10-14T02:35:00.000Z', '2026-10-15T03:05:00.000Z'].forEach((at) => put(emaTrade(at, { net: -20 })));
  const wins = ['2026-10-15T14:05:00.000Z', '2026-10-15T15:10:00.000Z', '2026-10-16T14:20:00.000Z', '2026-10-16T15:40:00.000Z', '2026-10-17T14:15:00.000Z'];
  wins.forEach((at) => put(emaTrade(at, { net: 25 })));
  // EMA Pullback (trend): two of the same entries and one of its own.
  put(emaTrade(wins[0], { filter: 'trend' })); put(emaTrade(wins[1], { filter: 'trend' })); put(emaTrade('2026-10-17T15:30:00.000Z', { filter: 'trend' }));
  // Fair value gap retest: ten wins, more net profit than EMA.
  for (let i = 0; i < 10; i += 1) put(journalTrade(i, { strategy: 'fvg-retest-5m', net: 25 }));
  return saved;
}
test('owner question 1, exact words: EMA against every other MNQ strategy, with an honest verdict from the records', async () => {
  const saved = ownerLedger();
  const keys = [...saved.keys()];
  // Real newPortfolio() keys are candidate|filter@version. An earlier synthetic
  // candidate|filter|target fixture concealed a production recency bug (PR #380).
  assert.ok([...saved.values()].every((t) => /^[-\w]+\|(?:any|trend)@version1$/.test(t.portfolio)));
  const journal = (await readLedgers(storageFor(saved))).find((l) => l.id === 'forward_paper_journal');
  const any = journal.by_strategy.find((r) => r.strategy === 'ema-pullback-5m' && r.filter === 'any');
  assert.deepEqual({ recent: any.recent_trades, recentNet: any.recent_net, earlier: any.earlier_trades, earlierNet: any.earlier_net },
    { recent: 5, recentNet: 125, earlier: 3, earlierNet: -60 });
  const che = await owner({ saved });
  const out = await che.say(OWNER_Q1);
  assert.equal(out.route, LEDGER_SOURCE);
  assert.equal(out.modelCalls, 0);
  assert.equal(out.done.kind, 'strategies');
  assert.doesNotMatch(out.reply, /sample rules|couldn't complete/i);
  assert.match(out.reply, /fair value gap retest \(any\): 10 trades, 10 won, 0 lost/, 'every other strategy is listed, not only EMA');
  assert.match(out.reply, /\[asked about\] trend pullback to the 20 EMA \(any\): 8 trades, 5 won, 3 lost, win rate 62\.5%, expectancy [-\d.]+ R per trade, net \$65\.00, profit factor 2\.08, maximum drawdown \$\d+\.\d\d/);
  assert.match(out.reply, /Not recorded for this set, so not reported: out-of-sample results\./);
  assert.match(out.reply, /trend pullback to the 20 EMA \(any\) ranks 3 of 3 by net P&L/);
  assert.match(out.reply, /under the 30-trade minimum, so "most profitable" is not established/);
  assert.match(out.reply, /Its newest 5 trades made \$125\.00; its 3 earlier trades made minus \$60\.00\. So its profit rests on its most recent winning trades/);
  assert.match(out.reply, /The highest net P&L here is fair value gap retest \(any\) at \$250\.00\./);
  assert.match(out.reply, /never added together/);
  assert.deepEqual([...saved.keys()].filter((k) => k.startsWith(RECORD_PREFIX)), keys.filter((k) => k.startsWith(RECORD_PREFIX)), 'paper trades are preserved');
});
test('owner question 2, exact words: EMA Pullback New York morning versus overnight, and whether any and trend share trades', async () => {
  const che = await owner({ saved: ownerLedger() });
  const out = await che.say(OWNER_Q2);
  assert.equal(out.route, 'che_trading_analysis');
  assert.equal(out.modelCalls, 0);
  assert.match(out.reply, /Recorded: 11 closed trades across 2 variants \(any, 2R target: 8; trend, 2R target: 3\), which are 9 distinct market entries\./);
  assert.match(out.reply, /New York morning \(9:30 AM to 1:00 PM ET\): 6 trades: 6 won, 0 lost, net \$150\.00, expectancy 1\.9 R per trade/);
  assert.match(out.reply, /overnight \([^)]*\): 3 trades: 0 won, 3 lost, net minus \$60\.00, expectancy -1\.05 R per trade/);
  assert.match(out.reply, /2 identical market entries \(same side and entry bar\), 2 of them with the same exit too; 6 only in the first, 1 only in the second\. Partly/);
});
