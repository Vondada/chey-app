import test from 'node:test';
import assert from 'node:assert/strict';
import { WORKFLOWS, selectWorkflow, chooseKnownAnswer, inferenceDecision, engineCapacityState, shouldSwitchEngine, ownerNotificationPolicy, minimalContext } from './workflow_governor.js';

test('governor selects efficient workflows', () => {
  assert.equal(selectWorkflow({ text: 'What is my Worker URL?' }), WORKFLOWS.INSTANT);
  assert.equal(selectWorkflow({ text: 'Change this Flutter button label' }), WORKFLOWS.FAST_CODING);
  assert.equal(selectWorkflow({ text: 'Fix this coding regression and find the root cause' }), WORKFLOWS.BUG_HUNT);
  assert.equal(selectWorkflow({ text: 'Research the latest provider limits' }), WORKFLOWS.RESEARCH);
  assert.equal(selectWorkflow({ text: 'continue', resume_checkpoint: true }), WORKFLOWS.RECOVERY);
  assert.equal(selectWorkflow({ text: 'answer this', offline: true }), WORKFLOWS.DEGRADED);
});

test('known information bypasses inference', () => {
  const candidates = [
    { source: 'research_library', found: true, value: 'library answer', verified_at: 100 },
    { source: 'active_conversation', found: true, value: 'conversation answer', verified_at: 100 },
  ];
  assert.equal(chooseKnownAnswer(candidates)?.value, 'conversation answer');
  assert.equal(inferenceDecision(candidates).use_engine, false);
  assert.equal(inferenceDecision([]).use_engine, true);
});

test('freshness rules reject stale facts', () => {
  const candidates = [{ source: 'knowledge_cache', found: true, value: 'old', verified_at: 100 }];
  assert.equal(chooseKnownAnswer(candidates, { now: 1000, freshnessMs: 100 }), null);
});

test('capacity drains at seventy percent', () => {
  assert.equal(engineCapacityState({ utilization: 0.40, health: 1 }), 'healthy');
  assert.equal(engineCapacityState({ utilization: 0.60, health: 1 }), 'caution');
  assert.equal(engineCapacityState({ utilization: 0.70, health: 1 }), 'draining');
  assert.equal(shouldSwitchEngine('draining'), true);
});

test('recoverable failures stay quiet and boundaries surface', () => {
  assert.equal(ownerNotificationPolicy({ recoverable: true }).notify, false);
  assert.equal(ownerNotificationPolicy({ recoverable: true, owner_action_required: true }).notify, true);
  assert.equal(ownerNotificationPolicy({ recoverable: true, security_risk: true }).notify, true);
});

test('minimal context deduplicates within budget', () => {
  assert.deepEqual(minimalContext(['abc', 'abc', 'de', 'toolong'], 5), ['abc', 'de']);
});
