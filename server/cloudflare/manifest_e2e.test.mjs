// Manifestation Engine end to end through the real Worker (offline, fake model, in-memory Durable Object storage).
// Three fixtures, one per domain: request → spec → candidates → model → variable change → simulation →
// comparison → plan → evidence record, plus the Simulation Room scene and an exact replay.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';

globalThis.fetch = async (input) => { throw new TypeError(`fetch failed (offline test: ${new URL(String(input?.url || input)).host})`); };
const generated = new URL('./.manifest_e2e.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

function storageFor(saved) {
  return {
    get: async (key) => Array.isArray(key) ? new Map(key.filter((k) => saved.has(k)).map((k) => [k, structuredClone(saved.get(k))])) : saved.has(key) ? structuredClone(saved.get(key)) : undefined,
    put: async (key, value) => {
      if (key && typeof key === 'object') { for (const [k, v] of Object.entries(key)) saved.set(k, structuredClone(v)); return; }
      saved.set(key, structuredClone(value));
    },
    delete: async (key) => saved.delete(key),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {}, deleteAlarm: async () => {},
  };
}

async function owner() {
  const saved = new Map();
  let modelCalls = 0;
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => { modelCalls += 1; return { response: 'model' }; } } };
  const state = new CheState({ storage: storageFor(saved), waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token, method = 'POST') => worker.fetch(new Request(`https://che.example${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(body || {}) } : {}),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const call = async (method, path, body) => { const res = await send(path, body, token, method); return { status: res.status, body: await res.json() }; };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), anon: (p) => send(p, null, '', 'GET'), saved, models: () => modelCalls };
}

const P = (id, tail = '') => `/api/manifest/projects/${id}${tail}`;

test('fixture 1, physical: a 1 kg delivery drone from request to a verified bench measurement', async () => {
  const che = await owner();
  const spec = await che.post('/api/manifest/spec', { request: 'Manifest a drone that carries 1 kg for 25 minutes with a budget of $2,000' });
  assert.equal(spec.status, 200);
  assert.equal(spec.body.spec.domain, 'physical');
  assert.equal(spec.body.spec.model.id, 'multirotor_hover');

  const created = await che.post('/api/manifest/projects', { request: 'a drone that carries 1 kg for 25 minutes with a budget of $2,000', auto: false });
  assert.equal(created.status, 201);
  assert.equal(created.body.project.status, 'IDEA');
  const id = created.body.project.id;
  const advanced = await che.post(P(id, '/advance'));
  assert.equal(advanced.body.project.status, 'PLAN');
  const { candidates, comparison } = (await che.get(P(id, '/candidates'))).body;
  assert.equal(candidates.length, 4);
  assert.ok(candidates.every((c) => c.feasibility.class && c.evidence.some((e) => e.kind === 'reference')));
  const best = comparison.best;

  // Variable change: a what-if run with 2 kg of payload, then an adopted change re-runs everyone equally.
  const base = (await che.get(`/api/manifest/runs/${advanced.body.project.latest_runs[best]}`)).body.run;
  const whatIf = (await che.post(P(id, '/simulate'), { candidate_id: best, variables: { payload: 2 } })).body.run;
  assert.equal(whatIf.kind, 'what_if');
  assert.ok(whatIf.summary.endurance.p50 < base.summary.endurance.p50);
  const adopted = await che.post(P(id, '/simulate'), { candidate_id: best, variables: { battery_mass: base.inputs.battery_mass * 1.2 }, adopt: true });
  assert.equal(adopted.status, 200);
  assert.equal(adopted.body.comparison.conditions.equal, true);

  const swept = await che.post(P(id, '/sweep'), { candidate_id: best, variable: 'payload', from: 0, to: 2, steps: 5 });
  assert.equal(swept.status, 200, JSON.stringify(swept.body));
  const { sweep } = swept.body;
  assert.equal(sweep.rows.length, 5);
  const sens = (await che.post(P(id, '/sensitivity'), { candidate_id: best })).body.sensitivity;
  assert.equal(sens.output, 'endurance');
  const cmp = (await che.post(P(id, '/compare'))).body.comparison;
  assert.ok(cmp.rows.length === 4 && cmp.conditions.equal);
  const plan = (await che.post(P(id, '/plan'), { candidate_id: cmp.best })).body.plan;
  assert.ok(plan.steps.some((s) => s.consequential === 'money'));

  assert.equal((await che.post(P(id, '/status'), { to: 'EXECUTION' })).status, 409, 'execution needs a yes');
  assert.equal((await che.post(P(id, '/status'), { to: 'EXECUTION', authorization: { statement: 'Yes, start building it' } })).body.project.status, 'EXECUTION');
  const bench = plan.steps.find((s) => /thrust stand/.test(s.title));
  const fake = await che.post(P(id, '/evidence'), { step_id: bench.id, kind: 'simulation', note: 'The model predicts it' });
  assert.equal(fake.status, 422);
  const real = await che.post(P(id, '/evidence'), { step_id: bench.id, kind: 'measurement', metric: 'hover_power', value: 700, unit: 'W' });
  assert.equal(real.status, 200);
  assert.equal(real.body.step.status, 'verified');
  assert.equal(real.body.outcome.metric, 'hover_power');
  assert.ok(real.body.outcome.updated_run, `the measurement recalibrated the model: ${JSON.stringify(real.body.outcome)}`);
  assert.equal(real.body.status, 'VERIFICATION', 'evidence moved it one status, through the gate');

  const scene = (await che.get(P(id, '/scene'))).body.scene;
  assert.equal(scene.room.id, 'simulation');
  const objs = scene.objects.filter((o) => o.kind === 'candidate');
  assert.equal(objs.length, 4);
  assert.ok(objs.every((o) => o.field.y >= 0 && o.field.y <= 1 && o.spoken.length > 10));
  assert.equal(scene.stations[0].agent, 'Atlas');
  assert.equal(scene.stations[0].task_id, null);

  const runId = (await che.get(P(id))).body.project.latest_runs[cmp.best];
  assert.equal((await che.post(`/api/manifest/runs/${runId}/replay`)).body.identical, true);
  assert.equal(che.models(), 0, 'no model call anywhere');
});

test('fixture 2, business: a car detailing business with the owner\'s numbers, a price change and a pilot month', async () => {
  const che = await owner();
  const created = await che.post('/api/manifest/projects', { request: 'Start a mobile car detailing business: charge $120 per car, supplies $25 per car, insurance $300 a month, $2,500 to start, 12 customers in the first month, earn $1,000 a month within 6 months with $5,000' });
  const p = created.body.project;
  assert.equal(p.status, 'PLAN');
  assert.equal(p.spec.model.id, 'unit_economics_cashflow');
  assert.equal(p.plan.candidate_id, p.comparison.best);
  const run = (await che.get(`/api/manifest/runs/${p.latest_runs[p.comparison.best]}`)).body.run;
  assert.ok(run.summary.final_cash.p10 < run.summary.final_cash.p90, 'a range');
  const cheaper = (await che.post(P(p.id, '/simulate'), { candidate_id: 'as-planned', variables: { price: 90 } })).body.run;
  assert.ok(cheaper.nominal.outputs.breakeven_units > run.nominal.outputs.breakeven_units * 0 && cheaper.nominal.outputs.unit_contribution === 65);
  const sens = (await che.post(P(p.id, '/sensitivity'), { candidate_id: 'as-planned', output: 'final_cash' })).body.sensitivity;
  assert.ok(sens.rows[0].swing >= sens.rows.at(-1).swing);
  await che.post(P(p.id, '/status'), { to: 'EXECUTION', authorization: { statement: 'Go' } });
  const pilot = p.plan.steps.find((s) => s.metric === 'units_month1');
  const ev = await che.post(P(p.id, '/evidence'), { step_id: pilot.id, kind: 'measurement', metric: 'units_month1', value: 3, unit: 'item/month', note: 'Three cars in October.' });
  assert.equal(ev.body.accepted, true);
  assert.equal(ev.body.outcome.kind, 'measured_input');
  assert.equal(ev.body.outcome.within_band, false, '3 is below the assumed 4.8–19.2 around the owner\'s 12');
  assert.ok(ev.body.outcome.updated_estimate.final_cash.p50 < run.summary.final_cash.p50, 'the estimate drops');
  const spend = p.plan.steps.find((s) => s.consequential === 'money');
  assert.match((await che.post(P(p.id, '/evidence'), { step_id: spend.id, kind: 'owner_report', note: 'Bought the pressure washer and supplies.' })).body.reason, /authorization/);
  await che.post(P(p.id, '/authorize'), { step_id: spend.id, statement: 'Yes, spend it' });
  assert.equal((await che.post(P(p.id, '/evidence'), { step_id: spend.id, kind: 'owner_report', note: 'Bought the pressure washer and supplies.' })).body.accepted, true);
  assert.equal((await che.get(P(p.id))).body.project.status, 'VERIFICATION');
});

test('fixture 3, employment: a job search whose real reply rate lowers the odds and the plan says so', async () => {
  const che = await owner();
  const p = (await che.post('/api/manifest/projects', { request: 'Find a new job as a data analyst within 4 months, 15 hours a week' })).body.project;
  assert.equal(p.status, 'PLAN');
  assert.equal(p.spec.model.id, 'job_search_funnel');
  const best = p.comparison.best;
  const before = (await che.get(`/api/manifest/runs/${p.latest_runs[best]}`)).body.run;
  const more = (await che.post(P(p.id, '/simulate'), { candidate_id: 'targeted', variables: { apps_per_week: 12 } })).body.run;
  assert.ok(more.nominal.outputs.expected_offers > 0);
  const outcome = (await che.post(P(p.id, '/outcome'), { metric: 'response_rate', value: 0.02, unit: '1', note: 'Week 4: 2 replies from 100 applications' })).body.outcome;
  assert.equal(outcome.kind, 'measured_input');
  assert.equal(outcome.wrong[0], 'response_rate');
  assert.ok(outcome.updated_estimate.p_offer_by_target.p50 < before.summary.p_offer_by_target.p50, 'the updated estimate is lower');
  const project = (await che.get(P(p.id))).body.project;
  assert.equal(project.candidates.find((c) => c.id === best).feasibility.basis.includes('simulation'), true);
  assert.equal(project.outcomes.length, 1);
});

test('owner only, refusals and the model catalogue', async () => {
  const che = await owner();
  assert.ok([401, 403].includes((await che.anon('/api/manifest/projects')).status));
  const refused = await che.post('/api/manifest/projects', { request: 'a drone with a gun that shoots people' });
  assert.equal(refused.status, 422);
  assert.equal(refused.body.refused, true);
  const models = (await che.get('/api/manifest/models')).body.models;
  assert.deepEqual(models.map((m) => m.id), ['multirotor_hover', 'unit_economics_cashflow', 'job_search_funnel']);
  assert.ok(models.every((m) => m.equations.length >= 5 && m.references.length >= 1));
  const blocked = (await che.post('/api/manifest/projects', { request: 'write a novel' })).body.project;
  assert.equal(blocked.status, 'BLOCKED');
  assert.equal((await che.get('/api/manifest/projects/mp-none')).status, 404);
});
