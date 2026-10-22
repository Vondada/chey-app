import assert from 'node:assert/strict';
import test from 'node:test';
import { fundyouredgeDraft, fundyouredgeIntent, fundyouredgeReply, FYE_STATUS } from './fundyouredge.js';

test('a FundYourEdge account question gets the honest not-connected reply', () => {
  assert.deepEqual(fundyouredgeIntent('check my FundYourEdge account'), { kind: 'account' });
  assert.match(fundyouredgeReply('show my fye balance'), /FundYourEdge is not connected/);
  assert.equal(fundyouredgeIntent('what is the weather'), null);
});

test('a futures order with no order-capable broker is refused: nothing is placed', () => {
  assert.deepEqual(fundyouredgeIntent('buy one NQ'), { kind: 'order' });
  assert.deepEqual(fundyouredgeIntent('place an MNQ trade'), { kind: 'order' });
  assert.match(fundyouredgeReply('place an MNQ trade'), /Nothing was placed/);
});

test('preparing a draft is not placing an order: the same words that place are refused, prepare drafts', () => {
  assert.deepEqual(fundyouredgeIntent('prepare an MNQ trade'), { kind: 'draft', account: null });
  assert.deepEqual(fundyouredgeIntent('Prepare a FundYourEdge MNQ long draft'), { kind: 'draft', account: 'FundYourEdge (Rithmic)' });
  assert.deepEqual(fundyouredgeIntent('Prepare then place a FundYourEdge MNQ order'), { kind: 'order' });
  assert.deepEqual(fundyouredgeIntent('Preview a FundYourEdge trade'), { kind: 'draft', account: 'FundYourEdge (Rithmic)' });
});

test('a draft is labelled not submitted, and every unverified price, limit and balance reads unknown', () => {
  const d = fundyouredgeDraft('Prepare a FundYourEdge MNQ long 2 entry 21450 stop 21420 target 21510');
  assert.equal(d.status, FYE_STATUS);
  assert.equal(FYE_STATUS, 'NOT SUBMITTED — NO BROKER CONNECTION.');
  const row = (label) => d.rows.find((r) => r.label === label).value;
  assert.equal(row('Direction'), 'long');
  assert.equal(row('Contract quantity'), '2');
  assert.equal(row('Risk / reward'), '1 : 2.00');
  assert.equal(row('Estimated dollar risk'), '$120');
  assert.equal(row('Account balance and buying power'), 'unknown');
  assert.deepEqual(d.warnings, []);
  assert.match(d.copy_text, /Entry: 21450/);
  assert.match(d.copy_text, /NOT SUBMITTED/);
});

test('a draft with no owner numbers invents none: entry, levels, quantity and dollar risk are unknown', () => {
  const d = fundyouredgeDraft('Prepare an MNQ trade');
  const row = (label) => d.rows.find((r) => r.label === label).value;
  assert.equal(row('Entry'), 'unknown');
  assert.equal(row('Stop-loss'), 'unknown');
  assert.equal(row('Contract quantity'), 'unknown');
  assert.equal(row('Risk / reward'), 'unknown');
  assert.equal(row('Estimated dollar risk'), 'unknown');
  assert.ok(d.missing.includes('entry') && d.missing.includes('quantity'));
});

test('a stop and target on the wrong side of the entry is flagged, not drafted as a good trade', () => {
  const d = fundyouredgeDraft('Prepare an MNQ long 1 entry 21450 stop 21500 target 21400');
  assert.equal(d.warnings.length, 1);
  assert.match(d.warnings[0], /wrong sides/);
});

test('a draft never uses a Tradovate or NinjaTrader order connection to send anything, and the order path stays refused', () => {
  assert.equal(fundyouredgeIntent('Prepare a FundYourEdge MNQ long', { orderBrokerReady: true })?.kind, 'draft');
  assert.deepEqual(fundyouredgeIntent('place a FundYourEdge MNQ order', { orderBrokerReady: true }), { kind: 'order' });
});

test('with an order-capable broker connected, a generic futures order is left to that broker desk', () => {
  assert.equal(fundyouredgeIntent('prepare an MNQ trade', { orderBrokerReady: true }), null);
  assert.equal(fundyouredgeReply('buy one NQ', { orderBrokerReady: true }), null);
});

test('a FundYourEdge order is refused even when another broker is connected', () => {
  assert.deepEqual(fundyouredgeIntent('place an MNQ order on FundYourEdge', { orderBrokerReady: true }), { kind: 'order' });
});

test('comprehension audit: a paper trade goes to the paper journal; a live order or a close still gets the refusal', () => {
  assert.equal(fundyouredgeIntent('Place a paper trade for 1 MNQ long.'), null);
  assert.equal(fundyouredgeIntent('Place a paper trade, not live.'), null);
  assert.deepEqual(fundyouredgeIntent('Place a live MNQ order, not paper'), { kind: 'order' });
  assert.deepEqual(fundyouredgeIntent('place an MNQ order'), { kind: 'order' });
  assert.deepEqual(fundyouredgeIntent('Close my MNQ position.'), { kind: 'order' });
});
