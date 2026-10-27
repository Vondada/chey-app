// Manifestation Engine, physical domain: the multirotor hover model.
// Known answers, conservation, dimensional consistency, a published-aircraft check, the closed-form battery
// optimum, agreement with the Simulation Lab, and the "flying car" and "hover forever" classifications.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DRONE_MODEL, G0, HYDROCARBON_WH_PER_KG, TODAY_PACK_WH_PER_KG, optimalBatteryMass } from './manifest_drone.js';
import { buildSpec, classifyCandidate, dimensionCheck, generateCandidates, sensitivity, simulate, sweep } from './manifest_engine.js';
import { PHYSICS_MODELS } from './sim_lab.js';

const base = (over = {}) => ({ ...Object.fromEntries(DRONE_MODEL.inputs.map((i) => [i.id, i.nominal])), ...over });
const near = (a, b, rel, msg) => assert.ok(Math.abs(a - b) <= rel * Math.abs(b), `${msg}: ${a} vs ${b}`);

test('known answer: ideal hover power of 1 kg on four 10-inch rotors at sea level is 43.58 W', () => {
  // By hand: T = 9.80665 N, A = π·0.254² = 0.20268 m², sqrt(2·1.225·0.20268) = 0.70468, T^1.5 = 30.7104 → 43.58 W.
  const o = DRONE_MODEL.evaluate(base({ rotors: 4, rotor_diameter: 0.254, frame_mass: 1, battery_mass: 0, payload: 0, air_density: 1.225 })).outputs;
  near(o.ideal_power, 43.58, 1e-4, 'ideal power');
  near(o.weight, 9.80665, 1e-12, 'weight');
  near(o.disk_area, 0.20268, 1e-4, 'disk area');
  // Induced velocity v = sqrt(T / 2ρA) and P_ideal = T·v are the same theory.
  near(o.ideal_power, o.weight * o.induced_velocity, 1e-12, 'P = T·v_i');
});

test('energy is conserved: usable energy equals hover power times endurance', () => {
  for (const c of generateCandidates(buildSpec('a drone that carries 2 kg for 30 minutes'))) {
    const o = DRONE_MODEL.evaluate(base(c.variables)).outputs;
    near(o.usable_energy * 3600, o.hover_power * o.endurance * 60, 1e-12, c.id);
  }
});

test('every equation is dimensionally consistent, and a broken one is caught', () => {
  for (const c of generateCandidates(buildSpec('a flying car for 2 people'))) {
    const x = base(c.variables);
    const r = dimensionCheck(DRONE_MODEL, x, DRONE_MODEL.evaluate(x));
    assert.ok(r.ok, r.error);
    assert.ok(r.checked.some((k) => k.id === 'endurance' && k.unit === 'min'));
  }
  const broken = { ...DRONE_MODEL, dimensional: (x) => ({ ...DRONE_MODEL.dimensional(x), weight: DRONE_MODEL.dimensional(x).ideal_power }) };
  assert.equal(dimensionCheck(broken, base(), DRONE_MODEL.evaluate(base())).ok, false);
});

test('scaling laws: four times the disk area halves ideal power; power grows as mass^1.5', () => {
  const a = DRONE_MODEL.evaluate(base({ rotor_diameter: 0.25 })).outputs.ideal_power;
  const b = DRONE_MODEL.evaluate(base({ rotor_diameter: 0.5 })).outputs.ideal_power;
  near(b, a / 2, 1e-12, 'area x4');
  const m1 = DRONE_MODEL.evaluate(base({ frame_mass: 1, battery_mass: 0, payload: 0 })).outputs.ideal_power;
  const m2 = DRONE_MODEL.evaluate(base({ frame_mass: 2, battery_mass: 0, payload: 0 })).outputs.ideal_power;
  near(m2 / m1, 2 ** 1.5, 1e-12, 'mass x2');
});

test('closed form: with no avionics load, endurance peaks at a battery twice the rest of the aircraft', () => {
  for (const [frame, payload] of [[1, 0.5], [3, 2], [400, 200]]) {
    const best = optimalBatteryMass(base({ frame_mass: frame, payload, avionics_power: 0 }));
    near(best, 2 * (frame + payload), 1e-4, `m0 = ${frame + payload}`);
  }
});

test('agrees with the Simulation Lab hover model (same momentum theory) for the same mass and disk', () => {
  const hover = PHYSICS_MODELS.find((m) => m.id === 'hover_flight');
  const area = 1.2;
  const battery = 30;
  // The lab's suit carries 80 + 25 + 4·area kg plus battery; huge motor specific power removes motor mass.
  const lab = hover.evaluate({ area, battery, energy: 250, motor: 1e12 }, { fm: 0.7, rho: 1.225, eta: 0.9, pack: 1 });
  const mass = 80 + 25 + 4 * area + battery;
  const mine = DRONE_MODEL.evaluate(base({ rotors: 4, rotor_diameter: Math.sqrt(area / Math.PI), frame_mass: mass - battery, battery_mass: battery, payload: 0, figure_of_merit: 0.7, drive_efficiency: 0.9, air_density: 1.225, avionics_power: 0 })).outputs;
  // sim_lab uses g = 9.81, this model 9.80665: the powers differ by (9.81/9.80665)^1.5 only.
  near(lab.metrics.power_kw * 1000, mine.hover_power * (9.81 / G0) ** 1.5, 1e-9, 'electrical power');
});

test('benchmark: DJI Phantom 4 Pro (1,388 g, 89.2 Wh, about 30 min rated) falls inside the simulated band', () => {
  // Published: 1,388 g take-off mass, 5,870 mAh / 89.2 Wh battery, "approx. 30 minutes" flight time (DJI).
  // Propeller diameter 0.239 m (9.4-inch class) is CHE's reading of the propeller type, not from DJI's page.
  // Endurance depends only on the 89.2 Wh and total mass, not on how mass splits between battery and frame.
  const x = { rotors: 4, rotor_diameter: 0.239, frame_mass: 1.388 - 0.468, battery_mass: 0.468, specific_energy: 89.2 / 0.468, payload: 0, reserve: 0, target_endurance: 1 };
  const run = simulate(DRONE_MODEL, x, { seed: 7, samples: 4000, ranges: { specific_energy: [89.2 / 0.468, 89.2 / 0.468] } });
  assert.ok(run.summary.endurance.p10 <= 30 && 30 <= run.summary.endurance.p90, JSON.stringify(run.summary.endurance));
  near(run.nominal.outputs.endurance, 30, 0.1, 'nominal within 10% of rated');
});

test('payload sweep: endurance falls as payload rises, under one seed', () => {
  const s = sweep(DRONE_MODEL, base({ battery_mass: 0.6 }), { variable: 'payload', values: [0, 0.5, 1, 1.5, 2], samples: 300, seed: 3 });
  const p50 = s.rows.map((r) => r.endurance.p50);
  for (let i = 1; i < p50.length; i += 1) assert.ok(p50[i] < p50[i - 1], `p50 ${p50}`);
  assert.equal(s.seed, 3);
});

test('sensitivity: endurance is proportional to specific energy (elasticity 1)', () => {
  const sens = sensitivity(DRONE_MODEL, base(), { output: 'endurance' });
  const e = sens.rows.find((r) => r.input === 'specific_energy');
  near(e.elasticity, 1, 1e-6, 'elasticity');
  // Hover power ∝ 1/sqrt(ρ) for the rotor part, so endurance rises with density.
  assert.ok(sens.rows.find((r) => r.input === 'air_density').elasticity > 0);
});

test('flying car: plausible but unproven, limited by battery energy density, with numbered alternatives', () => {
  const spec = buildSpec('Build a flying car for 2 people that flies for 1 hour');
  assert.equal(spec.domain, 'physical');
  assert.equal(spec.variables.payload, 200);
  assert.equal(spec.variables.max_span, 2.55);
  const [road] = generateCandidates(spec);
  const run = simulate(DRONE_MODEL, road.variables, { seed: 1, samples: 500 });
  const f = classifyCandidate(DRONE_MODEL, spec, road, run);
  assert.equal(f.class, 'unproven');
  assert.equal(f.limiting_constraint.id, 'battery_specific_energy');
  assert.ok(f.limiting_constraint.required_wh_per_kg > TODAY_PACK_WH_PER_KG && f.limiting_constraint.required_wh_per_kg < HYDROCARBON_WH_PER_KG);
  assert.ok(f.limiting_constraint.max_endurance_min_today < 60);
  const ids = f.alternatives.map((a) => a.id);
  for (const id of ['best_today', 'bigger_rotors', 'hybrid', 'winged']) assert.ok(ids.includes(id), id);
  assert.ok(f.alternatives.find((a) => a.id === 'bigger_rotors').numbers.endurance_min > f.alternatives.find((a) => a.id === 'best_today').numbers.endurance_min);
});

test('physics violations: hover forever and a figure of merit above 1 are incompatible, with the law named', () => {
  const spec = buildSpec('a drone that hovers forever without charging');
  const [c] = generateCandidates(spec);
  const f = classifyCandidate(DRONE_MODEL, spec, c, null);
  assert.equal(f.class, 'incompatible');
  assert.match(f.violated[0].text, /Conservation of energy/);
  assert.ok(f.alternatives.some((a) => a.id === 'tethered'));
  const g = classifyCandidate(DRONE_MODEL, buildSpec('a drone for 20 minutes'), { variables: base({ figure_of_merit: 1.2 }) }, null);
  assert.equal(g.class, 'incompatible');
  assert.equal(g.violated[0].id, 'figure_of_merit_le_1');
});

test('a small drone with a generous budget is feasible now', () => {
  const spec = buildSpec('a drone that carries 1 kg for 25 minutes with a budget of $2,000');
  const c = generateCandidates(spec).find((x) => x.id === 'quad-15in');
  const run = simulate(DRONE_MODEL, c.variables, { seed: 2, samples: 1000 });
  assert.equal(classifyCandidate(DRONE_MODEL, spec, c, run).class, 'feasible_now');
});
