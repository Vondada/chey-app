// Manifestation Engine, employment domain: the job-search funnel.
import assert from 'node:assert/strict';
import test from 'node:test';
import { JOBSEARCH_MODEL, lagCdf, offerByWeek } from './manifest_jobsearch.js';
import { rngFrom } from './manifest_stats.js';
import { buildSpec, classifyCandidate, dimensionCheck, generateCandidates, sensitivity, simulate } from './manifest_engine.js';

const base = (over = {}) => ({ ...Object.fromEntries(JOBSEARCH_MODEL.inputs.map((i) => [i.id, i.nominal])), ...over });

test('known answer: with no delay the chance of an offer is geometric, 1 − (1 − p)^(a·t)', () => {
  const x = base({ lag_min: 0, lag_max: 0, apps_per_week: 5, response_rate: 0.1, interview_rate: 0.5, offer_rate: 0.2, search_weeks: 52 });
  const p = 0.01;
  for (const t of [1, 4, 10, 30]) assert.ok(Math.abs(offerByWeek(x, t) - (1 - (1 - p) ** (5 * t))) < 1e-12, `week ${t}`);
});

test('the exact formula matches a Monte Carlo of individual applications', () => {
  const x = base({ apps_per_week: 6, lag_min: 2, lag_max: 6, search_weeks: 10 });
  const p = x.response_rate * x.interview_rate * x.offer_rate;
  const rng = rngFrom(99);
  const trials = 20000;
  const t = 12;
  let hit = 0;
  for (let i = 0; i < trials; i += 1) {
    let got = false;
    for (let w = 1; w <= x.search_weeks && !got; w += 1) {
      for (let k = 0; k < x.apps_per_week && !got; k += 1) {
        if (rng() < p) {
          const lag = x.lag_min + Math.floor(rng() * (x.lag_max - x.lag_min + 1));
          if (w + lag <= t) got = true;
        }
      }
    }
    if (got) hit += 1;
  }
  const exact = offerByWeek(x, t);
  const se = Math.sqrt(exact * (1 - exact) / trials);
  assert.ok(Math.abs(hit / trials - exact) < 4 * se, `MC ${hit / trials} vs exact ${exact}`);
});

test('the delay distribution is a proper CDF', () => {
  assert.equal(lagCdf(1, 2, 5), 0);
  assert.equal(lagCdf(2, 2, 5), 0.25);
  assert.equal(lagCdf(5, 2, 5), 1);
  assert.equal(lagCdf(99, 2, 5), 1);
});

test('funnel stages never grow, the curve never falls, and the equations are dimensionally consistent', () => {
  const x = base();
  const r = JOBSEARCH_MODEL.evaluate(x);
  assert.ok(r.outputs.responses_per_week >= r.outputs.interviews_per_week);
  assert.ok(r.outputs.interviews_per_week >= x.apps_per_week * r.outputs.p_offer_per_app);
  for (let i = 1; i < r.series.length; i += 1) assert.ok(r.series[i].p_offer >= r.series[i - 1].p_offer);
  assert.ok(r.outputs.weeks_to_offer_p50 <= r.outputs.weeks_to_offer_p90);
  const d = dimensionCheck(JOBSEARCH_MODEL, x, r);
  assert.ok(d.ok, d.error);
});

test('sensitivity: expected offers have elasticity exactly 1 to each conversion rate', () => {
  const sens = sensitivity(JOBSEARCH_MODEL, base(), { output: 'expected_offers' });
  for (const id of ['response_rate', 'interview_rate', 'offer_rate']) assert.ok(Math.abs(sens.rows.find((r) => r.input === id).elasticity - 1) < 1e-9, id);
});

test('spec, candidates and classification, with low confidence until the owner tracks his own rates', () => {
  const spec = buildSpec('Find a new job as a data analyst within 4 months, 15 hours a week');
  assert.equal(spec.domain, 'employment');
  assert.equal(spec.variables.target_weeks, 17);
  assert.equal(spec.variables.available_hours, 15);
  const cands = generateCandidates(spec);
  assert.deepEqual(cands.map((c) => c.id), ['volume', 'targeted', 'referral']);
  const t = cands.find((c) => c.id === 'targeted');
  // No job-market data source is wired: with placeholder rates the odds are not judged.
  const f = classifyCandidate(JOBSEARCH_MODEL, spec, t, simulate(JOBSEARCH_MODEL, t.variables, { seed: 4, samples: 800 }));
  assert.equal(f.class, 'unknown');
  assert.match(f.reasons[0], /No data source for job-market conversion rates/);
  assert.deepEqual(f.limiting_constraint.missing, ['response_rate', 'interview_rate', 'offer_rate']);
  assert.match(f.confidence, /^low/);
  assert.ok(JOBSEARCH_MODEL.data_sources.some((d) => d.id === 'job_market' && d.source === 'no data source'));
  const bad = classifyCandidate(JOBSEARCH_MODEL, spec, { variables: base({ response_rate: 1.4 }) }, null);
  assert.equal(bad.class, 'incompatible');
  // With the owner's own tracked rates the odds are judged.
  const own = buildSpec('Find a job in 4 months with a 12% reply rate, 40% interview rate and 25% offer rate, 15 hours a week');
  assert.equal(own.variables.response_rate, 0.12);
  assert.equal(own.variables.offer_rate, 0.25);
  const ot = generateCandidates(own).find((c) => c.id === 'targeted');
  const g = classifyCandidate(JOBSEARCH_MODEL, own, ot, simulate(JOBSEARCH_MODEL, ot.variables, { seed: 4, samples: 800 }));
  assert.ok(['feasible_now', 'feasible_expensive'].includes(g.class), g.class);
  assert.match(g.confidence, /^medium/);
  // Over-committed hours are impractical even if the odds are good.
  const heavy = { ...ot, variables: { ...ot.variables, apps_per_week: 30, hours_per_app: 1.5 } };
  assert.equal(classifyCandidate(JOBSEARCH_MODEL, own, heavy, simulate(JOBSEARCH_MODEL, heavy.variables, { seed: 4, samples: 300 })).class, 'feasible_expensive');
});
