// CHE Futures Paper Simulator: manual paper trading of MNQ, NQ, MES and ES (owner, 2026-11-04: "trade MNQ, NQ, MES and
// ES through CHE, starting with paper trading").
//
// This is CHE's own simulator, not a broker. No broker that CHE can reach executes futures today: Tradovate needs a
// funded account, the CME agreement and its paid API add-on; Rithmic's order API is licensed; Interactive Brokers has
// no integration; Alpaca has no futures. So every order here is a paper order on CHE's own ledger, filled against real
// CME prices from the only feed CHE has, which is DELAYED (Yahoo Finance's public chart data, about ten minutes behind).
// Nothing here can reach a broker or move money, and every reply and receipt says "paper" and "delayed".
//
// Rules, all deterministic:
//   - Orders: market, limit and stop, with an optional stop loss and take profit (a bracket: one cancels the other).
//   - A market order fills at once at the latest delayed price, one tick against the trader, and only while the feed
//     is fresh (a closed bar within FRESH_MS, CME session open). Otherwise it is rejected: there is no current price.
//   - A limit or stop order works until a delayed bar that STARTED after it was placed reaches its price. Inside one
//     bar a stop is checked before a target (the worst case). A stop pays one tick of slippage; a gap fills at the open.
//   - Every fill pays a simulated commission per contract per side.
//   - Positions, cash and P&L are always recomputable from the fill ledger alone (reconcile), and are checked.
//   - The same client order id never places twice; an identical order within DUPLICATE_MS is refused as a duplicate.
//   - Risk limits: contracts per market and a daily loss limit; past the limit only reducing orders are accepted.
//   - Flatten cancels every working order and closes every position, even on stale data (paper only, said so).

export const ROOTS = Object.freeze({
  MNQ: { name: 'Micro E-mini Nasdaq-100', yahoo: 'MNQ=F', tick: 0.25, pointValue: 2, commission: 0.62, maxContracts: 10 },
  NQ: { name: 'E-mini Nasdaq-100', yahoo: 'NQ=F', tick: 0.25, pointValue: 20, commission: 2.25, maxContracts: 2 },
  MES: { name: 'Micro E-mini S&P 500', yahoo: 'MES=F', tick: 0.25, pointValue: 5, commission: 0.62, maxContracts: 10 },
  ES: { name: 'E-mini S&P 500', yahoo: 'ES=F', tick: 0.25, pointValue: 50, commission: 2.25, maxContracts: 2 },
});
export const STATE_KEY = 'futures_paper_v1';
export const ACCOUNT_ID = 'CHE-PAPER-FUTURES';
export const STARTING_CASH = 50_000;
export const DAILY_LOSS_LIMIT = 500;
export const FRESH_MS = 30 * 60_000;
export const DUPLICATE_MS = 5_000;
export const SIMULATOR = 'CHE Futures Paper Simulator';
const MAX_ORDERS = 400;
const MAX_FILLS = 1000;

const round2 = (x) => Math.round(x * 100) / 100;
const iso = (ms) => new Date(ms).toISOString();
const onTick = (price, tick) => Math.abs(price / tick - Math.round(price / tick)) < 1e-6;

export function emptyState(now = Date.now()) {
  return { v: 1, account: { id: ACCOUNT_ID, starting_cash: STARTING_CASH, created_at: iso(now) }, orders: [], fills: [], positions: {}, cash: STARTING_CASH, realized: 0, commissions: 0, seq: 0, feeds: {}, processed: {}, events: [] };
}
export async function loadState(storage, now = Date.now()) {
  const saved = await Promise.resolve(storage.get(STATE_KEY)).catch(() => null);
  return saved && saved.v === 1 ? saved : emptyState(now);
}
export async function saveState(storage, state) {
  state.orders = state.orders.slice(-MAX_ORDERS);
  state.fills = state.fills.slice(-MAX_FILLS);
  state.events = (state.events || []).slice(-100);
  await storage.put(STATE_KEY, state);
}

function nextId(state, prefix) {
  state.seq = Number(state.seq || 0) + 1;
  return `${prefix}-${String(state.seq).padStart(5, '0')}`;
}
function note(state, now, text) { state.events.push({ at: iso(now), text: String(text).slice(0, 300) }); }

// ─── Prices ───

/** A feed reading for one root: { status: DELAYED | UNAVAILABLE, price, bar_time, candles, delayed_by_min, error }. */
export function feedReading(root, intraday, now = Date.now()) {
  const candles = Array.isArray(intraday?.candles) ? intraday.candles : [];
  const last = candles[candles.length - 1];
  const barTime = last ? Date.parse(last.t) : 0;
  const sessionOpen = intraday?.session?.open !== false;
  const ok = intraday?.status === 'DELAYED' && last && Number.isFinite(last.c);
  const ageMs = barTime ? now - barTime - 60_000 : null;
  return {
    root,
    status: ok ? 'DELAYED' : 'UNAVAILABLE',
    source: `${intraday?.provider || 'Yahoo Finance chart (public)'} ${ROOTS[root]?.yahoo || ''}`.trim(),
    contract: intraday?.contract || '',
    price: ok ? last.c : null,
    bar_time: last?.t || null,
    age_s: ageMs == null ? null : Math.max(0, Math.round(ageMs / 1000)),
    delayed_by_min: intraday?.delayed_by_min ?? null,
    session: intraday?.session?.state || '',
    fresh: Boolean(ok && sessionOpen && ageMs != null && ageMs <= FRESH_MS),
    error: ok ? '' : String(intraday?.error || 'no closed bars').slice(0, 200),
    checked_at: iso(now),
    candles,
  };
}

// ─── Positions and P&L from the ledger ───

function applyFill(book, fill) {
  const spec = ROOTS[fill.root];
  const signed = fill.side === 'buy' ? fill.qty : -fill.qty;
  const pos = book.positions[fill.root] || { qty: 0, avg: 0 };
  let realized = 0;
  if (pos.qty === 0 || Math.sign(pos.qty) === Math.sign(signed)) {
    const qty = pos.qty + signed;
    pos.avg = (pos.avg * Math.abs(pos.qty) + fill.price * Math.abs(signed)) / Math.abs(qty);
    pos.qty = qty;
  } else {
    const closing = Math.min(Math.abs(signed), Math.abs(pos.qty));
    realized = (fill.price - pos.avg) * closing * Math.sign(pos.qty) * spec.pointValue;
    const qty = pos.qty + signed;
    if (qty === 0) { pos.qty = 0; pos.avg = 0; } else if (Math.sign(qty) !== Math.sign(pos.qty)) { pos.qty = qty; pos.avg = fill.price; } else pos.qty = qty;
  }
  book.positions[fill.root] = pos;
  book.realized += realized;
  book.commissions += fill.commission;
  book.cash += realized - fill.commission;
  return round2(realized);
}

/** Positions, cash, realized P&L and commissions recomputed from the fill ledger alone. */
export function ledgerBook(fills = []) {
  const book = { positions: {}, cash: STARTING_CASH, realized: 0, commissions: 0 };
  for (const fill of fills) applyFill(book, fill);
  book.cash = round2(book.cash); book.realized = round2(book.realized); book.commissions = round2(book.commissions);
  return book;
}

/** Reconciliation: the stored book against the ledger, every field; the receipt lists any difference. */
export function reconcile(state, now = Date.now()) {
  const book = ledgerBook(state.fills);
  const diffs = [];
  const roots = new Set([...Object.keys(book.positions), ...Object.keys(state.positions || {})]);
  for (const root of roots) {
    const a = state.positions?.[root] || { qty: 0, avg: 0 };
    const b = book.positions[root] || { qty: 0, avg: 0 };
    if (a.qty !== b.qty || (b.qty !== 0 && Math.abs(a.avg - b.avg) > 1e-6)) diffs.push(`${root}: stored ${a.qty} @ ${a.avg}, ledger ${b.qty} @ ${b.avg}`);
  }
  for (const k of ['cash', 'realized', 'commissions']) if (Math.abs(round2(state[k]) - book[k]) > 0.005) diffs.push(`${k}: stored ${round2(state[k])}, ledger ${book[k]}`);
  const fillIds = new Set(state.fills.map((f) => f.id));
  for (const o of state.orders.filter((x) => x.status === 'filled')) if (!o.fill_id || !fillIds.has(o.fill_id)) diffs.push(`order ${o.id} is filled but has no fill in the ledger`);
  return { tool: 'che_futures_paper', operation: 'reconcile', status: diffs.length ? 'failure' : 'success', at: iso(now), fills: state.fills.length, orders: state.orders.length, positions: book.positions, cash: book.cash, realized: book.realized, commissions: book.commissions, diffs };
}

export function openPnl(state, readings = {}) {
  let total = 0;
  const rows = [];
  for (const [root, pos] of Object.entries(state.positions || {})) {
    if (!pos.qty) continue;
    const price = readings[root]?.price ?? state.feeds?.[root]?.price ?? null;
    const pnl = price == null ? null : round2((price - pos.avg) * pos.qty * ROOTS[root].pointValue);
    if (pnl != null) total += pnl;
    rows.push({ root, qty: pos.qty, avg: pos.avg, mark: price, open_pnl: pnl, mark_time: readings[root]?.bar_time ?? state.feeds?.[root]?.bar_time ?? null });
  }
  return { rows, total: round2(total) };
}

function todayLoss(state, now) {
  const day = iso(now).slice(0, 10);
  const realizedToday = state.fills.filter((f) => String(f.time).slice(0, 10) === day).reduce((s, f) => s + (f.realized || 0) - f.commission, 0);
  return round2(realizedToday + openPnl(state).total);
}

// ─── Orders ───

function receipt(operation, status, extra = {}, now = Date.now()) {
  return { tool: 'che_futures_paper', operation, status, at: iso(now), simulator: SIMULATOR, money_at_risk: false, ...extra };
}

function fillOrder(state, order, price, timeMs, basis) {
  const spec = ROOTS[order.root];
  const fill = { id: nextId(state, 'F'), order_id: order.id, root: order.root, side: order.side, qty: order.qty, price, time: iso(timeMs), commission: round2(spec.commission * order.qty), basis };
  const book = { positions: state.positions, cash: state.cash, realized: state.realized, commissions: state.commissions };
  fill.realized = applyFill(book, fill);
  Object.assign(state, { cash: round2(book.cash), realized: round2(book.realized), commissions: round2(book.commissions) });
  state.fills.push(fill);
  Object.assign(order, { status: 'filled', fill_id: fill.id, filled_at: fill.time, fill_price: price });
  // Bracket: the entry's fill places its stop loss and take profit; a child's fill cancels its sibling.
  if (order.bracket && !order.parent_id) {
    const exit = order.side === 'buy' ? 'sell' : 'buy';
    const group = `OCO-${order.id}`;
    if (order.bracket.stop_loss != null) state.orders.push(newOrder(state, { root: order.root, side: exit, qty: order.qty, type: 'stop', price: order.bracket.stop_loss, parent_id: order.id, oco: group, role: 'stop_loss' }, timeMs));
    if (order.bracket.take_profit != null) state.orders.push(newOrder(state, { root: order.root, side: exit, qty: order.qty, type: 'limit', price: order.bracket.take_profit, parent_id: order.id, oco: group, role: 'take_profit' }, timeMs));
  }
  if (order.oco) for (const sib of state.orders) if (sib.oco === order.oco && sib.id !== order.id && sib.status === 'working') Object.assign(sib, { status: 'cancelled', cancelled_at: fill.time, cancel_reason: `its bracket partner ${order.id} filled` });
  note(state, timeMs, `${order.id} filled: ${order.side} ${order.qty} ${order.root} at ${price} (${basis}).`);
  return fill;
}

function newOrder(state, o, nowMs) {
  return {
    id: nextId(state, 'O'), client_id: o.client_id || '', root: o.root, side: o.side, qty: o.qty, type: o.type,
    price: o.price ?? null, status: 'working', placed_at: iso(nowMs), parent_id: o.parent_id || '', oco: o.oco || '', role: o.role || 'entry',
    ...(o.bracket ? { bracket: o.bracket } : {}),
  };
}

/** Problems with an order request, before any risk or price check; empty when it is well formed. */
export function orderProblems(o = {}) {
  const spec = ROOTS[o.root];
  const out = [];
  if (!spec) out.push(`I trade only ${Object.keys(ROOTS).join(', ')} on paper`);
  if (!['buy', 'sell'].includes(o.side)) out.push('the side must be buy or sell');
  if (!Number.isInteger(o.qty) || o.qty < 1) out.push('the quantity must be a whole number of contracts, at least 1');
  if (!['market', 'limit', 'stop'].includes(o.type)) out.push('the order type must be market, limit or stop');
  if (o.type !== 'market' && !(Number(o.price) > 0)) out.push(`a ${o.type} order needs a price`);
  if (spec) {
    for (const [label, v] of [['price', o.type === 'market' ? null : o.price], ['stop loss', o.stop_loss], ['take profit', o.take_profit]]) {
      if (v != null && !(Number(v) > 0 && onTick(Number(v), spec.tick))) out.push(`the ${label} ${v} is not on ${o.root}'s ${spec.tick}-point tick`);
    }
  }
  return out;
}

/**
 * Place one paper order. `reading` is the root's feed reading (feedReading). Returns { ok, order, fill?, receipt, text }.
 * A duplicate (same client id, or the same order within DUPLICATE_MS) returns the existing order and places nothing.
 */
export function placeOrder(state, req, reading, now = Date.now()) {
  const o = { root: String(req.root || '').toUpperCase(), side: String(req.side || '').toLowerCase(), qty: Number(req.qty), type: String(req.type || 'market').toLowerCase(), price: req.price == null ? null : Number(req.price), stop_loss: req.stop_loss == null ? null : Number(req.stop_loss), take_profit: req.take_profit == null ? null : Number(req.take_profit), client_id: String(req.client_id || '').slice(0, 80) };
  const reject = (why, extra = {}) => {
    const order = { ...newOrder(state, o, now), status: 'rejected', reject_reason: why };
    state.orders.push(order);
    note(state, now, `${order.id} rejected: ${why}.`);
    return { ok: false, order, receipt: receipt('place_order', 'rejected', { order_id: order.id, reason: why, ...extra }, now), text: `Paper order rejected, sir: ${why}. Nothing was placed.` };
  };
  const dupe = o.client_id
    ? state.orders.find((x) => x.client_id === o.client_id)
    : state.orders.find((x) => x.status !== 'rejected' && !x.parent_id && x.root === o.root && x.side === o.side && x.qty === o.qty && x.type === o.type && (x.price ?? null) === (o.type === 'market' ? null : o.price) && now - Date.parse(x.placed_at) < DUPLICATE_MS);
  if (dupe) return { ok: true, duplicate: true, order: dupe, receipt: receipt('place_order', 'duplicate', { order_id: dupe.id, order_status: dupe.status }, now), text: `That is the same paper order as ${dupe.id} (${dupe.status}), sir, so I did not place it twice.` };
  const problems = orderProblems(o);
  if (problems.length) return reject(problems.join('; '));
  const spec = ROOTS[o.root];
  const pos = state.positions[o.root]?.qty || 0;
  const signed = o.side === 'buy' ? o.qty : -o.qty;
  const reduces = pos !== 0 && Math.sign(signed) !== Math.sign(pos) && Math.abs(signed) <= Math.abs(pos);
  if (!reduces && Math.abs(pos + signed) > spec.maxContracts) return reject(`it would hold ${Math.abs(pos + signed)} ${o.root}, over the ${spec.maxContracts}-contract paper limit`);
  if (!reduces && todayLoss(state, now) <= -DAILY_LOSS_LIMIT) return reject(`today's paper loss has reached the ${DAILY_LOSS_LIMIT}-dollar daily limit; only orders that reduce a position are accepted`);
  const ref = reading?.price ?? null;
  if (o.type === 'market' && !reading?.fresh) return reject(`there is no current ${o.root} price (${reading?.status === 'DELAYED' ? `the latest delayed bar is ${Math.round((reading.age_s || 0) / 60)} minutes old${reading.session && reading.session !== 'open' ? `, market ${reading.session}` : ''}` : `the feed is unavailable: ${reading?.error || 'no answer'}`})`, { feed: reading?.status || 'UNAVAILABLE' });
  // A bracket's prices must sit on the right sides of the entry.
  const entryRef = o.type === 'market' ? ref : o.price;
  if (entryRef != null) {
    const long = o.side === 'buy';
    if (o.stop_loss != null && (long ? o.stop_loss >= entryRef : o.stop_loss <= entryRef)) return reject(`a ${long ? 'buy' : 'sell'}'s stop loss must be ${long ? 'below' : 'above'} its entry (${entryRef})`);
    if (o.take_profit != null && (long ? o.take_profit <= entryRef : o.take_profit >= entryRef)) return reject(`a ${long ? 'buy' : 'sell'}'s take profit must be ${long ? 'above' : 'below'} its entry (${entryRef})`);
  }
  const order = newOrder(state, { ...o, ...(o.stop_loss != null || o.take_profit != null ? { bracket: { stop_loss: o.stop_loss, take_profit: o.take_profit } } : {}) }, now);
  state.orders.push(order);
  note(state, now, `${order.id} accepted: ${o.side} ${o.qty} ${o.root} ${o.type}${o.price ? ` ${o.price}` : ''}.`);
  const ack = { order_id: order.id, client_id: order.client_id, root: o.root, side: o.side, qty: o.qty, type: o.type, price: order.price, bracket: order.bracket || null };
  if (o.type === 'market') {
    const price = o.side === 'buy' ? ref + spec.tick : ref - spec.tick;
    const fill = fillOrder(state, order, price, now, `latest delayed ${o.root} price ${ref} from the ${reading.bar_time} bar, plus one tick of slippage`);
    return { ok: true, order, fill, receipt: receipt('place_order', 'success', { ...ack, order_status: 'filled', fill_id: fill.id, fill_price: price, feed: 'DELAYED', price_time: reading.bar_time }, now), text: `Paper order ${order.id} filled, sir: ${o.side} ${o.qty} ${o.root} at ${price}, from the latest delayed price ${ref} plus one tick of slippage.${order.bracket ? ` Its ${[order.bracket.stop_loss != null ? `stop loss ${order.bracket.stop_loss}` : '', order.bracket.take_profit != null ? `take profit ${order.bracket.take_profit}` : ''].filter(Boolean).join(' and ')} ${order.bracket.stop_loss != null && order.bracket.take_profit != null ? 'are' : 'is'} working.` : ''} Simulated on CHE's paper account with delayed prices; no broker, no money.` };
  }
  return { ok: true, order, receipt: receipt('place_order', 'accepted', { ...ack, order_status: 'working' }, now), text: `Paper order ${order.id} accepted and working, sir: ${o.side} ${o.qty} ${o.root} ${o.type} at ${o.price}. It fills when a delayed bar after now reaches that price. Simulated; no broker, no money.` };
}

/** Cancel one working order (and, for an unfilled bracket entry, nothing else exists yet). */
export function cancelOrder(state, id, now = Date.now()) {
  const order = state.orders.find((o) => o.id === id || (o.client_id && o.client_id === id));
  if (!order) return { ok: false, receipt: receipt('cancel_order', 'failure', { order_id: id, reason: 'no such order' }, now), text: `There is no paper order ${id}, sir. Nothing was cancelled.` };
  if (order.status !== 'working') return { ok: false, order, receipt: receipt('cancel_order', 'failure', { order_id: order.id, reason: `order is ${order.status}` }, now), text: `Paper order ${order.id} is ${order.status}, so there is nothing to cancel, sir.` };
  Object.assign(order, { status: 'cancelled', cancelled_at: iso(now), cancel_reason: 'cancelled by the owner' });
  note(state, now, `${order.id} cancelled by the owner.`);
  return { ok: true, order, receipt: receipt('cancel_order', 'success', { order_id: order.id }, now), text: `Paper order ${order.id} cancelled, sir: ${order.side} ${order.qty} ${order.root} ${order.type}${order.price ? ` ${order.price}` : ''}.` };
}

/**
 * Flatten: cancel every working order and close every position (one root, or all). Paper only, so it closes even on a
 * stale price, and says how old that price is. A root with no price at all keeps its position and says so.
 */
export function flatten(state, readings = {}, { root = null } = {}, now = Date.now()) {
  const roots = root ? [root] : Object.keys(ROOTS);
  const cancelled = [];
  for (const o of state.orders) if (o.status === 'working' && roots.includes(o.root)) { Object.assign(o, { status: 'cancelled', cancelled_at: iso(now), cancel_reason: 'flatten' }); cancelled.push(o.id); }
  const closed = [];
  const stuck = [];
  for (const r of roots) {
    const qty = state.positions[r]?.qty || 0;
    if (!qty) continue;
    // A feed that just stopped answering falls back to its last kept price (marked stale).
    const reading = readings[r]?.price != null ? readings[r] : (state.feeds?.[r]?.price != null ? { ...state.feeds[r], fresh: false } : {});
    const ref = reading.price ?? null;
    if (ref == null) { stuck.push(r); continue; }
    const spec = ROOTS[r];
    const side = qty > 0 ? 'sell' : 'buy';
    const order = newOrder(state, { root: r, side, qty: Math.abs(qty), type: 'market', role: 'flatten' }, now);
    state.orders.push(order);
    const price = side === 'buy' ? ref + spec.tick : ref - spec.tick;
    const stale = reading.fresh ? '' : `, a stale price ${Math.round((reading.age_s || 0) / 60)} minutes old`;
    const fill = fillOrder(state, order, price, now, `flatten at the latest delayed ${r} price ${ref}${stale}, plus one tick of slippage`);
    closed.push({ root: r, qty, order_id: order.id, fill_id: fill.id, price, stale: !reading.fresh });
  }
  note(state, now, `Flatten: ${cancelled.length} order(s) cancelled, ${closed.length} position(s) closed${stuck.length ? `, ${stuck.join(', ')} left open with no price` : ''}.`);
  const status = stuck.length ? 'failure' : 'success';
  const text = `Flattened, sir: ${cancelled.length ? `cancelled ${cancelled.join(', ')}` : 'no working orders'}; ${closed.length ? closed.map((c) => `closed ${c.qty > 0 ? 'long' : 'short'} ${Math.abs(c.qty)} ${c.root} at ${c.price}${c.stale ? ' (stale delayed price)' : ''}`).join('; ') : 'no open positions'}.${stuck.length ? ` ${stuck.join(', ')} could not be closed: no price at all. Try again when the feed answers.` : ''} Paper only.`;
  return { ok: !stuck.length, cancelled, closed, stuck, receipt: receipt('flatten', status, { cancelled, closed, stuck }, now), text };
}

/**
 * Work resting orders against delayed bars that started after each order was placed, in time order. Returns the fills.
 * A bar is used once per root (state.processed[root] is the last bar time worked).
 */
export function workOrders(state, root, candles = [], now = Date.now()) {
  const spec = ROOTS[root];
  const fills = [];
  const after = Date.parse(state.processed?.[root] || 0) || 0;
  for (const bar of candles) {
    const t = Date.parse(bar.t);
    if (!(t > after)) continue;
    const working = state.orders.filter((o) => o.root === root && o.status === 'working' && Date.parse(o.placed_at) <= t);
    // Stops before targets inside one bar: the worst case.
    working.sort((a, b) => (a.type === 'stop' ? 0 : 1) - (b.type === 'stop' ? 0 : 1));
    for (const o of working) {
      if (o.status !== 'working') continue;
      let price = null;
      if (o.type === 'limit') {
        if (o.side === 'buy' && bar.l <= o.price) price = Math.min(o.price, bar.o);
        if (o.side === 'sell' && bar.h >= o.price) price = Math.max(o.price, bar.o);
      } else if (o.type === 'stop') {
        if (o.side === 'buy' && bar.h >= o.price) price = Math.max(o.price, bar.o) + spec.tick;
        if (o.side === 'sell' && bar.l <= o.price) price = Math.min(o.price, bar.o) - spec.tick;
      }
      if (price != null) fills.push(fillOrder(state, o, price, t + 60_000, `${o.type} ${o.price} reached by the delayed ${bar.t} bar (open ${bar.o}, high ${bar.h}, low ${bar.l})${o.type === 'stop' ? ', plus one tick of slippage' : ''}`));
    }
    state.processed = { ...(state.processed || {}), [root]: bar.t };
  }
  return fills;
}

/** The account as the app and voice show it. */
export function accountView(state, readings = {}, now = Date.now()) {
  const open = openPnl(state, readings);
  return {
    simulator: SIMULATOR,
    account: state.account,
    mode: 'PAPER',
    money_at_risk: false,
    live_orders: 'off',
    cash: state.cash,
    realized: state.realized,
    commissions: state.commissions,
    open_pnl: open.total,
    equity: round2(state.cash + open.total),
    positions: open.rows,
    working: state.orders.filter((o) => o.status === 'working'),
    recent_orders: state.orders.slice(-20).reverse(),
    recent_fills: state.fills.slice(-20).reverse(),
    feeds: Object.fromEntries(Object.entries(readings).map(([r, x]) => [r, { status: x.status, source: x.source, contract: x.contract, price: x.price, bar_time: x.bar_time, age_s: x.age_s, fresh: x.fresh, session: x.session, error: x.error }])),
    limits: { daily_loss: DAILY_LOSS_LIMIT, max_contracts: Object.fromEntries(Object.entries(ROOTS).map(([r, s]) => [r, s.maxContracts])), today: todayLoss(state, now) },
    events: (state.events || []).slice(-10).reverse(),
  };
}
