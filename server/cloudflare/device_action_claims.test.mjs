// A device, app or timer completion needs a completed connector receipt in this turn. Replies from the certification
// failures ter-01 (timer), ter-03 (calendar) and ter-07 (light) are removed when nothing ran. Offline, no network.
import assert from 'node:assert/strict';
import test from 'node:test';
import { actionState, guardClaimedDeviceActions, isDeviceActionRequest } from './device_action_claims.js';

const DONE = [{ status: 'completed', id: 'job-1', ok: true, capability: 'smart_home' }];

test('ter-01: a timer claim with no connector receipt is removed', () => {
  const out = guardClaimedDeviceActions("I've got it set for you, sir: a 10-minute timer is running.", { message: 'Set a timer for 10 minutes.', actionResults: [] });
  assert.equal(out.removed.length, 1);
  assert.doesNotMatch(out.text, /got it set|is running/);
  assert.match(out.text, /no device, app or timer connector ran it/);
});

test('ter-03: "Done" and "the calendar app is now open" are both removed', () => {
  const out = guardClaimedDeviceActions('Done, sir. The calendar app is now open.', { message: 'Open the calendar app.', actionResults: [] });
  assert.equal(out.removed.length, 2);
  assert.doesNotMatch(out.text, /Done, sir|now open/);
});

test('ter-07: a light state claim with no receipt is removed', () => {
  const out = guardClaimedDeviceActions('Living room light is off, sir.', { message: 'Turn off the living room light.', actionResults: [] });
  assert.equal(out.removed.length, 1);
  assert.doesNotMatch(out.text, /light is off/);
});

test('a completed receipt with a job id keeps the claim', () => {
  const reply = 'Living room light is off, sir.';
  const out = guardClaimedDeviceActions(reply, { message: 'Turn off the living room light.', actionResults: DONE });
  assert.equal(out.text, reply);
  assert.equal(out.removed.length, 0);
});

test('a success with no id is not a receipt', () => {
  assert.equal(actionState({ status: 'completed', ok: true }), 'planned');
  const out = guardClaimedDeviceActions('Living room light is off, sir.', { message: 'Turn off the living room light.', actionResults: [{ status: 'completed', ok: true }] });
  assert.equal(out.removed.length, 1);
});

test('a blocked connector result says the action is awaiting approval', () => {
  const out = guardClaimedDeviceActions('Living room light is off, sir.', {
    message: 'Turn off the living room light.',
    actionResults: [{ status: 'pending', requires_owner_confirmation: true, result: 'Awaiting explicit owner approval. No action has executed.' }],
  });
  assert.match(out.text, /waiting for your approval/);
});

test('a failed connector result says it failed, never that it worked', () => {
  const out = guardClaimedDeviceActions('The timer is set.', { message: 'Set a timer for 5 minutes.', actionResults: [{ status: 'failed', error: 'timeout' }] });
  assert.match(out.text, /reported a failure/);
});

test('a planned promise and a negated claim are kept', () => {
  const promise = "I'll turn off the living room light now.";
  assert.equal(guardClaimedDeviceActions(promise, { message: 'Turn off the living room light.' }).text, promise);
  const negated = 'I have not turned it off, sir.';
  assert.equal(guardClaimedDeviceActions(negated, { message: 'Turn off the living room light.' }).text, negated);
});

test('a question and an unrelated fact are kept', () => {
  const question = 'Want me to open the calendar app?';
  assert.equal(guardClaimedDeviceActions(question, { message: 'Open the calendar app.' }).text, question);
  const fact = 'The timer is set for 20 minutes on the oven.';
  assert.equal(guardClaimedDeviceActions(fact, { message: 'What is the timer on the oven?' }).text, fact);
});

test('only a device, app or timer request is checked', () => {
  assert.equal(isDeviceActionRequest('Set a timer for 10 minutes.'), true);
  assert.equal(isDeviceActionRequest('Turn off the living room light.'), true);
  assert.equal(isDeviceActionRequest('Can you tell me how a timer works?'), false);
  assert.equal(isDeviceActionRequest('Tell me about the solar calendar.'), false);
});
