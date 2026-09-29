import { applyStripeEvent } from './stripe_webhooks.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('webhook math', () => {
  let today = applyStripeEvent({}, { type: 'charge.succeeded', data: { object: { amount: 5000 } } });
  today = applyStripeEvent(today, { type: 'charge.refunded', data: { object: { amount_refunded: 1000 } } });
  assert.equal(today.charges_cents, 5000);
  assert.equal(today.refunds_cents, 1000);
  assert.equal(today.net_cents, 4000);
});
