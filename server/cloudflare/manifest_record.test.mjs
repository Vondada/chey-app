// Manifestation Engine: the owner's ten additions (2026-10-27). One record per idea with claim provenance,
// pre-registered tests judged against the original, ranges with drivers, the cheapest test first, a visible
// track-record correction, approval gates where steps start, the spoken briefing, pause/resume/stop and the
// weekly review on request, and dated data sources with "no data source" instead of invented numbers.
import assert from 'node:assert/strict';
import test from 'node:test';
import { MODELS, ManifestStore, gateFor, recordOutcome, replayRun, startProject, transition } from './manifest_engine.js';
import { controlProject, manifestIntent, manifestScene } from './manifest_api.js';
import {
  PROVENANCE, amendPreregistration, biasOf, briefing, dataSourcesWithAge, judge, loadTrackRecord, setStepStatus, weeklyReview, whyClaim,
} from './manifest_record.js';
import { DRONE_MODEL } from './manifest_drone.js';

const NOW = '2026-10-27T00:00:00.000Z';
function store() {
  const m = new Map();
  return new ManifestStore({ get: async (k) => structuredClone(m.get(k)), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async (k) => m.delete(k) });
}
const ids = () => { let n = 0; return (p) => `${p}-${String(++n).padStart(3, '0')}`; };
const DRONE = 'a drone that carries 1 kg for 25 minutes with a budget of $2,000';

test('1. one record per idea: every number carries its provenance and "why" is answered from the record', async () => {
  const s = store();
  const { project } = await startProject(s, 'a flying car for 2 people that flies for 1 hour', { now: NOW, newId: ids(), samples: 300 });
  const kinds = new Set(project.claims.map((c) => c.provenance));
  for (const k of ['sourced', 'assumed', 'calculated', 'simulated']) assert.ok(kinds.has(k), k);
  assert.ok(project.claims.every((c) => PROVENANCE[c.provenance] && c.basis && c.stage));
  const payload = whyClaim(project, 'payload');
  assert.match(payload.spoken, /you said "2 people"/);
  const energy = whyClaim(project, 'quad-road battery energy density needed');
  assert.match(energy.spoken, /calculated with e_needed = e · t_target/);
  const forecast = whyClaim(project, 'quad-road hover endurance');
  assert.match(forecast.spoken, /simulated by multirotor_hover version 1, run mr-\d+, seed \d+, 300 samples/);
  assert.match(whyClaim(project, 'unicorn horsepower').spoken, /no recorded claim/);
});

test('2. pre-registered tests: written at FEASIBILITY, amendments appended, judged against the original', async () => {
  const s = store();
  const newId = ids();
  let { project } = await startProject(s, DRONE, { now: NOW, newId, samples: 300 });
  const pre = project.preregistration;
  assert.equal(pre.recorded_at, NOW);
  assert.deepEqual(pre.original.success_test, { metric: 'endurance', op: '>=', value: 25, unit: 'min', text: 'Measured hover endurance at least 25 minutes with the payload.' });
  assert.match(pre.original.stop_rule, /stop before buying/);
  assert.match(gateFor({ ...project, status: 'FEASIBILITY', preregistration: null }, 'SIMULATION'), /pre-registered/);
  amendPreregistration(project, { field: 'success_test', text: 'At least 20 minutes is enough.', reason: 'Owner relaxed the goal.' });
  assert.equal(project.preregistration.original.success_test.value, 25, 'the original never changes');
  assert.equal(project.preregistration.amendments.length, 1);
  assert.throws(() => amendPreregistration(project, { field: 'success_test', text: 'x' }), /reason/);
  await s.put(project);
  // A real 22-minute flight passes the amendment but fails the original: VERIFICATION judges the original.
  const outcome = await recordOutcome(s, project, { metric: 'endurance', value: 22, unit: 'min' }, { now: NOW, newId });
  assert.equal(outcome.preregistered.success, false);
  assert.equal(outcome.preregistered.failure_triggered, true);
  project = await s.get(project.id);
  const done = { ...project, status: 'VERIFICATION', plan: { ...project.plan, steps: project.plan.steps.map((st) => ({ ...st, status: 'verified' })) } };
  assert.match(transition(done, 'COMPLETE').error, /does not meet the pre-registered success test/);
  await recordOutcome(s, project, { metric: 'endurance', value: 26, unit: 'min' }, { now: NOW, newId });
  const after = await s.get(project.id);
  assert.equal(judge(after).success, true);
  assert.ok(transition({ ...after, status: 'VERIFICATION', plan: done.plan }, 'COMPLETE').ok);
});

test('3 and 4. ranges with their drivers, and the cheapest test of the riskiest assumption before PLAN', async () => {
  const s = store();
  const { project } = await startProject(s, DRONE, { now: NOW, newId: ids(), samples: 400 });
  const run = await s.getRun(project.latest_runs[project.comparison.best]);
  assert.equal(run.forecast.coverage, 0.8);
  assert.ok(run.forecast.low < run.forecast.likely && run.forecast.likely < run.forecast.high);
  assert.ok(run.drivers.length >= 1 && run.drivers.length <= 2);
  assert.ok(run.drivers[0].swing >= (run.drivers[1]?.swing ?? 0));
  assert.equal(replayRun(run).identical, true, 'drivers are part of the repeatable run');
  assert.ok(project.history.findIndex((h) => h.to === 'PLAN') > 0);
  assert.equal(project.first_test.assumption, run.drivers[0].input);
  assert.ok(project.first_test.title && project.first_test.instructions.length);
  assert.equal(project.first_test.cost, null, 'no price data source, so no invented cost');
  assert.match(gateFor({ ...project, status: 'SIMULATION', first_test: null }, 'PLAN'), /cheapest real-world test/);
  const job = (await startProject(s, 'Find a new job as a data analyst within 4 months, 15 hours a week', { now: NOW, newId: ids(), samples: 300 })).project;
  assert.equal(job.first_test.measures, 'response_rate');
});

test('5. the model\'s track record from real outcomes is applied as a visible correction', async () => {
  const s = store();
  const newId = ids();
  const first = (await startProject(s, DRONE, { now: NOW, newId, samples: 300 })).project;
  const run = await s.getRun(first.latest_runs[first.plan.candidate_id]);
  await recordOutcome(s, first, { metric: 'endurance', value: run.summary.endurance.p50 * 0.8, unit: 'min' }, { now: NOW, newId });
  const track = await loadTrackRecord(s.storage, DRONE_MODEL);
  assert.equal(track.by_metric.endurance.n, 1);
  assert.ok(Math.abs(biasOf(track).endurance.factor - 0.8) < 1e-3);
  const second = (await startProject(s, DRONE, { now: NOW, newId, samples: 300 })).project;
  const r2 = await s.getRun(second.latest_runs[second.plan.candidate_id]);
  const bc = r2.bias_correction.endurance;
  assert.equal(bc.n, 1);
  assert.ok(Math.abs(bc.corrected.likely - r2.summary.endurance.p50 * bc.factor) < 0.01 * r2.summary.endurance.p50);
  assert.match(bc.note, /optimistic by a factor of 0.8/);
  assert.ok(r2.summary.endurance.p50 > bc.corrected.likely, 'the raw forecast stays as it was');
  assert.equal(replayRun(r2).identical, true);
});

test('6. a consequential step cannot start running without a recorded owner approval', async () => {
  const s = store();
  const { project } = await startProject(s, DRONE, { now: NOW, newId: ids(), samples: 300 });
  const buy = project.plan.steps.find((st) => st.consequential === 'money');
  assert.equal(buy.approval_required, true);
  assert.equal(project.plan.steps.find((st) => st.verification === 'measurement').approval_required, false);
  assert.match(setStepStatus(project, buy.id, 'running').error, /after execution is authorized/);
  const exec = transition({ ...project, authorizations: [{ scope: 'execution', by: 'owner', statement: 'go', at: NOW }] }, 'EXECUTION', { now: NOW }).project;
  const refused = setStepStatus(exec, buy.id, 'running');
  assert.equal(refused.ok, false);
  assert.equal(refused.approval_required, true);
  assert.equal(exec.plan.steps.find((st) => st.id === buy.id).status, 'todo');
  assert.match(setStepStatus(exec, buy.id, 'verified').error, /only through evidence/);
  exec.authorizations.push({ scope: 'step', step_id: buy.id, by: 'owner', statement: 'yes, buy them', at: NOW });
  assert.equal(setStepStatus(exec, buy.id, 'running').ok, true);
  assert.equal(exec.plan.steps.find((st) => st.id === buy.id).status, 'running');
});

test('8 and 9. briefing with range, blocker, pending approval and numbered options; the room never animates by itself', async () => {
  const s = store();
  const { project } = await startProject(s, DRONE, { now: NOW, newId: ids(), samples: 300 });
  const b = briefing(project);
  assert.match(b.spoken, /Stage: PLAN\./);
  assert.match(b.spoken, /most likely [\d.]+ min, between [\d.]+ and [\d.]+ \(80% range\)/);
  assert.match(b.spoken, /Waiting for your approval: step \d, Buy the parts, cost unknown, no price data source\./);
  assert.match(b.spoken, /Options: 1\. Run the cheapest test first: /);
  assert.ok(b.options.some((o) => /^Pause it/.test(o)));
  const scene = manifestScene(project);
  assert.equal(scene.activity.animate, false);
  assert.equal(scene.activity.working, false);
  assert.equal(scene.latest_result.candidate_id, project.comparison.best);
  assert.ok(scene.first_test.title);
  assert.equal(scene.preregistration.amendments, 0);
});

test('pause, resume and stop by voice; the weekly review only when asked', async () => {
  for (const [said, kind] of [['Pause manifestation project 2', 'control'], ['manifest pause 1', 'control'], ['Kill my manifestation project', 'control'], ['Brief me on my manifestation projects', 'brief'],
    ['manifest briefing 2', 'brief'], ['Manifestation weekly review', 'review'], ['manifest why endurance', 'why'], ['Manifest a drone for 20 minutes', 'create']]) {
    assert.equal(manifestIntent(said)?.kind, kind, said);
  }
  assert.equal(manifestIntent('Pause the music'), null);
  assert.equal(manifestIntent('give me my weekly review'), null, 'a review without the engine\'s name is not this one');
  assert.equal(manifestIntent('Kill my manifestation project').action, 'stop');
  const s = store();
  const { project } = await startProject(s, DRONE, { now: NOW, newId: ids(), samples: 300 });
  const paused = controlProject(project, 'pause', NOW).project;
  assert.equal(paused.status, 'BLOCKED');
  assert.equal(paused.paused, true);
  assert.equal(controlProject(paused, 'resume', NOW).project.status, 'PLAN');
  const stopped = controlProject(project, 'stop', NOW).project;
  assert.equal(stopped.status, 'FAILED');
  assert.equal(controlProject(stopped, 'resume').ok, false);
  const review = weeklyReview([stopped], '2026-10-28T00:00:00.000Z');
  assert.match(review.spoken, /now FAILED, moved IDEA to RESEARCH/);
  assert.match(weeklyReview([stopped], '2026-12-30T00:00:00.000Z').spoken, /Nothing changed/);
});

test('10. every model lists dated data sources; where none is wired it says so and produces no number', () => {
  for (const m of Object.values(MODELS)) {
    const ds = dataSourcesWithAge(m, NOW);
    assert.ok(ds.length >= 3, m.id);
    assert.ok(ds.some((d) => d.kind === 'none' && d.source === 'no data source'), `${m.id} names what it has no data for`);
    assert.ok(ds.filter((d) => d.kind !== 'none' && d.kind !== 'owner').every((d) => d.as_of), m.id);
  }
  assert.ok(dataSourcesWithAge(DRONE_MODEL, '2028-01-01T00:00:00Z').find((d) => d.id === 'battery_packs').stale, 'stale data is flagged');
  assert.equal(DRONE_MODEL.outputs.some((o) => /cost/.test(o.id)), false, 'no cost figure without a price source');
  const budget = DRONE_MODEL.evaluate({ ...Object.fromEntries(DRONE_MODEL.inputs.map((i) => [i.id, i.nominal])), budget: 500 }).checks.find((c) => c.id === 'budget');
  assert.equal(budget.ok, null);
  assert.match(budget.text, /no part-price data source/);
});
