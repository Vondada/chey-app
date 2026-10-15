import assert from 'node:assert/strict';
import test from 'node:test';
import { fundyouredgeIntent, fundyouredgeReply } from './fundyouredge.js';

test('a FundYourEdge account question gets the honest not-connected reply', () => {
  assert.deepEqual(fundyouredgeIntent('check my FundYourEdge account'), { kind: 'account' });
  assert.match(fundyouredgeReply('show my fye balance'), /FundYourEdge is not connected/);
  assert.equal(fundyouredgeIntent('what is the weather'), null);
});

test('a futures order with no order-capable broker is refused: nothing is prepared or placed', () => {
  assert.deepEqual(fundyouredgeIntent('prepare an MNQ trade'), { kind: 'order' });
  assert.deepEqual(fundyouredgeIntent('buy one NQ'), { kind: 'order' });
  assert.match(fundyouredgeReply('prepare an MNQ trade'), /Nothing was prepared or placed/);
});

test('with an order-capable broker connected, a generic futures order is left to that broker desk', () => {
  assert.equal(fundyouredgeIntent('prepare an MNQ trade', { orderBrokerReady: true }), null);
  assert.equal(fundyouredgeReply('buy one NQ', { orderBrokerReady: true }), null);
});

test('a FundYourEdge order is refused even when another broker is connected', () => {
  assert.deepEqual(fundyouredgeIntent('place an MNQ order on FundYourEdge', { orderBrokerReady: true }), { kind: 'order' });
});
