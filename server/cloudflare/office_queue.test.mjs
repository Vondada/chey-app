// The Office queue rules: no job is done without evidence, the queue is worked by priority and due time, and overload is visible.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeCheck, jobState, queueOrder, workload } from './office_queue.js';

test('a job needs a result and at least one check to count as done', () => {
  assert.equal(closeCheck({ result: 'Fixed the banner.', evidence: { tests: ['npm test: 4201 pass'] } }).ok, true);
  assert.equal(closeCheck({ result: 'Fixed.', evidence: { files: ['lib/a.dart'] } }).ok, true);
  assert.equal(closeCheck({ result: 'Fixed.', verified_by_che: true }).ok, true);
  assert.deepEqual(closeCheck({ result: 'Fixed.' }).missing, ['a test run, a changed file, or a check by CHE']);
  assert.deepEqual(closeCheck({ evidence: { tests: ['x'] } }).missing, ['a result']);
});

test('a done job without evidence is shown as needs_evidence, not done', () => {
  assert.equal(jobState({ status: 'done', result: 'It works.' }), 'needs_evidence');
  assert.equal(jobState({ status: 'done', result: 'It works.', evidence: { tests: ['pass'] } }), 'done');
  assert.equal(jobState({ status: 'blocked' }), 'blocked');
  assert.equal(jobState({ status: 'reviewing' }), 'running');
  assert.equal(jobState({ status: 'queued' }), 'queued');
});

test('the queue is worked by priority, then the earliest due time, and skips finished jobs', () => {
  const tasks = [
    { id: 'low', priority: 'low' },
    { id: 'late', priority: 'high', due_at: '2026-10-27T10:00:00Z' },
    { id: 'soon', priority: 'high', due_at: '2026-10-26T10:00:00Z' },
    { id: 'urgent', priority: 'urgent' },
    { id: 'closed', priority: 'urgent', status: 'done', result: 'x', evidence: { tests: ['y'] } },
  ];
  assert.deepEqual(queueOrder(tasks).map((t) => t.id), ['urgent', 'soon', 'late', 'low']);
});

test('open jobs per owner are counted so overload shows', () => {
  const tasks = [
    { id: 'a', owner_id: 'atlas' },
    { id: 'b', owner_id: 'atlas', status: 'running' },
    { id: 'c', owner_id: 'nova', status: 'done', result: 'x', evidence: { tests: ['y'] } },
    { id: 'd' },
  ];
  assert.deepEqual(workload(tasks), { atlas: 2 });
});
