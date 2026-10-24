// CHE's two calendars (che_calendars.js): the trading P&L calendar per source, the learning windows and the
// Office calendar, all computed from stored records. Nothing here is sample data: an empty store is an empty month.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import {
  BREAK_EVEN, calendarDay, calendarIntent, dayColor, learningWindows, monthGrid, officeCalendar, officeState, shiftMonth,
  speakOfficeCalendar, speakTradingCalendar, tradingCalendar,
} from './che_calendars.js';

globalThis.fetch = async (input) => { throw new TypeError(`fetch failed (offline test: ${new URL(String(input?.url || input)).host})`); };

const memStorage = (m = new Map()) => ({
  saved: m,
  get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => m.has(x)).map((x) => [x, structuredClone(m.get(x))])) : structuredClone(m.get(k))),
  put: async (k, v) => { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) m.set(a, structuredClone(b)); else m.set(k, structuredClone(v)); },
  delete: async (k) => m.delete(k),
  list: async ({ prefix = '' } = {}) => new Map([...m].filter(([k]) => String(k).startsWith(prefix))),
});

// A forward paper record shaped like trading_evidence closeAt (long MNQ, 1 contract, costs on the record).
function rec({ strategy = 'ema-pullback-5m', res = '5m', entry, exit, raw = 21000, exitRaw = 21010, reason = 'target', market } = {}) {
  const pv = 2; const half = 0.125; const slip = 0.25;
  const gross = Math.round((exitRaw - raw) * pv * 100) / 100;
  const costs = { spread: half * 2 * pv, slippage: (slip + (reason === 'target' ? 0 : slip)) * pv, commissions: 3, fees: 1 };
  const net = Math.round((gross - costs.spread - costs.slippage - costs.commissions - costs.fees) * 100) / 100;
  return {
    source: 'paper', environment: 'paper', portfolio: `${strategy}|any@v1|2`, symbol: market === 'crypto' ? 'ETH-USD' : 'MNQ', contract: 'MNQ', qty: 1, ...(market ? { market } : {}),
    strategy, filter: 'any', strategy_version: 'v1', params: { target_r: 2 }, side: 'long', session: 'mid-morning',
    signal: { time: entry, why: 'pullback', ref: raw },
    entry: { time: entry, raw, fill: raw + half + slip, spread: half, slippage: slip, basis: 'next_bar_open' },
    stop: raw - 10, target: raw + 20, risk_points: 10,
    exit: { time: exit, raw: exitRaw, fill: exitRaw - half, reason },
    gross_before_costs: gross, costs, net_pnl: net, r_net: Math.round((net / (10 * pv)) * 10000) / 10000, risk_dollars: 20,
    mfe_points: 10, mae_points: 2, data: { resolution: res, label: `intraday ${res} bars, fills at the next open` }, cost_assumptions: {},
    result: net > 0 ? 'win' : net < 0 ? 'loss' : 'flat',
  };
}
const put = (m, r, key = `evr:paper:${r.portfolio}:${r.entry.time}`) => m.set(key, r);
const simTrade = (strategy, symbol, entry, exit, r) => ({ id: `${strategy}|${symbol}|${entry}`, strategy, symbol, label: symbol, entry_t: entry, entry_raw: 100, entry: 100, stop: 99, target: 102, exit_t: exit, exit_raw: 100 + r, exit: 100 + r, exit_reason: r > 0 ? 'target' : 'stop', r });
const putSim = (m, trades) => { m.set('strategy_sim_state', { trades: { first: 0, last: 0, tail: trades.length, stored: trades.length, dropped: 0 }, symbols: {} }); m.set('strategy_sim_trades:0', trades); };

test('September 22, 2026: the day\'s P&L is the sum of its stored rows; a duplicate record is reported, never counted twice', async () => {
  const m = new Map();
  const a = rec({ entry: '2026-09-22T14:05:00Z', exit: '2026-09-22T14:30:00Z', exitRaw: 21010 }); // +15.00
  const b = rec({ entry: '2026-09-22T15:05:00Z', exit: '2026-09-22T15:20:00Z', exitRaw: 20990, reason: 'stop' }); // -25.50
  const c = rec({ strategy: 'orb-5m', entry: '2026-09-22T16:05:00Z', exit: '2026-09-22T16:40:00Z', exitRaw: 20500, reason: 'stop' }); // -1,005.50
  for (const r of [a, b, c]) put(m, r);
  put(m, b, `evr:paper:${b.portfolio}:${b.entry.time}:copy`); // the same trade stored twice
  put(m, rec({ res: 'daily', entry: '2026-09-22T13:30:00Z', exit: '2026-09-22T20:00:00Z', exitRaw: 21400 })); // daily-bar research: not the forward paper journal
  putSim(m, [simTrade('rsi2-dip|any|1.5', 'ETH-USD', '2026-09-22T14:00:00Z', '2026-09-22T14:09:00Z', 1.5)]);
  const s = memStorage(m);

  const day = await tradingCalendar(s, { day: '2026-09-22', source: 'paper' });
  assert.equal(day.ok, true);
  assert.equal(day.totals.trades, 3);
  const expected = Math.round((a.net_pnl + b.net_pnl + c.net_pnl) * 100) / 100;
  assert.equal(day.totals.net, expected);
  assert.equal(day.totals.net, -1016);
  assert.equal(day.audit.sum, day.trades.reduce((x, t) => x + t.net, 0));
  assert.equal(day.audit.duplicates_not_counted, 1);
  assert.equal(day.color, 'red');
  assert.equal(day.unit, 'USD');
  for (const t of day.trades) { assert.match(t.id, /^T[0-9A-Z]{13}$/); assert.equal(t.replay, true); }
  assert.deepEqual(day.strategies.map((x) => x.strategy).sort(), ['ema-pullback-5m', 'orb-5m']);

  // Simulation is R only and never mixed into the dollar calendar.
  const sim = await tradingCalendar(s, { day: '2026-09-22', source: 'sim' });
  assert.equal(sim.unit, 'R');
  assert.equal(sim.totals.trades, 1);
  assert.equal(sim.totals.net, 1.5);
  assert.equal(sim.trades[0].net, null);

  // Broker: no fills stored, so no P&L; never a number made up.
  const broker = await tradingCalendar(s, { month: '2026-09', source: 'broker' });
  assert.equal(broker.totals.net, null);
  assert.equal(broker.empty, true);
  assert.equal(broker.fills_kept.fills, 0);
  assert.match(broker.note, /Paper account; no money at risk/);

  const month = await tradingCalendar(s, { month: '2026-09', source: 'paper' });
  assert.equal(month.totals.net, -1016);
  assert.equal(month.totals.red_days, 1);
  const week = month.weeks.find((w) => w.days.some((d) => d.date === '2026-09-22'));
  assert.equal(week.net, -1016);
  assert.equal(week.trades, 3);
  assert.match(speakTradingCalendar(month), /3 closed trades, 1 wins and 2 losses.*minus \$1,016\.00/);
  assert.equal((await tradingCalendar(s, { source: 'all' })).status, 400, 'sources are never summed');
});

test('time zone: a trade closing at 11:30 PM Chicago counts on that Chicago day; the CME basis rolls it to the next trading day', async () => {
  const exit = '2026-09-23T04:30:00Z'; // 11:30 PM CDT on Sept 22; 12:30 AM New York on Sept 23
  const t = { exit_time: exit };
  assert.equal(calendarDay(t, { tz: 'America/Chicago' }), '2026-09-22');
  assert.equal(calendarDay(t, { tz: 'UTC' }), '2026-09-23');
  assert.equal(calendarDay(t, { basis: 'cme' }), '2026-09-23');
  const m = new Map();
  put(m, rec({ entry: '2026-09-23T04:00:00Z', exit, exitRaw: 21010 }));
  const s = memStorage(m);
  const owner = await tradingCalendar(s, { day: '2026-09-22', source: 'paper' });
  assert.equal(owner.totals.trades, 1);
  assert.equal(owner.time_zone, 'America/Chicago');
  assert.equal(owner.audit.other_basis.rows, 0, 'by the CME day it belongs to the 23rd, and the audit says so');
  assert.equal((await tradingCalendar(s, { day: '2026-09-23', source: 'paper', basis: 'cme' })).totals.trades, 1);
  assert.equal((await tradingCalendar(s, { day: '2026-09-22', source: 'paper', env: { CHE_OWNER_TIMEZONE: 'UTC' } })).totals.trades, 0);
});

test('month grid and navigation: Monday-first weeks, every day once, and the year boundary', () => {
  const weeks = monthGrid('2026-09');
  assert.equal(weeks.flat().length, 30);
  assert.deepEqual(weeks[0], ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06']);
  assert.equal(weeks[1][0], '2026-09-07');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(monthGrid('2028-02').flat().length, 29);
});

test('colors: green profit, red loss, yellow near break-even, nothing for an empty day', () => {
  assert.equal(dayColor(120, 'USD', 2), 'green');
  assert.equal(dayColor(-120, 'USD', 2), 'red');
  assert.equal(dayColor(BREAK_EVEN.USD - 1, 'USD', 1), 'yellow');
  assert.equal(dayColor(-0.05, 'R', 1), 'yellow');
  assert.equal(dayColor(null, 'USD', 0), null);
});

test('empty store: an empty month, no sample trades, and it says so', async () => {
  // gpu:seeded: the Creation queue already seeded its own first jobs, so an empty store holds no job at all.
  const s = memStorage(new Map([['gpu:seeded', '2026-01-01T00:00:00Z']]));
  const v = await tradingCalendar(s, { month: '2026-10', source: 'paper' });
  assert.equal(v.empty, true);
  assert.equal(v.totals.trades, 0);
  assert.equal(v.totals.net, null);
  assert.ok(v.weeks.flatMap((w) => w.days).every((d) => d.trades === 0 && d.color === null));
  assert.match(speakTradingCalendar(v), /no trade closed in 2026-10/);
  const o = await officeCalendar(s, {}, { month: '2026-10' });
  assert.equal(o.empty, true);
  assert.equal(speakOfficeCalendar(o), 'No Office work is recorded in 2026-10.');
  const l = await learningWindows(s, { now: Date.parse('2026-10-24T12:00:00Z') });
  assert.deepEqual(l.rows, []);
});

test('learning windows: 7/30/90 days per strategy, old vs new on equal lengths, insufficient evidence below 30 trades', async () => {
  const now = Date.parse('2026-10-24T12:00:00Z');
  const m = new Map();
  const day = (d, h) => new Date(now - d * 86_400_000 + h * 60_000).toISOString();
  // 35 losing-ish trades 31-60 days ago, 35 better trades in the last 30 days.
  for (let i = 0; i < 35; i++) put(m, rec({ entry: day(31 + (i % 25), i), exit: day(31 + (i % 25), i + 5), exitRaw: i % 3 === 0 ? 21010 : 20990, reason: i % 3 === 0 ? 'target' : 'stop' }));
  for (let i = 0; i < 35; i++) put(m, rec({ entry: day(1 + (i % 25), i), exit: day(1 + (i % 25), i + 5), exitRaw: i % 3 === 0 ? 20990 : 21010, reason: i % 3 === 0 ? 'stop' : 'target' }));
  put(m, rec({ strategy: 'orb-5m', entry: day(2, 0), exit: day(2, 10), exitRaw: 21010 }));
  const s = memStorage(m);
  const v = await learningWindows(s, { now });
  const ema = v.rows.find((r) => r.strategy === 'ema-pullback-5m' && r.source === 'paper');
  const w30 = ema.windows.find((w) => w.days === 30);
  assert.equal(w30.now.trades, 35);
  assert.equal(w30.before.trades, 35);
  assert.equal(w30.verdict, 'improving');
  assert.ok(w30.now.net > w30.before.net);
  assert.ok(w30.now.profit_factor > w30.before.profit_factor);
  assert.equal(ema.windows.find((w) => w.days === 7).verdict, 'insufficient evidence');
  const orb = v.rows.find((r) => r.strategy === 'orb-5m');
  assert.equal(orb.windows[0].verdict, 'insufficient evidence');
  assert.equal(orb.windows[0].needs, 29);
  assert.match(orb.out_of_sample.basis, /out of sample/);
});

test('Office calendar: real jobs and tasks per day with receipts, colors from their outcomes, and who finished what', async () => {
  const s = memStorage(new Map([['che_reliability_ledger', { totals: {}, rows: [{ at: '2026-09-22T15:00:00Z', kind: 'job', outcome: 'completed' }, { at: '2026-09-22T16:00:00Z', kind: 'job', outcome: 'failed' }] }]]));
  const data = {
    team_tasks: [
      { id: 't1', task: 'Write the release notes', partner_name: 'Nova', status: 'complete', result: 'Notes saved to the mailbox.', created_at: '2026-09-22T14:00:00Z', updated_at: '2026-09-22T15:00:00Z' },
      { id: 't2', task: 'Check the deploy logs', partner_name: 'Atlas', status: 'failed', error: 'GitHub answered 403', created_at: '2026-09-22T16:00:00Z', updated_at: '2026-09-22T16:10:00Z' },
      { id: 't3', task: 'Draft the newsletter', partner_name: 'Lyra', status: 'complete', created_at: '2026-09-23T14:00:00Z', updated_at: '2026-09-23T15:00:00Z' },
      { id: 't4', task: 'Research suppliers', partner_name: 'Mira', status: 'running', created_at: '2026-09-24T14:00:00Z', updated_at: '2026-09-24T14:00:00Z' },
    ],
    objectives: [{ id: 'o1', objective: 'Ship the calendars', status: 'complete', created_at: '2026-09-21T14:00:00Z', updated_at: '2026-09-23T18:00:00Z', nodes: [{ status: 'complete' }, { status: 'complete' }] }],
    action_approvals: [{ id: 'a1', tool: 'gmail_send', status: 'pending', created_at: '2026-09-24T15:00:00Z' }],
  };
  const v = await officeCalendar(s, data, { month: '2026-09' });
  const day = (d) => v.weeks.flatMap((w) => w.days).find((x) => x.date === d);
  assert.equal(day('2026-09-22').color, 'red');
  assert.equal(day('2026-09-22').done, 1);
  assert.equal(day('2026-09-22').failed, 1);
  assert.deepEqual(day('2026-09-22').reliability, { completed: 1, failed: 1 });
  assert.equal(day('2026-09-23').color, 'green');
  assert.equal(day('2026-09-23').milestones, 1);
  assert.equal(day('2026-09-24').color, 'yellow');
  assert.equal(day('2026-09-24').approvals, 1);
  assert.equal(day('2026-09-25').color, null);
  assert.equal(v.totals.total, 6);

  const d22 = await officeCalendar(s, data, { day: '2026-09-22' });
  assert.deepEqual(d22.items.map((i) => i.id), ['t1', 't2']);
  assert.equal(d22.items[0].receipt, 'Notes saved to the mailbox.');
  assert.equal(d22.items[1].error, 'GitHub answered 403');
  assert.deepEqual(d22.items[1].link, { screen: 'office_task', id: 't2' });
  assert.deepEqual(d22.accomplishments, [{ agent: 'Nova', done: 1, titles: ['Write the release notes'] }]);
  assert.match(speakOfficeCalendar(d22), /On 2026-09-22: 1 done, 0 active, 0 pending, 1 failed; finished by Nova 1/);
  assert.equal(officeState('awaiting_approval'), 'pending');
  assert.equal(officeState('dead_letter'), 'failed');
});

test('voice: the owner\'s words open the right calendar', () => {
  const now = Date.parse('2026-10-24T17:00:00Z');
  assert.deepEqual(calendarIntent('CHE, open my trading calendar', { now }), { kind: 'trading', month: '', source: 'paper' });
  assert.deepEqual(calendarIntent('show the P&L calendar for the simulation', { now }), { kind: 'trading', month: '', source: 'sim' });
  assert.deepEqual(calendarIntent('show the office calendar for September', { now }), { kind: 'office', month: '2026-09' });
  assert.deepEqual(calendarIntent('what did we do yesterday?', { now }), { kind: 'office', day: '2026-10-23' });
  assert.equal(calendarIntent('add a dentist appointment to my calendar', { now }), null);
  assert.equal(calendarIntent('how is trading going', { now }), null);
});

test('routes: the owner reads both calendars through the Worker; a bad source is a 400', async () => {
  const generated = new URL('./.che_calendars.test.generated.mjs', import.meta.url);
  writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
    "import { DurableObject } from 'cloudflare:workers';", 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'), 'utf8');
  let mod;
  try { mod = await import(`${generated.href}?t=${Date.now()}`); } finally { try { unlinkSync(generated); } catch (_) {} }
  const { default: worker, CheState } = mod;
  const saved = new Map();
  const storage = { ...memStorage(saved), setAlarm: async () => {}, deleteAlarm: async () => {} };
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1' };
  const state = new CheState({ storage, waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, { method = 'GET', body, token = '' } = {}) => worker.fetch(new Request(`https://che.example${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), env);
  const token = (await (await send('/api/pair', { method: 'POST', body: { code: '123456' } })).json()).device_token;
  put(saved, rec({ entry: '2026-09-22T14:05:00Z', exit: '2026-09-22T14:30:00Z' }));
  const cal = await (await send('/api/trading/calendar?month=2026-09&source=paper', { token })).json();
  assert.equal(cal.ok, true);
  assert.equal(cal.totals.trades, 1);
  assert.equal(cal.totals.net, 15);
  assert.equal((await send('/api/trading/calendar?source=everything', { token })).status, 400);
  const learn = await (await send('/api/trading/learning', { token })).json();
  assert.equal(learn.ok, true);
  const office = await (await send('/api/office/calendar?month=2026-09', { token })).json();
  assert.equal(office.ok, true);
  assert.equal(office.time_zone, 'America/Chicago');
  assert.notEqual((await send('/api/trading/calendar?month=2026-09')).status, 200, 'no device, no calendar');
  // The owner's spoken words reach the calendars with no model.
  for (const [said, view] of [['Open my trading calendar.', 'trading_calendar'], ['Show the office calendar for September', 'office_calendar'], ['What did we do yesterday?', 'office_calendar']]) {
    const raw = await (await send('/api/chat', { method: 'POST', body: { message: said, history: [] }, token })).text();
    const done = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === 'done') || {};
    assert.equal(done.source, 'che_calendars', said);
    assert.equal(done.open_view, view, said);
    assert.equal(done.model_calls, 0, said);
  }
  // September 22 reconciliation by voice: the audit with that day three ways, and the day page on the CME basis.
  const chat = async (said) => (await (await send('/api/chat', { method: 'POST', body: { message: said, history: [] }, token })).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === 'done') || {};
  const audit = await chat('CHE, audit September 22');
  assert.equal(audit.source, 'che_trading_visual');
  assert.equal(audit.visual.day, '2026-09-22');
  assert.equal(audit.model_calls, 0);
  const cme = await chat('Show the trading calendar for September 22 by CME day');
  assert.equal(cme.source, 'che_calendars');
  assert.deepEqual([cme.calendar.day, cme.calendar.basis], ['2026-09-22', 'cme']);
});

test('broker: Alpaca PAPER fills are kept once each, and the calendar shows realized P&L on the closing fill\'s day', async () => {
  const { storeAlpacaFills, realizedClosesFromFills } = await import('./broker_alpaca.js');
  const s = memStorage();
  const fill = (id, side, qty, price, time) => ({ id, order_id: `o-${id}`, symbol: 'AAPL', side, qty, price, time });
  const fills = [fill('f1', 'buy', 10, 200, '2026-09-22T14:00:00Z'), fill('f2', 'sell', 4, 205, '2026-09-22T15:00:00Z'), fill('f3', 'sell', 6, 190, '2026-09-23T15:00:00Z')];
  assert.deepEqual(await storeAlpacaFills(s, fills.slice(0, 2)), { added: 2, total: 2 });
  assert.deepEqual(await storeAlpacaFills(s, fills), { added: 1, total: 3 }, 'a re-read adds only the new fill');
  assert.deepEqual(realizedClosesFromFills(fills).map((c) => c.pnl), [20, -60]);
  const month = await tradingCalendar(s, { month: '2026-09', source: 'broker', env: { CHE_OWNER_TIMEZONE: 'America/New_York' } });
  const cells = Object.fromEntries(month.weeks.flatMap((w) => w.days).map((d) => [d.date, d]));
  assert.deepEqual([cells['2026-09-22'].net, cells['2026-09-22'].color, cells['2026-09-23'].net, cells['2026-09-23'].color], [20, 'yellow', -60, 'red']);
  assert.equal(month.totals.net, -40);
  assert.equal(month.fills_kept.fills, 3);
  const day = await tradingCalendar(s, { day: '2026-09-23', source: 'broker', env: { CHE_OWNER_TIMEZONE: 'America/New_York' } });
  assert.equal(day.trades.length, 1);
  assert.deepEqual([day.trades[0].entry_price, day.trades[0].exit_price, day.trades[0].net, day.trades[0].evidence_label], [200, 190, -60, 'BROKER-CONFIRMED (PAPER)']);
});

test('Office rollup: finished work outlives the 120-row job list; days before the rollup say "no record kept"', async () => {
  const s = memStorage();
  const now = Date.parse('2026-10-20T12:00:00Z');
  const data = { team_tasks: [
    { id: 't1', task: 'Write the release notes', partner_name: 'Nova', status: 'complete', result: 'Notes saved.', created_at: '2026-10-18T14:00:00Z', updated_at: '2026-10-18T15:00:00Z' },
    { id: 't2', task: 'Check the deploy logs', partner_name: 'Atlas', status: 'failed', error: 'GitHub answered 403', created_at: '2026-10-19T16:00:00Z', updated_at: '2026-10-19T16:10:00Z' },
    { id: 't3', task: 'Research suppliers', partner_name: 'Mira', status: 'running', created_at: '2026-10-19T17:00:00Z', updated_at: '2026-10-19T17:00:00Z' },
  ] };
  await officeCalendar(s, data, { month: '2026-10', now });
  // Only finished and failed work is kept, once each, on its own day.
  assert.deepEqual(s.saved.get('office_day:2026-10-18').items.map((x) => x.id), ['t1']);
  assert.deepEqual(s.saved.get('office_day:2026-10-19').items.map((x) => [x.id, x.state]), [['t2', 'failed']]);
  await officeCalendar(s, data, { month: '2026-10', now });
  assert.equal(s.saved.get('office_day:2026-10-18').items.length, 1, 'a second read adds nothing');
  // The live lists drop them (as cloudJobs' cap would); the month still shows them, from the rollup.
  const later = await officeCalendar(s, { team_tasks: [] }, { month: '2026-10', now: now + 86_400_000 });
  const cell = (d) => later.weeks.flatMap((w) => w.days).find((x) => x.date === d);
  assert.deepEqual([cell('2026-10-18').done, cell('2026-10-19').failed, cell('2026-10-19').color], [1, 1, 'red']);
  const d18 = await officeCalendar(s, { team_tasks: [] }, { day: '2026-10-18', now });
  assert.equal(d18.items[0].receipt, 'Notes saved.');
  // Before the rollup began, an empty day says so instead of looking like a quiet day.
  assert.equal(cell('2026-10-01').record, 'no record kept');
  assert.equal(cell('2026-10-21').record, null);
});
