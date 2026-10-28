// A time-limited automation session. The owner authorizes it once with per-destination limits; each
// order inside it is checked here, server-side, before it is sent. Pure functions: no network or storage.
// Funded and personal-brokerage destinations stay disabled until their own verification is recorded.

export const DESTINATIONS = Object.freeze(['che_paper', 'fundyouredge', 'personal_broker']);
export const INSTRUMENTS = Object.freeze(['MNQ', 'NQ', 'ES']);
export const MAX_SESSION_MS = 8 * 3_600_000;

// Destinations that may trade inside a session. Funded and personal accounts need a verification record.
export function destinationReady(dest, verification = {}) {
  if (dest === 'che_paper') return { ok: true, reason: '' };
  const v = verification[dest];
  if (!v) return { ok: false, reason: `${dest} is not verified for automation` };
  if (!v.connection_verified) return { ok: false, reason: `${dest} connection is not verified` };
  if (!v.rules_verified_source) return { ok: false, reason: `${dest} published rules are not verified` };
  if (!v.agreement_verified) return { ok: false, reason: `${dest} account agreement is not verified` };
  return { ok: true, reason: '' };
}

/** Owner authorization: a time-limited session with its destinations, instruments and limits. */
export function authorizeSession(input = {}, { now = Date.now(), verification = {} } = {}) {
  const destinations = (input.destinations || []).filter((d) => DESTINATIONS.includes(d));
  const instruments = (input.instruments || []).filter((i) => INSTRUMENTS.includes(i));
  const duration = Math.min(Number(input.duration_ms) || 0, MAX_SESSION_MS);
  if (!destinations.length) return { error: 'choose at least one destination' };
  if (!instruments.length) return { error: 'choose at least one instrument (MNQ, NQ or ES)' };
  if (!(duration > 0)) return { error: 'the session needs a duration' };
  const limits = {};
  for (const d of destinations) {
    const l = (input.limits || {})[d] || {};
    limits[d] = {
      max_session_loss: Number(l.max_session_loss) || 0,
      max_loss_per_trade: Number(l.max_loss_per_trade) || 0,
      max_trades: Number(l.max_trades) || 0,
      max_contracts: Number(l.max_contracts) || 0,
      max_positions: Number(l.max_positions) || 0,
    };
    if (Object.values(limits[d]).some((x) => !(x > 0))) return { error: `${d} needs every limit set above zero` };
  }
  const ready = {};
  for (const d of destinations) ready[d] = destinationReady(d, verification);
  return {
    session: {
      id: `SES-${now.toString(36)}`, started_at: now, expires_at: now + duration, destinations, instruments, limits,
      emergency: false, trades: 0, realized_loss: {}, halted: {}, ready,
    },
    error: '',
  };
}

/** Each order is checked against the session, its destination's limits and the expiry, before sending. */
export function checkOrder(session, order = {}, state = {}, { now = Date.now() } = {}) {
  const blockers = [];
  if (!session) return { ok: false, blockers: ['no authorized session'] };
  if (session.emergency) blockers.push('the emergency stop is on');
  if (now >= session.expires_at) blockers.push('the session has expired');
  const dest = order.destination;
  if (!session.destinations.includes(dest)) blockers.push(`${dest} is not in this session`);
  if (!session.instruments.includes(order.instrument)) blockers.push(`${order.instrument} is not in this session`);
  if (session.ready[dest] && !session.ready[dest].ok) blockers.push(session.ready[dest].reason);
  if (session.halted[dest]) blockers.push(`${dest} was halted: ${session.halted[dest]}`);
  const lim = session.limits[dest];
  if (lim) {
    if (Number(order.qty) > lim.max_contracts) blockers.push(`${order.qty} contracts is above the ${lim.max_contracts} limit`);
    if (Number(order.risk_per_trade) > lim.max_loss_per_trade) blockers.push(`the risk of $${order.risk_per_trade} is above the $${lim.max_loss_per_trade} per-trade limit`);
    if (session.trades >= lim.max_trades) blockers.push(`the ${lim.max_trades}-trade limit for this session was reached`);
    if ((state.open_positions || 0) >= lim.max_positions) blockers.push(`the ${lim.max_positions}-position limit was reached`);
    const lost = -(session.realized_loss[dest] || 0);
    if (lost >= lim.max_session_loss) blockers.push(`the $${lim.max_session_loss} session loss limit was reached`);
  }
  return { ok: blockers.length === 0, blockers };
}

/** Record a closed trade's result; a limit breach halts that destination at once. */
export function recordTrade(session, { destination, pnl = 0 }, { now = Date.now() } = {}) {
  const realized = { ...session.realized_loss, [destination]: (session.realized_loss[destination] || 0) + Number(pnl) };
  const next = { ...session, trades: session.trades + 1, realized_loss: realized, halted: { ...session.halted } };
  const lim = session.limits[destination];
  if (lim && -realized[destination] >= lim.max_session_loss) next.halted[destination] = 'session loss limit reached';
  if (now >= session.expires_at) next.halted = Object.fromEntries(session.destinations.map((d) => [d, 'session expired']));
  return next;
}

export function emergencyStop(session) {
  return { ...session, emergency: true, halted: Object.fromEntries(session.destinations.map((d) => [d, 'emergency stop'])) };
}
