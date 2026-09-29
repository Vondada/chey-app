import test from 'node:test';
import assert from 'node:assert/strict';
import { assertAgentMayRun, jobKind, permissionBlocker } from './agent_permissions.js';
import { queueAgentTask, processAgentWork } from './agent_runtime.js';

const knox = { id: 'k1', name: 'Knox', can_merge_code: false, can_spend_money: false, can_open_payouts: false };

test('Knox with all flags false cannot merge, spend or open payouts', () => {
  assert.throws(() => assertAgentMayRun(knox, { kind: 'merge' }), { message: 'agent_cannot_merge_code', status: 403 });
  assert.throws(() => assertAgentMayRun(knox, { kind: 'github_merge' }), { message: 'agent_cannot_merge_code' });
  assert.throws(() => assertAgentMayRun(knox, { kind: 'spend' }), { message: 'agent_cannot_spend_money' });
  assert.throws(() => assertAgentMayRun(knox, { kind: 'purchase' }), { message: 'agent_cannot_spend_money' });
  assert.throws(() => assertAgentMayRun(knox, { kind: 'payout' }), { message: 'agent_cannot_open_payouts' });
  assert.throws(() => assertAgentMayRun(knox, { type: 'stripe_payout' }), { message: 'agent_cannot_open_payouts' });
});

test('missing flags count as false; ordinary work is allowed', () => {
  assert.throws(() => assertAgentMayRun({ name: 'Nova' }, { kind: 'merge' }), { message: 'agent_cannot_merge_code' });
  assert.equal(assertAgentMayRun(knox, { task: 'Build the checkout page' }), '');
  assert.equal(assertAgentMayRun(knox, { kind: 'code' }), 'code');
});

test('job text is classified when no kind is given', () => {
  assert.equal(jobKind({ task: 'Merge PR 45 into main' }), 'merge');
  assert.equal(jobKind({ task: 'Open a Stripe payout' }), 'payout');
  assert.equal(jobKind({ task: 'Buy a domain' }), 'spend');
  assert.equal(jobKind({ task: 'Transfer $50 to savings' }), 'transfer');
  assert.equal(jobKind({ task: 'Please merge the office branch' }), 'merge');
  // Only the job's leading action counts: ordinary work mentioning money is allowed.
  assert.equal(jobKind({ task: 'Write a listing so customers can buy the class' }), '');
  assert.equal(jobKind({ task: 'Report on payouts and merge conflicts seen this week' }), '');
  assert.throws(() => assertAgentMayRun(knox, { task: 'merge the office branch' }), { message: 'agent_cannot_merge_code' });
  assert.match(permissionBlocker(knox, new Error('agent_cannot_merge_code')), /^Blocked: Knox cannot merge code/);
});

test('the work loop refuses a disallowed job even if it was queued', async () => {
  let data = { autonomy: true, team: [{ ...knox, role: 'Engineering', status: 'available' }], team_tasks: [], meetings: [] };
  queueAgentTask(data, data.team[0], 'Merge PR 45 into main', 'owner');
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls++; throw new Error('model must not be called'); };
  try {
    await processAgentWork({
      env: {},
      load: async () => data,
      save: async (v) => { data = v; },
      notify: () => {},
      models: { fast: 'f', strong: 's' },
    }, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls, 0);
  assert.equal(data.team_tasks[0].status, 'blocked');
  assert.match(data.team_tasks[0].error, /cannot merge code/);
});
