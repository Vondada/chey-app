// CHE market context (owner, 2026-10-23): scheduled and unscheduled events that may move NQ/MNQ, treated as possible
// catalysts and never as predictors. One append-only event store, rule-derived and fetched calendars with their
// sources, an event-study engine on CHE's own verified bars, day regimes, chart annotations and market-context models
// for the strategy library.
//
// Truth rules, enforced in code:
//   - Every event keeps its source and two times: when it happened (event_time) and when the information first became
//     public (first_available). Nothing is ever back-dated: first_available is never before event_time, and an
//     unscheduled item needs a cited source with its original timestamp.
//   - A study only uses bars that ended at or before first_available for anything it calls a feature, and it reports
//     association, not causation. Below MIN_EVENTS events it says the sample is too small and claims nothing.
//   - Records are appended, never edited or deleted. A correction is a new record that names the one it supersedes.
//   - Nothing here schedules work, places an order or calls a model. Fetching happens only when the owner asks.
import { CONTRACTS } from './trading_evidence.js';
import { COST_PROFILES, cmeCalendar, sessionAt } from './trading_research.js';
import { etParts, tradeDayOf } from './trading_evidence.js';

export const CONTEXT_VERSION = 'context-1';
export const MIN_EVENTS = 10;           // below this an event study is an anecdote
export const MAX_FETCHES_PER_REFRESH = 6;
export const SOURCE_MIN_INTERVAL_MS = 6 * 3600_000;
const EV_PREFIX = 'mctx:ev:';
const SRC_PREFIX = 'mctx:src:';
const STUDY_PREFIX = 'mctx:study:';
const FETCH_LOG = 'mctx:fetchlog';
const SERIES_PREFIX = 'mctx:series:';
const DAY = 86_400_000;
const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;
const iso = (ms) => new Date(ms).toISOString();

/** The lifecycle shared with the strategy library. A market-context model stops at BACKTESTED on its own. */
export const STAGES = Object.freeze([
  { id: 'discovered', label: 'DISCOVERED' },
  { id: 'rules_documented', label: 'RULES DOCUMENTED' },
  { id: 'implemented', label: 'IMPLEMENTED' },
  { id: 'backtested', label: 'BACKTESTED' },
  { id: 'forward_tested', label: 'FORWARD TESTED' },
  { id: 'paper_active', label: 'PAPER ACTIVE' },
]);

// Sources. `machine` says how CHE reads it; a source CHE cannot read is listed honestly and not pretended.
export const SOURCES = Object.freeze({
  fomc: { name: 'Federal Reserve — FOMC meeting calendars', url: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm', machine: 'fomc_html' },
  bls: { name: 'U.S. Bureau of Labor Statistics — release calendar (iCalendar)', url: 'https://www.bls.gov/schedule/news_release/bls.ics', machine: 'ics' },
  fred_target: { name: 'FRED (St. Louis Fed) — Federal funds target range, upper limit (DFEDTARU)', url: 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFEDTARU', machine: 'fred_csv' },
  bea: { name: 'U.S. Bureau of Economic Analysis — release schedule', url: 'https://www.bea.gov/news/schedule', machine: null },
  dol: { name: 'U.S. Department of Labor — weekly unemployment insurance claims', url: 'https://www.dol.gov/ui/data.pdf', machine: null },
  cme_spec: { name: 'CME Group — E-mini Nasdaq-100 contract specifications (termination 9:30 a.m. ET, third Friday of the contract month)', url: 'https://www.cmegroup.com/markets/equities/nasdaq/e-mini-nasdaq-100.contractSpecs.html', machine: 'rule' },
  cme_options_rule: { name: 'CME Rulebook — Nasdaq-100 options (non-quarterly months terminate on the third Friday)', url: 'https://www.cmegroup.com/rulebook/files/ser6220_nasdaq_eom_04-26-2012.pdf', machine: 'rule' },
  ndx_method: { name: 'Nasdaq — Nasdaq-100 index methodology (quarterly rebalance and December reconstitution effective after the close on the third Friday)', url: 'https://indexes.nasdaqomx.com/docs/methodology_NDX.pdf', machine: 'rule' },
  cme_calendar: { name: "CHE's CME equity holiday and early-close rules (trading_research.js cmeCalendar)", url: 'repo:server/cloudflare/trading_research.js#cmeCalendar', machine: 'rule' },
  fed_presser: { name: 'Federal Reserve — press conference after every FOMC meeting since January 2019', url: 'https://www.federalreserve.gov/monetarypolicy/fomcpresconf.htm', machine: null },
});

// Kinds. `known_in_advance` is true only when an official calendar or a published rule fixes the time ahead.
export const EVENT_KINDS = Object.freeze({
  fomc_decision: { label: 'FOMC rate decision', scheduled: true, known_in_advance: true, high_impact: true },
  fomc_minutes: { label: 'FOMC minutes', scheduled: true, known_in_advance: true, high_impact: false },
  fomc_presser: { label: 'Fed chair press conference', scheduled: true, known_in_advance: true, high_impact: true },
  cpi: { label: 'CPI (consumer prices)', scheduled: true, known_in_advance: true, high_impact: true },
  ppi: { label: 'PPI (producer prices)', scheduled: true, known_in_advance: true, high_impact: false },
  pce: { label: 'PCE / personal income and outlays', scheduled: true, known_in_advance: true, high_impact: true },
  nfp: { label: 'Employment Situation (nonfarm payrolls)', scheduled: true, known_in_advance: true, high_impact: true },
  jobless_claims: { label: 'Weekly jobless claims', scheduled: true, known_in_advance: true, high_impact: false },
  gdp: { label: 'GDP', scheduled: true, known_in_advance: true, high_impact: false },
  major_release: { label: 'Other major economic release', scheduled: true, known_in_advance: true, high_impact: false },
  opex_monthly: { label: 'Monthly Nasdaq-100 options expiration', scheduled: true, known_in_advance: true, high_impact: false },
  opex_quarterly: { label: 'Quarterly NQ/MNQ futures expiration (third Friday, 9:30 a.m. ET)', scheduled: true, known_in_advance: true, high_impact: false },
  index_rebalance: { label: 'Nasdaq-100 quarterly rebalance / December reconstitution (after the close)', scheduled: true, known_in_advance: true, high_impact: false },
  earnings: { label: 'Large-company earnings', scheduled: true, known_in_advance: true, high_impact: false },
  holiday: { label: 'CME equity market holiday (closed)', scheduled: true, known_in_advance: true, high_impact: false },
  early_close: { label: 'CME equity early close / holiday halt', scheduled: true, known_in_advance: true, high_impact: false },
  geopolitical: { label: 'Geopolitical development', scheduled: false, known_in_advance: false, high_impact: false },
  political_statement: { label: 'Statement or post by an influential political figure', scheduled: false, known_in_advance: false, high_impact: false },
  other: { label: 'Other documented market event', scheduled: false, known_in_advance: false, high_impact: false },
});
export const INSTRUMENTS = Object.freeze(['NQ', 'MNQ']);
const SOURCE_TYPES = Object.freeze(['ics', 'fomc_html', 'fred_csv', 'calendar', 'news', 'other']);

// ─── New York wall time → UTC (DST from the time-zone database) ─────────────

/** UTC milliseconds of a New York wall-clock time on a date. Exact across DST changes. */
export function nyToUtc(day, hh, mm = 0) {
  const guess = Date.parse(`${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);
  for (const offsetH of [4, 5]) {
    const t = guess + offsetH * 3600_000;
    const p = etParts(t);
    if (p.day === day && p.mins === hh * 60 + mm) return t;
  }
  return guess + 5 * 3600_000;
}
const ymd = (ms) => iso(ms).slice(0, 10);
const thirdFriday = (y, m) => { const first = new Date(Date.UTC(y, m, 1)).getUTCDay(); return Date.UTC(y, m, 1 + ((5 - first + 7) % 7) + 14); };
function priorBusinessDay(ms, closed) { let t = ms; while ([0, 6].includes(new Date(t).getUTCDay()) || closed.has(ymd(t))) t -= DAY; return t; }

// ─── Event records (append-only) ─────────────────────────────────────────────

function fnv(text) { let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); }
export const eventId = (e) => `${e.kind}-${String(e.event_time || '').slice(0, 16)}-${fnv(`${e.kind}|${e.event_time}|${e.source_url}|${e.title}`)}`;

/**
 * The problems with a proposed event; empty means it may be stored. The checks that keep history honest live here:
 * a known kind, a parseable time, a cited source, information never available before it happened, and an unscheduled
 * item never dated in the future of its own ingestion.
 */
export function eventProblems(e, now = Date.now()) {
  const out = [];
  if (!e || typeof e !== 'object') return ['no event'];
  if (!EVENT_KINDS[e.kind]) out.push(`unknown kind "${e.kind}"`);
  if (!String(e.title || '').trim()) out.push('a title is required');
  const t = Date.parse(e.event_time); const fa = Date.parse(e.first_available);
  if (!Number.isFinite(t)) out.push('event_time must be an ISO time');
  if (!Number.isFinite(fa)) out.push('first_available must be an ISO time');
  if (Number.isFinite(t) && Number.isFinite(fa) && fa < t) out.push('first_available is before the event: information cannot be public before it exists');
  const src = String(e.source_url || '');
  if (!/^https:\/\/[^\s/]+\.[^\s]+$/.test(src) && !src.startsWith('repo:')) out.push('a cited https source is required');
  if (!Array.isArray(e.instruments) || !e.instruments.length || e.instruments.some((x) => !INSTRUMENTS.includes(x))) out.push('instruments must be NQ and/or MNQ');
  const kind = EVENT_KINDS[e.kind];
  if (kind && !kind.scheduled && Number.isFinite(fa) && fa > now + 60_000) out.push('an unscheduled event cannot be dated in the future');
  if (kind && e.scheduled !== kind.scheduled) out.push(`kind ${e.kind} is ${kind.scheduled ? 'scheduled' : 'unscheduled'}`);
  if (e.reported_at != null && !(Date.parse(e.reported_at) >= t)) out.push('reported_at must be an ISO time at or after the event');
  if (e.report_url != null && !/^https:\/\/[^\s/]+\.[^\s]+$/.test(String(e.report_url))) out.push('report_url must be an https link');
  return out;
}

/** A normalized record. Callers give the facts; CHE fills only what it knows (ingestion time, ids, kind flags). */
export function makeEvent(fields, { now = Date.now(), method = 'owner' } = {}) {
  const kind = EVENT_KINDS[fields.kind] || {};
  const e = {
    kind: fields.kind, title: String(fields.title || '').trim().slice(0, 200),
    scheduled: kind.scheduled === true, known_in_advance: kind.known_in_advance === true && method !== 'owner_unscheduled',
    event_time: fields.event_time, first_available: fields.first_available || fields.event_time,
    time_basis: fields.time_basis || (kind.scheduled ? 'official schedule' : 'source timestamp'),
    date_only: fields.date_only === true,
    timezone: 'America/New_York', source_name: String(fields.source_name || '').slice(0, 200), source_url: String(fields.source_url || ''),
    instruments: Array.isArray(fields.instruments) && fields.instruments.length ? fields.instruments : ['NQ', 'MNQ'],
    ingested_at: iso(now), provenance: { method, version: CONTEXT_VERSION },
    supersedes: fields.supersedes || null, notes: String(fields.notes || '').slice(0, 500),
    // A post seen through a news or wire report: the post's own time is event_time; the report's time and link are kept,
    // and first_available is the later of the two unless the owner cites the post itself.
    reported_at: fields.reported_at || null, report_url: fields.report_url ? String(fields.report_url) : null,
  };
  if (e.reported_at && Number.isFinite(Date.parse(e.reported_at)) && !fields.first_available) e.first_available = new Date(Math.max(Date.parse(e.event_time), Date.parse(e.reported_at))).toISOString();
  return { ...e, id: eventId(e) };
}

/** Appends events. An id already stored is kept as it was: re-ingesting never rewrites a record. */
export async function appendEvents(storage, events, { now = Date.now() } = {}) {
  const added = []; const refused = []; let existing = 0;
  for (const e of events) {
    const problems = eventProblems(e, now);
    if (problems.length) { refused.push({ title: e?.title || null, problems }); continue; }
    const key = `${EV_PREFIX}${e.id}`;
    if (await storage.get(key)) { existing++; continue; }
    await storage.put(key, e);
    added.push(e.id);
  }
  return { added: added.length, existing, refused, ids: added };
}
export async function readEvents(storage, { from = null, to = null, kinds = null } = {}) {
  const all = [...(await storage.list({ prefix: EV_PREFIX })).values()];
  const f = from ? Date.parse(from) : -Infinity; const t = to ? Date.parse(to) : Infinity;
  const superseded = new Set(all.map((e) => e.supersedes).filter(Boolean));
  return all.filter((e) => !superseded.has(e.id) && Date.parse(e.event_time) >= f && Date.parse(e.event_time) <= t && (!kinds || kinds.includes(e.kind)))
    .sort((a, b) => Date.parse(a.event_time) - Date.parse(b.event_time));
}

// ─── Rule-derived calendars (published rules, no fetch) ─────────────────────

/**
 * Events a published rule fixes: monthly options expiration, quarterly futures expiration, the Nasdaq-100 quarterly
 * rebalance and December reconstitution, CME holidays and early closes. Rule exceptions (Nasdaq moved the December 2024
 * reconstitution to before the open on December 23) are not known to a rule and must be added from a cited source.
 */
export function ruleEvents(fromYear, toYear, { now = Date.now() } = {}) {
  const out = [];
  for (let y = fromYear; y <= toYear; y++) {
    const cal = cmeCalendar(y);
    for (const d of cal.closed) {
      const day = d; const t = nyToUtc(day, 9, 30);
      out.push(makeEvent({ kind: 'holiday', title: `CME equity holiday (${day})`, event_time: iso(t), first_available: iso(t), time_basis: 'published holiday rule', date_only: true,
        source_name: SOURCES.cme_calendar.name, source_url: SOURCES.cme_calendar.url, notes: 'Rule-derived. Confirm against the CME holiday calendar for the year.' }, { now, method: 'rule' }));
    }
    for (const d of cal.early) {
      const t = nyToUtc(d, 13, 0);
      out.push(makeEvent({ kind: 'early_close', title: `CME equity early halt (${d}, 1:00 p.m. ET)`, event_time: iso(t), first_available: iso(t), time_basis: 'published holiday rule',
        source_name: SOURCES.cme_calendar.name, source_url: SOURCES.cme_calendar.url, notes: 'Rule-derived. Confirm against the CME holiday calendar for the year.' }, { now, method: 'rule' }));
    }
    for (let m = 0; m < 12; m++) {
      const quarterly = m % 3 === 2;
      const day = ymd(priorBusinessDay(thirdFriday(y, m), cal.closed));
      if (quarterly) {
        const t = nyToUtc(day, 9, 30);
        out.push(makeEvent({ kind: 'opex_quarterly', title: `NQ/MNQ quarterly expiration (${day}, 9:30 a.m. ET)`, event_time: iso(t), first_available: iso(t), time_basis: 'published contract rule',
          source_name: SOURCES.cme_spec.name, source_url: SOURCES.cme_spec.url, notes: 'Quarterly options in the March cycle terminate with the futures.' }, { now, method: 'rule' }));
        const close = nyToUtc(day, 16, 0);
        out.push(makeEvent({ kind: 'index_rebalance', title: `Nasdaq-100 ${m === 11 ? 'annual reconstitution and ' : ''}quarterly rebalance effective after the close (${day})`, event_time: iso(close), first_available: iso(close), time_basis: 'published index rule',
          source_name: SOURCES.ndx_method.name, source_url: SOURCES.ndx_method.url, notes: m === 11 ? 'Reconstitution changes are announced in early December. Nasdaq has made exceptions (December 2024 took effect before the open on December 23).' : 'Special rebalances can happen at any time and are not rule-derived.' }, { now, method: 'rule' }));
      } else {
        const t = nyToUtc(day, 9, 30);
        out.push(makeEvent({ kind: 'opex_monthly', title: `Monthly Nasdaq-100 options expiration (${day})`, event_time: iso(t), first_available: iso(t), time_basis: 'published options rule (date only: the expiry time is not established here)', date_only: true,
          source_name: SOURCES.cme_options_rule.name, source_url: SOURCES.cme_options_rule.url, notes: 'The rule found is a 2012 rulebook chapter; confirm the current terms on CME.' }, { now, method: 'rule' }));
      }
    }
  }
  return out;
}

// ─── Fetched calendars (parsers; fetched only on the owner's request) ───────

/** iCalendar (RFC 5545) VEVENTs: { summary, start (UTC ms), dateOnly, uid }. TZID New York and UTC times are handled. */
export function parseIcs(text) {
  const unfolded = String(text || '').replace(/\r?\n[ \t]/g, '');
  const out = [];
  for (const block of unfolded.split('BEGIN:VEVENT').slice(1)) {
    const body = block.split('END:VEVENT')[0];
    const line = (name) => body.split(/\r?\n/).find((l) => l.toUpperCase().startsWith(`${name}:`) || l.toUpperCase().startsWith(`${name};`));
    const summary = (line('SUMMARY') || '').replace(/^[^:]*:/, '').replace(/\\,/g, ',').replace(/\\n/gi, ' ').trim();
    const dt = line('DTSTART');
    if (!summary || !dt) continue;
    const params = dt.slice(0, dt.indexOf(':')); const value = dt.slice(dt.indexOf(':') + 1).trim();
    let start = null; let dateOnly = false;
    if (/VALUE=DATE(?!-)/i.test(params) || /^\d{8}$/.test(value)) { dateOnly = true; start = nyToUtc(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`, 8, 30); }
    else {
      const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
      if (!m) continue;
      const day = `${m[1]}-${m[2]}-${m[3]}`;
      if (m[7] === 'Z') start = Date.parse(`${day}T${m[4]}:${m[5]}:${m[6]}Z`);
      else if (/TZID=(?:"?America\/New_York"?|US-Eastern|Eastern Standard Time|US\/Eastern)/i.test(params)) start = nyToUtc(day, Number(m[4]), Number(m[5]));
      else continue;     // a floating or unknown zone cannot be placed on the timeline honestly
    }
    out.push({ summary, start, dateOnly, uid: ((line('UID') || '').replace(/^[^:]*:/, '')).trim() });
  }
  return out;
}
/** Which kind an official release title is, or null (not every release matters for NQ). */
export function kindOfRelease(summary) {
  const s = String(summary || '');
  if (/\bconsumer price index\b/i.test(s) && !/real earnings/i.test(s)) return 'cpi';
  if (/\bemployment situation\b/i.test(s)) return 'nfp';
  if (/\bproducer price index\b/i.test(s)) return 'ppi';
  if (/personal income and outlays/i.test(s)) return 'pce';
  if (/\bgross domestic product\b|\bGDP\b/.test(s)) return 'gdp';
  if (/unemployment insurance weekly claims/i.test(s)) return 'jobless_claims';
  return null;
}
export function icsEvents(text, source, { now = Date.now() } = {}) {
  const out = [];
  for (const v of parseIcs(text)) {
    const kind = (source.kind_map && Object.entries(source.kind_map).find(([re]) => new RegExp(re, 'i').test(v.summary))?.[1]) || kindOfRelease(v.summary);
    if (!kind || !EVENT_KINDS[kind]) continue;
    out.push(makeEvent({ kind, title: v.summary, event_time: iso(v.start), first_available: iso(v.start), date_only: v.dateOnly,
      time_basis: v.dateOnly ? 'official schedule (date only; 8:30 a.m. ET assumed and flagged)' : 'official schedule', source_name: source.name, source_url: source.url }, { now, method: 'fetched' }));
  }
  return out;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/**
 * FOMC meeting calendar page → scheduled decisions (2:00 p.m. ET on the last meeting day) and press conferences
 * (2:30 p.m. ET). Notation votes and unscheduled meetings are left out. Throws when the page shape is not recognised,
 * so a redesign reads as a failure, never as "no meetings".
 */
export function parseFomcCalendar(html, { now = Date.now(), source = { name: SOURCES.fomc.name, url: SOURCES.fomc.url } } = {}) {
  const text = String(html || '');
  const out = [];
  const panels = text.split(/(\d{4})\s+FOMC Meetings/i);
  for (let i = 1; i < panels.length; i += 2) {
    const year = Number(panels[i]); const body = panels[i + 1] || '';
    const re = /fomc-meeting__month[^>]*>\s*(?:<[^>]+>\s*)*([A-Za-z/]+)\s*(?:<[^>]+>\s*)*<\/div>[\s\S]*?fomc-meeting__date[^>]*>\s*(?:<[^>]+>\s*)*([0-9]{1,2}(?:\s*-\s*[0-9]{1,2})?)(\*?)/gi;
    let m;
    while ((m = re.exec(body))) {
      const monthWord = m[1].toLowerCase().split('/').pop();
      const mi = MONTHS.indexOf(monthWord);
      if (mi < 0) continue;
      const lastDay = Number(m[2].split('-').pop().trim());
      const sameMonthSpan = m[1].includes('/') ? mi : mi;
      const day = `${year}-${String(sameMonthSpan + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      const around = body.slice(m.index, m.index + 400);
      if (/notation vote|unscheduled/i.test(around.split('fomc-meeting__month')[0] || '')) continue;
      const dec = nyToUtc(day, 14, 0);
      out.push(makeEvent({ kind: 'fomc_decision', title: `FOMC decision ${day}${m[3] ? ' (with Summary of Economic Projections)' : ''}`, event_time: iso(dec), first_available: iso(dec),
        time_basis: 'official schedule; statement at 2:00 p.m. ET', source_name: source.name, source_url: source.url }, { now, method: 'fetched' }));
      const pc = nyToUtc(day, 14, 30);
      out.push(makeEvent({ kind: 'fomc_presser', title: `Fed chair press conference ${day}`, event_time: iso(pc), first_available: iso(pc),
        time_basis: 'Fed practice since January 2019: press conference at 2:30 p.m. ET after each meeting', source_name: SOURCES.fed_presser.name, source_url: SOURCES.fed_presser.url }, { now, method: 'fetched' }));
    }
  }
  if (!out.length) throw new Error('the FOMC calendar page did not have the expected meeting layout');
  return out;
}

/** FRED graph CSV → [{ date, value }], skipping missing values ("."). */
export function parseFredCsv(text) {
  const lines = String(text || '').trim().split(/\r?\n/);
  if (!lines.length || !/^(observation_date|DATE),/i.test(lines[0])) throw new Error('not a FRED graph CSV');
  return lines.slice(1).map((l) => l.split(',')).filter(([d, v]) => /^\d{4}-\d{2}-\d{2}$/.test(d) && v !== '.' && Number.isFinite(Number(v))).map(([d, v]) => ({ date: d, value: Number(v) }));
}

/**
 * Fed cycle on a day from the target-rate series, using only changes dated before that day. A change within the last
 * 180 days sets hiking or cutting; otherwise holding. The 180-day window is CHE's own choice, not an official definition.
 */
export function fedCycleOn(series, day) {
  if (!Array.isArray(series) || !series.length) return { state: 'unknown', reason: 'no cited rate data loaded' };
  const before = series.filter((p) => p.date < day);
  if (before.length < 2) return { state: 'unknown', reason: 'the rate series does not reach back to this day' };
  let last = null;
  for (let i = 1; i < before.length; i++) if (before[i].value !== before[i - 1].value) last = { date: before[i].date, dir: before[i].value > before[i - 1].value ? 'hiking' : 'cutting' };
  if (!last) return { state: 'holding', since: before[0].date, rule: 'no change in the loaded series' };
  const age = (Date.parse(day) - Date.parse(last.date)) / DAY;
  return age <= 180 ? { state: last.dir, last_change: last.date, rule: 'last change within 180 days (CHE threshold)' } : { state: 'holding', last_change: last.date, rule: 'no change for over 180 days (CHE threshold)' };
}

// ─── Owner-added sources ─────────────────────────────────────────────────────

export function sourceProblems(s) {
  const out = [];
  if (!String(s?.name || '').trim()) out.push('a name is required');
  if (!/^https:\/\/[^\s/]+\.[^\s]+$/.test(String(s?.url || ''))) out.push('an https link is required');
  if (!SOURCE_TYPES.includes(s?.type)) out.push(`type must be one of ${SOURCE_TYPES.join(', ')}`);
  if (s?.kind_map && (typeof s.kind_map !== 'object' || Object.values(s.kind_map).some((k) => !EVENT_KINDS[k]))) out.push('kind_map values must be known event kinds');
  if (s?.kind_map) for (const re of Object.keys(s.kind_map)) { try { new RegExp(re, 'i'); } catch { out.push(`kind_map pattern "${re}" is not a valid pattern`); } }
  return out;
}
export async function addSource(storage, s, { now = Date.now() } = {}) {
  const problems = sourceProblems(s);
  if (problems.length) return { ok: false, problems };
  const rec = { id: `src-${fnv(`${s.type}|${s.url}`)}`, name: String(s.name).trim().slice(0, 200), url: s.url, type: s.type, kind_map: s.kind_map || null, added_at: iso(now), added_by: 'owner',
    machine_readable: ['ics', 'fomc_html', 'fred_csv'].includes(s.type) };
  const key = `${SRC_PREFIX}${rec.id}`;
  if (await storage.get(key)) return { ok: true, existing: true, source: await storage.get(key) };
  await storage.put(key, rec);
  return { ok: true, source: rec };
}
export function builtinSources() {
  return [
    { id: 'builtin-fomc', name: SOURCES.fomc.name, url: SOURCES.fomc.url, type: 'fomc_html', machine_readable: true, added_by: 'CHE' },
    { id: 'builtin-bls', name: SOURCES.bls.name, url: SOURCES.bls.url, type: 'ics', machine_readable: true, added_by: 'CHE' },
    { id: 'builtin-fred-target', name: SOURCES.fred_target.name, url: SOURCES.fred_target.url, type: 'fred_csv', series: 'DFEDTARU', machine_readable: true, added_by: 'CHE' },
  ];
}
export async function readSources(storage) { return [...builtinSources(), ...(await storage.list({ prefix: SRC_PREFIX })).values()]; }

/**
 * On-demand refresh: rule events for the requested years, then each machine-readable source at most once per
 * SOURCE_MIN_INTERVAL_MS and at most MAX_FETCHES_PER_REFRESH fetches in total. Every attempt is logged with its outcome.
 */
export async function refreshContext(storage, { fromYear, toYear, fetcher = fetch, now = Date.now() } = {}) {
  const y = new Date(now).getUTCFullYear();
  const from = Math.max(2019, Number(fromYear) || y - 3); const to = Math.min(y + 1, Number(toYear) || y + 1);
  const report = { rules: await appendEvents(storage, ruleEvents(from, to, { now }), { now }), sources: [] };
  const log = (await storage.get(FETCH_LOG)) || {};
  let fetches = 0;
  for (const src of await readSources(storage)) {
    if (!src.machine_readable) { report.sources.push({ id: src.id, name: src.name, status: 'not machine-readable: listed for reference only' }); continue; }
    const last = log[src.id]?.at ? Date.parse(log[src.id].at) : 0;
    if (now - last < SOURCE_MIN_INTERVAL_MS) { report.sources.push({ id: src.id, name: src.name, status: 'skipped: fetched within the last 6 hours', last: log[src.id] }); continue; }
    if (fetches >= MAX_FETCHES_PER_REFRESH) { report.sources.push({ id: src.id, name: src.name, status: 'skipped: fetch budget for this refresh used' }); continue; }
    fetches++;
    const entry = { at: iso(now), url: src.url };
    try {
      const res = await fetcher(src.url, { headers: { 'user-agent': 'CHE market context (owner research)' } });
      if (!res.ok) throw new Error(`answered ${res.status}`);
      const text = await res.text();
      if (src.type === 'fred_csv') {
        const series = parseFredCsv(text);
        await storage.put(`${SERIES_PREFIX}${src.series || src.id}`, { source: { name: src.name, url: src.url }, fetched_at: iso(now), points: series.filter((p, i) => i === 0 || p.value !== series[i - 1].value || i === series.length - 1) });
        Object.assign(entry, { ok: true, points: series.length });
      } else {
        const events = src.type === 'ics' ? icsEvents(text, src, { now }) : parseFomcCalendar(text, { now, source: { name: src.name, url: src.url } });
        const out = await appendEvents(storage, events, { now });
        Object.assign(entry, { ok: true, parsed: events.length, added: out.added, existing: out.existing, refused: out.refused.length });
      }
    } catch (e) { Object.assign(entry, { ok: false, error: String(e?.message || e).slice(0, 200) }); }
    log[src.id] = entry;
    report.sources.push({ id: src.id, name: src.name, status: entry.ok ? 'fetched' : 'failed', ...entry });
  }
  await storage.put(FETCH_LOG, log);
  return report;
}
export async function readSeries(storage, id) { return (await storage.get(`${SERIES_PREFIX}${id}`)) || null; }

// ─── Statistics ─────────────────────────────────────────────────────────────

function lgamma(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x; const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5); let ser = 1.000000000190015;
  for (const v of c) ser += v / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}
function betacf(a, b, x) {
  let qab = a + b; let qap = a + 1; let qam = a - 1; let c = 1; let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < 1e-30) d = 1e-30; d = 1 / d; let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m; let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30; c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30; d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30; c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30; d = 1 / d;
    const del = d * c; h *= del; if (Math.abs(del - 1) < 3e-12) break;
  }
  return h;
}
function ibeta(a, b, x) {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
/** Two-sided p-value of a t statistic with df degrees of freedom. */
export function tTwoSided(t, df) { if (!Number.isFinite(t) || !(df > 0)) return null; return ibeta(df / 2, 0.5, df / (df + t * t)); }
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const variance = (a) => { const m = mean(a); return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1); };
/** Welch's t-test of two samples: { t, df, p }. Needs two values in each. */
export function welch(a, b) {
  if (a.length < 2 || b.length < 2) return { t: null, df: null, p: null };
  const va = variance(a) / a.length; const vb = variance(b) / b.length;
  if (va + vb === 0) return { t: null, df: null, p: null };
  const t = (mean(a) - mean(b)) / Math.sqrt(va + vb);
  const df = (va + vb) ** 2 / ((va ** 2) / (a.length - 1) + (vb ** 2) / (b.length - 1));
  return { t: r4(t), df: r2(df), p: r4(tTwoSided(t, df)) };
}
/** One-sample t-test against zero. */
export function tOne(a) {
  if (a.length < 2) return { t: null, df: null, p: null };
  const v = variance(a); if (!v) return { t: null, df: null, p: null };
  const t = mean(a) / Math.sqrt(v / a.length);
  return { t: r4(t), df: a.length - 1, p: r4(tTwoSided(t, a.length - 1)) };
}

// ─── Event study (no look-ahead) ────────────────────────────────────────────

const TF_MS = { '1m': 60_000, '2m': 120_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000, '1D': DAY };
/** Round-trip cost in index points for one contract, from CHE's cost profiles. */
export function roundTripCostPoints(market = 'NQ', profile = 'NORMAL') {
  const c = COST_PROFILES[profile] || COST_PROFILES.NORMAL; const k = CONTRACTS[market] || CONTRACTS.NQ;
  const ticks = c.spreadTicks + 2 * c.slippageTicks;
  const dollars = 2 * (c.commissionPerSide + c.feePerSide);
  return { points: r4(ticks * k.tick + dollars / k.pointValue), dollars: r2(ticks * k.tick * k.pointValue + dollars), profile, assumptions: c };
}

/**
 * A price "known at" an instant: the close of the last bar that had ENDED by then (bar start + timeframe ≤ time), and
 * only if that bar ended within `maxStaleMs`. Bars after the instant are never read.
 */
export function knownPriceAt(bars, time, tfMs, maxStaleMs) {
  let lo = 0; let hi = bars.length - 1; let found = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (Date.parse(bars[mid].t) + tfMs <= time) { found = mid; lo = mid + 1; } else hi = mid - 1; }
  if (found < 0) return null;
  const end = Date.parse(bars[found].t) + tfMs;
  return time - end <= maxStaleMs ? { price: bars[found].c, bar_end: iso(end), index: found } : null;
}

const INTRADAY_WINDOWS = [{ id: '5m', ms: 5 * 60_000 }, { id: '30m', ms: 30 * 60_000 }, { id: '2h', ms: 120 * 60_000 }];

function intradayReaction(bars, t0, tfMs) {
  const stale = Math.max(2 * tfMs, 10 * 60_000);
  const base = knownPriceAt(bars, t0, tfMs, stale);
  if (!base) return null;
  const pre = knownPriceAt(bars, t0 - 30 * 60_000, tfMs, stale);
  const row = { base: base.price, base_bar_end: base.bar_end, pre_30m: pre ? r4((base.price / pre.price - 1) * 1e4) : null, returns_bps: {} };
  for (const w of INTRADAY_WINDOWS) { const p = knownPriceAt(bars, t0 + w.ms, tfMs, stale); row.returns_bps[w.id] = p ? r4((p.price / base.price - 1) * 1e4) : null; }
  const { day, mins } = etParts(t0);
  const closeDay = mins < 16 * 60 ? day : ymd(Date.parse(`${day}T12:00:00Z`) + DAY);
  const close = knownPriceAt(bars, nyToUtc(closeDay, 16, 0), tfMs, stale);
  row.returns_bps.close = close && nyToUtc(closeDay, 16, 0) > t0 ? r4((close.price / base.price - 1) * 1e4) : null;
  return row;
}
function dailyIndex(bars) { const m = new Map(); bars.forEach((b, i) => m.set(String(b.t).slice(0, 10), i)); return m; }
function dailyReaction(bars, idx, t0) {
  const D = tradeDayOf(t0);
  // the base is the last daily bar dated before the event's trading day: it settled before that day's session opened
  let i = idx.get(D);
  const prev = i != null ? i - 1 : bars.findLastIndex((b) => String(b.t).slice(0, 10) < D);
  if (i == null || prev < 0) return null;
  const base = bars[prev].c;
  const next = bars[i + 1];
  return { base, base_day: String(bars[prev].t).slice(0, 10), pre_1d: prev > 0 ? r4((base / bars[prev - 1].c - 1) * 1e4) : null,
    returns_bps: { day: r4((bars[i].c / base - 1) * 1e4), next_day: next ? r4((next.c / base - 1) * 1e4) : null } };
}
export function persistenceOf(early, late) {
  if (early == null || late == null || early === 0) return 'unknown';
  if (Math.sign(early) === Math.sign(late) && Math.abs(late) >= 0.5 * Math.abs(early)) return 'persistent';
  if (Math.sign(early) !== Math.sign(late) && Math.abs(late) >= 0.5 * Math.abs(early)) return 'reversed';
  return 'faded';
}

/**
 * Event study of one kind on one bar series. Baseline: the same measurement at the same New York clock time (intraday)
 * or on every trading day (daily) when no event of that kind, and no other high-impact scheduled event, happened.
 * Reports association, not causation; under MIN_EVENTS events it claims nothing.
 */
export function eventStudy({ events, bars, tf, market = 'NQ', kind, manifest = null, profile = 'NORMAL' }) {
  const tfMs = TF_MS[tf];
  if (!tfMs) return { ok: false, reason: `unsupported timeframe ${tf}` };
  if (!Array.isArray(bars) || bars.length < 30) return { ok: false, reason: 'not enough verified bars for a study' };
  const sorted = [...bars].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  const daily = tf === '1D';
  const ofKind = events.filter((e) => e.kind === kind && (!e.date_only || daily));
  const first = Date.parse(sorted[0].t); const last = Date.parse(sorted.at(-1).t) + tfMs;
  const inRange = ofKind.filter((e) => Date.parse(e.first_available) >= first && Date.parse(e.first_available) <= last);
  const idx = daily ? dailyIndex(sorted) : null;
  const rows = [];
  for (const e of inRange) {
    const t0 = Date.parse(e.first_available);
    const r = daily ? dailyReaction(sorted, idx, t0) : intradayReaction(sorted, t0, tfMs);
    if (!r) { rows.push({ id: e.id, title: e.title, first_available: e.first_available, status: 'no bars at the event time (gap or outside the session)' }); continue; }
    const [earlyId, lateId] = daily ? ['day', 'next_day'] : ['30m', 'close'];
    rows.push({ id: e.id, title: e.title, first_available: e.first_available, source_url: e.source_url, status: 'measured', ...r, persistence: persistenceOf(r.returns_bps[earlyId], r.returns_bps[lateId]) });
  }
  // baseline: matched non-event instants
  const blocked = new Set(events.filter((e) => e.kind === kind || EVENT_KINDS[e.kind]?.high_impact).map((e) => tradeDayOf(Date.parse(e.event_time))));
  const base = [];
  if (daily) {
    for (let i = 1; i < sorted.length; i++) {
      const d = String(sorted[i].t).slice(0, 10);
      if (blocked.has(d)) continue;
      const nx = sorted[i + 1];
      base.push({ day: r4((sorted[i].c / sorted[i - 1].c - 1) * 1e4), next_day: nx ? r4((nx.c / sorted[i - 1].c - 1) * 1e4) : null });
    }
  } else {
    const clocks = [...new Set(rows.filter((r) => r.status === 'measured').map((r) => etParts(Date.parse(r.first_available)).mins))];
    const days = [...new Set(sorted.map((b) => etParts(Date.parse(b.t)).day))];
    for (const d of days) {
      for (const mins of clocks) {
        const t = nyToUtc(d, Math.floor(mins / 60), mins % 60);
        if (blocked.has(tradeDayOf(t))) continue;
        const r = intradayReaction(sorted, t, tfMs);
        if (r) base.push(r.returns_bps);
      }
    }
  }
  const measured = rows.filter((r) => r.status === 'measured');
  const windows = daily ? ['day', 'next_day'] : [...INTRADAY_WINDOWS.map((w) => w.id), 'close'];
  const cost = roundTripCostPoints(market, profile);
  const basePrice = measured.length ? mean(measured.map((r) => r.base)) : null;
  const stats = {};
  for (const w of windows) {
    const ev = measured.map((r) => r.returns_bps[w]).filter((x) => x != null);
    const bl = base.map((r) => r[w]).filter((x) => x != null);
    if (!ev.length) { stats[w] = { n_events: 0, n_baseline: bl.length }; continue; }
    const absEv = ev.map(Math.abs); const absBl = bl.map(Math.abs);
    const meanAbsPts = basePrice ? (mean(absEv) / 1e4) * basePrice : null;
    stats[w] = {
      n_events: ev.length, n_baseline: bl.length,
      mean_bps: r2(mean(ev)), mean_abs_bps: r2(mean(absEv)), baseline_mean_abs_bps: bl.length ? r2(mean(absBl)) : null,
      abnormal_abs_bps: bl.length ? r2(mean(absEv) - mean(absBl)) : null,
      abs_move_vs_baseline: welch(absEv, absBl), direction_vs_zero: tOne(ev), share_up: r2(ev.filter((x) => x > 0).length / ev.length),
      mean_abs_points: meanAbsPts == null ? null : r2(meanAbsPts),
      covers_round_trip_cost: meanAbsPts == null ? null : r2(meanAbsPts / cost.points),
    };
  }
  const persistence = measured.reduce((o, r) => ({ ...o, [r.persistence]: (o[r.persistence] || 0) + 1 }), {});
  const enough = measured.length >= MIN_EVENTS;
  return {
    ok: true, kind, label: EVENT_KINDS[kind]?.label || kind, market, timeframe: tf, version: CONTEXT_VERSION,
    data: manifest ? { provider: manifest.provider, first: manifest.first, last: manifest.last, bars: manifest.bars, sha256: manifest.sha256 } : { first: sorted[0].t, last: sorted.at(-1).t, bars: sorted.length },
    events_in_range: inRange.length, events_measured: measured.length, baseline_samples: base.length,
    sample: enough ? 'sufficient' : 'insufficient', verdict: enough ? null : `Insufficient sample: ${measured.length} measured event${measured.length === 1 ? '' : 's'}; at least ${MIN_EVENTS} are needed before CHE reports a reaction.`,
    interpretation: 'Association, not causation. Other news on the same day is not separated out.',
    economic_note: 'covers_round_trip_cost compares the average absolute move with one round trip. Capturing it would require knowing the direction in advance, so it is an upper bound, not a tradable edge.',
    stats: enough ? stats : null, preview_stats: enough ? null : stats, persistence, cost, rows,
    no_look_ahead: 'Base prices and pre-event features use only bars that ended at or before the time the information became public.',
  };
}

export async function saveStudy(storage, study, { now = Date.now() } = {}) {
  const key = `${STUDY_PREFIX}${study.kind}:${study.market}:${study.timeframe}`;
  const rec = { ...study, run_at: iso(now) };
  await storage.put(key, rec);
  return rec;
}
export async function readStudies(storage) { return [...(await storage.list({ prefix: STUDY_PREFIX })).values()]; }

// ─── Regimes ────────────────────────────────────────────────────────────────

const pctRank = (arr, x) => (arr.length ? arr.filter((v) => v < x).length / arr.length : null);
const tercile = (p) => (p == null ? 'unknown' : p < 1 / 3 ? 'low' : p > 2 / 3 ? 'high' : 'normal');
/**
 * Regime of each trading day as known before it opened: realized volatility (20-day stdev of daily log returns) and
 * volume, each ranked against their own trailing year, events known in advance for that day, and the Fed cycle.
 */
export function dayRegimes(dailyBars, { events = [], fedSeries = null } = {}) {
  const bars = [...dailyBars].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  const rets = bars.map((b, i) => (i ? Math.log(b.c / bars[i - 1].c) : null));
  const vols = []; const out = [];
  const byDay = new Map();
  for (const e of events) { if (!e.known_in_advance) continue; const d = tradeDayOf(Date.parse(e.event_time)); (byDay.get(d) || byDay.set(d, []).get(d)).push(e.kind); }
  for (let i = 0; i < bars.length; i++) {
    const day = String(bars[i].t).slice(0, 10);
    // as of the open of day i: returns and volume up to day i-1
    const window = rets.slice(Math.max(1, i - 20), i).filter((x) => x != null);
    const rv = window.length >= 20 ? Math.sqrt(variance(window)) * Math.sqrt(252) : null;
    const trailingRv = vols.slice(-252).filter((x) => x != null);
    const priorVol = i ? bars[i - 1].v : null;
    const trailingVolume = bars.slice(Math.max(0, i - 253), Math.max(0, i - 1)).map((b) => b.v).filter((v) => v > 0);
    const kinds = byDay.get(day) || [];
    out.push({
      day, as_of: 'before the session opened (data through the previous day)',
      volatility: trailingRv.length >= 60 && rv != null ? tercile(pctRank(trailingRv, rv)) : 'unknown', realized_vol_20d: rv == null ? null : r4(rv),
      liquidity: priorVol > 0 && trailingVolume.length >= 60 ? tercile(pctRank(trailingVolume, priorVol)) : 'unknown',
      event_day: kinds.length > 0, events: [...new Set(kinds)], high_impact_event_day: kinds.some((k) => EVENT_KINDS[k]?.high_impact),
      fed_cycle: fedCycleOn(fedSeries, day).state,
    });
    vols.push(rv);
  }
  return out;
}
/** Intraday session of an instant (the shared CHE session table, New York time). */
export const sessionOf = (time) => sessionAt(time, '5m');

// ─── Chart annotations and warnings ─────────────────────────────────────────

const PROVENANCE_LABEL = { rule: 'rule-derived (published rule)', fetched: 'from the official schedule', owner: 'owner-cited source' };
export function annotationsFor(events, studies = [], { from = null, to = null, market = 'NQ' } = {}) {
  const f = from ? Date.parse(from) : -Infinity; const t = to ? Date.parse(to) : Infinity;
  const reactions = new Map();
  for (const s of studies) for (const r of s.rows || []) if (r.status === 'measured' && s.market === market) reactions.set(r.id, { ...r.returns_bps, timeframe: s.timeframe, persistence: r.persistence });
  return events.filter((e) => e.instruments.includes(market) && Date.parse(e.first_available) >= f && Date.parse(e.first_available) <= t).map((e) => {
    const obs = reactions.get(e.id) || null;
    return {
      id: e.id, t: e.first_available, kind: e.kind, label: EVENT_KINDS[e.kind]?.label || e.kind, title: e.title, scheduled: e.scheduled, date_only: e.date_only,
      source_name: e.source_name, source_url: e.source_url, provenance: PROVENANCE_LABEL[e.provenance?.method] || e.provenance?.method,
      verified: e.provenance?.method === 'fetched' ? 'official schedule' : e.provenance?.method === 'rule' ? 'rule-derived, unconfirmed' : 'owner-cited, unverified',
      observed_reaction: obs, reaction_label: obs ? reactionLabel(obs) : 'no measured reaction',
    };
  });
}
function reactionLabel(o) {
  const parts = Object.entries(o).filter(([k, v]) => !['timeframe', 'persistence'].includes(k) && v != null).map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${r2(v / 100)}%`);
  return `${parts.join(', ')} (${o.persistence}; observed, not caused)`;
}
/** Events with a known time inside the horizon, nearest first, for "CPI in 25 minutes" warnings. */
export function upcomingEvents(events, now = Date.now(), horizonMin = 24 * 60) {
  return events.filter((e) => !e.date_only && e.known_in_advance && Date.parse(e.event_time) >= now && Date.parse(e.event_time) - now <= horizonMin * 60_000)
    .sort((a, b) => Date.parse(a.event_time) - Date.parse(b.event_time))
    .map((e) => ({ id: e.id, kind: e.kind, label: EVENT_KINDS[e.kind]?.label || e.kind, title: e.title, event_time: e.event_time, minutes_until: Math.round((Date.parse(e.event_time) - now) / 60_000), high_impact: EVENT_KINDS[e.kind]?.high_impact === true, source_name: e.source_name, source_url: e.source_url }));
}
export function speakUpcoming(list) {
  if (!list.length) return 'No scheduled market event with a known time is in my calendar for the next 24 hours, sir. My calendar holds only events from official schedules and published rules; refresh it to fetch the latest schedules.';
  const say = list.slice(0, 5).map((u) => `${u.label} in ${u.minutes_until < 120 ? `${u.minutes_until} minutes` : `${Math.round(u.minutes_until / 60)} hours`} (${u.source_name.split(' — ')[0]})`);
  return `Coming up, sir: ${say.join('; ')}. These are possible catalysts, not predictions.`;
}

// ─── Market-context models (strategy library entries) ───────────────────────

const STUDY_SPEC = (kind, w) => `Event study of ${EVENT_KINDS[kind].label}: price known at the moment the information became public (close of the last finished bar), returns ${w}, against matched non-event baselines; Welch t-test on absolute moves; persistence = whether the later move keeps at least half the early move in the same direction.`;
const MODEL_DEFS = [
  { id: 'ctx-fomc-decision', name: 'FOMC decision reaction', kinds: ['fomc_decision'], sources: ['fomc'], tf: ['5m', '1D'], window: '+5m, +30m, +2h and to the close (intraday); day and next day (daily)' },
  { id: 'ctx-fomc-presser', name: 'Fed chair press conference reaction', kinds: ['fomc_presser'], sources: ['fed_presser'], tf: ['5m'], window: '+5m, +30m, +2h and to the close' },
  { id: 'ctx-cpi', name: 'CPI release reaction', kinds: ['cpi'], sources: ['bls'], tf: ['5m', '1D'], window: '+5m, +30m, +2h and to the close; day and next day' },
  { id: 'ctx-nfp', name: 'Payrolls (Employment Situation) reaction', kinds: ['nfp'], sources: ['bls'], tf: ['5m', '1D'], window: '+5m, +30m, +2h and to the close; day and next day' },
  { id: 'ctx-ppi', name: 'PPI release reaction', kinds: ['ppi'], sources: ['bls'], tf: ['5m', '1D'], window: 'as CPI' },
  { id: 'ctx-pce', name: 'PCE release reaction', kinds: ['pce'], sources: ['bea'], tf: ['5m', '1D'], window: 'as CPI', missing: 'BEA publishes no schedule CHE can read automatically yet; add BEA release dates as a calendar source or as cited events.' },
  { id: 'ctx-jobless', name: 'Weekly jobless claims reaction', kinds: ['jobless_claims'], sources: ['dol'], tf: ['5m'], window: '+5m, +30m', missing: 'The Labor Department schedule is not ingested; add it as a calendar source.' },
  { id: 'ctx-opex-monthly', name: 'Monthly options expiration day', kinds: ['opex_monthly'], sources: ['cme_options_rule'], tf: ['1D'], window: 'day and next day (the expiry time is not established, so no intraday window)' },
  { id: 'ctx-quarterly', name: 'Quarterly expiration and Nasdaq-100 rebalance', kinds: ['opex_quarterly', 'index_rebalance'], sources: ['cme_spec', 'ndx_method'], tf: ['5m', '1D'], window: '+5m … close (expiry at 9:30 a.m. ET); rebalance effective after the close: next day' },
  { id: 'ctx-holiday', name: 'Holiday and early-close sessions', kinds: ['early_close', 'holiday'], sources: ['cme_calendar'], tf: ['1D'], window: 'day and next day' },
  { id: 'ctx-earnings', name: 'Large-company earnings reaction', kinds: ['earnings'], sources: [], tf: ['5m', '1D'], window: 'next session open, +30m, close', missing: 'No earnings calendar source is ingested. Add one (with each report time, before open or after close) as a calendar source or as cited events.' },
  { id: 'ctx-political', name: 'Political statements and posts', kinds: ['political_statement'], sources: [], tf: ['1m', '5m'], window: '+5m, +30m, +2h from the post\'s original timestamp', missing: 'Only owner-cited posts with their original timestamp count. None are stored until the owner adds them.',
    source_limits: 'Truth Social has no free official API and the X API is paid, so CHE does not collect posts automatically, does not scrape against either site\'s terms and spends nothing. A post counts when the owner adds its link, or a cited news or wire report that quotes it; CHE keeps the post time and the report time, and measures from the report time unless the post itself is cited.' },
  { id: 'ctx-geopolitical', name: 'Geopolitical developments', kinds: ['geopolitical'], sources: [], tf: ['5m', '1D'], window: 'from the first-report timestamp of a cited source', missing: 'Only owner-cited reports count; none are stored until added.' },
];
export const CONTEXT_CLASSIFIERS = Object.freeze([
  { id: 'regime-volatility', name: 'Volatility regime (20-day realized volatility vs its trailing year)', note: 'A tag for breaking down results, computed before each session; not a trading model.' },
  { id: 'regime-liquidity', name: 'Liquidity regime (prior-day volume vs its trailing year)', note: 'Uses the dataset volume; Yahoo futures volume is the front month only.' },
  { id: 'regime-session', name: 'Session (Globex overnight, London, New York open, morning, lunch, afternoon, close)', note: 'The shared CHE session table, New York time.' },
  { id: 'regime-fed-cycle', name: 'Fed cycle (hiking, cutting, holding)', note: 'From the FRED target-rate series; the 180-day window is CHE\'s own choice.' },
  { id: 'regime-event-day', name: 'Event day (scheduled events known in advance)', note: 'Only events known before the session count, so results are not split by hindsight.' },
]);

/** Library entries with their honest stage and why each is not running. */
export function contextModels(events, studies) {
  const byKind = events.reduce((m, e) => m.set(e.kind, (m.get(e.kind) || 0) + 1), new Map());
  return MODEL_DEFS.map((d) => {
    const nEvents = d.kinds.reduce((s, k) => s + (byKind.get(k) || 0), 0);
    const own = studies.filter((s) => d.kinds.includes(s.kind));
    const best = own.reduce((b, s) => (!b || s.events_measured > b.events_measured ? s : b), null);
    const implemented = nEvents > 0;
    const backtested = own.some((s) => s.sample === 'sufficient');
    const stage = backtested ? 'backtested' : implemented ? 'implemented' : 'rules_documented';
    let reason;
    if (!implemented) reason = d.missing || 'No events of this kind are stored yet: refresh the market calendar.';
    else if (!own.length) reason = `${nEvents} events stored; no study has been run on verified bars yet.`;
    else if (!backtested) reason = `Studied, but ${best.events_measured} measured event${best.events_measured === 1 ? '' : 's'} is below the ${MIN_EVENTS} needed (${best.timeframe} data ${String(best.data?.first || '').slice(0, 10)} to ${String(best.data?.last || '').slice(0, 10)}).`;
    else reason = 'A market-context model describes conditions; it is not traded by itself. Forward and paper testing happen when a strategy uses it as a filter.';
    return {
      id: d.id, kind: 'market_context', name: d.name, category: 'market_context', stage, stage_label: STAGES.find((s) => s.id === stage).label,
      sources: d.sources.map((k) => ({ name: SOURCES[k].name, url: SOURCES[k].url })), rules: STUDY_SPEC(d.kinds[0], d.window),
      documented_assumptions: ['Event time and first-available time come from the cited source or published rule.', 'Prices are CHE\'s verified dataset bars (provider shown on each study).', 'Costs: CHE NORMAL cost profile.'],
      timeframes: d.tf, data_requirements: `NQ/MNQ bars at ${d.tf.join(' or ')} covering the events; events of kind ${d.kinds.join(', ')}.`,
      event_dependencies: d.kinds, events_stored: nEvents,
      results: own.map((s) => ({ market: s.market, timeframe: s.timeframe, events_measured: s.events_measured, sample: s.sample, run_at: s.run_at, verdict: s.verdict })),
      limitations: ['Association, not causation.', 'Free delayed data has short intraday history (about 59 days of 5-minute bars), so intraday studies are usually small.', 'Same-day news is not separated out.'],
      source_limits: d.source_limits || null, reason_not_running: reason, live_trading: 'disabled',
    };
  });
}

const LIB_SOURCE_TYPE = { fomc: 'economic_calendar', bls: 'economic_calendar', bea: 'economic_calendar', dol: 'economic_calendar', fred_target: 'economic_calendar', fed_presser: 'website',
  cme_spec: 'market_event', cme_options_rule: 'market_event', ndx_method: 'market_event' };
// Models whose events CHE can obtain by itself (a published rule or an official machine-readable calendar).
const INGESTIBLE = new Set(['ctx-fomc-decision', 'ctx-fomc-presser', 'ctx-cpi', 'ctx-nfp', 'ctx-ppi', 'ctx-opex-monthly', 'ctx-quarterly', 'ctx-holiday']);
/**
 * Strategy-library entries (kind market_context), in the library's che.library_entry/1 shape. A model without an
 * ingestible event source asks for no more than RULES DOCUMENTED; the library computes anything higher from evidence.
 */
export function libraryEntries() {
  return MODEL_DEFS.map((d) => ({
    id: d.id, kind: 'market_context', name: d.name, category: 'other', lane: 'T7', engine: INGESTIBLE.has(d.id) ? 'market_context' : 'none',
    sources: [
      ...d.sources.map((k) => (SOURCES[k].url.startsWith('repo:') ? { type: 'repo_code', title: SOURCES[k].name, file: 'server/cloudflare/trading_research.js' } : { type: LIB_SOURCE_TYPE[k] || 'website', title: SOURCES[k].name, url: SOURCES[k].url })),
      ...(d.kinds.includes('political_statement') || d.kinds.includes('geopolitical') ? [{ type: 'news', title: 'Owner-cited news or wire reports that quote the original item with its timestamp' }] : []),
      ...(d.kinds.includes('earnings') ? [{ type: 'market_event', title: 'Company earnings dates and report times (before open / after close), from a cited calendar' }] : []),
    ].concat(d.sources.length ? [] : [{ type: 'description', title: 'CHE event-study design (docs/CHE_MARKET_CONTEXT.md)' }]),
    rules: [STUDY_SPEC(d.kinds[0], d.window)],
    assumptions: ['Event time and first-available time come from the cited source or published rule.', "Prices are CHE's verified dataset bars, with the provider shown on each study.", 'Costs: CHE NORMAL cost profile (1 tick spread, 1 tick slippage per side, $1.50 commission and $0.50 fees per side).'],
    timeframes: d.tf.map((t) => ({ '1m': 1, '5m': 5, '1D': 1440 }[t])).filter(Boolean),
    data_requirements: [`NQ/MNQ bars at ${d.tf.join(' or ')} covering the events`, `events of kind ${d.kinds.join(', ')} with their first-available time`],
    event_dependencies: d.kinds,
    limitations: ['Association, not causation.', 'Free delayed data has about 59 days of 5-minute history, so intraday studies are usually small.', 'Same-day news is not separated out.',
      ...(d.missing ? [d.missing] : []), ...(d.source_limits ? [d.source_limits] : [])],
    ...(INGESTIBLE.has(d.id) ? {} : { lifecycle_requested: 'rules_documented' }),
  }));
}

/** The whole page: counts by kind and stage, sources, models, upcoming events. */
export async function contextView(storage, { now = Date.now() } = {}) {
  const events = await readEvents(storage);
  const studies = await readStudies(storage);
  const models = contextModels(events, studies);
  const byKind = Object.fromEntries(Object.keys(EVENT_KINDS).map((k) => [k, { label: EVENT_KINDS[k].label, count: events.filter((e) => e.kind === k).length,
    sources: [...new Set(events.filter((e) => e.kind === k).map((e) => e.source_name))] }]));
  const byStage = Object.fromEntries(STAGES.map((s) => [s.id, models.filter((m) => m.stage === s.id).length]));
  return {
    version: CONTEXT_VERSION, events_total: events.length, events_by_kind: byKind, models, classifiers: CONTEXT_CLASSIFIERS, models_by_stage: byStage,
    sources: await readSources(storage), fetch_log: (await storage.get(FETCH_LOG)) || {}, upcoming: upcomingEvents(events, now),
    studies: studies.map((s) => ({ kind: s.kind, market: s.market, timeframe: s.timeframe, events_measured: s.events_measured, sample: s.sample, run_at: s.run_at })),
    live_trading: 'disabled', note: 'Events are possible catalysts, never predictions.',
  };
}

/** "What market events are coming up", "any economic events today", "refresh the market calendar". */
export function contextIntent(message) {
  const t = String(message || '').toLowerCase().replace(/[’]/g, "'").replace(/^(?:hey |ok |okay )?(?:che|chey|chay)[,:]?\s*/, '').trim();
  if (/\b(?:refresh|update|fetch|reload) (?:the |my )?(?:market|economic) (?:calendar|events|context)\b/.test(t)) return { kind: 'refresh' };
  if (/\b(?:refresh|reload)\b/.test(t) && /\b(?:market|economic) (?:calendar|events|context)\b/.test(t)) return { kind: 'refresh' };
  if (/\b(?:what|which|any) (?:market|economic|macro|news) events?\b|\b(?:market|economic) (?:events|calendar) (?:today|coming up|this week)\b|\bis there (?:a |an )?(?:fomc|cpi|fed|jobs report|nfp)\b/.test(t)) return { kind: 'upcoming' };
  return null;
}
