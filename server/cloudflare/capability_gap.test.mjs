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

test('an existing Projects or Office action is never queued as self-development, even when the reply refuses', () => {
  const refusals = [
    "I can't create projects, sir.",
    "I cannot assign tasks to agents.",
  ];
  for (const reply of refusals) {
    assert.equal(capabilityGap('CHE, create a project called Behavior Test and assign Atlas one task called "Check CHE response quality".', reply), null);
    assert.equal(capabilityGap('Can you add a task for Atlas to check the Office board?', reply), null);
  }
});

test('a real unsupported ability still queues after the existing actions do not cover it', () => {
  assert.equal(capabilityGap('Can you add a dark mode switch to the Settings page?', "I don't have a way to change the Settings page, sir.")?.fields.kind, 'self_development');
});

test('a missing ability that only mentions a project, team or agent still queues', () => {
  for (const message of ['Can you store my project pictures?', 'Can you add OCR for Office documents?', 'Build a tool for my team to track invoices.']) {
    assert.equal(capabilityGap(message, REFUSED)?.fields.kind, 'self_development', message);
  }
});
