// Manifestation Engine: seeded sampling, summaries and solvers shared by the domain models.
// Randomness is the Simulation Lab's seeded generator (sim_lab.js), so a run with the same seed repeats exactly.
import { rngFrom, seedOf } from './sim_lab.js';

export { rngFrom, seedOf };

/** Triangular distribution sample (lo ≤ mode ≤ hi) by inverse CDF. */
export function triangular(rng, lo, mode, hi) {
  if (!(hi > lo)) return lo;
  const m = Math.min(hi, Math.max(lo, mode ?? (lo + hi) / 2));
  const u = rng();
  const f = (m - lo) / (hi - lo);
  return u < f ? lo + Math.sqrt(u * (hi - lo) * (m - lo)) : hi - Math.sqrt((1 - u) * (hi - lo) * (hi - m));
}

/** Linear-interpolated quantile of a sorted array (type 7, as R and NumPy default). */
export function quantile(sorted, p) {
  if (!sorted.length) return NaN;
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

export const round = (n, d = 4) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : n);

/** Mean, standard deviation, standard error and percentiles of finite values; non-finite values are counted apart. */
export function summarize(values) {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  const n = finite.length;
  const mean = n ? finite.reduce((s, v) => s + v, 0) / n : NaN;
  const sd = n > 1 ? Math.sqrt(finite.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) : 0;
  return {
    n, non_finite: values.length - n,
    mean: round(mean), sd: round(sd), se: round(n ? sd / Math.sqrt(n) : NaN),
    min: round(finite[0]), p5: round(quantile(finite, 0.05)), p10: round(quantile(finite, 0.1)), p50: round(quantile(finite, 0.5)),
    p90: round(quantile(finite, 0.9)), p95: round(quantile(finite, 0.95)), max: round(finite[n - 1]),
  };
}

/** Root of f(x) = target on [lo, hi] by bisection, or null when the bracket holds no sign change. */
export function bisect(f, target, lo, hi, { tol = 1e-9, iterations = 200 } = {}) {
  let a = lo;
  let b = hi;
  let fa = f(a) - target;
  const fb = f(b) - target;
  if (!Number.isFinite(fa) || !Number.isFinite(fb) || fa * fb > 0) return null;
  for (let i = 0; i < iterations; i += 1) {
    const m = (a + b) / 2;
    const fm = f(m) - target;
    if (Math.abs(fm) < tol || (b - a) / 2 < tol * Math.max(1, Math.abs(m))) return m;
    if (fa * fm < 0) b = m; else { a = m; fa = fm; }
  }
  return (a + b) / 2;
}

/** Maximum of a unimodal f on [lo, hi] by golden-section search. */
export function goldenMax(f, lo, hi, { tol = 1e-7, iterations = 200 } = {}) {
  const r = (Math.sqrt(5) - 1) / 2;
  let a = lo;
  let b = hi;
  let c = b - r * (b - a);
  let d = a + r * (b - a);
  for (let i = 0; i < iterations && Math.abs(b - a) > tol * Math.max(1, Math.abs(a) + Math.abs(b)); i += 1) {
    if (f(c) > f(d)) b = d; else a = c;
    c = b - r * (b - a);
    d = a + r * (b - a);
  }
  return (a + b) / 2;
}
