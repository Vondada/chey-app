// NinjaTrader / Tradovate connection (NinjaTrader's web and mobile platform
// runs on Tradovate). The owner signs in on Tradovate's own page (OAuth), so
// his password never reaches CHE, the Worker, an AI provider or a log; CHE
// only keeps the short-lived access token Tradovate hands back.
//
// Worker secrets: OAuth application credentials that Tradovate issues for a
// registered app (not an ordinary API key's cid/sec, which only works with
// the password flow CHE must never use), registered with the redirect URI
// <worker origin>/broker/tradovate/callback:
//   CHE_TRADOVATE_OAUTH_CLIENT_ID
//   CHE_TRADOVATE_OAUTH_CLIENT_SECRET
// Optional: CHE_TRADOVATE_OAUTH_TOKEN_URL if Tradovate moves its token endpoint.
//
// "sim" uses Tradovate's demo environment (the simulated account), "live"
// the real one. Same login, same token, different server.

const AUTH_KEY = 'tradovate_auth';
const STATE_KEY = 'tradovate_oauth_state';
const BASE = { sim: 'https://demo.tradovateapi.com/v1', live: 'https://live.tradovateapi.com/v1' };
const DEFAULT_TOKEN_URL = 'https://live.tradovateapi.com/auth/oauthtoken';
export const CALLBACK_PATH = '/broker/tradovate/callback';

export function tradovateConfigured(env) {
  return Boolean(env?.CHE_TRADOVATE_OAUTH_CLIENT_ID && env?.CHE_TRADOVATE_OAUTH_CLIENT_SECRET);
}

/** One-time sign-in link (valid 10 minutes, single use). */
export async function connectLink(storage, env, origin, now = Date.now()) {
  if (!tradovateConfigured(env)) return { error: 'not_configured' };
  const state = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');
  await storage.put(STATE_KEY, { state, expires_at: now + 10 * 60_000 });
  const redirect = `${origin}${CALLBACK_PATH}`;
  const url = `https://trader.tradovate.com/oauth?response_type=code&client_id=${encodeURIComponent(env.CHE_TRADOVATE_OAUTH_CLIENT_ID)}&redirect_uri=${encodeURIComponent(redirect)}&state=${state}`;
  return { url };
}

/** Tradovate redirects back here after the owner signs in. */
export async function handleCallback(storage, env, requestUrl, fetcher = fetch, now = Date.now()) {
  const url = new URL(requestUrl);
  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  const saved = await storage.get(STATE_KEY);
  // A forged or stale callback changes nothing (so it cannot cancel the
  // owner's real sign-in); a matching one is consumed before any network call.
  if (!saved || !state || saved.state !== state || now > saved.expires_at || !code) {
    return { ok: false, message: 'This sign-in link is invalid or expired. Ask CHE to connect NinjaTrader again.' };
  }
  await storage.delete?.(STATE_KEY);
  try {
    const response = await fetcher(env.CHE_TRADOVATE_OAUTH_TOKEN_URL || DEFAULT_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${url.origin}${CALLBACK_PATH}`,
        client_id: env.CHE_TRADOVATE_OAUTH_CLIENT_ID,
        client_secret: env.CHE_TRADOVATE_OAUTH_CLIENT_SECRET,
      }).toString(),
    });
    const body = await response.json().catch(() => ({}));
    const token = body.access_token || body.accessToken;
    if (!response.ok || !token) return { ok: false, message: `Tradovate did not accept the sign-in (${body.error_description || body.errorText || response.status}).` };
    const seconds = Number(body.expires_in) || 80 * 60;
    await storage.put(AUTH_KEY, { access_token: token, expires_at: now + seconds * 1000, connected_at: new Date(now).toISOString() });
    return { ok: true, message: 'NinjaTrader is connected to CHE. You can close this page and go back to CHE.' };
  } catch (error) {
    return { ok: false, message: `Tradovate could not be reached: ${String(error?.message || error).slice(0, 120)}` };
  }
}

export async function connection(storage, now = Date.now()) {
  const auth = await storage.get(AUTH_KEY);
  if (!auth?.access_token) return { connected: false };
  return { connected: now < auth.expires_at, expired: now >= auth.expires_at, expires_at: auth.expires_at };
}

/** Keeps the token alive (Tradovate tokens last about 80-90 minutes). */
export async function renewToken(storage, fetcher = fetch, now = Date.now()) {
  const auth = await storage.get(AUTH_KEY);
  if (!auth?.access_token || now >= auth.expires_at || auth.expires_at - now > 45 * 60_000) return auth || null;
  try {
    const response = await fetcher(`${BASE.live}/auth/renewaccesstoken`, { headers: { Authorization: `Bearer ${auth.access_token}`, Accept: 'application/json' } });
    const body = await response.json().catch(() => ({}));
    if (response.ok && body.accessToken) {
      const next = { ...auth, access_token: body.accessToken, expires_at: Date.parse(body.expirationTime) || now + 80 * 60_000 };
      await storage.put(AUTH_KEY, next);
      return next;
    }
  } catch (_) { /* keep the current token until it expires */ }
  return auth;
}

async function api(storage, mode, path, { method = 'GET', body, fetcher = fetch, now = Date.now() } = {}) {
  const auth = await storage.get(AUTH_KEY);
  if (!auth?.access_token || now >= auth.expires_at) return { error: 'NinjaTrader is not connected (or the sign-in expired). Say "connect NinjaTrader" to sign in again.' };
  const response = await fetcher(`${BASE[mode]}${path}`, {
    method,
    headers: { Authorization: `Bearer ${auth.access_token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) return { error: `Tradovate answered ${response.status}${data?.errorText ? `: ${data.errorText}` : ''}.` };
  return { data };
}

/** Active accounts on the owner's login in this mode, in Tradovate's order. */
export async function listAccounts(storage, mode, opts = {}) {
  const res = await api(storage, mode, '/account/list', opts);
  if (res.error) return res;
  return { accounts: (Array.isArray(res.data) ? res.data : []).filter((a) => a && a.active !== false).map((a) => ({ id: a.id, name: String(a.name) })) };
}

/**
 * The account to trade in this mode. Live money only ever goes to the
 * account the owner named; a simulated order may use the only/first one.
 */
export async function pickAccount(storage, mode, preferred = '', opts = {}) {
  const listed = await listAccounts(storage, mode, opts);
  if (listed.error) return listed;
  const want = String(preferred || '').toLowerCase();
  if (want) {
    const named = listed.accounts.find((a) => a.name.toLowerCase() === want);
    return named ? { account: named } : { error: `The account ${preferred} is not active on your NinjaTrader login.` };
  }
  if (mode === 'live') return { error: 'Choose which live account to trade first: say "list my trading accounts".' };
  return listed.accounts[0] ? { account: listed.accounts[0] } : { error: 'No active simulated account was found on your NinjaTrader login.' };
}

/** Front-month contract for a root like MES or MNQ (e.g. "MESZ6"). */
export async function frontContract(storage, mode, root, opts = {}) {
  const res = await api(storage, mode, `/contract/suggest?t=${encodeURIComponent(root)}&l=5`, opts);
  if (res.error) return res;
  const hit = (Array.isArray(res.data) ? res.data : []).find((c) => new RegExp(`^${root}[FGHJKMNQUVXZ]\\d{1,2}$`).test(String(c?.name)));
  return hit ? { symbol: hit.name } : { error: `Tradovate did not return a current ${root} contract.` };
}

const tick = (price) => Math.round(price * 4) / 4; // ES, MES, NQ, MNQ trade in 0.25 points

/**
 * A limit entry with its stop and target attached (Order Sends Order): the
 * entry only fills at the planned price or better, and the stop and target
 * go in the moment it fills.
 */
export async function placeBracket(storage, mode, order, opts = {}) {
  if (!BASE[mode]) return { error: 'Orders go to the simulated or the live account only.' };
  const { root, action = 'Buy', qty, entry, stop, target, account: preferred } = order;
  if (!(qty >= 1 && qty <= 10)) return { error: 'Order size must be 1 to 10 contracts.' };
  if (action !== 'Buy' || !(stop < entry && entry < target)) return { error: 'The stop must be below the entry and the target above it.' };
  const acct = await pickAccount(storage, mode, preferred, opts);
  if (acct.error) return acct;
  const contract = await frontContract(storage, mode, root, opts);
  if (contract.error) return contract;
  const body = {
    accountSpec: acct.account.name,
    accountId: acct.account.id,
    action: 'Buy',
    symbol: contract.symbol,
    orderQty: qty,
    orderType: 'Limit',
    price: tick(entry),
    timeInForce: 'Day',
    isAutomated: true,
    bracket1: { action: 'Sell', orderType: 'Limit', price: tick(target), timeInForce: 'GTC' },
    bracket2: { action: 'Sell', orderType: 'Stop', stopPrice: tick(stop), timeInForce: 'GTC' },
  };
  const res = await api(storage, mode, '/order/placeoso', { ...opts, method: 'POST', body });
  if (res.error) return res;
  // Tradovate reports an accepted order with failureReason "Success".
  const failed = res.data?.failureReason && res.data.failureReason !== 'Success';
  if (failed || !res.data?.orderId) {
    return { error: `Tradovate rejected the order${res.data?.failureText ? `: ${res.data.failureText}` : res.data?.failureReason ? ` (${res.data.failureReason})` : ''}.` };
  }
  return { ok: true, order_id: res.data.orderId, account: acct.account.name, symbol: contract.symbol, entry: body.price, stop: body.bracket2.stopPrice, target: body.bracket1.price, qty };
}

/** Cash balance and net liquidation value of the account in this mode. */
export async function accountBalance(storage, mode, preferred = '', opts = {}) {
  const acct = await pickAccount(storage, mode, preferred, opts);
  if (acct.error) return acct;
  const res = await api(storage, mode, '/cashBalance/getcashbalancesnapshot', { ...opts, method: 'POST', body: { accountId: acct.account.id } });
  if (res.error) return res;
  const n = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null);
  return { account: acct.account.name, cash: n(res.data?.totalCashValue), net_liq: n(res.data?.netLiq), open_pnl: n(res.data?.openPnL), realized_pnl: n(res.data?.realizedPnL) };
}
