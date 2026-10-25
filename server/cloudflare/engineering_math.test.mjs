import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  helixLength, headroom, rotation, shaftPowerTorque, spinUp, gearTrain, boxClearance, cantileverTip, receiptVerdict, DIM,
} from './engineering_math.js';

// Reference values were computed outside this module: sympy's symbolic integral for the helix and the cantilever
// (Euler-Bernoulli, M = F(L−x), double integral), and hand arithmetic for the rotation and gear cases.

test('helix length matches sympy\'s symbolic arc-length integral and the chord sum', () => {
  const r = helixLength({ radius: 3, pitch: 2, turns: 3 });
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.value - 56.86608678248356) < 1e-9, `closed ${r.value}`);
  assert.equal(r.checks.pass, true, `chord sum disagrees by ${r.checks.relDiff}`);
  assert.equal(r.rise.value, 6);
  assert.deepEqual(r.inputs, { radius: 3, pitch: 2, turns: 3 });
});

test('a helix with zero pitch is a flat circle, and invalid input is refused rather than guessed', () => {
  const flat = helixLength({ radius: 5, pitch: 0, turns: 1 });
  assert.ok(Math.abs(flat.value - 2 * Math.PI * 5) < 1e-9);
  assert.equal(helixLength({ radius: -1, pitch: 1, turns: 1 }).ok, false);
  assert.equal(helixLength({ radius: 2, pitch: NaN, turns: 1 }).ok, false);
});

test('headroom subtracts the slab and reports against the minimum', () => {
  const h = headroom({ floorToFloor: 4.2, slabThickness: 0.3, minimum: 2.1 });
  assert.ok(Math.abs(h.value - 3.9) < 1e-12);
  assert.equal(h.pass, true);
  assert.equal(headroom({ floorToFloor: 2.2, slabThickness: 0.3, minimum: 2.1 }).pass, false);
});

test('rotation: 3000 rpm is 314.159 rad/s and one second sweeps 100π rad', () => {
  const r = rotation({ rpm: 3000, seconds: 1 });
  assert.ok(Math.abs(r.value - 100 * Math.PI) < 1e-9);
  assert.ok(Math.abs(r.angle.value - 100 * Math.PI) < 1e-9);
  assert.equal(r.checks.pass, true);
});

test('shaft power: the solved third value satisfies P = T·ω', () => {
  const p = shaftPowerTorque({ torque: 50, omega: 100 });
  assert.equal(p.solved, 'power');
  assert.equal(p.value.power, 5000);
  const t = shaftPowerTorque({ power: 5000, omega: 100 });
  assert.equal(t.solved, 'torque');
  assert.equal(t.value.torque, 50);
  assert.equal(shaftPowerTorque({ torque: 50 }).ok, false, 'needs exactly two inputs');
});

test('spin-up: time, angle and energy match hand arithmetic, and the angle matches numeric integration', () => {
  const s = spinUp({ inertia: 2, torque: 5, targetRpm: 3000 });
  assert.ok(Math.abs(s.value.seconds - 125.66370614359172) < 1e-9);
  assert.ok(Math.abs(s.value.angle - 19739.208802178717) < 1e-6);
  assert.ok(Math.abs(s.value.energy - 98696.04401089359) < 1e-6);
  assert.equal(s.checks.pass, true);
});

test('gear train: 20 teeth driving 60 gives a 3:1 ratio, a third of the speed and three times the torque, with balanced power', () => {
  const g = gearTrain({ driverTeeth: 20, drivenTeeth: 60, inputRpm: 900, inputTorque: 10 });
  assert.equal(g.value.ratio, 3);
  assert.equal(g.value.outputRpm, 300);
  assert.equal(g.value.outputTorque, 30);
  assert.equal(g.checks.pass, true);
});

test('box clearance: a gap is positive, and overlapping boxes report a collision', () => {
  const a = { c: [0, 0, 0], s: [1, 1, 1] };
  const apart = boxClearance({ a, b: { c: [2, 0, 0], s: [1, 1, 1] }, axis: 0 });
  assert.ok(Math.abs(apart.value - 1) < 1e-12);
  assert.equal(apart.collision, false);
  const crash = boxClearance({ a, b: { c: [0.2, 0.1, 0], s: [1, 1, 1] }, axis: 0 });
  assert.ok(crash.value < 0);
  assert.equal(crash.collision, true);
});

test('cantilever tip deflection matches the symbolic Euler-Bernoulli result and is marked not certified', () => {
  const c = cantileverTip({ force: 1000, length: 4, youngs: 200e9, width: 0.3, depth: 0.5 });
  assert.ok(Math.abs(c.value - 3.413333333333333e-5) / 3.413333333333333e-5 < 1e-9, `closed ${c.value}`);
  assert.equal(c.checks.pass, true, `integration disagrees by ${c.checks.relDiff}`);
  assert.equal(c.certified, false);
});

test('dimensions are declared and every formula result carries its dimension check', () => {
  assert.deepEqual(DIM.force, [1, 1, -2]);
  assert.equal(helixLength({ radius: 1, pitch: 1, turns: 1 }).dimension.ok, true);
  assert.equal(spinUp({ inertia: 1, torque: 1, targetRpm: 60 }).ok, true);
});

test('a receipt verdict lists every failed check and never claims certification', () => {
  const good = receiptVerdict([helixLength({ radius: 3, pitch: 2, turns: 3 }), rotation({ rpm: 60 })]);
  assert.equal(good.verified, true);
  assert.match(good.note, /not a structural or safety certification/);
  const bad = receiptVerdict([{ ok: true, name: 'broken', checks: { pass: false } }, { ok: false, name: 'refused' }]);
  assert.equal(bad.verified, false);
  assert.deepEqual(bad.failed, ['broken', 'refused']);
});
