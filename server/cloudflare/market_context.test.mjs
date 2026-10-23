// Market context (owner, 2026-10-23). Every bar and calendar page here is a TEST FIXTURE: these tests prove the machinery
// (timestamps, availability, no look-ahead, DST, statistics, costs, append-only storage, labels), never a market reaction.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EVENT_KINDS, MIN_EVENTS, STAGES, annotationsFor, appendEvents, addSource, contextIntent, contextModels, contextView, dayRegimes, eventProblems,
  eventStudy, fedCycleOn, icsEvents, kindOfRelease, knownPriceAt, makeEvent, nyToUtc, parseFomcCalendar, parseFredCsv, parseIcs, persistenceOf,
  readEvents, refreshContext, roundTripCostPoints, ruleEvents, saveStudy, sourceProblems, speakUpcoming, tTwoSided, upcomingEvents, welch,
} from './market_context.js';

globalThis.fetch = async (input) => { throw new TypeError(`fetch failed (offline test: ${new URL(String(input?.url || input)).host})`); };
const NOW = Date.parse('2026-10-23T12:00:00Z');
function memoryStorage() {
  const m = new Map();
  return {
    m,
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => m.has(x)).map((x) => [x, structuredClone(m.get(x))])) : m.has(k) ? structuredClone(m.get(k)) : undefined),
    put: async (k, v) => { if (k && typeof k === 'object') { for (const [a, b] of Object.entries(k)) m.set(a, structuredClone(b)); return; } m.set(k, structuredClone(v)); },
    delete: async (k) => m.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...m.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])),
  };
}
const cited = (over = {}) => makeEvent({ kind: 'cpi', title: 'Consumer Price Index (TEST)', event_time: '2026-03-11T12:30:00Z', source_name: 'TEST', source_url: 'https://www.bls.gov/test', ...over }, { now: NOW, method: 'fetched' });

test('New York wall time converts to UTC across DST', () => {
  assert.equal(new Date(nyToUtc('2026-01-13', 8, 30)).toISOString(), '2026-01-13T13:30:00.000Z');   // EST
  assert.equal(new Date(nyToUtc('2026-07-15', 8, 30)).toISOString(), '2026-07-15T12:30:00.000Z');   // EDT
  assert.equal(new Date(nyToUtc('2026-03-09', 14, 0)).toISOString(), '2026-03-09T18:00:00.000Z');   // the day after spring forward
  assert.equal(new Date(nyToUtc('2026-11-02', 14, 0)).toISOString(), '2026-11-02T19:00:00.000Z');   // the day after fall back
});

test('an event is refused when its information would be public before it happened, uncited, or an unscheduled item dated in the future', () => {
  assert.deepEqual(eventProblems(cited(), NOW), []);
  assert.match(eventProblems(cited({ first_available: '2026-03-11T12:00:00Z' }), NOW).join(), /before the event/);
  assert.match(eventProblems(cited({ source_url: 'not a link' }), NOW).join(), /cited https source/);
  const future = makeEvent({ kind: 'political_statement', title: 'post', event_time: '2026-10-24T00:00:00Z', source_url: 'https://example.com/a' }, { now: NOW, method: 'owner' });
  assert.match(eventProblems(future, NOW).join(), /future/);
  assert.match(eventProblems({ ...cited(), kind: 'astrology' }, NOW).join(), /unknown kind/);
});

test('a post seen through a news report is measured from the later report time, keeping both times and links', () => {
  const e = makeEvent({ kind: 'political_statement', title: 'Post quoted by a wire report (TEST)', event_time: '2026-04-02T14:05:00Z', reported_at: '2026-04-02T14:20:00Z',
    source_url: 'https://www.reuters.com/test-report', report_url: 'https://www.reuters.com/test-report' }, { now: NOW, method: 'owner' });
  assert.equal(e.first_available, '2026-04-02T14:20:00.000Z');
  assert.equal(e.event_time, '2026-04-02T14:05:00Z');
  assert.deepEqual(eventProblems(e, NOW), []);
  assert.match(eventProblems({ ...e, reported_at: '2026-04-02T13:00:00Z' }, NOW).join(), /reported_at/);
  const lib = contextModels([], []).find((m) => m.id === 'ctx-political');
  assert.match(lib.source_limits, /no free official API/);
  assert.match(lib.source_limits, /X API is paid/);
});

test('the store is append-only: re-ingesting never rewrites, and a correction supersedes without deleting', async () => {
  const s = memoryStorage();
  const e = cited();
  assert.equal((await appendEvents(s, [e], { now: NOW })).added, 1);
  const again = await appendEvents(s, [{ ...e, title: 'tampered' }], { now: NOW });   // same id
  assert.equal(again.added, 0); assert.equal(again.existing, 1);
  assert.equal((await readEvents(s))[0].title, 'Consumer Price Index (TEST)');
  const fix = cited({ event_time: '2026-03-11T12:31:00Z', title: 'Consumer Price Index corrected (TEST)', supersedes: e.id });
  await appendEvents(s, [fix], { now: NOW });
  const visible = await readEvents(s);
  assert.equal(visible.length, 1); assert.equal(visible[0].supersedes, e.id);
  assert.equal([...(await s.list({ prefix: 'mctx:ev:' })).keys()].length, 2, 'the superseded record is still stored');
});

test('rule events: quarterly expiration on the third Friday at 9:30 ET, rebalance after the close, Good Friday moves monthly expiry back', () => {
  const ev = ruleEvents(2026, 2026, { now: NOW });
  const q = ev.filter((e) => e.kind === 'opex_quarterly').map((e) => e.event_time);
  assert.deepEqual(q, ['2026-03-20T13:30:00.000Z', '2026-06-19T13:30:00.000Z', '2026-09-18T13:30:00.000Z', '2026-12-18T14:30:00.000Z']);
  assert.ok(ev.filter((e) => e.kind === 'index_rebalance').every((e) => /T2[01]:00:00/.test(e.event_time)), 'after the 16:00 ET close');
  assert.match(ev.find((e) => e.kind === 'index_rebalance' && e.event_time.startsWith('2026-12')).notes, /December 2024/);
  // Good Friday 2025 was April 18, the third Friday: the monthly expiry moves to Thursday April 17.
  const apr2025 = ruleEvents(2025, 2025, { now: NOW }).find((e) => e.kind === 'opex_monthly' && e.event_time.startsWith('2025-04'));
  assert.ok(apr2025.event_time.startsWith('2025-04-17'));
  assert.ok(ev.every((e) => e.source_url && e.provenance.method === 'rule'));
  assert.ok(ev.filter((e) => e.kind === 'opex_monthly').every((e) => e.date_only), 'the expiry time is not established, so date only');
});

test('iCalendar parsing: New York and UTC times, folded lines, date-only flagged, unknown zones refused', () => {
  const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:a1', 'DTSTART;TZID=US-Eastern:20260113T083000', 'SUMMARY:Consumer Price Index for Decem', ' ber 2025', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:a2', 'DTSTART:20260206T133000Z', 'SUMMARY:Employment Situation for January', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:a3', 'DTSTART;VALUE=DATE:20260115', 'SUMMARY:Producer Price Index', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:a4', 'DTSTART:20260115T083000', 'SUMMARY:Floating time release', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:a5', 'DTSTART;TZID=America/New_York:20260115T100000', 'SUMMARY:Job Openings and Labor Turnover Survey', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const v = parseIcs(ics);
  assert.equal(v.length, 4, 'the floating-time event is not placed on the timeline');
  assert.equal(v[0].summary, 'Consumer Price Index for December 2025');
  assert.equal(new Date(v[0].start).toISOString(), '2026-01-13T13:30:00.000Z');
  const ev = icsEvents(ics, { name: 'BLS (TEST)', url: 'https://www.bls.gov/test.ics' }, { now: NOW });
  assert.deepEqual(ev.map((e) => e.kind), ['cpi', 'nfp', 'ppi'], 'releases that do not map to a kind are left out');
  assert.equal(ev[2].date_only, true);
  assert.equal(kindOfRelease('Real Earnings for March'), null);
});

test('FOMC page parsing: decision at 2:00 p.m. ET on the last meeting day, press conference at 2:30, and a redesign fails loudly', () => {
  const html = `<div class="panel"><h4>2026 FOMC Meetings</h4>
    <div class="row fomc-meeting"><div class="fomc-meeting__month col-xs-5"><strong>January</strong></div><div class="fomc-meeting__date col-xs-4">27-28</div></div>
    <div class="row fomc-meeting"><div class="fomc-meeting__month col-xs-5"><strong>March</strong></div><div class="fomc-meeting__date col-xs-4">17-18*</div></div></div>`;
  const ev = parseFomcCalendar(html, { now: NOW });
  const dec = ev.filter((e) => e.kind === 'fomc_decision');
  assert.deepEqual(dec.map((e) => e.event_time), ['2026-01-28T19:00:00.000Z', '2026-03-18T18:00:00.000Z']);
  assert.match(dec[1].title, /Summary of Economic Projections/);
  assert.equal(ev.filter((e) => e.kind === 'fomc_presser')[0].event_time, '2026-01-28T19:30:00.000Z');
  assert.throws(() => parseFomcCalendar('<html>new design</html>'), /expected meeting layout/);
});

test('FRED series and the Fed cycle use only changes dated before the day', () => {
  const series = parseFredCsv('observation_date,DFEDTARU\n2024-09-16,5.50\n2024-09-17,5.50\n2024-09-18,5.00\n2024-09-19,.\n2024-11-08,4.75\n2025-06-01,4.75');
  assert.equal(series.length, 5);
  assert.equal(fedCycleOn(series, '2024-09-18').state, 'holding', 'the cut dated 2024-09-18 is not known before that day');
  assert.equal(fedCycleOn(series, '2024-12-01').state, 'cutting');
  assert.equal(fedCycleOn(series, '2025-09-01').state, 'holding');
  assert.equal(fedCycleOn(null, '2025-01-01').state, 'unknown');
  assert.throws(() => parseFredCsv('<html>'), /FRED/);
});

test('statistics: t-distribution p-values and Welch on known values', () => {
  assert.ok(Math.abs(tTwoSided(2.0, 10) - 0.0734) < 0.001);
  assert.ok(Math.abs(tTwoSided(1.96, 1e6) - 0.05) < 0.001);
  assert.ok(Math.abs(tTwoSided(0, 5) - 1) < 1e-9);
  const w = welch([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]);
  assert.ok(Math.abs(w.t + 1.8974) < 0.001); assert.ok(Math.abs(w.df - 5.88) < 0.05);
  assert.equal(welch([1], [2, 3]).p, null);
});

test('costs: one NQ round trip under the NORMAL profile', () => {
  const c = roundTripCostPoints('NQ', 'NORMAL');   // 1 spread + 2×1 slippage ticks = 0.75 pt; $4 commissions and fees = 0.2 pt
  assert.equal(c.points, 0.95); assert.equal(c.dollars, 19);
});

test('a known price never reads a bar that had not finished', () => {
  const bars = [{ t: '2026-01-13T13:20:00Z', c: 100 }, { t: '2026-01-13T13:25:00Z', c: 101 }, { t: '2026-01-13T13:30:00Z', c: 150 }];
  const p = knownPriceAt(bars, Date.parse('2026-01-13T13:30:00Z'), 300_000, 600_000);
  assert.equal(p.price, 101, 'the 13:30 bar is still open at 13:30');
  assert.equal(knownPriceAt(bars, Date.parse('2026-01-13T15:00:00Z'), 300_000, 600_000), null, 'a stale price is not used');
});

// Fixture: 5-minute bars over many days with a deterministic pattern. The pattern is synthetic, not market data.
function fixtureIntraday(days, { jumpAt = new Set(), jumpBps = 0 } = {}) {
  const bars = []; let p = 20000; let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  for (const day of days) {
    for (let m = 8 * 60; m < 16 * 60; m += 5) {
      const t = nyToUtc(day, Math.floor(m / 60), m % 60);
      let c = p * (1 + rnd() * 0.0006);
      if (jumpAt.has(t)) c = p * (1 + jumpBps / 1e4);
      bars.push({ t: new Date(t).toISOString(), o: p, h: Math.max(p, c), l: Math.min(p, c), c, v: 100 });
      p = c;
    }
  }
  return bars;
}
const weekdays = (from, n) => { const out = []; let t = Date.parse(`${from}T12:00:00Z`); while (out.length < n) { const d = new Date(t); if (![0, 6].includes(d.getUTCDay())) out.push(d.toISOString().slice(0, 10)); t += 86_400_000; } return out; };

test('event study: an insufficient sample claims nothing; a sufficient one reports association, costs and persistence', () => {
  const days = weekdays('2026-01-05', 60);
  const evDays = days.filter((_, i) => i % 5 === 2).slice(0, 12);
  const events = evDays.map((d) => cited({ event_time: new Date(nyToUtc(d, 8, 30)).toISOString(), title: `CPI ${d} (TEST)` }));
  const jumps = new Set(evDays.map((d) => nyToUtc(d, 8, 30)));   // the bar that STARTS at the release
  const bars = fixtureIntraday(days, { jumpAt: jumps, jumpBps: 40 });
  const small = eventStudy({ events: events.slice(0, 3), bars, tf: '5m', kind: 'cpi' });
  assert.equal(small.sample, 'insufficient'); assert.equal(small.stats, null); assert.match(small.verdict, /Insufficient sample: 3/);
  const s = eventStudy({ events, bars, tf: '5m', kind: 'cpi', market: 'NQ' });
  assert.equal(s.events_measured, 12); assert.equal(s.sample, 'sufficient');
  assert.ok(s.stats['5m'].mean_abs_bps > s.stats['5m'].baseline_mean_abs_bps, 'the fixture jump shows up in the 5-minute window');
  assert.ok(s.stats['5m'].abs_move_vs_baseline.p < 0.05);
  assert.match(s.interpretation, /Association, not causation/);
  assert.match(s.economic_note, /upper bound/);
  assert.ok(s.rows.every((r) => r.status === 'measured' && ['persistent', 'reversed', 'faded', 'unknown'].includes(r.persistence)));
  assert.ok(s.baseline_samples > 40, 'baseline from matched non-event days at the same clock time');
});

test('event study has no look-ahead: changing bars after the release leaves the base price and pre-event feature unchanged', () => {
  const days = weekdays('2026-02-02', 15);
  const events = [cited({ event_time: new Date(nyToUtc(days[5], 8, 30)).toISOString() })];
  const bars = fixtureIntraday(days);
  const a = eventStudy({ events, bars, tf: '5m', kind: 'cpi' }).rows[0];
  const t0 = nyToUtc(days[5], 8, 30);
  const tampered = bars.map((b) => (Date.parse(b.t) >= t0 ? { ...b, c: b.c * 1.05 } : b));
  const b = eventStudy({ events, bars: tampered, tf: '5m', kind: 'cpi' }).rows[0];
  assert.equal(a.base, b.base); assert.equal(a.pre_30m, b.pre_30m); assert.equal(a.base_bar_end, b.base_bar_end);
  assert.notEqual(a.returns_bps['5m'], b.returns_bps['5m'], 'only the reaction, measured after the release, changes');
});

test('persistence labels', () => {
  assert.equal(persistenceOf(20, 15), 'persistent'); assert.equal(persistenceOf(20, -12), 'reversed'); assert.equal(persistenceOf(20, 3), 'faded'); assert.equal(persistenceOf(null, 3), 'unknown');
});

test('day regimes are known before the session: no event that only became public later, no same-day data', () => {
  const days = weekdays('2025-01-01', 330);
  const bars = days.map((d, i) => ({ t: `${d}T00:00:00Z`, o: 100 + i, h: 101 + i, l: 99 + i, c: 100 + i + (i % 7) * 0.3, v: 1000 + (i % 13) * 50 }));
  const sched = cited({ event_time: new Date(nyToUtc(days[300], 8, 30)).toISOString() });
  const unsched = makeEvent({ kind: 'geopolitical', title: 'report (TEST)', event_time: new Date(nyToUtc(days[301], 11, 0)).toISOString(), source_url: 'https://example.com/r' }, { now: NOW, method: 'owner' });
  const r = dayRegimes(bars, { events: [sched, unsched] });
  assert.equal(r[300].event_day, true); assert.deepEqual(r[300].events, ['cpi']); assert.equal(r[300].high_impact_event_day, true);
  assert.equal(r[301].event_day, false, 'an unscheduled event is not known before the session');
  assert.ok(['low', 'normal', 'high'].includes(r[320].volatility)); assert.ok(['low', 'normal', 'high'].includes(r[320].liquidity));
  const changed = dayRegimes(bars.map((b, i) => (i === 320 ? { ...b, c: b.c * 2, v: 1e9 } : b)), { events: [] });
  assert.deepEqual([changed[320].volatility, changed[320].liquidity], [r[320].volatility, r[320].liquidity], "the day's own bar never sets its regime");
  assert.equal(r[0].fed_cycle, 'unknown');
});

test('annotations carry source, provenance and an observed (not caused) reaction label; upcoming warnings by minutes', async () => {
  const e = cited({ event_time: '2026-10-23T12:30:00Z' });
  const study = { market: 'NQ', timeframe: '5m', rows: [{ id: e.id, status: 'measured', returns_bps: { '5m': 25, '30m': 40, close: 10 }, persistence: 'faded' }] };
  const [a] = annotationsFor([e], [study], { market: 'NQ' });
  assert.equal(a.source_url, 'https://www.bls.gov/test'); assert.equal(a.verified, 'official schedule');
  assert.match(a.reaction_label, /observed, not caused/);
  const up = upcomingEvents([e], Date.parse('2026-10-23T12:05:00Z'));
  assert.equal(up[0].minutes_until, 25);
  assert.match(speakUpcoming(up), /CPI \(consumer prices\) in 25 minutes/);
  assert.match(speakUpcoming([]), /No scheduled market event/);
  const dateOnly = makeEvent({ kind: 'opex_monthly', title: 'opex', event_time: '2026-10-23T13:30:00Z', date_only: true, source_url: 'https://www.cmegroup.com/x' }, { now: NOW, method: 'rule' });
  assert.equal(upcomingEvents([dateOnly], Date.parse('2026-10-23T12:05:00Z')).length, 0, 'a date-only event gets no countdown');
});

test('models: stages follow real state; context models never claim forward or paper testing', async () => {
  const s = memoryStorage();
  let models = contextModels([], []);
  assert.ok(models.every((m) => m.stage === 'rules_documented' && m.reason_not_running));
  const events = Array.from({ length: 12 }, (_, i) => cited({ event_time: new Date(Date.parse('2026-01-13T13:30:00Z') + i * 30 * 86_400_000).toISOString() }));
  await appendEvents(s, events, { now: NOW });
  models = contextModels(await readEvents(s), []);
  assert.equal(models.find((m) => m.id === 'ctx-cpi').stage, 'implemented');
  await saveStudy(s, { kind: 'cpi', market: 'NQ', timeframe: '5m', events_measured: 3, sample: 'insufficient', verdict: 'x', data: { first: '2026-08-01', last: '2026-10-01' }, rows: [] }, { now: NOW });
  const m1 = contextModels(await readEvents(s), (await contextView(s, { now: NOW })).studies.length ? [...(await s.list({ prefix: 'mctx:study:' })).values()] : []).find((m) => m.id === 'ctx-cpi');
  assert.equal(m1.stage, 'implemented'); assert.match(m1.reason_not_running, /below the 10 needed/);
  await saveStudy(s, { kind: 'cpi', market: 'NQ', timeframe: '1D', events_measured: 40, sample: 'sufficient', data: {}, rows: [] }, { now: NOW });
  const m2 = contextModels(await readEvents(s), [...(await s.list({ prefix: 'mctx:study:' })).values()]).find((m) => m.id === 'ctx-cpi');
  assert.equal(m2.stage, 'backtested');
  assert.ok(!contextModels(await readEvents(s), [...(await s.list({ prefix: 'mctx:study:' })).values()]).some((m) => ['forward_tested', 'paper_active'].includes(m.stage)));
  assert.deepEqual(STAGES.map((x) => x.label), ['DISCOVERED', 'RULES DOCUMENTED', 'IMPLEMENTED', 'BACKTESTED', 'FORWARD TESTED', 'PAPER ACTIVE']);
  assert.equal(MIN_EVENTS, 10);
});

test('refresh: rule events always; each source fetched within the budget, failures logged, never treated as "no events"', async () => {
  const s = memoryStorage();
  const seen = [];
  const fetcher = async (url) => {
    seen.push(url);
    if (url.includes('fomccalendars')) return new Response('<html>redesigned</html>', { status: 200 });
    if (url.includes('bls.ics')) return new Response('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;TZID=US-Eastern:20261110T083000\r\nSUMMARY:Consumer Price Index for October 2026\r\nEND:VEVENT\r\nEND:VCALENDAR', { status: 200 });
    if (url.includes('fredgraph')) return new Response('observation_date,DFEDTARU\n2026-01-01,4.00\n2026-09-18,3.75', { status: 200 });
    return new Response('', { status: 404 });
  };
  const r = await refreshContext(s, { fromYear: 2026, toYear: 2026, fetcher, now: NOW });
  assert.ok(r.rules.added > 20);
  const by = Object.fromEntries(r.sources.map((x) => [x.id, x]));
  assert.equal(by['builtin-fomc'].status, 'failed'); assert.match(by['builtin-fomc'].error, /expected meeting layout/);
  assert.equal(by['builtin-bls'].added, 1);
  assert.equal(by['builtin-fred-target'].points, 2);
  const again = await refreshContext(s, { fromYear: 2026, toYear: 2026, fetcher, now: NOW + 60_000 });
  assert.ok(again.sources.filter((x) => x.id.startsWith('builtin')).every((x) => /within the last 6 hours/.test(x.status)), 'no refetch inside 6 hours');
  assert.equal(again.rules.added, 0, 'rule events are not duplicated');
  assert.equal(seen.length, 3);
});

test('owner sources are validated and stored with provenance; bad patterns refused', async () => {
  const s = memoryStorage();
  assert.match(sourceProblems({ name: 'x', url: 'http://insecure', type: 'ics' }).join(), /https/);
  assert.match(sourceProblems({ name: 'x', url: 'https://a.example/x.ics', type: 'ics', kind_map: { '(': 'cpi' } }).join(), /valid pattern/);
  const ok = await addSource(s, { name: 'BEA schedule (owner)', url: 'https://apps.bea.gov/test.ics', type: 'ics', kind_map: { 'Personal Income': 'pce' } }, { now: NOW });
  assert.equal(ok.ok, true); assert.equal(ok.source.added_by, 'owner'); assert.equal(ok.source.machine_readable, true);
  const view = await contextView(s, { now: NOW });
  assert.ok(view.sources.some((x) => x.name === 'BEA schedule (owner)'));
  assert.equal(view.live_trading, 'disabled');
});

test('chat intents', () => {
  assert.deepEqual(contextIntent('CHE, what market events are coming up?'), { kind: 'upcoming' });
  assert.deepEqual(contextIntent('is there a CPI today'), { kind: 'upcoming' });
  assert.deepEqual(contextIntent('refresh the market calendar'), { kind: 'refresh' });
  assert.equal(contextIntent('what events did I have on my calendar'), null);
  assert.equal(contextIntent('how is the EMA pullback doing'), null);
});

test('every kind is labelled scheduled or unscheduled and unscheduled kinds are never known in advance', () => {
  for (const [k, v] of Object.entries(EVENT_KINDS)) { assert.equal(typeof v.scheduled, 'boolean', k); if (!v.scheduled) assert.equal(v.known_in_advance, false, k); }
});
