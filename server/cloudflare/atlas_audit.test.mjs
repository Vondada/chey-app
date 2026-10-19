// Knowledge Atlas and trading answers, audit regressions (issue #346 audit). One test per defect, asked
// through the real /api/chat, offline, with a counted fake model: sizing answers the question asked and
// never a contract over budget, whole-number contract counts only, progress and study questions read the
// Brain instead of the model, a named lesson beats the evidence route, the paper journal and the evidence
// pass name their source and agree, a review drill on a generic word works, everyday words are not
// aliases, and the reset hold reads nothing. No order is placed and no broker is called.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';
import { ATLAS_CARDS, atlasIntent, findAtlasCard } from './knowledge_atlas.js';
import { tradingAtlasIntent } from './atlas_trading.js';
import { summarize } from './trading_evidence.js';

const generated = new URL('./.atlas_audit.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

const requests = [];
globalThis.fetch = async (input) => {
  requests.push(String(input?.url || input));
  throw new TypeError('fetch failed (atlas_audit tests are offline)');
};

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch (_) { DatabaseSync = null; }
const sqlite = { skip: DatabaseSync ? false : 'node:sqlite unavailable' };

// Key-value and SQLite storage, as the Durable Object has them. `journal` is seeded with closed paper trades.
function storageFor(saved = new Map()) {
  const db = DatabaseSync ? new DatabaseSync(':memory:') : null;
  return {
    sql: db ? { exec: (q, ...p) => { const stmt = db.prepare(q); return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []); } } : undefined,
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

// A paired owner phone; `say` returns the route, the reply and the model calls the turn took.
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

// Typed, spoken ("200 dollars", no punctuation) and with CHE's name in front.
const spokenOf = (phrase) => phrase.replace(/[.,?!]/g, '').replace(/\$(\d+)/g, '$1 dollars').replace(/\s+/g, ' ').trim().toLowerCase();
const variants = (phrase) => [phrase, spokenOf(phrase), `CHE, ${phrase}`];

// Closed paper trades in the journal's shape (trading_evidence.js), so the atlas and the evidence route read them.
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
const FORTY = [3, -1, -1, 3, -1, -1, 3, -1, -1, -1];
const forty = () => journal(Array.from({ length: 40 }, (_, i) => FORTY[i % FORTY.length]));

const calc = (out) => { assert.equal(out.modelCalls, 0, 'a calculation makes no model call'); return out; };

// ─── Defect 1: sizing answers "how many <contract> ... with $X risk and a N point stop" ─────────────

test('1. "how many MNQ can I trade risking $200 with a 10 point stop" is the largest whole number of contracts in the budget', async () => {
  const che = await owner();
  for (const words of [...variants('How many MNQ can I trade risking $200 with a 10 point stop?'), 'how many mnq can i trade risking two hundred dollars with a ten point stop',
    'How many MNQ can I trade with $200 risk and a 10 point stop?', 'How many MNQ can I risk $200 with a 10 point stop?', 'How many MNQ contracts for 200 dollars risk and a 10 point stop?']) {
    const out = calc(await che.say(words));
    assert.equal(out.route, 'che_knowledge_atlas', words);
    assert.match(out.reply, /^10 MNQ contracts, sir, risking \$200\.00 with a 10-point stop\. I placed and prepared no order; this is a calculation\./, words);
    assert.doesNotMatch(out.reply, /Your risk on 1 MNQ/, words);
  }
  // Without a stop there is nothing to size: the reply asks for it, and does not read it as a risk of one contract.
  const noStop = calc(await che.say('How many MNQ can I trade risking 200 dollars?'));
  assert.equal(noStop.route, 'che_knowledge_atlas');
  assert.match(noStop.reply, /a stop distance above zero is needed/);
  assert.doesNotMatch(noStop.reply, /Your risk on/);
});

// ─── Defect 2: a risk that does not fit is never shown as a contract ──────────────────────────────

test('2. a contract over the budget is not shown: "no contract fits", with the risk of one contract as the reason', async () => {
  const che = await owner();
  for (const words of variants('How many MNQ can I trade risking $25 with a 20 point stop?')) {
    const out = calc(await che.say(words));
    assert.equal(out.route, 'che_knowledge_atlas', words);
    assert.match(out.reply, /^No MNQ contract fits, sir: one contract risks \$40\.00 with a 20-point stop, more than the \$25\.00 budget\./, words);
    assert.doesNotMatch(out.reply, /^1 MNQ contract|\$40\.00 on 1 contract|Your risk on 1/, words);
  }
});

// ─── Defect 3: contract counts are whole positive numbers ─────────────────────────────────────────

test('3. "1.5 MNQ", "2.5 MNQ" and "-2 MNQ" are refused: nothing is calculated and the counts are not changed', async () => {
  const che = await owner();
  const refused = [
    ['what is my risk on 1.5 MNQ with a 10 point stop?', /Contracts are whole numbers, sir, and nothing was calculated for a fraction of a contract \(1\.5 MNQ\)\./],
    ['How many 2.5 MNQ can I trade risking $200 with a 10 point stop?', /Contracts are whole numbers, sir, and nothing was calculated for a fraction of a contract \(2\.5 MNQ\)\./],
    ['what is my risk on -2 MNQ with a 10 point stop?', /Contracts are whole positive numbers, sir, and nothing was calculated for -2 MNQ\./],
    ['How many -2 MNQ can I trade risking $200 with a 10 point stop?', /Contracts are whole positive numbers, sir, and nothing was calculated for -2 MNQ\./],
    ['Is this a good trade: long 2.5 MNQ at 18000, stop 17990, target 18030?', /Contracts are whole numbers, sir, and nothing was calculated for a fraction of a contract \(2\.5 MNQ\)\./],
  ];
  for (const [words, want] of refused) {
    const out = calc(await che.say(words));
    assert.equal(out.route, 'che_knowledge_atlas', words);
    assert.match(out.reply, want, words);
    assert.match(out.reply, /I placed and prepared no order/, words);
    assert.doesNotMatch(out.reply, /Your risk on|contracts?, sir, risking|Verdict/, `${words}: no number was calculated`);
  }
  // The intent itself: a fraction never reaches the calculator as 1 or 2 contracts.
  assert.equal(tradingAtlasIntent('what is my risk on 1.5 mnq with a 10 point stop')?.kind, 't_count');
  assert.equal(tradingAtlasIntent('what is my risk on 2 mnq with a 10 point stop')?.inputs?.contracts, 2, 'a whole count is still read');
});

// ─── Defect 4: progress and study questions are answered from the Brain, never by the model ──────

test('4. "how much have I learned" and "what have I learned" are answered from the Brain records; none are recorded, or the real counts', sqlite, async () => {
  const che = await owner();
  const cold = calc(await che.say('how much have I learned', { history: [] }));
  assert.equal(cold.route, 'che_knowledge_atlas');
  assert.match(cold.reply, /^No lessons recorded yet, sir\./);
  const lesson = calc(await che.say('teach me recursion'));
  assert.equal(lesson.route, 'che_knowledge_atlas');
  const progress = calc(await che.say('how much have I learned', { history: [{ role: 'assistant', content: lesson.reply }] }));
  assert.match(progress.reply, /^Your Knowledge Atlas progress, sir, measured from this chat: 1 lesson studied, on 1 of \d+ cards/, progress.reply);
  assert.doesNotMatch(progress.reply, /MODEL ANSWERED/);
  // A progress question about something else keeps the model (the counter-case).
  assert.notEqual((await che.say('what have I learned about the apartment lease', { history: [] })).route, 'che_knowledge_atlas');
});

// ─── Defect 5: a named lesson beats the evidence route; the owner's own win rate does not ─────────

test('5. "teach me win rate uncertainty" and "what is a win rate confidence interval" are lessons; "what is my win rate" stays with the record', async () => {
  const che = await owner();
  for (const words of ['teach me win rate uncertainty', 'what is a win rate confidence interval', 'what is the win rate confidence interval']) {
    const out = calc(await che.say(words));
    assert.equal(out.route, 'che_knowledge_atlas', words);
    assert.equal(out.done.atlas_card, 'win-rate-ci', words);
    assert.match(out.reply, /^Win rate and its confidence interval, beginner level, sir\./, words);
  }
  for (const words of ['what is my win rate', "what's my win rate", 'what is win rate']) {
    assert.equal((await che.say(words)).route, 'che_trading_evidence', words);
  }
});

// ─── Defect 6: the win rate and the expectancy agree on the paper journal, and each names its source ─

test('6. with 40 paper trades in the journal, the win rate and the expectancy agree and name CHE\'s paper journal', sqlite, async () => {
  const trades = forty();
  const che = await owner({ saved: store(trades) });
  const s = summarize(trades);
  const win = calc(await che.say('what is my win rate'));
  assert.equal(win.route, 'che_trading_evidence');
  assert.match(win.reply, /^Paper trades, from CHE's evidence pass .*none recorded yet\.\nRecorded in total: 0 /, win.reply);
  assert.match(win.reply, /Win rate, sir, from CHE's paper journal \(delayed forward-paper data\), since the evidence pass has recorded no trades/, win.reply);
  assert.match(win.reply, /40 closed paper trades in 1 paper portfolio/, win.reply);
  assert.match(win.reply, new RegExp(`${s.wins} wins in ${s.trades}, a win rate of ${s.win_rate}%`), win.reply);
  assert.doesNotMatch(win.reply, /No trading evidence has been recorded yet/, 'the journal has trades');
  const exp = calc(await che.say('what is my expectancy'));
  assert.match(exp.reply, /from delayed forward-paper data in CHE's paper journal, after assumed costs: 40 closed paper trades/, exp.reply);
  // With no evidence pass, an empty journal is still said plainly.
  const empty = await owner();
  assert.match((await empty.say('what is my win rate')).reply, /^No trading evidence has been recorded yet, sir/);
});

// ─── Defect 7: a review drill on a generic word ──────────────────────────────────────────────────

test('7. "give me a review drill on security" is a drill on the secure coding card, as "secure coding" is', async () => {
  const che = await owner();
  for (const words of ['give me a review drill on security', 'give me a review drill on secure coding']) {
    const out = calc(await che.say(words));
    assert.equal(out.route, 'che_knowledge_atlas', words);
    assert.equal(out.done.atlas_kind, 'coding_drill', words);
    assert.equal(out.done.atlas_card, 'c-security', words);
  }
  // A generic word still is not a lesson: "explain security" is not a coding card.
  assert.equal(atlasIntent('explain security'), null);
});

// ─── Defect 8: everyday words are not lesson aliases ──────────────────────────────────────────────

test('8. "tell me about recovery", "what is recovery", "explain the ci checks" are not lessons; the qualified names still are', async () => {
  const che = await owner();
  for (const words of ['tell me about recovery', 'what is recovery', 'explain recovery', 'tell me about the recovery', 'explain the ci checks', 'explain the required checks']) {
    const out = await che.say(words);
    assert.notEqual(out.route, 'che_knowledge_atlas', `${words} → ${out.reply.slice(0, 80)}`);
    assert.equal(atlasIntent(words), null, words);
  }
  assert.equal((await che.say('tell me about job recovery')).done.atlas_card, 'c-recovery');
  assert.equal((await che.say('explain ci checks')).done.atlas_card, 'c-ci-validation', 'a general CI lesson is still a lesson');
});

test('8b. no single-word alias is an everyday word, and every single-word alias has been reviewed', () => {
  const GENERIC = ['inspection', 'performance', 'security', 'architecture', 'profiling', 'latency', 'cache', 'caching', 'stack', 'queue', 'dict', 'dynamic', 'module', 'resumable', 'resuming', 'indentation', 'widget', 'reading', 'reasoning', 'recovery'];
  const single = new Map();
  for (const c of ATLAS_CARDS) for (const a of c.aliases) if (!/[\s-]/.test(a)) single.set(a, c.id);
  for (const word of GENERIC) assert.equal(single.has(word), false, `"${word}" is an everyday word and cannot be an alias on its own`);
  // Any new single-word alias must be added here on purpose, so an everyday word cannot slip in.
  const REVIEWED = new Set(['variables', 'variable', 'loops', 'loop', 'iteration', 'functions', 'function', 'scope', 'closures', 'closure', 'testing', 'tests', 'tdd', 'recursion', 'recursive', 'hashmap', 'hashmaps', 'hashing', 'sorting', 'sort', 'mergesort', 'http', 'apis', 'api', 'concurrency', 'async', 'asynchronous', 'parallelism', 'amdahl', 'python', 'typescript', 'javascript', 'js', 'dart', 'flutter', 'setstate', 'html', 'css', 'git', 'arrays', 'bfs', 'dfs', 'dp', 'memoization', 'memoisation', 'tabulation', 'databases', 'database', 'sql', 'indexes', 'indexing', 'sqlite', 'cloudflare', 'debugging', 'debug', 'modularity', 'ssrf', 'deployment', 'deploying', 'invariants', 'invariant', 'checkpoints', 'checkpoint', 'checkpointing', 'failover', 'backoff', 'idempotency', 'idempotent', 'spread', 'spreads', 'slippage', 'sizing', 'risk', 'expectancy', 'drawdown', 'drawdowns', 'mdd', 'vwap', 'overfitting', 'oco', 'stocks', 'stock', 'options', 'rvol', 'bos', 'choch', 'mss', 'liquidity', 'fvg', 'fvgs', 'ote', 'pdh', 'pdl', 'killzones', 'journaling', 'mae', 'mfe', 'survivorship', 'repainting']);
  for (const word of single.keys()) assert.ok(REVIEWED.has(word), `"${word}" is a new single-word alias: review it, then add it to REVIEWED`);
  for (const word of REVIEWED) assert.ok(single.has(word), `"${word}" is in REVIEWED but no card has it: remove it`);
});

// ─── Defect 9: the reset hold reads nothing ───────────────────────────────────────────────────────

test('9. "CHE reset my knowledge atlas progress" is held with no reading model call, after a conversation too', async () => {
  const che = await owner();
  const history = [{ role: 'user', content: 'teach me loops' }, { role: 'assistant', content: 'Loops, beginner level, sir. Source: Knowledge Atlas card "Loops" (coding).' }];
  for (const h of [[], history]) {
    const out = await che.say('CHE reset my knowledge atlas progress', { history: h });
    assert.equal(out.route, 'held');
    assert.equal(out.modelCalls, 0, 'the hold is fixed, not read by the model');
    assert.match(out.reply, /Before I delete anything, I need your yes: delete your \d+ Knowledge Atlas practice records/);
  }
});

test('the audit: no atlas turn in these tests reached the network', () => {
  assert.equal(requests.length, 0);
  assert.equal(findAtlasCard('recovery'), null, 'the bare word names no card');
  assert.equal(summarize([]).trades, 0);
});
