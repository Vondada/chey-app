import test from 'node:test';
import assert from 'node:assert/strict';
import { createObjective, runnableNodes, recordNodeOutcome, replanNode, advanceObjectives, mutateObjective, applyMissionEvent, rankStrategies, nodeContext, condenseObjective, resolveKnownNodes, missionFailureKind, speakObjective } from './objective_graph.js';

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
  again.failure_class = 'C'; // permanent: no automatic recovery, the owner replans
  advanceObjectives(data, enqueue);
  assert.equal(replanNode(o, 'design', { prompt: 'Third idea' }).ok, true);
  data.jobs.push({ id: 'x', status: 'failed', failure_class: 'C' });
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

// ---- Mission acceptance (A-numbers from the cognitive-execution mission) ----

const harness = (objective) => {
  const data = { jobs: [], objectives: [objective] };
  let n = 0;
  const enqueue = (fields) => { const job = { id: `j${(n += 1)}`, status: 'queued', ...fields }; data.jobs.push(job); return { job }; };
  const finish = (nodeId, patch = {}) => { const job = [...data.jobs].reverse().find((j) => j.node_id === nodeId); Object.assign(job, { status: 'complete', result: `${nodeId} ok` }, patch); return job; };
  return { data, enqueue, finish, node: (id) => objective.nodes.find((x) => x.id === id), advance: () => advanceObjectives(data, enqueue) };
};

test('A1 + A9: new evidence mutates the live graph (add, split, priority, verification) atomically; cycles are rejected and nothing changes', () => {
  const o = createObjective({ objective: 'Fix the microphone problem', owner_authorized: true, nodes: [
    { id: 'find', prompt: 'Find the microphone code' },
    { id: 'fix', prompt: 'Fix it', depends_on: ['find'] },
    { id: 'ship', prompt: 'Ship it', depends_on: ['fix'] },
  ] });
  const h = harness(o);
  h.advance();
  h.finish('find', { result: 'lib/voice/mic.dart' });
  h.advance();
  assert.equal(h.node('fix').status, 'running');
  // Evidence: the fix touches two independent areas; ship needs a device check.
  const split = applyMissionEvent(o, { id: 'e1', type: 'new_evidence', node_id: 'ship', evidence: 'two separate causes found', ops: [
    { op: 'split_node', id: 'ship', into: [{ id: 'ship_ios', prompt: 'Ship the iOS part' }, { id: 'ship_web', prompt: 'Ship the web part' }] },
    { op: 'set_priority', id: 'ship_web', priority: 8 },
    { op: 'add_verification', id: 'find', requirement: 'mic permission string present' },
  ] });
  assert.equal(split.ok, true);
  assert.equal(h.node('ship').status, 'cancelled');
  assert.ok(h.node('find_verify'), 'a finished step gets its new check as a separate step');
  assert.equal(h.node('find').status, 'complete', 'the finished step itself is untouched');
  assert.equal(applyMissionEvent(o, { id: 'e1', type: 'new_evidence', ops: [{ op: 'cancel_node', id: 'ship_ios' }] }).duplicate, true, 'a duplicate event is ignored');
  const snapshot = JSON.stringify(o.nodes);
  const cyc = mutateObjective(o, [{ op: 'add_node', node: { id: 'z', prompt: 'z', depends_on: ['ship_web'] } }, { op: 'set_dependencies', id: 'ship_web', depends_on: ['z'] }]);
  assert.equal(cyc.reason, 'cycle');
  assert.equal(JSON.stringify(o.nodes), snapshot, 'a rejected batch changes nothing');
  assert.equal(mutateObjective(o, [{ op: 'set_priority', id: 'find', priority: 1 }]).reason, 'step_complete');
});

test('A2 + A3 + safe lanes: independent nodes run together, dependents wait, nodes writing the same file are serialized', () => {
  const o = createObjective({ objective: 'Three edits', nodes: [
    { id: 'a', prompt: 'edit a', targets: ['lib/a.dart'] },
    { id: 'b', prompt: 'edit b', targets: ['lib/b.dart'] },
    { id: 'a2', prompt: 'edit a again', targets: ['lib/a.dart'] },
    { id: 'c', prompt: 'combine', depends_on: ['a', 'b'] },
  ] });
  const h = harness(o);
  assert.equal(h.advance(), 2, 'a and b start together; a2 waits for a\'s file lane');
  assert.deepEqual(h.data.jobs.map((j) => j.node_id), ['a', 'b']);
  assert.deepEqual(h.data.jobs[0].lane, { mission_id: o.id, node_id: 'a', base_sha: '', capability: 'chat', targets: ['lib/a.dart'] });
  assert.ok(o.events.some((e) => e.type === 'lane_wait' && e.node_id === 'a2'));
  assert.equal(h.node('c').status, 'pending', 'c waits for its prerequisites');
  h.finish('a');
  assert.equal(h.advance(), 1);
  assert.equal(h.node('a2').status, 'running', 'the lane is free once a finished');
});

test('A4 + A8 + A10: a CI failure recovers only that node with a new bounded strategy; finished nodes are kept; no blind repeat', () => {
  const o = createObjective({ objective: 'Fix X', nodes: [
    { id: 'find', prompt: 'Find X' },
    { id: 'fix', prompt: 'Fix X', depends_on: ['find'] },
    { id: 'report', prompt: 'Report', depends_on: ['fix'] },
  ] });
  const h = harness(o);
  h.advance(); h.finish('find'); h.advance(); h.finish('fix');
  h.advance();
  assert.equal(h.node('report').status, 'running');
  // Deterministic CI evidence arrives after the node finished.
  assert.equal(applyMissionEvent(o, { id: 'ci-1', type: 'ci_failed', node_id: 'fix', evidence: 'test mic_test.dart failed: expected granted' }).ok, true);
  const jobsBefore = h.data.jobs.length;
  h.advance();
  const fix = h.node('fix');
  assert.equal(fix.strategy, 'fix_reported_failure');
  assert.match(h.data.jobs[h.data.jobs.length - 1].prompt, /failed verification: ci_failed: test mic_test\.dart failed/);
  assert.deepEqual(h.data.jobs.slice(jobsBefore).map((j) => j.node_id), ['fix'], 'only the affected node runs again');
  assert.equal(h.node('find').status, 'complete');
  assert.equal(h.node('find').output, 'find ok', 'verified output kept');
  // It fails again: the next strategy is different, never the same one.
  h.finish('fix', { status: 'failed', error: 'tests failed again' });
  h.advance();
  assert.equal(fix.strategy, 'minimal_change');
  assert.equal(new Set(fix.fingerprints).size, fix.fingerprints.length, 'every attempt was a different strategy');
  h.finish('fix', { status: 'failed', error: 'tests failed again' });
  h.advance();
  assert.equal(fix.status, 'failed');
  assert.equal(fix.recovery, 'exhausted', 'bounded: the ladder ends instead of looping');
  assert.ok(o.events.some((e) => e.type === 'recovery_exhausted'));
  assert.equal(replanNode(o, 'fix', { prompt: 'Fix X' }).reason, 'duplicate_strategy');
});

test('A13 + A14: verified outcomes reorder recovery strategies, but safety, authorization and the mission cannot be optimized away', () => {
  const learning = { ENGINEERING: { minimal_change: { ok: 9, fail: 0 }, restate_with_evidence: { ok: 0, fail: 5 } } };
  assert.deepEqual(rankStrategies('ENGINEERING', learning).map((s) => s.id), ['minimal_change', 'restate_with_evidence']);
  assert.deepEqual(rankStrategies('ENGINEERING', {}).map((s) => s.id), ['restate_with_evidence', 'minimal_change'], 'default order without evidence');
  // Learned stats can only reorder the fixed ladder.
  const poisoned = { AUTHORIZATION: { bypass_owner: { ok: 999, fail: 0 } }, ENGINEERING: { skip_tests: { ok: 999, fail: 0 } } };
  assert.deepEqual(rankStrategies('AUTHORIZATION', poisoned), []);
  assert.ok(!rankStrategies('ENGINEERING', poisoned).some((s) => s.id === 'skip_tests'));
  // Learning is recorded from real outcomes.
  const o = createObjective({ objective: 'Learn', nodes: [{ id: 'a', prompt: 'do a' }] });
  const h = harness(o);
  h.advance();
  h.finish('a', { status: 'failed', error: 'wrong approach' });
  h.advance();
  h.finish('a');
  h.advance();
  assert.deepEqual(h.data.mission_learning.ENGINEERING.restate_with_evidence, { ok: 1, fail: 0 });
  // Protected invariants.
  const unauth = createObjective({ objective: 'Plan only', nodes: [{ id: 'a', prompt: 'think' }] });
  assert.equal(mutateObjective(unauth, [{ op: 'add_node', node: { id: 'b', prompt: 'edit code', kind: 'self_development' } }]).reason, 'owner_authorization_required');
  assert.equal(mutateObjective(unauth, [{ op: 'split_node', id: 'a', into: [{ id: 'x', prompt: 'x', kind: 'self_development' }, { id: 'y', prompt: 'y' }] }]).reason, 'owner_authorization_required');
  assert.equal(mutateObjective(unauth, [{ op: 'set_field', field: 'owner_authorized', value: true }]).reason, 'protected_field');
  assert.equal(unauth.owner_authorized, false);
  // An authorization failure is never auto-recovered, whatever the learning says.
  const auth = createObjective({ objective: 'Pay', nodes: [{ id: 'p', prompt: 'pay the bill' }] });
  const ha = harness(auth);
  ha.data.mission_learning = poisoned;
  ha.advance();
  ha.finish('p', { status: 'failed', error: 'Owner approval required for money actions.' });
  ha.advance();
  assert.equal(ha.node('p').status, 'failed');
  assert.equal(ha.node('p').recovery, 'needs_owner');
  assert.equal(ha.data.jobs.length, 1, 'nothing was retried behind the owner');
  assert.match(speakObjective(auth), /1 needs your approval/);
});

test('A16: a discovery miss widens the search, then checks routes/imports/tests, instead of rebuilding', () => {
  assert.equal(missionFailureKind({ status: 'failed', error: 'The source code was not provided.' }), 'DISCOVERY_MISS');
  assert.equal(missionFailureKind({ status: 'failed', error: 'Background model returned no result.' }), 'EMPTY_MODEL_RESPONSE');
  assert.equal(missionFailureKind({ status: 'failed', error: 'Retry limit reached; job moved to terminal dead-letter state.', dead_letter: true }), 'PROVIDER_UNAVAILABLE');
  assert.equal(missionFailureKind({ status: 'cancelled' }), 'CANCELLED');
  const o = createObjective({ objective: 'Fix mic', nodes: [{ id: 'find', prompt: 'Find the mic permission code' }] });
  const h = harness(o);
  h.advance();
  h.finish('find', { status: 'failed', error: 'could not find the microphone code in the repo' });
  h.advance();
  assert.match(h.data.jobs[1].prompt, /exact visible text, then exact symbol, route, imports, callers\/callees, tests/);
  h.finish('find', { status: 'failed', error: 'no matching file' });
  h.advance();
  assert.match(h.data.jobs[2].prompt, /List the routes, imports and tests that reference this feature first/);
  assert.match(h.data.jobs[2].prompt, /FAILED STRATEGIES \(do not repeat\)/);
});

test('A11 + A12: a replacement engine gets a compact structured slice; condensing at 70% keeps everything needed to resume', () => {
  const o = createObjective({ objective: 'Fix the microphone problem', constraints: ['do not touch che_browser.dart'], repo_sha: 'abc1234', owner_authorized: true, nodes: [
    { id: 'find', prompt: 'Find it' },
    { id: 'fix', prompt: 'Fix it', depends_on: ['find'], verify: ['mic test passes'], targets: ['lib/voice/mic.dart'] },
  ] });
  const h = harness(o);
  h.advance();
  h.finish('find', { result: 'Found in lib/voice/mic.dart. '.repeat(400) });
  h.advance();
  h.finish('fix', { status: 'failed', error: 'tests failed: mic_test' });
  h.advance();
  const ctx = nodeContext(o, h.node('fix'));
  for (const part of ['Fix it', 'VERIFICATION REQUIRED', 'mic test passes', 'VERIFIED RESULTS OF EARLIER STEPS', 'FAILED STRATEGIES', 'MISSION (owner objective; do not change it): Fix the microphone problem', 'do not touch che_browser.dart', 'abc1234']) assert.ok(ctx.includes(part), part);
  assert.ok(ctx.length < 6000, 'a slice, not the whole history');
  // Fill the mission state past 70% of its budget, then condense.
  for (let i = 0; i < 30; i += 1) o.events.push({ key: `k${i}`, type: 'noise', node_id: '', detail: 'x'.repeat(250), at: '' });
  const keep = JSON.stringify({ objective: o.objective, constraints: o.constraints, auth: o.owner_authorized, sha: o.repo_sha, graph: o.nodes.map((n) => [n.id, n.status, n.depends_on, n.fingerprints, n.failed_strategies, n.checkpoint, n.verify, n.prompt]) });
  const out = condenseObjective(o, { budgetTokens: 2000 });
  assert.equal(out.condensed, true);
  assert.ok(out.after < out.before);
  assert.equal(JSON.stringify({ objective: o.objective, constraints: o.constraints, auth: o.owner_authorized, sha: o.repo_sha, graph: o.nodes.map((n) => [n.id, n.status, n.depends_on, n.fingerprints, n.failed_strategies, n.checkpoint, n.verify, n.prompt]) }), keep, 'mission-critical state survives');
  assert.doesNotMatch(h.node('find').output, /\[condensed\]/, 'an output a pending step still reads is never shortened');
  h.finish('fix');
  h.advance();
  condenseObjective(o, { budgetTokens: 2000 });
  assert.match(h.node('find').output, /\[condensed\]$/, 'once consumed, finished output is condensed');
});

test('review fixes: events never orphan a running job; only verification evidence reopens a finished step; old event ids stay deduplicated; owner keeps his replans', () => {
  const o = createObjective({ objective: 'Fix X', nodes: [{ id: 'a', prompt: 'do a' }, { id: 'b', prompt: 'do b', depends_on: ['a'] }] });
  const h = harness(o);
  h.advance();
  assert.equal(applyMissionEvent(o, { id: 'r1', type: 'ci_failed', node_id: 'a' }).reason, 'step_running');
  assert.equal(mutateObjective(o, [{ op: 'add_verification', id: 'a', requirement: 'x' }]).reason, 'step_running');
  h.finish('a');
  h.advance();
  assert.equal(applyMissionEvent(o, { id: 'r2', type: 'task_failed', node_id: 'a' }).reason, 'step_complete');
  // Rejected mutation: no evidence is left behind.
  const before = JSON.stringify(o.nodes);
  assert.equal(applyMissionEvent(o, { id: 'r3', type: 'new_evidence', node_id: 'b', evidence: 'e', ops: [{ op: 'set_dependencies', id: 'b', depends_on: ['nope'] }] }).ok, false);
  assert.equal(JSON.stringify(o.nodes), before);
  // An old event id stays recognised after the visible log is trimmed.
  assert.equal(applyMissionEvent(o, { id: 'old-1', type: 'ci_passed' }).ok, true);
  for (let i = 0; i < 60; i += 1) applyMissionEvent(o, { id: `n${i}`, type: 'provider_degraded' });
  assert.equal(applyMissionEvent(o, { id: 'old-1', type: 'ci_passed' }).duplicate, true);
  // Automatic recovery does not use up the owner's replans.
  const p = createObjective({ objective: 'Y', nodes: [{ id: 'y', prompt: 'do y' }] });
  const hp = harness(p);
  hp.advance();
  for (let i = 0; i < 3; i += 1) { hp.finish('y', { status: 'failed', error: `wrong ${i}` }); hp.advance(); }
  assert.equal(hp.node('y').recovery, 'exhausted');
  assert.equal(replanNode(p, 'y', { prompt: 'owner idea 1' }).ok, true);
});

test('A7: a step CHE already knows from verified memory completes with zero model calls', async () => {
  const o = createObjective({ objective: 'Answer', nodes: [{ id: 'q', prompt: 'What is my locker number?' }, { id: 'r', prompt: 'Use it', depends_on: ['q'] }] });
  const h = harness(o);
  let lookups = 0;
  assert.equal(await resolveKnownNodes(h.data, async () => { lookups += 1; return { answer: 'Your locker number is 42, sir.', source: 'owner_memory', verified_at: 't' }; }), 1);
  assert.equal(lookups, 1);
  assert.equal(h.node('q').status, 'complete');
  assert.equal(h.node('q').verification.model_calls, 0);
  assert.equal(h.data.jobs.length, 0, 'no job, so no model call');
  h.advance();
  assert.deepEqual(h.data.jobs.map((j) => j.node_id), ['r']);
  assert.match(h.data.jobs[0].prompt, /locker number is 42/);
});
