// Manifestation Engine, physical domain: battery-electric multirotor hover (a small drone, or a
// "flying car" sized the same way). Every number comes from the equations below; nothing is drafted by a model.
//
// Equations (SI units; g = 9.80665 m/s²):
//   m      = m_frame + m_battery + m_payload                                 [kg]
//   T      = m·g                     (hover: total thrust equals weight)     [N]
//   A      = n·π·D²/4                (total rotor disk area)                 [m²]
//   P_id   = T^(3/2) / sqrt(2·ρ·A)   (actuator-disk momentum theory)         [W]
//   P_hov  = P_id / (FM·η) + P_av    (figure of merit, motor+ESC efficiency) [W]
//   E_use  = m_battery·e·u·(1 − r)   (specific energy, usable fraction, reserve) [Wh]
//   t      = E_use / P_hov                                                   [h → min]
//   v_i    = sqrt(T / (2·ρ·A))       (induced velocity at the disk)         [m/s]
//   P_max  = (k·T)^(3/2) / sqrt(2·ρ·A) / (FM·η)  for thrust-to-weight k = 2  [W]
//   span   = 2·R + D, R = 1.1·D / (2·sin(π/n))  (rotors on a ring with 10% tip clearance) [m]
// Boundary conditions: steady hover out of ground effect, still air, no forward flight (cruise needs less
// power for a multirotor, so hover endurance is a conservative bound), rigid rotors, no battery voltage sag
// beyond the usable fraction. Closed-form result used in the tests: with P_av = 0, endurance is maximised at
// m_battery = 2·(m_frame + m_payload), because t ∝ m_b / (m0 + m_b)^(3/2).
// References: momentum theory and figure of merit (Leishman, Principles of Helicopter Aerodynamics, 2nd ed.,
// ch. 2; https://en.wikipedia.org/wiki/Momentum_theory), disk loading (https://en.wikipedia.org/wiki/Disk_loading),
// gasoline energy (https://en.wikipedia.org/wiki/Energy_density). The Simulation Lab's hover_flight model
// (sim_lab.js) uses the same ideal-power equation; a test checks the two agree.

import { add, div, mul, pow, q, scalar, sqrt } from './manifest_units.js';
import { bisect, goldenMax, round } from './manifest_stats.js';

export const G0 = 9.80665;
// Above this, a battery would need more energy per kilogram than burning gasoline releases (~46 MJ/kg).
export const HYDROCARBON_WH_PER_KG = 12_800;
// Today's battery packs (CHE planning assumption; cell-level figures run higher than packs).
export const TODAY_PACK_WH_PER_KG = 300;
// Small unmanned aircraft limit used for the "small drone" scale (55 lb, FAA Part 107).
export const SMALL_UAS_KG = 25;

const INPUTS = [
  { id: 'rotors', name: 'Rotors', unit: '1', kind: 'design', nominal: 4, physical: [3, 16], int: true },
  { id: 'rotor_diameter', name: 'Rotor diameter', unit: 'm', kind: 'design', nominal: 0.25, physical: [0.02, 20] },
  { id: 'frame_mass', name: 'Empty mass without battery or payload', unit: 'kg', kind: 'design', nominal: 1.1, physical: [0.01, 1e5] },
  { id: 'battery_mass', name: 'Battery mass', unit: 'kg', kind: 'design', nominal: 0.5, physical: [0, 1e5] },
  { id: 'payload', name: 'Payload', unit: 'kg', kind: 'design', nominal: 0.5, physical: [0, 1e5] },
  { id: 'reserve', name: 'Battery reserve kept for landing', unit: '1', kind: 'design', nominal: 0.2, physical: [0, 0.9] },
  { id: 'specific_energy', name: 'Battery pack specific energy', unit: 'Wh/kg', kind: 'uncertain', nominal: 200, lo: 150, hi: 250, today: [100, TODAY_PACK_WH_PER_KG], physical: [1, HYDROCARBON_WH_PER_KG], source: 'assumption: lithium-ion packs; replace with your pack\'s rated Wh ÷ its weighed mass' },
  { id: 'figure_of_merit', name: 'Rotor figure of merit', unit: '1', kind: 'uncertain', nominal: 0.6, lo: 0.5, hi: 0.7, today: [0.4, 0.8], physical: [0.01, 1], source: 'assumption: small rotors measure about 0.5 to 0.7 (Leishman ch. 2); a thrust-stand test measures yours' },
  { id: 'drive_efficiency', name: 'Motor and controller efficiency', unit: '1', kind: 'uncertain', nominal: 0.85, lo: 0.75, hi: 0.9, today: [0.6, 0.95], physical: [0.01, 1], source: 'assumption: brushless motor plus ESC' },
  { id: 'air_density', name: 'Air density', unit: 'kg/m^3', kind: 'uncertain', nominal: 1.225, lo: 1.1, hi: 1.25, physical: [0.01, 2], source: 'ISA sea level 1.225 kg/m³; lower when hot or high' },
  { id: 'usable_fraction', name: 'Usable fraction of rated battery energy', unit: '1', kind: 'uncertain', nominal: 0.9, lo: 0.85, hi: 0.95, physical: [0.01, 1], source: 'assumption: voltage sag and cutoff' },
  { id: 'avionics_power', name: 'Avionics and payload electrical power', unit: 'W', kind: 'uncertain', nominal: 10, lo: 5, hi: 20, physical: [0, 1e7], source: 'assumption: flight controller, radio, GPS, camera' },
  { id: 'target_endurance', name: 'Required hover endurance', unit: 'min', kind: 'goal', nominal: 20, physical: [0, Infinity] },
  { id: 'max_span', name: 'Largest allowed overall width', unit: 'm', kind: 'goal', nominal: Infinity, physical: [0, Infinity] },
  { id: 'budget', name: 'Budget', unit: 'USD', kind: 'goal', nominal: Infinity, physical: [0, Infinity] },
];

const OUTPUTS = [
  { id: 'endurance', name: 'Hover endurance', unit: 'min', better: 'higher' },
  { id: 'hover_power', name: 'Electrical hover power', unit: 'W', better: 'lower' },
  { id: 'ideal_power', name: 'Ideal (momentum theory) hover power', unit: 'W', better: 'lower' },
  { id: 'total_mass', name: 'Take-off mass', unit: 'kg', better: 'lower' },
  { id: 'weight', name: 'Weight (hover thrust)', unit: 'N' },
  { id: 'disk_area', name: 'Total rotor disk area', unit: 'm^2' },
  { id: 'disk_loading', name: 'Disk loading', unit: 'N/m^2', better: 'lower' },
  { id: 'induced_velocity', name: 'Induced velocity', unit: 'm/s' },
  { id: 'battery_energy', name: 'Rated battery energy', unit: 'Wh' },
  { id: 'usable_energy', name: 'Usable energy after reserve', unit: 'Wh' },
  { id: 'max_power', name: 'Electrical power for 2:1 thrust-to-weight', unit: 'W' },
  { id: 'span', name: 'Overall width', unit: 'm', better: 'lower' },
  { id: 'c_rate', name: 'Hover discharge rate', unit: '1/h' },
];

function geometry(n, D) {
  const area = n * Math.PI * D * D / 4;
  const ring = (1.1 * D) / (2 * Math.sin(Math.PI / n));
  return { area, span: 2 * ring + D };
}

function evaluate(x) {
  const m = x.frame_mass + x.battery_mass + x.payload;
  const T = m * G0;
  const { area, span } = geometry(x.rotors, x.rotor_diameter);
  const root = Math.sqrt(2 * x.air_density * area);
  const ideal = T ** 1.5 / root;
  const hover = ideal / (x.figure_of_merit * x.drive_efficiency) + x.avionics_power;
  const rated = x.battery_mass * x.specific_energy;
  const usable = rated * x.usable_fraction * (1 - x.reserve);
  const endurance = hover > 0 ? (usable / hover) * 60 : Infinity;
  const maxPower = (2 * T) ** 1.5 / root / (x.figure_of_merit * x.drive_efficiency) + x.avionics_power;
  const small = m <= SMALL_UAS_KG;
  // No part-price table is wired (DATA_SOURCES.part_prices), so the model produces no cost figure.
  const outputs = {
    endurance, hover_power: hover, ideal_power: ideal, total_mass: m, weight: T, disk_area: area,
    disk_loading: T / area, induced_velocity: Math.sqrt(T / (2 * x.air_density * area)), battery_energy: rated,
    usable_energy: usable, max_power: maxPower, span, c_rate: rated > 0 ? hover / rated : Infinity,
  };
  const checks = [
    { id: 'figure_of_merit_le_1', kind: 'physics', ok: x.figure_of_merit <= 1, text: 'Momentum theory: no rotor can hover on less than the ideal power (figure of merit ≤ 1).' },
    { id: 'efficiency_le_1', kind: 'physics', ok: x.drive_efficiency <= 1 && x.usable_fraction <= 1, text: 'Conservation of energy: no motor or battery returns more energy than it takes in (efficiency ≤ 1).' },
    { id: 'finite_endurance', kind: 'physics', ok: Number.isFinite(x.target_endurance), text: 'Conservation of energy: hovering takes continuous power, so stored energy always runs out; unlimited hover needs an outside power source.' },
    { id: 'chemical_energy', kind: 'physics', ok: x.specific_energy <= HYDROCARBON_WH_PER_KG, text: `No chemical store holds more than about ${HYDROCARBON_WH_PER_KG.toLocaleString('en-US')} Wh/kg (gasoline, ~46 MJ/kg).` },
    { id: 'battery_today', kind: 'technology', ok: x.specific_energy <= TODAY_PACK_WH_PER_KG, text: `Battery packs today reach about ${TODAY_PACK_WH_PER_KG} Wh/kg.` },
    { id: 'rotor_today', kind: 'technology', ok: x.figure_of_merit <= 0.8, text: 'Real rotors reach a figure of merit of about 0.8 at best.' },
    { id: 'endurance_goal', kind: 'goal', ok: endurance >= x.target_endurance, text: `Hover for at least ${round(x.target_endurance, 1)} minutes.` },
    { id: 'span_goal', kind: 'goal', ok: span <= x.max_span + 1e-9, text: Number.isFinite(x.max_span) ? `Fit within ${round(x.max_span, 2)} m overall width.` : 'No width limit.' },
    // null = cannot be judged: no part-price data source.
    { id: 'budget', kind: 'practical', ok: Number.isFinite(x.budget) ? null : true, text: Number.isFinite(x.budget) ? `Parts within $${Math.round(x.budget).toLocaleString('en-US')}: cannot be checked, no part-price data source.` : 'No budget limit.' },
    { id: 'small_uas', kind: 'practical', ok: small, text: `Under ${SMALL_UAS_KG} kg: a small unmanned aircraft. Heavier or crewed aircraft need certification.` },
  ];
  return { outputs, checks };
}

// The same equations evaluated with units: a dimension error throws.
function dimensional(x) {
  const g = q(G0, 'm/s^2');
  const m = add(add(q(x.frame_mass, 'kg'), q(x.battery_mass, 'kg')), q(x.payload, 'kg'));
  const T = mul(m, g);
  const D = q(x.rotor_diameter, 'm');
  const area = mul(scalar(x.rotors * Math.PI / 4), mul(D, D));
  const rho = q(x.air_density, 'kg/m^3');
  const root = sqrt(mul(scalar(2), mul(rho, area)));
  const ideal = div(pow(T, 1.5), root);
  const hover = add(div(ideal, scalar(x.figure_of_merit * x.drive_efficiency)), q(x.avionics_power, 'W'));
  const rated = mul(q(x.battery_mass, 'kg'), q(x.specific_energy, 'Wh/kg'));
  const usable = mul(rated, scalar(x.usable_fraction * (1 - x.reserve)));
  return {
    weight: T, disk_area: area, ideal_power: ideal, hover_power: hover, battery_energy: rated, usable_energy: usable,
    endurance: div(usable, hover), induced_velocity: sqrt(div(T, mul(scalar(2), mul(rho, area)))), disk_loading: div(T, area),
  };
}

/** Battery mass that maximises endurance for a design (golden-section search; 2·m0 when avionics power is 0). */
export function optimalBatteryMass(x) {
  const m0 = x.frame_mass + x.payload;
  return goldenMax((b) => evaluate({ ...x, battery_mass: b }).outputs.endurance, 0, 20 * Math.max(m0, 1e-3));
}

// Battery sized to the target with 15% margin, never past the endurance optimum.
function sizeBattery(x) {
  const best = optimalBatteryMass(x);
  const want = x.target_endurance * 1.15;
  const f = (b) => evaluate({ ...x, battery_mass: b }).outputs.endurance;
  if (f(best) < want) return best;
  return bisect(f, want, 1e-6, best) ?? best;
}

function scaleOf(spec) {
  return (spec.variables?.payload ?? 0) >= 50 || spec.flags?.person_carrying ? 'person' : 'small';
}

/** Three or four candidate designs for the spec, each a full set of design variables. */
function candidates(spec) {
  const v = spec.variables || {};
  const payload = v.payload ?? 0.5;
  const goals = { target_endurance: v.target_endurance ?? 20, max_span: v.max_span ?? Infinity, budget: spec.budget?.usd_max ?? Infinity };
  const out = [];
  const add = (id, name, description, design, notes = []) => {
    const x = { ...nominalInputs(), ...goals, payload, ...design };
    x.battery_mass = design.battery_mass ?? sizeBattery(x);
    out.push({ id, name, description, variables: roundVars(x), notes });
  };
  if (scaleOf(spec) === 'person') {
    // Person-carrying: structure, motors and seats assumed at 400 kg without battery (CHE assumption, labelled).
    const frame = v.frame_mass ?? 400;
    const avionics = 2000;
    const width = Number.isFinite(goals.max_span) ? goals.max_span : 2.55;
    // Rounded down to the millimetre so the rounded design still fits the width.
    const quadD = Math.floor(1000 * width / (2 * 1.1 / (2 * Math.sin(Math.PI / 4)) + 1)) / 1000;
    const octoD = Math.floor(1000 * width / (2 * 1.1 / (2 * Math.sin(Math.PI / 8)) + 1)) / 1000;
    add('quad-road', `Four rotors of ${round(quadD, 2)} m inside a ${round(width, 2)} m road width`, 'Largest four-rotor disk area that still fits the road-legal width.', { rotors: 4, rotor_diameter: round(quadD, 3), frame_mass: frame, avionics_power: avionics, max_span: width }, ['Empty mass 400 kg is a CHE assumption for a two-seat electric multirotor.']);
    add('octo-road', `Eight rotors of ${round(octoD, 2)} m inside the same width`, 'More rotors for redundancy if one motor fails, at the cost of less disk area.', { rotors: 8, rotor_diameter: round(octoD, 3), frame_mass: frame, avionics_power: avionics, max_span: width });
    add('quad-unlimited', 'Four 3 m rotors with no road-width limit', 'Shows what the width limit costs: far more disk area, not drivable on a road.', { rotors: 4, rotor_diameter: 3, frame_mass: frame, avionics_power: avionics, max_span: width });
    return out;
  }
  // Small drone: empty mass 0.8 kg + 0.6 kg per kg of payload (CHE scaling assumption for frame, motors and avionics).
  const frame = v.frame_mass ?? round(0.8 + 0.6 * payload, 3);
  add('quad-10in', 'Quadcopter, 10-inch (0.25 m) propellers', 'Compact and cheap; high disk loading costs endurance.', { rotors: 4, rotor_diameter: 0.254, frame_mass: frame });
  add('quad-15in', 'Quadcopter, 15-inch (0.38 m) propellers', 'Larger, slower propellers: less power to hover.', { rotors: 4, rotor_diameter: 0.381, frame_mass: frame + 0.15 });
  add('hex-15in', 'Hexacopter, 15-inch propellers', 'Six motors: can land after one motor fails; heavier.', { rotors: 6, rotor_diameter: 0.381, frame_mass: frame + 0.45 });
  add('quad-22in', 'Quadcopter, 22-inch (0.56 m) propellers', 'Lowest disk loading; large and slower to respond.', { rotors: 4, rotor_diameter: 0.559, frame_mass: frame + 0.4 });
  return out;
}

function nominalInputs() {
  return Object.fromEntries(INPUTS.map((i) => [i.id, i.nominal]));
}
const roundVars = (x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, Number.isFinite(v) ? round(v, 4) : v]));

/**
 * Feasibility for one candidate. `run` holds the Monte Carlo success probability. The limiting constraint is
 * found by solving: the battery specific energy this design would need, with its endurance-optimal battery, to meet
 * the target. Below today's packs it is buildable; up to the energy of gasoline it is plausible but unproven;
 * above that no known chemical store can do it.
 */
function classify({ x, nominal, run }) {
  const physics = nominal.checks.filter((c) => c.kind === 'physics' && !c.ok);
  const alternatives = alternativesFor(x);
  if (physics.length) {
    return { class: 'incompatible', violated: physics.map(({ id, text }) => ({ id, text })), limiting_constraint: { id: physics[0].id, text: physics[0].text }, reasons: physics.map((c) => c.text), alternatives };
  }
  const best = optimalBatteryMass(x);
  const atBest = evaluate({ ...x, battery_mass: best }).outputs.endurance;
  // Endurance is proportional to specific energy at a fixed battery mass, so the requirement solves exactly.
  const required = x.specific_energy * x.target_endurance / atBest;
  const limiting = {
    id: 'battery_specific_energy', text: 'Battery energy per kilogram (energy density)', required_wh_per_kg: round(required, 1),
    today_wh_per_kg: TODAY_PACK_WH_PER_KG, max_endurance_min_today: round(evaluate({ ...x, battery_mass: optimalBatteryMass({ ...x, specific_energy: TODAY_PACK_WH_PER_KG }), specific_energy: TODAY_PACK_WH_PER_KG }).outputs.endurance, 2),
    optimal_battery_kg: round(best, 3),
  };
  const p = run?.success_probability ?? (nominal.checks.every((c) => c.ok || c.kind === 'practical') ? 1 : 0);
  const practical = nominal.checks.filter((c) => c.kind === 'practical' && c.ok === false);
  const unchecked = nominal.checks.filter((c) => c.ok === null).map((c) => `Cannot check: ${c.text}`);
  const goalFails = nominal.checks.filter((c) => c.kind === 'goal' && !c.ok);
  if (required > HYDROCARBON_WH_PER_KG) {
    return { class: 'incompatible', violated: [{ id: 'chemical_energy', text: `Needs ${Math.round(required).toLocaleString('en-US')} Wh/kg, more than any chemical store (gasoline is about ${HYDROCARBON_WH_PER_KG.toLocaleString('en-US')} Wh/kg).` }], limiting_constraint: limiting, reasons: [`Even an ideal battery fraction needs ${Math.round(required).toLocaleString('en-US')} Wh/kg.`], alternatives };
  }
  if (required > TODAY_PACK_WH_PER_KG && p < 0.1) {
    return { class: 'unproven', violated: [], limiting_constraint: limiting, reasons: [`Meeting ${round(x.target_endurance, 1)} minutes needs about ${Math.round(required).toLocaleString('en-US')} Wh/kg; packs today reach about ${TODAY_PACK_WH_PER_KG}. Today's best gives about ${limiting.max_endurance_min_today} minutes.`], alternatives };
  }
  const geometryFail = goalFails.find((c) => c.id === 'span_goal');
  if (p >= 0.5 && !practical.length && !geometryFail) {
    return { class: 'feasible_now', violated: [], limiting_constraint: limiting, reasons: [`Meets every goal in ${Math.round(p * 100)}% of Monte Carlo runs.`, ...unchecked], alternatives };
  }
  const reasons = [
    ...(p < 0.5 ? [`Meets the endurance goal in only ${Math.round(p * 100)}% of Monte Carlo runs.`] : []),
    ...practical.map((c) => `Not met: ${c.text}`),
    ...(geometryFail ? [`Not met: ${geometryFail.text}`] : []),
    ...unchecked,
  ];
  return { class: 'feasible_expensive', violated: [], limiting_constraint: geometryFail ? { id: 'span_goal', text: geometryFail.text } : practical[0] ? { id: practical[0].id, text: practical[0].text } : limiting, reasons, alternatives };
}

/** Nearest achievable alternatives, each with numbers from the same model where it applies. */
function alternativesFor(x) {
  const safe = { ...x, figure_of_merit: Math.min(x.figure_of_merit, 0.8), drive_efficiency: Math.min(x.drive_efficiency, 1), usable_fraction: Math.min(x.usable_fraction, 1), specific_energy: Math.min(x.specific_energy, TODAY_PACK_WH_PER_KG), target_endurance: Number.isFinite(x.target_endurance) ? x.target_endurance : 20 };
  const best = optimalBatteryMass(safe);
  const today = evaluate({ ...safe, battery_mass: best }).outputs;
  const out = [{ id: 'best_today', name: 'Same craft with today\'s best battery fraction', class: today.total_mass <= SMALL_UAS_KG ? 'feasible_now' : 'feasible_expensive', text: `About ${round(today.endurance, 1)} minutes of hover with a ${round(best, 2)} kg battery at ${safe.specific_energy} Wh/kg.`, numbers: { endurance_min: round(today.endurance, 2), battery_kg: round(best, 3) } }];
  if (Number.isFinite(x.max_span)) {
    const wide = evaluate({ ...safe, rotor_diameter: safe.rotor_diameter * 2, battery_mass: best }).outputs;
    out.push({ id: 'bigger_rotors', name: 'Twice the rotor diameter, without the width limit', class: 'feasible_expensive', text: `Four times the disk area halves ideal power: about ${round(wide.endurance, 1)} minutes, ${round(wide.span, 2)} m wide.`, numbers: { endurance_min: round(wide.endurance, 2), span_m: round(wide.span, 2) } });
  }
  out.push({ id: 'tethered', name: 'Tethered hover on ground power', class: 'unknown', text: 'Endurance limited by the ground supply instead of the battery; height limited by the cable. Not modelled here.' });
  if (x.payload >= 50 || x.frame_mass >= 50) {
    out.push({ id: 'hybrid', name: 'Hybrid-electric: fuel and a generator', class: 'unknown', text: 'Fuel stores roughly 40 times more energy per kilogram than packs today, minus engine losses. Not modelled here.' });
    out.push({ id: 'winged', name: 'Roadable aircraft or gyroplane with wings or a free-spinning rotor', class: 'unknown', text: 'Wings carry the weight in cruise for far less power than hover; it needs a runway and a pilot licence. Not modelled here.' });
  }
  return out;
}

/** Realization plan steps for a drone candidate, with expected results from the model. */
function planSteps({ candidate, nominal }) {
  const o = nominal.outputs;
  const x = candidate.variables;
  const person = o.total_mass > SMALL_UAS_KG;
  if (person) {
    return [
      { title: 'Build and test a subscale unmanned model first', who: 'owner', instructions: ['Use the small-drone plan at about 1:10 scale to measure real hover power and compare it with this model.'], expected: `Hover power within the model\'s band, scaled.`, verification: 'measurement', consequential: null, safety: 'Unmanned only.', fallback: 'Recalibrate the model from the measured power before anything larger.' },
      { title: 'Talk to the aviation authority before any full-size build', who: 'owner', instructions: ['A crewed aircraft needs certification or an experimental permit. Ask what applies to an electric multirotor.'], expected: 'A written list of the rules that apply.', verification: 'owner_report', consequential: 'application', safety: 'No crewed flight without certified parts and a regulator-approved test programme.', fallback: 'Stay with unmanned subscale work.' },
    ];
  }
  const wh = Math.ceil(o.battery_energy);
  return [
    { title: 'Check local drone rules', who: 'owner', instructions: ['Read your aviation authority\'s small-drone rules. In the US the FAA requires registration for drones over 250 g and a recreational test (TRUST) or Part 107 for commercial use.', 'Write down where you may fly.'], materials: [], cost_usd: null, time: '1 to 2 hours', expected: 'You know where and how you may fly.', verification: 'owner_report', consequential: null, safety: 'Never fly over people, near airports or above the legal height.', fallback: 'Fly only at a club field.' },
    { title: 'Choose parts that match the model', who: 'che', instructions: [`Rotors: ${x.rotors} at ${round(x.rotor_diameter * 39.37, 1)} inches.`, `Motors and ESCs: at least ${Math.ceil(o.max_power / x.rotors)} W each for 2:1 thrust-to-weight.`, `Battery: about ${wh} Wh at ${round(x.battery_mass, 2)} kg or less; discharge rate at least ${Math.ceil(o.max_power / Math.max(o.battery_energy, 1))}C.`, `Frame: fits ${round(o.span, 2)} m overall.`], materials: ['motors', 'ESCs', 'propellers', 'battery', 'frame', 'flight controller', 'GPS', 'radio'], cost_usd: null, time: '1 evening', expected: 'A parts list matching these numbers, with real prices you look up (CHE has no part-price data source).', verification: 'artifact', consequential: null, safety: 'Buy batteries with protection and a fire-safe charging bag.', fallback: 'Pick the nearest stocked size and rerun the simulation with its real numbers.' },
    { title: 'Buy the parts', who: 'owner', instructions: ['Order the list after you approve it.'], cost_usd: null, time: '1 to 2 weeks delivery', expected: 'Parts on hand.', verification: 'owner_report', consequential: 'money', safety: '', fallback: 'Substitute and rerun the model.' },
    { title: 'Bench-test one motor and propeller on a thrust stand', who: 'owner', instructions: ['Clamp the motor to a stand on a kitchen scale, propeller pushing up, behind a guard.', `Raise throttle until thrust reads ${round(o.weight / x.rotors / G0 * 1000, 0)} grams; read the volts and amps.`, 'Report: grams of thrust, volts and amps.'], materials: ['kitchen scale', 'power meter'], cost_usd: null, time: '2 hours', expected: `About ${round((o.hover_power - x.avionics_power) / x.rotors, 0)} W per rotor at hover thrust.`, verification: 'measurement', consequential: null, safety: 'Eye protection; stand clear of the propeller plane; battery in a fire-safe bag.', fallback: 'If power is over 20% high, record it as an outcome: CHE recalibrates the figure of merit.' },
    { title: 'Assemble and hover tethered, then measure hover power', who: 'owner', instructions: ['Tie the drone to a weight with a 2 m line on open ground.', 'Hover 60 seconds; read average volts × amps from the flight log.'], time: '1 day', expected: `Hover power near ${Math.round(o.hover_power)} W.`, verification: 'measurement', consequential: null, safety: 'Tethered, outdoors, nobody within 10 m.', fallback: 'Recalibrate from the measured power.' },
    { title: 'Endurance flight with the payload', who: 'owner', instructions: [`Carry ${round(x.payload, 2)} kg; hover until the ${Math.round(x.reserve * 100)}% reserve alarm.`, 'Report the minutes flown.'], time: '1 hour', expected: `${round(o.endurance, 1)} minutes (see the Monte Carlo band).`, verification: 'measurement', metric: 'endurance', consequential: null, safety: 'Land at the reserve alarm.', fallback: 'If short, CHE compares it with the simulation and names the assumption that was wrong.' },
  ];
}

// Where each kind of number comes from, and when it was last checked. `kind: 'none'` means no data source is
// wired, so the model produces no figure of that kind.
export const DATA_SOURCES = Object.freeze([
  { id: 'momentum_theory', what: 'Hover power equation and figure-of-merit range', kind: 'reference', source: 'Leishman, Principles of Helicopter Aerodynamics, 2nd ed., ch. 2', url: 'https://en.wikipedia.org/wiki/Momentum_theory', as_of: '2026-10-27', stale_after_days: null },
  { id: 'battery_packs', what: 'Battery pack specific energy range (150–250 Wh/kg, today about 300 at best)', kind: 'assumed', source: 'CHE planning assumption; replace with your pack\'s rated Wh and weighed mass', url: '', as_of: '2026-10-27', stale_after_days: 365 },
  { id: 'gasoline', what: 'Chemical energy ceiling (~12,800 Wh/kg, gasoline ~46 MJ/kg)', kind: 'reference', source: 'Energy density tables', url: 'https://en.wikipedia.org/wiki/Energy_density', as_of: '2026-10-27', stale_after_days: null },
  { id: 'benchmark_p4p', what: 'Benchmark aircraft: DJI Phantom 4 Pro, 1,388 g, 89.2 Wh, about 30 min', kind: 'sourced', source: 'DJI product page (web search)', url: 'https://www.dji.com/us/phantom-4-pro', as_of: '2026-10-27', stale_after_days: null },
  { id: 'faa_rules', what: 'Small-drone rules (registration over 250 g)', kind: 'sourced', source: 'FAA', url: 'https://www.faa.gov/uas/recreational_flyers', as_of: '2026-10-27', stale_after_days: 365 },
  { id: 'road_width', what: 'Road vehicle width limit 2.55 m (EU), 8.5 ft (US)', kind: 'assumed', source: 'CHE reading of EU and US vehicle width rules; not linked to the regulation text', url: '', as_of: '2026-10-27', stale_after_days: 365 },
  { id: 'part_prices', what: 'Part prices (motors, batteries, frames)', kind: 'none', source: 'no data source', url: '', as_of: null, stale_after_days: null },
  { id: 'materials', what: 'Materials strength and mass tables', kind: 'none', source: 'no data source', url: '', as_of: null, stale_after_days: null },
]);

export const DRONE_MODEL = Object.freeze({
  id: 'multirotor_hover', version: 1, domain: 'physical',
  title: 'Battery-electric multirotor hover',
  method: 'Actuator-disk momentum theory with a figure of merit, plus a battery energy balance.',
  equations: [
    { id: 'mass', text: 'm = m_frame + m_battery + m_payload', units: 'kg' },
    { id: 'thrust', text: 'T = m·g', units: 'N' },
    { id: 'area', text: 'A = n·π·D²/4', units: 'm²' },
    { id: 'ideal_power', text: 'P_ideal = T^(3/2) / sqrt(2·ρ·A)', units: 'W', source: 'Momentum theory (Leishman ch. 2)' },
    { id: 'hover_power', text: 'P_hover = P_ideal / (FM·η) + P_avionics', units: 'W' },
    { id: 'usable_energy', text: 'E = m_battery·e·u·(1 − reserve)', units: 'Wh' },
    { id: 'endurance', text: 't = E / P_hover', units: 'min' },
    { id: 'induced_velocity', text: 'v_i = sqrt(T / (2·ρ·A))', units: 'm/s' },
    { id: 'max_power', text: 'P_max = (2T)^(3/2) / sqrt(2·ρ·A) / (FM·η) + P_avionics', units: 'W' },
    { id: 'span', text: 'span = 2·(1.1·D / (2·sin(π/n))) + D', units: 'm' },
  ],
  assumptions: ['Steady hover out of ground effect in still air; forward flight not modelled.', 'Rotors on a ring with 10% tip clearance.', 'No cost figures: no part-price data source is wired.', 'Frame-mass scaling and person-scale empty mass are CHE assumptions, labelled on each candidate.'],
  data_sources: DATA_SOURCES,
  references: [
    { title: 'Momentum theory', url: 'https://en.wikipedia.org/wiki/Momentum_theory' },
    { title: 'Disk loading', url: 'https://en.wikipedia.org/wiki/Disk_loading' },
    { title: 'Energy density', url: 'https://en.wikipedia.org/wiki/Energy_density' },
    { title: 'FAA: Recreational flyers', url: 'https://www.faa.gov/uas/recreational_flyers' },
  ],
  inputs: INPUTS, outputs: OUTPUTS, primary: 'endurance',
  outcome_metrics: ['endurance', 'hover_power'],
  evaluate, dimensional, candidates, classify, planSteps,
});
