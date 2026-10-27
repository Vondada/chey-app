// CHE's trade approval: a proposal becomes an order only through an explicit choice and a fresh
// recheck. Pure functions only. Nothing here talks to a broker or storage; the caller passes the
// broker answer, the account and the prices in, so every path can be tested with mock responses.
//
// Choices: 'paper' (CHE Paper), 'live' (My Account), 'both' (Paper + My Account: two independent
// confirmations, one for each order). A live order is never created from a paper confirmation.

export const CHOICES = Object.freeze(['paper', 'live', 'both']);
export const APPROVAL_TTL_MS = 120_000;
export const MAX_DATA_AGE_MS = 60_000;
export const ORDER_STATES = Object.freeze(['proposed', 'approved', 'submitted', 'acknowledged', 'partial', 'filled', 'rejected', 'cancelled', 'error']);
// A fill is "real" only when a broker reported it. Anything else is a simulated fill and says so.
export const REAL_SOURCES = Object.freeze(['broker']);

// FNV-1a over a string: a stable id for the order's content. Not a security token.
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// The fields that decide what would be sent. Changing any of them changes the fingerprint.
export function fingerprint(order = {}) {
  const fields = ['account', 'symbol', 'side', 'qty', 'entry', 'stop', 'target', 'type'];
  return hash(JSON.stringify(fields.map((f) => [f, order[f] ?? null])));
}

export function riskDollars(order = {}) {
  const risk = Math.abs(Number(order.entry) - Number(order.stop)) * Number(order.qty) * Number(order.point_value || 1);
  return Number.isFinite(risk) ? Math.round(risk * 100) / 100 : null;
}

/** A proposal from a detected setup. The order id is unique per proposal, so a repeat cannot share it. */
export function buildProposal(setup = {}, { now = Date.now(), nonce = '' } = {}) {
  const order = {
    account: String(setup.account || ''),
    symbol: String(setup.symbol || '').toUpperCase(),
    side: String(setup.side || '').toLowerCase(),
    qty: Number(setup.qty),
    entry: Number(setup.entry),
    stop: Number(setup.stop),
    target: Number(setup.target),
    type: String(setup.type || 'market'),
    point_value: Number(setup.point_value || 1),
    strategy: String(setup.strategy || ''),
  };
  const id = `CHE-${hash(`${fingerprint(order)}|${now}|${nonce}`)}`;
  return { order_id: id, order, fingerprint: fingerprint(order), state: 'proposed', created_at: new Date(now).toISOString(), approvals: [], events: [] };
}

/** Any change to the order is a new proposal state: every earlier approval is cleared. */
export function modifyProposal(proposal, changes = {}, { now = Date.now() } = {}) {
  const order = { ...proposal.order, ...changes };
  order.symbol = String(order.symbol || '').toUpperCase();
  order.side = String(order.side || '').toLowerCase();
  const next = fingerprint(order);
  return {
    ...proposal,
    order,
    fingerprint: next,
    state: 'proposed',
    approvals: [],
    events: [...proposal.events, { at: new Date(now).toISOString(), type: 'modified', from: proposal.fingerprint, to: next }],
  };
}

/**
 * Every check that must pass before a live or paper order can be approved. Returns the blockers;
 * an empty list means the checks passed for this instant. `ctx` carries what the caller verified:
 * data { last_bar_ms, delayed }, broker { connected, trading_permitted, account_id, kind },
 * account { funded, buying_power, realized_today, open_positions, max_daily_loss, max_open_positions,
 * open_symbols }, firm_rules { verified_at_ms, source, max_contracts, ... } for funded accounts.
 */
export function reviewProposal(proposal, ctx = {}, { now = Date.now(), choice = 'paper', journal = [] } = {}) {
  const b = [];
  const o = proposal.order;
  if (!o.symbol || !['buy', 'sell'].includes(o.side)) b.push('the order needs a symbol and a buy or sell side');
  if (!(o.qty > 0) || !Number.isInteger(o.qty)) b.push('the quantity must be a whole number of contracts above zero');
  if (![o.entry, o.stop, o.target].every(Number.isFinite)) b.push('entry, stop and target must all be prices');
  else if (o.side === 'buy' && !(o.stop < o.entry && o.target > o.entry)) b.push('a buy needs its stop below entry and its target above');
  else if (o.side === 'sell' && !(o.stop > o.entry && o.target < o.entry)) b.push('a sell needs its stop above entry and its target below');
  if (ctx.emergency) b.push('Emergency Stop is on');
  if (ctx.stop_new_entries) b.push('new entries are stopped');

  // Market data: a delayed feed can be tested, never sent as a live price.
  const age = now - Number(ctx.data?.last_bar_ms);
  if (!Number.isFinite(age) || age > MAX_DATA_AGE_MS) b.push('the market data is not fresh (older than one minute or unknown)');
  if (choice !== 'paper' && ctx.data?.delayed !== false) b.push('the live price is delayed, so no live order can be checked against it');

  if (choice !== 'paper') {
    const broker = ctx.broker || {};
    if (!broker.connected) b.push('the broker is not connected');
    if (!broker.trading_permitted) b.push('the broker has not confirmed trading permission for this account');
    if (!broker.account_id) b.push('the destination account is not confirmed');
    if (broker.account_id && o.account && broker.account_id !== o.account) b.push('the order account does not match the connected account');
    const acct = ctx.account || {};
    if (Number.isFinite(acct.buying_power) && Number(o.qty) * Number(o.entry) * Number(o.point_value || 1) > acct.buying_power) b.push('the order needs more buying power than the account has');
    if (Number.isFinite(acct.realized_today) && Number.isFinite(acct.max_daily_loss) && acct.realized_today <= -acct.max_daily_loss) b.push('the daily loss limit was reached');
    if (Number.isFinite(acct.open_positions) && Number.isFinite(acct.max_open_positions) && acct.open_positions >= acct.max_open_positions) b.push('the open-position limit was reached');
    if ((acct.open_symbols || []).includes(o.symbol) && acct.open_positions > 0 && !acct.allow_add) b.push(`a position in ${o.symbol} is already open`);
    if (acct.funded) {
      const rules = ctx.firm_rules;
      if (!rules || !rules.verified_at_ms || !rules.source) b.push('the funded-account rules have not been verified for this firm');
      else if (now - rules.verified_at_ms > 24 * 3_600_000) b.push('the funded-account rules were verified more than 24 hours ago');
      else if (Number.isFinite(rules.max_contracts) && o.qty > rules.max_contracts) b.push(`the firm allows at most ${rules.max_contracts} contracts`);
    }
  }
  const repeat = journal.find((r) => r.fingerprint === proposal.fingerprint && r.state !== 'rejected' && r.state !== 'error' && now - Date.parse(r.at || 0) < 60_000);
  if (repeat) b.push('the same order was already sent in the last minute');
  return b;
}

/**
 * Record the owner's explicit choice for the exact current fingerprint. A live or both approval
 * must echo the destination account and the fingerprint the owner saw. Returns { proposal, error }.
 */
export function approveProposal(proposal, { choice, confirmed_fingerprint, confirmed_account = '', now = Date.now() } = {}) {
  if (!CHOICES.includes(choice)) return { proposal, error: 'the execution choice must be paper, live or both' };
  if (confirmed_fingerprint !== proposal.fingerprint) return { proposal, error: 'the order changed after you saw it, so the approval was not recorded' };
  const needsLive = choice !== 'paper';
  if (needsLive && confirmed_account !== proposal.order.account) return { proposal, error: 'the account you confirmed does not match the order' };
  const legs = choice === 'both' ? ['paper', 'live'] : [choice];
  const approvals = legs.map((leg) => ({ leg, fingerprint: proposal.fingerprint, account: leg === 'live' ? proposal.order.account : 'CHE Paper', at: new Date(now).toISOString(), expires_at: new Date(now + APPROVAL_TTL_MS).toISOString(), used: false }));
  return { proposal: { ...proposal, state: 'approved', approvals, events: [...proposal.events, { at: new Date(now).toISOString(), type: 'approved', choice }] }, error: '' };
}

/**
 * Last check before a submission. Rejects an expired approval, a changed order, a second use of the
 * same approval, and any blocker found by a fresh review. Returns { ok, reason, leg }.
 */
export function recheckForSubmit(proposal, leg, ctx = {}, { now = Date.now(), journal = [] } = {}) {
  const approval = proposal.approvals.find((a) => a.leg === leg);
  if (!approval) return { ok: false, reason: `there is no ${leg} approval for this order` };
  if (approval.used) return { ok: false, reason: 'this approval was already used for a submission' };
  if (now > Date.parse(approval.expires_at)) return { ok: false, reason: 'the approval expired, so the order must be confirmed again' };
  if (approval.fingerprint !== proposal.fingerprint) return { ok: false, reason: 'the order changed after approval' };
  const blockers = reviewProposal(proposal, ctx, { now, choice: leg === 'live' ? 'live' : 'paper', journal });
  if (blockers.length) return { ok: false, reason: blockers.join('; ') };
  return { ok: true, reason: '', leg };
}

/**
 * Idempotent submission: the same order id and leg are sent at most once. `submit` is the broker or
 * paper adapter; it returns { ack_id, status } and never throws across this boundary.
 */
export async function submitOnce(proposal, leg, ctx, { submitted = new Set(), submit, now = Date.now(), journal = [] } = {}) {
  const key = `${proposal.order_id}:${leg}`;
  if (submitted.has(key)) return { ok: false, reason: 'this order was already submitted (duplicate refused)', key };
  const check = recheckForSubmit(proposal, leg, ctx, { now, journal });
  if (!check.ok) return { ok: false, reason: check.reason, key };
  submitted.add(key);
  try {
    const answer = await submit({ order_id: proposal.order_id, leg, ...proposal.order });
    return { ok: true, key, ack_id: String(answer?.ack_id || ''), status: String(answer?.status || 'acknowledged') };
  } catch (error) {
    return { ok: false, reason: `the ${leg} order was not confirmed: ${String(error?.message || error).slice(0, 200)}`, key, error: true };
  }
}

/**
 * Record what really happened. A fill is labelled real only when the source is the broker.
 * Simulated fills keep their label so the paper ledger is never shown as a broker fill.
 */
export function recordEvent(proposal, event = {}, { now = Date.now() } = {}) {
  const state = ORDER_STATES.includes(event.state) ? event.state : 'error';
  const source = String(event.source || 'unknown');
  const real = REAL_SOURCES.includes(source);
  const isFill = state === 'filled' || state === 'partial';
  const label = isFill && !real ? 'simulated fill (not a broker fill)' : (isFill ? 'broker fill' : state);
  const entry = { at: new Date(now).toISOString(), state, source, label, qty: event.qty ?? null, price: event.price ?? null, ack_id: event.ack_id || '', message: String(event.message || '').slice(0, 300) };
  return { ...proposal, state, events: [...proposal.events, entry] };
}
