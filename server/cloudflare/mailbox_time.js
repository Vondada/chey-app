// Flagstaff message times (owner report, 2026-10-24: his iPhone said 12:16 PM Central and a Claude message
// already showed 2:30 PM).
//
// Cause, from the che-mailbox history: AIs that write mailbox/<peer>.jsonl directly type the "at" value by hand.
// Claude's line "claude-20261024-1930" says 2026-10-24T19:30:00Z (2:30 PM CDT) but the commit that added it
// (b070024) is 2026-10-24T16:39:50Z (11:39 AM CDT); 33 agent lines on that branch are stamped after the commit
// that wrote them. Lines the Worker writes (sendMail) use its own clock, and the files are append-only.
//
// So every message keeps the time its sender wrote, as long as that time is possible. A time can't be later than
// when the line could have existed: before a later line in the same file stamped by the Worker's clock, and
// before the Worker first saw it (or now). An impossible time is replaced by that latest possible time and the
// sender's value is kept as claimed_at. Stored history is never rewritten: this runs on read only.
//
// All times leave here as UTC ISO-8601 with Z; the app shows them in the device's own zone.
// Legacy values: of the 856 lines on che-mailbox (2026-10-24), none has a clock time without a zone (Worker
// toISOString, agents' "...Z", Python isoformat "+00:00"); 7 ChatGPT lines are a bare date. A zone-less clock time
// is read as UTC, like every writer produced, and marked at_zone: 'assumed-utc'. A bare date stays a date
// (at_precision: 'day', midnight UTC) so no zone moves it to the day before.

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i;
const WORKER_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TOLERANCE_MS = 2 * 60_000;   // a sender's clock may run a little ahead

/** One `at` value as { ms, day, assumed } (UTC milliseconds), or null when it is not a date. */
export function parseMailTime(value) {
  const m = ISO.exec(String(value ?? '').trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac, zone] = m;
  if (h === undefined) {
    const ms = Date.UTC(+y, +mo - 1, +d);
    return Number.isFinite(ms) ? { ms, day: true, assumed: false } : null;
  }
  let offset = 0;
  if (zone && zone.toUpperCase() !== 'Z') {
    const z = /^([+-])(\d{2}):?(\d{2})?$/.exec(zone);
    offset = (z[1] === '-' ? -1 : 1) * (+z[2] * 60 + +(z[3] || 0)) * 60_000;
  }
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0), Math.floor(Number(`0.${frac || 0}`) * 1000)) - offset;
  if (!Number.isFinite(ms) || +mo > 12 || +d > 31 || +h > 23 || +mi > 59) return null;
  return { ms, day: false, assumed: !zone };
}

/** Sort key: creation time in UTC milliseconds (unknown times last). */
export function mailTimeMs(message) {
  return parseMailTime(message?.at)?.ms ?? Number.MAX_SAFE_INTEGER;
}

/** Oldest first by creation time. Array.prototype.sort is stable, so equal times keep their read order. */
export function byMailTime(a, b) {
  return mailTimeMs(a) - mailTimeMs(b);
}

/**
 * One thread file's messages, in file (= write) order, with each `at` normalised to UTC ISO Z.
 * `seen` maps id -> when the Worker first saw the line (ISO); with it each message also gets `received_at`.
 */
export function normalizeThreadTimes(messages, { now = Date.now(), seen = null } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const out = new Array(list.length);
  let later = Number.POSITIVE_INFINITY;   // earliest Worker-clock time among later lines
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (!m || typeof m !== 'object') { out[i] = m; continue; }
    const receivedMs = parseMailTime(seen?.get?.(m.id))?.ms ?? now;
    const latest = Math.min(later, receivedMs);
    const parsed = parseMailTime(m.at);
    const row = { ...m };
    if (seen) row.received_at = new Date(receivedMs).toISOString();
    if (!parsed || parsed.ms > latest + TOLERANCE_MS) {
      row.at = new Date(latest).toISOString();
      if (m.at !== undefined && m.at !== '') row.claimed_at = m.at;
      row.at_source = 'bounded';
    } else {
      row.at = new Date(parsed.ms).toISOString();
      if (parsed.day) row.at_precision = 'day';
      if (parsed.assumed) row.at_zone = 'assumed-utc';
    }
    if (m.from === 'che' && WORKER_CLOCK.test(String(m.at)) && parsed) later = Math.min(later, parsed.ms);
    out[i] = row;
  }
  return out;
}
