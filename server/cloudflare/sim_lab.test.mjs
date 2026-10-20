// Simulation Lab (owner, 2026-10-20): staged, budgeted, seeded design-space search over the Concept-to-Plan
// plans. These tests cover ranking, uncertainty, reproducibility, resource limits, provenance, memory reuse,
// the physics against known equations, safe handling of dangerous concepts, and the chat route end to end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { buildPlan } from './project_plan.js';
import { DEFAULT_BUDGET, EVIDENCE, MAX_BUDGET, PHYSICS_MODELS, configModel, modelsFor, rngFrom, runLab, runModel, saveRun, loadSimMemory, simLabIntent } from './sim_lab.js';
import { strategySimIntent } from './strategy_sim.js';
import { simScene } from './world_scene.js';

const generated = new URL('./.sim_lab.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch (_) { DatabaseSync = null; }
const sqlite = { skip: DatabaseSync ? false : 'node:sqlite unavailable' };

// Offline: the only page CHE may read is a stubbed Wikipedia summary; every other host fails.
const wikiReads = [];
globalThis.fetch = async (input) => {
  const url = String(input?.url || input);
  if (url.startsWith('https://en.wikipedia.org/api/rest_v1/page/summary/')) {
    wikiReads.push(url);
    const title = decodeURIComponent(url.split('/').pop()).replace(/_/g, ' ');
    return new Response(JSON.stringify({ title, extract: `${title} is a stub summary for tests.`, content_urls: { desktop: { page: `https://en.wikipedia.org/wiki/${title.replace(/ /g, '_')}` } } }), { status: 200 });
  }
  throw new TypeError(`fetch failed (sim_lab tests are offline: ${url})`);
};

function storageFor(saved = new Map()) {
  const db = new DatabaseSync(':memory:');
  return {
    sql: { exec: (q, ...p) => { const stmt = db.prepare(q); return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []); } },
    get: async (key) => (Array.isArray(key)
      ? new Map(key.filter((k) => saved.has(k)).map((k) => [k, structuredClone(saved.get(k))]))
      : (saved.has(key) ? structuredClone(saved.get(key)) : undefined)),
    put: async (key, value) => {
      if (key && typeof key === 'object') for (const [k, v] of Object.entries(key)) saved.set(k, structuredClone(v));
      else saved.set(key, structuredClone(value));
    },
    delete: async (key) => (Array.isArray(key) ? key.filter((k) => saved.delete(k)).length : saved.delete(key)),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => String(k).startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

async function owner() {
  let calls = 0;
  const pending = [];
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async () => { calls += 1; return { response: 'ok' }; } },
  };
  const saved = new Map();
  const storage = storageFor(saved);
  const state = new CheState({ storage, waitUntil: (p) => pending.push(p) }, env);
  env.CHE_STATE = { getByName: () => state };
  const che = { env, storage, saved, state, calls: () => calls };
  const send = (path, body, token = '', method = 'POST') => worker.fetch(new Request(`https://che.example${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  che.say = async (message, history = []) => {
    const raw = await (await send('/api/chat', { message, history }, token)).text();
    while (pending.length) await pending.shift();
    const events = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const done = events.find((e) => e.type === 'done') || {};
    return { reply: events.filter((e) => e.type === 'delta').map((e) => e.delta).join(''), done, route: done.source || 'model' };
  };
  che.get = async (path, withToken = true) => { const res = await send(path, null, withToken ? token : '', 'GET'); return { status: res.status, body: await res.json() }; };
  return che;
}

const model = (id) => PHYSICS_MODELS.find((m) => m.id === id);
const FLY = 'Design an Iron Man suit that can fly';

test('ranking: candidates come best first, realistic designs above ones that need tomorrow\'s technology', () => {
  const run = runLab(buildPlan(FLY, { id: 'p-fly' }), { id: 'sim-t1', seed: 7 });
  const hover = run.models[0];
  assert.equal(hover.model.id, 'hover_flight');
  const scores = hover.candidates.map((c) => c.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  assert.deepEqual(hover.candidates.map((c) => c.rank), hover.candidates.map((_, i) => i + 1));
  const best = hover.candidates[0];
  assert.deepEqual(best.beyond_today, [], 'the closest realistic solution uses today\'s battery and motor ranges');
  assert.ok(best.params.energy <= 300 && best.params.motor <= 7);
  for (const k of ['feasibility', 'closeness', 'performance', 'cost', 'reliability', 'simplicity']) assert.ok(best.dims[k] >= 0 && best.dims[k] <= 1, k);
  assert.equal(run.best.id, best.id);
  assert.match(run.spoken, /Closest realistic solution, electric hover flight/);
});

test('uncertainty: Monte Carlo gives ordered p10/p50/p90 and a feasibility probability for each finalist', () => {
  const run = runLab(buildPlan('Design an electric car prototype', { id: 'p-ev' }), { id: 'sim-t2', seed: 3 });
  const ev = run.models[0];
  assert.equal(ev.model.id, 'ev_range');
  for (const c of ev.candidates) {
    assert.ok(c.primary.p10 <= c.primary.p50 && c.primary.p50 <= c.primary.p90, JSON.stringify(c.primary));
    assert.ok(c.primary.p10 < c.primary.p90, 'the uncertain constants actually vary the result');
    assert.ok(c.feasibility >= 0 && c.feasibility <= 1);
    assert.ok(c.cost.p10 <= c.cost.nominal + 1 && c.cost.nominal <= c.cost.p90 + 1);
  }
  assert.equal(ev.counts.monte_carlo_samples, ev.candidates.length * 1000);
});

test('reproducibility: the same seed gives the same run; another seed searches differently', () => {
  const plan = buildPlan(FLY, { id: 'p-fly' });
  const a = runLab(plan, { id: 'sim-x', seed: 42, now: '2026-10-20T00:00:00Z' });
  const b = runLab(plan, { id: 'sim-x', seed: 42, now: '2026-10-20T00:00:00Z' });
  const c = runLab(plan, { id: 'sim-x', seed: 43, now: '2026-10-20T00:00:00Z' });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.models[0].candidates[0].params, c.models[0].candidates[0].params);
  assert.equal(runLab(plan, { id: 'sim-y' }).seed, runLab(plan, { id: 'sim-z' }).seed, 'the default seed comes from the request, so a rerun reproduces');
  const r = rngFrom(1);
  assert.deepEqual([r(), r()], (() => { const q = rngFrom(1); return [q(), q()]; })());
});

test('resource limits: evaluations never exceed the budget, oversized asks are capped and said so, counts are what ran', () => {
  const plan = buildPlan(FLY, { id: 'p-fly' });
  const small = runLab(plan, { id: 'sim-s', seed: 1, budget: 2000 });
  assert.equal(small.budget, 2000);
  for (const m of small.models) assert.ok(m.counts.screening_evaluations <= m.budget, `${m.model.id} ${m.counts.screening_evaluations} > ${m.budget}`);
  assert.ok(small.totals.screening_evaluations <= 2000);
  assert.equal(small.totals.screening_evaluations, small.models.reduce((n, m) => n + m.counts.screening_evaluations, 0));
  assert.equal(small.totals.eliminated + small.totals.feasible, small.totals.screening_evaluations);
  const huge = runLab(plan, { id: 'sim-h', seed: 1, budget: 5e9 });
  assert.equal(huge.budget, MAX_BUDGET);
  assert.equal(huge.requested_budget, 5e9);
  assert.match(huge.spoken, /You asked for 5,000,000,000; one run is capped at 1,000,000 evaluations/);
  assert.ok(huge.totals.screening_evaluations <= MAX_BUDGET);
  assert.match(huge.spoken, new RegExp(`screened ${huge.totals.screening_evaluations.toLocaleString('en-US')} candidate designs with equations, which are mathematical predictions, not simulations, and ran ${huge.totals.monte_carlo_samples.toLocaleString('en-US')} Monte Carlo simulations`));
  assert.ok(['budget', 'converged', 'max_rounds', 'exhaustive'].includes(huge.models[0].stop));
});

test('exhaustive search when every combination fits the budget; sampling with refinement when it does not', () => {
  const plan = buildPlan('Plan a barbershop business with a cost breakdown', { id: 'p-shop' });
  const cfg = configModel(plan);
  const all = runModel(cfg, { seed: 1, budget: cfg.combinations + 10 });
  assert.equal(all.stop, 'exhaustive');
  assert.equal(all.counts.screening_evaluations, cfg.combinations);
  const sampled = runModel(cfg, { seed: 1, budget: Math.floor(cfg.combinations / 4) });
  assert.notEqual(sampled.stop, 'exhaustive');
  assert.ok(sampled.rounds.length >= 2 && sampled.rounds[0].kind === 'random screening');
  const bests = sampled.rounds.map((r) => r.best);
  assert.deepEqual(bests, [...bests].sort((a, b) => a - b), 'refinement never loses the best design');
});

test('provenance: findings are predictions or simulated results, never measurements or proof', () => {
  for (const req of [FLY, 'Design an electric car prototype', 'Design a wearable robotics exoskeleton prototype', 'Design a running sneaker', 'Turn this idea into a mobile app: a dog walking marketplace, under $20,000']) {
    const run = runLab(buildPlan(req, { id: 'p' }), { id: 'sim-p', seed: 5 });
    assert.deepEqual(Object.keys(EVIDENCE), ['prediction', 'simulated', 'measured', 'proven']);
    for (const f of run.findings) assert.ok(['prediction', 'simulated'].includes(f.evidence), `${req}: ${f.evidence}`);
    for (const m of run.models) for (const c of m.candidates) assert.equal(c.evidence, 'simulated');
    assert.ok(['simulated', 'mathematical prediction'].includes(run.readiness.stage));
    assert.ok(run.readiness.index < run.readiness.ladder.indexOf('prototype built'));
    assert.match(run.spoken, /not measurements: nothing has been built or tested/);
    assert.ok(run.unresolved.some((u) => /benchmarked against measured data/.test(u)));
  }
  const app = runLab(buildPlan('Turn this idea into a mobile app: a dog walking marketplace, under $20,000', { id: 'p' }), { id: 'sim-a', seed: 5 });
  assert.equal(app.models.length, 1, 'no physics model for software: only the option search runs');
  assert.ok(app.models[0].eliminated.some((e) => e.id === 'over_budget'), 'the $20,000 ceiling eliminates designs');
  assert.equal(app.missing_capabilities.length, 1);
  assert.match(app.missing_capabilities[0].how, /paid AI model, so it starts only when you say so/);
});

test('physics: the models reproduce their textbook equations', () => {
  const hover = model('hover_flight');
  // Momentum theory with a perfect fan and drive: P = T^1.5 / sqrt(2 rho A).
  const p = { area: 1, battery: 40, energy: 250, motor: 1e9 };
  const r = hover.evaluate(p, { fm: 1, rho: 1.225, eta: 1, pack: 1 });
  const thrust = (80 + 25 + 4 + 40) * 9.81;
  assert.ok(Math.abs(r.metrics.power_kw * 1000 - thrust ** 1.5 / Math.sqrt(2 * 1.225 * 1)) < 1);
  assert.ok(Math.abs(r.metrics.minutes - (40 * 250 * 0.8) / (r.metrics.power_kw * 1000) * 60) < 1e-6);
  // Quadrupling the disk area halves the ideal power at the same mass.
  const r4 = hover.evaluate({ ...p, area: 4 }, { fm: 1, rho: 1.225, eta: 1, pack: 1 });
  const thrust4 = (80 + 25 + 16 + 40) * 9.81;
  assert.ok(Math.abs(r4.metrics.power_kw * 1000 - thrust4 ** 1.5 / Math.sqrt(2 * 1.225 * 4)) < 1);
  // Real motors have mass: a weak motor never settles (the mass spiral), and the design is eliminated.
  assert.deepEqual(hover.evaluate({ ...p, motor: 0.05 }, { fm: 0.65, rho: 1.225, eta: 0.88, pack: 0.95 }).violations, ['mass_spiral']);
  // Road load: drag plus rolling resistance at 110 km/h, over drivetrain efficiency, plus 1 kW of accessories.
  const ev = model('ev_range');
  const e = ev.evaluate({ kwh: 75, base: 1600, cd: 0.28, frontal: 2.3, crr: 0.009 }, { pack: 175, eta: 0.9, rho: 1.225 });
  const v = 110 / 3.6;
  const mass = 1600 + 75000 / 175;
  const whPerKm = ((0.5 * 1.225 * 0.28 * 2.3 * v * v + 0.009 * mass * 9.81) / 0.9 + 1000 / v) / 3.6;
  assert.ok(Math.abs(e.metrics.wh_per_km - whPerKm) < 1e-6);
  assert.ok(e.metrics.wh_per_km > 150 && e.metrics.wh_per_km < 250, `a mid-size EV at highway speed uses roughly 150-250 Wh/km, got ${e.metrics.wh_per_km}`);
  const exo = model('exo_runtime');
  const x = exo.evaluate({ joints: 4, watts: 50, battery: 2, energy: 250 }, { pack: 1, duty: 1 });
  assert.ok(Math.abs(x.metrics.hours - (2 * 250 * 0.85) / (4 * 50 + 20)) < 1e-9);
});

test('model choice: flight gets the hover model, cars the road-load model, exoskeletons the runtime model, everything the option search', () => {
  const ids = (req) => modelsFor(buildPlan(req, { id: 'p' })).map((m) => m.id);
  assert.deepEqual(ids(FLY), ['hover_flight', 'config_search']);
  assert.deepEqual(ids('Design a jetpack prototype'), ['hover_flight', 'config_search']);
  assert.deepEqual(ids('Design an electric car prototype'), ['ev_range', 'config_search']);
  assert.deepEqual(ids('Design a wearable robotics exoskeleton prototype'), ['exo_runtime', 'config_search']);
  assert.deepEqual(ids('Design a running sneaker'), ['config_search']);
  assert.deepEqual(ids('Create a game production roadmap for a roguelike'), ['config_search']);
});

test('memory: what worked seeds the next run, and failures are tallied per model', { skip: sqlite.skip }, async () => {
  const storage = storageFor();
  const plan = buildPlan(FLY, { id: 'p-fly' });
  const first = runLab(plan, { id: 'sim-m1', seed: 9 });
  assert.equal(first.totals.reused_prior, 0);
  await saveRun(storage, null, first);
  const memory = await loadSimMemory(storage, plan);
  assert.equal(memory['hover_flight@1'].runs, 1);
  assert.ok(memory['hover_flight@1'].best.length >= 1);
  assert.ok(Object.values(memory['hover_flight@1'].eliminated).reduce((a, b) => a + b, 0) > 0);
  const second = runLab(plan, { id: 'sim-m2', seed: 10, memory });
  assert.ok(second.models[0].counts.reused_prior >= 1);
  assert.match(second.spoken, /earlier best designs? (?:was|were) reused/);
  assert.ok(second.models[0].candidates[0].score >= first.models[0].candidates[0].score - 1e-9, 'starting from the earlier best never ends worse');
  await saveRun(storage, null, second);
  assert.equal((await loadSimMemory(storage, plan))['hover_flight@1'].runs, 2);
});

test('safety: weapons are refused before any evaluation; dangerous concepts get non-operational analysis with a warning', () => {
  const gun = runLab(buildPlan('Design a drone with a gun mounted on it', { id: 'p-gun' }), { id: 'sim-gun' });
  assert.equal(gun.refused, true);
  assert.deepEqual(gun.models, []);
  assert.match(gun.spoken, /I won't simulate that/);
  const fly = runLab(buildPlan(FLY, { id: 'p-fly' }), { id: 'sim-f', seed: 1 });
  assert.ok(fly.hazard_notes.includes('A simulated result is never proof that a real-world test is safe.'));
  assert.match(fly.spoken, /Crewed flight can kill/);
  assert.match(fly.roadmap[0], /unmanned/);
  const missile = runLab(buildPlan('Design an Iron Man suit that can fly with missiles', { id: 'p-m' }), { id: 'sim-mi', seed: 1 });
  assert.ok(!missile.refused && missile.safety.excluded.some((x) => /Weapons/.test(x)), 'the weapon is left out, the suit is still simulated');
});

test('intent: lab requests are recognised, budgets parsed, and the strategy simulation keeps its phrases', () => {
  const yes = [
    ['CHE, find the closest realistic solution', { subject: '', budget: null, open: false }],
    ['Find the closest realistic solution for a flying suit', { subject: 'a flying suit', budget: null, open: false }],
    ['run a million simulations on this idea', { subject: '', budget: 1e6, open: false }],
    ['Run 250,000 simulations for the sneaker idea', { subject: 'the sneaker idea', budget: 250000, open: false }],
    ['Simulate this design', { subject: '', budget: null, open: false }],
    ['optimize the design', { subject: '', budget: null, open: false }],
    ['open the simulation lab', { subject: '', budget: null, open: true }],
    ["What's the most realistic version of a flying car?", { subject: 'a flying car', budget: null, open: false }],
  ];
  for (const [m, want] of yes) assert.deepEqual(simLabIntent(m), want, m);
  for (const m of ['pause the strategy simulation', 'what are the simulation results', 'simulate a trade on MNQ', 'simulate the conversation with my boss', 'how is the paper simulation', 'Design an Iron Man suit', 'what is a simulation', "what's the most realistic option for dinner", 'the most realistic way to lose weight', 'find the closest realistic solution to my sleep problem']) {
    assert.equal(simLabIntent(m), null, m);
  }
  for (const m of ['pause the strategy simulation', 'what are the simulation results']) assert.ok(strategySimIntent(m), m);
});

test('chat: plan, then "find the closest realistic solution" runs the lab on it; scene, list and Brain record; no model call', { skip: sqlite.skip }, async () => {
  const che = await owner();
  const planned = await che.say('CHE, design an Iron Man suit that can fly and estimate the cost');
  assert.equal(planned.route, 'che_project_plan');
  const lab = await che.say('Find the closest realistic solution');
  assert.equal(lab.route, 'che_sim_lab');
  assert.equal(lab.done.plan_id, planned.done.plan_id, 'it ran on the plan just made');
  assert.match(lab.done.sim_id, /^sim-/);
  assert.match(lab.reply, /Closest realistic solution, electric hover flight/);
  assert.match(lab.reply, /mathematical predictions, not simulations/);
  assert.equal(che.calls(), 0);
  const scene = await che.get(`/api/world/scene?scene=sim&id=${lab.done.sim_id}`);
  assert.equal(scene.status, 200);
  assert.equal(scene.body.scene.scene, 'sim');
  const kinds = new Set(scene.body.scene.objects.map((o) => o.kind));
  for (const k of ['candidate', 'elimination', 'finding', 'assumption', 'unresolved', 'safety', 'reference']) assert.ok(kinds.has(k), k);
  for (const o of scene.body.scene.objects) assert.ok(o.source?.store && o.provenance_spoken, o.id);
  assert.equal(scene.body.scene.readiness.stage, 'simulated');
  assert.equal((await che.get('/api/world/scene?scene=sim&id=sim-missing0')).status, 404);
  assert.equal((await che.get('/api/sims', false)).status, 401);
  const list = await che.get('/api/sims');
  assert.equal(list.body.runs[0].id, lab.done.sim_id);
  const full = await che.get(`/api/sims/${lab.done.sim_id}`);
  assert.equal(full.body.run.models[0].model.id, 'hover_flight');
  const record = new (await import('./brain_store.js')).CheBrainStore(che.storage).get(`sim_run:${lab.done.sim_id}`);
  assert.equal(record.kind, 'simulation_run');
  assert.equal(record.verification, 'proposed');
  assert.equal(record.source.evidence, 'simulated');
  assert.deepEqual(record.source.models, ['hover_flight@1', 'config_search@1']);
  assert.ok(Number.isInteger(record.source.seed));
  assert.match(record.body, /Model hover_flight v1 \(Actuator-disk momentum theory/);
  assert.match(record.body, /screening evaluations \(mathematical predictions\)/);
  assert.match(record.body, /Nothing was built or measured/);
  assert.ok(che.saved.has('sim_memory:hover_flight@1'));
  const reopened = await che.say('open the simulation lab');
  assert.equal(reopened.done.sim_id, lab.done.sim_id);
});

test('chat: a named idea is planned and simulated in one turn; no idea at all asks which; weapons refused and not saved', { skip: sqlite.skip }, async () => {
  const che = await owner();
  const none = await che.say('Find the closest realistic solution');
  assert.equal(none.route, 'che_sim_lab');
  assert.equal(none.done.ok, false);
  assert.match(none.reply, /Which idea should I simulate/);
  const car = await che.say('Find the closest realistic solution for an electric car under $40,000');
  assert.equal(car.route, 'che_sim_lab');
  assert.equal(car.done.project_type, 'vehicle');
  assert.match(car.reply, /battery-electric vehicle highway range/);
  const fromHistory = await che.say('Simulate this design', [{ role: 'user', content: 'a wearable exoskeleton for warehouse lifting' }, { role: 'assistant', content: 'Interesting.' }]);
  assert.equal(fromHistory.route, 'che_sim_lab');
  const gun = await che.say('Find the closest realistic solution for a drone with a gun');
  assert.equal(gun.route, 'che_sim_lab');
  assert.equal(gun.done.ok, false);
  assert.equal(gun.done.sim_id, '');
  assert.match(gun.reply, /won't (?:simulate|plan) that/);
  assert.equal(che.calls(), 0);
});

test('the phone\'s simulation fixture is exactly what the Worker draws today', () => {
  const plan = buildPlan(FLY, { id: 'plan-fixture', now: '2026-10-20T00:00:00Z' });
  const run = runLab(plan, { id: 'sim-fixture', seed: 2026, budget: 4000, now: '2026-10-20T00:00:00Z' });
  const fixture = JSON.parse(readFileSync(new URL('../../test/fixtures/sim_scene.json', import.meta.url), 'utf8'));
  assert.deepEqual(fixture, JSON.parse(JSON.stringify(simScene(run))), 'regenerate test/fixtures/sim_scene.json (see docs/CHE_SIMULATION_LAB.md)');
  assert.ok(DEFAULT_BUDGET >= 10000);
});
