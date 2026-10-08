import test from 'node:test';
import assert from 'node:assert/strict';
import { noteJobActivity } from './job_activity.js';

test('job activity keeps the newest 40 lines, trimmed to 240 characters', () => {
  const job = { id: 'j1' };
  for (let i = 0; i < 50; i += 1) noteJobActivity(job, `step ${i}`);
  assert.equal(job.activity.length, 40);
  assert.equal(job.activity.at(-1).text, 'step 49');
  noteJobActivity(job, 'x'.repeat(500));
  assert.equal(job.activity.at(-1).text.length, 240);
});

test('blank or missing activity is ignored', () => {
  const job = { id: 'j2' };
  noteJobActivity(job, '   ');
  noteJobActivity(null, 'hello');
  assert.equal(job.activity, undefined);
});
