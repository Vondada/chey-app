import test from 'node:test';
import assert from 'node:assert/strict';
import { speakRuntimeStatus } from './coding_runtime.js';

test('billing alerts remain visible independently of coding success, failure or unverified liveness', () => {
  for (const record of [{state:'pr_open',pr_number:42},{state:'failed'},{state:'running',liveness:'unverified'}]) {
    const reply=speakRuntimeStatus({...record,billing_alert:true,billing:{openrouter:{verified:true,delta_usd:0.02}}});
    assert.match(reply,/billing alert/i);
    assert.match(reply,/openrouter.*\$0\.02/i);
    assert.match(reply,/zero.*spend|spending.*unauthorized/i);
  }
});

test('unverified billing never invents a charge amount and normal receipts do not invent an alert', () => {
  const unknown=speakRuntimeStatus({state:'failed',billing_alert:true,billing:{openrouter:{verified:false,delta_usd:12}}});
  assert.match(unknown,/amount.*not verified/i);
  assert.doesNotMatch(unknown,/\$12/);
  assert.doesNotMatch(speakRuntimeStatus({state:'no_change'}),/billing alert/i);
});
