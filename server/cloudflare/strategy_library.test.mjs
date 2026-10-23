// Strategy Library (owner, 2026-10-23): the registry, the evidence lifecycle, the approval gate and the voice
// routes. Module tests use an in-memory storage; the chat and HTTP tests go through the real Worker.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';
import {
  BUDGET, KINDS, LIFECYCLE, activeDefinitions, approveEntry, builtinEntries, countsOf, definitionProblems, duplicateEntry, entryProblems,
  libraryView, lifecycleOf, readAudit, recordResults, registerEntry, resolveName, setFlag, strategyLibraryIntent,
} from './strategy_library.js';
import { LIBRARY_SEEDS } from './library_seeds/index.js';
import { INTRADAY_CANDIDATES, CANDIDATES } from './trading_evidence.js';
import { SIM_STRATEGIES } from './strategy_sim.js';
import { STRATEGIES as LAB } from './trading_lab.js';
import { UNDEFINED_STRATEGIES } from './trading_research.js';

const generated = new URL('./.strategy_library.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;
globalThis.fetch = async (input) => { throw new TypeError(`fetch failed (strategy library tests are offline: ${new URL(String(input?.url || input)).host})`); };

function storageFor(saved = new Map()) {
  return {
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => saved.set(key, structuredClone(value)),
    delete: async (key) => saved.delete(key),
    deleteAll: async () => saved.clear(),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

const DOC = {
  schema: 'che.strategy/1', id: 'owner-ema-test', name: 'Owner EMA test', category: 'trend', timeframes: [5],
  series: { ema9: { fn: 'ema', period: 9 }, ema21: { fn: 'ema', period: 21 } },
  long: { conditions: [{ id: 'x', label: '9 EMA crosses above 21 EMA', when: { cross_above: ['ema9', 'ema21'] } }], stop: { sub: ['close', 10] }, target: { r: 2 } },
};
const ENTRY = { id: 'owner-ema-test', kind: 'strategy', name: 'Owner EMA test', category: 'trend', sources: [{ type: 'owner', title: 'Owner request' }], rules: ['9/21 cross'], timeframes: ['5m'], definition: DOC };

test('every built-in strategy in the code is in the library, counted exactly once', () => {
  const ids = builtinEntries().map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate ids');
  const expected = Object.keys(INTRADAY_CANDIDATES).length + Object.keys(CANDIDATES).length + SIM_STRATEGIES.length + Object.keys(LAB).length + UNDEFINED_STRATEGIES.length;
  assert.equal(ids.length, expected);
  for (const id of [...Object.keys(INTRADAY_CANDIDATES), ...Object.keys(CANDIDATES)]) assert.ok(ids.includes(id), id);
});

test('seed entries are valid, unique across files, and never collide with a built-in', () => {
  const builtin = new Set(builtinEntries().map((e) => e.id));
  const seen = new Set();
  for (const e of LIBRARY_SEEDS) {
    assert.deepEqual(entryProblems(e), [], `${e.id}: ${entryProblems(e).join('; ')}`);
    assert.ok(!seen.has(e.id), `duplicate seed ${e.id}`);
    assert.ok(!builtin.has(e.id), `seed ${e.id} collides with a built-in`);
    assert.ok(KINDS.includes(e.kind));
    seen.add(e.id);
  }
});

test('lifecycle comes from evidence: a request can lower it, never raise it', () => {
  const base = { kind: 'strategy', engine: 'dsl', rules: ['r'], approval: { state: 'approved' }, enabled: true };
  assert.equal(lifecycleOf({ kind: 'strategy' }), 'discovered');
  assert.equal(lifecycleOf({ ...base, engine: 'none' }), 'rules_documented');
  assert.equal(lifecycleOf(base), 'implemented');
  assert.equal(lifecycleOf({ ...base, results: { backtest: { trades: 40 } } }), 'backtested');
  assert.equal(lifecycleOf({ ...base, results: { backtest: { trades: 40 }, forward: { trades: 12 } } }), 'backtested', '12 forward trades is under 30');
  assert.equal(lifecycleOf({ ...base, results: { backtest: { trades: 40 }, forward: { trades: 31 } } }), 'forward_tested');
  assert.equal(lifecycleOf(base, { running: true }), 'paper_active');
  assert.equal(lifecycleOf({ ...base, approval: { state: 'pending_owner' } }, { running: true }), 'implemented', 'not approved: never paper active');
  assert.equal(lifecycleOf({ kind: 'strategy', lifecycle_requested: 'paper_active' }), 'discovered', 'asking for a stage does not grant it');
  assert.equal(lifecycleOf({ ...base, lifecycle_requested: 'rules_documented' }), 'rules_documented');
  assert.deepEqual(LIFECYCLE, ['discovered', 'rules_documented', 'implemented', 'backtested', 'forward_tested', 'paper_active']);
});

test('definitions that could run code, look ahead or lack a stop are refused by name', () => {
  assert.deepEqual(definitionProblems(DOC), []);
  const noStop = structuredClone(DOC); delete noStop.long.stop;
  assert.match(definitionProblems(noStop).join(' '), /long\.stop: a stop is required/);
  const ahead = structuredClone(DOC); ahead.long.conditions[0].when = { gt: ['close', { series: 'ema9', ahead: 1 }] };
  assert.match(definitionProblems(ahead).join(' '), /unsupported construct "ahead"/);
  const negative = structuredClone(DOC); negative.long.conditions[0].when = { gt: ['close', { series: 'ema9', ago: -1 }] };
  assert.match(definitionProblems(negative).join(' '), /look-ahead is not allowed/);
  const code = structuredClone(DOC); code.long.conditions[0].when = { eval: 'fetch("https://x")' };
  assert.match(definitionProblems(code).join(' '), /unsupported construct "eval"/);
  assert.match(entryProblems({ ...ENTRY, sources: [{ type: 'tradingview', title: 'x', code: '//@version=5' }] }).join(' '), /script code is never stored/);
  assert.match(entryProblems({ ...ENTRY, sources: [{ type: 'authorized_script', title: 'x' }] }).join(' '), /names its license/);
});

test('a custom strategy waits for the owner: register → pending, enable refused, approve needs confirm, then enable', async () => {
  const saved = new Map(); const storage = storageFor(saved);
  const reg = await registerEntry(storage, ENTRY, { who: 'owner' });
  assert.deepEqual([reg.ok, reg.version, reg.approval], [true, 1, 'pending_owner']);
  assert.match((await setFlag(storage, ENTRY.id, 'enable')).error, /needs your approval first/);
  assert.equal((await activeDefinitions(storage)).definitions.length, 0, 'nothing runs before approval');
  const ask = await approveEntry(storage, ENTRY.id);
  assert.equal(ask.needs_confirmation, true);
  assert.match(ask.summary, /paper testing\? It will paper trade only; live trading stays off/);
  assert.equal((await approveEntry(storage, ENTRY.id, { confirm: true })).ok, true);
  assert.equal((await setFlag(storage, ENTRY.id, 'enable')).ok, true);
  const active = await activeDefinitions(storage);
  assert.deepEqual(active.definitions.map((d) => d.id), [ENTRY.id]);
  // An edit is a new version: the old one is kept and the new rules need a new yes.
  const v2 = await registerEntry(storage, { ...ENTRY, definition: { ...DOC, name: 'Owner EMA test v2' } });
  assert.equal(v2.version, 2);
  assert.equal((await activeDefinitions(storage)).definitions.length, 0, 'edited rules stop until approved again');
  const view = await libraryView(storage);
  const e = view.entries.find((x) => x.id === ENTRY.id);
  assert.deepEqual([e.version, e.versions.map((v) => v.version), e.approval, e.lifecycle], [2, [1, 2], 'pending_owner', 'implemented']);
  const audit = (await readAudit(storage)).map((r) => r.action);
  assert.deepEqual(audit, ['edit', 'enable', 'approve', 'register'], 'append-only, newest first');
});

test('built-ins cannot be overwritten; duplicating one gives the owner a pending copy with rules as text', async () => {
  const storage = storageFor();
  assert.match((await registerEntry(storage, { ...ENTRY, id: 'ema-pullback-5m', definition: { ...DOC, id: 'ema-pullback-5m' } })).problems[0], /built-in/);
  const dup = await duplicateEntry(storage, 'ema-pullback-5m', 'my-ema-pullback');
  assert.equal(dup.ok, true);
  const e = (await libraryView(storage)).entries.find((x) => x.id === 'my-ema-pullback');
  assert.equal(e.engine, 'none', 'a built-in\'s code is not copied; its rules come along as text');
  assert.equal(e.lifecycle, 'rules_documented');
});

test('seeded executable rules start off and pending, like any custom strategy', async () => {
  const storage = storageFor();
  const view = await libraryView(storage);
  const macd = view.entries.find((e) => e.id === 'macd-signal-cross');
  assert.deepEqual([macd.enabled, macd.approval, macd.lifecycle], [false, 'pending_owner', 'implemented']);
  assert.match(macd.not_running, /Waiting for the owner's approval/);
  assert.equal((await approveEntry(storage, 'macd-signal-cross', { confirm: true })).ok, true);
  assert.equal((await setFlag(storage, 'macd-signal-cross', 'enable')).ok, true);
  assert.deepEqual((await activeDefinitions(storage)).definitions.map((d) => d.id), ['macd-signal-cross']);
});

test('the audit counts come from the same entries: names without rules are never counted as executable', async () => {
  const view = await libraryView(storage());
  function storage() { return storageFor(); }
  const c = view.counts;
  assert.equal(c.named, view.entries.filter((e) => e.kind === 'strategy').length);
  assert.equal(c.executable_rules, view.entries.filter((e) => e.kind === 'strategy' && e.engine !== 'none').length);
  for (const id of ['dirty-trez', 'ict-ote', 'ict-2022-model', 'bollinger-squeeze']) {
    const e = view.entries.find((x) => x.id === id);
    assert.ok(['discovered', 'rules_documented'].includes(e.lifecycle), `${id} is ${e.lifecycle}`);
  }
  assert.equal(c.backtested, 0, 'an empty ledger has no backtests');
  assert.equal(c.paper_active, 0);
  assert.deepEqual(countsOf([]).named, 0);
});

test('backtest and forward evidence come from the research ledger and the harness, never estimated', async () => {
  const storage = storageFor();
  assert.match((await recordResults(storage, 'macd-signal-cross', 'backtest', { trades: 50 })).error, /evidence source/);
  assert.equal((await recordResults(storage, 'macd-signal-cross', 'backtest', { trades: 50, expectancy_r: 0.1 }, { source: 'harness job h1' })).ok, true);
  const e = (await libraryView(storage)).entries.find((x) => x.id === 'macd-signal-cross');
  assert.deepEqual([e.lifecycle, e.results.backtest.trades, e.results.backtest.source], ['backtested', 50, 'harness job h1']);
});

test('search and filters: by words, category, kind and stage; favorites first', async () => {
  const storage = storageFor();
  await setFlag(storage, 'vwap-revert-5m', 'favorite');
  const all = await libraryView(storage);
  assert.equal(all.entries[0].id, 'vwap-revert-5m');
  assert.ok((await libraryView(storage, { q: 'silver bullet' })).entries.some((e) => e.id === 'silver-bullet-5m'));
  assert.ok((await libraryView(storage, { category: 'ict_smc' })).entries.every((e) => e.category === 'ict_smc'));
  assert.deepEqual((await libraryView(storage, { kind: 'market_context' })).entries.map((e) => e.id), ['amd-power-of-three']);
  assert.ok((await libraryView(storage, { lifecycle: 'discovered' })).entries.every((e) => e.lifecycle === 'discovered'));
});

test('names resolve to one entry or to a question, never a guess', async () => {
  const view = await libraryView(storageFor());
  assert.equal(resolveName(view.entries, 'silver bullet').match.id, 'silver-bullet-5m');
  assert.equal(resolveName(view.entries, 'EMA pullback').match.id, 'ema-pullback-5m', 'research beats the lab variant');
  assert.equal(resolveName(view.entries, 'MACD signal cross').match.id, 'macd-signal-cross');
  assert.equal(resolveName(view.entries, 'zebra unicorn').match, null);
  const amb = resolveName(view.entries, 'order block');
  assert.equal(amb.match, null);
  assert.ok(amb.candidates.length >= 2);
});

test('voice intents: library, compare, approve, favorite, draft; ordinary sentences are left alone', () => {
  assert.deepEqual(strategyLibraryIntent('Show the strategy library'), { kind: 'list' });
  assert.deepEqual(strategyLibraryIntent('CHE, how many strategies can you execute?'), { kind: 'list' });
  assert.deepEqual(strategyLibraryIntent('Compare EMA pullback and VWAP reversion'), { kind: 'compare', names: ['ema pullback', 'vwap reversion'] });
  assert.deepEqual(strategyLibraryIntent('Approve MACD signal cross'), { kind: 'approve', name: 'macd signal cross', confirm: false });
  assert.deepEqual(strategyLibraryIntent('Yes, approve MACD signal cross'), { kind: 'approve', name: 'macd signal cross', confirm: true });
  assert.deepEqual(strategyLibraryIntent('Favorite Silver Bullet'), { kind: 'flag', flag: 'favorite', name: 'silver bullet' });
  assert.equal(strategyLibraryIntent('Add a strategy that buys when RSI crosses above 30 in the NY open').kind, 'draft');
  assert.equal(strategyLibraryIntent('What is the 86 strategy?').kind, 'identify');
  for (const s of ['Compare these two quotes for my kitchen', 'I approve of the new logo', 'Show me my emails', 'Disable notifications']) {
    const got = strategyLibraryIntent(s);
    assert.ok(got == null || got.kind === 'flag', `${s} → ${JSON.stringify(got)}`);
  }
  assert.equal(strategyLibraryIntent('Compare these two quotes for my kitchen'), null);
});

test('budget: evaluation never calls a model, and caps are explicit', () => {
  assert.equal(BUDGET.model_calls_per_candle, 0);
  assert.ok(BUDGET.max_active > 0 && BUDGET.max_paper_global_day > 0 && BUDGET.max_paper_per_strategy_day <= BUDGET.max_paper_global_day);
});

// ─── Through the real Worker ───────────────────────────────────────────────────────

async function owner({ model = () => '{}' } = {}) {
  const saved = new Map();
  const counter = { calls: 0 };
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async (_m, input) => { counter.calls += 1; return { response: model(input) }; } } };
  const state = new CheState({ storage: storageFor(saved) }, env);
  env.CHE_STATE = { getByName: () => state };
  const call = (path, { method = 'POST', body, token } = {}) => worker.fetch(new Request(`https://che.example${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
  }), env);
  const token = (await (await call('/api/pair', { body: { code: '123456' } })).json()).device_token;
  const say = async (message) => {
    const before = counter.calls;
    const raw = await (await call('/api/chat', { body: { message, history: [] }, token })).text();
    const done = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((x) => x.type === 'done') || {};
    return { reply: replyFromNdjson(raw), meta: done, modelCalls: counter.calls - before };
  };
  const api = async (path, opts = {}) => { const r = await call(path, { ...opts, token }); return { status: r.status, body: await r.json() }; };
  return { say, api, saved, counter, call };
}

test('chat: "show the strategy library" answers from the registry with zero model calls', async () => {
  const che = await owner();
  const out = await che.say('Show the strategy library');
  assert.equal(out.meta.source, 'che_strategy_library');
  assert.equal(out.modelCalls, 0);
  assert.match(out.reply, /named strategies and 1 market-context model/);
  assert.match(out.reply, /have executable rules/);
  assert.match(out.reply, /Live trading is off/);
});

test('chat: approve asks for a spoken yes, and only "yes, approve …" approves', async () => {
  const che = await owner();
  const ask = await che.say('Approve MACD signal cross');
  assert.match(ask.reply, /Say "yes, approve MACD signal-line cross" to approve it\. Nothing has changed yet\./);
  assert.equal((await che.api('/api/trading/library/active', { method: 'GET' })).body.definitions.length, 0);
  const yes = await che.say('Yes, approve MACD signal-line cross');
  assert.match(yes.reply, /Approved MACD signal-line cross/);
  assert.match((await che.say('Enable the MACD signal-line cross strategy')).reply, /enabled for paper testing/);
  assert.deepEqual((await che.api('/api/trading/library/active', { method: 'GET' })).body.definitions.map((d) => d.id), ['macd-signal-cross']);
});

test('chat: compare names two real entries from recorded evidence, or asks which one', async () => {
  const che = await owner();
  const out = await che.say('Compare EMA pullback and VWAP reversion');
  assert.match(out.reply, /trend pullback to the 20 EMA: /i);
  assert.match(out.reply, /VWAP 2-sigma reversion: /);
  assert.match(out.reply, /no recorded backtest/);
  assert.equal(out.modelCalls, 0);
  assert.match((await che.say('Compare order block and silver bullet')).reply, /could mean .* Which one\?/);
});

test('chat: a plain-language strategy becomes a pending draft; an invalid draft saves nothing', async () => {
  const good = { schema: 'che.strategy/1', id: 'rsi-ny-open', name: 'RSI NY open', category: 'reversal', timeframes: [5], series: { rsi: { fn: 'rsi', period: 14 } },
    long: { conditions: [{ id: 'r', label: 'RSI crosses above 30', when: { cross_above: ['rsi', 30] } }, { id: 'w', label: 'NY open', when: { in_window: 'ny_open' } }], stop: { sub: ['low', 2] }, target: { r: 2 } } };
  const che = await owner({ model: () => `Here it is: ${JSON.stringify(good)}` });
  const out = await che.say('Add a strategy that buys when RSI crosses above 30 during the New York open');
  assert.match(out.reply, /I wrote that up as "RSI NY open".*waits for your approval/);
  assert.equal(out.modelCalls, 1);
  const lib = (await che.api('/api/trading/library?q=rsi%20ny', { method: 'GET' })).body;
  const e = lib.entries.find((x) => x.id === 'rsi-ny-open');
  assert.deepEqual([e.approval, e.enabled, e.sources[0].type], ['pending_owner', false, 'owner']);
  const bad = await owner({ model: () => 'I think you should buy low and sell high.' });
  const no = await bad.say('Add a strategy that goes long whenever the moon looks bright');
  assert.match(no.reply, /could not turn that into valid rules.*Nothing was saved/);
});

test('HTTP: owner only; register validates; enable of a built-in goes through the Strategy Control Center', async () => {
  const che = await owner();
  assert.ok([401, 403].includes((await che.call('/api/trading/library', { method: 'GET' })).status), 'no device token, no library');
  const bad = await che.api('/api/trading/library/register', { body: { entry: { ...ENTRY, definition: { ...DOC, long: { ...DOC.long, stop: undefined } } } } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.problems.join(' '), /stop is required/);
  const off = await che.api('/api/trading/library/disable', { body: { id: 'silver-bullet-5m' } });
  assert.equal(off.body.via, 'trading_controls');
  assert.equal(off.body.ok, true);
  const controls = (await che.api('/api/trading/controls', { method: 'GET' })).body;
  assert.equal(JSON.stringify(controls).includes('silver-bullet-5m'), true);
});
