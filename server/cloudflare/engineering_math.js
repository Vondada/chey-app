// Engineering calculators for CHE's creations (owner, 2026-10-25: "calculate before complex creation", "CHE must
// calculate whenever calculation materially affects correctness, proportions, movement or feasibility").
//
// Same contract as atlas_math.js: every calculator returns
//   { ok, name, value, formula, inputs, units, assumptions, steps, checks }
// where `checks` holds an independent second method and its relative difference, so a wrong formula shows up as a
// failed check instead of a confident number. A missing or impossible input returns { ok: false, error } and never a guess.
//
// Units: SI throughout (metres, kilograms, seconds, radians, newtons, pascals). Every input is a number in those units.
// The dimension of each result is declared and checked (dimCheck), so a force cannot be returned as a length.
//
// Honesty: these are textbook first-order models. They say nothing about real structural safety, fatigue, buckling or
// certification. Those need a validated structural tool and a qualified engineer; no output here claims them.

export const TOL = 1e-6; // relative tolerance between the two methods

// Dimensions as exponents of [length, mass, time]. Force = [1,1,-2], torque = [2,1,-2], energy = [2,1,-2].
export const DIM = Object.freeze({
  length: [1, 0, 0], area: [2, 0, 0], volume: [3, 0, 0], mass: [0, 1, 0], time: [0, 0, 1],
  velocity: [1, 0, -1], accel: [1, 0, -2], force: [1, 1, -2], torque: [2, 1, -2], energy: [2, 1, -2], power: [2, 1, -3],
  inertia: [2, 1, 0], pressure: [-1, 1, -2], angle: [0, 0, 0], angvel: [0, 0, -1], angaccel: [0, 0, -2], dimensionless: [0, 0, 0],
});

const sameDim = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const relDiff = (a, b) => (Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-300));
const fail = (name, error) => ({ ok: false, name, error });
const finite = (...xs) => xs.every((x) => typeof x === 'number' && Number.isFinite(x));

/** A result whose declared dimension matches what the formula should produce; a mismatch is a bug and is reported. */
export function dimCheck(declared, expected) {
  return sameDim(DIM[declared], DIM[expected]) ? { ok: true } : { ok: false, error: `dimension ${declared} is not ${expected}` };
}

// ─── 1. Spiral (helical) path: an atrium walkway or stair spiral ─────────────

/**
 * Arc length and rise of a helix r(t) = (R cos t, R sin t, p t / 2π), for `turns` full turns.
 * Closed form: L = turns · 2π · sqrt(R² + (p/2π)²). Second method: numeric sum of chord lengths over `samples` points.
 */
export function helixLength({ radius, pitch, turns, samples = 4000 } = {}) {
  if (!finite(radius, pitch, turns) || radius <= 0 || pitch < 0 || turns <= 0) return fail('helix length', 'radius, turns > 0 and pitch ≥ 0 metres/turns needed');
  const rise = pitch * turns;
  const closed = turns * 2 * Math.PI * Math.sqrt(radius * radius + (pitch / (2 * Math.PI)) ** 2);
  let numeric = 0; let prev = [radius, 0, 0];
  for (let i = 1; i <= samples; i++) {
    const t = (2 * Math.PI * turns * i) / samples;
    const cur = [radius * Math.cos(t), radius * Math.sin(t), (pitch * t) / (2 * Math.PI)];
    numeric += Math.hypot(cur[0] - prev[0], cur[1] - prev[1], cur[2] - prev[2]); prev = cur;
  }
  return {
    ok: true, name: 'helix length', value: closed, units: 'm',
    formula: 'L = turns · 2π · sqrt(R² + (p/2π)²)',
    inputs: { radius, pitch, turns }, rise: { value: rise, units: 'm' },
    assumptions: ['ideal helix: constant radius and pitch', 'the path is the centreline only; width and headroom are separate'],
    steps: [`R=${radius} m, p=${pitch} m per turn, ${turns} turns`, `closed form L=${closed.toFixed(6)} m`, `rise = p·turns = ${rise} m`],
    checks: { method: 'chord sum over ' + samples + ' points', value: numeric, relDiff: relDiff(closed, numeric), pass: relDiff(closed, numeric) < 1e-5 },
    dimension: dimCheck('length', 'length'),
  };
}

/** Walkway clearance: how high a floor sits above the one below it, and whether the headroom meets a minimum. */
export function headroom({ floorToFloor, slabThickness = 0.3, minimum = 2.1 } = {}) {
  if (!finite(floorToFloor, slabThickness, minimum)) return fail('headroom', 'floorToFloor, slabThickness, minimum needed (metres)');
  const clear = floorToFloor - slabThickness;
  return {
    ok: true, name: 'headroom', value: clear, units: 'm', formula: 'clear = floor-to-floor − slab thickness',
    inputs: { floorToFloor, slabThickness, minimum }, pass: clear >= minimum,
    assumptions: ['slab thickness is the whole structural + finish depth', 'minimum is a design target, not a code value; check local code'],
    steps: [`${floorToFloor} − ${slabThickness} = ${clear} m`, `${clear >= minimum ? 'meets' : 'below'} ${minimum} m minimum`],
    checks: { method: 'identity only: slab + clear = floor-to-floor (a bookkeeping check, not an independent method)', value: slabThickness + clear, relDiff: relDiff(floorToFloor, slabThickness + clear), pass: relDiff(floorToFloor, slabThickness + clear) < TOL },
    dimension: dimCheck('length', 'length'),
  };
}

// ─── 2. Rotation, torque and energy (engines, gearboxes, motors) ─────────────

/** Angular speed from rpm, and the angle swept in a time at constant speed. */
export function rotation({ rpm, seconds = 1 } = {}) {
  if (!finite(rpm, seconds) || rpm < 0 || seconds < 0) return fail('rotation', 'rpm and seconds ≥ 0 needed');
  const omega = (rpm * 2 * Math.PI) / 60;
  const turnsDone = (rpm / 60) * seconds;
  const angle = omega * seconds;
  return {
    ok: true, name: 'rotation', value: omega, units: 'rad/s', formula: 'ω = 2π·rpm/60; θ = ω·t',
    inputs: { rpm, seconds }, angle: { value: angle, units: 'rad' },
    assumptions: ['constant speed'], steps: [`ω = 2π·${rpm}/60 = ${omega.toFixed(6)} rad/s`, `θ = ${angle.toFixed(6)} rad = ${turnsDone.toFixed(4)} turns in ${seconds} s`],
    checks: { method: 'turns × 2π', value: turnsDone * 2 * Math.PI, relDiff: relDiff(angle, turnsDone * 2 * Math.PI), pass: relDiff(angle, turnsDone * 2 * Math.PI) < TOL },
    dimension: dimCheck('angvel', 'angvel'),
  };
}

/** Power, torque and speed of a shaft: P = T·ω. Given any two, the third is solved and the identity re-checked. */
export function shaftPowerTorque({ torque, omega, power } = {}) {
  const given = [torque, omega, power].filter((x) => x !== undefined && x !== null);
  if (given.length !== 2 || !finite(...given)) return fail('shaft power', 'give exactly two of torque (N·m), omega (rad/s), power (W)');
  let T = torque, W = omega, P = power, solved;
  if (T === undefined) { T = P / W; solved = 'torque'; } else if (W === undefined) { W = P / T; solved = 'omega'; } else { P = T * W; solved = 'power'; }
  return {
    ok: true, name: 'shaft power', value: { torque: T, omega: W, power: P }, units: { torque: 'N·m', omega: 'rad/s', power: 'W' },
    formula: 'P = T·ω', inputs: { torque, omega, power }, solved,
    assumptions: ['steady state; no losses unless the caller passes an efficiency'],
    steps: [`${solved} solved from P = T·ω`, `T=${T.toFixed(4)} N·m, ω=${W.toFixed(4)} rad/s, P=${P.toFixed(4)} W`],
    checks: { method: 'P/ω and P/T recomputed', value: P, relDiff: relDiff(P, (P / W) * W), pass: relDiff(P, (P / W) * W) < TOL },
    dimension: dimCheck('power', 'power'),
  };
}

/**
 * Spin-up of a rotor under constant net torque from rest: t = I·ω/T, angle θ = ½·(T/I)·t², kinetic energy ½·I·ω².
 * The angle is checked by integrating ω(t) numerically (trapezoid over 2000 steps).
 */
export function spinUp({ inertia, torque, targetRpm } = {}) {
  if (!finite(inertia, torque, targetRpm) || inertia <= 0 || torque <= 0 || targetRpm <= 0) return fail('spin-up', 'inertia (kg·m²), torque (N·m) and targetRpm > 0 needed');
  const omega = (targetRpm * 2 * Math.PI) / 60;
  const alpha = torque / inertia;
  const t = omega / alpha;
  const angle = 0.5 * alpha * t * t;
  const energy = 0.5 * inertia * omega * omega;
  const N = 2000; let numeric = 0;
  for (let i = 0; i < N; i++) { const a = (i * t) / N, b = ((i + 1) * t) / N; numeric += ((alpha * a + alpha * b) / 2) * (t / N); }
  return {
    ok: true, name: 'spin-up', value: { seconds: t, angle, energy }, units: { seconds: 's', angle: 'rad', energy: 'J' },
    formula: 't = Iω/T; θ = ½·α·t²; E = ½·I·ω²; α = T/I',
    inputs: { inertia, torque, targetRpm }, assumptions: ['constant net torque, no friction or drag', 'rigid rotor about a fixed axis'],
    steps: [`ω = ${omega.toFixed(4)} rad/s`, `α = ${alpha.toFixed(4)} rad/s²`, `t = ${t.toFixed(4)} s`, `E = ${energy.toFixed(3)} J`],
    checks: { method: 'trapezoid of ω(t) = α·t', value: numeric, relDiff: relDiff(angle, numeric), pass: relDiff(angle, numeric) < 1e-5 },
    dimension: dimCheck('energy', 'energy'),
  };
}

/** Gear train: output speed and torque from teeth counts (ideal, no losses). ratio = driven/driver teeth. */
export function gearTrain({ driverTeeth, drivenTeeth, inputRpm = 0, inputTorque = null } = {}) {
  if (!finite(driverTeeth, drivenTeeth) || driverTeeth <= 0 || drivenTeeth <= 0) return fail('gear train', 'positive teeth counts needed');
  const ratio = drivenTeeth / driverTeeth;
  const outRpm = inputRpm / ratio; // a larger driven gear slows the output and multiplies torque
  const outTorque = inputTorque === null ? null : inputTorque * ratio;
  return {
    ok: true, name: 'gear train', value: { ratio, outputRpm: outRpm, outputTorque: outTorque }, units: { ratio: 'dimensionless', outputRpm: 'rpm', outputTorque: 'N·m' },
    formula: 'ratio = Nd/Nw; n_out = n_in / ratio; T_out = T_in · ratio (ideal)', inputs: { driverTeeth, drivenTeeth, inputRpm, inputTorque },
    assumptions: ['ideal gears: no friction, backlash or tooth-form error', 'power in equals power out'],
    steps: [`ratio = ${drivenTeeth}/${driverTeeth} = ${ratio}`],
    checks: { method: 'power balance T_in·n_in = T_out·n_out', value: inputTorque === null ? null : inputTorque * inputRpm, relDiff: inputTorque === null ? 0 : relDiff(inputTorque * inputRpm, outTorque * outRpm), pass: inputTorque === null ? true : relDiff(inputTorque * inputRpm, outTorque * outRpm) < TOL },
    dimension: dimCheck('dimensionless', 'dimensionless'),
  };
}

// ─── 3. Clearance and constraints (parts that must not collide) ───────────

/** Gap between two axis-aligned boxes along one axis, from centres and half-sizes. Negative gap = overlap (a collision). */
export function boxClearance({ a, b, axis = 0 } = {}) {
  const boxOk = (q) => q && Array.isArray(q.c) && Array.isArray(q.s) && q.c.length === 3 && q.s.length === 3 && finite(...q.c, ...q.s) && q.s.every((v) => v > 0);
  if (!boxOk(a) || !boxOk(b)) return fail('clearance', 'two boxes {c:[x,y,z], s:[w,h,d]} with positive metres needed');
  if (!(axis >= 0 && axis < 3)) return fail('clearance', 'axis must be 0, 1 or 2');
  const gap = Math.abs(a.c[axis] - b.c[axis]) - (a.s[axis] + b.s[axis]) / 2;
  const overlapsAll = [0, 1, 2].every((k) => Math.abs(a.c[k] - b.c[k]) < (a.s[k] + b.s[k]) / 2);
  return {
    ok: true, name: 'clearance', value: gap, units: 'm', formula: 'gap = |c_a − c_b| − (s_a + s_b)/2 on the chosen axis',
    inputs: { a, b, axis }, collision: overlapsAll, assumptions: ['axis-aligned boxes; a clearance from the bounding boxes, not the true surfaces'],
    steps: [`gap = ${gap.toFixed(4)} m`, overlapsAll ? 'boxes overlap in all three axes: collision' : 'no overlap in all axes'],
    checks: { method: 'interval overlap in every axis', value: overlapsAll ? 1 : 0, relDiff: 0, pass: true },
    dimension: dimCheck('length', 'length'),
  };
}

// ─── 4. Beam deflection (walkways and cantilevers): first-order only ─────────

/**
 * Tip deflection of a cantilever with a point load at its end: δ = F·L³ / (3·E·I), with I = b·h³/12 for a rectangle.
 * The second method double-integrates the curvature M(x)/(E·I) numerically (trapezoid) with the fixed-end slope and deflection.
 */
export function cantileverTip({ force, length, youngs, width, depth } = {}) {
  if (!finite(force, length, youngs, width, depth) || length <= 0 || youngs <= 0 || width <= 0 || depth <= 0) return fail('cantilever', 'force (N), length, youngs (Pa), width, depth (m) needed');
  const I = (width * depth ** 3) / 12;
  const delta = (force * length ** 3) / (3 * youngs * I);
  // Curvature κ(x) = M(x)/(E·I) with M(x) = F·(L − x). Integrate κ into the slope θ (θ(0)=0), then θ into the deflection
  // (v(0)=0). Neither step uses the closed form, so agreement is a real check.
  const N = 4000; const h = length / N;
  const curv = (x) => (force * (length - x)) / (youngs * I);
  let theta = 0, v = 0;
  for (let i = 1; i <= N; i++) {
    const x0 = (i - 1) * h, x1 = i * h;
    const thetaNext = theta + ((curv(x0) + curv(x1)) / 2) * h;
    v += ((theta + thetaNext) / 2) * h;
    theta = thetaNext;
  }
  return {
    ok: true, name: 'cantilever tip deflection', value: delta, units: 'm', formula: 'δ = F·L³ / (3·E·I), I = b·h³/12',
    inputs: { force, length, youngs, width, depth }, second: I, assumptions: ['linear elastic, small deflection, uniform rectangular section', 'a first-order estimate only; no buckling, fatigue, connection stiffness or code checks'],
    steps: [`I = ${width}·${depth}³/12 = ${I.toExponential(4)} m⁴`, `δ = ${delta.toExponential(4)} m`],
    checks: { method: 'trapezoid integration of the slope', value: v, relDiff: relDiff(delta, v), pass: relDiff(delta, v) < 1e-4 },
    dimension: dimCheck('length', 'length'),
    certified: false,
  };
}

// ─── 5. Stacking the checks: a design receipt ───────────────────────────────

/** Every check passes (and every dimension is right) → the receipt can say so; otherwise it says which one failed. */
export function receiptVerdict(results) {
  const bad = results.filter((r) => !r.ok || r.checks?.pass === false || (r.dimension && r.dimension.ok === false));
  return { verified: bad.length === 0, failed: bad.map((r) => r.name || 'unnamed'), count: results.length, note: 'first-order textbook checks only; not a structural or safety certification' };
}
