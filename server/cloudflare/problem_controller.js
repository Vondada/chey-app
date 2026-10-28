// Universal problem controller, first slice: one goal goes through classify → the verified capability → exact evaluation
// → round-trip verification → a receipt. The exact arithmetic is arithmetic.js (PR #737), the only parser in CHE for a
// plain sum. The capability registry (capability_registry.js) decides whether the arithmetic capability serves.
// A goal with no verified path is reported as needs_model. It is never answered from a guess, and no model is called.

import { ArithmeticError, checkEquations, evaluate, formatRational, parseDecimal, plainArithmetic } from './arithmetic.js';
import { PROMOTION_CHECKS, emptyRegistry, promote, recordCheck, recordUse, register, serving } from './capability_registry.js';
import { tradeExpectancy } from './trade_expectancy.js';

export const ARITHMETIC_ID = 'math.exact_arithmetic';
export const EXPECTANCY_ID = 'math.trade_expectancy';

const clip = (v, n) => String(v ?? '').slice(0, n);

/** Classifies a goal. Only a bare sum is arithmetic; anything else is unhandled and goes to the model. */
export function classify(goal = '') {
  const sum = plainArithmetic(goal);
  if (sum) return { kind: 'arithmetic', expression: sum.expression };
  // Figures the owner supplies in the message, not the paper journal: checked before any journal route.
  if (tradeExpectancy(goal)) return { kind: 'expectancy' };
  return { kind: 'unhandled', expression: null };
}

/**
 * The text a receipt shows for an exact value: a decimal when the decimal reads back to the same exact value, else the
 * exact fraction. Nothing is rounded, so a shown answer is always the value that was computed.
 */
export function exactText(r) {
  const shown = formatRational(r);
  if (r.d === 1n) return shown;
  try {
    const back = parseDecimal(shown);
    if (back.n === r.n && back.d === r.d) return shown;
  } catch (_) { /* not a plain decimal: use the fraction */ }
  return `${r.n}/${r.d}`;
}

/** Reads a shown answer back into an exact value: a decimal (with separators) or a fraction "n/d". */
function readBack(text) {
  const frac = /^\s*(-?\d+)\/(\d+)\s*$/.exec(text);
  if (frac) return { n: BigInt(frac[1]), d: BigInt(frac[2]) };
  return parseDecimal(text);
}

const CODE_FOR = [
  [/Division by zero/, 'division_by_zero'],
  [/Only whole-number powers/, 'exponent_too_large'],
];
const errorCode = (message) => CODE_FOR.find(([pattern]) => pattern.test(message))?.[1] || 'bad_expression';

/** Seeds the registry with the one deterministic capability. It is promoted only through the registry's own gate. */
export function seedRegistry(now = new Date().toISOString()) {
  const registry = emptyRegistry();
  register(registry, {
    capability_id: ARITHMETIC_ID,
    name: 'Exact arithmetic',
    description: 'Exact +, -, *, /, ^ and percentages on rational numbers (arithmetic.js). No model call, no network.',
    category: 'mathematics',
    inputs: ['arithmetic expression'],
    outputs: ['exact rational', 'verified flag'],
    implementation_location: 'server/cloudflare/arithmetic.js',
    execution: 'internal',
    risk_level: 'low',
    permissions: { network: [], credentials: [], files: [], devices: [], actions: [] },
  }, now);
  const evidence = {
    functional: 'arithmetic_eval.test.mjs: 24 exact problems, precedence, errors; problem_controller.test.mjs: receipts and routing',
    security: 'pure code: no network, storage or credentials used',
    resource: 'whole-number powers capped at 64; the expression is parsed in one pass',
    license: 'original CHE code',
    output: 'the stated result must read back to the exact value (round trip)',
    regression: 'problem_controller.test.mjs and arithmetic_eval.test.mjs run on every Worker test run',
    rollback: 'no prior version; removing the seed makes needs_model apply',
  };
  for (const check of PROMOTION_CHECKS) recordCheck(registry, ARITHMETIC_ID, check, { ok: true, evidence: evidence[check] }, now);
  promote(registry, ARITHMETIC_ID, now);
  register(registry, {
    capability_id: EXPECTANCY_ID,
    name: 'Hypothetical trade expectancy',
    description: 'Expected profit per trade, win rate, break-even win rate and total from the trade figures a message supplies (trade_expectancy.js). Exact arithmetic. Never reads the paper journal. No model call, no network.',
    category: 'mathematics',
    inputs: ['win count and average win, loss count and average loss (or win rate with the amounts)'],
    outputs: ['exact expectancy per trade', 'break-even win rate', 'verified flag'],
    implementation_location: 'server/cloudflare/trade_expectancy.js',
    execution: 'internal',
    risk_level: 'low',
    permissions: { network: [], credentials: [], files: [], devices: [], actions: [] },
  }, now);
  const expectancyEvidence = {
    functional: 'trade_expectancy.test.mjs: owner example, a second scenario, win rate vs profitability, conflicting counts, missing inputs, own-record refusal; problem_controller_route.test.mjs',
    security: 'pure code: no network, storage or credentials used',
    resource: 'a single pass over the message text',
    license: 'original CHE code',
    output: 'expectancy = win rate x win - loss rate x loss, computed exactly; conflicting figures are refused',
    regression: 'trade_expectancy.test.mjs runs on every Worker test run',
    rollback: 'removing the seed makes needs_model apply',
  };
  for (const check of PROMOTION_CHECKS) recordCheck(registry, EXPECTANCY_ID, check, { ok: true, evidence: expectancyEvidence[check] }, now);
  promote(registry, EXPECTANCY_ID, now);
  return registry;
}

/** A hypothetical trade calculation from the figures the message gives. Incomplete or conflicting figures are an error, never a guess. */
function solveExpectancyGoal(goal, { registry, now, steps, finish }) {
  const cap = serving(registry, EXPECTANCY_ID);
  steps.push({ step: 'select', capability: EXPECTANCY_ID, version: cap?.version ?? null, result: cap ? 'verified capability' : 'none served' });
  if (!cap) return finish({ status: 'needs_model', reason: 'The expectancy capability is not verified, so it was not used.' });
  const result = tradeExpectancy(goal);
  steps.push({ step: 'exact', result: result.status });
  recordUse(registry, EXPECTANCY_ID, result.status === 'verified', now);
  return finish({
    status: result.status === 'verified' ? 'verified' : 'error',
    expectancy: result,
    message: result.text,
    capability_id: EXPECTANCY_ID,
    capability_version: cap.version,
    ...(result.status === 'verified' ? {} : { error: result.status }),
  });
}

/**
 * Solves one goal and returns a receipt. Status is one of:
 *   verified     exact result; the stated result reads back to the exact value
 *   error        the goal has a verified path, and the problem is undefined (for example division by zero)
 *   needs_model  no verified path; the model would be needed and was not called
 */
export function solve(goal, { registry = seedRegistry(), now = new Date().toISOString(), correlationId = crypto.randomUUID() } = {}) {
  const started = performance.now();
  const route = classify(goal);
  const steps = [{ step: 'classify', result: route.kind }];
  const receipt = { correlation_id: correlationId, goal: clip(goal, 200), route: route.kind, model_calls: 0, steps };
  const finish = (fields) => ({ ...receipt, ...fields, latency_ms: Math.round((performance.now() - started) * 100) / 100 });

  if (route.kind === 'expectancy') return solveExpectancyGoal(goal, { registry, now, steps, finish });

  if (route.kind !== 'arithmetic') {
    steps.push({ step: 'select', result: 'no verified deterministic path' });
    return finish({ status: 'needs_model', reason: 'No verified path handles this goal yet. The model was not called, so no answer is given.' });
  }
  const cap = serving(registry, ARITHMETIC_ID);
  steps.push({ step: 'select', capability: ARITHMETIC_ID, version: cap?.version ?? null, result: cap ? 'verified capability' : 'none served' });
  if (!cap) return finish({ status: 'needs_model', reason: 'The arithmetic capability is not verified, so it was not used.' });

  let exact;
  try {
    exact = evaluate(route.expression);
  } catch (err) {
    if (!(err instanceof ArithmeticError)) throw err;
    // An undefined problem is a correct answer, so it does not count against the capability's record.
    steps.push({ step: 'exact', result: errorCode(err.message) });
    return finish({ status: 'error', expression: route.expression, error: errorCode(err.message), message: err.message, capability_id: ARITHMETIC_ID, capability_version: cap.version });
  }
  const result = exactText(exact);
  steps.push({ step: 'exact', result });
  // Round trip: the stated result must read back to the exact value, and a decimal must also check as an equation.
  const readsBack = (() => { try { const b = readBack(result); return b.n === exact.n && b.d === exact.d; } catch (_) { return false; } })();
  const equation = /\//.test(result) ? [] : checkEquations(`${route.expression} = ${result}`);
  const equationOk = equation.length === 0 || equation.every((c) => c.status === 'verified');
  const verified = readsBack && equationOk;
  steps.push({ step: 'verify', result: verified ? 'agrees' : 'disagrees' });
  recordUse(registry, ARITHMETIC_ID, verified, now);
  return finish({
    status: verified ? 'verified' : 'error',
    expression: route.expression,
    result,
    capability_id: ARITHMETIC_ID,
    capability_version: cap.version,
    ...(verified ? {} : { error: 'verification_failed', message: 'The computed answer did not read back to the exact value, so it is not given.' }),
  });
}

/**
 * The chat route's use of the controller. Returns null when the goal has no verified path, so the model answers as
 * before. Otherwise returns the reply text and the receipt, with no model call.
 */
export function answerForChat(goal, options) {
  const receipt = solve(goal, options);
  if (receipt.status === 'needs_model') return null;
  if (receipt.expectancy) return { text: receipt.message, status: receipt.status, expression: null, receipt };
  const text = receipt.status === 'verified' ? `${receipt.result}.` : (receipt.message || 'That problem has no answer, sir.');
  return { text, status: receipt.status, expression: receipt.expression, receipt };
}
