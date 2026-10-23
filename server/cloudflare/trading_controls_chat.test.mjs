// Strategy Control Center through the real /api/chat and /api/trading/controls (owner, 2026-10-20):
// the owner's own words change limits, risk increases wait for "yes, confirm", Emergency Stop acts at
// once and says what it stopped and what remains open, and every change is audited. Paper only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';

const generated = new URL('./.trading_controls_chat.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch (_) { DatabaseSync = null; }
const sqlite = { skip: DatabaseSync ? false : 'node:sqlite unavailable' };

globalThis.fetch = async (input) => { throw new TypeError(`fetch failed (offline test: ${new URL(String(input?.url || input)).host})`); };

function storageFor(saved = new Map()) {
  const db = new DatabaseSync(':memory:');
  return {
    sql: { exec: (q, ...p) => { const stmt = db.prepare(q); return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []); } },
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

async function owner({ model = () => 'Here is the answer, sir.' } = {}) {
  let calls = 0;
  const pending = [];
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', 
    AI: { run: async (_model, opts = {}) => { calls += 1; return { response: model(opts) }; } },
  };
  const saved = new Map();
  const storage = storageFor(saved);
  const state = new CheState({ storage, waitUntil: (p) => pending.push(p) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const history = [];
  // RAGDBG=1 prints each turn (route and reply) while measuring before/after.
  const say = async (message, { as = token } = {}) => { const r = await say0(message, { as }); if (process.env.RAGDBG) console.error("DBG", JSON.stringify({ message, route: r.route, reply: r.reply.slice(0, 900) })); return r; };
  const say0 = async (message, { as = token } = {}) => {
    const before = calls;
    const res = await send('/api/chat', { message, history: history.slice(-8) }, as);
    const raw = await res.text();
    while (pending.length) await pending.shift();
    const events = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const done = events.find((e) => e.type === 'done') || {};
    const reply = events.filter((e) => e.type === 'delta').map((e) => e.delta).join('');
    history.push({ role: 'user', content: message }, { role: 'assistant', content: reply });
    return { status: res.status, reply, done, route: done.source || (calls > before ? 'model' : 'none'), modelCalls: calls - before };
  };
  const seedMemory = async (records) => {
    await say('Hello CHE.');
    const data = saved.get('che');
    data.memory_records = [...(data.memory_records || []), ...records];
    saved.set('che', data);
  };
  const api = async (path, method = 'GET', payload) => (await worker.fetch(new Request(`https://che.example${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(payload ? { body: JSON.stringify(payload) } : {}) }), env)).json();
  return { say, seedMemory, saved, api };
}


test('the owner\'s control words through /api/chat: change, confirm a risk increase, stop, Emergency Stop, skip reasons', sqlite, async () => {
  const che = await owner();
  const fresh = await che.api('/api/trading/controls');
  assert.ok(fresh.strategies.length >= 10);
  assert.ok(fresh.strategies.every((r) => r.max_per_day === 30), 'every strategy shows its 30-a-day default');
  assert.equal(fresh.paper_only, true);
  const ema = fresh.strategies.find((r) => r.id === 'ema-pullback-5m');
  assert.match(ema.rules, /20 EMA above the 50 EMA/);
  assert.match(ema.exit, /flat by 16:55 New York/);
  assert.equal(ema.paper.trades, 0);
  assert.equal(ema.paper.enough, false, 'no claim of a result before 30 trades');
  assert.deepEqual(ema.ict_concepts, [], 'the EMA pullback is not labelled ICT');
  const ob = fresh.strategies.find((r) => r.id === 'order-block-5m');
  assert.equal(ob.family, 'ICT');
  assert.ok(ob.ict_concepts.some((n) => /Order blocks/.test(n)) && ob.ict_concepts.some((n) => /Displacement/.test(n)));
  assert.equal(fresh.ict_concepts.find((k) => /London/.test(k.name)).implemented, false, 'an unimplemented ICT concept is said to be unimplemented');
  assert.equal(fresh.ict_concepts.find((k) => /Premium/.test(k.name)).implemented, false);
  assert.ok(fresh.strategies.every((r) => r.signals_today === 0 && r.entries_today === 0), 'daily maximum versus actual valid signals');

  const same = await che.say('Chey, set every strategy to 30 per day');
  assert.equal(same.route, 'che_trading_controls');
  assert.equal(same.modelCalls, 0);
  assert.match(same.reply, /already have maximum trades per day 30/);

  const ict = await che.say('pause the ICT strategy');
  assert.equal(ict.route, 'che_trading_controls');
  assert.match(ict.reply, /^Done, sir\. .*ICT Silver Bullet paused/);
  assert.equal(ict.done.open_view, 'trading_controls');

  const up = await che.say('increase the maximum trades');
  assert.equal(up.done.confirmation_needed, true);
  assert.match(up.reply, /This raises risk[\s\S]*up to 5 more paper entries a day \(30 → 35\)[\s\S]*Nothing has changed yet/);
  assert.equal((await che.api('/api/trading/controls')).strategies[0].max_per_day, 30, 'not applied before the yes');
  const yes = await che.say('yes, confirm');
  assert.equal(yes.route, 'che_trading_controls');
  assert.match(yes.reply, /^Done, sir\./);
  assert.ok((await che.api('/api/trading/controls')).strategies.every((r) => r.max_per_day === 35));

  const stop = await che.say('stop all new entries');
  assert.match(stop.reply, /New entries are stopped for every strategy/);
  const kill = await che.say('Emergency stop');
  assert.equal(kill.route, 'che_trading_controls');
  assert.equal(kill.done.confirmation_needed, false, 'Emergency Stop acts at once');
  assert.match(kill.reply, /unfilled order[s]? cancelled; 0 positions still open/);
  assert.match(kill.reply, /Alpaca PAPER is not connected/);

  const why = await che.say('why did this strategy skip that trade');
  assert.equal(why.route, 'che_trading_controls');
  assert.match(why.reply, /no skipped signal on record|latest skipped signal/);

  const view = await che.api('/api/trading/controls');
  assert.ok(view.strategies.every((r) => r.state === 'emergency stop'), 'the kill switch shows on every strategy');
  assert.deepEqual(view.audit.map((r) => r.action), ['emergency_stop', 'stop_entries', 'set', 'pause'], 'one audit record per applied change, newest first');
  assert.ok(view.audit.every((r) => r.who === 'owner (chat)' && r.at));
  assert.match(view.audit[0].summary, /still open/);

  const alpaca = await che.say('show me my Alpaca trades');
  assert.equal(alpaca.done.open_view, 'alpaca_paper', 'the Alpaca dashboard keeps its route');
});

test('/api/trading/controls: a raise without confirm changes nothing; with confirm it is applied and restorable', sqlite, async () => {
  const che = await owner();
  const ask = await che.api('/api/trading/controls', 'POST', { change: { kind: 'set', scope: 'ema-pullback-5m', field: 'qty', value: 3 } });
  assert.equal(ask.needs_confirmation, true);
  assert.match(ask.spoken, /3 times larger/);
  assert.equal(ask.view.strategies.find((r) => r.id === 'ema-pullback-5m').qty, 1);
  const done = await che.api('/api/trading/controls', 'POST', { change: { kind: 'set', scope: 'ema-pullback-5m', field: 'qty', value: 3 }, confirm: true });
  assert.equal(done.ok, true);
  assert.equal(done.view.strategies.find((r) => r.id === 'ema-pullback-5m').qty, 3);
  assert.equal(done.view.can_restore, true);
  const back = await che.api('/api/trading/controls', 'POST', { change: { kind: 'restore' } });
  assert.equal(back.ok, true);
  assert.equal(back.view.strategies.find((r) => r.id === 'ema-pullback-5m').qty, 1);
  assert.equal(done.view.audit[0].who, 'owner (iPhone)');
});

test('the strategy governor routes: view, owner pause with its log entry, why each setup was taken or skipped (paper only)', sqlite, async () => {
  const che = await owner();
  const view = await che.api('/api/trading/governor');
  assert.equal(view.live_trading, 'disabled: the governor never enables broker orders');
  assert.equal(view.settings.min_trades, 30);
  assert.ok(Array.isArray(view.strategies) && Array.isArray(view.allocation) && view.allocation.length >= 10);
  assert.match(view.spoken, /forward paper trades to judge yet/);
  const paused = await che.api('/api/trading/governor', 'POST', { action: 'pause', strategy: 'vwap-revert-5m', reason: 'owner test' });
  assert.equal(paused.ok, true);
  const log = await che.api('/api/trading/governor/decisions');
  assert.equal(log.decisions[0].action, 'pause');
  assert.equal(log.decisions[0].by, 'owner');
  assert.deepEqual((await che.api('/api/trading/governor/trades')).items, []);
  const bad = await che.api('/api/trading/governor', 'POST', { action: 'launch' });
  assert.equal(bad.ok, false);
});
