import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyOwnerAction, gateOwnerAction, gateAppAccess } from './owner_action_gate.js';

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

test('a verb in the middle of a sentence does not trigger the gate', () => {
  assert.equal(classifyOwnerAction('write a listing customers can buy'), '');
  assert.equal(classifyOwnerAction('explain how to remove duplicates from a list'), '');
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
  assert.deepEqual(gateOwnerAction('read my last note'), { allowed: true, kind: '' });
});

test('apps are refused until the owner grants them', () => {
  const refused = gateAppAccess('Notes', []);
  assert.equal(refused.allowed, false);
  assert.match(refused.ask, /not given me permission to use notes/);
  assert.equal(gateAppAccess('Notes', ['notes']).allowed, true);
  assert.equal(gateAppAccess('', ['notes']).allowed, false);
});
