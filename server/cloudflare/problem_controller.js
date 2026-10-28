// Universal problem controller, first slice: one goal goes through classify → choose the cheapest verified path →
// execute → cross-check → record a receipt. It reuses the capability registry (promotion gate, serving, use records).
// A goal with no verified path is reported as needs_model. It is never answered from a guess, and no model is called.

import { PROMOTION_CHECKS, emptyRegistry, register, recordCheck, promote, serving, recordUse } from './capability_registry.js';

export const ARITHMETIC_ID = 'math.exact_arithmetic';

const MAX_EXPONENT = 64n;
const TOLERANCE = 1e-9;
const EXPRESSION = /^[\d\s+\-*/^().]+$/;

const clip = (v, n) => String(v ?? '').slice(0, n);
const coded = (code) => Object.assign(new Error(code), { code });

// Exact rational arithmetic on BigInt. The denominator is always positive and the fraction is reduced.
const gcd = (a, b) => {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y) [x, y] = [y, x % y];
  return x;
};
const rat = (n, d = 1n) => {
  if (d === 0n) throw coded('division_by_zero');
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n, d) || 1n;
  return { n: n / g, d: d / g };
};
const EXACT = {
  num: (s) => {
    const [whole, frac = ''] = s.split('.');
    return rat(BigInt(whole + frac), 10n ** BigInt(frac.length));
  },
  add: (a, b) => rat(a.n * b.d + b.n * a.d, a.d * b.d),
  sub: (a, b) => rat(a.n * b.d - b.n * a.d, a.d * b.d),
  mul: (a, b) => rat(a.n * b.n, a.d * b.d),
  div: (a, b) => {
    if (b.n === 0n) throw coded('division_by_zero');
    return rat(a.n * b.d, a.d * b.n);
  },
  pow: (a, b) => {
    if (b.d !== 1n || b.n > MAX_EXPONENT || b.n < -MAX_EXPONENT) throw coded('exponent_too_large');
    const k = b.n < 0n ? -b.n : b.n;
    let r = rat(1n);
    for (let i = 0n; i < k; i++) r = EXACT.mul(r, a);
    return b.n < 0n ? EXACT.div(rat(1n), r) : r;
  },
  neg: (a) => rat(-a.n, a.d),
  toNumber: (a) => Number(a.n) / Number(a.d),
};

// Floating-point arithmetic. It is a different arithmetic from EXACT, so it cross-checks the exact result.
const FLOAT = {
  num: (s) => Number(s),
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  mul: (a, b) => a * b,
  div: (a, b) => {
    if (b === 0) throw coded('division_by_zero');
    return a / b;
  },
  pow: (a, b) => {
    if (b !== Math.trunc(b) || Math.abs(b) > Number(MAX_EXPONENT)) throw coded('exponent_too_large');
    if (a === 0 && b < 0) throw coded('division_by_zero');
    return a ** b;
  },
  neg: (a) => -a,
  toNumber: (a) => a,
};

// One recursive-descent parser for both arithmetics. Precedence: parentheses, then ^ (right-assoc), then unary -,
// then * and /, then + and -. So -2^2 is -4, as in school arithmetic.
export function evaluate(source, ops) {
  const normalised = String(source).replace(/\s+/g, '');
  const tokens = normalised.match(/\d+(?:\.\d+)?|[-+*/^()]/g) || [];
  if (tokens.join('') !== normalised) throw coded('bad_expression');
  let i = 0;
  const eat = (t) => {
    if (tokens[i] === t) { i++; return true; }
    return false;
  };
  const expr = () => {
    let v = term();
    while (tokens[i] === '+' || tokens[i] === '-') {
      const op = tokens[i++];
      const r = term();
      v = op === '+' ? ops.add(v, r) : ops.sub(v, r);
    }
    return v;
  };
  const term = () => {
    let v = factor();
    while (tokens[i] === '*' || tokens[i] === '/') {
      const op = tokens[i++];
      const r = factor();
      v = op === '*' ? ops.mul(v, r) : ops.div(v, r);
    }
    return v;
  };
  const factor = () => (eat('-') ? ops.neg(factor()) : power());
  const power = () => {
    const base = primary();
    return eat('^') ? ops.pow(base, factor()) : base;
  };
  const primary = () => {
    if (eat('(')) {
      const v = expr();
      if (!eat(')')) throw coded('bad_expression');
      return v;
    }
    if (tokens[i] && /^\d/.test(tokens[i])) return ops.num(tokens[i++]);
    throw coded('bad_expression');
  };
  const value = expr();
  if (i !== tokens.length) throw coded('bad_expression');
  return value;
}

/** Decides which kind of problem a goal is. Only plain arithmetic is handled deterministically in this slice. */
export function classify(goal = '') {
  let s = String(goal).trim()
    .replace(/^(?:what is|what's|calculate|compute|evaluate|solve)\s+/i, '')
    .replace(/\s*[=?]\s*$/, '')
    .replace(/×/g, '*')
    .replace(/÷/g, '/')
    .replace(/(?<=\d\s*)x(?=\s*\(?\d)/gi, '*');
  if (!s || !EXPRESSION.test(s) || !/\d/.test(s)) return { kind: 'unhandled', expression: null };
  return { kind: 'arithmetic', expression: s.trim() };
}

const formatExact = (r) => (r.d === 1n ? r.n.toString() : `${r.n}/${r.d}`);

/** Seeds the registry with the one deterministic capability. It is promoted only through the registry's own gate. */
export function seedRegistry(now = new Date().toISOString()) {
  const registry = emptyRegistry();
  register(registry, {
    capability_id: ARITHMETIC_ID,
    name: 'Exact arithmetic',
    description: 'Exact +, -, *, /, ^ on rational numbers, cross-checked with floating point. No model call, no network.',
    category: 'mathematics',
    inputs: ['arithmetic expression'],
    outputs: ['exact rational', 'verified flag'],
    implementation_location: 'server/cloudflare/problem_controller.js',
    execution: 'internal',
    risk_level: 'low',
    permissions: { network: [], credentials: [], files: [], devices: [], actions: [] },
  }, now);
  const evidence = {
    functional: 'problem_controller.test.mjs: precedence, rationals, errors',
    security: 'pure code: no network, storage or credentials used',
    resource: `exponent capped at ${MAX_EXPONENT}, expression parsed in one pass`,
    license: 'original CHE code',
    output: 'exact result must match the floating-point cross-check',
    regression: 'problem_controller.test.mjs runs on every Worker test run',
    rollback: 'no prior version; removing the seed makes needs_model apply',
  };
  for (const check of PROMOTION_CHECKS) recordCheck(registry, ARITHMETIC_ID, check, { ok: true, evidence: evidence[check] }, now);
  promote(registry, ARITHMETIC_ID, now);
  return registry;
}

/**
 * Solves one goal and returns a receipt. Status is one of:
 *   verified     exact result, cross-checked
 *   unverified   exact result, cross-check disagreed (never claimed as verified)
 *   error        the goal has a verified path, and the problem is undefined (for example division by zero)
 *   needs_model  no verified path; the model would be needed and was not called
 */
export function solve(goal, { registry = seedRegistry(), now = new Date().toISOString(), correlationId = crypto.randomUUID() } = {}) {
  const started = performance.now();
  const route = classify(goal);
  const steps = [{ step: 'classify', result: route.kind }];
  const receipt = { correlation_id: correlationId, goal: clip(goal, 200), route: route.kind, model_calls: 0, steps };
  const finish = (fields) => ({ ...receipt, ...fields, latency_ms: Math.round((performance.now() - started) * 100) / 100 });

  if (route.kind !== 'arithmetic') {
    steps.push({ step: 'select', result: 'no verified deterministic path' });
    return finish({ status: 'needs_model', reason: 'No verified path handles this goal yet. The model was not called, so no answer is given.' });
  }
  const cap = serving(registry, ARITHMETIC_ID);
  steps.push({ step: 'select', capability: ARITHMETIC_ID, version: cap?.version ?? null, result: cap ? 'verified capability' : 'none served' });
  if (!cap) return finish({ status: 'needs_model', reason: 'The arithmetic capability is not verified, so it was not used.' });

  let exact;
  try {
    exact = evaluate(route.expression, EXACT);
  } catch (err) {
    // An undefined or malformed problem is a correct answer, so it does not count against the capability's record.
    steps.push({ step: 'exact', result: err.code });
    return finish({ status: 'error', expression: route.expression, error: err.code, capability_id: ARITHMETIC_ID, capability_version: cap.version });
  }
  steps.push({ step: 'exact', result: formatExact(exact) });
  const approx = evaluate(route.expression, FLOAT);
  const agrees = Number.isFinite(approx) && Number.isFinite(EXACT.toNumber(exact))
    && Math.abs(EXACT.toNumber(exact) - approx) <= TOLERANCE * Math.max(1, Math.abs(approx));
  steps.push({ step: 'float_cross_check', result: agrees ? 'agrees' : 'disagrees' });
  recordUse(registry, ARITHMETIC_ID, agrees, now);
  return finish({
    status: agrees ? 'verified' : 'unverified',
    expression: route.expression,
    result: formatExact(exact),
    capability_id: ARITHMETIC_ID,
    capability_version: cap.version,
  });
}
