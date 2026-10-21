// Master mission §4 (owner, 2026-10-21): a delegated Office task becomes complete only when CHE's
// review approves it. A rejection is repaired a bounded number of times and then ends `rejected`; a
// review that cannot run is retried (the agent's work is not redone) and then held `needs_review`; an
// approved result claiming an action no tool receipt backs is sent back; interrupted work is recovered
// without doing anything twice; and the board, activity feed and agent status say the same thing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_REPAIR_PASSES,
  MAX_REVIEW_ATTEMPTS,
  createAgent,
  processAgentWork,
  queueAgentTask,
  recoverStaleWork,
  reviewVerdict,
  steerAgentTask,
  unbackedActionClaims,
} from './agent_runtime.js';
import { activityFeed } from './activity.js';

const REVIEW_PROMPT = /reviewing a delegated result/;

// One Office with Atlas, and a fake model: `work` answers the agent, `review` answers CHE's review.
// Each is a list consumed in order (the last entry repeats); an Error entry is thrown.
function office({ work = ['Three sourced findings about the lamp market.'], review = ['APPROVED\nSolid.'] } = {}) {
  let data = { autonomy: true, team: [], team_tasks: [], meetings: [], office_skills: [] };
  const agent = createAgent(data, { name: 'Atlas', role: 'Research Partner' }).agent;
  const calls = { work: 0, review: 0 };
  const events = [];
  const next = (list, i) => list[Math.min(i, list.length - 1)];
  const env = {
    AI: {
      run: async (_model, { messages }) => {
        const isReview = REVIEW_PROMPT.test(messages[0].content);
        const answer = isReview ? next(review, calls.review++) : next(work, calls.work++);
        if (answer instanceof Error) throw answer;
        return { response: answer };
      },
    },
  };
  const ctx = {
    env,
    load: async () => structuredClone(data),
    save: async (value) => { data = structuredClone(value); },
    notify: () => {},
    models: { fast: 'fast', strong: 'strong' },
    roomEvent: async (event) => { events.push(event); return true; },
  };
  return {
    ctx, calls, events,
    agentId: agent.id,
    get data() { return data; },
    set data(value) { data = value; },
    queue(text = 'Research the brass lamp market.', options = {}) {
      return queueAgentTask(data, data.team.find((a) => a.id === agent.id), text, 'owner', options).id;
    },
    task(id) { return data.team_tasks.find((t) => t.id === id); },
    agent() { return data.team.find((a) => a.id === agent.id); },
    // Lets any backoff elapse, then runs the loop.
    async run(budget = 12) {
      for (const t of data.team_tasks) t.retry_at = null;
      return processAgentWork(ctx, budget);
    },
  };
}

test('approval: only an APPROVED review completes the task, verified', async () => {
  const o = office();
  const id = o.queue();
  await o.run();
  assert.equal(o.task(id).status, 'complete');
  assert.equal(o.task(id).verified_by_che, true);
  assert.equal(o.calls.work, 1);
  assert.equal(o.calls.review, 1);
  assert.equal(o.events.find((e) => e.kind === 'task_complete')?.status, 'verified');
  assert.equal(o.data.agent_work_log[0].verified_by_che, true);
});

test('rejection: repaired at most MAX_REPAIR_PASSES times, then rejected, never complete or verified', async () => {
  const o = office({ review: ['NEEDS WORK\nNo sources for the price claims.'] });
  const id = o.queue();
  await o.run();
  const t = o.task(id);
  assert.equal(t.status, 'rejected');
  assert.equal(t.verified_by_che, false);
  assert.equal(t.revision_count, MAX_REPAIR_PASSES);
  assert.equal(o.calls.work, MAX_REPAIR_PASSES + 1, 'the original pass plus each repair pass');
  assert.match(t.error, /did not approve.*not complete/);
  assert.match(t.review_feedback, /No sources/);
  assert.ok(!o.events.some((e) => e.kind === 'task_complete'), 'no completion event for a rejected task');
  assert.equal(o.events.find((e) => e.kind === 'task_rejected')?.refs.task_id, id);
  assert.equal(o.data.agent_work_log[0].status, 'rejected');
  assert.equal(o.agent().runtime_status, 'idle', 'the agent is not shown as done');
});

test('a rejection that is then repaired completes on the approved pass', async () => {
  const o = office({ work: ['Draft one.', 'Draft two with sources.'], review: ['NEEDS WORK\nAdd sources.', 'APPROVED\nSourced now.'] });
  const id = o.queue();
  await o.run();
  assert.equal(o.task(id).status, 'complete');
  assert.equal(o.task(id).verified_by_che, true);
  assert.equal(o.task(id).result, 'Draft two with sources.');
  assert.equal(o.calls.work, 2);
});

test('review outage: the review is retried without redoing the work, then held needs_review, never complete', async () => {
  const o = office({ review: [new Error('429 rate limited')] });
  const id = o.queue();
  await o.run(1);
  assert.equal(o.task(id).status, 'review_pending');
  assert.ok(o.task(id).retry_at > Date.now(), 'the review retry waits out a backoff');
  assert.equal(o.agent().runtime_status, 'waiting');
  for (let i = 0; i < MAX_REVIEW_ATTEMPTS; i++) await o.run(1);
  const t = o.task(id);
  assert.equal(t.status, 'needs_review');
  assert.equal(t.verified_by_che, false);
  assert.equal(o.calls.work, 1, 'the agent did the work once; only the review was retried');
  assert.equal(o.calls.review, MAX_REVIEW_ATTEMPTS);
  assert.match(t.error, /could not review.*not complete/);
  assert.ok(!o.events.some((e) => e.kind === 'task_complete'));
  const line = activityFeed(o.data).find((e) => e.id === id);
  assert.match(line.line, /not verified yet/);
  // Further passes do nothing to a held task.
  await o.run();
  assert.equal(o.calls.review, MAX_REVIEW_ATTEMPTS);
});

test('an empty or unreadable review is an outage, not an approval or a rejection', async () => {
  for (const reply of ['', 'Looks fine to me overall.']) {
    const o = office({ review: [reply, 'APPROVED\nChecked.'] });
    const id = o.queue();
    await o.run(1);
    assert.equal(o.task(id).status, 'review_pending', JSON.stringify(reply));
    await o.run();
    assert.equal(o.task(id).status, 'complete');
    assert.equal(o.calls.work, 1);
  }
});

test('an approved result that claims an action with no tool receipt is sent back, then rejected', async () => {
  const o = office({ work: ['I deployed the landing page and sent the email to all 40 customers.'] });
  const id = o.queue('Launch the landing page.');
  await o.run();
  const t = o.task(id);
  assert.equal(t.status, 'rejected');
  assert.equal(t.verified_by_che, false);
  assert.match(t.che_review, /Receipt check: no tool receipt backs "I deployed the landing page/);
  assert.match(t.review_feedback, /state it as a proposal/);
});

test('the receipt check: claims need a receipt; denials, proposals and ordinary findings do not', () => {
  assert.equal(unbackedActionClaims('I merged PR 12 and pushed the fix.').length, 1);
  assert.equal(unbackedActionClaims('We have already placed the order for 3 lamps.').length, 1);
  assert.deepEqual(unbackedActionClaims('I have not deployed anything. I will open a PR once you approve.'), []);
  assert.deepEqual(unbackedActionClaims('Lamp prices range from $40 to $90 on Etsy; demand peaks in November.'), []);
  assert.deepEqual(unbackedActionClaims('I deployed the page.', [{ kind: 'computer_workspace', status: 'ok' }]), [], 'a successful tool receipt backs it');
  assert.equal(unbackedActionClaims('I deployed the page.', [{ kind: 'computer_workspace', status: 'failed' }]).length, 1, 'a failed receipt does not');
});

test('review verdicts are read from the first line only', () => {
  assert.equal(reviewVerdict('APPROVED\nGood.'), 'approved');
  assert.equal(reviewVerdict('**NEEDS WORK**\nMissing sources.'), 'needs_work');
  assert.equal(reviewVerdict('Needs-work: thin'), 'needs_work');
  assert.equal(reviewVerdict('The result is not APPROVED'), null);
  assert.equal(reviewVerdict(''), null);
});

test('interrupted in review: the stored result goes back to review; the agent is not run again', async () => {
  const o = office();
  const id = o.queue();
  const t = o.task(id);
  Object.assign(t, { status: 'reviewing', result: 'Finished findings.', updated_at: new Date(Date.now() - 600_000).toISOString() });
  assert.equal(recoverStaleWork(o.data), true);
  assert.equal(o.task(id).status, 'review_pending');
  assert.equal(o.agent().runtime_status, 'waiting');
  await o.run();
  assert.equal(o.task(id).status, 'complete');
  assert.equal(o.calls.work, 0, 'no duplicate work');
  assert.equal(o.calls.review, 1);
});

test('interrupted during owner-approved computer use: held, never re-run', async () => {
  const o = office();
  const id = o.queue('Post the listing on the shop.', { use_computer: true, owner_approved_computer: true });
  Object.assign(o.task(id), { status: 'running', updated_at: new Date(Date.now() - 600_000).toISOString() });
  recoverStaleWork(o.data);
  assert.equal(o.task(id).status, 'needs_review');
  assert.match(o.task(id).error, /Not re-run/);
  await o.run();
  assert.equal(o.calls.work, 0);
});

test('work interrupted over and over stops as failed instead of looping forever', () => {
  const o = office();
  const id = o.queue();
  for (let i = 0; i < 4; i++) {
    Object.assign(o.task(id), { status: 'running', updated_at: new Date(Date.now() - 600_000).toISOString() });
    recoverStaleWork(o.data);
  }
  assert.equal(o.task(id).status, 'failed');
  assert.match(o.task(id).error, /Interrupted 4 times/);
});

test('a fresh running task is not touched by stale recovery', () => {
  const o = office();
  const id = o.queue();
  Object.assign(o.task(id), { status: 'running', updated_at: new Date().toISOString() });
  assert.equal(recoverStaleWork(o.data), false);
  assert.equal(o.task(id).status, 'running');
});

test('steering a held result reworks it; a rejected task is finished and cannot be steered', async () => {
  const o = office({ review: [new Error('timeout')] });
  const id = o.queue();
  for (let i = 0; i <= MAX_REVIEW_ATTEMPTS; i++) await o.run(1);
  assert.equal(o.task(id).status, 'needs_review');
  const steered = steerAgentTask(o.data, id, 'Use only primary sources.');
  assert.equal(steered.task.status, 'queued');
  assert.equal(steered.task.prior_result, 'Three sourced findings about the lamp market.');
  Object.assign(o.task(id), { status: 'rejected' });
  assert.match(steerAgentTask(o.data, id, 'Try again').error, /already finished/);
});

test('cancelled while CHE was reviewing: the late review does not revive it', async () => {
  const o = office();
  const id = o.queue();
  const realRun = o.ctx.env.AI.run;
  o.ctx.env.AI.run = async (model, body) => {
    if (REVIEW_PROMPT.test(body.messages[0].content)) {
      const data = o.data;
      data.team_tasks.find((t) => t.id === id).status = 'cancelled';
      o.data = data;
    }
    return realRun(model, body);
  };
  await o.run();
  assert.equal(o.task(id).status, 'cancelled');
});
