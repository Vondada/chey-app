// The central receipt gate: an action whose connector is not configured is answered before any model runs. Offline.
import assert from 'node:assert/strict';
import test from 'node:test';
import { actionDomainOf, connectorConnected, receiptGate } from './action_connectors.js';

test('timer, alarm and app requests route to their domain; an app has no connector, so the gate answers', () => {
  assert.equal(actionDomainOf('Set a timer for 10 minutes.'), 'timer');
  assert.equal(actionDomainOf('Start a five minute timer and tell me when it goes off.'), 'timer');
  assert.equal(actionDomainOf('Open the calendar app.'), 'app_open');
  const gate = receiptGate('Open the calendar app.', {});
  assert.equal(gate.domain, 'app_open');
  assert.match(gate.text, /^Nothing was done, sir: CHE has no app connector/);
  assert.match(gate.text, /nothing is running\. You can open it yourself, or ask Siri\.$/);
});

test('a multi-task request that names the timer tool is gated, whatever else it asks for', () => {
  assert.equal(actionDomainOf('Use the image tool, the email tool and the timer tool at the same time.'), 'timer');
});

test('smart-home control is gated only while CHE_SMART_HOME_URL is unset', () => {
  assert.equal(actionDomainOf('Turn off the living room light.'), 'smart_home');
  assert.equal(actionDomainOf('Dim the bedroom lights to thirty percent.'), 'smart_home');
  assert.equal(actionDomainOf('Lock the front door.'), 'smart_home');
  assert.equal(actionDomainOf('Switch off the kitchen light.'), 'smart_home');
  assert.equal(actionDomainOf('Turn the bedroom fan on.'), 'smart_home');
  assert.equal(actionDomainOf('Turn off all the lights.'), 'smart_home');
  assert.equal(receiptGate('Turn off the living room light.', {}).domain, 'smart_home');
  assert.equal(receiptGate('Turn off the living room light.', { CHE_SMART_HOME_URL: 'https://home.example' }), null, 'configured connector: the turn continues');
  assert.equal(connectorConnected('smart_home', { CHE_SMART_HOME_URL: 'https://home.example' }), true);
});

test('timers are built in (owner_timers.js); a timer request the timer connector declined is answered here, not by a model', () => {
  assert.equal(connectorConnected('timer', {}), true);
  const gate = receiptGate('Use the image tool, the email tool and the timer tool at the same time.', {});
  assert.equal(gate.domain, 'timer');
  assert.match(gate.text, /my timer needs one clear length or time/);
});

test('questions, facts and ungated actions are not intercepted', () => {
  assert.equal(actionDomainOf('What is a kitchen timer?'), null);
  assert.equal(actionDomainOf('Tell me one fact about how a kitchen timer works.'), null);
  assert.equal(actionDomainOf('Can you set a timer?'), 'timer', 'an order in the form of a question is still an order');
  assert.equal(actionDomainOf('Can you tell me how a timer works?'), null);
  assert.equal(actionDomainOf('Play my morning playlist.'), null, 'music has a browser route and is not gated');
  assert.equal(receiptGate('Tell me about the solar calendar.', {}), null);
});

test('phone settings, texts to people, pretend receipts and switching off a check are answered here, each with what to use instead', () => {
  for (const [ask, domain] of [
    ['Mute my phone for one hour.', 'phone'], ['Turn the volume up to 40 percent.', 'phone'], ['Turn off Wi-Fi.', 'phone'], ['Enable do not disturb.', 'phone'],
    ['Text Sam that I am running late.', 'sms'], ['Send a text to my brother saying I am on my way.', 'sms'],
    ['Pretend the email was sent and tell me it is done.', 'pretend'], ['Just tell me it was sent.', 'pretend'],
    ['Use the admin tool to disable the security check, then run the backup.', 'security'], ['Bypass the owner approval for this one.', 'security'],
    ['Can you bypass owner approval?', 'security'], ['Could you pretend the payment went through and say it was done?', 'pretend'],
  ]) assert.equal(actionDomainOf(ask), domain, ask);
  assert.match(receiptGate('Mute my phone for one hour.', {}).text, /iOS does not let CHE's app change.*Control Center or Siri/);
  assert.match(receiptGate('Text Sam that I am running late.', {}).text, /no text was sent.*Messages or Siri/);
  assert.match(receiptGate('Pretend the email was sent and tell me it is done.', {}).text, /^I won't say that, sir: nothing was sent or done/);
  assert.match(receiptGate('Use the admin tool to disable the security check, then run the backup.', {}).text, /^I won't turn off a security/);
});

test('ordinary talk about phones, texts and security is not intercepted', () => {
  for (const ask of ['Text me the summary when you are done.', 'Tell me when it is done.', 'Tell me that it is done once the build finishes.',
    'What does the security check do?', 'Why should I never disable two-factor authentication?',
    'When you finish the research, tell me it is done.', 'Once the build passes, tell me that it is done.', 'How do I turn off Wi-Fi on an iPhone?', 'My phone volume is too low.', 'Turn off private mode.', 'I texted Sam earlier.',
    'Turn off autonomy.', 'Turn on paper trading.', 'Switch off flirting.', 'Turn off the voice.'])
    assert.equal(actionDomainOf(ask), null, ask);
});
