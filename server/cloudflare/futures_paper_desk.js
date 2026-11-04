// The futures paper simulator's desk: delayed prices in, orders worked, the owner's API and chat (futures_paper.js holds
// the rules). A certification probe turn trades a separate test account, never the owner's.
import { loadIntraday } from './market_feed.js';
import { LIVE_TRADING_OFF } from './trading_environments.js';
import {
  accountView, cancelOrder, feedReading, flatten, loadState, placeOrder, reconcile, ROOTS, saveState, STATE_KEY, SIMULATOR, workOrders,
} from './futures_paper.js';

export const PROBE_STATE_KEY = `${STATE_KEY}:probe`;
const stateKey = (probe) => (probe ? PROBE_STATE_KEY : STATE_KEY);
// One read-modify-write at a time per account (Codex review on #925): a request that waits on prices must not lose an
// order, cancel or fill saved by another request or the alarm meanwhile. All requests reach one Durable Object.
const locks = new Map();
export function locked(key, fn) {
  const prior = locks.get(key) || Promise.resolve();
  const run = prior.catch(() => null).then(fn);
  const tail = run.catch(() => null);
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}
const keyed = (storage, key) => ({ get: (k) => storage.get(k === STATE_KEY ? key : k), put: (k, v) => storage.put(k === STATE_KEY ? key : k, v) });

/** Delayed readings for [roots], each worked against its resting orders; the state keeps each feed's last reading. */
export async function syncFeeds(state, roots, { fetcher = fetch, now = Date.now(), load = loadIntraday } = {}) {
  const readings = {};
  await Promise.all(roots.map(async (root) => {
    const intraday = await load(root, { fetcher, now, range: '1d', interval: '1m' }).catch((error) => ({ status: 'UNAVAILABLE', error: String(error?.message || error) }));
    const reading = feedReading(root, intraday, now);
    readings[root] = reading;
    if (reading.candles.length) workOrders(state, root, reading.candles, now);
    const { candles, ...kept } = reading;
    // A feed that stops answering keeps its last price, marked stale, so flatten can still close on paper.
    state.feeds = { ...(state.feeds || {}), [root]: reading.price != null ? kept : { ...(state.feeds?.[root] || {}), status: 'UNAVAILABLE', fresh: false, error: kept.error, checked_at: kept.checked_at } };
  }));
  return readings;
}

/** The roots that need prices now: the asked one, and any with a working order or an open position. */
function activeRoots(state, also = []) {
  const set = new Set(also.filter((r) => ROOTS[r]));
  for (const o of state.orders) if (o.status === 'working') set.add(o.root);
  for (const [r, p] of Object.entries(state.positions || {})) if (p.qty) set.add(r);
  return [...set];
}

/** The alarm's pass: work resting orders against new delayed bars. True while anything is working or open. */
export async function futuresPaperTick(storage, opts = {}) {
  let busy = false;
  for (const probe of [false, true]) {
    busy = (await locked(stateKey(probe), async () => {
      const store = keyed(storage, stateKey(probe));
      const state = await loadState(store);
      const roots = activeRoots(state);
      if (!roots.length) return false;
      await syncFeeds(state, roots, opts);
      await saveState(store, state);
      return activeRoots(state).length > 0;
    })) || busy;
  }
  return busy;
}

/** True when either account has a working order or an open position (the alarm wakes every minute then). */
export async function futuresPaperBusy(storage) {
  for (const probe of [false, true]) {
    const state = await loadState(keyed(storage, stateKey(probe)));
    if (activeRoots(state).length) return true;
  }
  return false;
}

function withState(storage, probe, fn) {
  return locked(stateKey(probe), async () => {
    const store = keyed(storage, stateKey(probe));
    const state = await loadState(store);
    const out = await fn(state);
    await saveState(store, state);
    return out;
  });
}

/** The app's routes under /api/futures/paper. Returns { status, body } or null for another path. */
export async function futuresPaperApi(path, method, body = {}, storage, { query = new URLSearchParams(), probe = false, ...opts } = {}) {
  if (!path.startsWith('/api/futures/paper')) return null;
  const now = opts.now || Date.now();
  const sub = path.slice('/api/futures/paper'.length) || '/';
  if (method === 'GET' && (sub === '/' || sub === '')) {
    return withState(storage, probe, async (state) => {
      const readings = await syncFeeds(state, activeRoots(state, [String(query.get('root') || 'MNQ').toUpperCase()]), { ...opts, now });
      return { status: 200, body: accountView(state, readings, now) };
    });
  }
  if (method === 'GET' && sub === '/reconcile') return withState(storage, probe, async (state) => ({ status: 200, body: reconcile(state, now) }));
  if (method === 'POST' && sub === '/order') {
    return withState(storage, probe, async (state) => {
      const root = String(body.root || '').toUpperCase();
      const readings = ROOTS[root] ? await syncFeeds(state, activeRoots(state, [root]), { ...opts, now }) : {};
      const out = placeOrder(state, body, readings[root], now);
      return { status: out.ok ? 200 : 422, body: { ...out, account: accountView(state, readings, now) } };
    });
  }
  if (method === 'POST' && sub === '/cancel') {
    return withState(storage, probe, async (state) => {
      const out = cancelOrder(state, String(body.id || ''), now);
      return { status: out.ok ? 200 : 404, body: { ...out, account: accountView(state, {}, now) } };
    });
  }
  if (method === 'POST' && sub === '/flatten') {
    return withState(storage, probe, async (state) => {
      const root = body.root ? String(body.root).toUpperCase() : null;
      const readings = await syncFeeds(state, root ? [root] : activeRoots(state), { ...opts, now });
      const out = flatten(state, readings, { root }, now);
      return { status: 200, body: { ...out, account: accountView(state, readings, now) } };
    });
  }
  return { status: 404, body: { detail: 'Unknown futures paper route.' } };
}

// ─── Chat ───

const VOCATIVE = /^(?:(?:hey|ok|okay)\s+)?(?:che|chey|chay|jay)[,:\s]+/i;
const ROOT = '(mnq|nq|mes|es)';
const NUM = '(\\d{1,6}(?:\\.\\d{1,2})?)';
const LIVE = /\b(?:live|real\s+money|real\s+account|funded|for\s+real|with\s+real)\b/i;

/** What the owner asked of the futures paper desk, or null. */
export function futuresPaperIntent(message = '') {
  const raw = String(message || '').replace(/[’]/g, "'").replace(/,(?=\d{3}\b)/g, '').trim();
  const text = raw.replace(VOCATIVE, '').replace(/^please\s+/i, '').replace(/[.!?]+$/, '').trim();
  const t = text.toLowerCase();
  // A request naming a broker or platform is that route's (Alpaca refuses futures, Tradovate and FundYourEdge say
  // what they need); the simulator answers only for CHE's own paper account.
  if (/\b(?:alpaca|tradovate|ninja\s?trader|fund\s?your\s?edge|fye|rithmic|interactive\s+brokers|ibkr|tradesea|chart)\b/.test(t)) return null;
  const order = new RegExp(`^(?:paper\\s+)?(buy|sell|short|go long|go short)\\s+(?:(\\d{1,3})\\s+)?(?:contracts?\\s+(?:of\\s+)?)?${ROOT}\\b(.*)$`).exec(t);
  if (order) {
    if (LIVE.test(t)) return { action: 'live_refused' };
    const rest = order[4] || '';
    const side = /buy|long/.test(order[1]) ? 'buy' : 'sell';
    const stopLoss = new RegExp(`\\b(?:with\\s+(?:a\\s+)?stop(?:\\s+loss)?|stop\\s+loss|sl)\\s+(?:at\\s+|of\\s+)?${NUM}`).exec(rest);
    const takeProfit = new RegExp(`\\b(?:take\\s+profit|target|tp|profit\\s+target)\\s+(?:at\\s+|of\\s+)?${NUM}`).exec(rest);
    const entryRest = rest.replace(stopLoss?.[0] || '\u0000', ' ').replace(takeProfit?.[0] || '\u0000', ' ');
    const stopEntry = new RegExp(`\\b(?:on\\s+a\\s+)?stop\\s+(?:at\\s+)?${NUM}`).exec(entryRest);
    const limit = new RegExp(`\\b(?:limit\\s+(?:at\\s+)?|at\\s+)${NUM}`).exec(entryRest);
    const type = stopEntry ? 'stop' : limit && !/\bat\s+market\b/.test(entryRest) ? 'limit' : 'market';
    return {
      action: 'order', side, qty: order[2] ? Number(order[2]) : 1, root: order[3].toUpperCase(), type,
      price: type === 'stop' ? Number(stopEntry[1]) : type === 'limit' ? Number(limit[1]) : null,
      stop_loss: stopLoss ? Number(stopLoss[1]) : null, take_profit: takeProfit ? Number(takeProfit[1]) : null,
    };
  }
  const cancel = /^cancel\s+(?:paper\s+|futures\s+)*order\s+(o-\d{5})$/.exec(t) || /^cancel\s+(o-\d{5})$/.exec(t);
  if (cancel) return { action: 'cancel', id: cancel[1].toUpperCase() };
  const cancelAll = new RegExp(`^cancel\\s+(?:all\\s+)?(?:my\\s+)?(?:working\\s+|open\\s+)?(?:${ROOT}\\s+)?(?:paper\\s+|futures\\s+)+orders?$`).exec(t);
  // "Cancel my paper order" is the stock desk's (Alpaca); a futures cancel names futures or a futures market.
  if (cancelAll && (cancelAll[1] || /\bfutures\b/.test(t))) return { action: 'cancel_all', root: cancelAll[1] ? cancelAll[1].toUpperCase() : null };
  const flat = new RegExp(`^(?:emergency\\s+)?(?:flatten|close\\s+(?:out\\s+)?(?:all|everything|my\\s+(?:paper\\s+|futures\\s+)*positions?))(?:\\s+(?:everything|all|it\\s+all))?(?:\\s+(?:my\\s+)?${ROOT})?(?:\\s+(?:my\\s+)?(?:paper\\s+|futures\\s+)*(?:positions?|account))?(?:\\s+now)?$`).exec(t);
  if (flat) return LIVE.test(t) ? { action: 'live_refused' } : { action: 'flatten', root: flat[1] ? flat[1].toUpperCase() : null };
  if (/^reconcile\s+(?:my\s+)?(?:futures\s+)?paper(?:\s+account)?$/.test(t)) return { action: 'reconcile' };
  if (/^(?:(?:show|read|what(?:'s| is| are))\s+)?(?:me\s+)?(?:my\s+)?(?:futures\s+paper|paper\s+futures)\s+(?:account|positions?|p&l|pnl|orders?)\??$/.test(t)
    || /^(?:show|what are)\s+my\s+futures\s+positions\??$/.test(t)) return { action: 'status' };
  return null;
}

/** One chat turn for the futures paper desk: { text, meta } or null when the message is not for it. */
export async function futuresPaperChat(storage, message, { probe = false, wake = null, ...opts } = {}) {
  const ask = futuresPaperIntent(message);
  if (!ask) return null;
  const meta = (extra = {}) => ({ source: 'che_futures_paper', model_calls: 0, simulator: SIMULATOR, money_at_risk: false, ...extra });
  if (ask.action === 'live_refused') return { text: `${LIVE_TRADING_OFF} CHE trades futures only on her paper simulator with delayed prices for now.`, meta: meta({ ok: false, order_sent: false }) };
  const call = async (method, sub, body = {}) => (await futuresPaperApi(`/api/futures/paper${sub}`, method, body, storage, { probe, ...opts })).body;
  let text = '';
  let receipt = null;
  if (ask.action === 'order') {
    const out = await call('POST', '/order', ask);
    ({ text, receipt } = out);
  } else if (ask.action === 'cancel') {
    const out = await call('POST', '/cancel', { id: ask.id });
    ({ text, receipt } = out);
  } else if (ask.action === 'cancel_all') {
    const view = await call('GET', '/');
    const ids = view.working.filter((o) => !ask.root || o.root === ask.root).map((o) => o.id);
    const results = [];
    for (const id of ids) results.push(await call('POST', '/cancel', { id }));
    text = ids.length ? `Cancelled ${ids.length} paper order${ids.length === 1 ? '' : 's'}, sir: ${ids.join(', ')}.` : 'There are no working paper futures orders to cancel, sir.';
    receipt = { tool: 'che_futures_paper', operation: 'cancel_all', status: 'success', at: new Date().toISOString(), cancelled: ids };
  } else if (ask.action === 'flatten') {
    const out = await call('POST', '/flatten', { root: ask.root });
    ({ text, receipt } = out);
  } else if (ask.action === 'reconcile') {
    receipt = await call('GET', '/reconcile');
    text = receipt.status === 'success'
      ? `Reconciled, sir: every position, cash and P&L figure matches the fill ledger (${receipt.fills} fills, ${receipt.orders} orders). Cash ${receipt.cash}, realized ${receipt.realized}, commissions ${receipt.commissions}.`
      : `Reconciliation found differences, sir: ${receipt.diffs.join('; ')}.`;
  } else {
    const view = await call('GET', '/');
    const pos = view.positions.length ? view.positions.map((p) => `${p.qty > 0 ? 'long' : 'short'} ${Math.abs(p.qty)} ${p.root} at ${p.avg}, open P&L ${p.open_pnl ?? 'unknown'}`).join('; ') : 'no open positions';
    text = `Your futures paper account, sir: ${pos}; ${view.working.length} working order${view.working.length === 1 ? '' : 's'}; cash ${view.cash}, realized ${view.realized}, equity ${view.equity}. Simulated with delayed prices; live orders are off.`;
    receipt = { tool: 'che_futures_paper', operation: 'read_account', status: 'success', at: new Date().toISOString(), positions: view.positions, working: view.working.map((o) => o.id) };
  }
  if (wake) await Promise.resolve(wake()).catch(() => null);
  return { text, meta: meta({ ok: receipt?.status !== 'rejected' && receipt?.status !== 'failure', execution_receipt: receipt, open_view: 'futures_paper' }) };
}
