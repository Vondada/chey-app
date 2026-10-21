// CHE's trading clock: the time on a 12-hour clock (12 AM to 11 PM, never 24-hour), which market sessions
// are open right now, and when the next open or close is. Time zones come from Intl, so daylight-saving
// changes are handled. Session hours are the usual cash-market hours; CME micro Nasdaq (MNQ) futures run
// Sunday 6:00 PM to Friday 5:00 PM New York time, with a daily break from 5:00 to 6:00 PM.

export const SESSIONS = Object.freeze([
  { id: 'asia', name: 'Asia (Tokyo)', label: 'Tokyo time', zone: 'Asia/Tokyo', open: [9, 0], close: [15, 0] },
  { id: 'london', name: 'London', label: 'London time', zone: 'Europe/London', open: [8, 0], close: [16, 30] },
  { id: 'new_york', name: 'New York', label: 'New York time', zone: 'America/New_York', open: [9, 30], close: [16, 0] },
]);

/** Hour and minute on a 12-hour clock: 12:05 AM, 9:30 AM, 12:00 PM, 3:15 PM. */
export function twelveHour(hour, minute) {
  const h = ((hour % 12) + 12) % 12 || 12;
  return `${h}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

function zoneParts(date, zone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  return { weekday: get('weekday'), hour: Number(get('hour')) % 24, minute: Number(get('minute')) };
}

const mins = (hm) => hm[0] * 60 + hm[1];

/** Whether a cash session is open at this local weekday and time. Weekends are closed. */
export function sessionOpen(session, weekday, hour, minute) {
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const now = hour * 60 + minute;
  return now >= mins(session.open) && now < mins(session.close);
}

/** CME micro Nasdaq futures: open Sunday 6:00 PM to Friday 5:00 PM New York time, with a 5:00 to 6:00 PM break. */
export function futuresOpen(weekday, hour, minute) {
  const now = hour * 60 + minute;
  if (weekday === 'Sat') return false;
  if (weekday === 'Sun') return now >= 18 * 60;
  if (weekday === 'Fri') return now < 17 * 60;
  return !(now >= 17 * 60 && now < 18 * 60);
}

/** The whole clock at one moment, every field already in 12-hour time. */
export function tradingClock(now = Date.now()) {
  const date = new Date(now);
  const ny = zoneParts(date, 'America/New_York');
  const sessions = SESSIONS.map((s) => {
    const local = zoneParts(date, s.zone);
    return {
      id: s.id, name: s.name,
      local: `${twelveHour(local.hour, local.minute)} ${s.label}`,
      open: sessionOpen(s, local.weekday, local.hour, local.minute),
      opens_at: twelveHour(s.open[0], s.open[1]),
      closes_at: twelveHour(s.close[0], s.close[1]),
    };
  });
  const futures = futuresOpen(ny.weekday, ny.hour, ny.minute);
  return {
    now_iso: date.toISOString(),
    clock: `${twelveHour(ny.hour, ny.minute)} New York time`,
    sessions,
    open_now: sessions.filter((s) => s.open).map((s) => s.name),
    futures: { name: 'CME Micro Nasdaq (MNQ)', open: futures, note: futures ? 'Trading is open.' : 'Trading is closed for the daily break or the weekend.' },
  };
}

/** Said aloud or shown: "It is 9:30 AM New York time. London and New York are open. Tokyo is closed." */
export function speakTradingClock(clock) {
  const open = clock.open_now;
  const names = open.length ? `${open.join(' and ')} ${open.length > 1 ? 'are' : 'is'} open` : 'No cash session is open';
  const closed = clock.sessions.filter((s) => !s.open).map((s) => s.name);
  const rest = closed.length ? ` ${closed.join(' and ')} ${closed.length > 1 ? 'are' : 'is'} closed.` : '';
  return `It is ${clock.clock}. ${names}.${rest} MNQ futures are ${clock.futures.open ? 'open' : 'closed'}.`;
}
