// One view of every trading connection for the Trading Room and for voice (issue #344).
// It only reads what each existing system reports (the paper engine, the trading desk, the
// Tradovate sign-in, the Alpaca paper check); it never changes a mode or a connection. Each
// card says its real state, so nothing reads "connected" until the provider proved it.

import { liveOrderBlock } from './trading_environments.js';
import { cryptoView } from './crypto_markets.js';
import { tradingClock } from './trading_clock.js';

export const MODE_LABEL = { paper: 'PAPER', sim: 'BROKER SIM', live: 'LIVE' };

// What Tradovate itself requires before CHE can use its API (owner research, issue #344, Oct 18
// 2026), in the owner's order and in words that read aloud cleanly. The secret names are shown
// apart from the spoken steps.
export const TRADOVATE_PREREQUISITES = [
  'A funded Tradovate live account with more than 1,000 dollars in it',
  'The CME market-data agreement, signed inside Tradovate',
  "Tradovate's paid API Access add-on, which does not include real-time CME data",
  'An OAuth app that Tradovate registers for CHE; its client ID and client secret go into CHE\'s Worker secrets, never into chat',
];
export const TRADOVATE_WORKER_SECRETS = ['CHE_TRADOVATE_OAUTH_CLIENT_ID', 'CHE_TRADOVATE_OAUTH_CLIENT_SECRET'];
// The owner does not qualify yet (issue #344): nothing here asks him to deposit or to buy anything.
export const TRADOVATE_BLOCKED_NOTE = 'Until Tradovate approves API access, Tradovate demo and live orders stay blocked in CHE. CHE never deposits money, buys the add-on or signs an agreement for you; each paid step is your choice. Tradovate\'s free two-week simulated trial is manual trading on Tradovate\'s own site, not an API connection for CHE.';

const TRADOVATE_OPEN_ACCOUNT = 'https://www.tradovate.com/open-your-trading-account/';

function paperCard(paper) {
  const feed = paper?.feed || {};
  const lastBar = feed.last_bar_time || feed.last_bar || null;
  const lagMinutes = feed.latency_s != null && Number.isFinite(Number(feed.latency_s)) ? Math.round(Number(feed.latency_s) / 60) : null;
  return {
    id: 'che_paper',
    name: 'CHE Paper',
    state: paper?.state?.enabled ? 'on' : 'off',
    mode: 'PAPER',
    money_at_risk: false,
    contract: paper?.contract || null,
    data: {
      source: feed.provider ? `${feed.provider} ${feed.provider_symbol || ''}`.trim() : null,
      // LIVE, DELAYED, REPLAY or UNAVAILABLE, exactly as the feed labelled itself.
      label: feed.status || null,
      last_bar: lastBar,
      lag_minutes: lagMinutes,
    },
    detail: `${Number(paper?.portfolios) || 0} isolated paper portfolios; no broker is reachable from the paper engine.`,
  };
}

function tradovateCard({ configured, conn, desk }) {
  const state = !configured ? 'not_configured' : conn?.connected ? 'signed_in' : conn?.expired ? 'expired' : 'configured';
  return {
    id: 'tradovate',
    name: 'Tradovate (NinjaTrader)',
    state,
    mode: MODE_LABEL[desk.mode] || 'PAPER',
    money_at_risk: desk.mode === 'live',
    accounts: { sim: desk.account.sim || null, live: desk.account.live || null },
    risk_limits: desk.risk_limits,
    blocked_by: configured ? [] : TRADOVATE_PREREQUISITES,
    ...(configured ? {} : { blocked_note: TRADOVATE_BLOCKED_NOTE, worker_secrets: TRADOVATE_WORKER_SECRETS }),
    open_account: TRADOVATE_OPEN_ACCOUNT,
    detail: state === 'signed_in' ? 'Signed in on Tradovate\'s own page; CHE never sees the password.'
      : state === 'expired' ? 'The Tradovate sign-in expired; say "connect NinjaTrader" to sign in again.'
        : state === 'configured' ? 'The OAuth app is set up; say "connect NinjaTrader" to sign in on Tradovate\'s page.'
          : 'Not set up: Tradovate has to approve API access first.',
  };
}

// Alpaca's options levels, from its options documentation: each level includes the ones below it.
const OPTION_LEVELS = { 0: 'options off', 1: 'covered calls and cash-secured puts', 2: 'level 1 plus buying calls and puts', 3: 'level 2 plus call and put spreads' };

// Options readiness, read only (issue #344): the levels exactly as GET /v2/account reports them.
// CHE places no option orders; that is a later phase with its own approval.
export function alpacaOptions(account) {
  if (!account) return null;
  const level = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const approved = level(account.options_approved_level);
  const trading = level(account.options_trading_level);
  const words = (n) => (n == null ? 'not reported' : `level ${n}${OPTION_LEVELS[n] ? ` (${OPTION_LEVELS[n]})` : ''}`);
  return {
    approved_level: approved,
    trading_level: trading,
    orders: 'off',
    detail: approved == null && trading == null
      ? 'Options, read only: Alpaca did not report an options level for this paper account. CHE places no option orders.'
      : `Options, read only: Alpaca approved ${words(approved)}; trading ${words(trading)}. CHE places no option orders yet.`,
  };
}

function alpacaCard(alpaca) {
  const a = alpaca?.account;
  return {
    id: 'alpaca',
    name: 'Alpaca (stock paper)',
    state: alpaca?.state || 'not_configured',
    mode: 'PAPER',
    money_at_risk: false,
    key_last4: alpaca?.key_last4 || null,
    account: a || null,
    options: alpaca?.state === 'verified' ? alpacaOptions(a) : null,
    detail: alpaca?.state === 'verified' ? `Paper account ending ${a.account_last4 || '—'}: ${a.status}, buying power $${a.buying_power ?? 'unknown'}.`
      : alpaca?.state === 'refused' || alpaca?.state === 'rejected' ? alpaca.error
        : alpaca?.state === 'unavailable' ? `Alpaca's paper service could not be checked: ${alpaca.error}`
          : 'Not set up: add your Alpaca paper key ID and secret in the Trading Room. CHE accepts paper keys only.',
  };
}

const FUNDYOUREDGE = {
  id: 'fundyouredge',
  name: 'FundYourEdge (Rithmic)',
  state: 'unsupported',
  mode: null,
  money_at_risk: false,
  // Market data and orders are separate (owner recording, 2026-10-25: Rithmic status confusion). The iPhone reads
  // Rithmic prices itself; orders through Rithmic stay unsupported.
  detail: 'Orders: not supported. FundYourEdge trades on Rithmic, whose order API needs a licensed developer kit, so CHE places no orders there. Market data: your iPhone reads Rithmic prices itself (Market data feeds in the Trading Room); the login stays on the phone and never reaches CHE\'s server. TradeSea inside CHE is a viewer only.',
};

// Public BTC and ETH data never needs an exchange account (owner, 2026-10-25).
const COINBASE = {
  id: 'coinbase',
  name: 'Coinbase (public market data)',
  state: 'public',
  mode: null,
  money_at_risk: false,
  detail: 'Public market data — no trading account. BTC and ETH prices and candles come from Coinbase\'s public feed; CHE has no Coinbase login, key or order path.',
};

/** The cards, the desk mode and what each permission currently allows. */
export function tradingConnections({ paper = null, desk, tradovate = {}, alpaca = null }) {
  const cards = [paperCard(paper), tradovateCard({ ...tradovate, desk }), alpacaCard(alpaca), FUNDYOUREDGE, COINBASE];
  const signedIn = cards[1].state === 'signed_in';
  return {
    mode: MODE_LABEL[desk.mode] || 'PAPER',
    cards,
    permissions: {
      research: true,
      paper: true,
      sim_orders: desk.mode === 'sim' && signedIn ? 'on: CHE places her entries on the simulated account' : 'off',
      // The live kill switch first: off in code means off here, whatever the desk says.
      live_orders: !liveOrderBlock() && desk.mode === 'live' && signedIn && desk.risk_limits && desk.account.live ? 'each order needs your approval of that exact order' : 'off',
    },
  };
}

const SAY_STATE = { on: 'on', off: 'off', not_configured: 'not set up', configured: 'set up, not signed in', signed_in: 'signed in', expired: 'sign-in expired', verified: 'verified', rejected: 'key rejected', refused: 'live key refused', unavailable: 'could not be checked', unsupported: 'orders not supported', public: 'public data, no account' };

/** A numbered spoken list, one line per connection. */
export function speakConnections(view) {
  const lines = view.cards.map((c, i) => {
    const extra = c.id === 'che_paper' && c.data.label ? `, ${c.data.label.toLowerCase()} ${c.data.source || ''} data`.trimEnd()
      : c.id === 'alpaca' && c.options ? `, options ${c.options.approved_level == null ? 'level not reported' : `level ${c.options.approved_level}`}, read only` : '';
    return `${i + 1}, ${c.name}: ${SAY_STATE[c.state] || c.state}${extra}.`;
  });
  const live = view.permissions.live_orders === 'off' ? 'Live orders are off.' : 'Live orders need your approval of each exact order.';
  return `Your trading connections, sir: ${lines.join(' ')} Trading mode: ${view.mode}. ${live}`;
}

/** Tradovate's own steps as a numbered spoken list, with what stays blocked meanwhile. */
export function speakTradovateSteps({ configured = false, redirect = '' } = {}) {
  if (configured) return 'Tradovate\'s OAuth app is already set up for CHE, sir. Say "connect NinjaTrader" to sign in on Tradovate\'s own page.';
  const steps = TRADOVATE_PREREQUISITES.map((step, i) => `${i + 1}, ${step}.`).join(' ');
  const where = redirect ? ` Tradovate registers the app with this redirect address: ${redirect}.` : '';
  return `Tradovate requires these steps before CHE can use its API, sir: ${steps}${where} ${TRADOVATE_BLOCKED_NOTE} To open an account: ${TRADOVATE_OPEN_ACCOUNT}`;
}

// ─── "Is the crypto feed live?" / "is the MNQ data live?" (Trading Room v3, owner 2026-10-25) ──────────────────
// Answered only from the stored feed records, never by a model. LIVE is said only for data that is actually fresh:
// a Rithmic minute the owner's iPhone recorded that closed within FRESH_MS. Signing in to Rithmic alone, or a delayed
// Yahoo bar, is never called live. The crypto record on the Worker is Coinbase's public 5-minute candles (no account),
// which are current or not, but are not a live trade stream; the phone's chart streams trades itself.
const FRESH_MS = 3 * 60_000;
const nyTime = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
const ago = (iso, now) => { const raw = (now - Date.parse(iso)) / 60_000; const m = Math.round(raw); return raw < 1 ? 'under a minute ago' : m < 120 ? `${m} minute${m === 1 ? '' : 's'} ago` : `${Math.round(m / 60)} hours ago`; };

/** "Is the crypto feed live", "is the mnq data live", "is rithmic live": which feed, or null. */
export function feedLiveIntent(message) {
  const t = String(message || '').toLowerCase().replace(/[’']/g, "'");
  if (!/\b(?:live|real[\s-]?time|fresh|current|delayed|streaming|working)\b/.test(t)) return null;
  if (!/\b(?:is|are|isn't|whether)\b[\s\S]{0,40}\b(?:data|feed|prices?|quotes?|chart|stream|candles?)\b|\b(?:is|are)\s+(?:the\s+)?(?:rithmic|coinbase)\b/.test(t)) return null;
  if (/\b(?:crypto|bitcoin|btc|eth|ethereum|coinbase)\b/.test(t)) return { kind: 'connections', feed: 'crypto' };
  if (/\b(?:mnq|nq|mes|es|futures?|rithmic|micro)\b/.test(t)) return { kind: 'connections', feed: 'futures' };
  return null;
}

async function newestRithmicMinute(storage) {
  if (typeof storage.list !== 'function') return null;
  const index = await storage.list({ prefix: 'rithmic_1m_index:' }).catch(() => new Map());
  let best = null;
  for (const [key, hours] of index) {
    const symbol = key.slice('rithmic_1m_index:'.length);
    const hour = Array.isArray(hours) ? [...hours].sort().at(-1) : null;
    if (!hour || (best && hour < best.hour)) continue;
    const rec = await storage.get(`rithmic_1m:${symbol}:${hour}`).catch(() => null);
    const last = Object.values(rec?.candles || {}).sort((a, b) => String(a.t).localeCompare(String(b.t))).at(-1);
    if (last && (!best || last.t > best.t)) best = { symbol, hour, t: last.t, close: last.c };
  }
  return best;
}

/** The spoken answer, from the feed records alone. [cryptoFeeds] is cryptoView().feeds; [futuresOpen] the CME clock. */
export async function speakFeedLive(storage, feed, { now = Date.now(), cryptoFeeds = null, futuresOpen = tradingClock(now).futures.open } = {}) {
  if (feed === 'crypto') {
    const rows = (cryptoFeeds || (await cryptoView(storage, now).catch(() => ({ feeds: [] }))).feeds).filter((f) => f.tf === '5m');
    if (!rows.some((f) => f.last_bar)) return 'No crypto market data has been read yet, sir: Orion\'s desk has not fetched a Coinbase candle. It uses Coinbase public market data, which needs no account.';
    const lines = rows.map((f) => (f.last_bar
      ? `${f.coin}: newest 5-minute candle ${f.status === 'LIVE' ? 'is current' : `is ${String(f.status).toLowerCase()}`}, closed ${nyTime(f.last_bar)} New York time (${ago(f.last_bar, now)}), last price ${f.last_close}`
      : `${f.coin}: ${String(f.status || 'not read').toLowerCase()}${f.reason ? ` (${f.reason})` : ''}`));
    return `Not a live stream on my side, sir. ${lines.join('. ')}. That is Coinbase public market data polled every 5 minutes, with no trading account. The Trading Room chart streams BTC and ETH trades on your phone and says LIVE only when a trade arrived in the last minute.`;
  }
  const minute = await newestRithmicMinute(storage);
  const stored = (await storage.get('live_paper_feed').catch(() => null)) || {};
  const closedAt = minute ? Date.parse(minute.t) + 60_000 : null;
  const closedIso = closedAt == null ? '' : new Date(closedAt).toISOString();
  const delayed = stored.last_bar_time ? ` My own MNQ record is ${stored.provider || 'a delayed source'}, ${String(stored.status || 'unknown').toLowerCase()}, last bar ${nyTime(stored.last_bar_time)} New York time; delayed data is never called live.` : '';
  const hours = futuresOpen === false ? ' CME futures are closed right now (Sunday 6 PM to Friday 5 PM New York time, with a 5 to 6 PM break), so no trades are expected.' : '';
  if (closedAt != null && now - closedAt <= FRESH_MS) return `Yes, sir: live Rithmic data. The newest ${minute.symbol} minute your iPhone recorded closed ${ago(closedIso, now)}, at ${minute.close}.${delayed}`;
  if (minute) return `No, sir, the MNQ data is not live. The newest Rithmic minute your iPhone recorded, ${minute.symbol}, closed ${nyTime(closedIso)} New York time, ${ago(closedIso, now)}. Rithmic runs only while CHE is open on your phone.${hours}${delayed}`;
  return `No, sir, there is no live MNQ data: no Rithmic minute has been recorded yet. Live futures data comes only from Rithmic on your iPhone, and being signed in is not the same as receiving trades.${hours}${delayed}`;
}
