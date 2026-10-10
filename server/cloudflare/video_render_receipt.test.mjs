import assert from 'node:assert/strict';
import test from 'node:test';
import { verifiedState, verifiedStatusText } from './truth_layer.js';

test('a render CHE started is listed in verified state, with no upload claimed', () => {
  const receipts = [{ kind: 'video_render', key: 'video_render:gha_abc', task_id: 'gha_abc', topic: '3 facts about space', status: 'queued', at: new Date().toISOString() }];
  const state = verifiedState(receipts, []);
  assert.equal(state.renders.length, 1);
  const text = verifiedStatusText(state);
  assert.match(text, /3 facts about space/);
  assert.match(text, /No upload is recorded/);
});

test('with no render receipts, verified state lists none', () => {
  assert.deepEqual(verifiedState([], []).renders, []);
});
