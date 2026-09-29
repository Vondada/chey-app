// "Today" for the Office means the owner's day in Central time. A UTC date
// would roll the board and Stripe totals over at 7pm (6pm in winter) Chicago.
const FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function chicagoDayKey(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(d.getTime())) return '';
  const parts = FORMAT.formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
