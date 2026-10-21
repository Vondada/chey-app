// The owner's missing-ability rule (2026-10-21): CHE queues an ability she lacks instead of refusing, and never queues
// money, deletion or secrets.
import assert from 'node:assert/strict';
import test from 'node:test';
import { capabilityGap, capabilityReply } from './capability_gap.js';

const REFUSED = "I don't have anywhere to store pictures, sir.";

test('an ability CHE lacks is queued for herself, and the reply is not a refusal', () => {
  const gap = capabilityGap('Can you store my pictures for me?', REFUSED);
  assert.equal(gap.fields.kind, 'self_development');
  assert.match(gap.fields.title, /^Add ability: Can you store my pictures/);
  assert.equal(gap.fields.idempotency_key, gap.key);
  const reply = capabilityReply('job-1');
  assert.match(reply, /Job job-1 is queued/);
  assert.doesNotMatch(reply, /don't have|cannot|can't/i);
});

test('the same request has the same key, so a repeat is deduplicated', () => {
  assert.equal(capabilityGap('Can you store my pictures?', REFUSED).key, capabilityGap('can you store my pictures', REFUSED).key);
});

test('money, deletion and secrets are never queued', () => {
  for (const message of ['Can you pay the invoice for me?', 'Can you buy the domain?', 'Can you delete my old files?', 'Can you store my password?', 'Can you book a flight?']) {
    assert.equal(capabilityGap(message, REFUSED), null, message);
  }
});

test('an answer that is not a refusal, a memory answer, or a question about stored facts queues nothing', () => {
  assert.equal(capabilityGap('Can you store my pictures?', 'Saved.'), null);
  assert.equal(capabilityGap('Can you tell me my favorite food?', "I don't have a record of that, sir."), null);
  assert.equal(capabilityGap('What is my favorite food?', "I don't have anywhere to store that."), null);
});
