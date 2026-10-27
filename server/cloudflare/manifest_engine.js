// CHE Manifestation Engine (owner, 2026-10-27): a goal becomes a structured spec, candidate solutions, real
// domain models, a comparison under equal conditions, a Realization Plan and a tracked project whose steps are
// verified only by evidence. It extends the Simulation Lab (sim_lab.js: seeded randomness and evidence levels)
// and Concept-to-Plan (project_plan.js: classification and the safety layer); it is not a second planner or
// agent. Office work stays on the existing queue: this engine records who should do each step and never invents
// a task, a result or an agent's words.
//
// Every number comes from a model in manifest_drone.js, manifest_business.js or manifest_jobsearch.js; a model
// may never be replaced by a language model's figure. Runs are seeded and recorded with their inputs, model
// version and equations, so any run can be replayed exactly.

import { classifyProject, safetyCheck } from './project_plan.js';
import { EVIDENCE as SIM_EVIDENCE } from './sim_lab.js';
import { as, convert, sameDimension } from './manifest_units.js';
import { bisect, rngFrom, round, seedOf, summarize, triangular } from './manifest_stats.js';
import { DRONE_MODEL } from './manifest_drone.js';
import { BUSINESS_MODEL } from './manifest_business.js';
import { JOBSEARCH_MODEL } from './manifest_jobsearch.js';

export const ENGINE_VERSION = 1;
export const MANIFEST_SOURCE = 'che_manifest';
export const STATUSES = Object.freeze(['IDEA', 'RESEARCH', 'FEASIBILITY', 'SIMULATION', 'PLAN', 'EXECUTION', 'VERIFICATION', 'COMPLETE']);
export const SIDE_STATUSES = Object.freeze(['FAILED', 'BLOCKED']);
export const FEASIBILITY = Object.freeze({
  feasible_now: 'feasible now',
  feasible_expensive: 'feasible but expensive or impractical',
  unproven: 'theoretically plausible but unproven',
  unknown: 'unknown: insufficient evidence',
  incompatible: 'incompatible with established physical constraints',
});
const CLASS_ORDER = ['feasible_now', 'feasible_expensive', 'unproven', 'unknown', 'incompatible'];
export const EVIDENCE_LEVELS = SIM_EVIDENCE;
export const MODELS = Object.freeze({ [DRONE_MODEL.id]: DRONE_MODEL, [BUSINESS_MODEL.id]: BUSINESS_MODEL, [JOBSEARCH_MODEL.id]: JOBSEARCH_MODEL });
const DOMAIN_MODEL = { physical: DRONE_MODEL, business: BUSINESS_MODEL, employment: JOBSEARCH_MODEL };
export const MISSING_MODELS = Object.freeze({
  unknown: 'No domain model fits this goal yet. Models exist for multirotor flight, business unit economics and job searches; anything else needs a new tested model first.',
});
export const DEFAULT_SAMPLES = 2000;
const SCREEN_SAMPLES = 200;
const MAX_SAMPLES = 20000;
const OFFICE_DEPARTMENT = { physical: 'engineering', business: 'intelligence', employment: 'research' };

const clip = (s, n) => String(s ?? '').slice(0, n);
const newIdDefault = (prefix) => `${prefix}-${crypto.randomUUID().slice(0, 12)}`;

// ── Spec builder ────────────────────────────────────────────────────────────────────────────────
const NUM_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };
const num = (s) => (s == null ? NaN : Object.hasOwn(NUM_WORDS, String(s).toLowerCase()) ? NUM_WORDS[String(s).toLowerCase()] : Number(String(s).replace(/,/g, '')));
const money = (n, k) => num(n) * (/^(?:k|thousand)$/i.test(k || '') ? 1e3 : /^(?:m|million)$/i.test(k || '') ? 1e6 : 1);
const NUMBER = '(\\d[\\d,]*(?:\\.\\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten|twelve)';
const DOLLARS = '\\$\\s?(\\d[\\d,]*(?:\\.\\d+)?)\\s*(k|thousand|m|million)?';

const PHYSICAL = /\b(?:drones?|quad-?copters?|multi-?rotors?|multicopters?|hexacopters?|octocopters?|uavs?|flying\s+cars?|evtols?|air\s*taxis?|personal\s+(?:air|flying)\s+(?:vehicle|car|machine)s?|hover(?!craft)\w*)\b/i;
const EMPLOYMENT = /\b(?:a\s+(?:new\s+)?job|jobs?\s+(?:offer|search|hunt)|get\s+hired|employment|career\s+change|job\s+offer|land\s+(?:a\s+)?(?:job|role|position)|find\s+(?:a\s+)?(?:job|work|role|position))\b/i;
const BUSINESS = /\b(?:business|side\s+hustle|start(?:ing)?\s+(?:a|an|my)\s+\w+(?:\s+\w+)?\s+(?:company|shop|service|store)|income|revenue|profit|make\s+money|earn\s+\$|sell(?:ing)?\s+\w+|customers)\b/i;

/** Which domain model a goal fits: physical (multirotor), business, employment, or unknown. */
export function detectDomain(text) {
  const t = String(text || '');
  if (PHYSICAL.test(t)) return 'physical';
  if (EMPLOYMENT.test(t) && !/\b(?:business|my\s+own\s+company|self-employ\w*)\b/i.test(t)) return 'employment';
  if (BUSINESS.test(t)) return 'business';
  return 'unknown';
}

function parsePhysical(t, found) {
  const people = new RegExp(`${NUMBER}\\s+(?:people|persons|passengers|seats?|adults|riders)`, 'i').exec(t);
  const flyingCar = /\b(?:flying\s+cars?|air\s*taxis?|personal\s+(?:air|flying)|evtols?)\b/i.test(t);
  if (people || flyingCar) {
    const n = people ? num(people[1]) : 2;
    found('payload', n * 100, 'kg', people ? people[0] : 'flying car (assumed two people)', !!people, '100 kg per person including luggage (CHE assumption)');
    found('person_carrying', 1, '1', people ? people[0] : 'flying car', true);
  }
  const load = new RegExp(`(?:carr(?:y|ies|ying)|lift(?:s|ing)?|payload\\s+of|deliver(?:s|ing)?)\\s+(?:a\\s+|up\\s+to\\s+)?(\\d+(?:\\.\\d+)?)\\s*(kg|kilograms?|g|grams?|lbs?|pounds?)\\b`, 'i').exec(t);
  if (load) {
    const u = load[2].toLowerCase();
    const kg = /^(?:g|grams?)$/.test(u) ? num(load[1]) / 1000 : /^(?:lbs?|pounds?)$/.test(u) ? num(load[1]) * 0.45359237 : num(load[1]);
    found('payload', round(kg, 4), 'kg', load[0], true);
  }
  if (/\b(?:forever|indefinitely|unlimited\s+(?:flight|hover|time)|never\s+(?:lands?|needs?\s+to\s+(?:land|charge|recharge))|without\s+(?:ever\s+)?(?:landing|charging|recharging|refuel\w*))\b/i.test(t)) {
    found('target_endurance', Infinity, 'min', 'unlimited flight', true);
  } else {
    const dur = new RegExp(`(?:fl(?:y|ies)|hover|stay\\s+(?:up|airborne)|airborne|flight\\s+time\\s+of|endurance\\s+of|for)\\s+(?:for\\s+)?(?:at\\s+least\\s+)?${NUMBER}\\s*(minutes?|mins?|hours?|hrs?)\\b`, 'i').exec(t)
      || new RegExp(`${NUMBER}[-\\s](minute|hour)s?\\s+(?:flights?|hover|endurance)`, 'i').exec(t);
    if (dur) found('target_endurance', num(dur[1]) * (/^h/i.test(dur[2]) ? 60 : 1), 'min', dur[0], true);
  }
  const width = /\b(?:no\s+wider\s+than|under|within|at\s+most)\s+(\d+(?:\.\d+)?)\s*(m|meters?|metres?)\s+(?:wide|across|width)/i.exec(t);
  if (width) found('max_span', num(width[1]), 'm', width[0], true);
  else if (/\b(?:flying\s+cars?|drive\s+on\s+(?:the\s+)?roads?|road-?legal|roadable)\b/i.test(t)) found('max_span', 2.55, 'm', 'drives on roads', false, 'Road vehicles are limited to about 2.55 m wide (EU limit; the US limit is 8.5 ft, 2.59 m).');
}

function parseBusiness(t, found) {
  const price = new RegExp(`(?:charg(?:e|ing)|price\\s+(?:of|at|is)?|sell(?:\\s+\\w+){0,3}\\s+(?:for|at))\\s+${DOLLARS}`, 'i').exec(t);
  if (price) found('price', money(price[1], price[2]), 'USD/item', price[0], true);
  const variable = new RegExp(`${DOLLARS}\\s+(?:per|a|each|for\\s+each)\\s+\\w+\\s+(?:in|for|of)\\s+(?:supplies|materials|parts|ingredients|fees|costs?)|(?:supplies|materials|parts|ingredients|variable\\s+costs?)\\s+(?:of|cost|costs|are|is|run|at)?\\s*(?:about\\s+)?${DOLLARS}`, 'i').exec(t);
  if (variable) found('variable_cost', money(variable[1] ?? variable[3], variable[2] ?? variable[4]), 'USD/item', variable[0], true);
  const fixed = new RegExp(`${DOLLARS}\\s+(?:a|per)\\s+month\\s+(?:in|for|of|on)\\s+(?:fixed|insurance|rent|overhead|costs|expenses|software|bills)|(?:fixed\\s+costs?|overhead|insurance|rent|expenses)\\s+(?:of|is|are|run|costs?|at)?\\s*(?:about\\s+)?${DOLLARS}\\s*(?:a|per|\\/)\\s*month`, 'i').exec(t);
  if (fixed) found('fixed_monthly', money(fixed[1] ?? fixed[3], fixed[2] ?? fixed[4]), 'USD/month', fixed[0], true);
  const startup = new RegExp(`(?:start-?up|equipment|to\\s+get\\s+started|initial|upfront)\\s+(?:costs?|spend|investment|of)?\\s*(?:of|is|are|about)?\\s*${DOLLARS}|${DOLLARS}\\s+(?:to\\s+start|in\\s+equipment|upfront|start-?up)`, 'i').exec(t);
  if (startup) found('startup_cost', money(startup[1] ?? startup[3], startup[2] ?? startup[4]), 'USD', startup[0], true);
  const units = new RegExp(`${NUMBER}\\s+(?:customers|sales|cars|clients|jobs|orders|bookings|cuts|meals)\\s+(?:in\\s+the\\s+first\\s+month|the\\s+first\\s+month|a\\s+month|per\\s+month|to\\s+start)`, 'i').exec(t);
  if (units) found('units_month1', num(units[1]), 'item/month', units[0], true);
  const cap = new RegExp(`(?:up\\s+to|at\\s+most|max(?:imum)?\\s+of)\\s+${NUMBER}\\s+(?:customers|sales|cars|clients|jobs|orders|bookings)\\s+(?:a|per)\\s+month`, 'i').exec(t);
  if (cap) found('capacity', num(cap[1]), 'item/month', cap[0], true);
  const target = new RegExp(`(?:earn|make|profit\\s+of|income\\s+of|net|clear)\\s+(?:at\\s+least\\s+)?${DOLLARS}\\s*(?:a|per|\\/|each)\\s*month`, 'i').exec(t);
  if (target) found('target_profit', money(target[1], target[2]), 'USD/month', target[0], true);
}

function parseEmployment(t, found) {
  const apps = new RegExp(`${NUMBER}\\s+applications?\\s+(?:a|per|each)\\s+week`, 'i').exec(t);
  if (apps) found('apps_per_week', num(apps[1]), 'item/week', apps[0], true);
  const rate = (id, words) => {
    const m = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*%\\s+(?:${words})(?:\\s+rate)?`, 'i').exec(t);
    if (m) found(id, num(m[1]) / 100, '1', m[0], true);
  };
  rate('response_rate', 'repl(?:y|ies)|responses?|callbacks?');
  rate('interview_rate', 'interviews?');
  rate('offer_rate', 'offers?');
  const hours = new RegExp(`${NUMBER}\\s+hours?\\s+(?:a|per)\\s+week`, 'i').exec(t);
  if (hours) found('available_hours', num(hours[1]), 'h/week', hours[0], true);
}

/**
 * The structured spec for a goal. Pure. Numbers the owner said are marked `owner_text`; numbers given through
 * the API are `owner_api`; everything else is a model default, labelled as an assumption on its input.
 */
export function buildSpec(request, { overrides = {}, now = new Date().toISOString() } = {}) {
  const raw = clip(request, 1500).replace(/[’]/g, "'").trim();
  const text = raw.replace(/^(?:(?:hey\s+)?(?:che|chay|chey|shay)[,:]?\s+)?(?:please\s+)?(?:manifest(?:ation)?(?:\s+engine)?[,:]?\s*)?/i, '').trim();
  const { type } = classifyProject(text);
  const safety = safetyCheck(text, type);
  const domain = detectDomain(text);
  const model = DOMAIN_MODEL[domain] || null;
  const parsed = [];
  const variables = {};
  const owner = {};
  const flags = {};
  const found = (id, value, unit, said, fromOwner, note = '') => {
    if (id === 'person_carrying') { flags.person_carrying = true; return; }
    variables[id] = value;
    if (fromOwner) owner[id] = 'owner_text';
    parsed.push({ id, value, unit, text: clip(said, 120), source: fromOwner ? 'owner_text' : 'assumption', ...(note ? { note } : {}) });
  };
  if (domain === 'physical') parsePhysical(text, found);
  if (domain === 'business') parseBusiness(text, found);
  if (domain === 'employment') parseEmployment(text, found);
  // Budget and timeline, any domain.
  const budget = new RegExp(`(?:budget\\s+(?:of|is)?|with(?:\\s+only)?|have|under|up\\s+to|no\\s+more\\s+than|invest|spend)\\s+(?:about\\s+)?${DOLLARS}(?!\\s*(?:a|per|\\/)\\s*month)`, 'i').exec(text);
  const timeline = new RegExp(`(?:within|in|by|over|inside)\\s+(?:the\\s+next\\s+)?${NUMBER}\\s+(weeks?|months?|years?)`, 'i').exec(text);
  const months = timeline ? num(timeline[1]) * (/^w/i.test(timeline[2]) ? 12 / 52 : /^y/i.test(timeline[2]) ? 12 : 1) : null;
  if (domain === 'business' && months) { variables.target_month = Math.max(1, Math.round(months)); owner.target_month = 'owner_text'; }
  if (domain === 'employment' && months) { variables.target_weeks = Math.max(1, Math.round(months * 52 / 12)); owner.target_weeks = 'owner_text'; }
  for (const [k, v] of Object.entries(overrides || {})) {
    if (!model?.inputs.some((i) => i.id === k)) continue;
    const n = Number(v);
    if (!Number.isFinite(n) && v !== Infinity) continue;
    variables[k] = n;
    owner[k] = 'owner_api';
    parsed.push({ id: k, value: n, unit: model.inputs.find((i) => i.id === k).unit, text: 'given through the API', source: 'owner_api' });
  }
  const spec = {
    version: ENGINE_VERSION, request: raw, goal: text, created_at: now, domain,
    model: model ? { id: model.id, version: model.version, title: model.title } : null,
    safety: { level: safety.level, notes: safety.notes || [], excluded: safety.excluded || [] },
    refused: safety.level === 'refuse',
    budget: { usd_max: budget ? money(budget[1], budget[2]) : null, source: budget ? 'owner_text' : 'not given', text: budget ? budget[0] : '' },
    timeline: { months: months ? round(months, 2) : null, weeks: months ? round(months * 52 / 12, 1) : null, source: timeline ? 'owner_text' : 'not given', text: timeline ? timeline[0] : '' },
    variables, owner_variables: owner, flags, parsed,
    constraints: [], assumptions: [], resources: [], deliverables: [], success_criteria: [], verification_methods: [],
    missing_model: model ? null : MISSING_MODELS.unknown,
  };
  if (!model) return spec;
  const v = { ...Object.fromEntries(model.inputs.map((i) => [i.id, i.nominal])), ...variables };
  spec.assumptions = [
    ...model.assumptions,
    ...model.inputs.filter((i) => !(i.id in owner) && i.kind !== 'goal' && (i.source || i.placeholder)).map((i) => `${i.name}: ${fmtNum(i.nominal)} ${i.unit === '1' ? '' : i.unit}${i.lo != null ? ` (range ${fmtNum(i.lo)}–${fmtNum(i.hi)})` : ''}, ${i.source || 'placeholder until you give your own figure'}.`.replace(/\s+,/, ',')),
    ...parsed.filter((p) => p.note).map((p) => p.note),
  ];
  spec.resources = ['CHE: specs, models, simulations, comparisons and plans (no cost).', ...(spec.budget.usd_max ? [`Your budget: $${spec.budget.usd_max.toLocaleString('en-US')}.`] : []), ...(spec.timeline.months ? [`Your timeline: ${spec.timeline.text}.`] : []), 'You: every physical step, purchase, application or signature.'];
  if (domain === 'physical') {
    spec.constraints = [`Payload ${fmtNum(v.payload)} kg.`, Number.isFinite(v.target_endurance) ? `Hover at least ${fmtNum(v.target_endurance)} minutes.` : 'Hover without ever landing or recharging.', ...(Number.isFinite(v.max_span) ? [`At most ${fmtNum(v.max_span)} m wide.`] : []), ...(spec.budget.usd_max ? [`Parts within $${spec.budget.usd_max.toLocaleString('en-US')}.`] : [])];
    spec.success_criteria = [{ metric: 'endurance', op: '>=', value: v.target_endurance, unit: 'min', text: `Measured hover endurance at least ${fmtNum(v.target_endurance)} minutes with the payload.` }];
    spec.deliverables = ['Parts list sized from the model', 'Bench thrust and power measurements', 'Assembled aircraft', 'Endurance flight log'];
    spec.verification_methods = ['Thrust-stand measurement of thrust and electrical power', 'Tethered hover power from the flight log', 'Timed endurance flight to the reserve alarm'];
  } else if (domain === 'business') {
    spec.constraints = [`Monthly profit of $${fmtNum(v.target_profit)} by month ${v.target_month}.`, ...(spec.budget.usd_max ? [`Cash put in at most $${spec.budget.usd_max.toLocaleString('en-US')}.`] : [])];
    spec.success_criteria = [{ metric: 'profit_last_month', op: '>=', value: v.target_profit, unit: 'USD/month', text: `A real month with at least $${fmtNum(v.target_profit)} operating profit by month ${v.target_month}.` }];
    spec.deliverables = ['Demand check with 10 likely customers', 'Real quotes for every cost', 'Pilot month sales record', 'Month-3 go or no-go review'];
    spec.verification_methods = ['Customer answers written down', 'Quotes and receipts', 'Monthly sales and cost records'];
  } else {
    spec.constraints = [`An even chance of an offer by week ${v.target_weeks}.`, `At most ${fmtNum(v.available_hours)} hours a week.`];
    spec.success_criteria = [{ metric: 'weeks_to_offer_p50', op: '<=', value: v.target_weeks, unit: 'week', text: `A written job offer by week ${v.target_weeks}.` }];
    spec.deliverables = ['Résumé you approve', 'Application tracking sheet', 'Interview preparation', 'Offer decision'];
    spec.verification_methods = ['Tracking sheet counts (applications, replies, interviews)', 'Offer letter you report'];
  }
  return spec;
}

/** A number as CHE reads it aloud: whole numbers from 100 up, three significant digits below. */
export function fmtNum(n) {
  if (n === Infinity) return 'unlimited';
  if (!Number.isFinite(n)) return String(n);
  return Math.abs(n) >= 100 ? Math.round(n).toLocaleString('en-US') : String(Number(n.toPrecision(3)));
}

// ── Simulation, sweeps, sensitivity ────────────────────────────────────────────────────────────
function inputRange(model, inp, value, ranges) {
  if (ranges?.[inp.id]) return ranges[inp.id];
  if (inp.lo == null) return [value, value];
  // A candidate's own value keeps the default's relative spread.
  const base = inp.nominal || 1;
  const lo = value * (inp.lo / base);
  const hi = value * (inp.hi / base);
  return [Math.max(inp.physical?.[0] ?? -Infinity, Math.min(lo, hi)), Math.min(inp.physical?.[1] ?? Infinity, Math.max(lo, hi))];
}

function fullInputs(model, variables) {
  return { ...Object.fromEntries(model.inputs.map((i) => [i.id, i.nominal])), ...variables };
}

/** The dimensional check: each equation recomputed with units must agree with the numeric path. */
export function dimensionCheck(model, x, nominal) {
  try {
    const qs = model.dimensional(x);
    const checked = [];
    for (const [id, quantity] of Object.entries(qs)) {
      const out = model.outputs.find((o) => o.id === id);
      if (!out) { checked.push({ id, dimension: 'consistent' }); continue; }
      const v = as(quantity, out.unit);
      const expect = nominal.outputs[id];
      // A non-finite numeric result (no endurance limit, never breaks even) has nothing to compare.
      const ok = !Number.isFinite(expect) || Math.abs(v - expect) <= 1e-6 * Math.max(1, Math.abs(expect));
      if (!ok) return { ok: false, checked, error: `${id}: ${v} with units vs ${expect} without` };
      checked.push({ id, unit: out.unit, value: round(v, 6) });
    }
    return { ok: true, checked, error: '' };
  } catch (error) {
    return { ok: false, checked: [], error: String(error?.message || error) };
  }
}

const successOf = (r) => r.checks.every((c) => c.ok || c.kind === 'practical');

/**
 * One repeatable simulation run: the nominal evaluation, the dimensional check and a seeded Monte Carlo over
 * the uncertain inputs (triangular, low–nominal–high). Returns a run record; `id` and `created_at` are the only
 * fields a replay may change.
 */
export function simulate(model, variables, { seed, samples = DEFAULT_SAMPLES, ranges = null, id = '', now = new Date().toISOString(), kind = 'simulation', candidate_id = '', calibrated = false } = {}) {
  const x = fullInputs(model, variables);
  const n = Math.max(1, Math.min(MAX_SAMPLES, Math.floor(samples)));
  const runSeed = Number.isInteger(seed) ? seed >>> 0 : seedOf(JSON.stringify([model.id, model.version, x]));
  const nominal = model.evaluate(x);
  const rng = rngFrom(runSeed);
  const uncertain = model.inputs.filter((i) => i.kind === 'uncertain').map((i) => ({ id: i.id, name: i.name, unit: i.unit, nominal: x[i.id], range: inputRange(model, i, x[i.id], ranges), int: !!i.int }));
  const values = Object.fromEntries(model.outputs.map((o) => [o.id, []]));
  let ok = 0;
  for (let s = 0; s < n; s += 1) {
    const xs = { ...x };
    for (const u of uncertain) {
      const v = triangular(rng, u.range[0], u.nominal, u.range[1]);
      xs[u.id] = u.int ? Math.round(v) : v;
    }
    const r = model.evaluate(xs);
    if (successOf(r)) ok += 1;
    for (const o of model.outputs) values[o.id].push(r.outputs[o.id]);
  }
  const summary = Object.fromEntries(model.outputs.map((o) => [o.id, { unit: o.unit, ...summarize(values[o.id]) }]));
  return {
    id, kind, candidate_id, calibrated, engine_version: ENGINE_VERSION,
    model: { id: model.id, version: model.version, title: model.title },
    equations: model.equations.map((e) => `${e.text} [${e.units}]`),
    // Inputs and ranges are stored exactly as sampled, so a replay is bit-for-bit identical.
    inputs: { ...x },
    uncertain, seed: runSeed, samples: n, input_hash: seedOf(JSON.stringify([model.id, model.version, x, uncertain.map((u) => u.range), n, runSeed])).toString(16),
    nominal: { outputs: Object.fromEntries(Object.entries(nominal.outputs).map(([k, v]) => [k, Number.isFinite(v) ? round(v, 6) : v])), checks: nominal.checks.map(({ id, kind: k, ok: pass, text }) => ({ id, kind: k, ok: pass, text })), ...(nominal.series ? { series: nominal.series } : {}) },
    dimension_check: dimensionCheck(model, x, nominal),
    success_probability: round(ok / n, 4),
    summary,
    evidence_level: 'simulated', evidence_label: EVIDENCE_LEVELS.simulated,
    created_at: now,
  };
}

/** Re-executes a run from its record and says whether every output is identical. */
export function replayRun(run, { now } = {}) {
  const model = MODELS[run?.model?.id];
  if (!model) return { identical: false, reason: `Model ${run?.model?.id} is not available.` };
  if (model.version !== run.model.version) return { identical: false, reason: `The run used ${model.id} v${run.model.version}; this CHE has v${model.version}, so it cannot be replayed exactly.` };
  const ranges = Object.fromEntries(run.uncertain.map((u) => [u.id, u.range]));
  const again = simulate(model, run.inputs, { seed: run.seed, samples: run.samples, ranges, id: run.id, now: now || run.created_at, kind: run.kind, candidate_id: run.candidate_id, calibrated: run.calibrated });
  const strip = (r) => JSON.stringify({ ...r, id: '', created_at: '' });
  return { identical: strip(again) === strip(run), run: again };
}

/** Parameter sweep: one variable over the given values, everything else fixed, the same seed for every point. */
export function sweep(model, variables, { variable, values, outputs = [model.primary], samples = 400, seed = 1 } = {}) {
  const inp = model.inputs.find((i) => i.id === variable);
  if (!inp) throw new Error(`Unknown variable ${variable}.`);
  const list = (Array.isArray(values) ? values : []).map(Number).filter(Number.isFinite).slice(0, 50);
  if (!list.length) throw new Error('A sweep needs at least one value.');
  const outs = outputs.filter((o) => model.outputs.some((m) => m.id === o));
  return {
    model: { id: model.id, version: model.version }, variable, unit: inp.unit, seed, samples, outputs: outs,
    rows: list.map((value) => {
      const run = simulate(model, { ...variables, [variable]: inp.int ? Math.round(value) : value }, { seed, samples });
      return { value, success_probability: run.success_probability, ...Object.fromEntries(outs.map((o) => [o, { nominal: run.nominal.outputs[o], p10: run.summary[o].p10, p50: run.summary[o].p50, p90: run.summary[o].p90 }])) };
    }),
  };
}

/**
 * One-at-a-time sensitivity of an output: each uncertain input at the low and high end of its range with the
 * others at nominal (a tornado), plus the elasticity (%Δoutput / %Δinput) from a ±1% central difference.
 */
export function sensitivity(model, variables, { output = model.primary, ranges = null } = {}) {
  const x = fullInputs(model, variables);
  const base = model.evaluate(x).outputs[output];
  const rows = [];
  for (const inp of model.inputs.filter((i) => i.kind === 'uncertain')) {
    const [lo, hi] = inputRange(model, inp, x[inp.id], ranges);
    const at = (v) => model.evaluate({ ...x, [inp.id]: inp.int ? Math.round(v) : v }).outputs[output];
    const yLo = at(lo);
    const yHi = at(hi);
    let elasticity = null;
    if (!inp.int && x[inp.id] !== 0 && Number.isFinite(base) && base !== 0) {
      const h = 0.01 * x[inp.id];
      const up = at(x[inp.id] + h);
      const dn = at(x[inp.id] - h);
      if (Number.isFinite(up) && Number.isFinite(dn)) elasticity = round(((up - dn) / base) / 0.02, 4);
    }
    const swing = Number.isFinite(yLo) && Number.isFinite(yHi) ? Math.abs(yHi - yLo) : Infinity;
    rows.push({ input: inp.id, name: inp.name, unit: inp.unit, low: round(lo, 6), high: round(hi, 6), output_at_low: round(yLo, 6), output_at_high: round(yHi, 6), swing: round(swing, 6), elasticity });
  }
  rows.sort((a, b) => b.swing - a.swing);
  return { output, base: round(base, 6), rows };
}

// ── Candidates, feasibility, comparison ────────────────────────────────────────────────────────
/** Candidate records for a spec: design variables, the sources behind them, and empty feasibility. */
export function generateCandidates(spec) {
  const model = MODELS[spec.model?.id];
  if (!model) return [];
  return model.candidates(spec).map((c) => ({
    id: c.id, name: c.name, description: c.description, model: { id: model.id, version: model.version },
    variables: c.variables,
    evidence: [
      ...model.references.map((r) => ({ kind: 'reference', title: r.title, url: r.url })),
      ...Object.keys(spec.owner_variables || {}).map((k) => ({ kind: 'owner_statement', input: k, value: c.variables[k] })),
    ],
    sources: Object.fromEntries(model.inputs.map((i) => [i.id, i.id in (spec.owner_variables || {}) ? spec.owner_variables[i.id] : i.kind === 'goal' ? 'goal default' : (i.source || (i.placeholder ? 'placeholder' : 'model default'))])),
    notes: c.notes || [],
    feasibility: null,
  }));
}

/** Feasibility of one candidate from its model's classifier and a run. */
export function classifyCandidate(model, spec, candidate, run) {
  const x = fullInputs(model, candidate.variables);
  const nominal = model.evaluate(x);
  const sens = run ? sensitivity(model, candidate.variables, { output: model.primary }).rows : null;
  const result = model.classify({ x, nominal, run: run ? { success_probability: run.success_probability, summary: run.summary, sensitivity: sens } : null, spec, candidate });
  return {
    class: result.class, label: FEASIBILITY[result.class], limiting_constraint: result.limiting_constraint || null,
    violated: result.violated || [], reasons: result.reasons || [], alternatives: result.alternatives || [],
    confidence: result.confidence || (Object.keys(spec.owner_variables || {}).length ? 'medium: some of your own figures' : 'low: model defaults only'),
    basis: run ? `${run.kind} ${run.id || ''} (${run.samples} Monte Carlo samples, seed ${run.seed})`.replace(/\s+\(/, ' (') : 'nominal values only',
    evidence_level: run ? 'simulated' : 'prediction',
  };
}

/** Candidates compared under equal conditions: the same seed, sample count and uncertainty ranges for all. */
export function compareRuns(model, candidates, runsByCandidate) {
  const better = model.outputs.find((o) => o.id === model.primary)?.better === 'lower' ? -1 : 1;
  const rows = candidates.map((c) => {
    const run = runsByCandidate[c.id];
    const cls = c.feasibility?.class || 'unknown';
    if (!run) return { candidate_id: c.id, name: c.name, class: cls, label: FEASIBILITY[cls], simulated: false };
    const prim = run.summary[model.primary];
    const costs = run.nominal.outputs.cost_high != null ? { cost_low: run.nominal.outputs.cost_low, cost_high: run.nominal.outputs.cost_high } : {};
    return {
      candidate_id: c.id, name: c.name, class: cls, label: FEASIBILITY[cls], simulated: true, run_id: run.id,
      success_probability: run.success_probability,
      primary: { id: model.primary, unit: prim.unit, p10: prim.p10, p50: prim.p50, p90: prim.p90 },
      key_outputs: Object.fromEntries(model.outputs.slice(0, 6).map((o) => [o.id, { unit: o.unit, p10: run.summary[o.id].p10, p50: run.summary[o.id].p50, p90: run.summary[o.id].p90 }])),
      ...costs,
      limiting_constraint: c.feasibility?.limiting_constraint || null,
    };
  });
  // Ties within a class: higher success probability, then fewer goals or limits missed at nominal values,
  // then the better primary median.
  for (const r of rows) r.missed_at_nominal = r.run_id ? runsByCandidate[r.candidate_id].nominal.checks.filter((c) => !c.ok).map((c) => c.id) : [];
  rows.sort((a, b) => CLASS_ORDER.indexOf(a.class) - CLASS_ORDER.indexOf(b.class)
    || (b.success_probability ?? -1) - (a.success_probability ?? -1)
    || a.missed_at_nominal.length - b.missed_at_nominal.length
    || better * ((b.primary?.p50 ?? -Infinity) - (a.primary?.p50 ?? -Infinity)));
  const seeds = [...new Set(Object.values(runsByCandidate).map((r) => r.seed))];
  const samples = [...new Set(Object.values(runsByCandidate).map((r) => r.samples))];
  return {
    model: { id: model.id, version: model.version }, primary: model.primary,
    conditions: { seed: seeds.length === 1 ? seeds[0] : seeds, samples: samples.length === 1 ? samples[0] : samples, equal: seeds.length <= 1 && samples.length <= 1, uncertainty: 'each input\'s range relative to its value, the same for every candidate' },
    rows, best: rows.find((r) => r.simulated && r.class !== 'incompatible')?.candidate_id || null,
  };
}

// ── Projects and the status machine ────────────────────────────────────────────────────────────
export function createProject(spec, { id, now = new Date().toISOString() } = {}) {
  return {
    id, version: ENGINE_VERSION, title: clip(spec.goal || spec.request, 120), request: spec.request, domain: spec.domain,
    status: 'IDEA', blocked_from: null, history: [{ from: null, to: 'IDEA', at: now, reason: 'Goal received.' }],
    spec, candidates: [], runs: [], latest_runs: {}, comparison: null, plan: null, evidence: [], outcomes: [], calibration: {}, authorizations: [],
    created_at: now, updated_at: now,
  };
}

const terminal = (s) => s === 'COMPLETE' || s === 'FAILED';

/** Why a forward move to `to` is not allowed yet, or '' when every gate is met. */
export function gateFor(project, to) {
  const p = project;
  switch (to) {
    case 'RESEARCH':
      if (p.spec?.refused) return 'The goal was refused by the safety layer.';
      if (!p.spec?.model) return p.spec?.missing_model || 'No domain model fits this goal.';
      return p.spec.success_criteria?.length ? '' : 'The spec has no measurable success criteria.';
    case 'FEASIBILITY':
      return p.candidates.length && p.candidates.every((c) => c.evidence?.length && c.sources) ? '' : 'Candidates with their sources are needed first.';
    case 'SIMULATION':
      return p.candidates.length && p.candidates.every((c) => c.feasibility?.class) ? '' : 'Every candidate needs a feasibility class first.';
    case 'PLAN': {
      const live = p.candidates.filter((c) => c.feasibility?.class !== 'incompatible');
      if (!live.length) return 'Every candidate is incompatible with physical constraints; see the alternatives.';
      if (!live.every((c) => p.latest_runs[c.id])) return 'Every compatible candidate needs a full simulation run.';
      return p.comparison ? '' : 'The candidates have not been compared yet.';
    }
    case 'EXECUTION':
      if (!p.plan) return 'There is no Realization Plan yet.';
      return p.authorizations.some((a) => a.scope === 'execution') ? '' : 'Execution needs your explicit authorization.';
    case 'VERIFICATION':
      return p.plan?.steps.some((s) => s.status === 'verified') ? '' : 'At least one step needs accepted evidence first.';
    case 'COMPLETE': {
      const open = (p.plan?.steps || []).filter((s) => s.milestone && s.status !== 'verified');
      return open.length ? `Not verified yet: ${open.map((s) => s.title).join('; ')}.` : '';
    }
    default:
      return `Unknown status ${to}.`;
  }
}

/** Moves a project one status; never skips, and every forward move must pass its gate. Pure: returns a copy. */
export function transition(project, to, { reason = '', now = new Date().toISOString() } = {}) {
  const from = project.status;
  const next = structuredClone(project);
  const done = (extra = {}) => {
    Object.assign(next, extra, { status: to, updated_at: now });
    next.history.push({ from, to, at: now, reason: clip(reason, 800) });
    return { ok: true, project: next };
  };
  if (terminal(from)) return { ok: false, error: `The project is ${from}; it cannot change.` };
  if (to === 'BLOCKED' || to === 'FAILED') {
    if (!String(reason).trim()) return { ok: false, error: `${to} needs a reason.` };
    if (from === 'BLOCKED' && to === 'BLOCKED') return { ok: false, error: 'Already blocked.' };
    return done(to === 'BLOCKED' ? { blocked_from: from } : {});
  }
  if (from === 'BLOCKED') {
    if (to !== project.blocked_from) return { ok: false, error: `A blocked project returns to ${project.blocked_from} first.` };
    return done({ blocked_from: null });
  }
  const i = STATUSES.indexOf(from);
  if (STATUSES.indexOf(to) !== i + 1) return { ok: false, error: `From ${from} the next status is ${STATUSES[i + 1]}; statuses are never skipped.` };
  const gate = gateFor(project, to);
  if (gate) return { ok: false, error: gate };
  return done();
}

// ── Realization Plan ───────────────────────────────────────────────────────────────────────────
export function buildRealizationPlan(project, candidateId, run) {
  const model = MODELS[project.spec.model.id];
  const candidate = project.candidates.find((c) => c.id === candidateId);
  if (!candidate || !run) throw new Error('The plan needs a simulated candidate.');
  const steps = model.planSteps({ candidate: { ...candidate, variables: run.inputs }, nominal: run.nominal, run }).map((s, i, all) => ({
    id: `s${i + 1}`, title: s.title, who: s.who, instructions: s.instructions || [], materials: s.materials || [],
    cost_usd: s.cost_usd || [0, 0], time: s.time || '', prerequisites: i ? [`s${i}`] : [],
    safety_legal: s.safety || '', expected: s.expected || '', verification: s.verification || 'owner_report', metric: s.metric || null,
    fallback: s.fallback || '', consequential: s.consequential || null,
    milestone: ['measurement', 'artifact', 'owner_report'].includes(s.verification) && (s.verification !== 'owner_report' || i === all.length - 1 || !!s.consequential),
    status: 'todo', evidence_ids: [],
  }));
  const cost = steps.reduce((t, s) => [t[0] + s.cost_usd[0], t[1] + s.cost_usd[1]], [0, 0]);
  return {
    candidate_id: candidate.id, candidate_name: candidate.name, run_id: run.id, model: run.model,
    class: candidate.feasibility?.class, label: candidate.feasibility?.label,
    expected: Object.fromEntries(Object.entries(run.summary).slice(0, 6).map(([k, v]) => [k, { unit: v.unit, p10: v.p10, p50: v.p50, p90: v.p90 }])),
    cost_usd: cost, steps,
    office: { department: OFFICE_DEPARTMENT[project.domain] || null, task_id: null, note: 'Suggested Office department only; no task has been queued.' },
    note: 'Costs and times are planning ranges, not quotes. Steps marked consequential (money, applications, accounts, contracts, deployments, devices) wait for your explicit yes for that step.',
  };
}

// ── Evidence ───────────────────────────────────────────────────────────────────────────────────
const NOT_EVIDENCE = new Set(['simulation', 'model_output', 'prediction', 'speculation', 'estimate', 'opinion']);
const ACCEPTS = { measurement: ['measurement'], artifact: ['artifact', 'test_run'], owner_report: ['owner_report', 'measurement'] };

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Validates one evidence record against the step it would verify. Returns { accepted, reason, record }. */
export async function validateEvidence(project, input, { submitted_by = 'owner', now = new Date().toISOString(), id = '' } = {}) {
  const step = project.plan?.steps.find((s) => s.id === input?.step_id);
  const record = {
    id, step_id: input?.step_id || '', kind: clip(input?.kind, 30), submitted_by, at: now,
    ref: clip(input?.ref, 300), note: clip(input?.note, 600), sha256: clip(input?.sha256, 64).toLowerCase(),
    tests: input?.tests ? { passed: Number(input.tests.passed), failed: Number(input.tests.failed) } : null,
    observed: input?.metric != null ? { metric: clip(input.metric, 60), value: Number(input.value), unit: clip(input.unit, 30) } : null,
  };
  const reject = (reason) => ({ accepted: false, reason, record: { ...record, accepted: false, reason } });
  if (!step) return reject('No such plan step.');
  if (NOT_EVIDENCE.has(record.kind)) return reject('A simulation, estimate or model output is never evidence of a real-world result.');
  if (!['artifact', 'test_run', 'measurement', 'owner_report'].includes(record.kind)) return reject(`Unknown evidence kind "${record.kind}".`);
  if (!(ACCEPTS[step.verification] || ['owner_report']).includes(record.kind)) return reject(`This step is verified by ${step.verification}, not ${record.kind}.`);
  if (submitted_by !== 'owner' && !(step.who === 'che' && ['artifact', 'test_run'].includes(record.kind))) return reject('Only you can supply evidence for this step.');
  if (step.consequential && !project.authorizations.some((a) => a.step_id === step.id)) return reject(`This step is consequential (${step.consequential}); it needs your authorization before it can be verified.`);
  if (record.kind === 'artifact') {
    if (!record.ref || !/^[0-9a-f]{64}$/.test(record.sha256)) return reject('An artifact needs a reference and its SHA-256.');
    if (input.content != null && await sha256Hex(input.content) !== record.sha256) return reject('The SHA-256 does not match the artifact\'s content.');
    record.hash_checked = input.content != null;
  }
  if (record.kind === 'test_run' && !(Number.isInteger(record.tests?.passed) && record.tests.passed > 0 && record.tests.failed === 0 && record.ref)) return reject('A test run needs a reference, at least one passing test and no failures.');
  if (record.kind === 'measurement' && !(record.observed && Number.isFinite(record.observed.value) && record.observed.unit)) return reject('A measurement needs a metric, a number and a unit.');
  if (record.kind === 'owner_report' && record.note.trim().length < 12) return reject('Say what you actually observed (at least a short sentence).');
  // The same claim again is not new evidence.
  const key = JSON.stringify([record.kind, record.ref, record.note.trim().toLowerCase(), record.sha256, record.observed]);
  if (project.evidence.some((e) => e.accepted && e.step_id === record.step_id && JSON.stringify([e.kind, e.ref, String(e.note || '').trim().toLowerCase(), e.sha256, e.observed]) === key)) return reject('Repeating the same claim is not new evidence.');
  return { accepted: true, reason: '', record: { ...record, accepted: true } };
}

// ── Learning from reality ──────────────────────────────────────────────────────────────────────
/**
 * Compares an owner-reported outcome with the simulation. For an output, it finds, for each uncertain input
 * alone, the value that would have reproduced the result, and calls an assumption likely wrong when that value
 * lies outside its assumed range. For a measured input, the measured value replaces the assumption directly.
 * Returns the comparison and the calibrated variables (or null when no single assumption explains it).
 */
export function compareOutcome(model, run, { metric, value, unit }) {
  const out = model.outputs.find((o) => o.id === metric);
  const inp = model.inputs.find((i) => i.id === metric);
  if (!out && !inp) return { ok: false, error: `${metric} is not an output or input of ${model.id}.` };
  const target = out || inp;
  if (!sameDimension(unit || target.unit, target.unit)) return { ok: false, error: `${unit} cannot be compared with ${target.unit}.` };
  const observed = convert(Number(value), unit || target.unit, target.unit);
  if (!Number.isFinite(observed)) return { ok: false, error: 'The outcome needs a number.' };
  const x = { ...run.inputs };
  const ranges = Object.fromEntries(run.uncertain.map((u) => [u.id, u.range]));
  if (inp) {
    const [lo, hi] = ranges[inp.id] || [inp.lo ?? x[inp.id], inp.hi ?? x[inp.id]];
    const inside = observed >= lo - 1e-12 && observed <= hi + 1e-12;
    return {
      ok: true, kind: 'measured_input', metric, unit: target.unit, observed, assumed: { nominal: x[inp.id], range: [lo, hi] },
      error_pct: x[inp.id] ? round(((observed - x[inp.id]) / x[inp.id]) * 100, 2) : null, within_band: inside,
      assumptions: [{ input: inp.id, name: inp.name, assumed_range: [lo, hi], nominal: x[inp.id], needed: observed, inside_range: inside }],
      wrong: inside ? [] : [inp.id], calibrate: { [inp.id]: observed }, calibrated_ranges: { [inp.id]: [observed * 0.9, observed * 1.1] },
    };
  }
  const predicted = run.summary[metric];
  const within = observed >= predicted.p10 && observed <= predicted.p90;
  const assumptions = [];
  for (const u of run.uncertain) {
    const inpDef = model.inputs.find((i) => i.id === u.id);
    const f = (v) => model.evaluate({ ...x, [u.id]: v }).outputs[metric];
    const loB = Math.max(inpDef.physical?.[0] ?? -Infinity, Math.min(u.range[0], x[u.id]) / 10);
    const hiB = Math.min(inpDef.physical?.[1] ?? Infinity, Math.max(u.range[1], x[u.id]) * 10);
    const needed = u.int ? null : bisect(f, observed, loB, hiB, { tol: 1e-10 });
    const inside = needed != null && needed >= u.range[0] - 1e-12 && needed <= u.range[1] + 1e-12;
    const span = Math.max(1e-12, u.range[1] - u.range[0]);
    assumptions.push({ input: u.id, name: u.name, unit: u.unit, assumed_range: u.range, nominal: u.nominal, needed: needed == null ? null : round(needed, 6), inside_range: inside, shift: needed == null ? null : round(Math.abs(needed - u.nominal) / span, 4) });
  }
  const explainers = assumptions.filter((a) => a.needed != null).sort((a, b) => a.shift - b.shift);
  const best = explainers[0] || null;
  return {
    ok: true, kind: 'output', metric, unit: target.unit, observed, predicted: { p10: predicted.p10, p50: predicted.p50, p90: predicted.p90, nominal: run.nominal.outputs[metric] },
    error_pct: predicted.p50 ? round(((observed - predicted.p50) / predicted.p50) * 100, 2) : null, within_band: within,
    assumptions, wrong: within ? [] : assumptions.filter((a) => a.needed != null && !a.inside_range).map((a) => a.input),
    explained_by: best ? best.input : null,
    calibrate: best ? { [best.input]: best.needed } : null,
    calibrated_ranges: best ? { [best.input]: [best.needed * 0.95, best.needed * 1.05] } : null,
    note: best ? `The smallest single change that reproduces your result: ${best.name} ${fmtNum(best.needed)}${best.unit === '1' ? '' : ` ${best.unit}`} (assumed ${fmtNum(best.assumed_range[0])}–${fmtNum(best.assumed_range[1])}). Other assumptions may share the error; more outcomes separate them.` : 'No single assumption explains the result; more than one is wrong, or the model is missing an effect.',
  };
}

// ── Storage ────────────────────────────────────────────────────────────────────────────────────
const INDEX_KEY = 'manifest_projects';
const MAX_PROJECTS = 30;
const MAX_RUNS_PER_PROJECT = 40;
const projectKey = (id) => `manifest_project:${id}`;
const runKey = (id) => `manifest_run:${id}`;

export class ManifestStore {
  constructor(storage) { this.storage = storage; }
  async list() { return (await this.storage.get(INDEX_KEY)) || []; }
  async get(id) { return (await this.storage.get(projectKey(id))) || null; }
  async getRun(id) { return (await this.storage.get(runKey(id))) || null; }
  async putRun(run) { await this.storage.put(runKey(run.id), run); }
  async put(project) {
    // Old run records beyond the per-project limit are dropped from storage; the index keeps their summary.
    if (project.runs.length > MAX_RUNS_PER_PROJECT) {
      const keep = new Set(Object.values(project.latest_runs));
      const drop = project.runs.slice(0, project.runs.length - MAX_RUNS_PER_PROJECT).filter((r) => !keep.has(r.id));
      for (const r of drop) await this.storage.delete(runKey(r.id));
      const dropped = new Set(drop.map((r) => r.id));
      project.runs = project.runs.map((r) => (dropped.has(r.id) ? { ...r, stored: false } : r));
    }
    await this.storage.put(projectKey(project.id), project);
    const index = await this.list();
    const next = [{ id: project.id, title: project.title, domain: project.domain, status: project.status, updated_at: project.updated_at }, ...index.filter((p) => p.id !== project.id)];
    for (const old of next.slice(MAX_PROJECTS)) {
      const gone = await this.get(old.id);
      for (const r of gone?.runs || []) await this.storage.delete(runKey(r.id));
      await this.storage.delete(projectKey(old.id));
    }
    await this.storage.put(INDEX_KEY, next.slice(0, MAX_PROJECTS));
  }
}

// ── Orchestration (stored projects) ────────────────────────────────────────────────────────────
function moveTo(project, to, reason, now) {
  const r = transition(project, to, { reason, now });
  if (!r.ok) throw Object.assign(new Error(r.error), { status: 409 });
  return r.project;
}

async function saveRun(store, project, run) {
  await store.putRun(run);
  project.runs.push({ id: run.id, kind: run.kind, candidate_id: run.candidate_id, seed: run.seed, samples: run.samples, success_probability: run.success_probability, calibrated: run.calibrated, created_at: run.created_at });
  if (run.kind === 'simulation') project.latest_runs[run.candidate_id] = run.id;
}

/** Creates a project from a goal. With `auto`, runs it through research, feasibility, simulation and a plan. */
export async function startProject(store, request, { overrides = {}, auto = true, now = new Date().toISOString(), newId = newIdDefault, samples = DEFAULT_SAMPLES } = {}) {
  const spec = buildSpec(request, { overrides, now });
  if (spec.refused) return { refused: true, spec };
  let project = createProject(spec, { id: newId('mp'), now });
  if (auto) project = await advanceToPlan(store, project, { now, newId, samples });
  else await store.put(project);
  return { refused: false, project };
}

/** Research → feasibility → simulation → comparison → plan, each move through its gate. Blocks honestly. */
export async function advanceToPlan(store, project, { now = new Date().toISOString(), newId = newIdDefault, samples = DEFAULT_SAMPLES } = {}) {
  let p = project;
  const gate = gateFor(p, 'RESEARCH');
  if (p.status === 'IDEA' && gate) {
    p = moveTo(p, 'BLOCKED', gate, now);
    await store.put(p);
    return p;
  }
  if (p.status === 'IDEA') p = moveTo(p, 'RESEARCH', 'Spec built; gathering candidates and their sources.', now);
  const model = MODELS[p.spec.model.id];
  if (p.status === 'RESEARCH') {
    p.candidates = generateCandidates(p.spec);
    p = moveTo(p, 'FEASIBILITY', `${p.candidates.length} candidates with sources.`, now);
  }
  if (p.status === 'FEASIBILITY') {
    // Screening: a short seeded Monte Carlo per candidate to classify it; the full run follows.
    const seed = seedOf(`${p.id}|screen`);
    for (const c of p.candidates) {
      const screen = simulate(model, c.variables, { seed, samples: SCREEN_SAMPLES, id: newId('mr'), now, kind: 'screening', candidate_id: c.id });
      await saveRun(store, p, screen);
      c.feasibility = classifyCandidate(model, p.spec, c, screen);
    }
    p = moveTo(p, 'SIMULATION', 'Every candidate classified from a screening run.', now);
  }
  if (p.status === 'SIMULATION') {
    await simulateAll(store, p, { now, newId, samples });
    const live = p.candidates.filter((c) => c.feasibility.class !== 'incompatible');
    if (!live.length) {
      const c = p.candidates[0];
      p = moveTo(p, 'BLOCKED', `Every candidate is incompatible with established physical constraints: ${c?.feasibility?.violated?.[0]?.text || ''} Nearest alternatives: ${(c?.feasibility?.alternatives || []).map((a) => a.name).join('; ')}.`, now);
      await store.put(p);
      return p;
    }
    p = moveTo(p, 'PLAN', 'Candidates simulated and compared under equal conditions.', now);
    const best = p.comparison.best;
    p.plan = buildRealizationPlan(p, best, await store.getRun(p.latest_runs[best]));
  }
  p.updated_at = now;
  await store.put(p);
  return p;
}

/** Full simulation of every compatible candidate with one shared seed and sample count, then the comparison. */
export async function simulateAll(store, p, { now, newId = newIdDefault, samples = DEFAULT_SAMPLES }) {
  const model = MODELS[p.spec.model.id];
  const seed = seedOf(`${p.id}|full`);
  const runs = {};
  for (const c of p.candidates) {
    if (c.feasibility?.class === 'incompatible') continue;
    const variables = { ...c.variables, ...(p.calibration[c.id]?.variables || {}) };
    const run = simulate(model, variables, { seed, samples, ranges: p.calibration[c.id]?.ranges || null, id: newId('mr'), now, kind: 'simulation', candidate_id: c.id, calibrated: !!p.calibration[c.id] });
    await saveRun(store, p, run);
    runs[c.id] = run;
    c.feasibility = classifyCandidate(model, p.spec, { ...c, variables }, run);
  }
  p.comparison = compareRuns(model, p.candidates, runs);
  return runs;
}

/** The owner's real outcome: compared with the simulation, assumptions named, estimates updated by a new run. */
export async function recordOutcome(store, p, { metric, value, unit, candidate_id, note = '' }, { now = new Date().toISOString(), newId = newIdDefault } = {}) {
  const cid = candidate_id || p.plan?.candidate_id;
  const runId = p.latest_runs[cid];
  if (!runId) throw Object.assign(new Error('That candidate has no simulation run to compare with.'), { status: 409 });
  const model = MODELS[p.spec.model.id];
  const run = await store.getRun(runId);
  const cmp = compareOutcome(model, run, { metric, value, unit });
  if (!cmp.ok) throw Object.assign(new Error(cmp.error), { status: 400 });
  const outcome = { id: newId('mo'), candidate_id: cid, compared_run: runId, ...cmp, note: [cmp.note, clip(note, 300)].filter(Boolean).join(' '), provenance: 'owner_report', at: now };
  if (cmp.calibrate) {
    const prev = p.calibration[cid] || { variables: {}, ranges: {} };
    p.calibration[cid] = { variables: { ...prev.variables, ...cmp.calibrate }, ranges: { ...prev.ranges, ...cmp.calibrated_ranges }, from_outcomes: [...(prev.from_outcomes || []), outcome.id] };
    const variables = { ...run.inputs, ...p.calibration[cid].variables };
    const ranges = { ...Object.fromEntries(run.uncertain.map((u) => [u.id, u.range])), ...p.calibration[cid].ranges };
    const again = simulate(model, variables, { seed: run.seed, samples: run.samples, ranges, id: newId('mr'), now, kind: 'simulation', candidate_id: cid, calibrated: true });
    await saveRun(store, p, again);
    const c = p.candidates.find((x) => x.id === cid);
    if (c) c.feasibility = classifyCandidate(model, p.spec, { ...c, variables }, again);
    outcome.updated_run = again.id;
    outcome.updated_estimate = Object.fromEntries(Object.entries(again.summary).map(([k, v]) => [k, { unit: v.unit, p10: v.p10, p50: v.p50, p90: v.p90 }]));
  }
  p.outcomes.push(outcome);
  p.updated_at = now;
  await store.put(p);
  return outcome;
}

// ── Spoken summaries (read on request; nothing here speaks by itself) ────────────────────────────
export function speakProject(p) {
  if (!p) return 'There is no manifestation project yet, sir.';
  const lines = [`Manifestation project: ${p.title}. Status ${p.status}.`];
  if (p.status === 'BLOCKED') lines.push(`Blocked: ${p.history.at(-1).reason}`);
  if (p.spec?.model) lines.push(`Model: ${p.spec.model.title}.`);
  p.candidates.forEach((c, i) => lines.push(`${i + 1}. ${c.name}: ${c.feasibility?.label || 'not classified'}.${c.feasibility?.reasons?.[0] ? ` ${c.feasibility.reasons[0]}` : ''}`));
  const best = p.comparison?.rows.find((r) => r.candidate_id === p.comparison.best);
  if (best?.primary) lines.push(`Best under equal conditions: ${best.name}, ${best.primary.id.replace(/_/g, ' ')} p10 ${fmtNum(best.primary.p10)}, median ${fmtNum(best.primary.p50)}, p90 ${fmtNum(best.primary.p90)} ${best.primary.unit === '1' ? '' : best.primary.unit}.`.replace(/\s+\./, '.'));
  if (p.plan) lines.push(`Plan: ${p.plan.steps.length} steps. First: ${p.plan.steps[0].title}.`);
  lines.push('These are simulated results, not measurements; a step counts as done only with real evidence.');
  return lines.join(' ');
}
