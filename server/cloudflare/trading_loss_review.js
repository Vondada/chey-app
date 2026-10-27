// Why CHE's forward-paper trades lost, read from the stored journal only: how many losses were profitable before costs,
// which strategies lost most, where losing streaks and too-quick re-entries came from, which sessions lost, and whether a
// strategy's recent stretch is worse than the one before. Pure over trade records (trading_evidence.js summaries), so it
// never calls a model and never invents a figure. Market direction and choppiness are not in the records, so they are
// reported as not measured rather than guessed. Backtests and paper trades are never combined: the caller reads one journal.
import { INTRADAY_CANDIDATES, MIN_TRADES, readTrades, sessionOf, summarize } from './trading_evidence.js';
import { RESOLUTION } from './trading_live.js';

export const STREAK = 3;            // three or more losses in a row from one setup is a pattern to flag
export const QUICK_MINUTES = 30;    // a re-entry this soon after a stop-out is "too quick"
export const RECENT = 10;           // a recent stretch: the last RECENT entries against the RECENT before them

const costsOf = (t) => (t.costs?.spread || 0) + (t.costs?.slippage || 0) + (t.costs?.commissions || 0) + (t.costs?.fees || 0);
const entryKey = (t) => `${t.strategy}|${t.side}|${t.entry?.time}`;
const minutesBetween = (from, to) => (Date.parse(to) - Date.parse(from)) / 60000;

/** One market entry per strategy, however many variants took it (the same count trading_status.js uses). */
export function distinctEntries(records) {
  return [...new Map(records.map((t) => [entryKey(t), t])).values()]
    .sort((a, b) => String(a.entry?.time).localeCompare(String(b.entry?.time)));
}

function trendOf(list) {
  if (list.length < 2 * RECENT) return { trend: 'not enough entries to compare a recent stretch', recent: null, prior: null };
  const recent = summarize(list.slice(-RECENT));
  const prior = summarize(list.slice(-2 * RECENT, -RECENT));
  const trend = recent.expectancy_r > prior.expectancy_r ? 'improving' : recent.expectancy_r < prior.expectancy_r ? 'deteriorating' : 'flat';
  return { trend, recent: { expectancy_r: recent.expectancy_r, net_pnl: recent.net_pnl, trades: recent.trades }, prior: { expectancy_r: prior.expectancy_r, net_pnl: prior.net_pnl, trades: prior.trades } };
}

/**
 * The review of one journal (futures or crypto, paper only). `name` maps a strategy id to its name. Each finding carries
 * the record ids that show it, so the spoken answer can cite real trades.
 */
export function reviewLosses(records, { name = (id) => id } = {}) {
  const trades = distinctEntries(records);
  const losses = trades.filter((t) => t.net_pnl < 0);
  const flippedByCosts = losses.filter((t) => t.net_pnl + costsOf(t) > 0);
  const stopped = losses.filter((t) => t.exit?.reason === 'stop');
  const feedUnverified = trades.filter((t) => t.data?.entry_feed && !['LIVE', 'DELAYED'].includes(t.data.entry_feed.status));

  const byStrategy = new Map();
  for (const t of trades) byStrategy.set(t.strategy, [...(byStrategy.get(t.strategy) || []), t]);
  const streaks = [];
  const quick = [];
  const strategies = [];
  for (const [id, list] of byStrategy) {
    let run = [];
    list.forEach((t, i) => {
      if (t.net_pnl < 0) run.push(t);
      else { if (run.length >= STREAK) streaks.push({ strategy: id, name: name(id), length: run.length, ids: run.map((x) => x.id) }); run = []; }
      const before = list[i - 1];
      if (before && before.net_pnl < 0 && before.exit?.reason === 'stop' && before.exit?.time) {
        const gap = minutesBetween(before.exit.time, t.entry.time);
        if (gap >= 0 && gap <= QUICK_MINUTES) quick.push({ strategy: id, name: name(id), id: t.id, after: before.id, minutes: Math.round(gap) });
      }
    });
    if (run.length >= STREAK) streaks.push({ strategy: id, name: name(id), length: run.length, ids: run.map((x) => x.id) });
    const s = summarize(list);
    strategies.push({ id, name: name(id), ...s, ...trendOf(list), losing_ids: list.filter((t) => t.net_pnl < 0).slice(0, 3).map((t) => t.id) });
  }
  streaks.sort((a, b) => b.length - a.length);

  const bySession = {};
  for (const t of losses) {
    const session = sessionOf(t.entry?.time, t.data?.resolution || 'daily');
    bySession[session] = (bySession[session] || 0) + 1;
  }
  return {
    entries: trades.length,
    wins: trades.filter((t) => t.net_pnl > 0).length,
    losses: losses.length,
    net_pnl: summarize(trades).net_pnl,
    costs_paid: summarize(trades).costs_paid,
    stopped_out: stopped.length,
    flipped_by_costs: { count: flippedByCosts.length, ids: flippedByCosts.slice(0, 3).map((t) => t.id) },
    streaks,
    quick_reentries: quick,
    losses_by_session: bySession,
    feed_unverified: feedUnverified.length,
    strategies: strategies.sort((a, b) => a.net_pnl - b.net_pnl),
    min_trades: MIN_TRADES,
    not_measured: ['market direction', 'choppy or sideways conditions', 'stop distance against volatility'],
  };
}

/** The single most important pattern in one review, as a plain finding, or null when nothing repeats. */
export function mainPattern(review) {
  const options = [];
  if (review.flipped_by_costs.count) options.push({ weight: review.flipped_by_costs.count, kind: 'costs', count: review.flipped_by_costs.count, of: review.losses });
  if (review.streaks.length) options.push({ weight: review.streaks.reduce((s, x) => s + x.length, 0), kind: 'streak', streaks: review.streaks });
  if (review.quick_reentries.length) options.push({ weight: review.quick_reentries.length, kind: 'quick', count: review.quick_reentries.length });
  options.sort((a, b) => b.weight - a.weight);
  return options[0] || null;
}

// ─── Questions the owner asks, and the answers ───
const MAX_LOSS_TURN = 300;
// Narrow on purpose: a single trade's explanation, a market-specific performance read and the trading-live answers keep
// their own routes (trading_live_chat.js), so these match the owner's aggregate questions only.
const WHY_LOSING = /\bwhy\b[\s\S]{0,30}\b(?:losing|lose|lost)\s+(?:so\s+many|more|most|money)\b|\bwhy\b[\s\S]{0,30}\blosing\b[\s\S]{0,20}\btrades\b/i;
const MISTAKE = /\b(?:biggest|main|worst|big)\s+(?:trading\s+)?mistake\b/i;
const REPEAT = /\b(?:keep|keeps|kept|repeat\w*|again\s+and\s+again)\b[\s\S]{0,30}\b(?:losing|losses?|mistakes?)\b|\bare you repeating\b/i;
const WORST = /\b(?:which|what)\s+(?:strategy|setup)\b[\s\S]{0,40}\b(?:hurt\w*|costing)\b/i;
const BEST = /\b(?:which|what)\s+(?:strategy|setup)\b[\s\S]{0,40}\b(?:do\s+better|will\s+do\s+better|likely\s+to\s+do\s+better|tomorrow)\b/i;

/** The loss question in [message], or null. Pure. Questions about other things keep their own routes. */
export function lossIntent(message) {
  const text = String(message || '').trim().replace(/[’']/g, "'");
  if (!text || text.length > MAX_LOSS_TURN) return null;
  if (MISTAKE.test(text)) return { kind: 'mistake' };
  if (REPEAT.test(text)) return { kind: 'repeat' };
  if (WORST.test(text)) return { kind: 'worst' };
  if (BEST.test(text)) return { kind: 'best' };
  if (WHY_LOSING.test(text)) return { kind: 'why_losing' };
  return null;
}

const money = (value) => `${Number(value) < 0 ? '-' : ''}$${Math.abs(Number(value) || 0).toFixed(2)}`;
const plural = (n, word) => `${n} ${n === 1 ? word : word.endsWith('entry') ? word.replace(/entry$/, 'entries') : `${word}s`}`;

/** Reads the paper journal the owner's question is about, one market at a time (futures and crypto are never added together). */
export async function gatherLossReview(storage, { readTrades, isPaper, nameOf }) {
  const [futures, crypto] = await Promise.all([
    readTrades(storage, isPaper, { market: 'futures' }),
    readTrades(storage, isPaper, { market: 'crypto' }),
  ]);
  return {
    futures: { market: 'futures', ...reviewLosses(futures, { name: nameOf }) },
    crypto: { market: 'crypto', ...reviewLosses(crypto, { name: nameOf }) },
  };
}

function patternSentence(p) {
  if (!p) return 'No single pattern repeats in these records.';
  if (p.kind === 'costs') return `The biggest measurable cause is costs: ${p.count} of the ${p.of} losses were profitable before fees and slippage, so the costs turned them into losses.`;
  if (p.kind === 'streak') {
    const longest = p.streaks[0];
    return `The clearest pattern is streaks: ${plural(p.streaks.length, 'run')} of three or more losses in a row from one setup, the longest ${longest.length} losses from ${longest.name}.`;
  }
  return `Re-entries: ${plural(p.count, 'trade')} came back in within 30 minutes of a stop-out from the same setup.`;
}

/** The short spoken answer for one loss question, from one review. Pure: no storage, no clock, no model. */
export function lossReply(kind, review) {
  const r = review;
  if (!r.entries) return 'No paper trades are recorded in this journal yet, sir, so there are no losses to explain.';
  const head = `From the ${r.market || 'paper'} paper journal, ${plural(r.entries, 'distinct entry')}, ${r.wins} won and ${r.losses} lost, net ${money(r.net_pnl)} after costs.`;
  if (kind === 'why_losing') {
    const p = mainPattern(r);
    const worst = r.strategies[0];
    const worstLine = worst && worst.net_pnl < 0 ? ` The setup that cost most is ${worst.name}, at ${money(worst.net_pnl)} across ${plural(worst.trades, 'entry')}.` : '';
    return `${head} ${patternSentence(p)}${worstLine} Not measured from these records: market direction and choppy conditions.`;
  }
  if (kind === 'mistake') return `${head} ${patternSentence(mainPattern(r))}`;
  if (kind === 'repeat') {
    if (!r.streaks.length && !r.quick_reentries.length) return `${head} I did not find three losses in a row from one setup, or a too-quick re-entry after a stop, so I do not flag a repeated mistake.`;
    const streak = r.streaks.length ? `I see ${plural(r.streaks.length, 'losing streak')} of three or more from one setup; the longest is ${r.streaks[0].length} losses from ${r.streaks[0].name}.` : '';
    const quick = r.quick_reentries.length ? ` ${plural(r.quick_reentries.length, 'too-quick re-entry')} after a stop-out.` : '';
    return `${head} ${streak}${quick} That is a pattern to review and pause for study, not proof the strategy is broken.`;
  }
  if (kind === 'worst') {
    const w = r.strategies[0];
    if (!w || w.net_pnl >= 0) return `${head} No strategy in this journal is losing money overall.`;
    return `${head} The strategy costing most is ${w.name}: ${plural(w.trades, 'entry')}, ${w.losses} losses, net ${money(w.net_pnl)}. ${w.trades < MIN_TRADES ? `That is below the ${MIN_TRADES} entries needed for a firm conclusion, so it is a warning, not a verdict.` : 'That is enough entries to take seriously.'}`;
  }
  if (kind === 'best') {
    const ranked = r.strategies.filter((s) => s.trades >= MIN_TRADES).sort((a, b) => b.expectancy_r - a.expectancy_r);
    if (!ranked.length) return `${head} No strategy has ${MIN_TRADES} entries yet, so I cannot say which one will do better with evidence.`;
    const b = ranked[0];
    return `${head} The strongest record so far is ${b.name}: ${plural(b.trades, 'entry')}, average ${b.expectancy_r} R per trade, ${b.trend}. This is recorded paper evidence, not a promise for tomorrow.`;
  }
  return head;
}

/**
 * The spoken answer to one loss question, read from the stored paper journals, or null when [message] is not one. The
 * futures journal is the answer; the crypto journal follows as its own line, never added in.
 */
export async function lossAnswer(storage, message) {
  const ask = lossIntent(message);
  if (!ask) return null;
  const isPaper = (t) => t.environment === 'paper' && t.data?.resolution === RESOLUTION;
  const nameOf = (id) => INTRADAY_CANDIDATES[id]?.name || id;
  const { futures, crypto } = await gatherLossReview(storage, { readTrades, isPaper, nameOf });
  const crypto_line = crypto.entries ? ` Crypto paper journal, kept separate: ${lossReply(ask.kind, crypto)}` : '';
  return `${lossReply(ask.kind, futures)}${crypto_line}`;
}
