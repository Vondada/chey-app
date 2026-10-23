import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeAgent, queueAgentTask } from './agent_runtime.js';
import { ensureLaAgenciaRoster } from './office_company.js';
import { acceptanceChecks, advanceOfficeJobs, disciplinesFor, officeJobView, planOfficeJob, speakOfficeJob } from './office_jobs.js';

function office() {
  const data = { team: [], team_tasks: [], office_goals: [] };
  ensureLaAgenciaRoster(data);
  data.team.forEach(normalizeAgent);
  const hooks = { queueStep: (agent, text, options) => queueAgentTask(data, agent, text, 'office_job', options), blocker: () => '' };
  return { data, hooks };
}

// What CHE's review does when it approves a stage's result (agent_runtime.reviewDelegatedResult). The end-to-end test
// in office_api.test.mjs runs the real runtime and review instead.
function finish(data, job, discipline, result) {
  const stage = job.stages.find((s) => s.discipline === discipline && s.status === 'running');
  assert.ok(stage, `${discipline} is running`);
  Object.assign(data.team_tasks.find((t) => t.id === stage.task_id), { status: 'complete', result, updated_at: new Date().toISOString() });
}

const FEATURE = 'Improve the Trading Room chart: a cleaner layout, the engineering change, a security review and testing';

test('Test E: Nova plans design → engineering → security → verification with one accountable owner', () => {
  assert.deepEqual(disciplinesFor(FEATURE), ['experience', 'engineering', 'security', 'qa']);
  const { data } = office();
  const { job } = planOfficeJob(data, { request: FEATURE });
  assert.match(job.id, /^oj-[0-9a-f]{8}$/);
  assert.equal(job.coordinator, 'Nova');
  assert.equal(job.accountable, 'Atlas', 'engineering owns the outcome');
  assert.deepEqual(job.stages.map((s) => s.agent), ['Iris', 'Atlas', 'Knox', 'Vale']);
  assert.deepEqual(job.supporting, ['Iris', 'Knox', 'Vale']);
  assert.ok(job.acceptance_criteria.length >= 1);
  assert.equal(job.verification.status, 'unverified');
  assert.equal(data.office_goals.at(-1), job, 'the job is an Office goal, not a second store');
  assert.ok(job.rollback && job.tools_required.length && job.permissions_required.length);
  assert.equal(job.cost.measured, null, 'cost is not invented');
});

test('Test E: every handoff is recorded, accepted by its receiver, carries the work so far, and Vale verifies last', () => {
  const { data, hooks } = office();
  const { job } = planOfficeJob(data, { request: FEATURE, acceptance_criteria: ['The chart keeps one size when data loads', 'Every new button has a VoiceOver label'] });
  assert.equal(advanceOfficeJobs(data, hooks), true);
  assert.equal(job.handoffs[0].from_agent_name, 'Nova');
  assert.equal(job.handoffs[0].to_agent_name, 'Iris');
  assert.equal(job.handoffs[0].accepted, true);
  assert.ok(job.handoffs[0].checks.every((c) => c.ok));
  assert.equal(advanceOfficeJobs(data, hooks), false, 'nothing moves while Iris works');

  finish(data, job, 'experience', 'Layout: chart on top, one fixed height, labels on every control.');
  advanceOfficeJobs(data, hooks);
  const atlasTask = data.team_tasks.find((t) => t.id === job.stages[1].task_id);
  assert.equal(atlasTask.partner_name, 'Atlas');
  assert.match(atlasTask.task, /Iris \(experience, task [^)]+\): Layout: chart on top/, 'the design travels with the handoff');
  assert.equal(atlasTask.handoffs[0].from_agent_name, 'Iris', 'the Brain sees the collaboration');
  assert.equal(atlasTask.office_job_id, job.id);

  finish(data, job, 'engineering', 'Plan: change che_trading_chart.dart; add a widget test.');
  advanceOfficeJobs(data, hooks);
  finish(data, job, 'security', 'Reviewed the plan: no new permissions, no secrets.');
  advanceOfficeJobs(data, hooks);
  const valeTask = data.team_tasks.find((t) => t.id === job.stages[3].task_id);
  assert.equal(valeTask.partner_name, 'Vale');
  assert.match(valeTask.task, /VERDICT: PASS/);
  assert.match(valeTask.task, /Every new button has a VoiceOver label/);
  assert.equal(job.workflow_stage, 'verify');

  finish(data, job, 'qa', 'VERDICT: PASS\n1. met: fixed height in the plan.\n2. met: labels listed.');
  advanceOfficeJobs(data, hooks);
  assert.equal(job.status, 'verified');
  assert.equal(job.verification.by, 'Vale');
  assert.equal(job.workflow_stage, 'remember');
  assert.deepEqual(job.handoffs.map((h) => `${h.from_agent_name}->${h.to_agent_name}`), ['Nova->Iris', 'Iris->Atlas', 'Atlas->Knox', 'Knox->Vale']);
  assert.equal(job.evidence.length, 4);
  assert.match(speakOfficeJob(job), /^CHE here\. Office job oj-[0-9a-f]{8}: verified\. Nova coordinates; Atlas is accountable\./);
  assert.ok(officeJobView(job).history.length >= 6);
});

test('a receiver that cannot take the work refuses the handoff; the job waits and is escalated, then resumes once fixed', () => {
  const { data, hooks } = office();
  let codex = false;
  const blocked = { ...hooks, blocker: (agent) => (agent.name === 'Atlas' && !codex ? 'Blocked: tool not configured (Codex)' : '') };
  const { job } = planOfficeJob(data, { request: FEATURE });
  advanceOfficeJobs(data, blocked);
  finish(data, job, 'experience', 'Layout done.');
  advanceOfficeJobs(data, blocked);
  const refused = job.handoffs.at(-1);
  assert.equal(refused.to_agent_name, 'Atlas');
  assert.equal(refused.accepted, false);
  assert.match(refused.note, /Codex/);
  assert.equal(job.status, 'waiting');
  assert.equal(job.stages[1].task_id, null, 'no task is queued for a refused handoff');
  assert.match(job.history.at(-1).detail, /Escalated to CHE/);
  const before = job.history.length;
  assert.equal(advanceOfficeJobs(data, blocked), false);
  assert.equal(job.history.length, before, 'a waiting job does not fill its history');
  codex = true;
  assert.equal(advanceOfficeJobs(data, blocked), true);
  assert.equal(job.handoffs.at(-1).accepted, true);
  assert.equal(job.status, 'running');
});

test('Vale failing the work sends it back to the accountable owner once; a second failure is reported, never verified', () => {
  const { data, hooks } = office();
  const { job } = planOfficeJob(data, { request: FEATURE });
  advanceOfficeJobs(data, hooks);
  for (const [d, r] of [['experience', 'Layout.'], ['engineering', 'Plan v1.'], ['security', 'Reviewed.']]) { finish(data, job, d, r); advanceOfficeJobs(data, hooks); }
  finish(data, job, 'qa', 'VERDICT: FAIL\n1. not met: no fixed height.');
  advanceOfficeJobs(data, hooks);
  assert.equal(job.corrections, 1);
  assert.ok(job.history.some((h) => h.event === 'verification failed' && h.stage === 'correct'), 'the Correct step is recorded');
  const redo = data.team_tasks.find((t) => t.id === job.stages[1].task_id);
  assert.equal(redo.partner_name, 'Atlas');
  assert.match(redo.task, /CORRECTION REQUESTED BY VALE:\nVERDICT: FAIL/);
  assert.equal(job.stages[0].status, 'complete', 'finished earlier work is kept');
  for (const [d, r] of [['engineering', 'Plan v2.'], ['security', 'Reviewed again.']]) { finish(data, job, d, r); advanceOfficeJobs(data, hooks); }
  finish(data, job, 'qa', 'VERDICT: FAIL\n1. still not met.');
  advanceOfficeJobs(data, hooks);
  assert.equal(job.status, 'failed');
  assert.equal(job.verification.status, 'failed');
  assert.match(speakOfficeJob(job), /Vale did not verify it/);
});

test('a Vale answer with no verdict is not a verification', () => {
  const { data, hooks } = office();
  const { job } = planOfficeJob(data, { request: 'Research brass lamp suppliers' });
  assert.deepEqual(job.stages.map((s) => s.agent), ['Mira', 'Vale']);
  advanceOfficeJobs(data, hooks);
  finish(data, job, 'research', 'Three suppliers with sources.');
  advanceOfficeJobs(data, hooks);
  finish(data, job, 'qa', 'Looks good to me.');
  advanceOfficeJobs(data, hooks);
  assert.equal(job.verification.status, 'unverified');
  assert.equal(job.status, 'failed');
});

test('two jobs on the same target: one accountable owner, the second waits for the first', () => {
  const { data, hooks } = office();
  const first = planOfficeJob(data, { request: FEATURE, targets: ['lib/trading/che_trading_chart.dart'] }).job;
  const second = planOfficeJob(data, { request: 'Fix the chart legend', targets: ['lib/trading/che_trading_chart.dart'] }).job;
  assert.equal(second.collision.with, first.id);
  assert.equal(second.collision.accountable, 'Atlas');
  assert.ok(second.depends_on.includes(first.id));
  advanceOfficeJobs(data, hooks);
  assert.ok(first.stages[0].task_id, 'the first job started');
  assert.equal(second.stages[0].task_id, null, 'the second waits');
  first.status = 'verified';
  advanceOfficeJobs(data, hooks);
  assert.ok(second.stages[0].task_id, 'it starts once the first is done');
});

test('acceptance checks: the receiver must head that department and earlier stages must be finished', () => {
  const { data } = office();
  const { job } = planOfficeJob(data, { request: FEATURE });
  const atlasStage = job.stages[1];
  const early = acceptanceChecks(data, job, atlasStage);
  assert.equal(early.accepted, false);
  assert.equal(early.checks.find((c) => c.check === 'earlier stages finished').ok, false);
  const wrong = acceptanceChecks(data, job, { ...atlasStage, agent: 'Lyra', depends_on: [] });
  assert.equal(wrong.checks.find((c) => c.check === 'heads engineering').ok, false);
});

test('an unclear request still gets research and verification; nothing is planned without a request', () => {
  const { data } = office();
  assert.match(planOfficeJob(data, { request: '' }).error, /Describe the work/);
  assert.deepEqual(disciplinesFor('Handle the lamp thing'), ['research', 'qa']);
  assert.deepEqual(disciplinesFor('Make a launch video for the lamp store'), ['creative', 'qa']);
});
