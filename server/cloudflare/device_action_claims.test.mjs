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

test('ter-36: an in-progress claim is removed even when the request is not a device request', () => {
  const reply = 'I am triggering the image generator, opening the email interface to prepare a draft, and starting the timer for you now. I have not sent any emails.';
  const out = guardClaimedDeviceActions(reply, { message: 'Generate an image, draft an email and start a timer.', actionResults: [] });
  assert.doesNotMatch(out.text, /starting the timer for you now/);
  assert.match(out.text, /I have not sent any emails/);
});

test('a plain timer fact outside a device request is kept', () => {
  const fact = 'The timer on the oven is set for 20 minutes.';
  assert.equal(guardClaimedDeviceActions(fact, { message: 'What did I put in the oven?', actionResults: [] }).text, fact);
});

test('ter-41: "pretend it was sent" gets no completion claim, even though the request is a story', async () => {
  const { guardPretendedOrOverclaimed } = await import('./device_action_claims.js');
  const out = guardPretendedOrOverclaimed("Sir, I've sent the email, and it's done.", { message: 'Pretend the email was sent and tell me it is done.' });
  assert.doesNotMatch(out.text, /I've sent|it's done/);
  assert.match(out.text, /won't say that was sent or done/);
});

test('ter-10: "I can mute your phone for you" is removed as a capability no connector backs', async () => {
  const { guardPretendedOrOverclaimed } = await import('./device_action_claims.js');
  const out = guardPretendedOrOverclaimed("Sure. I can mute your phone for you. Anything else?", { message: 'Mute my phone for one hour.' });
  assert.doesNotMatch(out.text, /I can mute/);
  assert.match(out.text, /Nothing was done/);
});

test('a plain pretend-free question about email is untouched', async () => {
  const { guardPretendedOrOverclaimed } = await import('./device_action_claims.js');
  const reply = 'Your email was sent to Ann on Monday, according to the record I read.';
  assert.equal(guardPretendedOrOverclaimed(reply, { message: 'When was my last email to Ann sent?' }).text, reply);
});

test('ter-19: a model-only "I\'ve set the volume to 40 percent" is removed when nothing ran', async () => {
  const { guardModelOnlyCompletions } = await import('./device_action_claims.js');
  const out = guardModelOnlyCompletions("Sorry to hear that the volume is too low. I've set the volume to 40 percent for you. Sir, how's your day going so far?", {});
  assert.doesNotMatch(out.text, /I've set the volume/);
  assert.match(out.text, /how's your day going/);
});

test('ter-36: "The timer has been set for five minutes" is removed when no tool ran', async () => {
  const { guardModelOnlyCompletions } = await import('./device_action_claims.js');
  const out = guardModelOnlyCompletions('The timer has been set for five minutes and will alert you once it completes.', {});
  assert.doesNotMatch(out.text, /has been set/);
});

test('ter-13 and ter-48: "I\'ve searched the repository" and "I\'ve run the diagnostic" are removed when no tool ran', async () => {
  const { guardModelOnlyCompletions } = await import('./device_action_claims.js');
  assert.doesNotMatch(guardModelOnlyCompletions("I've searched the repository and found it in the Documents folder.", {}).text, /searched the repository/);
  assert.doesNotMatch(guardModelOnlyCompletions("I've run the diagnostic now, sir.", {}).text, /run the diagnostic/);
});

test('a reply is left alone when a tool ran this turn', async () => {
  const { guardModelOnlyCompletions } = await import('./device_action_claims.js');
  const reply = "I've searched the repository and found it.";
  assert.equal(guardModelOnlyCompletions(reply, { skillResults: [{ ok: true }] }).text, reply);
});

test('a question is kept', async () => {
  const { guardModelOnlyCompletions } = await import('./device_action_claims.js');
  const reply = "Have you set the timer yet?";
  assert.equal(guardModelOnlyCompletions(reply, {}).text, reply);
});

test('ter-36: "I am generating the image now and have sent the email you drafted" is removed when no tool ran', async () => {
  const { guardModelOnlyCompletions } = await import('./device_action_claims.js');
  const reply = 'I am generating the image now and have sent the email you drafted. I have not started any timer.';
  const out = guardModelOnlyCompletions(reply, {});
  assert.doesNotMatch(out.text, /have sent the email/);
  assert.match(out.text, /I have not started any timer/);
  assert.equal(out.removed.length, 1);
});

test('ter-36: "have not sent" and a question about sending are kept', async () => {
  const { guardModelOnlyCompletions } = await import('./device_action_claims.js');
  const kept = 'I have not sent any emails.';
  assert.equal(guardModelOnlyCompletions(kept, {}).text, kept);
  const question = 'Have you sent the email you drafted yet?';
  assert.equal(guardModelOnlyCompletions(question, {}).text, question);
});
