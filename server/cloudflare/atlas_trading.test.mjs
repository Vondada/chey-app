// Knowledge Atlas trading cards and calculations (issue #346, trading lane). The cards are checked
// as data (every field the owner asked for, honest limitations), the numbers in their text are
// recomputed, every number from a record carries its provenance, and the owner's phrasings are
// asked through the real /api/chat, typed and spoken, with the counter-cases that must keep their
// own routes. No lesson or calculation reaches a broker, places an order or changes the desk.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';
import { ATLAS_TRADING_CARDS, PROVENANCE, TRADING_FORMULAS, provenanceText, tradingAtlasIntent } from './atlas_trading.js';
import { costInR, maxDrawdown, num, premiumDiscount, riskOfRuin, sampleSizeForMargin, vwapBands } from './atlas_math.js';
import { ATLAS_CARDS, FORMULAS, LEVELS, atlasCard, atlasExport, atlasIntent, findAtlasCard } from './knowledge_atlas.js';
import { COSTS, CONTRACTS, MIN_TRADES, summarize, wilsonInterval } from './trading_evidence.js';
import { readDesk } from './trading_desk.js';
import { LIVE_BACKTEST, LIVE_FEED, LIVE_STATE } from './trading_live.js';

const generated = new URL('./.atlas_trading.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

// Offline, and every outbound request is counted: a broker call would show up here.
const requests = [];
globalThis.fetch = async (input) => {
  requests.push(String(input?.url || input));
  throw new TypeError('fetch failed (atlas_trading tests are offline)');
};

function storageFor(saved) {
  return {
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

async function owner({ saved = new Map() } = {}) {
  let calls = 0;
  const pending = [];
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async () => { calls += 1; return { response: 'MODEL ANSWERED' }; } },
  };
  const state = new CheState({ storage: storageFor(saved), waitUntil: (p) => pending.push(p) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const say = async (message, { history = [] } = {}) => {
    const before = calls;
    const res = await send('/api/chat', { message, history }, token);
    const raw = await res.text();
    while (pending.length) await pending.shift();
    let held = null;
    try { held = JSON.parse(raw); } catch (_) { held = null; }
    const events = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const done = events.find((e) => e.type === 'done') || {};
    const route = held?.held_for_owner ? 'held' : done.source || (calls > before ? 'model' : 'none');
    return { route, done, reply: held?.message || replyFromNdjson(raw), modelCalls: calls - before };
  };
  return { say, saved };
}

const spoken = (text) => text.replace(/[.,?!:]/g, '').replace(/'/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const variants = (phrase) => [phrase, spoken(phrase), `CHE, ${phrase}`, `hey che ${spoken(phrase)}`];
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// The trading records that must never change during a lesson or a calculation.
const TRADING_KEYS = (saved) => Object.fromEntries([...saved.entries()].filter(([k]) => /^(?:trading_desk|live_paper_|evr:|trading_paper_book|evidence_)/.test(k)).map(([k, v]) => [k, JSON.stringify(v)]));

// Closed paper trades in the journal's shape (trading_evidence.js), keyed as appendTrades keys them.
function journal(rows, { side = 'long', targetR = 3, strategy = 'fvg-retest-5m', from = '2026-10-15T14:00:00Z' } = {}) {
  return rows.map((r, i) => {
    const time = new Date(Date.parse(from) + i * 300_000).toISOString();
    const entry = 21000;
    const stop = side === 'short' ? entry + 10 : entry - 10;
    return {
      environment: 'paper', source: 'paper', portfolio: `${strategy}|any|${targetR}`, symbol: 'MNQ=F', contract: 'MNQ', strategy, side, session: 'mid-morning',
      entry: { time, fill: entry, raw: entry }, exit: { time, reason: r > 0 ? 'target' : 'stop', fill: entry + r * 10 }, stop, target: side === 'short' ? entry - 10 * targetR : entry + 10 * targetR,
      qty: 1, net_pnl: r * 20, r_net: r, params: { target_r: targetR },
      costs: { spread: 0.5, slippage: 1, commissions: 3, fees: 1 }, data: { resolution: '5m', label: 'intraday 5m bars, fills at the next open' },
    };
  });
}
const store = (trades, saved = new Map()) => { for (const t of trades) saved.set(`evr:paper:${t.portfolio}:${t.entry.time}`, t); return saved; };

// ─── The cards ────────────────────────────────────────────────────────────

const ICT = ['t-price-action', 't-market-structure', 't-liquidity', 't-fair-value-gaps', 't-order-blocks', 't-premium-discount', 't-session-levels'];

test('twenty trading-lane cards with every field the owner asked for', () => {
  assert.equal(ATLAS_TRADING_CARDS.length, 20);
  assert.deepEqual(ATLAS_TRADING_CARDS.map((c) => c.id), [
    't-futures', 't-order-types', 't-order-book', 't-stocks', 't-options', 't-price-action', 't-market-structure', 't-liquidity', 't-fair-value-gaps', 't-order-blocks',
    't-premium-discount', 't-session-levels', 't-opening-range', 't-vwap-bands', 't-journaling', 't-strategy-evaluation', 't-trades-needed', 't-backtesting-pitfalls', 't-monte-carlo', 't-risk-of-ruin',
  ]);
  for (const c of ATLAS_TRADING_CARDS) {
    assert.match(c.id, /^t-[a-z-]+$/, c.id);
    assert.equal(c.domain, 'trading');
    assert.ok(atlasCard(c.id) === c, `${c.id} is registered in the atlas`);
    // Definition, beginner and advanced explanations, analogy, formula, example, prerequisites, sources, limitations, practice questions.
    assert.ok(c.summary.length >= 30, `${c.id} definition`);
    for (const level of LEVELS) assert.ok(c.levels[level].length >= 120, `${c.id} ${level}`);
    assert.match(c.analogy, /\blike\b/);
    assert.ok(c.formula && TRADING_FORMULAS[c.formula.compute] && FORMULAS[c.formula.compute] === TRADING_FORMULAS[c.formula.compute], `${c.id} formula is computed by atlas_math.js`);
    assert.equal(c.example.kind, 'numeric');
    assert.equal(c.example.provenance, PROVENANCE.example, `${c.id}: the worked example is an educational example`);
    assert.equal(c.example.steps[0], 'Educational example, made-up numbers, not market data');
    assert.ok(Array.isArray(c.prerequisites) && c.prerequisites.length >= 1, `${c.id} prerequisites`);
    assert.ok(c.sources.length >= 2, `${c.id} sources`);
    assert.ok(c.limitations.length >= 1 && c.limitations.every((l) => l.length >= 40), `${c.id} limitations`);
    assert.ok(c.quiz.length >= 3, `${c.id} practice questions`);
    assert.ok(c.related.every((id) => atlasCard(id)), `${c.id} related`);
  }
  // Every trading card, the phase-1 ones too, now states its limitations, and the phone gets them.
  const exported = atlasExport().cards.filter((c) => c.domain === 'trading');
  assert.equal(exported.length, 30);
  for (const c of exported) assert.ok(c.limitations.length >= 1, `${c.id} limitations exported`);
});

test('ICT and SMC cards say their evidence is mixed or limited, and no card claims an edge', () => {
  for (const id of ICT) assert.match(atlasCard(id).limitations.join(' '), /mixed or limited evidence/, id);
  for (const c of ATLAS_TRADING_CARDS) {
    const text = [c.summary, ...Object.values(c.levels), c.analogy, c.che_note, ...c.limitations, ...c.quiz.map((q) => q.a)].join(' ');
    assert.doesNotMatch(text, /\b(?:proven edge|guaranteed|always works|high[- ]probability setup|reliable edge|risk[- ]free)\b/i, c.id);
    assert.doesNotMatch(text, /\btap\b/i, `${c.id}: never "tap here"`);
  }
});

test('the numbers written in the cards are the computed ones', () => {
  const s = sampleSizeForMargin({ margin: 0.05 }).value;
  assert.ok(atlasCard('t-trades-needed').levels.beginner.includes(`roughly ${s} trades`) && atlasCard('t-trades-needed').levels.beginner.includes(`about ${sampleSizeForMargin({ margin: 0.1 }).value}`));
  const pd = premiumDiscount({ low: 100, high: 200 }).value;
  assert.ok(atlasCard('t-premium-discount').levels.intermediate.includes(`62% is ${pd.ote62}, 70.5% is ${pd.ote705} and 79% is ${pd.ote79}`));
  const dd = maxDrawdown({ pnl: [200, -150, -250, 300, -100], start: 10000 }).value;
  assert.ok(atlasCard('t-journaling').levels.intermediate.includes(`$${dd.dollars}, or ${(dd.percent * 100).toFixed(2)}%`));
  // CHE's assumed MNQ round trip, from the engine's own costs: the spread once, slippage, commissions and fees on both sides.
  const tickValue = CONTRACTS.MNQ.tick * CONTRACTS.MNQ.pointValue;
  const roundTrip = COSTS.spreadTicks * tickValue + 2 * COSTS.slippageTicks * tickValue + 2 * COSTS.commissionPerSide + 2 * COSTS.feePerSide;
  const drag = costInR({ grossR: 0.15, roundTripCost: roundTrip, riskDollars: 40 }).value;
  const pit = atlasCard('t-backtesting-pitfalls').levels.intermediate;
  assert.ok(pit.includes(`about $${roundTrip.toFixed(2)}`) && pit.includes(`${drag.costR}R a trade`) && pit.includes(`+${drag.netR.toFixed(4)}R`), pit);
  const ruin = riskOfRuin({ winRate: 0.55, riskPerTrade: 1, account: 10, trades: 10, paths: 10 }).value.classic;
  assert.ok(atlasCard('t-risk-of-ruin').levels.intermediate.includes(`about ${(ruin * 100).toFixed(1)}%`));
  for (const sym of ['NQ', 'MNQ', 'ES', 'MES']) assert.ok(atlasCard('t-futures').levels.intermediate.includes(`${sym} $`) || atlasCard('t-futures').levels.intermediate.includes(`and ${sym} $`), sym);
  assert.ok(atlasCard('t-options').levels.intermediate.includes('risks $300 and is worth $1,000 at a stock price of $110, a $700 profit'));
});

test('every alias finds its own card, and lesson phrasings reach the cards', () => {
  for (const c of ATLAS_TRADING_CARDS) for (const a of c.aliases) assert.equal(findAtlasCard(a)?.id, c.id, a);
  assert.equal(atlasIntent('Teach me order blocks at expert level').card.id, 't-order-blocks');
  assert.equal(atlasIntent('Teach me order blocks at expert level').level, 'expert');
  assert.equal(atlasIntent('quiz me on fair value gaps').card.id, 't-fair-value-gaps');
  assert.equal(atlasIntent("what's the difference between BOS and CHOCH").kind, 't_compare');
  // Each card is reachable by its first name and its title, for a lesson and a quiz.
  for (const c of ATLAS_TRADING_CARDS) {
    for (const words of [`teach me ${c.aliases[0]}`, `quiz me on ${c.aliases[0]}`, `explain ${c.title}`, spoken(`CHE, teach me ${c.aliases[0]}`)]) assert.equal(atlasIntent(words)?.card?.id, c.id, words);
  }
  // Not lessons: a bare contract name, an everyday word, a market read.
  for (const words of ['what is mnq', 'What is a tick?', 'what is nq doing', 'What is the spread right now?', 'what is a contract', 'what is margin', 'what is an hour', 'what is volume', 'what is a journal', 'what is bootstrap', 'what is an index', 'what is the dom']) {
    assert.equal(atlasIntent(words), null, words);
  }
});

// ─── Provenance ───────────────────────────────────────────────────────────

test('five provenance labels; broker SIM and live orders say "no records" unless the desk holds one', () => {
  assert.deepEqual(Object.values(PROVENANCE), ['educational example', 'historical backtest', 'delayed forward-paper data', 'broker SIM', 'live orders']);
  const empty = provenanceText({ paper: [], backtest: null, desk: null });
  assert.equal(empty, 'Delayed forward-paper data: no recorded trades yet in CHE\'s paper journal. Historical backtest: no stored backtest with trades yet. Broker SIM: no records. Live orders: no records.');
  assert.doesNotMatch(empty, /\d/, 'no number without a record');
  const trades = journal([3, -1, -1, 3, -1]);
  const s = summarize(trades);
  const full = provenanceText({
    paper: trades,
    backtest: { ok: true, at: '2026-10-18T12:00:00Z', data: 'Yahoo MNQ=F, 1200 five-minute bars (DELAYED public data)', rows: [{ stats: { trades: 12, expectancy_r: -0.1 } }, { stats: { trades: 40, expectancy_r: 0.2 } }] },
    desk: { alerts: [{ mode: 'sim', status: 'placed' }, { mode: 'sim', status: 'failed' }, { mode: 'live', status: 'pending' }] },
  });
  assert.ok(full.includes(`Delayed forward-paper data, CHE's paper journal: 5 closed paper trades in 1 paper portfolio, one strategy. It is Fair value gap retest on MNQ, five-minute bars, 3R target: 5 trades, expectancy +${s.expectancy_r.toFixed(2)}R per trade after assumed costs.`), full);
  // Two portfolios are two records: the largest is named, and the others only bound a range.
  const two = provenanceText({ paper: [...trades, ...journal([-1, -1], { strategy: 'sweep-mss-5m', targetR: 2, from: '2026-10-17T14:00:00Z' })] });
  assert.match(two, /7 closed paper trades in 2 separate paper portfolios, each its own strategy, so nothing is pooled\. The largest is Fair value gap retest on MNQ, five-minute bars, 3R target: 5 trades, .* Across the 2 portfolios, expectancy ranged /);
  assert.ok(full.includes('Historical backtest, stored 2026-10-18, Yahoo MNQ=F, 1200 five-minute bars (DELAYED public data): 2 strategy portfolios with 52 trades; expectancy ranged −0.10R to +0.20R across them.'), full);
  assert.ok(full.includes('Broker SIM: 1 order record on the desk, with no recorded fills or results, so no statistics.'), 'a placed SIM order is counted, a failed one is not');
  assert.ok(full.includes('Live orders: no records.'), 'a pending live alert is not an order');
  assert.match(provenanceText({ paper: [], unreadable: true }), /could not read CHE's paper journal just now/);
});

// ─── Through /api/chat ────────────────────────────────────────────────────

async function calc(che, words) {
  const out = await che.say(words);
  assert.equal(out.route, 'che_knowledge_atlas', `${words} → ${out.route}: ${out.reply.slice(0, 160)}`);
  assert.equal(out.modelCalls, 0, words);
  assert.doesNotMatch(out.reply, /\btap\b/i);
  return out;
}

test('risk and size questions, typed and spoken, with the steps shown', async () => {
  const che = await owner();
  for (const words of [...variants('What is my risk on 2 MNQ contracts with a 12 point stop?'), 'what is my risk on two mnq contracts with a twelve point stop']) {
    const out = await calc(che, words);
    assert.match(out.reply, /^Your risk on 2 MNQ contracts with a 12-point stop is \$48\.00, sir\. I placed and prepared no order; this is a calculation\./);
    assert.ok(out.reply.includes('risk per contract = 12 points × $2.00 a point = $24.00; total risk = $24.00 × 2 contracts = $48.00'), out.reply);
    assert.match(out.reply, /before commissions and fees: you gave none, so none are assumed/);
    assert.match(out.reply, /from CME Group; verify against the exchange; specs can change/);
    assert.match(out.reply, /Source: Knowledge Atlas card "Index futures: NQ, MNQ, ES and MES" \(trading\), calculator futuresRisk in atlas_math\.js/);
  }
  for (const words of [...variants('How many MNQ contracts can I trade risking $200 with a 10 point stop?'), 'how many mnq contracts can i trade risking two hundred dollars with a ten point stop']) {
    const out = await calc(che, words);
    assert.match(out.reply, /^10 MNQ contracts, sir, risking \$200\.00 with a 10-point stop\./);
    assert.ok(out.reply.includes('$200.00 ÷ $20.00 = 10, rounded down = 10 contracts'), out.reply);
  }
  assert.match((await calc(che, 'How many NQ contracts can I trade risking $150 with a 10 point stop?')).reply, /^No NQ contract fits, sir.*one MNQ risks a tenth as much/s);
  assert.match((await calc(che, 'how many contracts can I trade risking $200 with a 10 point stop')).reply, /^Which contract, sir: MNQ, NQ, ES or MES\?/, 'no contract is assumed');
  assert.match((await calc(che, 'What is my risk on 3 MES with a 40 tick stop plus $2.50 commissions per side?')).reply, /is \$150\.00, or \$165\.00 with the costs you gave, sir/);
  assert.match((await calc(che, 'How many shares can I buy risking $100 with an entry at 50 and a stop at 48?')).reply, /^50 shares, sir, risking \$100\.00\./);
  assert.match((await calc(che, "What's the breakeven on a long call with a 100 strike and a $3 premium?")).reply, /breakeven 103\..*most it can lose = \$300\.00; most it can gain = unlimited/s);
  assert.match((await calc(che, 'How many trades do I need for a 5% margin on my win rate?')).reply, /^About 385 trades, sir/);
});

test('VWAP from the latest bars: only stored bars, with their source and time; none stored, none invented', async () => {
  const empty = await owner();
  for (const words of variants('Explain VWAP and calculate it from the latest bars.')) {
    const out = await calc(empty, words);
    assert.match(out.reply, /^VWAP, sir: VWAP, the volume-weighted average price, is the average price traded so far in the session/);
    assert.match(out.reply, /No price bar is stored yet, sir, so I can't calculate VWAP and I won't invent prices\./);
    assert.doesNotMatch(out.reply.replace(/Source:.*$/s, ''), /VWAP = /, 'no VWAP without bars');
    assert.equal(out.done.ok, false);
  }
  // Stored delayed paper-feed bars for Friday 2026-10-16: a pre-open bar, then the session from 9:30 New York (13:30 UTC).
  const bar = (t, h, l, c, v) => ({ t, o: c, h, l, c, v });
  const bars = [bar('2026-10-16T13:00:00Z', 200, 190, 195, 5000),
    bar('2026-10-16T13:30:00Z', 21010, 20990, 21000, 300), bar('2026-10-16T13:35:00Z', 21020, 21000, 21015, 200),
    bar('2026-10-16T13:40:00Z', 21030, 21010, 21025, 100), bar('2026-10-16T13:45:00Z', 21025, 21005, 21010, 400)];
  const feed = { status: 'DELAYED', provider: 'Yahoo Finance chart (public)', provider_symbol: 'MNQ=F', contract: 'MNQZ6', latency_s: 600, checked_at: '2026-10-16T13:55:00Z', bars };
  const che = await owner({ saved: new Map([[LIVE_FEED, feed]]) });
  // Independent: the session's typical prices repeated by volume, averaged.
  const session = bars.slice(1);
  const list = session.flatMap((b) => Array(b.v).fill((b.h + b.l + b.c) / 3));
  const mean = list.reduce((a, b) => a + b, 0) / list.length;
  const sd = Math.sqrt(list.reduce((a, b) => a + (b - mean) ** 2, 0) / list.length);
  for (const words of ['Calculate VWAP from the latest bars', 'CHE, calculate the vwap from the latest bars', 'whats the vwap right now']) {
    const out = await calc(che, words);
    assert.match(out.reply, /From stored bars only: delayed forward-paper data, DELAYED MNQ=F \(MNQZ6\) from Yahoo Finance chart \(public\), 5 bars from Oct 16, 9:00 AM New York time to Oct 16, 9:45 AM New York time, read at Oct 16, 9:55 AM New York time\./);
    assert.match(out.reply, /session: 2026-10-16, from the 9:30 New York open \(2026-10-16T13:30:00\.000Z\), 4 bars, session not finished in these bars/);
    assert.ok(out.reply.includes(`= ${num(mean, 4)}`), `VWAP ${mean}: ${out.reply}`);
    assert.ok(out.reply.includes(`σ = √(Σ volume × (typical price - VWAP)² ÷ Σ volume) = ${num(sd, 4)}`), out.reply);
    assert.ok(out.reply.includes(`2σ ${num(mean - 2 * sd, 2)} to ${num(mean + 2 * sd, 2)}`));
    assert.match(out.reply, /Delayed bars are research only, not execution prices\./);
  }
  assert.ok(close(vwapBands({ bars, anchor: 'rth' }).value.vwap, mean), 'the pre-open bar is not in the session VWAP');
  // Bars that start after the open: the 9:30 VWAP is refused, and the CME-day VWAP is labelled as what it is.
  const late = await owner({ saved: new Map([[LIVE_FEED, { ...feed, bars: bars.slice(2) }]]) });
  const out = await calc(late, 'Calculate VWAP from the latest bars');
  assert.match(out.reply, /No regular-hours VWAP: the bars for 2026-10-16 start at 2026-10-16T13:35:00Z, after the 9:30 New York open/);
  assert.match(out.reply, /Instead, VWAP of the CME day 2026-10-16 from its first stored bar at Oct 16, 9:35 AM New York time, not the 9:30 open: /);
  const or = await calc(che, 'Calculate the opening range from the latest bars');
  assert.match(or.reply, /Opening range, first 15 minutes after 9:30 New York time: .*high = 21,030, low = 20,990, range = 40 points/);
});

test('the win-rate interval and expectancy come from the paper journal, or "no recorded trades yet"', async () => {
  const empty = await owner();
  for (const words of variants("What's the confidence interval on my win rate?")) {
    const out = await calc(empty, words);
    assert.match(out.reply, /^No recorded trades yet, sir: CHE's paper journal \(delayed forward-paper data\) has no closed paper trades, so there is no win rate and no interval\./);
    assert.match(out.reply, /Broker SIM: no records\.\sLive orders: no records\./);
  }
  for (const words of [...variants('What is my expectancy?'), ...variants('Evaluate my strategy.')]) {
    const out = await calc(empty, words);
    assert.match(out.reply, /no recorded trades yet/);
    assert.match(out.reply, /Verdict: unsupported, because no closed trades\. Criteria: Good needs at least 30 closed trades/);
  }
  const trades = journal([3, -1, -1, 3, -1, -1, 3, -1, -1, -1, 3, -1]);
  const che = await owner({ saved: store(trades) });
  const s = summarize(trades);
  const w = wilsonInterval(s.wins, s.trades);
  const ci = await calc(che, "CHE, what's the confidence interval on my win rate?");
  assert.match(ci.reply, /^Your win rate's 95% Wilson interval, sir, one paper portfolio at a time, from delayed forward-paper data in CHE's paper journal: 12 closed paper trades in 1 paper portfolio, one strategy\./);
  assert.ok(ci.reply.includes(`1. Fair value gap retest on MNQ, five-minute bars, 3R target: ${s.wins} wins in ${s.trades}, ${(100 * w.low).toFixed(1)}% to ${(100 * w.high).toFixed(1)}%.`), ci.reply);
  assert.match(ci.reply, /The largest has fewer than the 30 trades needed, so it is anecdote, not evidence/);
  const e = await calc(che, 'what is my expectancy');
  assert.ok(e.reply.includes(`form 2: mean R = ${num(trades.reduce((a, t) => a + t.r_net, 0), 4)} ÷ ${trades.length} = +${s.expectancy_r.toFixed(2)}R; the two forms agree`), e.reply);
  assert.match(e.reply, /t for 11 degrees of freedom = 2\.201/);
  assert.match(e.reply, /It is Fair value gap retest on MNQ, five-minute bars, 3R target, n = 12\. Math: /);
  assert.match(e.reply, /Verdict for Fair value gap retest on MNQ, five-minute bars, 3R target: unsupported, because only 12 closed trades; 30 are the minimum/);
});

test('"Evaluate my strategy": good, bad and unsupported by the written criteria', async () => {
  const strong = journal(Array.from({ length: 40 }, (_, i) => (i % 2 ? 3 : -1)));
  const good = await calc(await owner({ saved: store(strong) }), 'Evaluate my strategy');
  assert.match(good.reply, /^Your strategies, judged one paper portfolio at a time, sir, from delayed forward-paper data in CHE's paper journal, after assumed costs: 40 closed paper trades in 1 paper portfolio, one strategy\./);
  assert.match(good.reply, /Verdict for Fair value gap retest on MNQ, five-minute bars, 3R target: good, because the 95% expectancy range is above zero and the profit factor 3 is above 1\.2/);
  assert.match(good.reply, /maximum drawdown \$\d+\.\d\d, or \d+\.\d\dR, within that portfolio's own record/, 'a drawdown is a magnitude, never +R');
  const weak = journal(Array.from({ length: 40 }, (_, i) => (i % 4 ? -1 : 1)));
  assert.match((await calc(await owner({ saved: store(weak) }), 'evaluate my strategy')).reply, /Verdict for Fair value gap retest on MNQ, five-minute bars, 3R target: bad, because the whole 95% expectancy range is below zero/);
  const mixed = journal(Array.from({ length: 40 }, (_, i) => (i % 3 ? -1 : 2.2)));
  assert.match((await calc(await owner({ saved: store(mixed) }), 'evaluate my strategy')).reply, /Verdict for Fair value gap retest on MNQ, five-minute bars, 3R target: unsupported, because the 95% expectancy range includes zero/);
  // Two strategies are judged one by one, never pooled into one verdict without saying so.
  const two = store([...strong, ...journal([3, -1, -1], { strategy: 'sweep-mss-5m', targetR: 2, from: '2026-10-17T14:00:00Z' })]);
  assert.match((await calc(await owner({ saved: two }), 'evaluate my strategy')).reply, /43 closed paper trades in 2 separate paper portfolios, each its own strategy, so nothing is pooled\..*Verdict for Fair value gap retest on MNQ, five-minute bars, 3R target: good,.*The other portfolios, each judged on its own: 2\. Liquidity sweep then market structure shift on MNQ, five-minute bars, 2R target: 3 trades, \+0\.33R a trade, unsupported\./s);
});

test('"Is this a good trade": the plan\'s math, what the records support, and an explicit verdict', async () => {
  const empty = await owner();
  for (const words of variants('Is this a good trade: long MNQ at 18000, stop 17990, target 18030?')) {
    const out = await calc(empty, words);
    assert.match(out.reply, /^Long MNQ at 18,000, stop 17,990, target 18,030, sir\. I placed and prepared no order; this is a calculation\./);
    assert.ok(out.reply.includes('reward to risk = 30 ÷ 10 = 3 to 1; in dollars on 1 MNQ: risk 10 × $2.00 × 1 = $20.00, reward 30 × $2.00 × 1 = $60.00; win rate needed to break even before costs = 10 ÷ (10 + 30) = 25.0%'), out.reply);
    assert.match(out.reply, /CHE's paper journal has no closed MNQ long trades planned near 3 to 1/);
    assert.match(out.reply, /Verdict: unsupported, because no recorded trade matches this setup\. Criteria: good needs every paper portfolio with at least 30 comparable recorded trades/);
  }
  const winners = journal(Array.from({ length: 36 }, (_, i) => (i % 2 ? 3 : -1)));
  const good = await calc(await owner({ saved: store(winners) }), 'is this a good trade long mnq at 18000 stop 17990 target 18030');
  const w = wilsonInterval(18, 36);
  assert.ok(good.reply.includes(`What the data supports, delayed forward-paper data, one paper portfolio at a time: 1. Fair value gap retest on MNQ, five-minute bars, 3R target: 36 closed MNQ long trades planned near 3 to 1 won 18, a Wilson 95% range of ${(100 * w.low).toFixed(1)}% to ${(100 * w.high).toFixed(1)}% against the 25.0% needed.`), good.reply);
  assert.match(good.reply, /Verdict: good, because every portfolio with 30 or more comparable trades has its whole win-rate range above the 25\.0% break-even/);
  const losers = journal(Array.from({ length: 40 }, (_, i) => (i % 20 ? -1 : 3)));
  assert.match((await calc(await owner({ saved: store(losers) }), 'Is this a good trade: long MNQ at 18000, stop 17990, target 18030?')).reply, /Verdict: bad, because every portfolio with 30 or more comparable trades has its whole win-rate range below the 25\.0% break-even/);
  // Shorts, other sides and wrong-way stops.
  assert.match((await calc(empty, 'Is this a good trade: long MNQ at 18000, stop 18010, target 18030?')).reply, /Verdict: bad, because for a long the stop must be below the entry/);
  assert.match((await calc(empty, 'CHE, is this a good trade: short 2 NQ at 21000, stop 21020, target 20940?')).reply, /^Short 2 NQ at 21,000, stop 21,020, target 20,940, sir\..*reward to risk = 60 ÷ 20 = 3 to 1; in dollars on 2 NQ: risk 20 × \$20\.00 × 2 = \$800\.00/s);
  assert.match((await calc(empty, 'is this a good trade: long MNQ at 18000')).reply, /^To judge a trade I need its entry, stop and target, sir\./);
});

test('lessons: order blocks at expert level, a fair value gap quiz, and BOS versus CHOCH', async () => {
  const che = await owner();
  // A card name inside a sentence about the owner's own things is not a lesson.
  for (const [lesson, own] of [['teach me about order blocks', 'walk me through my order blocks from today'], ['explain options', 'help me understand my options for the lease'],
    ['teach me fair value gaps', 'walk me through the fair value gaps you traded today'], ['explain the opening range', 'what was the opening range today'], ['teach me market structure', 'teach me market structure and send it to Mark']]) {
    assert.equal((await che.say(lesson)).route, 'che_knowledge_atlas', lesson);
    assert.notEqual((await che.say(own)).route, 'che_knowledge_atlas', own);
  }
  for (const words of variants('Teach me order blocks at expert level.')) {
    const out = await calc(che, words);
    assert.match(out.reply, /^Order blocks, expert level, sir\. There is no single definition/);
    assert.match(out.reply, /Educational example, made-up numbers, not market data; bar 3 is the displacement/);
    assert.match(out.reply, /Limitations: A discretionary concept with mixed or limited evidence: definitions differ between teachers/, 'the lesson says how weak the evidence is');
    assert.match(out.reply, /Source: Knowledge Atlas card "Order blocks" \(trading\)/);
  }
  for (const words of variants('Quiz me on fair value gaps.')) {
    const out = await calc(che, words);
    assert.match(out.reply, /^Quiz on Fair value gaps, sir\. 3 questions:\n1\. Bar 1 has a high of 50/);
    const answers = await che.say('quiz answers', { history: [{ role: 'assistant', content: out.reply }] });
    assert.match(answers.reply, /^Answers for Fair value gaps, sir:\n1\. Yes, 1\.5 points, from 50 to 51\.5\./);
  }
  for (const words of variants("What's the difference between BOS and CHOCH?")) {
    const out = await calc(che, words);
    assert.match(out.reply, /^Both are on one card, sir: Market structure: BOS and CHOCH\. The difference is direction against the trend/);
    assert.match(out.reply, /bar 6 closed at 103\.8, above the swing high 103: BOS; bar 8 closed at 98\.5, below the swing low 99\.5: CHOCH, the first break against the trend/);
  }
  const follow = await che.say('quiz me on this', { history: [{ role: 'assistant', content: (await che.say('teach me the opening range')).reply }] });
  assert.match(follow.reply, /^Quiz on Opening range, sir\./, 'a follow-up knows the card');
});

test('a Monte Carlo of the journal is seeded and repeatable, and refuses with no trades', async () => {
  const che = await owner({ saved: store(journal([3, -1, -1, 3, -1, 2, -1, -1])) });
  const a = await calc(che, 'Run a Monte Carlo on my trades');
  const b = await calc(che, 'run a monte carlo on my trades');
  assert.equal(a.reply, b.reply, 'the same seed gives the same answer');
  assert.match(a.reply, /^Monte Carlo of Fair value gap retest on MNQ, five-minute bars, 3R target, your largest paper portfolio, 8 closed trades, sir, from delayed forward-paper data, in R after assumed costs\./);
  assert.match(a.reply, /2,000 paths of 8 trades, drawn with replacement from 8 results, seed 1/);
  assert.match(a.reply, /With fewer than 30 trades it repeats their luck\./);
  assert.match((await calc(await owner(), 'run a monte carlo on my trades')).reply, /no closed paper trades to simulate/);
});

test('counter-cases keep their routes: orders, the Trading Room\'s analysis, chart reads and measured questions', async () => {
  const bar = (t, h, l, c, v) => ({ t, o: c, h, l, c, v });
  const saved = new Map([[LIVE_FEED, { status: 'DELAYED', provider: 'Yahoo Finance chart (public)', provider_symbol: 'MNQ=F', contract: 'MNQZ6', latency_s: 600,
    bars: [bar('2026-10-16T14:00:00Z', 100, 98, 99, 10), bar('2026-10-16T14:05:00Z', 101, 99, 100, 10), bar('2026-10-16T14:10:00Z', 102, 100, 101, 20), bar('2026-10-16T14:15:00Z', 103, 101, 102, 10)] }]]);
  const che = await owner({ saved });
  const buy = await che.say('buy 2 MNQ');
  assert.notEqual(buy.route, 'che_knowledge_atlas');
  assert.match(buy.reply, /I need your yes/, 'the money gate holds it');
  for (const words of ['place a trade', 'Place a trade', 'long MNQ at 18000, stop 17990, target 18030', 'Is this a good trade and if so buy it: long MNQ at 18000, stop 17990, target 18030', 'Is this a good trade? If yes, place it: long MNQ at 18000, stop 17990, target 18030']) {
    assert.notEqual((await che.say(words)).route, 'che_knowledge_atlas', words);
  }
  for (const words of ['analyze MNQ', "Don't place any orders, just analyze MNQ", 'Analyze the NQ chart']) assert.equal((await che.say(words)).route, 'che_trading', words);
  const mnq = "CHE, analyze MNQ using your latest available market data. Tell me the source, price timestamp, data delay, market structure, VWAP if available, and whether any paper trades actually occurred. Don't place any orders.";
  for (const words of [mnq, spoken(mnq)]) {
    const out = await che.say(words);
    assert.equal(out.route, 'che_trading_live', words);
    assert.match(out.reply, /^I placed no order, sir\./);
  }
  assert.equal((await che.say("What's my win rate?")).route, 'che_trading_evidence');
  assert.equal((await che.say('how many paper trades have you won')).route, 'che_trading_live');
  // Questions about open positions or other plans are not calculations.
  for (const words of ['How many contracts are open?', 'how many shares of apple do I own', 'is my strategy working', 'Is this a good trade?', "What's my risk on MNQ right now?", 'review my results', 'evaluate my youtube strategy']) {
    assert.notEqual((await che.say(words)).route, 'che_knowledge_atlas', words);
  }
  // The owner's own trades, positions and performance keep the routes that hold those records.
  for (const [words, route] of [['show me my positions', 'che_trading_live'], ["what's my trading performance", 'che_trading_live'], ['review my trading performance', 'che_trading_live'],
    ['how did your paper trades do', 'che_trading_live'], ['which ict strategy is performing best', 'che_trading_live'], ['explain why that trade lost', 'che_trading_live']]) {
    assert.equal((await che.say(words)).route, route, words);
  }
  // Pure intent checks: an order, anywhere in the turn, is never an atlas calculation.
  for (const words of ['what is my risk on 2 mnq and then buy them', 'how many mnq contracts can i trade risking $200 with a 10 point stop and place the order', 'evaluate my strategy and then sell everything']) {
    assert.equal(tradingAtlasIntent(spoken(words)), null, words);
  }
});

test('no broker request, no order, no desk or paper-trading change from any atlas turn', async () => {
  const saved = store(journal(Array.from({ length: 32 }, (_, i) => (i % 2 ? 3 : -1))));
  saved.set('trading_desk', { mode: 'paper', qty: 1, contract: 'micro', alerts: [], account: { sim: 'SIM-1', live: 'LIVE-1' } });
  saved.set(LIVE_STATE, { enabled: true, started_at: '2026-10-18T13:00:00.000Z' });
  saved.set(LIVE_BACKTEST, { at: '2026-10-18T12:00:00.000Z', ok: true, data: 'Yahoo MNQ=F (DELAYED public data)', rows: [{ name: 'fair value gap retest', target_r: 3, stats: { trades: 40, win_rate: 30, expectancy_r: 0.1, profit_factor: 1.1, net_pnl: 50, expectancy_r_95ci: { low: -0.2, high: 0.4 } } }] });
  const che = await owner({ saved });
  const before = TRADING_KEYS(saved);
  const desk = await readDesk(storageFor(saved));
  const sent = requests.length;
  for (const words of ['What is my risk on 2 MNQ contracts with a 12 point stop?', 'How many MNQ contracts can I trade risking $200 with a 10 point stop?',
    'Explain VWAP and calculate it from the latest bars', "What's the confidence interval on my win rate?", 'What is my expectancy?', 'Evaluate my strategy',
    'Is this a good trade: long MNQ at 18000, stop 17990, target 18030?', 'Teach me order blocks at expert level', 'quiz me on fair value gaps',
    "what's the difference between BOS and CHOCH", 'run a monte carlo on my trades', 'teach me the opening range']) {
    await calc(che, words);
  }
  assert.equal(requests.length, sent, 'no outbound request at all, so none to a broker');
  assert.deepEqual(TRADING_KEYS(saved), before, 'the journal, the desk, paper trading and the backtest are unchanged');
  assert.deepEqual(await readDesk(storageFor(saved)), desk);
  const evaluated = await che.say('Is this a good trade: long MNQ at 18000, stop 17990, target 18030?');
  assert.match(evaluated.reply, /Historical backtest, stored 2026-10-18, Yahoo MNQ=F \(DELAYED public data\): 1 portfolio targeting 3R won 30% of their trades \(40\), long and short together; history, not this setup\./);
  assert.match(evaluated.reply, /Broker SIM: no records\.\sLive orders: no records\./);
  assert.ok(MIN_TRADES === 30);
});
