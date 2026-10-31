// Timers and reminders CHE really runs (owner, 2026-10-31: "make CHE execute authorized actions reliably").
// A timer is a record in this Durable Object's storage with a fire time; the object's alarm wakes at that time and
// marks it fired. Every step has a receipt: the set is read back from storage before CHE says it is set, the firing
// is stamped when the alarm actually ran, and the owner hears it in the reply to whatever he says next (the same
// channel trade alerts use: there is no phone push). Nothing here calls a model or the network.
import { recordReceipt } from './truth_layer.js';
import { safeTimeZone, zonedWallTimeToUtc } from './google_services.js';

export const TIMERS_KEY = 'owner_timers';
// The certification probe runs as the owner on his own Durable Object. Its timers live under their own key, fire on the
// same alarm, and never reach the owner's timer list, his receipt log, his Brain or his next reply.
export const PROBE_TIMERS_KEY = 'owner_timers:probe';
export const TIMER_KEYS = [TIMERS_KEY, PROBE_TIMERS_KEY];
const MAX_ACTIVE = 20;
const MIN_MS = 5_000;
const MAX_MS = 7 * 24 * 3600_000;
const KEEP_FIRED = 20;

const WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, 'twenty-five': 25, thirty: 30, 'forty-five': 45, forty: 40, fifty: 50, sixty: 60, ninety: 90 };
const UNIT_MS = { s: 1000, m: 60_000, h: 3600_000 };
const AMOUNT = String.raw`(\d+(?:\.\d+)?|${Object.keys(WORDS).sort((x, y) => y.length - x.length).join('|')})`;
const DURATION = new RegExp(String.raw`\b${AMOUNT}[\s-]*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b`, 'gi');
const HALF_HOUR = /\bhalf an? hour\b/i;
const CLOCK = /\b(?:at|for)\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?=\s|$|[.,!?])/i;

const SET = /\b(?:set|start|create|put on)\s+(?:a|an|the|my|\d+)?\s*(?:[\w-]+\s+){0,2}?(?:timer|alarm|reminder)s?\b|\bremind me\b|\b(?:timer|alarm)\s+for\b/i;
const CANCEL = /\b(?:cancel|stop|delete|clear|remove|turn off)\b[^.?!]{0,30}\b(?:timers?|alarms?|reminders?)\b/i;
const LIST = /\b(?:what|which|any|show|list|how many)\b[^.?!]{0,30}\b(?:timers?|alarms?|reminders?)\b|\bhow (?:much|long)\b[^.?!]{0,30}\b(?:left|remaining)\b[^.?!]{0,30}\btimer\b|\b(?:did|has|is)\s+my\s+(?:timer|alarm|reminder)\b/i;
const ABOUT = /\b(?:timers?|alarms?|reminders?|remind me)\b/i;
// A day or date the timer cannot place by itself ("next month", "on Friday", "tomorrow" with no time).
const HORIZON = /\b(?:next\s+(?:week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|on\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|tomorrow|tonight|this\s+(?:weekend|evening|afternoon)|later|someday|every\s+\w+)\b/i;
const QUESTION_ONLY = /^(?:what is|what's|how does|how do|why|explain|tell me about)\b(?![^?]*\bmy\b)/i;

function amountOf(word) {
  const w = String(word).toLowerCase();
  return Number.isFinite(Number(w)) ? Number(w) : WORDS[w] || 0;
}

/** Duration in ms said in the message ("10 minutes", "an hour and 30 minutes", "half an hour"), or 0. */
export function durationMs(message) {
  let text = String(message || '');
  let total = HALF_HOUR.test(text) ? 30 * 60_000 : 0;
  text = text.replace(HALF_HOUR, ' ');
  for (const m of text.matchAll(DURATION)) total += amountOf(m[1]) * UNIT_MS[m[2][0].toLowerCase()];
  return Math.round(total);
}

/** The next instant of a wall-clock time ("at 7 am", "for 5:30 pm") in the owner's zone, or 0. */
export function clockTimeMs(message, timeZone, now = Date.now()) {
  const m = CLOCK.exec(String(message || ''));
  if (!m) return 0;
  let h = Number(m[1]);
  const mi = Number(m[2] || 0);
  const half = (m[3] || '').toLowerCase().replace(/\./g, '');
  if (h > 23 || mi > 59 || (half && (h < 1 || h > 12))) return 0;
  if (half === 'pm' && h < 12) h += 12;
  if (half === 'am' && h === 12) h = 0;
  const zone = safeTimeZone(timeZone);
  // "Tomorrow at 9 am" is on tomorrow's date; a bare "at 9 am" is the next 9 am.
  // The wall time is placed on a calendar date, never by adding 24 hours: across a daylight-saving change that would
  // move it an hour (live run 41210217956: "6:45 am" was set for 5:45 AM on the day clocks went back).
  const dateOf = (ms) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms)).map((p) => [p.type, Number(p.value)]));
  const on = (d, add) => { const u = new Date(Date.UTC(d.year, d.month - 1, d.day + add)); return zonedWallTimeToUtc(u.getUTCFullYear(), u.getUTCMonth() + 1, u.getUTCDate(), h, mi, zone); };
  const today = dateOf(now);
  if (/\btomorrow\b/i.test(String(message))) return on(today, 1);
  const at = on(today, 0);
  return at > now ? at : on(today, 1);
}

/** What a message asks of the timer connector: set, cancel, list, or null when it is not about CHE's timers. */
export function timerIntent(message) {
  const text = String(message || '').trim();
  if (!text || !ABOUT.test(text) || QUESTION_ONLY.test(text)) return null;
  if (CANCEL.test(text)) return { action: 'cancel' };
  if (LIST.test(text)) return { action: 'list' };
  if (SET.test(text)) return { action: 'set' };
  return null;
}

/** "remind me to call Sam in 10 minutes" -> "call Sam". */
export function timerLabel(message) {
  const m = /\b(?:to|that|about)\s+(.+?)(?:\s+(?:in|at|for|after)\s+(?:\d|an?\b|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|fifty|sixty|ninety|half).*)?[.!?]*$/i.exec(String(message || ''));
  const label = m ? m[1].replace(/\b(?:please|sir)\b/gi, '').trim() : '';
  return /^(?:set|start|create)\b/i.test(label) ? '' : label.slice(0, 80);
}

async function load(storage, key = TIMERS_KEY) {
  const list = await storage.get(key);
  return Array.isArray(list) ? list : [];
}

// The owner's timers write to his receipt log; probe timers keep their receipts on the timer record only.
async function receipt(storage, key, timer, entry) {
  timer.receipts = [...(timer.receipts || []), { kind: entry.kind, at: entry.at }];
  if (key === TIMERS_KEY) await recordReceipt(storage, entry);
}

function makeId(now) {
  const rand = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '').slice(0, 8) : Math.random().toString(16).slice(2, 10);
  return `t-${now.toString(36)}-${rand}`;
}

/** Saves a timer and reads it back. Returns { timer } only when the stored record matches, else { error }. */
export async function setTimer(storage, { ms = 0, at = 0, label = '', kind = 'timer', now = Date.now(), key = TIMERS_KEY } = {}) {
  const fireAt = at || now + ms;
  const span = fireAt - now;
  if (!(span >= MIN_MS)) return { error: 'too_short' };
  if (span > MAX_MS) return { error: 'too_long' };
  const list = await load(storage, key);
  if (list.filter((t) => t.status === 'scheduled').length >= MAX_ACTIVE) return { error: 'too_many' };
  const timer = { id: makeId(now), kind, label: String(label || '').slice(0, 80), set_at: new Date(now).toISOString(), fire_at: new Date(fireAt).toISOString(), duration_ms: span, status: 'scheduled', receipts: [{ kind: 'timer_set', at: new Date(now).toISOString() }] };
  await storage.put(key, [...list, timer]);
  const back = (await load(storage, key)).find((t) => t.id === timer.id);
  if (!back || back.fire_at !== timer.fire_at || back.status !== 'scheduled') return { error: 'not_verified' };
  if (key === TIMERS_KEY) await recordReceipt(storage, { kind: 'timer_set', key: `timer_set:${timer.id}`, timer_id: timer.id, fire_at: timer.fire_at, at: timer.set_at });
  return { timer: back };
}

/** Cancels every scheduled timer (or the one whose label matches). Returns the cancelled records. */
export async function cancelTimers(storage, { match = '', now = Date.now(), key = TIMERS_KEY } = {}) {
  const list = await load(storage, key);
  const words = String(match || '').toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  const scheduled = list.filter((t) => t.status === 'scheduled');
  const picked = words.length ? scheduled.filter((t) => words.some((w) => t.label.toLowerCase().includes(w))) : [];
  const cancel = picked.length ? picked : scheduled;
  for (const t of cancel) { t.status = 'cancelled'; t.cancelled_at = new Date(now).toISOString(); }
  for (const t of cancel) await receipt(storage, key, t, { kind: 'timer_cancelled', key: `timer_cancelled:${t.id}`, timer_id: t.id, at: t.cancelled_at });
  if (cancel.length) await storage.put(key, list);
  return cancel;
}

/** Earliest scheduled fire time (ms), or 0. The Durable Object alarm includes it. */
export async function nextTimerAt(storage, key = TIMERS_KEY) {
  const times = (await load(storage, key)).filter((t) => t.status === 'scheduled').map((t) => Date.parse(t.fire_at)).filter(Number.isFinite);
  return times.length ? Math.min(...times) : 0;
}

/** Called by the alarm: every timer due by `now` is marked fired, stamped with when the alarm really ran. */
export async function fireDueTimers(storage, now = Date.now(), key = TIMERS_KEY) {
  const list = await load(storage, key);
  const due = list.filter((t) => t.status === 'scheduled' && Date.parse(t.fire_at) <= now);
  if (!due.length) return [];
  for (const t of due) {
    t.status = 'fired'; t.fired_at = new Date(now).toISOString(); t.announced = false;
    await receipt(storage, key, t, { kind: 'timer_fired', key: `timer_fired:${t.id}`, timer_id: t.id, fire_at: t.fire_at, fired_at: t.fired_at, at: t.fired_at });
  }
  const scheduled = list.filter((t) => t.status === 'scheduled');
  const done = list.filter((t) => t.status !== 'scheduled').slice(-KEEP_FIRED);
  await storage.put(key, [...scheduled, ...done]);
  return due;
}

function clock(ms, timeZone) {
  return new Intl.DateTimeFormat('en-US', { timeZone: safeTimeZone(timeZone), hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
}

export function spokenDuration(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const part = (n, unit) => (n ? `${n} ${unit}${n === 1 ? '' : 's'}` : '');
  return [part(h, 'hour'), part(m, 'minute'), h ? '' : part(sec, 'second')].filter(Boolean).join(' ') || '0 seconds';
}

function name(t) {
  return `${t.kind === 'reminder' ? 'reminder' : `${spokenDuration(t.duration_ms)} timer`}${t.label ? ` (${t.label})` : ''}`;
}

/** Fired timers the owner has not heard yet, as one line; marks them heard. */
export async function takeTimerAnnouncement(storage, timeZone = 'UTC', key = TIMERS_KEY) {
  const list = await load(storage, key);
  const fresh = list.filter((t) => t.status === 'fired' && !t.announced);
  if (!fresh.length) return '';
  for (const t of fresh) t.announced = true;
  await storage.put(key, list);
  return fresh.map((t) => `Your ${name(t)} went off at ${clock(Date.parse(t.fired_at), timeZone)}, sir (timer ${t.id}).`).join(' ');
}

/** CHE's answer for a timer request, from the timer records (no model). Null when the message is not about timers. */
export async function timerChatTurn(storage, message, { timeZone = 'UTC', now = Date.now(), wake = null, key = TIMERS_KEY } = {}) {
  const intent = timerIntent(message);
  if (!intent) return null;
  const zone = safeTimeZone(timeZone);
  const meta = (extra = {}) => ({ source: 'che_timer', model_calls: 0, ...extra });
  if (intent.action === 'list') {
    const list = await load(storage, key);
    const live = list.filter((t) => t.status === 'scheduled');
    const fired = list.filter((t) => t.status === 'fired').slice(-3);
    if (!live.length && !fired.length) return { text: 'You have no timers or reminders, sir. Nothing is running.', meta: meta({ timers: [] }) };
    const lines = live.map((t) => `${name(t)}: goes off at ${clock(Date.parse(t.fire_at), zone)}, ${spokenDuration(Math.max(0, Date.parse(t.fire_at) - now))} left (timer ${t.id}).`);
    const past = fired.map((t) => `${name(t)} went off at ${clock(Date.parse(t.fired_at), zone)} (timer ${t.id}).`);
    return { text: `${live.length ? `Running, sir: ${lines.join(' ')}` : 'No timer is running, sir.'}${past.length ? ` Earlier: ${past.join(' ')}` : ''}`, meta: meta({ timers: live.map((t) => t.id) }) };
  }
  if (intent.action === 'cancel') {
    const cancelled = await cancelTimers(storage, { match: timerLabel(message), now, key });
    if (wake) await wake();
    if (!cancelled.length) return { text: 'There is no running timer to cancel, sir. Nothing changed.', meta: meta({ cancelled: [] }) };
    return { text: `Cancelled, sir: ${cancelled.map((t) => `${name(t)} (timer ${t.id})`).join(', ')}. It will not go off.`, meta: meta({ cancelled: cancelled.map((t) => t.id), execution_receipt: { tool: 'che_timer', operation: 'cancel', status: 'success', timer_ids: cancelled.map((t) => t.id) } }) };
  }
  const ms = durationMs(message);
  const at = ms ? 0 : clockTimeMs(message, zone, now);
  const label = timerLabel(message);
  const kind = /\bremind/i.test(message) ? 'reminder' : 'timer';
  if (!ms && !at && HORIZON.test(message)) {
    return { text: `I did not set that reminder, sir: my timer takes a length ("in 20 minutes") or a clock time ("at 5 pm", "tomorrow at 9 am"), up to seven days ahead, and "${HORIZON.exec(message)[0]}" is not one I can place. Give me a time and I'll set it.`, meta: meta({ ok: false, needs: 'time' }) };
  }
  if (!ms && !at) {
    return { text: `For how long, sir? Say something like "set a timer for 10 minutes" or "remind me at 5 pm to call Sam". Nothing is set yet.`, meta: meta({ needs: 'duration' }) };
  }
  const result = await setTimer(storage, { ms, at, label, kind, now, key });
  if (result.error) {
    const why = { too_short: 'that is under five seconds', too_long: 'that is more than seven days away', too_many: 'twenty timers are already running', not_verified: 'I could not read the timer back from storage' }[result.error];
    return { text: `I did not set it, sir: ${why}. Nothing is running for it.`, meta: meta({ ok: false, error: result.error }) };
  }
  if (wake) await wake();
  const t = result.timer;
  const fire = Date.parse(t.fire_at);
  const what = kind === 'reminder' ? `Reminder set, sir${t.label ? `: ${t.label}` : ''}` : `Timer set, sir: ${spokenDuration(t.duration_ms)}`;
  return {
    text: `${what}, at ${clock(fire, zone)}. It is saved on CHE's server as timer ${t.id}, and I read it back. I can't ring your phone, so I'll tell you it went off in my next reply after that time; ask "what timers do I have?" anytime.`,
    meta: meta({ ok: true, timer: t, execution_receipt: { tool: 'che_timer', operation: 'set', status: 'success', timer_id: t.id, fire_at: t.fire_at, set_at: t.set_at, verified: 'read_back' } }),
  };
}
