import { test } from 'node:test';
import assert from 'node:assert/strict';
import { debate, proposesMoneyOrPublicPost } from './team_debate.js';

const linesFor = (out, agentId) => out.filter((l) => l.agentId === agentId);

test('every line has agentId, a valid stance and a reason', () => {
  const out = debate([
    { agentId: 'trading_analyst', idea: 'Backtest the opening range on Nasdaq futures' },
    { agentId: 'offers_scout', idea: 'Buy a cheaper label printer for the shop' },
  ]);
  assert.ok(out.length > 0);
  for (const l of out) {
    assert.deepEqual(Object.keys(l).sort(), ['agentId', 'reason', 'stance']);
    assert.ok(['support', 'challenge'].includes(l.stance), l.stance);
    assert.ok(typeof l.reason === 'string' && l.reason.length > 0);
  }
});

test('the Skeptic challenges every idea, money or not', () => {
  const ideas = [
    { agentId: 'content_strategist', idea: 'Draft a product explainer script' },
    { agentId: 'builder', idea: 'Add a voice label to the settings screen' },
    { agentId: 'trading_analyst', idea: 'Pay for a data feed' },
  ];
  const out = debate(ideas);
  const skeptic = linesFor(out, 'skeptic');
  assert.equal(skeptic.length, ideas.length);
  assert.ok(skeptic.every((l) => l.stance === 'challenge'));
});

test('the Finance Guard challenges every money or public-posting idea', () => {
  const money = [
    'Buy a domain for the shop site',
    'Subscribe to the signal service for $29 a month',
    'Transfer 200 dollars to the broker',
    'Trade the NQ open with 2 contracts',
    'Pay the supplier invoice',
  ];
  const publicPost = [
    'Publish the new ad video on YouTube',
    'Post the offer to the storefront feed',
    'Announce the launch publicly',
  ];
  for (const idea of [...money, ...publicPost]) {
    const out = debate([{ agentId: 'content_strategist', idea }]);
    const guard = linesFor(out, 'finance_guard');
    assert.equal(guard.length, 1, idea);
    assert.equal(guard[0].stance, 'challenge', idea);
  }
});

test('a non-money, non-public idea gets a support line from the Finance Guard', () => {
  const out = debate([{ agentId: 'builder', idea: 'Tidy the Office screen labels' }]);
  const guard = linesFor(out, 'finance_guard');
  assert.equal(guard.length, 1);
  assert.equal(guard[0].stance, 'support');
});

test('outbound ideas bring the Security Chief in as a hold, with no name', () => {
  const out = debate([{ agentId: 'offers_scout', idea: 'Order the cheapest scanner today' }]);
  const chief = linesFor(out, 'security_chief');
  assert.equal(chief.length, 1);
  assert.equal(chief[0].stance, 'challenge');
  assert.match(chief[0].reason, /^Hold: /);
});

test('output is deterministic: same input gives the same lines', () => {
  const ideas = [
    { agentId: 'trading_analyst', idea: 'Trade the Monday gap with a stop' },
    { agentId: 'content_strategist', idea: 'Post a teaser clip' },
  ];
  assert.deepEqual(debate(ideas), debate(ideas));
});

test('a guard that proposes an idea gets one line for itself, not two', () => {
  const out = debate([{ agentId: 'finance_guard', idea: 'Set a $300 monthly budget ceiling' }]);
  const guard = linesFor(out, 'finance_guard');
  assert.equal(guard.length, 1);
  assert.equal(guard[0].stance, 'challenge');
});

test('an empty list gives no lines', () => {
  assert.deepEqual(debate([]), []);
});

test('bad input is rejected', () => {
  assert.throws(() => debate('nope'), TypeError);
  assert.throws(() => debate([{ agentId: 'nobody', idea: 'x' }]), /unknown agentId/);
  assert.throws(() => debate([{ agentId: 'builder', idea: '   ' }]), TypeError);
  assert.throws(() => debate([null]), TypeError);
});

test('money and public detection', () => {
  assert.equal(proposesMoneyOrPublicPost('Pay the invoice'), true);
  assert.equal(proposesMoneyOrPublicPost('Spend $40 on ads'), true);
  assert.equal(proposesMoneyOrPublicPost('Publish the video'), true);
  assert.equal(proposesMoneyOrPublicPost('Refactor the router'), false);
});
