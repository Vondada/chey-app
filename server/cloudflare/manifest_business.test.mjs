// Manifestation Engine, business domain: unit economics and cash flow, with ranges, never one number.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BUSINESS_MODEL, cashFlow } from './manifest_business.js';
import { buildSpec, classifyCandidate, dimensionCheck, generateCandidates, sensitivity, simulate } from './manifest_engine.js';

const base = (over = {}) => ({ ...Object.fromEntries(BUSINESS_MODEL.inputs.map((i) => [i.id, i.nominal])), ...over });
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

test('known answer: $50 price, $20 cost, $3,000 a month fixed breaks even at 100 sales a month', () => {
  const o = BUSINESS_MODEL.evaluate(base({ price: 50, variable_cost: 20, fixed_monthly: 2500, marketing_monthly: 500 })).outputs;
  assert.equal(o.unit_contribution, 30);
  assert.equal(o.margin_ratio, 0.6);
  assert.equal(o.breakeven_units, 100);
});

test('known answer: flat sales pay back the start-up spend in ceil(S / monthly profit) months', () => {
  const x = base({ price: 100, variable_cost: 40, fixed_monthly: 400, marketing_monthly: 200, startup_cost: 3000, units_month1: 20, growth_monthly: 0, capacity: 100, horizon: 24 });
  const o = BUSINESS_MODEL.evaluate(x).outputs;
  // Monthly profit 20·60 − 600 = 600, so 3000 / 600 = 5 months.
  assert.equal(o.payback_month, 5);
  assert.equal(o.breakeven_month, 1);
  assert.equal(o.funding_needed, 3000);
});

test('money is conserved month by month', () => {
  for (const c of generateCandidates(buildSpec('Start a cleaning business: charge $90 per job, supplies $15 per job, $1,500 to start, 6 customers in the first month'))) {
    const x = base(c.variables);
    const months = cashFlow(x);
    const o = BUSINESS_MODEL.evaluate(x).outputs;
    near(o.final_cash + x.startup_cost, o.total_profit, 1e-6, `${c.id} cash`);
    const variable = months.reduce((s, m) => s + m.variable, 0);
    near(o.total_revenue - variable - months.length * (x.fixed_monthly + x.marketing_monthly), o.total_profit, 1e-6, `${c.id} P&L`);
  }
});

test('the equations are dimensionally consistent (USD, items, months)', () => {
  const x = base();
  const r = dimensionCheck(BUSINESS_MODEL, x, BUSINESS_MODEL.evaluate(x));
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.checked.map((k) => k.id).sort(), ['breakeven_units', 'cac', 'first_month_cash', 'margin_ratio', 'unit_contribution']);
});

test('Monte Carlo gives ordered percentiles, repeats with the same seed and changes with another', () => {
  const x = base({ price: 120, variable_cost: 25, fixed_monthly: 300, startup_cost: 2500, units_month1: 8 });
  const a = simulate(BUSINESS_MODEL, x, { seed: 11, samples: 1500 });
  const b = simulate(BUSINESS_MODEL, x, { seed: 11, samples: 1500 });
  const c = simulate(BUSINESS_MODEL, x, { seed: 12, samples: 1500 });
  assert.deepEqual(a.summary, b.summary);
  assert.notDeepEqual(a.summary.final_cash, c.summary.final_cash);
  const s = a.summary.final_cash;
  assert.ok(s.p5 <= s.p10 && s.p10 <= s.p50 && s.p50 <= s.p90 && s.p90 <= s.p95);
  assert.ok(s.p90 - s.p10 > 1000, 'a range, never one guaranteed number');
  assert.equal(a.evidence_level, 'simulated');
});

test('sensitivity: break-even elasticity to price is −p/(p − v)', () => {
  const sens = sensitivity(BUSINESS_MODEL, base({ price: 50, variable_cost: 20 }), { output: 'breakeven_units' });
  near(sens.rows.find((r) => r.input === 'price').elasticity, -50 / 30, 1e-3, 'price');
  near(sens.rows.find((r) => r.input === 'variable_cost').elasticity, 20 / 30, 1e-3, 'variable cost');
});

test('classification: negative contribution is incompatible, placeholders are unknown, owner numbers are judged', () => {
  const losing = buildSpec('Start a business selling cakes: charge $10 per cake, ingredients cost $12, 20 customers a month', {});
  const [c0] = generateCandidates(losing);
  const f0 = classifyCandidate(BUSINESS_MODEL, losing, c0, simulate(BUSINESS_MODEL, c0.variables, { seed: 1, samples: 200 }));
  assert.equal(f0.class, 'incompatible');
  assert.equal(f0.violated[0].id, 'positive_contribution');

  const vague = buildSpec('Start a business');
  const [c1] = generateCandidates(vague);
  const f1 = classifyCandidate(BUSINESS_MODEL, vague, c1, simulate(BUSINESS_MODEL, c1.variables, { seed: 1, samples: 200 }));
  assert.equal(f1.class, 'unknown');
  assert.ok(f1.limiting_constraint.missing.includes('Price per sale'));

  const real = buildSpec('Start a mobile car detailing business: charge $120 per car, supplies $25 per car, insurance $300 a month, $2,500 to start, 12 customers in the first month, earn $1,000 a month within 6 months with $5,000');
  assert.equal(real.variables.price, 120);
  assert.equal(real.variables.variable_cost, 25);
  assert.equal(real.variables.fixed_monthly, 300);
  assert.equal(real.variables.startup_cost, 2500);
  assert.equal(real.variables.units_month1, 12);
  assert.equal(real.variables.target_profit, 1000);
  assert.equal(real.variables.target_month, 6);
  assert.equal(real.budget.usd_max, 5000);
  const c2 = generateCandidates(real).find((c) => c.id === 'as-planned');
  const f2 = classifyCandidate(BUSINESS_MODEL, real, c2, simulate(BUSINESS_MODEL, c2.variables, { seed: 1, samples: 1000 }));
  assert.equal(f2.class, 'feasible_now');
  assert.ok(f2.alternatives.find((a) => a.id === 'volume_needed').numbers.units_per_month > 0);
});
