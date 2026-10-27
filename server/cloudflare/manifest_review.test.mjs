// PR #680 review findings, each pinned by a test.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ManifestStore, buildSpec, generateCandidates, recordOutcome, startProject, validateEvidence } from './manifest_engine.js';
import { briefing } from './manifest_record.js';
import { manifestScene } from './manifest_api.js';

const NOW = '2026-10-27T00:00:00.000Z';
function store() {
  const m = new Map();
  return { m, s: new ManifestStore({ get: async (k) => structuredClone(m.get(k)), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async (k) => m.delete(k) }) };
}
const ids = () => { let n = 0; return (p) => `${p}-${String(++n).padStart(4, '0')}`; };

test('finding 1: past the project limit nothing is deleted; creation is refused with a clear message', async () => {
  const { m, s } = store();
  const newId = ids();
  const first = (await startProject(s, 'a drone that carries 1 kg for 25 minutes', { now: NOW, newId, samples: 100 })).project;
  for (let i = 1; i < 30; i += 1) await startProject(s, `a drone that carries 1 kg for ${10 + i} minutes`, { now: NOW, newId, auto: false });
  const runKeys = [...m.keys()].filter((k) => k.startsWith('manifest_run:')).length;
  await assert.rejects(startProject(s, 'a drone that carries 2 kg for 20 minutes', { now: NOW, newId, auto: false }), (e) => e.status === 409 && /30 manifestation projects/.test(e.message) && /Nothing was deleted/.test(e.message));
  assert.ok(await s.get(first.id), 'the oldest project, with its runs, is still there');
  assert.equal([...m.keys()].filter((k) => k.startsWith('manifest_run:')).length, runKeys);
  assert.equal((await s.list()).length, 30);
});

test('finding 1: saving a project never deletes its run records', async () => {
  const { m, s } = store();
  const p = (await startProject(s, 'a drone that carries 1 kg for 25 minutes', { now: NOW, newId: ids(), samples: 50 })).project;
  for (let i = 0; i < 45; i += 1) p.runs.push({ id: `mr-x${i}`, kind: 'what_if', candidate_id: 'quad-10in' });
  for (let i = 0; i < 45; i += 1) m.set(`manifest_run:mr-x${i}`, { id: `mr-x${i}` });
  await s.put(p);
  assert.equal([...m.keys()].filter((k) => k.startsWith('manifest_run:mr-x')).length, 45);
});

test('finding 2: owner-supplied physical inputs reach every drone candidate; the battery is auto-sized only when not given', () => {
  const spec = buildSpec('a drone that carries 1 kg for 25 minutes', { overrides: { specific_energy: 400, figure_of_merit: 0.9, battery_mass: 2 } });
  for (const c of generateCandidates(spec)) {
    assert.equal(c.variables.specific_energy, 400, c.id);
    assert.equal(c.variables.figure_of_merit, 0.9, c.id);
    assert.equal(c.variables.battery_mass, 2, c.id);
    assert.equal(c.sources.specific_energy, 'owner_api');
  }
  const sized = generateCandidates(buildSpec('a drone that carries 1 kg for 25 minutes', { overrides: { specific_energy: 400 } }));
  assert.ok(sized.every((c) => c.variables.specific_energy === 400 && c.variables.battery_mass !== 2));
});

test('finding 3: after an outcome recalibrates, the comparison, plan, briefing and scene use the new forecast', async () => {
  const { s } = store();
  const newId = ids();
  const p = (await startProject(s, 'Find a new job as a data analyst within 4 months, 15 hours a week', { now: NOW, newId, samples: 400 })).project;
  const cid = p.plan.candidate_id;
  const before = p.comparison.rows.find((r) => r.candidate_id === cid).primary.p50;
  p.plan.steps[0].status = 'verified';
  await s.put(p);
  const outcome = await recordOutcome(s, p, { metric: 'response_rate', value: 0.02, unit: '1' }, { now: NOW, newId });
  const after = await s.get(p.id);
  const row = after.comparison.rows.find((r) => r.candidate_id === cid);
  assert.equal(row.run_id, outcome.updated_run);
  assert.ok(row.primary.p50 < before, `${row.primary.p50} < ${before}`);
  assert.equal(after.plan.run_id, outcome.updated_run);
  assert.equal(after.plan.expected.p_offer_by_target.p50, row.primary.p50);
  assert.equal(after.plan.steps[0].status, 'verified', 'execution progress is kept');
  const p50 = Number(row.primary.p50.toPrecision(3));
  assert.match(briefing(after).spoken, new RegExp(`most likely ${String(p50).replace('.', '\\.')}`));
  assert.equal(manifestScene(after).latest_result.forecast.likely, row.primary.p50);
});

test('finding 4: measurement evidence must match the step\'s metric and units', async () => {
  const { s } = store();
  const p = (await startProject(s, 'a drone that carries 1 kg for 25 minutes', { now: NOW, newId: ids(), samples: 100 })).project;
  const flight = p.plan.steps.find((st) => st.metric === 'endurance');
  const wrong = await validateEvidence(p, { step_id: flight.id, kind: 'measurement', metric: 'temperature', value: 22, unit: 'C' });
  assert.equal(wrong.accepted, false);
  assert.match(wrong.reason, /endurance/);
  const badUnit = await validateEvidence(p, { step_id: flight.id, kind: 'measurement', metric: 'endurance', value: 22, unit: 'kg' });
  assert.equal(badUnit.accepted, false);
  assert.match(badUnit.reason, /cannot be compared|units/);
  assert.equal((await validateEvidence(p, { step_id: flight.id, kind: 'measurement', metric: 'endurance', value: 0.4, unit: 'h' })).accepted, true);
  const bench = p.plan.steps.find((st) => /thrust stand/.test(st.title));
  assert.equal((await validateEvidence(p, { step_id: bench.id, kind: 'measurement', metric: 'temperature', value: 22, unit: 'C' })).accepted, false);
  assert.equal((await validateEvidence(p, { step_id: bench.id, kind: 'measurement', metric: 'hover_power', value: 500, unit: 'W' })).accepted, true);
});
