// One view of every trading connection for the Trading Room and for voice (issue #344).
// It only reads what each existing system reports (the paper engine, the trading desk, the
// Tradovate sign-in, the Alpaca paper check); it never changes a mode or a connection. Each
// card says its real state, so nothing reads "connected" until the provider proved it.

export const MODE_LABEL = { paper: 'PAPER', sim: 'BROKER SIM', live: 'LIVE' };

// What Tradovate itself requires before CHE can use its API (owner research, Oct 18 2026).
export const TRADOVATE_PREREQUISITES = [
  'A funded Tradovate live account with more than $1,000',
  'The CME market-data agreement signed in Tradovate',
  "Tradovate's paid API add-on (it does not include real-time CME data)",
  'An OAuth app registered with Tradovate, saved as the Worker secrets CHE_TRADOVATE_OAUTH_CLIENT_ID and CHE_TRADOVATE_OAUTH_CLIENT_SECRET',
];

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
    open_account: TRADOVATE_OPEN_ACCOUNT,
    detail: state === 'signed_in' ? 'Signed in on Tradovate\'s own page; CHE never sees the password.'
      : state === 'expired' ? 'The Tradovate sign-in expired; say "connect NinjaTrader" to sign in again.'
        : state === 'configured' ? 'The OAuth app is set up; say "connect NinjaTrader" to sign in on Tradovate\'s page.'
          : 'Not set up: Tradovate has to approve API access first.',
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
    detail: alpaca?.state === 'verified' ? `Paper account ending ${a.account_last4 || '—'}: ${a.status}, buying power $${a.buying_power ?? 'unknown'}${a.options_approved_level != null ? `, options level ${a.options_approved_level}` : ''}.`
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
      live_orders: desk.mode === 'live' && signedIn && desk.risk_limits && desk.account.live ? 'each order needs your approval of that exact order' : 'off',
    },
  };
}

const SAY_STATE = { on: 'on', off: 'off', not_configured: 'not set up', configured: 'set up, not signed in', signed_in: 'signed in', expired: 'sign-in expired', verified: 'verified', rejected: 'key rejected', refused: 'live key refused', unavailable: 'could not be checked', unsupported: 'not supported' };

/** A numbered spoken list, one line per connection. */
export function speakConnections(view) {
  const lines = view.cards.map((c, i) => {
    const extra = c.id === 'che_paper' && c.data.label ? `, ${c.data.label.toLowerCase()} ${c.data.source || ''} data`.trimEnd() : '';
    return `${i + 1}, ${c.name}: ${SAY_STATE[c.state] || c.state}${extra}.`;
  });
  const live = view.permissions.live_orders === 'off' ? 'Live orders are off.' : 'Live orders need your approval of each exact order.';
  return `Your trading connections, sir: ${lines.join(' ')} Trading mode: ${view.mode}. ${live}`;
}
