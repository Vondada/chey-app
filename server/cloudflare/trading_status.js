// "Why are no new trades appearing?" answered from stored records only, in five short facts (owner, 2026-10-21):
// the best strategy, its trade count, its P&L, the confidence, and the exact reason new trades are blocked.
// The reason comes from the scheduler's last run, the feed it saw, the skipped setups and the journal's own
// timestamps. Nothing is guessed. Paper only: no order and no model call.
//
// A market entry taken by more than one variant of a strategy is ONE trade: it is counted once, as the analysis
// in trading_ledgers.js counts it. Delayed-paper trades are reported apart from verified live-forward trades.
import { LIVE_FEED, LIVE_RUNS, LIVE_STATE, RESOLUTION, readLivePortfolios } from './trading_live.js';
import { INTRADAY_CANDIDATES, MIN_TRADES, readTrades, summarize } from './trading_evidence.js';

export const TRADING_STATUS_SOURCE = 'che_trading_status';

const WAKE = /^\s*(?:(?:hey\s+)?(?:che|chay|chey|shay)[,:]?\s+)?/i;
// A negation ("no", "zero", "aren't", "isn't", "not", "don't see") followed by at most four other words and a trade
// word, after "why". The words between may be a market ("new MNQ paper trades"), a subject ("CHE is not taking any
// trades") or a verb ("showing up"). Trade words are the nouns for the journal, not "trading" used as an adjective.
const NEGATION = "(?:no|zero|none|not|aren'?t|isn'?t|haven'?t|hasn'?t|didn'?t|don'?t|doesn'?t|won'?t|never|nothing|without)";
const TRADE_WORD = '(?:trades?|entries|entry|positions?|orders?|setups?|signals?|fills?)';
const WHY_NO = new RegExp(`\\bwhy\\b[\\s\\S]{0,60}?\\b${NEGATION}\\b(?:\\s+[a-z0-9&/']+){0,6}?\\s+${TRADE_WORD}\\b`, 'i');

/**
 * The owner's "why are there no new trades" question in any natural wording, with or without a market name, "paper",
 * or a wake word ("CHE", "Chay", "Chey", "Shay", "Hey CHE"), or null. Questions about other things do not match.
 */
export function newTradesIntent(message) {
  const text = String(message || '').replace(/[’]/g, "'").replace(WAKE, '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 300) return null;
  return WHY_NO.test(text) ? { kind: 'why_no_trades' } : null;
}

const clock = (iso) => {
  const at = new Date(String(iso || ''));
  return Number.isFinite(at.getTime()) ? `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'an unknown time';
};
const money = (value) => `${Number(value) < 0 ? '-' : ''}$${Math.abs(Number(value) || 0).toFixed(2)}`;
const entryKey = (t) => `${t.strategy}|${t.side}|${t.entry?.time}`;

// The reason new trades are blocked, from the last recorded run and the portfolios' own skip lists.
function blockReason(state, runs, feed, portfolios, now) {
  if (!state?.enabled) return 'Paper trading is off: the scheduler is not opening anything. Turn paper trading on to resume.';
  const last = Array.isArray(runs) && runs.length ? runs[runs.length - 1] : null;
  if (!last) return 'The scheduler has not recorded a run yet, so there is no feed reading to judge.';
  const when = clock(last.at);
  if (last.error) return `The last scheduler run at ${when} failed: ${last.error}`;
  if (last.entries_allowed === false) {
    const feedNote = feed?.status ? ` The feed then was ${feed.status}${feed.checked_at ? ` (checked ${clock(feed.checked_at)})` : ''}.` : '';
    return `The last scheduler run at ${when} opened no entries. ${last.entry_blocker || 'The entry gate was closed.'}${feedNote}`;
  }
  const skips = portfolios.flatMap((pf) => (Array.isArray(pf.skips) ? pf.skips : []));
  const lastSkip = skips.sort((a, b) => String(b.time).localeCompare(String(a.time)))[0];
  const skipNote = lastSkip ? ` Latest skipped setup: ${clock(lastSkip.time)}, ${lastSkip.reason}.` : '';
  return `The last scheduler run at ${when} allowed entries (${last.entry_quality || 'feed'} bars), so no new trade is blocked. No valid setup has passed the strategy rules since then.${skipNote}`;
}

/** The five facts, read from the stored journal and scheduler records. */
export async function tradingStatus(storage, { now = Date.now() } = {}) {
  const [state, runs, feed, portfolios] = await Promise.all([
    storage.get(LIVE_STATE), storage.get(LIVE_RUNS), storage.get(LIVE_FEED), readLivePortfolios(storage),
  ]);
  let records;
  try {
    records = await readTrades(storage, (t) => t.environment === 'paper' && t.data?.resolution === RESOLUTION);
  } catch (_) {
    return { ok: false, text: 'I could not read the forward paper journal just now, sir, so I give no trade count, P&L or reason.' };
  }
  // One market entry per strategy, however many variants took it.
  const unique = [...new Map(records.map((t) => [entryKey(t), t])).values()];
  const byStrategy = new Map();
  for (const t of unique) byStrategy.set(t.strategy, [...(byStrategy.get(t.strategy) || []), t]);
  const ranked = [...byStrategy.entries()]
    .map(([id, list]) => ({ id, name: INTRADAY_CANDIDATES[id]?.name || id, stats: summarize(list) }))
    .sort((a, b) => b.stats.expectancy_r - a.stats.expectancy_r);
  const best = ranked.find((r) => r.stats.trades >= MIN_TRADES) || ranked[0] || null;
  const total = summarize(unique);
  const verified = unique.filter((t) => t.data?.entry_feed?.status === 'LIVE'
    && t.data.entry_feed.authenticated === true && t.data.entry_feed.subscription_verified === true).length;
  const delayed = unique.filter((t) => t.data?.entry_feed?.status === 'DELAYED').length;
  const variantRecords = records.length - unique.length;

  const lines = ['Why no new trades, sir. From the stored paper records only (paper, no money):'];
  lines.push(`1. Best strategy: ${best ? `${best.name}${best.stats.trades >= MIN_TRADES ? '' : ' (so far)'}` : 'none yet; no paper trade is recorded.'}`);
  lines.push(`2. Trades: ${total.trades} distinct market entries${variantRecords ? ` (${variantRecords} variant record${variantRecords === 1 ? '' : 's'} of the same entries counted once)` : ''}. Last entry: ${unique.length ? clock(unique.reduce((latest, t) => (String(t.entry?.time) > latest ? String(t.entry?.time) : latest), '')) : 'none'}.`);
  lines.push(`3. P&L: ${money(total.net_pnl)} net across those entries.`);
  const confidence = !best ? 'none: no trades'
    : best.stats.trades >= MIN_TRADES ? `enough trades (${best.stats.trades} of the ${MIN_TRADES} needed)`
      : `low: ${best.stats.trades} trades, under the ${MIN_TRADES}-trade minimum, so not a conclusion`;
  lines.push(`4. Confidence: ${confidence}. Delayed-paper entries: ${delayed}. Verified live-forward entries: ${verified}. The two are never added together.`);
  lines.push(`5. Blocked because: ${blockReason(state, runs, feed, portfolios, now)}`);
  return { ok: true, text: lines.join('\n'), trades: total.trades };
}
