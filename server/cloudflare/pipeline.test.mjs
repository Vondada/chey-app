import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addLead, approveProposal, checkPaid, createPaymentLink, draftProposal, markStage, parseProposalDraft, pipelineSummary,
} from './pipeline.js';

test('leads need a real client and need', () => {
  const data = {};
  assert.equal(addLead(data, { client_name: 'A', need: 'site' }).status, 400);
  const { deal } = addLead(data, { client_name: 'Joe’s Tacos', need: 'A one-page website with menu', contact: 'joe@example.com' });
  assert.equal(deal.stage, 'lead');
  assert.equal(pipelineSummary(data).counts.lead, 1);
});

test('draft stays a draft until the owner approves a price', async () => {
  const data = {};
  const { deal } = addLead(data, { client_name: 'Joe’s Tacos', need: 'A one-page website with menu' });
  const env = { AI: { run: async () => ({ response: '{"proposal_text":"I will build a one-page site with your menu and contact info. Estimated 1 week.","price_usd":350,"price_reasoning":"suggestion"}' }) } };
  const drafted = await draftProposal(env, deal, 'm');
  assert.equal(drafted.deal.stage, 'proposal');
  assert.equal(drafted.deal.price_usd, 350);
  assert.equal(markStage(deal, 'building').status, 409);
  assert.equal(approveProposal(deal, { price_usd: 0 }).status, 400);
  assert.equal(approveProposal(deal, { price_usd: 400 }).deal.stage, 'approved');
  assert.equal(markStage(deal, 'building').deal.stage, 'building');
  assert.equal(markStage(deal, 'review').deal.stage, 'review');
});

test('draft failures are reported honestly', async () => {
  const data = {};
  const { deal } = addLead(data, { client_name: 'Shop', need: 'An inventory app' });
  const result = await draftProposal({ AI: { run: async () => { throw new Error('All AI engines failed'); } } }, deal, 'm');
  assert.equal(result.status, 503);
  assert.equal(deal.stage, 'lead');
  assert.equal(parseProposalDraft('plain text').price_usd, null);
});

test('payment link only after review, paid only when Stripe says so', async () => {
  const data = {};
  const { deal } = addLead(data, { client_name: 'Shop', need: 'An inventory app' });
  deal.stage = 'approved'; deal.price_usd = 500; deal.proposal_text = 'x'.repeat(30);
  const env = { STRIPE_SECRET_KEY: 'rk_test_x' };
  let paid = false;
  const fetcher = async (url) => {
    if (url.endsWith('/products')) return new Response(JSON.stringify({ id: 'prod_1', default_price: 'price_1' }));
    if (url.endsWith('/payment_links')) return new Response(JSON.stringify({ id: 'plink_9', url: 'https://buy.stripe.com/test_9' }));
    if (url.includes('/checkout/sessions')) {
      assert.match(url, /payment_link=plink_9/);
      return new Response(JSON.stringify({ data: paid ? [{ id: 'cs_1', payment_status: 'paid', amount_total: 50000 }] : [] }));
    }
    return new Response('{}', { status: 404 });
  };
  assert.equal((await createPaymentLink(env, deal, fetcher)).status, 409);
  deal.stage = 'review';
  assert.equal((await createPaymentLink(env, deal, fetcher)).status, 400);
  const linked = await createPaymentLink(env, deal, fetcher, { confirmed: true });
  assert.equal(linked.deal.stage, 'invoiced');
  assert.equal(linked.deal.payment.url, 'https://buy.stripe.com/test_9');
  assert.equal((await checkPaid(env, deal, fetcher)).paid, false);
  assert.equal(deal.stage, 'invoiced');
  paid = true;
  assert.equal((await checkPaid(env, deal, fetcher)).paid, true);
  assert.equal(deal.stage, 'paid');
});
