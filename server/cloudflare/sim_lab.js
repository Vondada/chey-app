// CHE Simulation Lab (owner, 2026-10-20): "find the closest realistic solution" for an idea.
// It extends Concept-to-Plan (project_plan.js): the plan supplies the project type, safety level, parts and
// cost ranges; the lab searches the design space around it.
// Staged, multi-fidelity, with an explicit compute budget:
//   1. Screening: closed-form equations evaluated over many candidate designs. These are mathematical
//      predictions, counted as evaluations, never as simulations.
//   2. Refinement: evolutionary rounds around the best designs until the score stops improving, the
//      budget is spent, or the round limit is reached. The stopping reason is recorded.
//   3. Detailed: Monte Carlo runs on the strongest few designs, sampling the uncertain constants. These
//      are simulated results, with p10/p50/p90 and the probability each design meets every constraint.
// Nothing is built or measured here, so no result is ever labeled an experimental measurement or a
// proven real-world result. Every count in a run is the number of evaluations actually executed. Runs
// are seeded and reproducible. What worked and what failed is kept per model and seeds the next run.
// Pure except `saveRun` / `loadSimMemory` (DO storage + the Brain).

import { BRAIN_REGIONS, isSafeText } from './brain_store.js';
import { classifyProject, safetyCheck } from './project_plan.js';

export const SIM_VERSION = 1;
export const SIM_SOURCE = 'che_sim_lab';
export const EVIDENCE = Object.freeze({
  prediction: 'mathematical prediction',
  simulated: 'simulated result',
  measured: 'experimental measurement',
  proven: 'proven real-world result',
});
// From idea to proof. The lab can reach "simulated" at most; the later steps need the real world.
export const READINESS = Object.freeze(['idea', 'planned', 'mathematical prediction', 'simulated', 'prototype built', 'bench tested', 'proven in the real world']);
export const DEFAULT_BUDGET = 60_000;
export const MAX_BUDGET = 1_000_000;
const MC_CANDIDATES = 5;
const MC_SAMPLES = 1000;
const ELITE = 40;
const MAX_ROUNDS = 8;
const G = 9.81;

// ── Reproducible randomness ─────────────────────────────────────────────────────────────────────
export function rngFrom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function seedOf(text) {
  let h = 2166136261;
  for (const ch of String(text)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}
const uniform = (rng, lo, hi) => lo + (hi - lo) * rng();
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

// ── Models ──────────────────────────────────────────────────────────────────────────────────────
// A model: params (the design choices, each with the range available today), uncertain constants
// (sampled in Monte Carlo), constraints with the reason a design fails them, and evaluate(p, u).
// evaluate returns metrics, cost (USD), violations, margin, performance and complexity (0..1).
const HOVER = {
  id: 'hover_flight', version: 1, label: 'Electric hover flight for one person',
  method: 'Actuator-disk momentum theory: ideal hover power P = T^1.5 / sqrt(2·ρ·A), divided by the figure of merit and drive efficiency; mass solved to a fixed point because motors add mass.',
  // Person-carrying flight only: a drone carries no pilot, a game or story is fiction, a building does not fly.
  applies: (type, text) => !['software', 'game', 'business', 'building', 'apparel', 'footwear'].includes(type) && !/\bdrones?\b|\bquadcopters?\b/i.test(text)
    && /\b(?:fly|flies|flying|flight|hover\w*|jet\s*pack|jetpack|jet\s*suit|levitat\w*|airborne|take\s+off)\b/i.test(text),
  params: [
    { id: 'area', name: 'Total fan disk area', unit: 'm²', min: 0.3, max: 4, today: [0.3, 4] },
    { id: 'battery', name: 'Battery mass', unit: 'kg', min: 5, max: 80, today: [5, 80] },
    { id: 'energy', name: 'Battery pack specific energy', unit: 'Wh/kg', min: 150, max: 500, today: [150, 300] },
    { id: 'motor', name: 'Motor specific power', unit: 'kW/kg', min: 2, max: 12, today: [2, 7] },
  ],
  uncertain: [
    { id: 'fm', name: 'Fan figure of merit', lo: 0.55, hi: 0.75, nominal: 0.65 },
    { id: 'rho', name: 'Air density', unit: 'kg/m³', lo: 1.10, hi: 1.25, nominal: 1.225 },
    { id: 'eta', name: 'Motor and controller efficiency', lo: 0.85, hi: 0.92, nominal: 0.88 },
    { id: 'pack', name: 'Real pack energy vs. rated', lo: 0.9, hi: 1.0, nominal: 0.95 },
  ],
  constants: ['Pilot 80 kg, suit structure 25 kg, fans and ducts 4 kg per m² of disk', '20% battery reserve kept for landing', 'Costs: packs $300/kWh, motors and controllers $80/kW, fans $2,000/m², structure $5,000'],
  constraints: {
    mass_spiral: 'motors add more weight than their thrust lifts (the mass never settles)',
    too_short: 'under 3 minutes of hover, not a usable flight',
    not_wearable: 'more than 1.5 m² of fans, too large to wear',
    too_heavy: 'over 250 kg in total, too heavy to stand or land on legs',
    c_rate: 'the battery would have to discharge faster than 10C',
  },
  primary: { id: 'minutes', name: 'Hover time', unit: 'minutes' },
  costRef: 40_000,
  evaluate(p, u) {
    const fixed = 80 + 25 + 4 * p.area;
    const k = Math.sqrt(2 * u.rho * p.area) * u.fm;
    let mass = fixed + p.battery;
    let shaft = 0;
    for (let i = 0; i < 40; i += 1) {
      shaft = (mass * G) ** 1.5 / k;
      const next = fixed + p.battery + shaft / 1000 / p.motor;
      if (next > 1000) return { metrics: { minutes: 0, mass: next, power_kw: shaft / 1000 }, cost: Infinity, violations: ['mass_spiral'], margin: 0, performance: 0, complexity: 1 };
      if (Math.abs(next - mass) < 0.01) { mass = next; break; }
      mass = next;
    }
    const electric = shaft / u.eta;
    const energyWh = p.battery * p.energy * u.pack;
    const minutes = (energyWh * 0.8) / electric * 60;
    const cRate = electric / energyWh;
    const violations = [];
    if (minutes < 3) violations.push('too_short');
    if (p.area > 1.5) violations.push('not_wearable');
    if (mass > 250) violations.push('too_heavy');
    if (cRate > 10) violations.push('c_rate');
    const cost = (energyWh / 1000) * 300 + (shaft / 1000) * 80 + p.area * 2000 + 5000;
    return {
      metrics: { minutes, mass, power_kw: electric / 1000, disk_loading: (mass * G) / p.area, c_rate: cRate, battery_kwh: energyWh / 1000 },
      cost, violations,
      margin: Math.min(1, Math.max(0, Math.min((minutes - 3) / 10, (250 - mass) / 100, (10 - cRate) / 5))),
      performance: Math.min(1, minutes / 20),
      complexity: Math.min(1, p.area / 0.15 / 12),
    };
  },
  parts: (p, m) => [
    { name: 'Battery pack', spec: `${round(m.battery_kwh, 1)} kWh, ${round(p.battery, 1)} kg at ${Math.round(p.energy)} Wh/kg`, cost: Math.round(m.battery_kwh * 300) },
    { name: 'Electric fans and motors', spec: `${round(m.power_kw, 0)} kW in total, ${round(p.area, 2)} m² of disk, motors at ${round(p.motor, 1)} kW/kg`, cost: Math.round(m.power_kw * 80 + p.area * 2000) },
    { name: 'Suit structure and harness', spec: '25 kg frame carrying the fans and the pilot', cost: 5000 },
  ],
  hazard: 'Crewed flight can kill. Any test starts unmanned, tethered and subscale, under the aviation authority\'s rules.',
  roadmap: ['Check the hover model against a small tethered fan rig (thrust and power measured, unmanned).', 'Build a subscale unmanned demonstrator and measure hover time.', 'Full-size tethered, unmanned test with a dummy load.', 'Crewed flight only with certified parts, the regulator and a professional test programme.'],
  references: [{ title: 'Momentum theory', url: 'https://en.wikipedia.org/wiki/Momentum_theory' }, { title: 'Disk loading', url: 'https://en.wikipedia.org/wiki/Disk_loading' }],
};

const EV = {
  id: 'ev_range', version: 1, label: 'Battery-electric vehicle highway range',
  method: 'Road-load equation at 110 km/h: aerodynamic drag ½·ρ·Cd·A·v² plus rolling resistance Crr·m·g, over drivetrain efficiency, plus 1 kW of accessories.',
  applies: (type, text) => type === 'vehicle' && !HOVER.applies(type, text),
  params: [
    { id: 'kwh', name: 'Battery capacity', unit: 'kWh', min: 20, max: 200, today: [20, 120] },
    { id: 'base', name: 'Vehicle mass without battery', unit: 'kg', min: 900, max: 2200, today: [900, 2200] },
    { id: 'cd', name: 'Drag coefficient', unit: '', min: 0.18, max: 0.4, today: [0.21, 0.4] },
    { id: 'frontal', name: 'Frontal area', unit: 'm²', min: 1.9, max: 2.8, today: [1.9, 2.8] },
    { id: 'crr', name: 'Tyre rolling resistance', unit: '', min: 0.006, max: 0.013, today: [0.007, 0.013] },
  ],
  uncertain: [
    { id: 'pack', name: 'Pack specific energy', unit: 'Wh/kg', lo: 150, hi: 200, nominal: 175 },
    { id: 'eta', name: 'Drivetrain efficiency', lo: 0.85, hi: 0.92, nominal: 0.88 },
    { id: 'rho', name: 'Air density', unit: 'kg/m³', lo: 1.10, hi: 1.25, nominal: 1.225 },
  ],
  constants: ['Steady 110 km/h, flat road, no wind', '90% of the battery usable', 'Costs: packs $130/kWh, base vehicle $18,000, low-drag bodywork extra below Cd 0.30'],
  constraints: {
    short_range: 'under 300 km of highway range',
    too_heavy: 'over 2,800 kg in total',
  },
  primary: { id: 'range_km', name: 'Highway range', unit: 'km' },
  costRef: 35_000,
  evaluate(p, u) {
    const v = 110 / 3.6;
    const mass = p.base + (p.kwh * 1000) / u.pack;
    const force = 0.5 * u.rho * p.cd * p.frontal * v * v + p.crr * mass * G;
    const joulesPerM = force / u.eta + 1000 / v;
    const rangeKm = (p.kwh * 3.6e6 * 0.9) / joulesPerM / 1000;
    const violations = [];
    if (rangeKm < 300) violations.push('short_range');
    if (mass > 2800) violations.push('too_heavy');
    return {
      metrics: { range_km: rangeKm, mass, wh_per_km: joulesPerM / 3.6 },
      cost: p.kwh * 130 + 18000 + Math.max(0, 0.3 - p.cd) * 100_000,
      violations,
      margin: Math.min(1, Math.max(0, Math.min((rangeKm - 300) / 200, (2800 - mass) / 600))),
      performance: Math.min(1, rangeKm / 600),
      complexity: Math.min(1, Math.max(0, (0.32 - p.cd) / 0.14)),
    };
  },
  parts: (p, m) => [
    { name: 'Battery pack', spec: `${Math.round(p.kwh)} kWh`, cost: Math.round(p.kwh * 130) },
    { name: 'Body and aerodynamics', spec: `Cd ${round(p.cd, 3)}, ${round(p.frontal, 2)} m² frontal area`, cost: Math.round(Math.max(0, 0.3 - p.cd) * 100_000) },
    { name: 'Rolling chassis and drivetrain', spec: `${Math.round(p.base)} kg without battery, tyres Crr ${round(p.crr, 4)}, ${Math.round(m.mass)} kg in total`, cost: 18000 },
  ],
  hazard: 'Road vehicles need crash testing and type approval before anyone drives one on a public road.',
  roadmap: ['Check the model against a published efficiency rating for a similar production car.', 'Coast-down test of the real chassis to measure Cd·A and Crr.', 'Closed-track range test at 110 km/h.', 'Type approval before road use.'],
  references: [{ title: 'Drag equation', url: 'https://en.wikipedia.org/wiki/Drag_equation' }, { title: 'Rolling resistance', url: 'https://en.wikipedia.org/wiki/Rolling_resistance' }],
};

const EXO = {
  id: 'exo_runtime', version: 1, label: 'Powered exoskeleton runtime and weight',
  method: 'Energy balance: runtime = usable battery energy / (joints × average joint power + 20 W of electronics); suit mass from per-joint actuator mass.',
  applies: (type, text) => type === 'wearable_robotics' && !HOVER.applies(type, text),
  params: [
    { id: 'joints', name: 'Powered joints', unit: '', min: 2, max: 12, today: [2, 12], int: true },
    { id: 'watts', name: 'Average power per joint', unit: 'W', min: 20, max: 200, today: [20, 200] },
    { id: 'battery', name: 'Battery mass', unit: 'kg', min: 0.5, max: 8, today: [0.5, 8] },
    { id: 'energy', name: 'Battery pack specific energy', unit: 'Wh/kg', min: 150, max: 400, today: [150, 300] },
  ],
  uncertain: [
    { id: 'pack', name: 'Real pack energy vs. rated', lo: 0.85, hi: 1.0, nominal: 0.93 },
    { id: 'duty', name: 'Duty cycle vs. average', lo: 0.8, hi: 1.3, nominal: 1 },
  ],
  constants: ['Frame 3 kg, plus 1.8 kg per joint and 0.4 kg per joint for each 100 W', '85% of the battery usable', 'Costs: $600 per actuated joint plus $2 per watt, $0.60 per Wh of battery, frame $1,500'],
  constraints: {
    short_runtime: 'under 2 hours of use',
    too_heavy: 'over 25 kg to wear',
    too_weak: 'under 100 W of total assistance',
  },
  primary: { id: 'hours', name: 'Runtime', unit: 'hours' },
  costRef: 12_000,
  evaluate(p, u) {
    const draw = p.joints * p.watts * u.duty + 20;
    const wh = p.battery * p.energy * u.pack;
    const hours = (wh * 0.85) / draw;
    const mass = 3 + p.joints * (1.8 + 0.4 * (p.watts / 100)) + p.battery;
    const assist = p.joints * p.watts;
    const violations = [];
    if (hours < 2) violations.push('short_runtime');
    if (mass > 25) violations.push('too_heavy');
    if (assist < 100) violations.push('too_weak');
    return {
      metrics: { hours, mass, assist_w: assist, battery_wh: wh },
      cost: p.joints * (600 + 2 * p.watts) + wh * 0.6 + 1500,
      violations,
      margin: Math.min(1, Math.max(0, Math.min((hours - 2) / 4, (25 - mass) / 10))),
      performance: Math.min(1, assist / 800) * 0.6 + Math.min(1, hours / 8) * 0.4,
      complexity: p.joints / 12,
    };
  },
  parts: (p, m) => [
    { name: 'Joint actuators', spec: `${p.joints} joints at ${Math.round(p.watts)} W average`, cost: Math.round(p.joints * (600 + 2 * p.watts)) },
    { name: 'Battery pack', spec: `${Math.round(m.battery_wh)} Wh, ${round(p.battery, 1)} kg`, cost: Math.round(m.battery_wh * 0.6) },
    { name: 'Frame and straps', spec: `${round(m.mass, 1)} kg suit in total`, cost: 1500 },
  ],
  hazard: 'A powered joint can injure the wearer: test with hard torque limits and an emergency stop before anyone wears it.',
  roadmap: ['Bench-test one joint actuator and measure its real average power.', 'Build one powered joint on a test rig with a torque limit and an emergency stop.', 'Fit the full frame unpowered, then power one joint at a time.', 'Supervised wear tests with the stop in reach.'],
  references: [{ title: 'Powered exoskeleton', url: 'https://en.wikipedia.org/wiki/Powered_exoskeleton' }],
};

export const PHYSICS_MODELS = Object.freeze([HOVER, EV, EXO]);

// Universal configuration search: which option (cheapest, balanced, premium) for each plan item, and
// which optional items to include. Works for every project type the planner knows.
const TIERS = ['cheapest', 'balanced', 'premium'];
const TIER_QUALITY = [0.5, 0.75, 1];
const TIER_RISK = [1.3, 1, 0.8];
export function configModel(plan, budgetCap = null) {
  const items = (plan.items || []).filter((i) => i.cost?.balanced);
  const optional = items.filter((i) => !i.required);
  const params = [
    ...items.map((i) => ({ id: `tier:${i.id}`, name: `${i.name} option`, unit: '', min: 0, max: 2, today: [0, 2], int: true, item: i.id })),
    ...optional.map((i) => ({ id: `include:${i.id}`, name: `Include ${i.name}`, unit: '', min: 0, max: 1, today: [0, 1], int: true, item: i.id })),
  ];
  const first = (i, tier, u) => {
    const [lo, hi] = i.cost[TIERS[tier]];
    const v = lo + (hi - lo) * (u ? u[`cost:${i.id}`] : 0.5);
    return i.per === 'month' ? v * 12 : v;
  };
  const sizeSum = items.reduce((s, i) => s + i.size, 0) || 1;
  const riskMax = items.reduce((s, i) => s + i.complexity * TIER_RISK[0], 0) || 1;
  const costMax = items.reduce((s, i) => s + first(i, 2, null), 0) || 1;
  return {
    id: 'config_search', version: 1, label: `Option choices for ${plan.title}`,
    method: 'Every combination of cheapest, balanced or premium per item, and of the optional items, scored on first-year cost (monthly costs × 12), quality and risk. Monte Carlo samples each item\'s cost inside its estimated range.',
    params,
    uncertain: items.map((i) => ({ id: `cost:${i.id}`, name: `${i.name} cost within its range`, lo: 0, hi: 1, nominal: 0.5 })),
    constants: [`Item cost ranges from the plan (${plan.estimate_basis?.method || 'CHE estimates'})`, 'Quality 0.5, 0.75 and 1 for the cheapest, balanced and premium options; risk falls as quality rises', budgetCap ? `Budget ceiling $${budgetCap.toLocaleString('en-US')} for the first year` : 'No budget ceiling was given'],
    constraints: { over_budget: 'over the budget ceiling' },
    primary: { id: 'first_year', name: 'First-year cost', unit: 'USD' },
    costRef: costMax / 2,
    combinations: items.reduce((n) => n * 3, 1) * 2 ** optional.length,
    evaluate(p, u) {
      let cost = 0;
      let quality = 0;
      let risk = 0;
      for (const i of items) {
        if (!i.required && !p[`include:${i.id}`]) continue;
        const tier = p[`tier:${i.id}`];
        cost += first(i, tier, u);
        quality += TIER_QUALITY[tier] * i.size;
        risk += i.complexity * TIER_RISK[tier];
      }
      const violations = budgetCap && cost > budgetCap ? ['over_budget'] : [];
      return {
        metrics: { first_year: cost, quality: quality / sizeSum, risk: risk / riskMax },
        cost, violations,
        margin: budgetCap ? Math.min(1, Math.max(0, (budgetCap - cost) / budgetCap)) : 1 - risk / riskMax,
        performance: quality / sizeSum,
        complexity: risk / riskMax,
      };
    },
    parts: (p) => items.filter((i) => i.required || p[`include:${i.id}`]).map((i) => {
      const tier = p[`tier:${i.id}`];
      const [lo, hi] = i.cost[TIERS[tier]];
      return { name: i.name, spec: `${TIERS[tier]}: ${i.options[TIERS[tier]]}`, cost: Math.round(((lo + hi) / 2) * (i.per === 'month' ? 12 : 1)), per: i.per };
    }),
    hazard: '',
    roadmap: (plan.stages || []).map((s) => `Stage ${s.n}, ${s.name}: ${s.items.length} item${s.items.length === 1 ? '' : 's'}.`),
    references: [],
  };
}

// ── Scoring ─────────────────────────────────────────────────────────────────────────────────────
// Ranking dimensions, 0..1 each. Feasibility is 1/0 in screening and the Monte Carlo probability later.
export const WEIGHTS = Object.freeze({ feasibility: 0.3, closeness: 0.2, performance: 0.2, cost: 0.15, reliability: 0.1, simplicity: 0.05 });
function closenessOf(model, p) {
  const ps = model.params;
  if (!ps.length) return 1;
  let inside = 0;
  for (const q of ps) if (p[q.id] >= q.today[0] - 1e-9 && p[q.id] <= q.today[1] + 1e-9) inside += 1;
  return inside / ps.length;
}
function scoreOf(model, p, r, feasibility) {
  const dims = {
    feasibility,
    closeness: closenessOf(model, p),
    performance: r.performance,
    cost: Number.isFinite(r.cost) ? 1 / (1 + r.cost / model.costRef) : 0,
    reliability: r.margin,
    simplicity: 1 - r.complexity,
  };
  // "Closest realistic": a design that needs technology beyond today's range ranks below one that does not.
  let score = -0.3 * (1 - dims.closeness);
  for (const [k, w] of Object.entries(WEIGHTS)) score += w * dims[k];
  return { score, dims };
}
const nominal = (model) => Object.fromEntries(model.uncertain.map((u) => [u.id, u.nominal]));

// ── The search ──────────────────────────────────────────────────────────────────────────────────
function sampleParams(model, rng) {
  const p = {};
  for (const q of model.params) {
    const v = uniform(rng, q.min, q.max + (q.int ? 0.999 : 0));
    p[q.id] = q.int ? Math.min(q.max, Math.floor(v)) : v;
  }
  return p;
}
function mutate(model, base, rng, sigma) {
  const p = {};
  for (const q of model.params) {
    const span = q.max - q.min;
    if (q.int) {
      p[q.id] = rng() < sigma ? Math.min(q.max, Math.floor(uniform(rng, q.min, q.max + 0.999))) : base[q.id];
    } else {
      p[q.id] = Math.min(q.max, Math.max(q.min, base[q.id] + (rng() * 2 - 1) * sigma * span));
    }
  }
  return p;
}
const keyOf = (model, p) => model.params.map((q) => (q.int ? p[q.id] : p[q.id].toFixed(4))).join('|');

/**
 * Runs one model: screening, refinement rounds, then Monte Carlo on the best designs.
 * `budget` caps screening evaluations; the counts returned are the ones executed.
 */
export function runModel(model, { seed = 1, budget = DEFAULT_BUDGET, prior = [] } = {}) {
  const rng = rngFrom(seed);
  const u0 = nominal(model);
  const cap = Math.max(100, Math.min(MAX_BUDGET, Math.floor(budget)));
  const eliminated = Object.fromEntries(Object.keys(model.constraints).map((k) => [k, 0]));
  let evaluations = 0;
  let feasibleCount = 0;
  const elite = new Map();
  let closest = null;
  const consider = (p) => {
    const r = model.evaluate(p, u0);
    evaluations += 1;
    if (r.violations.length) {
      for (const v of r.violations) eliminated[v] += 1;
      if (!closest || r.violations.length < closest.r.violations.length || (r.violations.length === closest.r.violations.length && r.performance > closest.r.performance)) closest = { p, r };
      return;
    }
    feasibleCount += 1;
    const { score } = scoreOf(model, p, r, 1);
    const key = keyOf(model, p);
    if (elite.has(key)) return;
    if (elite.size < ELITE) { elite.set(key, { p, score }); return; }
    let worstKey = null;
    let worst = Infinity;
    for (const [k, e] of elite) if (e.score < worst) { worst = e.score; worstKey = k; }
    if (score > worst) { elite.delete(worstKey); elite.set(key, { p, score }); }
  };
  const best = () => Math.max(-1, ...[...elite.values()].map((e) => e.score));

  const rounds = [];
  let stop = 'budget';
  let reused = 0;
  for (const p of prior) {
    if (evaluations >= cap) break;
    if (model.params.every((q) => typeof p?.[q.id] === 'number')) { consider(p); reused += 1; }
  }
  if (model.combinations && model.combinations <= cap - evaluations) {
    // Small enough to try every combination: exhaustive, no sampling.
    const ps = model.params;
    const counter = ps.map(() => 0);
    for (let n = 0; n < model.combinations; n += 1) {
      consider(Object.fromEntries(ps.map((q, i) => [q.id, counter[i]])));
      for (let i = 0; i < ps.length; i += 1) {
        counter[i] += 1;
        if (counter[i] <= ps[i].max) break;
        counter[i] = 0;
      }
    }
    rounds.push({ round: 1, kind: 'exhaustive', evaluations, best: round(best(), 4) });
    stop = 'exhaustive';
  } else {
    const first = Math.floor((cap - evaluations) * 0.4);
    for (let i = 0; i < first; i += 1) consider(sampleParams(model, rng));
    rounds.push({ round: 1, kind: 'random screening', evaluations, best: round(best(), 4) });
    let stale = 0;
    const perRound = Math.floor((cap - evaluations) / MAX_ROUNDS);
    for (let r = 2; r <= MAX_ROUNDS + 1; r += 1) {
      if (evaluations >= cap || perRound < 1) { stop = 'budget'; break; }
      const parents = [...elite.values()];
      if (!parents.length) {
        for (let i = 0; i < perRound && evaluations < cap; i += 1) consider(sampleParams(model, rng));
      } else {
        const sigma = 0.25 * 0.6 ** (r - 2);
        for (let i = 0; i < perRound && evaluations < cap; i += 1) consider(mutate(model, parents[i % parents.length].p, rng, sigma));
      }
      const before = rounds.at(-1).best;
      const now = round(best(), 4);
      rounds.push({ round: r, kind: 'refinement', evaluations, best: now });
      stale = before > -1 && now - before < 0.002 ? stale + 1 : 0;
      if (stale >= 2) { stop = 'converged'; break; }
      if (r === MAX_ROUNDS + 1) stop = 'max_rounds';
    }
  }

  // Detailed stage: Monte Carlo over the uncertain constants for the strongest distinct designs.
  const top = [...elite.values()].sort((a, b) => b.score - a.score).slice(0, MC_CANDIDATES);
  let samples = 0;
  const candidates = top.map(({ p }, rank) => {
    const values = [];
    const costs = [];
    let ok = 0;
    for (let s = 0; s < MC_SAMPLES; s += 1) {
      const u = Object.fromEntries(model.uncertain.map((c) => [c.id, uniform(rng, c.lo, c.hi)]));
      const r = model.evaluate(p, u);
      samples += 1;
      if (!r.violations.length) ok += 1;
      values.push(r.metrics[model.primary.id]);
      costs.push(r.cost);
    }
    values.sort((a, b) => a - b);
    costs.sort((a, b) => a - b);
    const r = model.evaluate(p, u0);
    const feasibility = ok / MC_SAMPLES;
    const { score, dims } = scoreOf(model, p, r, feasibility);
    const beyond = model.params.filter((q) => p[q.id] < q.today[0] - 1e-9 || p[q.id] > q.today[1] + 1e-9).map((q) => q.name);
    return {
      id: `c${rank + 1}`, params: Object.fromEntries(model.params.map((q) => [q.id, q.int ? p[q.id] : round(p[q.id], 4)])),
      metrics: Object.fromEntries(Object.entries(r.metrics).map(([k, v]) => [k, round(v, 3)])),
      primary: { ...model.primary, nominal: round(r.metrics[model.primary.id], 2), p10: round(quantile(values, 0.1), 2), p50: round(quantile(values, 0.5), 2), p90: round(quantile(values, 0.9), 2) },
      cost: { nominal: Math.round(r.cost), p10: Math.round(quantile(costs, 0.1)), p90: Math.round(quantile(costs, 0.9)) },
      feasibility: round(feasibility, 3), score: round(score, 4), dims: Object.fromEntries(Object.entries(dims).map(([k, v]) => [k, round(v, 3)])),
      beyond_today: beyond, evidence: 'simulated',
      parts: model.parts(p, r.metrics),
    };
  }).sort((a, b) => b.score - a.score).map((c, i) => ({ ...c, rank: i + 1 }));

  const closestMiss = closest && !candidates.length ? {
    params: Object.fromEntries(model.params.map((q) => [q.id, q.int ? closest.p[q.id] : round(closest.p[q.id], 4)])),
    metrics: Object.fromEntries(Object.entries(closest.r.metrics).map(([k, v]) => [k, round(v, 3)])),
    fails: closest.r.violations.map((v) => model.constraints[v]), evidence: 'prediction',
  } : null;
  return {
    model: { id: model.id, version: model.version, label: model.label, method: model.method, constants: model.constants, uncertain: model.uncertain.length > 12 ? [{ name: `${model.uncertain.length} item costs, each inside its range` }] : model.uncertain, params: model.params.map(({ id, name, unit, min, max, today, int }) => ({ id, name, unit, min, max, today, int: Boolean(int) })), primary: model.primary, references: model.references },
    seed, budget: cap, stop,
    counts: { screening_evaluations: evaluations, feasible: feasibleCount, eliminated: evaluations - feasibleCount, monte_carlo_samples: samples, detailed_candidates: candidates.length, reused_prior: reused, combinations: model.combinations || null },
    eliminated: Object.entries(eliminated).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ id, reason: model.constraints[id], count: n })),
    rounds, candidates, closest_miss: closestMiss,
    hazard: model.hazard, roadmap: model.roadmap,
  };
}

// ── Requests ────────────────────────────────────────────────────────────────────────────────────
const WAKE = /^(?:(?:hey\s+)?(?:che|chay|chey|shay)[,:]?\s+)?(?:please\s+|can\s+you\s+|could\s+you\s+|would\s+you\s+|now\s+|and\s+|then\s+)*/i;
const ASK = /\b(?:(?:closest|most)\s+realistic\s+(?:solution|version|design|option|way|answer)s?|simulat(?:e|ions?)\s+(?:and\s+optimi[sz]e\s+)?(?:this|that|it|the|my|a|an|some|many|lots|millions|thousands|billions|\d)|run\s+(?:a\s+|the\s+|some\s+)?(?:[\d,.]+\s*)?(?:thousand\s+|million\s+|billion\s+)?(?:simulations?|sims)\s+(?:on|for|of)\b|explore\s+(?:the\s+|all\s+|many\s+)?(?:possible\s+)?(?:solutions|designs|candidates|options)\s+(?:for|to)\b|optimi[sz]e\s+(?:this|the|my)\s+(?:design|plan|idea|concept|prototype|build)|(?:open|show)\s+(?:me\s+)?(?:the\s+)?(?:simulation|invention)\s+lab|invention\s+lab)\b/i;
const NOT_SIM = /\b(?:strateg(?:y|ies)|trad(?:e|es|ing)|paper|mnq|backtest\w*|portfolio|stocks?|futures|broker|account|flight\s+simulator|conversation|interview|meeting|negotiation)\b/i;
const LAB_ONLY = /^(?:open|show)\s+(?:me\s+)?(?:the\s+)?(?:simulation|invention)\s+lab\s*$/i;
const BUDGET_WORDS = { thousand: 1e3, million: 1e6, millions: 1e6, billion: 1e9, billions: 1e9 };

/** A Simulation Lab request, or null: { subject, budget, open }. */
export function simLabIntent(message) {
  const raw = String(message || '').replace(/[’]/g, "'").trim();
  if (!raw || raw.length > 1500) return null;
  const body = raw.replace(WAKE, '').trim().replace(/[.?!]+$/, '');
  if (!ASK.test(body) || NOT_SIM.test(body)) return null;
  if (LAB_ONLY.test(body)) return { subject: '', budget: null, open: true };
  // "Run a million simulations": the owner's budget, capped at MAX_BUDGET.
  let budget = null;
  const COUNT = /\b(?:(\d[\d,]*(?:\.\d+)?|an?)\s*(thousand|million|billion)?|(thousands|millions|billions)(?:\s+of)?)\s+(?:candidate\s+)?(?:designs|candidates|evaluations|simulations|sims|options)\b/i;
  const n = COUNT.exec(body);
  if (n && (n[2] || n[3] || /\d/.test(n[1] || ''))) {
    budget = n[3] ? BUDGET_WORDS[n[3].toLowerCase()] : (/\d/.test(n[1]) ? Number(n[1].replace(/,/g, '')) : 1) * (n[2] ? BUDGET_WORDS[n[2].toLowerCase()] : 1);
  }
  const subject = body
    .replace(COUNT, 'simulations')
    .replace(/\b(?:find|give\s+me|show\s+me|what(?:'s|\s+is)|get|search\s+for)?\s*(?:the\s+)?(?:closest|most)\s+realistic\s+(?:solution|version|design|option|way|answer)s?\b/i, '')
    .replace(/\b(?:simulat(?:e|ions?)(?:\s+and\s+optimi[sz]e)?|run\s+(?:a\s+|the\s+|some\s+)?(?:simulations?|sims)|explore\s+(?:the\s+|all\s+|many\s+)?(?:possible\s+)?(?:solutions|designs|candidates|options)|optimi[sz]e)\b/i, '')
    .replace(/^\s*simulations\b/i, '')
    .replace(/^[\s,]*(?:and\s+)?(?:for|to|of|on)?\s*/i, '')
    .replace(/^(?:(?:this|that|the|my)\s+(?:idea|plan|design|concept|project|prototype|build|invention)|this|that|it)\s*$/i, '')
    .trim();
  // "The most realistic option for dinner" is not a design question: a phrase about realism alone needs
  // an idea CHE can model (a known project type or person-carrying flight), or none named at all.
  const realismOnly = !/\b(?:simulat|run\s|explore|optimi[sz]e|lab\b)/i.test(body);
  if (realismOnly && subject && !/\b(?:idea|plan|design|concept|prototype|invention)\b/i.test(subject)) {
    const type = classifyProject(subject).type.id;
    if (type === 'project' && !PHYSICS_MODELS.some((m) => m.applies(type, subject))) return null;
  }
  return { subject: subject.split(/\s+/).length >= 2 ? subject : '', budget, open: false };
}

function budgetCapOf(text) {
  const m = /\b(?:under|below|less\s+than|within|budget\s+(?:of|is)|max(?:imum)?\s+(?:of\s+)?)\s*\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|m|million)?\b/i.exec(String(text || ''));
  if (!m) return null;
  const mult = /^(?:k|thousand)$/i.test(m[2] || '') ? 1e3 : /^(?:m|million)$/i.test(m[2] || '') ? 1e6 : 1;
  return Number(m[1].replace(/,/g, '')) * mult;
}

/** Which models a plan gets: the physics model that fits its type, if any, and always the option search. */
export function modelsFor(plan) {
  const text = plan.request || '';
  const physics = PHYSICS_MODELS.filter((m) => m.applies(plan.type, text));
  return [...physics, configModel(plan, budgetCapOf(text))];
}

// Domains the planner knows but the lab has no physics model for yet: honest about the gap.
const MISSING = {
  aerospace: 'an orbital or rocket performance model (the lab only has electric hover flight)',
  building: 'a structural load and energy model for buildings',
  electronics: 'a circuit power and thermal model',
  physical_product: 'a structural strength and manufacturing cost model',
  footwear: 'a material wear and comfort model',
  apparel: 'a fabric and pattern-yield model',
  software: 'a load, latency and hosting-cost model',
  game: 'a performance-budget model for the target devices',
  business: 'a unit-economics and cash-flow model',
  project: 'a domain model for this kind of project',
};

/**
 * The lab run for one plan: safety first, then each model, then the ranking across them, the findings,
 * the readiness and the spoken summary. `memory` is { [modelKey]: { best: [params] } } from earlier runs.
 */
export function runLab(plan, { id, seed, budget = DEFAULT_BUDGET, memory = {}, now = new Date().toISOString() } = {}) {
  const { type } = classifyProject(plan.request || '');
  const safety = plan.safety || safetyCheck(plan.request || '', type);
  const runId = id || `sim-${Date.now().toString(36)}`;
  const base = { id: runId, version: SIM_VERSION, plan_id: plan.id, title: plan.title, request: plan.request, type: plan.type, type_label: plan.type_label, created_at: now, safety: { level: safety.level, notes: safety.notes || [], excluded: safety.excluded || [] } };
  if (safety.level === 'refuse' || plan.refused) {
    return { ...base, refused: true, models: [], spoken: `I won't simulate that, sir. ${(safety.notes || []).join(' ')} I can run the lab on a safe version of the idea.` };
  }
  const requested = budget || DEFAULT_BUDGET;
  const cap = Math.max(1000, Math.min(MAX_BUDGET, Math.floor(requested)));
  const runSeed = Number.isInteger(seed) ? seed >>> 0 : seedOf(`${plan.request}|${SIM_VERSION}`);
  const models = modelsFor(plan);
  // The physics model gets most of the budget; the option search is usually small enough to be exhaustive.
  const shares = models.length > 1 ? [...models.slice(0, -1).map(() => 0.8 / (models.length - 1)), 0.2] : [1];
  const runs = models.map((m, i) => runModel(m, { seed: (runSeed + i * 7919) >>> 0, budget: Math.floor(cap * shares[i]), prior: memory[`${m.id}@${m.version}`]?.best || [] }));
  const lead = runs[0];
  const best = lead.candidates[0] || null;
  const hazard = runs.map((r) => r.hazard).filter(Boolean);
  const totals = runs.reduce((t, r) => ({ screening_evaluations: t.screening_evaluations + r.counts.screening_evaluations, monte_carlo_samples: t.monte_carlo_samples + r.counts.monte_carlo_samples, eliminated: t.eliminated + r.counts.eliminated, feasible: t.feasible + r.counts.feasible, reused_prior: t.reused_prior + r.counts.reused_prior }), { screening_evaluations: 0, monte_carlo_samples: 0, eliminated: 0, feasible: 0, reused_prior: 0 });
  const findings = [];
  for (const r of runs) {
    const c = r.candidates[0];
    if (c) findings.push({ model: r.model.id, evidence: 'simulated', text: `${r.model.label}: the best design gives ${r.model.primary.name.toLowerCase()} of ${fmt(c.primary.p50, r.model.primary.unit)} (p10 ${fmt(c.primary.p10, r.model.primary.unit)}, p90 ${fmt(c.primary.p90, r.model.primary.unit)}), meeting every constraint in ${Math.round(c.feasibility * 100)}% of ${MC_SAMPLES} Monte Carlo runs.` });
    else if (r.closest_miss) findings.push({ model: r.model.id, evidence: 'prediction', text: `${r.model.label}: no design met every constraint. The closest still fails: ${r.closest_miss.fails.join('; ')}.` });
    if (r.eliminated[0]) findings.push({ model: r.model.id, evidence: 'prediction', text: `Most designs failed because of ${r.eliminated[0].reason} (${r.eliminated[0].count.toLocaleString('en-US')} of ${r.counts.screening_evaluations.toLocaleString('en-US')}).` });
  }
  const unresolved = [
    ...runs.flatMap((r) => r.candidates.slice(0, 1).flatMap((c) => c.beyond_today.map((name) => `The best ${r.model.label.toLowerCase()} design needs ${name.toLowerCase()} beyond what is available today.`))),
    ...(MISSING[plan.type] && !runs.some((r) => r.model.id !== 'config_search') ? [`No physics model yet: ${MISSING[plan.type]}. Only the option choices were searched.`] : []),
    'No model here has been benchmarked against measured data yet; treat the numbers as predictions to test.',
    ...(plan.speculative || []).map((s) => `${s.name} stays speculative: ${s.why}`),
  ];
  const missing = MISSING[plan.type] && !runs.some((r) => r.model.id !== 'config_search') ? [{ need: MISSING[plan.type], how: 'A CHE coding job can add it as a tested model in sim_lab.js. It uses a paid AI model, so it starts only when you say so.' }] : [];
  const readiness = { stage: lead.counts.monte_carlo_samples ? 'simulated' : 'mathematical prediction', ladder: READINESS, index: READINESS.indexOf(lead.counts.monte_carlo_samples ? 'simulated' : 'mathematical prediction') };
  const assumptions = [...new Set(runs.flatMap((r) => r.model.constants)), 'Every count above is the number of evaluations this run executed; screening evaluations are equations, not simulations.'];
  const result = {
    ...base,
    seed: runSeed, budget: cap, requested_budget: requested, models: runs, totals, findings, unresolved, assumptions, missing_capabilities: missing, readiness,
    hazard_notes: hazard.length ? [...hazard, 'A simulated result is never proof that a real-world test is safe.'] : [],
    evidence_levels: EVIDENCE,
    roadmap: lead.roadmap,
    best: best ? { model: lead.model.id, ...best } : null,
  };
  result.spoken = speakLab(result);
  return result;
}

function fmt(v, unit) {
  if (unit === 'USD') return `$${Math.round(v).toLocaleString('en-US')}`;
  const n = Math.abs(v) < 1 && v !== 0 ? Number(v.toPrecision(2)).toString() : Number(v).toLocaleString('en-US', { maximumFractionDigits: v < 10 ? 1 : 0 });
  return `${n}${unit ? ` ${unit}` : ''}`;
}

/** A design in words: physics parameters with units, or for option choices how many items take each tier. */
export function describeDesign(model, params) {
  if (model.id !== 'config_search') return model.params.map((q) => `${q.name.toLowerCase()} ${fmt(params[q.id], q.unit)}`).join(', ');
  const counts = [0, 0, 0];
  for (const q of model.params) if (q.id.startsWith('tier:')) counts[params[q.id]] += 1;
  const left = model.params.filter((q) => q.id.startsWith('include:') && !params[q.id]).map((q) => q.name.replace(/^Include /, ''));
  return `${TIERS.map((t, i) => `${counts[i]} item${counts[i] === 1 ? '' : 's'} ${t}`).join(', ')}${left.length ? `, leaving out ${left.join(' and ')}` : ''}`;
}

/** The run read aloud: what ran (actual counts, labeled), the closest realistic design, why others failed, and what is unproven. */
export function speakLab(run) {
  if (run.refused) return run.spoken;
  const t = run.totals;
  const lead = run.models[0];
  const lines = [
    `Simulation Lab for ${run.title}, sir. I screened ${t.screening_evaluations.toLocaleString('en-US')} candidate designs with equations, which are mathematical predictions, not simulations, and ran ${t.monte_carlo_samples.toLocaleString('en-US')} Monte Carlo simulations on the strongest ${run.models.reduce((n, m) => n + m.counts.detailed_candidates, 0)}.`,
  ];
  if (run.requested_budget > run.budget) lines.push(`You asked for ${run.requested_budget.toLocaleString('en-US')}; one run is capped at ${run.budget.toLocaleString('en-US')} evaluations, so that is what ran.`);
  if (t.reused_prior) lines.push(`${t.reused_prior} earlier best design${t.reused_prior === 1 ? ' was' : 's were'} reused as starting points.`);
  const c = lead.candidates[0];
  if (c) {
    lines.push(`Closest realistic solution, ${lead.model.label.toLowerCase()}: ${describeDesign(lead.model, c.params)}. ${lead.model.primary.name}: about ${fmt(c.primary.p50, lead.model.primary.unit)}, between ${fmt(c.primary.p10, lead.model.primary.unit)} and ${fmt(c.primary.p90, lead.model.primary.unit)}; it met every constraint in ${Math.round(c.feasibility * 100)}% of runs. Estimated cost about ${fmt(c.cost.nominal, 'USD')}.`);
    if (c.beyond_today.length) lines.push(`It still needs ${c.beyond_today.join(' and ').toLowerCase()} beyond today's technology.`);
  } else if (lead.closest_miss) {
    lines.push(`No design met every constraint. The closest still fails: ${lead.closest_miss.fails.join('; ')}.`);
  }
  if (lead.eliminated.length) lines.push(`Eliminated ${lead.counts.eliminated.toLocaleString('en-US')}: mostly ${lead.eliminated.slice(0, 2).map((e) => e.reason).join(', then ')}.`);
  if (run.missing_capabilities.length) lines.push(`I have no physics model for this yet, so only the option choices were searched.`);
  lines.push('These are simulated results, not measurements: nothing has been built or tested.');
  if (run.hazard_notes.length) lines.push(run.hazard_notes[0]);
  return lines.join(' ');
}

// ── Storage, memory and the Brain ───────────────────────────────────────────────────────────────
const INDEX_KEY = 'sim_runs_index';
const MAX_RUNS = 20;
const memoryKey = (model) => `sim_memory:${model.id}@${model.version}`;

/** What earlier runs learned, per model: { [id@version]: { runs, best, eliminated } }. */
export async function loadSimMemory(storage, plan) {
  const out = {};
  for (const m of modelsFor(plan)) {
    if (m.id === 'config_search') continue; // option choices are specific to one plan
    const mem = await storage.get(memoryKey(m));
    if (mem) out[`${m.id}@${m.version}`] = mem;
  }
  return out;
}

/** Saves the run, updates each physics model's memory of what worked and failed, and records it in the Brain. */
export async function saveRun(storage, store, run) {
  await storage.put(`sim_run:${run.id}`, run);
  const index = (await storage.get(INDEX_KEY)) || [];
  const next = [{ id: run.id, title: run.title, plan_id: run.plan_id, created_at: run.created_at }, ...index.filter((r) => r.id !== run.id)];
  for (const old of next.slice(MAX_RUNS)) await storage.delete(`sim_run:${old.id}`);
  await storage.put(INDEX_KEY, next.slice(0, MAX_RUNS));
  if (run.refused) return null;
  for (const m of run.models) {
    if (m.model.id === 'config_search') continue;
    const key = `sim_memory:${m.model.id}@${m.model.version}`;
    const mem = (await storage.get(key)) || { runs: 0, best: [], eliminated: {}, worked: [] };
    const eliminated = { ...mem.eliminated };
    for (const e of m.eliminated) eliminated[e.id] = (eliminated[e.id] || 0) + e.count;
    const best = [...m.candidates.slice(0, 3).map((c) => c.params), ...mem.best].slice(0, 6);
    const worked = [...m.candidates.slice(0, 1).map((c) => ({ run: run.id, params: c.params, p50: c.primary.p50, feasibility: c.feasibility })), ...mem.worked].slice(0, 10);
    await storage.put(key, { runs: mem.runs + 1, best, eliminated, worked, updated_at: run.created_at });
  }
  if (!store) return null;
  const body = [
    `Simulation Lab run for: ${run.request}`,
    ...run.models.map((m) => `Model ${m.model.id} v${m.model.version} (${m.model.method}). Seed ${m.seed}, budget ${m.budget}, stopped: ${m.stop}. ${m.counts.screening_evaluations} screening evaluations (mathematical predictions), ${m.counts.monte_carlo_samples} Monte Carlo samples (simulated).`),
    ...run.findings.map((f) => `[${EVIDENCE[f.evidence]}] ${f.text}`),
    `Assumptions: ${run.assumptions.join('; ')}.`,
    `Unresolved: ${run.unresolved.join(' ')}`,
    ...run.hazard_notes,
    'Evidence level: simulated at most. Nothing was built or measured.',
  ].join('\n');
  // Research descriptions can contain strings shaped like credentials even when the
  // simulation is safe. Never store those lines in Brain; keep the verified-safe
  // observations with an explicit withholding notice instead of losing the run.
  const cleanLines = body.split('\n').filter((line) => isSafeText(line));
  const cleanBody = cleanLines.join('\n');
  const withheld = 'Some simulation details were withheld because they resembled private credentials.';
  const safeBody = isSafeText(body) ? body
    : isSafeText(cleanBody) ? `${cleanBody}\n${withheld}`
      : `Simulation recorded. ${withheld}`;
  const brainRecord = {
    id: `sim_run:${run.id}`, kind: 'simulation_run', region: BRAIN_REGIONS.projects, path: run.type_label,
    title: `Simulation: ${run.title}`, body: safeBody, verification: 'proposed', created_at: run.created_at,
    source: { store: 'sim_runs', id: run.id, plan: run.plan_id, route: SIM_SOURCE, models: run.models.map((m) => `${m.model.id}@${m.model.version}`), seed: run.seed, evidence: 'simulated', references: run.models.flatMap((m) => m.model.references.map((r) => r.url)) },
  };
  const written = store.put(brainRecord);
  return written;
}

export async function loadRun(storage, id) {
  if (id) return (await storage.get(`sim_run:${id}`)) || null;
  const index = (await storage.get(INDEX_KEY)) || [];
  return index[0] ? (await storage.get(`sim_run:${index[0].id}`)) || null : null;
}

export async function listRuns(storage) {
  return (await storage.get(INDEX_KEY)) || [];
}
