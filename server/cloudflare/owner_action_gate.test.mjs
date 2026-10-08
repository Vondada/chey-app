import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyOwnerAction, classifyOwnerActions, gateOwnerAction, gateAppAccess, grantForKinds } from './owner_action_gate.js';

test('money verbs are classified as money', () => {
  assert.equal(classifyOwnerAction('buy the domain chey-test.com'), 'money');
  assert.equal(classifyOwnerAction('Please subscribe to the pro plan'), 'money');
  assert.equal(classifyOwnerAction('order more credits'), 'money');
});

test('delete and remove verbs are classified as delete', () => {
  assert.equal(classifyOwnerAction('delete my old learned skills'), 'delete');
  assert.equal(classifyOwnerAction('remove the old key'), 'delete');
  assert.equal(classifyOwnerAction('and then unpublish the website'), 'delete');
});

test('ordinary requests are not gated', () => {
  assert.equal(classifyOwnerAction('read my last note'), '');
  assert.equal(classifyOwnerAction('what is the capital of Australia'), '');
  assert.equal(classifyOwnerAction(''), '');
});

test('verbs anywhere in the request are gated (a false hold costs one yes)', () => {
  assert.equal(classifyOwnerAction('can you delete my notes'), 'delete');
  assert.equal(classifyOwnerAction('go ahead and delete the skills'), 'delete');
  assert.equal(classifyOwnerAction('pls delete it'), 'delete');
  assert.equal(classifyOwnerAction('"delete the note"'), 'delete');
  assert.equal(classifyOwnerAction('I want to pay the bill'), 'money');
  assert.equal(classifyOwnerAction('charge my card for the domain'), 'money');
  assert.equal(classifyOwnerAction('upgrade to the pro plan'), 'money');
  assert.equal(classifyOwnerAction('reset my learned skills'), 'delete');
  assert.equal(classifyOwnerAction('uninstall the app'), 'delete');
});

test('a mixed request lists every kind and needs a grant for each', () => {
  const mixed = 'buy the domain then delete the old key';
  assert.deepEqual(classifyOwnerActions(mixed), ['money', 'delete']);
  assert.equal(gateOwnerAction(mixed, { money: true }).allowed, false);
  assert.equal(gateOwnerAction(mixed, { money: true }).kind, 'delete');
  assert.equal(gateOwnerAction(mixed, { money: true, delete: true }).allowed, true);
  assert.deepEqual(grantForKinds(['money', 'delete']), { money: true, delete: true });
});

test('ordinary requests with no action verb are not gated', () => {
  assert.deepEqual(classifyOwnerActions('tell me about the weather'), []);
});

test('money and delete actions are held without an explicit yes', () => {
  const money = gateOwnerAction('buy the domain chey-test.com');
  assert.equal(money.allowed, false);
  assert.equal(money.kind, 'money');
  assert.match(money.ask, /spend or buy/);

  const del = gateOwnerAction('delete my old learned skills', {});
  assert.equal(del.allowed, false);
  assert.equal(del.kind, 'delete');
  assert.match(del.ask, /delete or remove/);
});

test('an explicit yes for that kind allows the action', () => {
  assert.equal(gateOwnerAction('delete my old learned skills', { delete: true }).allowed, true);
  // A yes for one kind does not allow the other.
  assert.equal(gateOwnerAction('buy the domain', { delete: true }).allowed, false);
});

test('ordinary requests pass without a grant', () => {
  assert.deepEqual(gateOwnerAction('read my last note'), { allowed: true, kind: '', kinds: [] });
});

test('apps are refused until the owner grants them', () => {
  const refused = gateAppAccess('Notes', []);
  assert.equal(refused.allowed, false);
  assert.match(refused.ask, /not given me permission to use notes/);
  assert.equal(gateAppAccess('Notes', ['notes']).allowed, true);
  assert.equal(gateAppAccess('', ['notes']).allowed, false);
});

test('a held request is released only by a plain yes', async () => {
  const { isOwnerYes } = await import('./owner_action_gate.js');
  assert.equal(isOwnerYes('yes'), true);
  assert.equal(isOwnerYes('Yes, go ahead.'), true);
  assert.equal(isOwnerYes('yes and also delete the other one'), false);
  assert.equal(isOwnerYes('no'), false);
});
