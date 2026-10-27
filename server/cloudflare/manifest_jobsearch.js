// Manifestation Engine, employment domain: a job-search pipeline funnel.
// applications → responses → interviews → offers, with an application-to-offer delay. The probability of
// an offer by week t is computed exactly (independent applications); Monte Carlo then samples the uncertain
// conversion rates to give ranges. The rates are planning assumptions until the owner tracks his own.
//
// Equations:
//   p        = r_resp · r_int · r_offer          offer probability per application          [1]
//   E[offers]= a · S · p                         expected offers from S weeks at a per week [item]
//   F(d)     = P(L ≤ d), L ~ uniform integer on [L_min, L_max] weeks (delay to an offer)
//   P(t)     = 1 − Π_{w=1}^{min(S,t)} (1 − p·F(t − w))^a   probability of at least one offer by week t [1]
//   t50, t90 = smallest t with P(t) ≥ 0.5, 0.9                                              [week]
//   workload = a · h                              hours per week                             [h/week]
// Known answers (tested): with every delay 0, P(t) = 1 − (1 − p)^(a·t) (geometric); the elasticity of
// E[offers] to each rate is exactly 1, because E is their product.
// Boundary conditions: applications independent, rates constant over the search, applying stops after S weeks.

import { div, mul, q } from './manifest_units.js';
import { round } from './manifest_stats.js';

const INPUTS = [
  { id: 'apps_per_week', name: 'Applications per week', unit: 'item/week', kind: 'design', nominal: 10, physical: [0, 500] },
  { id: 'response_rate', name: 'Share of applications that get a reply', unit: '1', kind: 'uncertain', nominal: 0.1, lo: 0.04, hi: 0.2, physical: [0, 1], placeholder: true, source: 'planning assumption; replace with your tracked rate' },
  { id: 'interview_rate', name: 'Share of replies that become interviews', unit: '1', kind: 'uncertain', nominal: 0.5, lo: 0.3, hi: 0.7, physical: [0, 1], placeholder: true, source: 'planning assumption; replace with your tracked rate' },
  { id: 'offer_rate', name: 'Share of interview processes that end in an offer', unit: '1', kind: 'uncertain', nominal: 0.2, lo: 0.1, hi: 0.35, physical: [0, 1], placeholder: true, source: 'planning assumption; replace with your tracked rate' },
  { id: 'lag_min', name: 'Shortest time from application to offer', unit: 'week', kind: 'uncertain', nominal: 3, lo: 2, hi: 4, physical: [0, 52], int: true, placeholder: true },
  { id: 'lag_max', name: 'Longest time from application to offer', unit: 'week', kind: 'uncertain', nominal: 8, lo: 6, hi: 10, physical: [0, 104], int: true, placeholder: true },
  { id: 'search_weeks', name: 'Weeks you keep applying', unit: 'week', kind: 'design', nominal: 12, physical: [1, 104], int: true },
  { id: 'hours_per_app', name: 'Hours per tailored application', unit: 'h/item', kind: 'design', nominal: 1, physical: [0, 40] },
  { id: 'target_weeks', name: 'Want an offer by week', unit: 'week', kind: 'goal', nominal: 16, physical: [1, 104], int: true },
  { id: 'available_hours', name: 'Hours per week you can give the search', unit: 'h/week', kind: 'goal', nominal: 20, physical: [0, 168] },
];

const OUTPUTS = [
  { id: 'p_offer_per_app', name: 'Offer probability per application', unit: '1', better: 'higher' },
  { id: 'responses_per_week', name: 'Expected replies per week', unit: 'item/week' },
  { id: 'interviews_per_week', name: 'Expected interviews per week', unit: 'item/week' },
  { id: 'expected_offers', name: 'Expected offers over the search', unit: 'item', better: 'higher' },
  { id: 'p_offer_by_target', name: 'Chance of an offer by your target week', unit: '1', better: 'higher' },
  { id: 'weeks_to_offer_p50', name: 'Week with a 50% chance of an offer', unit: 'week', better: 'lower' },
  { id: 'weeks_to_offer_p90', name: 'Week with a 90% chance of an offer', unit: 'week', better: 'lower' },
  { id: 'hours_per_week', name: 'Search hours per week', unit: 'h/week', better: 'lower' },
];

/** P(L ≤ d) for an integer delay uniform on [lo, hi]. */
export function lagCdf(d, lo, hi) {
  const a = Math.round(Math.min(lo, hi));
  const b = Math.round(Math.max(lo, hi));
  if (d < a) return 0;
  if (d >= b) return 1;
  return (Math.floor(d) - a + 1) / (b - a + 1);
}

/** Exact probability of at least one offer by week t. */
export function offerByWeek(x, t) {
  const p = x.response_rate * x.interview_rate * x.offer_rate;
  let none = 1;
  const S = Math.round(x.search_weeks);
  for (let w = 1; w <= Math.min(S, t); w += 1) none *= (1 - p * lagCdf(t - w, x.lag_min, x.lag_max)) ** x.apps_per_week;
  return 1 - none;
}

const HORIZON = 156;
// P(t) for t = 1..until; stops early once the 90% week is found. After the last application week plus the
// longest delay nothing changes, so the curve is flat from there.
function offerCurve(x, until) {
  const flat = Math.round(x.search_weeks) + Math.round(Math.max(x.lag_min, x.lag_max));
  const curve = [];
  for (let t = 1; t <= until; t += 1) {
    curve.push(t <= flat + 1 ? offerByWeek(x, t) : curve.at(-1));
  }
  return curve;
}

function evaluate(x) {
  const p = x.response_rate * x.interview_rate * x.offer_rate;
  const target = Math.round(x.target_weeks);
  const curve = offerCurve(x, Math.max(target, Math.min(HORIZON, Math.round(x.search_weeks) + Math.round(Math.max(x.lag_min, x.lag_max)) + 1)));
  const reach = (level) => { const i = curve.findIndex((v) => v >= level); return i < 0 ? Infinity : i + 1; };
  const outputs = {
    p_offer_per_app: p,
    responses_per_week: x.apps_per_week * x.response_rate,
    interviews_per_week: x.apps_per_week * x.response_rate * x.interview_rate,
    expected_offers: x.apps_per_week * Math.round(x.search_weeks) * p,
    p_offer_by_target: curve[target - 1] ?? curve.at(-1),
    weeks_to_offer_p50: reach(0.5),
    weeks_to_offer_p90: reach(0.9),
    hours_per_week: x.apps_per_week * x.hours_per_app,
  };
  const checks = [
    { id: 'rates_are_probabilities', kind: 'physics', ok: [x.response_rate, x.interview_rate, x.offer_rate].every((r) => r >= 0 && r <= 1), text: 'Each conversion rate is a probability between 0 and 1.' },
    { id: 'delay_order', kind: 'physics', ok: x.lag_min <= x.lag_max, text: 'The shortest delay cannot exceed the longest.' },
    { id: 'offer_by_target', kind: 'goal', ok: outputs.weeks_to_offer_p50 <= x.target_weeks, text: `At least an even chance of an offer by week ${Math.round(x.target_weeks)}.` },
    { id: 'workload', kind: 'practical', ok: outputs.hours_per_week <= x.available_hours, text: `At most ${round(x.available_hours, 1)} hours a week.` },
  ];
  const series = curve.map((v, i) => ({ week: i + 1, p_offer: round(v, 4) }));
  return { outputs, checks, series };
}

function dimensional(x) {
  const a = q(x.apps_per_week, 'item/week');
  const p = q(x.response_rate * x.interview_rate * x.offer_rate, '1');
  return {
    responses_per_week: mul(a, q(x.response_rate, '1')),
    expected_offers: mul(mul(a, q(Math.round(x.search_weeks), 'week')), p),
    hours_per_week: mul(a, q(x.hours_per_app, 'h/item')),
    p_offer_per_app: div(mul(a, p), a),
  };
}

const nominalInputs = () => Object.fromEntries(INPUTS.map((i) => [i.id, i.nominal]));

/** Three search strategies: the rates of each are planning assumptions, labelled. */
function candidates(spec) {
  const v = spec.variables || {};
  const base = { ...nominalInputs(), ...v, target_weeks: v.target_weeks ?? (spec.timeline?.weeks ? Math.round(spec.timeline.weeks) : 16) };
  const out = [];
  const add = (id, name, description, change, notes) => out.push({ id, name, description, variables: Object.fromEntries(Object.entries({ ...base, ...change }).map(([k, val]) => [k, Number.isFinite(val) ? round(val, 4) : val])), notes });
  add('volume', 'High volume: 20 quick applications a week', 'Many applications, lightly tailored; reply rate assumed lower.', { apps_per_week: 20, hours_per_app: 0.5, response_rate: (v.response_rate ?? 0.1) * 0.6 }, ['Reply rate assumed at 60% of the targeted rate.']);
  add('targeted', 'Targeted: 8 tailored applications a week', 'Each application tailored to the job.', { apps_per_week: 8, hours_per_app: 1.5 }, []);
  add('referral', 'Referral first: 4 applications a week through people you know', 'Ask contacts to refer you; fewer applications, replies assumed twice as likely.', { apps_per_week: 4, hours_per_app: 3, response_rate: Math.min(1, (v.response_rate ?? 0.1) * 2) }, ['Referral reply rate assumed at twice the targeted rate.']);
  return out;
}

function classify({ x, nominal, run, spec }) {
  const physics = nominal.checks.filter((c) => c.kind === 'physics' && !c.ok);
  const owned = ['response_rate', 'interview_rate', 'offer_rate'].filter((k) => k in (spec?.owner_variables || {}));
  const confidence = owned.length === 3 ? 'medium: your own tracked rates' : 'low: the conversion rates are planning assumptions until you track your own';
  const alternatives = alternativesFor(x);
  if (physics.length) return { class: 'incompatible', violated: physics.map(({ id, text }) => ({ id, text })), limiting_constraint: { id: physics[0].id, text: physics[0].text }, reasons: physics.map((c) => c.text), alternatives, confidence };
  // No job-market data source is wired: without your own tracked rates the odds are not judged.
  if (owned.length < 3) {
    const missing = ['response_rate', 'interview_rate', 'offer_rate'].filter((k) => !owned.includes(k));
    return { class: 'unknown', violated: [], limiting_constraint: { id: 'conversion_rates', text: 'Your own reply, interview and offer rates', missing }, reasons: [`No data source for job-market conversion rates; the figures shown use placeholder rates for ${missing.join(', ').replace(/_/g, ' ')}. Track your first applications and CHE recalibrates.`], alternatives, confidence };
  }
  const p = run?.success_probability ?? 0;
  const practical = nominal.checks.filter((c) => c.kind === 'practical' && !c.ok);
  const sens = run?.sensitivity?.[0];
  const limiting = sens ? { id: sens.input, text: `Most sensitive input: ${sens.name}`, swing: sens.swing } : null;
  if (p >= 0.5 && !practical.length) return { class: 'feasible_now', violated: [], limiting_constraint: limiting, reasons: [`An even chance of an offer by week ${Math.round(x.target_weeks)} in ${Math.round(p * 100)}% of Monte Carlo runs.`], alternatives, confidence };
  if (p >= 0.1 || practical.length) return { class: 'feasible_expensive', violated: [], limiting_constraint: practical[0] ? { id: practical[0].id, text: practical[0].text } : limiting, reasons: [`Meets the target in ${Math.round(p * 100)}% of runs.`, ...practical.map((c) => `Not met: ${c.text}`)], alternatives, confidence };
  return { class: 'unproven', violated: [], limiting_constraint: limiting, reasons: [`Meets the target in only ${Math.round(p * 100)}% of runs at these rates.`], alternatives, confidence };
}

function alternativesFor(x) {
  const p = x.response_rate * x.interview_rate * x.offer_rate;
  // Applications per week for an even chance by the target, ignoring the delay: 1 − (1 − p)^(a·t) = 0.5.
  const weeksApplying = Math.max(1, Math.min(Math.round(x.search_weeks), Math.round(x.target_weeks) - Math.round(x.lag_max)));
  const need = p > 0 && p < 1 ? Math.log(0.5) / (weeksApplying * Math.log(1 - p)) : Infinity;
  return [
    { id: 'apps_needed', name: 'Applications a week for an even chance', class: 'unknown', text: `About ${Number.isFinite(need) ? Math.ceil(need) : 'no number of'} applications a week over ${weeksApplying} weeks, at these rates and allowing for the longest delay.`, numbers: { apps_per_week: Number.isFinite(need) ? round(need, 2) : null } },
    { id: 'raise_reply_rate', name: 'Raise the reply rate first', class: 'unknown', text: 'A stronger résumé or portfolio raises every later stage; the model shows how much once you measure it.' },
    { id: 'bridge_income', name: 'Contract or temporary work while searching', class: 'unknown', text: 'Income during the search; not modelled here.' },
  ];
}

function planSteps({ candidate, nominal }) {
  const o = nominal.outputs;
  const x = candidate.variables;
  return [
    { title: 'Name the target role and write the résumé', who: 'che', instructions: ['Tell CHE the job title, place and pay you want.', 'CHE drafts a résumé and a short pitch from what you tell her; you read and correct it.'], cost_usd: [0, 0], time: '2 to 3 hours', expected: 'A résumé you approve.', verification: 'artifact', consequential: null, safety: 'Every line must be true; CHE never invents experience.', fallback: 'Ask a contact in the field to review it.' },
    { title: 'Start a tracking sheet', who: 'che', instructions: ['One row per application: date, company, role, reply (yes or no), interview, offer.'], cost_usd: [0, 0], time: '15 minutes', expected: 'Your real rates, measured from week 1.', verification: 'artifact', consequential: null, safety: '', fallback: 'A note on the phone works too.' },
    { title: `Apply: ${round(x.apps_per_week, 0)} applications a week for ${Math.round(x.search_weeks)} weeks`, who: 'owner', instructions: [`About ${round(o.hours_per_week, 1)} hours a week.`, 'CHE may prepare each application; sending one needs your yes for that application.'], cost_usd: null, time: `${Math.round(x.search_weeks)} weeks`, expected: `About ${round(o.responses_per_week, 1)} replies a week.`, verification: 'measurement', metric: 'response_rate', consequential: 'application', safety: '', fallback: 'After 4 weeks, CHE recalibrates the rates from your sheet.' },
    { title: 'Week-4 check: compare real replies with the simulation', who: 'owner', instructions: ['Tell CHE how many applications went out and how many replied.'], cost_usd: null, time: '10 minutes', expected: `A reply rate between ${round(x.response_rate * 0.5 * 100, 0)}% and ${round(x.response_rate * 1.5 * 100, 0)}%.`, verification: 'measurement', metric: 'response_rate', consequential: null, safety: '', fallback: 'If replies are far below, change the résumé or the target before sending more.' },
    { title: 'Prepare for interviews', who: 'che', instructions: ['CHE runs practice questions by voice for the role.'], cost_usd: [0, 0], time: '1 hour per interview', expected: `About ${round(o.interviews_per_week, 2)} interviews a week.`, verification: 'owner_report', consequential: null, safety: '', fallback: 'Ask for feedback after each one.' },
    { title: 'Decide on an offer', who: 'owner', instructions: ['Compare pay, travel and terms. Accepting or signing is yours alone.'], cost_usd: null, time: '1 to 3 days', expected: `An even chance of an offer by week ${Number.isFinite(o.weeks_to_offer_p50) ? o.weeks_to_offer_p50 : 'beyond the horizon'}.`, verification: 'owner_report', metric: 'weeks_to_offer_p50', consequential: 'contract', safety: '', fallback: 'Keep applying until a contract is signed.' },
  ];
}

export const DATA_SOURCES = Object.freeze([
  { id: 'owner_rates', what: 'Your reply, interview and offer rates', kind: 'owner', source: 'your tracking sheet, when you report it', url: '', as_of: null, stale_after_days: 30 },
  { id: 'placeholder_rates', what: 'Placeholder conversion rates', kind: 'assumed', source: 'CHE placeholders (not market statistics)', url: '', as_of: '2026-10-27', stale_after_days: null },
  { id: 'job_market', what: 'Job-market data (openings, pay, competition)', kind: 'none', source: 'no data source', url: '', as_of: null, stale_after_days: null },
  { id: 'skills_gap', what: 'Skills gap against the target role', kind: 'none', source: 'no data source', url: '', as_of: null, stale_after_days: null },
]);

export const JOBSEARCH_MODEL = Object.freeze({
  id: 'job_search_funnel', version: 1, domain: 'employment',
  title: 'Job-search pipeline funnel',
  method: 'Independent applications through reply, interview and offer stages with a uniform delay; exact probability of an offer by each week, Monte Carlo over the conversion rates.',
  equations: [
    { id: 'p', text: 'p = r_reply · r_interview · r_offer', units: '1' },
    { id: 'expected', text: 'E[offers] = a · S · p', units: 'item' },
    { id: 'cdf', text: 'F(d) = P(L ≤ d), L uniform on [L_min, L_max] weeks', units: '1' },
    { id: 'by_week', text: 'P(t) = 1 − Π_{w=1}^{min(S,t)} (1 − p·F(t − w))^a', units: '1' },
    { id: 'workload', text: 'hours = a · h', units: 'h/week' },
  ],
  data_sources: DATA_SOURCES,
  assumptions: ['Applications are independent and rates stay constant.', 'The conversion rates are planning assumptions, not measured statistics; track your own and CHE recalibrates.', 'Delay from application to offer is uniform between its shortest and longest value.'],
  references: [{ title: 'Conversion funnel', url: 'https://en.wikipedia.org/wiki/Conversion_funnel' }, { title: 'Geometric distribution', url: 'https://en.wikipedia.org/wiki/Geometric_distribution' }],
  inputs: INPUTS, outputs: OUTPUTS, primary: 'p_offer_by_target',
  outcome_metrics: ['response_rate', 'interview_rate', 'offer_rate', 'weeks_to_offer_p50'],
  evaluate, dimensional, candidates, classify, planSteps,
});
