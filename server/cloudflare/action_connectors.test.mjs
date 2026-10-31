// The central receipt gate: an action whose connector is not configured is answered before any model runs. Offline.
import assert from 'node:assert/strict';
import test from 'node:test';
import { actionDomainOf, connectorConnected, receiptGate } from './action_connectors.js';

test('timer, alarm and app requests route to a domain with no connector, so the gate answers', () => {
  assert.equal(actionDomainOf('Set a timer for 10 minutes.'), 'timer');
  assert.equal(actionDomainOf('Start a five minute timer and tell me when it goes off.'), 'timer');
  assert.equal(actionDomainOf('Open the calendar app.'), 'app_open');
  const gate = receiptGate('Set a timer for 10 minutes.', {});
  assert.equal(gate.domain, 'timer');
  assert.match(gate.text, /^Nothing was done, sir: CHE has no timer connector/);
  assert.match(gate.text, /nothing is running\.$/);
});

test('a multi-task request that names the timer tool is gated, whatever else it asks for', () => {
  assert.equal(actionDomainOf('Use the image tool, the email tool and the timer tool at the same time.'), 'timer');
});

test('smart-home control is gated only while CHE_SMART_HOME_URL is unset', () => {
  assert.equal(actionDomainOf('Turn off the living room light.'), 'smart_home');
  assert.equal(actionDomainOf('Dim the bedroom lights to thirty percent.'), 'smart_home');
  assert.equal(actionDomainOf('Lock the front door.'), 'smart_home');
  assert.equal(receiptGate('Turn off the living room light.', {}).domain, 'smart_home');
  assert.equal(receiptGate('Turn off the living room light.', { CHE_SMART_HOME_URL: 'https://home.example' }), null, 'configured connector: the turn continues');
  assert.equal(connectorConnected('smart_home', { CHE_SMART_HOME_URL: 'https://home.example' }), true);
});

test('timers have no connector, so configuring some other URL does not connect them', () => {
  assert.equal(connectorConnected('timer', { CHE_SMART_HOME_URL: 'x', CHE_MUSIC_URL: 'y' }), false);
  assert.equal(receiptGate('Set a timer for 5 minutes.', { CHE_SMART_HOME_URL: 'x' }).domain, 'timer');
});

test('questions, facts and ungated actions are not intercepted', () => {
  assert.equal(actionDomainOf('What is a kitchen timer?'), null);
  assert.equal(actionDomainOf('Tell me one fact about how a kitchen timer works.'), null);
  assert.equal(actionDomainOf('Can you set a timer?'), 'timer', 'an order in the form of a question is still an order');
  assert.equal(actionDomainOf('Can you tell me how a timer works?'), null);
  assert.equal(actionDomainOf('Play my morning playlist.'), null, 'music has a browser route and is not gated');
  assert.equal(actionDomainOf('Mute my phone for one hour.'), null, 'device-state claims are handled by the reply guards');
  assert.equal(actionDomainOf('Text Sam that I am running late.'), null);
  assert.equal(receiptGate('Tell me about the solar calendar.', {}), null);
});
