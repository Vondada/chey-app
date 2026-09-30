import assert from 'node:assert/strict';
import test from 'node:test';
import {
  approveProposal, assertStripeCallAllowed, formEncode, proposeProduct, rejectProposal, salesSummary, storeStatus, stripeConfigured, stripeMissingSecrets, stripeMode, validateProposal,
} from './stripe_store.js';

test('stripe mode reads the key type without exposing it', () => {
  assert.equal(stripeMode({}), 'not_connected');
  assert.equal(stripeMode({ STRIPE_SECRET_KEY: 'rk_test_abc' }), 'test');
  assert.equal(stripeMode({ STRIPE_SECRET_KEY: 'rk_live_abc' }), 'live');
  const status = storeStatus({ STRIPE_SECRET_KEY: 'rk_test_abc' }, {});
  assert.equal(JSON.stringify(status).includes('rk_test'), false);
  assert.equal(status.connected, true);
  assert.deepEqual(status.missing_secrets, ['STRIPE_PUBLISHABLE_KEY', 'STRIPE_WEBHOOK_SECRET']);
  assert.equal(status.publishable_configured, false);
  assert.equal(status.webhook_configured, false);
  assert.match(status.inbound_webhook, /\/api\/stripe\/webhook$/);
});

test('missing secrets and publishable pk_ surface without leaking sk_/whsec_', () => {
  assert.equal(stripeConfigured({}), false);
  assert.deepEqual(stripeMissingSecrets({}), [
    'STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'STRIPE_WEBHOOK_SECRET',
  ]);
  const env = {
    STRIPE_SECRET_KEY: 'sk_test_secret_never_echo',
    STRIPE_PUBLISHABLE_KEY: 'pk_test_public_ok',
    STRIPE_WEBHOOK_SECRET: 'whsec_never_echo',
  };
  assert.equal(stripeConfigured(env), true);
  assert.deepEqual(stripeMissingSecrets(env), []);
  const status = storeStatus(env, {});
  assert.equal(status.publishable_key, 'pk_test_public_ok');
  assert.equal(status.publishable_configured, true);
  assert.equal(status.webhook_configured, true);
  const blob = JSON.stringify(status);
  assert.equal(blob.includes('sk_test_secret_never_echo'), false);
  assert.equal(blob.includes('whsec_never_echo'), false);
});

test('form encoding handles nested Stripe params', () => {
  assert.equal(
    formEncode({ line_items: [{ price: 'price_1', quantity: 1 }], metadata: { a: 'b c' } }),
    'line_items%5B0%5D%5Bprice%5D=price_1&line_items%5B0%5D%5Bquantity%5D=1&metadata%5Ba%5D=b%20c',
  );
});

test('proposals are validated and never touch Stripe until approved', () => {
  assert.ok(validateProposal({ name: 'X', price_usd: 5 }).error);
  assert.ok(validateProposal({ name: 'Guide', price_usd: 0.1 }).error);
  const data = {};
  const made = proposeProduct(data, { name: 'Budget Template', price_usd: 9.99 });
  assert.equal(made.status, 200);
  assert.equal(made.proposal.unit_amount, 999);
  assert.equal(made.proposal.status, 'pending');
  assert.equal(rejectProposal(data, made.proposal.id).proposal.status, 'rejected');
  assert.equal(rejectProposal(data, made.proposal.id).status, 409);
});

test('approval creates product + payment link with receipts and idempotency', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/products')) return new Response(JSON.stringify({ id: 'prod_1', default_price: 'price_1' }));
    if (url.endsWith('/payment_links')) return new Response(JSON.stringify({ id: 'plink_1', url: 'https://buy.stripe.com/test_1' }));
    return new Response('{}', { status: 404 });
  };
  const env = { STRIPE_SECRET_KEY: 'rk_test_abc' };
  const data = {};
  const { proposal } = proposeProduct(data, { name: 'Intro Class', kind: 'class', price_usd: 25 });
  assert.equal((await approveProposal(env, data, proposal.id, fetcher)).status, 400);
  const result = await approveProposal(env, data, proposal.id, fetcher, { confirmed: true });
  assert.equal(result.status, 200);
  assert.equal(result.proposal.receipt.payment_link_url, 'https://buy.stripe.com/test_1');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers['Idempotency-Key'], `che-product-${proposal.id}`);
  assert.match(calls[0].init.body, /unit_amount%5D=2500/);
  // Approving again does not create a second product.
  await approveProposal(env, data, proposal.id, fetcher, { confirmed: true });
  assert.equal(calls.length, 2);
});

test('stripe errors are reported, not hidden as success', async () => {
  const fetcher = async () => new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 });
  const data = {};
  const { proposal } = proposeProduct(data, { name: 'Guide', price_usd: 5 });
  const result = await approveProposal({ STRIPE_SECRET_KEY: 'rk_test_x' }, data, proposal.id, fetcher, { confirmed: true });
  assert.equal(result.status, 502);
  assert.match(result.detail, /Invalid API key/);
  assert.equal(data.stripe_proposals[0].status, 'pending');
  assert.equal((await approveProposal({}, data, proposal.id, fetcher)).status, 503);
});

test('sales come straight from Stripe charges and balance', async () => {
  const fetcher = async (url) => {
    if (url.includes('/charges')) {
      return new Response(JSON.stringify({ data: [
        { id: 'ch_1', paid: true, status: 'succeeded', amount: 999, amount_refunded: 0, currency: 'usd', created: 1_790_000_000 },
        { id: 'ch_2', paid: false, status: 'failed', amount: 500, currency: 'usd', created: 1_790_000_000 },
      ] }));
    }
    return new Response(JSON.stringify({ available: [{ amount: 900, currency: 'usd' }], pending: [{ amount: 99, currency: 'usd' }] }));
  };
  const result = await salesSummary({ STRIPE_SECRET_KEY: 'rk_test_x' }, fetcher);
  assert.equal(result.status, 200);
  assert.equal(result.sales.length, 1);
  assert.equal(result.recent_total_cents, 999);
  assert.equal(result.balance.available_cents, 900);
});

test('Stripe money-out paths are blocked at the helper', () => {
  assert.throws(() => assertStripeCallAllowed('POST', '/refunds'), /blocked/);
  assert.throws(() => assertStripeCallAllowed('POST', '/charges'), /blocked/);
  assert.throws(() => assertStripeCallAllowed('POST', '/transfers'), /blocked/);
  assert.throws(() => assertStripeCallAllowed('POST', '/payouts'), /blocked/);
  assert.doesNotThrow(() => assertStripeCallAllowed('POST', '/payment_links'));
  assert.doesNotThrow(() => assertStripeCallAllowed('GET', '/charges'));
});
