// CHE's own token tracker: precise totals per day, and rolled up to week,
// month and year. Fed from the router on every engine call.
const DAY = 'tok_day:'; // tok_day:YYYY-MM-DD -> total tokens that day

function dayKey(ts) { return new Date(ts).toISOString().slice(0, 10); }

export async function addTokens(storage, tokens, now = Date.now()) {
  if (!storage?.get || !Number.isFinite(tokens) || tokens <= 0) return;
  const key = DAY + dayKey(now);
  const cur = Number(await storage.get(key)) || 0;
  await storage.put(key, cur + Math.ceil(tokens));
}

async function sumSince(storage, days, now = Date.now()) {
  let total = 0;
  const today = new Date(now);
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    total += Number(await storage.get(DAY + d.toISOString().slice(0, 10))) || 0;
  }
  return total;
}

export async function usageReport(storage, now = Date.now()) {
  return {
    today: await sumSince(storage, 1, now),
    week: await sumSince(storage, 7, now),
    month: await sumSince(storage, 30, now),
    year: await sumSince(storage, 365, now),
    at: new Date(now).toISOString(),
  };
}

const fmt = (n) => Number(n || 0).toLocaleString('en-US');

export function speakUsage(r, scope) {
  if (scope === 'today') return `You've used about ${fmt(r.today)} tokens today, sir.`;
  if (scope === 'week') return `About ${fmt(r.week)} tokens this week, sir.`;
  if (scope === 'month') return `About ${fmt(r.month)} tokens this month, sir.`;
  if (scope === 'year') return `About ${fmt(r.year)} tokens this year, sir.`;
  return `Tokens used, sir: ${fmt(r.today)} today, ${fmt(r.week)} this week, ${fmt(r.month)} this month, ${fmt(r.year)} this year.`;
}

export function usageIntent(message) {
  const t = String(message || '')
    .toLowerCase()
    .replace(/^(?:chay|chey|shay|che)[, ]+/, '')
    .replace(/[.!?]+$/g, '')
    .trim();

  // Token totals are diagnostics, never a keyword shortcut. Only intercept
  // a turn when the owner explicitly asks for CHE's token usage.
  const explicit = [
    /^how many tokens(?:\s+(?:have|did)\s+(?:i|you|we)\s+use(?:d)?)?(?:\s+(?:today|this week|this month|this year))?$/,
    /^(?:what(?:'s| is)|show|tell me|give me|check)\s+(?:(?:my|your|our|che(?:'s)?)\s+)?token(?:s| usage)?(?:\s+(?:today|this week|this month|this year))?$/,
    /^token usage(?:\s+(?:today|this week|this month|this year))?$/,
    /^tokens(?:\s+(?:today|this week|this month|this year))$/,
  ].some((re) => re.test(t));
  if (!explicit) return null;

  if (/\btoday\b/.test(t)) return { scope: 'today' };
  if (/\bthis week\b/.test(t)) return { scope: 'week' };
  if (/\bthis month\b/.test(t)) return { scope: 'month' };
  if (/\bthis year\b/.test(t)) return { scope: 'year' };
  return { scope: 'all' };
}

export function replyHijacksOwnerRequest(message, reply) {
  const text = String(reply || '').trim();
  if (!text) return true;

  const usageTelemetry =
    /^tokens used, sir:/i.test(text) ||
    /^you(?:'ve| have) used about [\d,]+ tokens/i.test(text) ||
    /^about [\d,]+ tokens this (?:week|month|year),? sir/i.test(text);
  if (usageTelemetry && !usageIntent(message)) return true;

  return /\[AWAITING INITIAL TASK\]/i.test(text) ||
    /NEXT DIRECTIVE:\s*\[[^\]]+\]/i.test(text) ||
    /^\s*\[[^\]\n]{0,50}progress[^\]\n]*\]/im.test(text);
}
