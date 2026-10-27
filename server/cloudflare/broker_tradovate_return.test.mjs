// NinjaTrader return to CHE and the separated status (owner, 2026-10-27): the callback points the owner back into the
// app through CHE's URL scheme, the market-data fact comes from Tradovate's own sign-in answer, and the card reports
// website login, brokerage authorization, accounts, market data and live orders as separate facts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CHE_RETURN_URL, callbackPage, connection, handleCallback } from './broker_tradovate.js';
import { tradingConnections } from './trading_connections.js';

const ENV = { CHE_TRADOVATE_OAUTH_CLIENT_ID: 'id', CHE_TRADOVATE_OAUTH_CLIENT_SECRET: 'secret' };
const NOW = Date.parse('2026-10-27T12:00:00Z');

function memStorage() {
  const m = new Map();
  return { m, get: async (k) => (m.has(k) ? structuredClone(m.get(k)) : undefined), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async (k) => m.delete(k) };
}

async function signIn(hasMarketData) {
  const s = memStorage();
  const { url } = await (await import('./broker_tradovate.js')).connectLink(s, ENV, 'https://che.example', NOW);
  const state = new URL(url).searchParams.get('state');
  const fetcher = async () => new Response(JSON.stringify({ accessToken: 't', expirationTime: new Date(NOW + 80 * 60_000).toISOString(), ...(hasMarketData === undefined ? {} : { hasMarketData }) }), { status: 200 });
  const done = await handleCallback(s, ENV, `https://che.example/broker/tradovate/callback?code=c&state=${state}`, fetcher, NOW);
  return { s, done };
}

test('a successful callback tells the owner to return to CHE through the app URL scheme', async () => {
  const { done } = await signIn(true);
  assert.equal(done.ok, true);
  assert.equal(done.return_url, 'che://broker/tradovate');
  assert.equal(CHE_RETURN_URL, 'che://broker/tradovate');
});

test('the callback page links back into CHE with the result, and a failed sign-in is a 400', async () => {
  const ok = callbackPage({ ok: true, message: 'NinjaTrader is connected to CHE.' });
  assert.equal(ok.status, 200);
  const html = await ok.text();
  assert.match(html, /href="che:\/\/broker\/tradovate\?result=connected"/);
  const bad = callbackPage({ ok: false, message: '<script>x</script> failed' });
  assert.equal(bad.status, 400);
  const badHtml = await bad.text();
  assert.match(badHtml, /result=failed/);
  assert.doesNotMatch(badHtml, /<script>/, 'the message is escaped');
});

test('the market-data fact is what Tradovate reported at sign-in, and unknown when it did not say', async () => {
  const yes = await signIn(true);
  assert.equal((await connection(yes.s, NOW)).market_data_allowed, true);
  const no = await signIn(false);
  assert.equal((await connection(no.s, NOW)).market_data_allowed, false);
  const silent = await signIn(undefined);
  assert.equal((await connection(silent.s, NOW)).market_data_allowed, null);
  assert.equal((await connection(memStorage(), NOW)).market_data_allowed, null);
});

test('the NinjaTrader card reports each fact separately and never treats a website sign-in as brokerage access', () => {
  const desk = { mode: 'sim', account: { sim: 'SIM-1', live: null }, risk_limits: {} };
  const card = tradingConnections({ paper: null, desk, tradovate: { configured: true, conn: { connected: true, market_data_allowed: false } } }).cards.find((c) => c.id === 'tradovate');
  assert.equal(card.state, 'signed_in');
  assert.equal(card.separate.brokerage_authorized, true);
  assert.deepEqual(card.separate.accounts, { sim: 'SIM-1', live: null });
  assert.equal(card.separate.market_data, 'not allowed');
  assert.match(card.separate.website_login, /grants CHE no brokerage access/);
  assert.match(card.separate.live_orders, /^disabled/);
  const unsigned = tradingConnections({ paper: null, desk, tradovate: { configured: true, conn: { connected: false } } }).cards.find((c) => c.id === 'tradovate');
  assert.equal(unsigned.separate.brokerage_authorized, false);
  assert.equal(unsigned.separate.market_data, 'unknown');
});
