// One view of every trading connection for the Trading Room and for voice (issue #344).
// It only reads what each existing system reports (the paper engine, the trading desk, the
// Tradovate sign-in, the Alpaca paper check); it never changes a mode or a connection. Each
// card says its real state, so nothing reads "connected" until the provider proved it.

import { liveOrderBlock } from './trading_environments.js';

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
  detail: 'FundYourEdge trades on Rithmic, whose order API needs a licensed developer kit; CHE has no Rithmic connection. TradeSea inside CHE is a viewer only, and CHE never uses your Rithmic login as an API key.',
};

/** The cards, the desk mode and what each permission currently allows. */
export function tradingConnections({ paper = null, desk, tradovate = {}, alpaca = null }) {
  const cards = [paperCard(paper), tradovateCard({ ...tradovate, desk }), alpacaCard(alpaca), FUNDYOUREDGE];
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

const SAY_STATE = { on: 'on', off: 'off', not_configured: 'not set up', configured: 'set up, not signed in', signed_in: 'signed in', expired: 'sign-in expired', verified: 'verified', rejected: 'key rejected', refused: 'live key refused', unavailable: 'could not be checked', unsupported: 'not supported' };

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
