import test from 'node:test';
import assert from 'node:assert/strict';
import { createObjective, runnableNodes, recordNodeOutcome, replanNode, advanceObjectives } from './objective_graph.js';

const plan = () => createObjective({
  objective: 'Ship the faster voice reply',
  repo_sha: 'abc1234',
  nodes: [
    { id: 'research', prompt: 'Research streaming TTS options' },
    { id: 'audit', prompt: 'Audit the current reply latency' },
    { id: 'design', prompt: 'Design the change', depends_on: ['research', 'audit'] },
    { id: 'build', prompt: 'Build it', kind: 'self_development', depends_on: ['design'] },
  ],
});

test('objective graph: validation rejects cycles, unknown steps, duplicates and unsafe kinds', () => {
  assert.throws(() => createObjective({ objective: 'x', nodes: [{ id: 'a', prompt: 'p', depends_on: ['b'] }, { id: 'b', prompt: 'q', depends_on: ['a'] }] }), /cycle/);
  assert.throws(() => createObjective({ objective: 'x', nodes: [{ id: 'a', prompt: 'p', depends_on: ['zz'] }] }), /unknown step/);
  assert.throws(() => createObjective({ objective: 'x', nodes: [{ id: 'a', prompt: 'p' }, { id: 'a', prompt: 'q' }] }), /unique/);
  assert.equal(createObjective({ objective: 'x', nodes: [{ prompt: 'p', kind: 'shell' }] }).nodes[0].kind, 'chat', 'no unrestricted tool kind can be smuggled in');
  const o = plan();
  assert.equal(o.repo_sha, 'abc1234');
  assert.deepEqual(runnableNodes(o).map((n) => n.id), ['research', 'audit'], 'independent steps are runnable together');
});

test('objective graph: independent steps run in parallel, dependents wait, outputs flow downstream', () => {
  const data = { jobs: [], objectives: [plan()] };
  let n = 0;
  const enqueue = (fields) => { const job = { id: `j${(n += 1)}`, status: 'queued', ...fields }; data.jobs.push(job); return { job }; };
  assert.equal(advanceObjectives(data, enqueue), 2);
  data.jobs.find((j) => j.node_id === 'research').status = 'complete';
  data.jobs.find((j) => j.node_id === 'research').result = 'Use chunked streaming.';
  assert.equal(advanceObjectives(data, enqueue), 0, 'design waits for audit');
  data.jobs.find((j) => j.node_id === 'audit').status = 'complete';
  assert.equal(advanceObjectives(data, enqueue), 1);
  const design = data.jobs.find((j) => j.node_id === 'design');
  assert.match(design.prompt, /VERIFIED RESULTS OF EARLIER STEPS[\s\S]*Use chunked streaming/);
});

test('objective graph: a failure touches only the affected step; finished steps are never re-run; replans are bounded', () => {
  const data = { jobs: [], objectives: [plan()] };
  let n = 0;
  const enqueue = (fields) => { const job = { id: `j${(n += 1)}`, status: 'queued', ...fields }; data.jobs.push(job); return { job }; };
  advanceObjectives(data, enqueue);
  for (const j of data.jobs) { j.status = 'complete'; j.result = `${j.node_id} done`; }
  advanceObjectives(data, enqueue);
  const o = data.objectives[0];
  // The design job retries quietly with a checkpoint: the node keeps it.
  const designJob = data.jobs.find((j) => j.node_id === 'design');
  designJob.checkpoint = { genuine_passes: 1 };
  advanceObjectives(data, enqueue);
  assert.deepEqual(o.nodes.find((x) => x.id === 'design').checkpoint, { genuine_passes: 1 });
  designJob.status = 'failed';
  designJob.failure_class = 'C';
  advanceObjectives(data, enqueue);
  assert.equal(o.nodes.find((x) => x.id === 'design').status, 'failed');
  assert.equal(o.nodes.find((x) => x.id === 'build').status, 'blocked');
  assert.equal(o.status, 'needs_replan');
  const before = data.jobs.length;
  assert.equal(replanNode(o, 'design', { prompt: 'Design the change' }).reason, 'duplicate_strategy');
  assert.equal(replanNode(o, 'research', { prompt: 'again' }).reason, 'not_failed', 'a finished step cannot be reset');
  assert.equal(replanNode(o, 'design', { prompt: 'Design a smaller change behind a flag' }).ok, true);
  assert.equal(o.nodes.find((x) => x.id === 'build').status, 'pending');
  advanceObjectives(data, enqueue);
  assert.equal(data.jobs.length, before + 1, 'only the replanned step runs again');
  assert.deepEqual(data.jobs.slice(before).map((j) => j.node_id), ['design']);
  assert.equal(o.nodes.find((x) => x.id === 'research').output, 'research done', 'verified output kept');
  const again = data.jobs[data.jobs.length - 1];
  again.status = 'failed';
  advanceObjectives(data, enqueue);
  assert.equal(replanNode(o, 'design', { prompt: 'Third idea' }).ok, true);
  data.jobs.push({ id: 'x', status: 'failed' });
  o.nodes.find((x) => x.id === 'design').job_id = 'x';
  advanceObjectives(data, enqueue);
  assert.equal(replanNode(o, 'design', { prompt: 'Fourth idea' }).reason, 'strategies_exhausted', 'bounded: no endless replanning');
  recordNodeOutcome(o, 'research', { id: 'late', status: 'failed' });
  assert.equal(o.nodes.find((x) => x.id === 'research').status, 'complete', 'a late failure cannot undo a completed step');
});


test('objective graph: self-development nodes never enter the queue without durable owner authorization', () => {
  const unauthorized = createObjective({
    objective: 'Change CHE',
    nodes: [{ id: 'build', prompt: 'edit the worker', kind: 'self_development' }],
  });
  const data = { jobs: [], objectives: [unauthorized] };
  const enqueue = (fields) => { const job = { id: 'should-not-exist', status: 'queued', ...fields }; data.jobs.push(job); return { job }; };
  assert.equal(advanceObjectives(data, enqueue), 0);
  assert.equal(data.jobs.length, 0);
  assert.equal(unauthorized.nodes[0].status, 'failed');
  assert.match(unauthorized.nodes[0].evidence.join(' '), /owner authorization required/);

  const authorized = createObjective({
    objective: 'Change CHE',
    owner_authorized: true,
    nodes: [{ id: 'build', prompt: 'edit the worker', kind: 'self_development' }],
  });
  const ok = { jobs: [], objectives: [authorized] };
  assert.equal(advanceObjectives(ok, (fields) => { const job = { id: 'j1', status: 'queued', ...fields }; ok.jobs.push(job); return { job }; }), 1);
  assert.equal(ok.jobs[0].kind, 'self_development');
});
