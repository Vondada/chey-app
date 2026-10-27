// Manifestation Engine, business / income domain: unit economics, break-even and monthly cash flow.
// Every figure is computed from the owner's inputs or from a labelled placeholder assumption; the
// result is always a range from Monte Carlo over the uncertain inputs, never one guaranteed number.
//
// Equations (month k = 1..H):
//   c        = p − v                         unit contribution                     [USD/item]
//   CM%      = c / p                         contribution margin ratio             [1]
//   F        = F_fixed + F_marketing         fixed monthly costs                   [USD/month]
//   Q_be     = F / c                         break-even volume                     [item/month]
//   q_k      = min(q_1·(1+g)^(k−1), Q_cap)   units sold in month k (compound growth to a market cap) [item/month]
//   π_k      = q_k·c − F                     operating profit in month k           [USD/month]
//   C_k      = −S + Σ_{j≤k} π_j              cumulative cash after the start-up spend S [USD]
//   funding  = −min(0, min_k C_k)            cash needed before the business pays for itself [USD]
// Conservation check (tested): C_H + S = Σ π_k, and Σ q_k·p − Σ q_k·v − H·F = Σ π_k.
// Boundary conditions: no taxes, no financing cost, no seasonality, every unit sold is paid in the month it is sold.
// Reference: contribution margin and break-even analysis (https://en.wikipedia.org/wiki/Contribution_margin,
// https://en.wikipedia.org/wiki/Break-even_(economics)).

import { add, div, mul, q, sub } from './manifest_units.js';
import { round } from './manifest_stats.js';

const INPUTS = [
  { id: 'price', name: 'Price per sale', unit: 'USD/item', kind: 'uncertain', nominal: 100, lo: 85, hi: 110, physical: [0, 1e9], placeholder: true },
  { id: 'variable_cost', name: 'Variable cost per sale (materials, fees, fuel)', unit: 'USD/item', kind: 'uncertain', nominal: 30, lo: 25, hi: 40, physical: [0, 1e9], placeholder: true },
  { id: 'fixed_monthly', name: 'Fixed costs per month (insurance, rent, software, phone)', unit: 'USD/month', kind: 'uncertain', nominal: 500, lo: 400, hi: 650, physical: [0, 1e9], placeholder: true },
  { id: 'marketing_monthly', name: 'Marketing per month', unit: 'USD/month', kind: 'design', nominal: 200, physical: [0, 1e9], placeholder: true },
  { id: 'startup_cost', name: 'Start-up spend before the first sale', unit: 'USD', kind: 'uncertain', nominal: 3000, lo: 2500, hi: 4000, physical: [0, 1e10], placeholder: true },
  { id: 'units_month1', name: 'Sales in the first month', unit: 'item/month', kind: 'uncertain', nominal: 10, lo: 4, hi: 16, physical: [0, 1e9], placeholder: true },
  { id: 'growth_monthly', name: 'Monthly growth in sales', unit: '1', kind: 'uncertain', nominal: 0.1, lo: 0, hi: 0.2, physical: [-1, 10], placeholder: true },
  { id: 'capacity', name: 'Most sales you can serve or the market takes per month', unit: 'item/month', kind: 'design', nominal: 60, physical: [0, 1e9], placeholder: true },
  { id: 'horizon', name: 'Months simulated', unit: 'month', kind: 'design', nominal: 12, physical: [1, 120], int: true },
  { id: 'target_profit', name: 'Monthly profit goal', unit: 'USD/month', kind: 'goal', nominal: 0, physical: [-Infinity, Infinity] },
  { id: 'target_month', name: 'Reach the goal by month', unit: 'month', kind: 'goal', nominal: 12, physical: [1, 120], int: true },
  { id: 'budget', name: 'Cash you can put in', unit: 'USD', kind: 'goal', nominal: Infinity, physical: [0, Infinity] },
];

const OUTPUTS = [
  { id: 'unit_contribution', name: 'Contribution per sale', unit: 'USD/item', better: 'higher' },
  { id: 'margin_ratio', name: 'Contribution margin', unit: '1', better: 'higher' },
  { id: 'breakeven_units', name: 'Break-even sales per month', unit: 'item/month', better: 'lower' },
  { id: 'breakeven_month', name: 'First month with an operating profit', unit: 'month', better: 'lower' },
  { id: 'payback_month', name: 'Month the start-up spend is paid back', unit: 'month', better: 'lower' },
  { id: 'funding_needed', name: 'Cash needed before it pays for itself', unit: 'USD', better: 'lower' },
  { id: 'final_cash', name: 'Cumulative cash at the end', unit: 'USD', better: 'higher' },
  { id: 'profit_last_month', name: 'Operating profit in the last month', unit: 'USD/month', better: 'higher' },
  { id: 'goal_month', name: 'First month at the profit goal', unit: 'month', better: 'lower' },
  { id: 'cac', name: 'Marketing spend per first-month sale (an upper bound on customer acquisition cost)', unit: 'USD/item', better: 'lower' },
  { id: 'total_revenue', name: 'Revenue over the horizon', unit: 'USD' },
  { id: 'total_profit', name: 'Operating profit over the horizon', unit: 'USD' },
];

/** Month-by-month cash flow. */
export function cashFlow(x) {
  const months = [];
  const c = x.price - x.variable_cost;
  const F = x.fixed_monthly + x.marketing_monthly;
  let cash = -x.startup_cost;
  for (let k = 1; k <= Math.round(x.horizon); k += 1) {
    const units = Math.min(x.units_month1 * (1 + x.growth_monthly) ** (k - 1), x.capacity);
    const revenue = units * x.price;
    const profit = units * c - F;
    cash += profit;
    months.push({ month: k, units, revenue, variable: units * x.variable_cost, fixed: F, profit, cash });
  }
  return months;
}

function evaluate(x) {
  const c = x.price - x.variable_cost;
  const F = x.fixed_monthly + x.marketing_monthly;
  const months = cashFlow(x);
  const first = (pred) => { const m = months.find(pred); return m ? m.month : Infinity; };
  const minCash = Math.min(-x.startup_cost, ...months.map((m) => m.cash));
  const outputs = {
    unit_contribution: c,
    margin_ratio: x.price > 0 ? c / x.price : -Infinity,
    breakeven_units: c > 0 ? F / c : Infinity,
    breakeven_month: first((m) => m.profit >= 0),
    payback_month: first((m) => m.cash >= 0),
    funding_needed: -Math.min(0, minCash),
    final_cash: months.at(-1)?.cash ?? -x.startup_cost,
    profit_last_month: months.at(-1)?.profit ?? -F,
    goal_month: first((m) => m.profit >= x.target_profit),
    cac: x.units_month1 > 0 ? x.marketing_monthly / x.units_month1 : Infinity,
    total_revenue: months.reduce((s, m) => s + m.revenue, 0),
    total_profit: months.reduce((s, m) => s + m.profit, 0),
  };
  const checks = [
    { id: 'positive_contribution', kind: 'physics', ok: c > 0, text: 'Each sale must bring in more than it costs (price above variable cost); otherwise more sales only lose more money.' },
    { id: 'capacity_covers_breakeven', kind: 'physics', ok: outputs.breakeven_units <= x.capacity, text: 'The most you can sell per month must exceed the break-even volume.' },
    { id: 'profit_goal', kind: 'goal', ok: outputs.goal_month <= x.target_month, text: `Monthly profit of $${Math.round(x.target_profit).toLocaleString('en-US')} by month ${Math.round(x.target_month)}.` },
    { id: 'budget', kind: 'practical', ok: !Number.isFinite(x.budget) || outputs.funding_needed <= x.budget, text: Number.isFinite(x.budget) ? `Cash needed within your $${Math.round(x.budget).toLocaleString('en-US')}.` : 'No cash limit given.' },
  ];
  return { outputs, checks, series: months.map((m) => ({ month: m.month, units: round(m.units, 2), profit: round(m.profit, 2), cash: round(m.cash, 2) })) };
}

function dimensional(x) {
  const p = q(x.price, 'USD/item');
  const v = q(x.variable_cost, 'USD/item');
  const c = sub(p, v);
  const F = add(q(x.fixed_monthly, 'USD/month'), q(x.marketing_monthly, 'USD/month'));
  const units1 = q(x.units_month1, 'item/month');
  const profit1 = sub(mul(units1, c), F);
  return {
    unit_contribution: c,
    margin_ratio: div(c, p),
    cac: div(q(x.marketing_monthly, 'USD/month'), units1),
    breakeven_units: div(F, c),
    // One month of profit times one month is USD, the same dimension as the start-up spend it pays back.
    first_month_cash: add(q(-x.startup_cost, 'USD'), mul(profit1, q(1, 'month'))),
  };
}

const nominalInputs = () => Object.fromEntries(INPUTS.map((i) => [i.id, i.nominal]));

/** Three operating strategies on the owner's numbers (or labelled placeholders when none were given). */
function candidates(spec) {
  const v = spec.variables || {};
  const base = { ...nominalInputs(), ...v, budget: spec.budget?.usd_max ?? Infinity, target_profit: v.target_profit ?? 0, target_month: v.target_month ?? spec.timeline?.months ?? 12 };
  base.horizon = Math.max(base.horizon, base.target_month);
  const out = [];
  const add = (id, name, description, change, notes = []) => out.push({ id, name, description, variables: Object.fromEntries(Object.entries({ ...base, ...change }).map(([k, val]) => [k, Number.isFinite(val) ? round(val, 4) : val])), notes });
  add('as-planned', 'As described', 'Your prices, costs and volumes as given.', {});
  add('premium', 'Premium: 25% higher price, 25% fewer first-month sales', 'Fewer, better-paying customers; same costs.', { price: base.price * 1.25, units_month1: base.units_month1 * 0.75 });
  add('lean', 'Lean start: half the start-up spend and marketing, slower growth', 'Start smaller with what you have; grow by word of mouth.', { startup_cost: base.startup_cost * 0.5, marketing_monthly: base.marketing_monthly * 0.5, growth_monthly: base.growth_monthly * 0.6 });
  return out;
}

function classify({ x, nominal, run, spec }) {
  const physics = nominal.checks.filter((c) => c.kind === 'physics' && !c.ok);
  const placeholders = INPUTS.filter((i) => i.placeholder && !(i.id in (spec?.owner_variables || {}))).map((i) => i.name);
  const alternatives = alternativesFor(x, nominal);
  if (physics.length) {
    return { class: 'incompatible', violated: physics.map(({ id, text }) => ({ id, text })), limiting_constraint: { id: physics[0].id, text: physics[0].text, required_price_usd: round(x.variable_cost + (x.fixed_monthly + x.marketing_monthly) / Math.max(x.capacity, 1e-9), 2) }, reasons: physics.map((c) => c.text), alternatives };
  }
  // Without the owner's own price, cost and volume figures the numbers are placeholders: insufficient evidence.
  const ownerGiven = INPUTS.filter((i) => i.placeholder).length - placeholders.length;
  if (ownerGiven < 3) {
    return { class: 'unknown', violated: [], limiting_constraint: { id: 'owner_inputs', text: 'Your own price, cost and sales figures', missing: placeholders }, reasons: [`Only ${ownerGiven} of your own figures were given; the rest are placeholders. Give at least price, variable cost and first-month sales.`], alternatives };
  }
  const p = run?.success_probability ?? 0;
  const practical = nominal.checks.filter((c) => c.kind === 'practical' && !c.ok);
  const sens = run?.sensitivity?.[0];
  const limiting = sens ? { id: sens.input, text: `Most sensitive input: ${sens.name}`, swing: sens.swing } : null;
  if (p >= 0.5 && !practical.length) return { class: 'feasible_now', violated: [], limiting_constraint: limiting, reasons: [`Reaches the goal by month ${Math.round(x.target_month)} in ${Math.round(p * 100)}% of Monte Carlo runs.`], alternatives };
  if (p >= 0.1 || practical.length) return { class: 'feasible_expensive', violated: [], limiting_constraint: practical[0] ? { id: practical[0].id, text: practical[0].text } : limiting, reasons: [`Reaches the goal in ${Math.round(p * 100)}% of runs.`, ...practical.map((c) => `Not met: ${c.text}`)], alternatives };
  return { class: 'unproven', violated: [], limiting_constraint: limiting, reasons: [`Reaches the goal in only ${Math.round(p * 100)}% of runs: it would need better numbers than the ones given.`], alternatives };
}

function alternativesFor(x, nominal) {
  const F = x.fixed_monthly + x.marketing_monthly;
  const out = [];
  const needUnits = (x.target_profit + F) / Math.max(x.price - x.variable_cost, 1e-9);
  out.push({ id: 'volume_needed', name: 'Sales needed for the goal', class: needUnits <= x.capacity ? 'feasible_now' : 'feasible_expensive', text: `${Math.ceil(needUnits)} sales a month reach $${Math.round(x.target_profit).toLocaleString('en-US')} profit at these prices.`, numbers: { units_per_month: round(needUnits, 2) } });
  const priceNeeded = x.variable_cost + (x.target_profit + F) / Math.max(Math.min(x.capacity, nominal.outputs.breakeven_units * 2 || x.capacity), 1e-9);
  out.push({ id: 'price_needed', name: 'Price that reaches the goal at your capacity', class: 'unknown', text: `About $${round(x.variable_cost + (x.target_profit + F) / Math.max(x.capacity, 1e-9), 2)} per sale if you sell your full ${Math.round(x.capacity)} a month. Whether customers pay it is untested.`, numbers: { price_usd: round(x.variable_cost + (x.target_profit + F) / Math.max(x.capacity, 1e-9), 2), at_half_capacity: round(priceNeeded, 2) } });
  out.push({ id: 'side_first', name: 'Run it part-time beside a paid job first', class: 'unknown', text: 'Keeps income steady while the real numbers are measured. Not modelled here.' });
  return out;
}

function planSteps({ candidate, nominal, run }) {
  const o = nominal.outputs;
  const x = candidate.variables;
  const band = run?.summary?.funding_needed;
  return [
    { title: 'Check demand with real people before spending', who: 'owner', instructions: ['Ask 10 likely customers what they pay today and whether they would pay your price.', 'Write down each answer.'], cost_usd: null, time: '1 week', expected: `Most say yes at about $${round(x.price, 0)}.`, verification: 'measurement', metric: 'price', consequential: null, safety: '', fallback: 'If fewer than 3 of 10 would pay, rerun the simulation with the price they named.' },
    { title: 'Replace every placeholder with a real quote', who: 'che', instructions: ['CHE lists each cost in the simulation; you get two quotes for each start-up item and monthly cost.', 'Send the quotes to CHE to rerun the numbers.'], cost_usd: [0, 0], time: '1 week', expected: `Start-up spend near $${Math.round(x.startup_cost).toLocaleString('en-US')} and fixed costs near $${Math.round(x.fixed_monthly).toLocaleString('en-US')} a month.`, verification: 'owner_report', consequential: null, safety: '', fallback: 'If quotes run higher, choose the lean candidate.' },
    { title: 'Register the business and get insurance', who: 'owner', instructions: ['Check your city and state licence rules and register.', 'Get liability insurance quotes.'], cost_usd: null, time: '1 to 3 weeks', expected: 'Licensed and insured.', verification: 'owner_report', consequential: 'account', safety: 'Legal: rules vary by place; check with your city or a local small-business centre.', fallback: 'Ask the local small-business development centre (free in the US).' },
    { title: 'Spend the start-up money', who: 'owner', instructions: ['Buy the start-up items after you approve the list.'], cost_usd: [Math.round(x.startup_cost * 0.8), Math.round(x.startup_cost * 1.3)], time: '1 week', expected: band ? `Total cash needed between $${Math.round(band.p10).toLocaleString('en-US')} and $${Math.round(band.p90).toLocaleString('en-US')} (p10–p90).` : `About $${Math.round(o.funding_needed).toLocaleString('en-US')} before it pays for itself.`, verification: 'owner_report', consequential: 'money', safety: '', fallback: 'Buy only what the first ten customers need.' },
    { title: 'Run a pilot month and record every sale', who: 'owner', instructions: ['Record each sale: date, price, and its variable cost.', 'At month end tell CHE the number of sales and the profit.'], cost_usd: [Math.round(x.fixed_monthly + x.marketing_monthly), Math.round((x.fixed_monthly + x.marketing_monthly) * 1.2)], time: '1 month', expected: `About ${round(x.units_month1, 1)} sales in month 1.`, verification: 'measurement', metric: 'units_month1', consequential: null, safety: '', fallback: 'CHE compares the month with the simulation and updates the estimate before month 2.' },
    { title: 'Go or no-go review at month 3', who: 'owner', instructions: ['CHE compares months 1 to 3 with the p10–p90 band and names which assumptions were wrong.'], cost_usd: [0, 0], time: '1 hour', expected: `Break-even by month ${Number.isFinite(o.breakeven_month) ? o.breakeven_month : 'not within the horizon'}.`, verification: 'owner_report', consequential: null, safety: '', fallback: 'Change price or scope, or stop before more cash goes in.' },
  ];
}

export const DATA_SOURCES = Object.freeze([
  { id: 'owner_figures', what: 'Price, costs, start-up spend and sales volumes', kind: 'owner', source: 'your own figures, when you give them', url: '', as_of: null, stale_after_days: 90 },
  { id: 'placeholders', what: 'Default figures used until you give yours', kind: 'assumed', source: 'CHE placeholders (not market data)', url: '', as_of: '2026-10-27', stale_after_days: null },
  { id: 'market_cac', what: 'Market customer-acquisition cost benchmarks', kind: 'none', source: 'no data source', url: '', as_of: null, stale_after_days: null },
  { id: 'market_demand', what: 'Local demand and competitor prices', kind: 'none', source: 'no data source', url: '', as_of: null, stale_after_days: null },
  { id: 'method', what: 'Contribution margin and break-even method', kind: 'reference', source: 'Contribution margin', url: 'https://en.wikipedia.org/wiki/Contribution_margin', as_of: '2026-10-27', stale_after_days: null },
]);

export const BUSINESS_MODEL = Object.freeze({
  id: 'unit_economics_cashflow', version: 1, domain: 'business',
  title: 'Unit economics and monthly cash flow',
  method: 'Contribution margin, break-even volume and a month-by-month cash flow with compound sales growth to a capacity cap; Monte Carlo over the uncertain inputs.',
  equations: [
    { id: 'contribution', text: 'c = p − v', units: 'USD/item' },
    { id: 'margin', text: 'CM = c / p', units: '1' },
    { id: 'breakeven', text: 'Q_be = (F_fixed + F_marketing) / c', units: 'item/month' },
    { id: 'units', text: 'q_k = min(q_1·(1+g)^(k−1), Q_cap)', units: 'item/month' },
    { id: 'profit', text: 'π_k = q_k·c − F', units: 'USD/month' },
    { id: 'cash', text: 'C_k = −S + Σ_{j≤k} π_j', units: 'USD' },
    { id: 'funding', text: 'funding = −min(0, min_k C_k)', units: 'USD' },
  ],
  data_sources: DATA_SOURCES,
  assumptions: ['No taxes, loans or interest; no seasonality.', 'Sales are paid in the month they happen.', 'Placeholder figures are labelled and must be replaced with your own quotes and measured sales.'],
  references: [
    { title: 'Contribution margin', url: 'https://en.wikipedia.org/wiki/Contribution_margin' },
    { title: 'Break-even (economics)', url: 'https://en.wikipedia.org/wiki/Break-even_(economics)' },
  ],
  inputs: INPUTS, outputs: OUTPUTS, primary: 'final_cash',
  outcome_metrics: ['units_month1', 'profit_last_month', 'price'],
  evaluate, dimensional, candidates, classify, planSteps,
});
