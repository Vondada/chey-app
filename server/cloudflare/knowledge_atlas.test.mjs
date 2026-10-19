// CHE Knowledge Atlas (owner issue #346, phase 1). The cards are checked as data (every field,
// every link), as mathematics (every formula recomputed, most against CHE's own trading engine)
// and as code (every code example runs). The lessons are then asked for through the real
// /api/chat, as typed and as unpunctuated speech, with the counter-cases that must keep their
// own routes: a lesson never reaches the trading desk, and a question with no card is never
// answered with an invented one.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';
import { BRAIN_REGIONS, RELATIONSHIP_TYPES, isSafeText, normalizeRecord } from './brain_store.js';
import { commandById, dispatchPrompt } from './command_catalog.js';
import {
  ATLAS_CARDS, FORMULAS, LEVELS, answerAtlas, atlasBrainRecord, atlasCard, atlasExport, atlasIntent, findAtlasCard, measuredText, topicKey,
} from './knowledge_atlas.js';
import { COSTS, CONTRACTS, MIN_TRADES, settleTrade, summarize, wilsonInterval } from './trading_evidence.js';
import { readDesk } from './trading_desk.js';
import { LIVE_BACKTEST } from './trading_live.js';

const generated = new URL('./.knowledge_atlas.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

// Offline, and every outbound request is counted: a lesson reads no network at all.
const requests = [];
globalThis.fetch = async (input) => {
  requests.push(String(input?.url || input));
  throw new TypeError('fetch failed (knowledge_atlas tests are offline)');
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

// A paired owner phone; `say` returns the route, the reply and how many model calls it took.
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
  const say = async (message, { history = [], as = token, ...extra } = {}) => {
    const before = calls;
    const res = await send('/api/chat', { message, history, ...extra }, as);
    const raw = await res.text();
    while (pending.length) await pending.shift();
    let held = null;
    try { held = JSON.parse(raw); } catch (_) { held = null; }
    const events = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const done = events.find((e) => e.type === 'done') || {};
    const route = held?.held_for_owner ? 'held' : done.source || (calls > before ? 'model' : 'none');
    return { route, done, reply: held?.message || replyFromNdjson(raw), modelCalls: calls - before };
  };
  const post = async (path, body) => (await send(path, body, token)).json();
  return { say, send, post, saved };
}

// The same words as speech recognition hands them over: no punctuation, lower case, no apostrophes.
const spoken = (text) => text.replace(/[.,?!]/g, '').replace(/'/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const variants = (phrase) => [phrase, spoken(phrase), `CHE, ${phrase}`, `hey che ${spoken(phrase)}`];
const close = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;
const sameResult = (actual, expected, eps = 1e-4) => (typeof expected === 'object' && expected !== null
  ? Object.keys(expected).every((k) => close(actual[k], expected[k], eps))
  : close(actual, expected, eps));

// ─── The cards are well formed ────────────────────────────────────────────

test('ten coding and ten trading cards, each complete from beginner to expert', () => {
  assert.equal(ATLAS_CARDS.filter((c) => c.domain === 'coding').length, 10);
  assert.equal(ATLAS_CARDS.filter((c) => c.domain === 'trading').length, 10);
  assert.equal(new Set(ATLAS_CARDS.map((c) => c.id)).size, 20, 'ids are unique');
  assert.equal(new Set(ATLAS_CARDS.map((c) => c.title)).size, 20, 'titles are unique');
  for (const c of ATLAS_CARDS) {
    assert.match(c.id, /^[a-z][a-z0-9-]+$/, c.id);
    assert.ok(LEVELS.includes(c.level), `${c.id} level`);
    assert.equal(c.source_kind, 'curated', `${c.id} is curated teaching content`);
    assert.ok(c.revision >= 1, `${c.id} revision`);
    assert.ok(c.summary.length >= 30 && c.summary.length <= 140, `${c.id} summary`);
    for (const level of LEVELS) assert.ok(c.levels[level]?.length >= 120, `${c.id} ${level} explanation`);
    assert.notEqual(c.levels.beginner, c.levels.expert, `${c.id} levels differ`);
    assert.match(c.analogy, /\blike\b/, `${c.id} analogy is an analogy`);
    assert.ok(c.aliases.length >= 2, `${c.id} aliases`);
    assert.ok(c.quiz.length >= 3 && c.quiz.every((q) => q.q.endsWith('?') && q.a.length >= 3), `${c.id} quiz with answers`);
    assert.ok(c.misconceptions.length >= 1, `${c.id} misconception`);
    assert.ok(c.related.length >= 1, `${c.id} related cards`);
    assert.ok(c.sources.length >= 1, `${c.id} sources`);
    for (const s of c.sources) {
      assert.ok(s.title && s.author && s.license && s.text_scope, `${c.id} source fields`);
      assert.ok(s.url === '' || /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}\//.test(s.url), `${c.id} source link ${s.url}`);
    }
    for (const id of [...c.prerequisites, ...c.related]) {
      assert.ok(atlasCard(id), `${c.id} links to a real card: ${id}`);
      assert.notEqual(id, c.id, `${c.id} never links to itself`);
    }
    assert.ok(['code', 'numeric'].includes(c.example.kind), `${c.id} example kind`);
    if (c.domain === 'coding') assert.equal(c.example.kind, 'code', `${c.id}: a coding card's example is code that runs`);
    if (c.formula) {
      assert.ok(FORMULAS[c.formula.compute], `${c.id} formula has an implementation`);
      assert.ok(c.formula.expression && c.formula.spoken && c.formula.assumptions && c.formula.variables.length, `${c.id} formula fields`);
      assert.ok(c.formula.variables.every((v) => v.symbol && v.meaning && v.unit), `${c.id} formula units`);
    }
    if (c.measured) assert.ok(['expectancy', 'win_rate', 'profit_factor', 'max_drawdown', 'sample'].includes(c.measured.metric), `${c.id} measured metric`);
  }
});

test('prerequisites form a curriculum: each comes earlier in its own domain, so there is no cycle', () => {
  for (const domain of ['coding', 'trading']) {
    const order = ATLAS_CARDS.filter((c) => c.domain === domain).map((c) => c.id);
    for (const [i, id] of order.entries()) {
      for (const pre of atlasCard(id).prerequisites) {
        assert.equal(atlasCard(pre).domain, domain, `${id} → ${pre}`);
        assert.ok(order.indexOf(pre) < i, `${id} builds on ${pre}, which comes first`);
      }
    }
    assert.equal(atlasCard(order[0]).prerequisites.length, 0, `${domain} starts from nothing`);
  }
});

test('every alias names exactly one card, and every card is found by its own names', () => {
  const owners = new Map();
  for (const c of ATLAS_CARDS) {
    for (const name of [c.id, c.title, ...c.aliases]) {
      const key = topicKey(name);
      assert.ok(key, `${c.id}: "${name}" is not all filler words`);
      if (owners.has(key)) assert.equal(owners.get(key), c.id, `"${name}" is claimed by ${owners.get(key)} and ${c.id}`);
      owners.set(key, c.id);
      assert.equal(findAtlasCard(name)?.id, c.id, `"${name}" finds ${c.id}`);
    }
  }
  // Near misses are not guessed: a card is named, or there is none.
  for (const miss of ['option spreads', 'my win rate', 'quantum chromodynamics', 'graph theory', 'the nq chart']) assert.equal(findAtlasCard(miss), null, miss);
  // Everyday words are not lessons: "what is a tick", "what are threads", "what is rest", "what is a promise".
  for (const everyday of ['What is a tick?', 'what are threads', 'What is rest?', 'what is a promise', 'what is an edge', 'What is a multiplier?', 'what are stops', 'what is a map', 'what are dictionaries']) {
    assert.equal(atlasIntent(everyday), null, everyday);
  }
});

// ─── Every formula is checked numerically ─────────────────────────────────

test('each formula reproduces its stated worked example and each numbered quiz answer', () => {
  for (const c of ATLAS_CARDS) {
    if (c.formula) {
      const { inputs, result } = c.formula.example;
      assert.ok(sameResult(FORMULAS[c.formula.compute](inputs), result), `${c.id}: ${c.formula.expression}`);
    }
    if (c.example.kind === 'numeric') {
      assert.ok(sameResult(FORMULAS[c.example.compute](c.example.inputs), c.example.result), `${c.id} worked example`);
      assert.ok(c.example.steps.length >= 1, `${c.id} shows its steps`);
      if (c.formula) assert.deepEqual(c.example.inputs, c.formula.example.inputs, `${c.id}: the example is the formula's example`);
    }
    for (const q of c.quiz.filter((x) => x.check)) {
      assert.ok(sameResult(FORMULAS[q.check.compute](q.check.inputs), q.check.result, 1e-3), `${c.id} quiz: ${q.q}`);
      for (const shown of q.check.shown) assert.ok(q.a.includes(shown), `${c.id} quiz answer shows ${shown}: ${q.a}`);
    }
  }
  const checked = ATLAS_CARDS.flatMap((c) => c.quiz).filter((q) => q.check).length;
  assert.ok(checked >= 15, `${checked} quiz answers are recomputed`);
});

test('coding formulas match brute force: sums, binary search, Fibonacci calls, merge sort, Amdahl', () => {
  for (let n = 0; n <= 200; n += 1) {
    let total = 0;
    for (let i = 1; i <= n; i += 1) total += i;
    assert.equal(FORMULAS.triangular({ n }), total, `sum to ${n}`);
  }
  // The most comparisons binary search makes for any target, present or absent.
  const worstSearch = (n) => {
    const list = Array.from({ length: n }, (_, i) => i * 2);
    let worst = 0;
    for (let target = -1; target <= 2 * n; target += 1) {
      let low = 0; let high = n - 1; let count = 0;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        count += 1;
        if (list[mid] === target) break;
        if (list[mid] < target) low = mid + 1; else high = mid - 1;
      }
      worst = Math.max(worst, count);
    }
    return worst;
  };
  for (let n = 1; n <= 300; n += 1) assert.equal(FORMULAS.binarySearchWorst({ n }), worstSearch(n), `binary search on ${n}`);
  const fibCalls = (n) => { let calls = 0; const fib = (k) => { calls += 1; return k < 2 ? k : fib(k - 1) + fib(k - 2); }; fib(n); return calls; };
  for (let n = 0; n <= 20; n += 1) assert.equal(FORMULAS.fibCalls({ n }), fibCalls(n), `fib(${n}) calls`);
  // Merge sort's worst case over every ordering of up to 7 items is exactly the bound.
  const mergeCount = (items) => {
    let comparisons = 0;
    const sort = (list) => {
      if (list.length <= 1) return list;
      const mid = Math.floor(list.length / 2);
      const left = sort(list.slice(0, mid)); const right = sort(list.slice(mid)); const out = [];
      while (left.length && right.length) { comparisons += 1; out.push(left[0] <= right[0] ? left.shift() : right.shift()); }
      return [...out, ...left, ...right];
    };
    const sorted = sort(items);
    assert.deepEqual(sorted, [...items].sort((a, b) => a - b));
    return comparisons;
  };
  const permutations = (list) => (list.length <= 1 ? [list] : list.flatMap((x, i) => permutations([...list.slice(0, i), ...list.slice(i + 1)]).map((p) => [x, ...p])));
  for (let n = 1; n <= 7; n += 1) {
    const worst = Math.max(...permutations(Array.from({ length: n }, (_, i) => i)).map(mergeCount));
    assert.equal(FORMULAS.mergeSortWorst({ n }), worst, `merge sort worst case for ${n}`);
  }
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
  for (let n = 8; n <= 64; n += 7) {
    const items = Array.from({ length: n }, random);
    assert.ok(mergeCount(items) <= FORMULAS.mergeSortWorst({ n }), `merge sort on ${n} items stays within the bound`);
  }
  assert.equal(FORMULAS.loadFactor({ n: 750, m: 1000 }), 0.75);
  assert.equal(FORMULAS.amdahl({ p: 0.9, n: 1 }), 1, 'one worker is no speed-up');
  for (const n of [2, 4, 16, 1024]) assert.ok(FORMULAS.amdahl({ p: 0.9, n }) < 1 / (1 - 0.9), 'never above 1 / (1 − p)');
});

// Closed trades the way CHE's journal holds them, for the statistics checks.
function journalTrades(rows, { from = '2026-10-15T14:00:00Z' } = {}) {
  return rows.map(([r, pnl], i) => {
    const time = new Date(Date.parse(from) + i * 300_000).toISOString();
    return {
      environment: 'paper', source: 'paper', portfolio: 'atlas-test', strategy: 'fvg-retest-5m', side: 'long', session: 'mid-morning',
      entry: { time, fill: 21000, raw: 21000 }, exit: { time, reason: r > 0 ? 'target' : 'stop', fill: 21000 + r * 10 },
      stop: 20990, target: 21020, qty: 1, net_pnl: pnl, r_net: r,
      costs: { spread: 0.5, slippage: 1, commissions: 3, fees: 1 }, data: { resolution: '5m', label: 'DELAYED' },
    };
  });
}

test('trading formulas agree with CHE\'s own evidence engine (trading_evidence.js)', () => {
  const zero = { spreadTicks: 0, slippageTicks: 0, commissionPerSide: 0, feePerSide: 0 };
  for (const [name, contract] of Object.entries(CONTRACTS)) {
    for (const [entry, stop, exit, side] of [[100, 98, 105, 'long'], [21000, 20990, 20985, 'long'], [100, 103, 94, 'short']]) {
      const position = { side, entry: { raw: entry, spread: 0, slippage: 0 }, stop };
      const settled = settleTrade(position, { raw: exit, spread: 0, slippage: 0 }, 2, contract, zero);
      const points = side === 'short' ? entry - exit : exit - entry;
      assert.ok(close(FORMULAS.futuresPnl({ points, pointValue: contract.pointValue, contracts: 2 }), settled.gross_before_costs, 0.01), `${name} P&L`);
      assert.ok(close(FORMULAS.rMultiple({ entry, stop, exit, side }), settled.r_gross), `${name} ${side} R`);
    }
    // The round trip's spread cost in the engine is the card's spread cost for its assumed spread.
    const position = { side: 'long', entry: { raw: 100, spread: (COSTS.spreadTicks * contract.tick) / 2, slippage: 0 }, stop: 99 };
    const settled = settleTrade(position, { raw: 101, spread: (COSTS.spreadTicks * contract.tick) / 2, slippage: 0 }, 3, contract, { ...COSTS, slippageTicks: 0 });
    const card = FORMULAS.spreadCost({ bid: 0, ask: COSTS.spreadTicks * contract.tick, tick: contract.tick, tickValue: contract.tick * contract.pointValue, contracts: 3 });
    assert.ok(close(card, settled.costs.spread, 0.01), `${name} spread cost`);
  }
  for (const [wins, n] of [[0, 1], [1, 1], [12, 20], [6, 10], [33, 100], [0, 30], [30, 30], [517, 1000]]) {
    const engine = wilsonInterval(wins, n);
    const card = FORMULAS.wilson({ wins, n });
    assert.ok(close(card.low, engine.low, 1e-12) && close(card.high, engine.high, 1e-12), `Wilson ${wins}/${n}`);
  }
  const rows = [[2, 40], [-1, -20], [-1, -20], [2, 40], [-1, -20], [2, 40], [-1, -20], [-1, -20], [2, 40], [-1, -20]];
  const s = summarize(journalTrades(rows));
  assert.ok(close(FORMULAS.expectancy({ p: 0.4, win: 2, loss: 1 }), s.expectancy_r), 'expectancy is the mean R');
  assert.ok(close(FORMULAS.profitFactor({ pnl: rows.map(([, p]) => p) }), s.profit_factor, 0.01), 'profit factor');
  assert.ok(close(FORMULAS.maxDrawdown({ pnl: rows.map(([, p]) => p) }), s.max_drawdown, 0.01), 'maximum drawdown');
  assert.equal(FORMULAS.maxDrawdown({ pnl: [100, -50, -80, 200, -30] }), summarize(journalTrades([[1, 100], [-1, -50], [-1, -80], [1, 200], [-1, -30]])).max_drawdown);
  const rs = rows.map(([r]) => r);
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  const sd = Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (rs.length - 1));
  const ci = FORMULAS.meanCi({ mean, sd, n: rs.length });
  assert.ok(close(ci.low, s.expectancy_r_95ci.low) && close(ci.high, s.expectancy_r_95ci.high), 'the 95% range of mean R is the engine\'s');
  assert.equal(FORMULAS.vwap({ bars: [{ h: 10, l: 10, c: 10, v: 100 }, { h: 12, l: 12, c: 12, v: 300 }] }), 11.5);
  const size = FORMULAS.positionSize({ risk: 100, stopPoints: 10, pointValue: CONTRACTS.MNQ.pointValue });
  assert.ok(size * 10 * 2 <= 100 && (size + 1) * 10 * 2 > 100, 'the size is the most that fits the budget');
});

test('the numbers written in the explanations are the computed ones, and CHE\'s notes use the engine\'s constants', () => {
  const pct = (x) => `${(100 * x).toFixed(1)}%`;
  const w = FORMULAS.wilson({ wins: 12, n: 20 });
  assert.ok(atlasCard('win-rate-ci').levels.intermediate.includes(`${pct(w.low)} to ${pct(w.high)}`));
  assert.ok(atlasCard('big-o').levels.intermediate.includes(`${FORMULAS.binarySearchWorst({ n: 1000 })} for a thousand items and ${FORMULAS.binarySearchWorst({ n: 1e6 })} for a million`));
  assert.ok(atlasCard('expectancy').levels.intermediate.includes(`+${FORMULAS.expectancy({ p: 0.4, win: 2, loss: 1 }).toFixed(1)}R`));
  const ci = FORMULAS.meanCi({ mean: 0.2, sd: 1.2, n: 36 });
  assert.ok(atlasCard('sample-size').levels.intermediate.includes(`−${Math.abs(ci.low).toFixed(2)}R to +${ci.high.toFixed(2)}R`));
  assert.ok(atlasCard('drawdown').levels.intermediate.includes(`maximum drawdown of ${FORMULAS.maxDrawdown({ pnl: [100, -50, -80, 200, -30] })}`));
  assert.ok(atlasCard('risk-management').levels.expert.includes(`about ${(100 * 0.6 ** 10).toFixed(1)}%`));
  assert.ok(atlasCard('concurrency').quiz[2].a.includes(FORMULAS.amdahl({ p: 0.9, n: 4 }).toFixed(2)));
  assert.ok(atlasCard('tick-value').che_note.includes(`$${CONTRACTS.MNQ.pointValue} a point`) && atlasCard('tick-value').che_note.includes(`$${CONTRACTS.NQ.pointValue} a point`));
  assert.ok(atlasCard('bid-ask-spread').che_note.includes(`${COSTS.spreadTicks}-tick spread`));
  assert.ok(atlasCard('sample-size').levels.beginner.includes(`fewer than ${MIN_TRADES} trades`));
});

// ─── Every code example runs ──────────────────────────────────────────────

test('every code example runs and returns exactly what its card says', async () => {
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const coded = ATLAS_CARDS.filter((c) => c.example.kind === 'code');
  assert.equal(coded.length, 10);
  for (const c of coded) {
    assert.equal(c.example.language, 'javascript');
    const result = await new AsyncFunction(c.example.code)();
    assert.deepEqual(result, c.example.expected, c.id);
    // The spoken description cites the very numbers the code returns.
    const numbers = JSON.stringify(c.example.expected).match(/-?\d+(?:\.\d+)?/g) || [];
    for (const n of numbers) assert.ok(c.example.explain.includes(n), `${c.id}: "${c.example.explain}" mentions ${n}`);
  }
});

// ─── Storage: the phone's export and the Brain's record shape ─────────────

test('the phone\'s bundled atlas matches the cards (regenerate: node tool/dump_knowledge_atlas.mjs)', () => {
  const bundled = JSON.parse(readFileSync(new URL('../../assets/atlas/knowledge_atlas.json', import.meta.url), 'utf8'));
  assert.deepEqual(bundled, JSON.parse(JSON.stringify(atlasExport())));
  assert.equal(bundled.cards.length, 20);
  assert.ok(bundled.cards.every((c) => c.quiz.every((q) => Object.keys(q).join() === 'q,a')), 'only questions and answers go to the phone');
  assert.match(readFileSync(new URL('../../pubspec.yaml', import.meta.url), 'utf8'), /^\s+- assets\/atlas\/$/m, 'pubspec bundles it');
});

test('each card fits the Brain\'s own record schema, with typed links and no sensitive text', () => {
  for (const c of ATLAS_CARDS) {
    const record = atlasBrainRecord(c);
    const normalized = normalizeRecord(record);
    assert.equal(normalized.error, undefined, c.id);
    assert.equal(normalized.region, c.domain === 'coding' ? BRAIN_REGIONS.coding : BRAIN_REGIONS.trading);
    assert.equal(normalized.verification, 'unverified_reference', 'a reference link is not proof of every sentence');
    assert.ok(normalized.links.every((l) => RELATIONSHIP_TYPES.includes(l.type) && atlasCard(l.to.replace(/^atlas:/, ''))), c.id);
    assert.equal(normalized.links.filter((l) => l.type === 'builds_upon').length, c.prerequisites.length);
    assert.ok(isSafeText(`${normalized.title}\n${normalized.body}`), `${c.id} passes the Brain's secret gate`);
  }
});

// ─── Measured statistics come only from records ───────────────────────────

test('a trading card cites measured numbers only from CHE\'s records, and says so when there are none', () => {
  const empty = measuredText(atlasCard('expectancy'), { paper: [], backtest: null });
  assert.match(empty, /no recorded data yet/);
  assert.match(empty, /No stored backtest with trades yet/);
  assert.doesNotMatch(empty, /\d+(?:\.\d+)?R/, 'no number without a record');
  assert.equal(measuredText(atlasCard('recursion'), { paper: [], backtest: null }), '', 'coding cards cite no trading records');
  assert.equal(measuredText(atlasCard('vwap'), { paper: [], backtest: null }), '', 'a card that cites no statistic has no measured line');
  assert.match(measuredText(atlasCard('drawdown'), { paper: [], backtest: null, unreadable: true }), /could not read CHE's paper journal just now, so I give no measured maximum drawdown/, 'a failed read is not "no data"');
  const trades = journalTrades([[2, 40], [-1, -20], [-1, -20], [2, 40], [-1, -20]]);
  const s = summarize(trades);
  const text = measuredText(atlasCard('win-rate-ci'), { paper: trades, backtest: null });
  assert.ok(text.includes(`${s.trades} closed paper trades`) && text.includes(`Win rate ${s.win_rate}%`) && text.includes(`${s.win_rate_95ci.low}% to ${s.win_rate_95ci.high}%`), text);
  assert.match(text, new RegExp(`fewer than the ${MIN_TRADES} trades needed`));
});

// ─── Through /api/chat ────────────────────────────────────────────────────

test('the owner\'s seven phrasings are answered from the cards with no model, typed or spoken', async () => {
  const che = await owner();
  const sent = requests.length;
  const lesson = async (words, history = []) => {
    const out = await che.say(words, { history });
    assert.equal(out.route, 'che_knowledge_atlas', `${words} → ${out.route}: ${out.reply.slice(0, 120)}`);
    assert.equal(out.modelCalls, 0, words);
    return out;
  };
  for (const words of variants('Teach me recursion.')) {
    const out = await lesson(words);
    assert.match(out.reply, /^Recursion, beginner level, sir\. Recursion is a function that solves a problem by calling itself/);
    assert.match(out.reply, /Analogy, and only an analogy: Recursion is like Russian nesting dolls/);
    assert.match(out.reply, /fib\(10\) returns 55 but takes 177 calls/);
    assert.match(out.reply, /Source: Knowledge Atlas card "Recursion" \(coding\), curated teaching content/);
    assert.equal(out.done.atlas_card, 'recursion');
  }
  const taught = (await che.say('Teach me recursion')).reply;
  const after = [{ role: 'user', content: 'Teach me recursion' }, { role: 'assistant', content: taught }];
  for (const words of variants('Give me the expert version.')) {
    const out = await lesson(words, after);
    assert.match(out.reply, /^Recursion, expert level, sir\. Model the cost with a recurrence/);
    assert.match(out.reply, /Formula: naive Fibonacci of n makes/);
    assert.match(out.reply, /Common mistake: /);
  }
  for (const words of variants("What's next after this?")) {
    const out = await lesson(words, after);
    assert.match(out.reply, /^After Recursion comes Hash maps, intermediate level, sir: /);
    assert.match(out.reply, /Say "teach me hash maps" to start it/);
  }
  for (const words of variants("Explain expectancy like I'm a beginner.")) {
    const out = await lesson(words);
    assert.match(out.reply, /^Expectancy, beginner level, sir\. Expectancy is what a strategy makes or loses on an average trade/);
    assert.match(out.reply, /0\.4 × 2R = 0\.8R; losses: 0\.6 × 1R = 0\.6R; expectancy = 0\.8 - 0\.6 = \+0\.2R per trade/);
    assert.match(out.reply, /Your records: no recorded data yet/);
  }
  for (const words of variants("What's the formula for VWAP?")) {
    const out = await lesson(words);
    assert.match(out.reply, /^The formula for VWAP, sir: VWAP equals the sum of typical price times volume, divided by the sum of volume/);
    assert.match(out.reply, /VWAP = 40,400 ÷ 400 = 101/);
    assert.match(out.reply, /CHE does not compute VWAP on market data yet/, 'the card says what CHE cannot do');
  }
  for (const words of variants('Quiz me on risk management.')) {
    const out = await lesson(words);
    assert.match(out.reply, /^Quiz on Risk management and position sizing, sir\. 3 questions:\n1\. You risk \$60 with a 15-point stop on MNQ\. How many contracts\?/);
    assert.doesNotMatch(out.reply, /\$60 ÷ \$30 = 2/, 'the answers wait until asked');
    const answers = await lesson('quiz answers', [{ role: 'assistant', content: out.reply }]);
    assert.match(answers.reply, /^Answers for Risk management and position sizing, sir:\n1\. 2: each contract risks 15 × \$2 = \$30, and \$60 ÷ \$30 = 2\./);
  }
  for (const words of variants('List the trading cards.')) {
    const out = await lesson(words);
    assert.match(out.reply, /^Trading cards in the Knowledge Atlas, sir: 10\.\n1\. Ticks, points and contract value, beginner\.\n2\. Bid, ask and spread, beginner\./);
    const picked = await lesson('number five', [{ role: 'assistant', content: out.reply }]);
    assert.match(picked.reply, /^Expectancy, beginner level, sir\./, 'a spoken number picks from the list just read');
  }
  assert.equal(requests.length, sent, 'no lesson made an outbound request');
});

test('the /learn command is the same lesson route, through the one catalog', async () => {
  const che = await owner();
  const command = commandById('learn');
  assert.equal(command.route, 'che_knowledge_atlas');
  assert.equal(dispatchPrompt(command, 'recursion'), 'Knowledge Atlas: recursion');
  const slash = await che.say('/learn recursion');
  assert.equal(slash.route, 'che_knowledge_atlas');
  assert.equal(slash.modelCalls, 0);
  assert.equal(slash.reply, (await che.say('Teach me recursion')).reply);
  assert.match((await che.say('/learn quiz me on expectancy')).reply, /^Quiz on Expectancy, sir\./);
  assert.match((await che.say('/learn what\'s the formula for profit factor')).reply, /^The formula for Profit factor, sir: profit factor equals gross profit divided by gross loss/);
  const overview = await che.say('/learn');
  assert.equal(overview.route, 'che_knowledge_atlas');
  assert.match(overview.reply, /^The Knowledge Atlas has 20 cards, sir: 10 coding and 10 trading/);
  const unknown = await che.say('/learn string theory');
  assert.equal(unknown.route, 'che_knowledge_atlas');
  assert.match(unknown.reply, /^I don't have a Knowledge Atlas card on "string theory" yet, sir, so I won't make one up\./);
  assert.equal(unknown.done.ok, false);
});

test('a coding or trading topic with no card is said plainly; other subjects keep their usual route', async () => {
  const che = await owner();
  for (const words of variants('Teach me Kubernetes.')) {
    const out = await che.say(words);
    assert.equal(out.route, 'che_knowledge_atlas', words);
    assert.equal(out.modelCalls, 0);
    assert.match(out.reply, /^I don't have a Knowledge Atlas card on "kubernetes" yet, sir, so I won't make one up\./);
  }
  const options = await che.say('Quiz me on option spreads');
  assert.match(options.reply, /no Knowledge Atlas card on "option spreads"|card on "option spreads" yet/, 'option spreads are not the bid-ask spread');
  // Not coding or trading: the atlas does not claim it, and the conversation goes on as before.
  for (const words of ['Teach me how to cook pasta', 'Teach me quantum chromodynamics', 'What is the capital of France?']) {
    const out = await che.say(words);
    assert.equal(out.route, 'model', words);
  }
});

test('"teach me to trade live" is a lesson request: it never enables trading or touches the desk', async () => {
  const che = await owner();
  for (const words of [...variants('Teach me to trade live.'), 'Teach me how to switch to live trading', 'teach me how to place a live order']) {
    const out = await che.say(words);
    assert.equal(out.route, 'che_knowledge_atlas', words);
    assert.equal(out.modelCalls, 0);
    assert.match(out.reply, /Lessons never place or enable trades: live orders stay disabled, and nothing was changed\./, words);
    const desk = await readDesk(storageFor(che.saved));
    assert.equal(desk.mode, 'paper', words);
    assert.equal(desk.live_request_at, 0, `${words}: no live switch was even requested`);
  }
  // The real desk request keeps its own two-step route.
  const live = await che.say('Switch to live trading');
  assert.equal(live.route, 'che_trading_desk');
  assert.equal((await readDesk(storageFor(che.saved))).mode, 'paper', 'still waits for "confirm live trading"');
});

test('"quiz me" with no topic asks which one; "number" picks then quiz that card', async () => {
  const che = await owner();
  for (const words of variants('Quiz me.')) {
    const out = await che.say(words);
    assert.equal(out.route, 'che_knowledge_atlas', words);
    assert.equal(out.modelCalls, 0);
    assert.match(out.reply, /^Which topic should I quiz you on, sir\? For example recursion, Big-O, expectancy or risk management\./);
    assert.doesNotMatch(out.reply, /^Quiz on/, 'no topic is guessed');
  }
  const trading = await che.say('Quiz me on trading');
  assert.match(trading.reply, /^Trading cards in the Knowledge Atlas, for a quiz, sir: 10\./);
  const picked = await che.say('number 2', { history: [{ role: 'assistant', content: trading.reply }] });
  assert.match(picked.reply, /^Quiz on Bid, ask and spread, sir\./);
  // Answers only follow a quiz; with none open CHE says so.
  assert.match((await che.say('give me the quiz answers')).reply, /^There is no quiz open right now, sir\./);
});

test('follow-ups need the lesson they follow: without one, the usual route answers', async () => {
  const che = await owner();
  for (const words of ['Give me the expert version', "What's next after this?", 'go deeper', 'show me the code']) {
    const out = await che.say(words);
    assert.notEqual(out.route, 'che_knowledge_atlas', words);
  }
  const taught = (await che.say('Teach me sorting')).reply;
  const history = [{ role: 'assistant', content: taught }];
  const code = await che.say('show me the code', { history });
  assert.equal(code.route, 'che_knowledge_atlas');
  assert.ok(code.reply.includes(atlasCard('sorting').example.code), 'the code is shown only when asked for');
  assert.match((await che.say('go deeper', { history })).reply, /^Sorting and merge sort, intermediate level, sir\./);
  assert.match((await che.say("what's the formula", { history })).reply, /^The formula for Sorting and merge sort, sir: merge sort makes at most/);
  const variablesFormula = await che.say("what's the formula", { history: [{ role: 'assistant', content: (await che.say('teach me variables')).reply }] });
  assert.match(variablesFormula.reply, /^Variables and data types has no single formula, sir: it is a concept, not a calculation, so I won't invent one\./);
});

test('counter-cases keep their routes: measured questions, chart reads, skills, memory, money', async () => {
  const che = await owner();
  assert.equal((await che.say("What's my win rate?")).route, 'che_trading_evidence');
  assert.equal((await che.say('what is win rate')).route, 'che_trading_evidence', 'a bare question about the win rate asks for CHE\'s numbers');
  assert.equal((await che.say('Analyze the NQ chart')).route, 'che_trading');
  assert.equal((await che.say('Learn this skill: always check the NQ opening range before taking any entries')).route, 'che_self_skills');
  assert.equal((await che.say('What have I told you about recursion?')).route, 'che_memory_provenance');
  // A lesson that also buys something is not a lesson: the money gate holds it.
  const buy = await che.say('Teach me recursion and buy the course');
  assert.equal(buy.route, 'held');
  assert.equal(buy.modelCalls, 0);
});

test('measured lines through /api/chat: the journal and the stored backtest, exactly as recorded', async () => {
  const saved = new Map();
  const trades = journalTrades([[2, 40], [-1, -20], [-1, -20], [2, 40], [-1, -20]]);
  for (const t of trades) saved.set(`evr:paper:${t.portfolio}:${t.entry.time}`, t);
  saved.set(LIVE_BACKTEST, {
    at: '2026-10-18T12:00:00.000Z', ok: true, data: 'Yahoo MNQ=F, 1200 five-minute bars (DELAYED public data)',
    rows: [
      { name: 'a', stats: { trades: 12, expectancy_r: -0.15, win_rate: 33.33, profit_factor: 0.8, max_drawdown: 120 } },
      { name: 'b', stats: { trades: 40, expectancy_r: 0.12, win_rate: 45, profit_factor: 1.3, max_drawdown: 80.5 } },
      { name: 'c', stats: { trades: 0, expectancy_r: 0, win_rate: null, profit_factor: null, max_drawdown: 0 } },
    ],
  });
  const che = await owner({ saved });
  const s = summarize(trades);
  const out = await che.say('Explain expectancy');
  assert.equal(out.route, 'che_knowledge_atlas');
  assert.match(out.reply, /Your records, measured from CHE's paper journal: 5 closed paper trades, fewer than the 30 trades needed, so this is anecdote, not evidence\./);
  assert.ok(out.reply.includes(`Expectancy +${s.expectancy_r.toFixed(2)}R per trade after assumed costs`), out.reply);
  assert.match(out.reply, /Latest stored backtest, 2026-10-18, Yahoo MNQ=F, 1200 five-minute bars \(DELAYED public data\): 2 strategy portfolios with 52 trades; expectancy ranged -0\.15R to \+0\.12R across them\. A backtest is history, not a forward result\./);
  const pf = await che.say("What's the formula for profit factor?");
  assert.ok(pf.reply.includes(`Profit factor ${s.profit_factor}.`), pf.reply);
  assert.match(pf.reply, /profit factor ranged 0\.8 to 1\.3 across them/);
  const dd = await che.say('Teach me maximum drawdown like an expert');
  assert.match(dd.reply, /^Maximum drawdown, expert level, sir\./);
  assert.ok(dd.reply.includes(`Maximum drawdown $${s.max_drawdown.toFixed(2)}`), dd.reply);
  assert.equal((await che.say('Teach me VWAP')).reply.includes('Your records'), false, 'VWAP cites no record because CHE computes none');
});

test('a guest device gets no lesson from the owner\'s records', async () => {
  const che = await owner();
  const tenant = await che.post('/api/platform/tenants', { name: 'Guest', role: 'family' });
  const invite = await che.post('/api/platform/enrollments', { access: 'private', tenant_id: tenant.body?.tenant?.id || tenant.tenant?.id });
  const enrollment = invite.body?.enrollment || invite.enrollment;
  const guest = (await (await che.send('/api/enroll', { enrollment_token: enrollment.token, device_name: 'guest' })).json()).device_token;
  const out = await che.say('Explain expectancy', { as: guest });
  assert.equal(out.route, 'che_guest');
  assert.doesNotMatch(out.reply, /paper journal/);
});

test('atlasIntent reads whole sentences only, and answers are pure functions of cards and records', async () => {
  assert.equal(atlasIntent('teach me recursion and then open youtube'), null);
  assert.equal(atlasIntent('What is the spread right now?'), null, 'a reading, not a lesson');
  assert.equal(atlasIntent('explain why that trade lost'), null);
  assert.equal(atlasIntent('tell me about my business'), null);
  assert.equal(atlasIntent('delete the recursion card'), null, 'a delete is never a lesson');
  assert.deepEqual(atlasIntent('teach me recursion', [], { explainLevel: 'deeper' }), { kind: 'teach', card: atlasCard('recursion'), level: 'expert' }, 'the phone\'s depth setting applies when none is said');
  const a = await answerAtlas(atlasIntent('teach me big o'));
  const b = await answerAtlas(atlasIntent('teach me big o'));
  assert.equal(a.text, b.text);
  assert.doesNotMatch(a.text, /tap/i, 'never "tap here"');
});
