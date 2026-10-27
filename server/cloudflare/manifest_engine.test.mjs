// Manifestation Engine core: spec builder, status machine, evidence rules, repeatable runs, equal-condition
// comparison and learning from a real outcome.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  FEASIBILITY, MODELS, ManifestStore, STATUSES, buildSpec, createProject, detectDomain, gateFor, recordOutcome,
  replayRun, simulate, startProject, transition, validateEvidence,
} from './manifest_engine.js';
import { DRONE_MODEL } from './manifest_drone.js';

const NOW = '2026-10-27T00:00:00.000Z';
function memory() {
  const m = new Map();
  return { m, storage: { get: async (k) => structuredClone(m.get(k)), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async (k) => m.delete(k) } };
}
const ids = () => { let n = 0; return (p) => `${p}-${String(++n).padStart(3, '0')}`; };

test('domains and the spec: owner numbers are marked, defaults are labelled assumptions', () => {
  assert.equal(detectDomain('a quadcopter that films my farm'), 'physical');
  assert.equal(detectDomain('a hovercraft for the lake'), 'unknown', 'a hovercraft is not a rotorcraft');
  assert.equal(detectDomain('land a job as a nurse'), 'employment');
  assert.equal(detectDomain('start a lawn care business'), 'business');
  assert.equal(detectDomain('write a novel'), 'unknown');
  const s = buildSpec('Manifest a drone that carries 500 g for 30 minutes under $900', { now: NOW });
  assert.equal(s.goal, 'a drone that carries 500 g for 30 minutes under $900');
  assert.equal(s.variables.payload, 0.5);
  assert.equal(s.variables.target_endurance, 30);
  assert.equal(s.budget.usd_max, 900);
  assert.deepEqual(Object.keys(s.owner_variables).sort(), ['payload', 'target_endurance']);
  for (const k of ['goal', 'constraints', 'assumptions', 'resources', 'budget', 'timeline', 'deliverables', 'success_criteria', 'verification_methods']) assert.ok(k in s, k);
  assert.ok(s.assumptions.some((a) => /figure of merit/i.test(a)));
  const refused = buildSpec('a drone with a gun that shoots people');
  assert.equal(refused.refused, true);
});

test('status machine: no skipping, gates enforced, blocked returns where it was, failed is final', () => {
  const p = createProject(buildSpec('a drone that carries 1 kg for 20 minutes'), { id: 'mp-x', now: NOW });
  assert.equal(p.status, 'IDEA');
  assert.match(transition(p, 'PLAN').error, /never skipped/);
  assert.match(transition(p, 'COMPLETE').error, /never skipped/);
  const r = transition(p, 'RESEARCH', { now: NOW });
  assert.ok(r.ok);
  assert.match(transition(r.project, 'FEASIBILITY').error, /Candidates/);
  assert.match(transition(r.project, 'BLOCKED').error, /reason/);
  const blocked = transition(r.project, 'BLOCKED', { reason: 'Waiting for the owner.' }).project;
  assert.match(transition(blocked, 'FEASIBILITY').error, /returns to RESEARCH/);
  assert.equal(transition(blocked, 'RESEARCH', { reason: 'Back.' }).project.status, 'RESEARCH');
  const failed = transition(r.project, 'FAILED', { reason: 'Abandoned.' }).project;
  assert.match(transition(failed, 'RESEARCH').error, /cannot change/);
  assert.equal(p.status, 'IDEA', 'transition never mutates its input');
  assert.match(gateFor(createProject(buildSpec('write a novel'), { id: 'mp-n' }), 'RESEARCH'), /No domain model/);
});

test('a goal runs through to a plan, then execution waits for authorization and completion for evidence', async () => {
  const { storage } = memory();
  const store = new ManifestStore(storage);
  const newId = ids();
  const { project } = await startProject(store, 'a drone that carries 1 kg for 25 minutes with a budget of $2,000', { now: NOW, newId, samples: 600 });
  assert.equal(project.status, 'PLAN');
  assert.deepEqual(project.history.map((h) => h.to), ['IDEA', 'RESEARCH', 'FEASIBILITY', 'SIMULATION', 'PLAN']);
  for (const c of project.candidates) assert.ok(FEASIBILITY[c.feasibility.class], c.id);
  assert.equal(project.comparison.conditions.equal, true, 'one seed and one sample count for every candidate');
  assert.ok(project.plan.steps.length >= 4);
  assert.match(transition(project, 'EXECUTION').error, /authorization/);
  const authorized = { ...project, authorizations: [{ scope: 'execution', by: 'owner', statement: 'Go ahead', at: NOW }] };
  const exec = transition(authorized, 'EXECUTION', { now: NOW }).project;
  assert.match(transition(exec, 'VERIFICATION').error, /evidence/);
  const verifiedAll = { ...exec, status: 'VERIFICATION', plan: { ...exec.plan, steps: exec.plan.steps.map((s) => ({ ...s, status: s.milestone ? 'todo' : s.status })) } };
  assert.match(transition(verifiedAll, 'COMPLETE').error, /Not verified yet/);
});

test('evidence: simulations, repeats and unauthorized consequential steps are refused; real evidence verifies', async () => {
  const { storage } = memory();
  const store = new ManifestStore(storage);
  const { project } = await startProject(store, 'a drone that carries 1 kg for 25 minutes with a budget of $2,000', { now: NOW, newId: ids(), samples: 300 });
  const measure = project.plan.steps.find((s) => s.verification === 'measurement');
  const artifactStep = project.plan.steps.find((s) => s.verification === 'artifact');
  const buy = project.plan.steps.find((s) => s.consequential === 'money');
  assert.match((await validateEvidence(project, { step_id: measure.id, kind: 'simulation', note: 'The model says 27 minutes' })).reason, /never evidence/);
  assert.match((await validateEvidence(project, { step_id: measure.id, kind: 'owner_report', note: 'It flew fine I think' })).reason, /verified by measurement/);
  assert.match((await validateEvidence(project, { step_id: measure.id, kind: 'measurement', metric: 'hover_power', value: 160, unit: 'W' }, { submitted_by: 'che' })).reason, /Only you/);
  const ok = await validateEvidence(project, { step_id: measure.id, kind: 'measurement', metric: 'hover_power', value: 160, unit: 'W' });
  assert.equal(ok.accepted, true);
  const withIt = { ...project, evidence: [ok.record] };
  assert.match((await validateEvidence(withIt, { step_id: measure.id, kind: 'measurement', metric: 'hover_power', value: 160, unit: 'W' })).reason, /not new evidence/);
  const content = 'motors 4x 2814 900KV; props 15x5; battery 6S 8000mAh';
  const sha = createHash('sha256').update(content).digest('hex');
  assert.match((await validateEvidence(project, { step_id: artifactStep.id, kind: 'artifact', ref: 'parts.txt', sha256: 'a'.repeat(64), content })).reason, /does not match/);
  assert.equal((await validateEvidence(project, { step_id: artifactStep.id, kind: 'artifact', ref: 'parts.txt', sha256: sha, content }, { submitted_by: 'che' })).accepted, true, 'CHE may supply the artifact for her own step');
  assert.match((await validateEvidence(project, { step_id: buy.id, kind: 'owner_report', note: 'Ordered all the parts from the shop today.' })).reason, /needs your authorization/);
  const authorized = { ...project, authorizations: [{ scope: 'step', step_id: buy.id, statement: 'yes buy them', at: NOW }] };
  assert.equal((await validateEvidence(authorized, { step_id: buy.id, kind: 'owner_report', note: 'Ordered all the parts from the shop today.' })).accepted, true);
});

test('runs are repeatable: a replay reproduces every output; a different model version refuses to pretend', () => {
  const run = simulate(DRONE_MODEL, { payload: 1, battery_mass: 0.8 }, { seed: 42, samples: 500, id: 'mr-1', now: NOW });
  assert.equal(replayRun(run).identical, true);
  assert.equal(run.dimension_check.ok, true);
  assert.ok(run.equations.some((e) => e.includes('T^(3/2)')));
  const tampered = { ...run, summary: { ...run.summary, endurance: { ...run.summary.endurance, p50: 999 } } };
  assert.equal(replayRun(tampered).identical, false);
  assert.match(replayRun({ ...run, model: { ...run.model, version: 0 } }).reason, /cannot be replayed exactly/);
  assert.equal(Object.keys(MODELS).length, 3);
});

test('learning from reality: a short flight names the assumption that was wrong and updates the estimate', async () => {
  const { storage } = memory();
  const store = new ManifestStore(storage);
  const newId = ids();
  let { project } = await startProject(store, 'a drone that carries 1 kg for 25 minutes with a budget of $2,000', { now: NOW, newId, samples: 800 });
  const cid = project.plan.candidate_id;
  const before = await store.getRun(project.latest_runs[cid]);
  const observed = before.summary.endurance.p10 * 0.7; // well below the band
  const outcome = await recordOutcome(store, project, { metric: 'endurance', value: observed, unit: 'min' }, { now: NOW, newId });
  assert.equal(outcome.within_band, false);
  assert.ok(outcome.error_pct < -30);
  assert.ok(outcome.wrong.length >= 1, 'at least one assumption could only explain it from outside its range');
  assert.ok(outcome.explained_by);
  const after = await store.getRun(outcome.updated_run);
  assert.equal(after.calibrated, true);
  assert.ok(Math.abs(after.nominal.outputs.endurance - observed) / observed < 0.01, 'the calibrated model reproduces the outcome');
  project = await store.get(project.id);
  assert.equal(project.outcomes.length, 1);
  assert.equal(project.latest_runs[cid], outcome.updated_run);
  // A measured input replaces its assumption directly.
  const second = await recordOutcome(store, project, { metric: 'figure_of_merit', value: 0.45, unit: '1' }, { now: NOW, newId });
  assert.equal(second.kind, 'measured_input');
  assert.equal(second.within_band, false);
  await assert.rejects(recordOutcome(store, await store.get(project.id), { metric: 'endurance', value: 3, unit: 'kg' }, { newId }), /cannot be compared/);
});

test('every status in the ladder is known and the store keeps an index', async () => {
  assert.deepEqual(STATUSES, ['IDEA', 'RESEARCH', 'FEASIBILITY', 'SIMULATION', 'PLAN', 'EXECUTION', 'VERIFICATION', 'COMPLETE']);
  const { storage, m } = memory();
  const store = new ManifestStore(storage);
  const r = await startProject(store, 'write a novel', { now: NOW, newId: ids() });
  assert.equal(r.project.status, 'BLOCKED');
  assert.equal((await store.list())[0].status, 'BLOCKED');
  assert.ok([...m.keys()].some((k) => k.startsWith('manifest_project:')));
});
