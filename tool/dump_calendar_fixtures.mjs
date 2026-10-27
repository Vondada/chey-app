// Writes test/fixtures/calendars/*.json: what the Worker's calendar routes answer (server/cloudflare/che_calendars.js)
// for one stored September 2026, so the Flutter calendar tests read the real response shape. Run: node tool/dump_calendar_fixtures.mjs
import { writeFileSync } from 'node:fs';
import { learningWindows, officeCalendar, tradingCalendar } from '../server/cloudflare/che_calendars.js';

const m = new Map([['gpu:seeded', '2026-01-01T00:00:00Z']]);
const storage = {
  get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => m.has(x)).map((x) => [x, structuredClone(m.get(x))])) : structuredClone(m.get(k))),
  put: async (k, v) => { m.set(k, structuredClone(v)); },
  delete: async (k) => m.delete(k),
  list: async ({ prefix = '' } = {}) => new Map([...m].filter(([k]) => String(k).startsWith(prefix))),
};
function rec(strategy, entry, exit, exitRaw, reason) {
  const pv = 2; const raw = 21000; const gross = (exitRaw - raw) * pv;
  const costs = { spread: 0.5, slippage: reason === 'target' ? 0.5 : 1, commissions: 3, fees: 1 };
  const net = Math.round((gross - costs.spread - costs.slippage - costs.commissions - costs.fees) * 100) / 100;
  return {
    source: 'paper', environment: 'paper', portfolio: `${strategy}|any@v1|2`, symbol: 'MNQ', contract: 'MNQ', qty: 1, strategy, filter: 'any', strategy_version: 'v1',
    params: { target_r: 2 }, side: 'long', session: 'mid-morning', signal: { time: entry, why: 'fixture', ref: raw },
    entry: { time: entry, raw, fill: raw + 0.375, spread: 0.125, slippage: 0.25, basis: 'next_bar_open' }, stop: raw - 10, target: raw + 20, risk_points: 10,
    exit: { time: exit, raw: exitRaw, fill: exitRaw - 0.125, reason }, gross_before_costs: gross, costs, net_pnl: net, r_net: Math.round((net / 20) * 10000) / 10000,
    risk_dollars: 20, mfe_points: 10, mae_points: 2, data: { resolution: '5m', label: 'intraday 5m bars, fills at the next open' }, cost_assumptions: {}, result: net > 0 ? 'win' : 'loss',
  };
}
for (const r of [
  rec('ema-pullback-5m', '2026-09-22T14:05:00Z', '2026-09-22T14:30:00Z', 21010, 'target'),
  rec('ema-pullback-5m', '2026-09-22T15:05:00Z', '2026-09-22T15:20:00Z', 20990, 'stop'),
  rec('orb-5m', '2026-09-22T16:05:00Z', '2026-09-22T16:40:00Z', 20500, 'stop'),
  rec('orb-5m', '2026-09-24T14:05:00Z', '2026-09-24T14:40:00Z', 21020, 'target'),
]) m.set(`evr:paper:${r.portfolio}:${r.entry.time}`, r);
const data = {
  team_tasks: [
    { id: 't1', task: 'Write the release notes', partner_name: 'Nova', status: 'complete', result: 'Notes saved to the mailbox.', created_at: '2026-09-22T14:00:00Z', updated_at: '2026-09-22T15:00:00Z' },
    { id: 't2', task: 'Check the deploy logs', partner_name: 'Atlas', status: 'failed', error: 'GitHub answered 403', created_at: '2026-09-22T16:00:00Z', updated_at: '2026-09-22T16:10:00Z' },
  ],
};
const dir = new URL('../test/fixtures/calendars/', import.meta.url);
const out = {
  trading_month: await tradingCalendar(storage, { month: '2026-09', source: 'paper' }),
  trading_day: await tradingCalendar(storage, { day: '2026-09-22', source: 'paper' }),
  trading_empty: await tradingCalendar(storage, { month: '2026-09', source: 'sim' }),
  learning: await learningWindows(storage, { now: Date.parse('2026-09-30T12:00:00Z') }),
  office_month: await officeCalendar(storage, data, { month: '2026-09' }),
  office_day: await officeCalendar(storage, data, { day: '2026-09-22' }),
};
for (const [name, value] of Object.entries(out)) writeFileSync(new URL(`${name}.json`, dir), `${JSON.stringify(value, null, 1)}\n`);
console.log(Object.keys(out).join(', '));
