// Manifestation Engine: quantities with units, for dimensional checks of every model equation.
// A quantity is { v, d }: its value in SI base units (USD and item are treated as base units too) and
// its dimension exponents. Adding or comparing quantities with different dimensions throws, so an
// equation that is not dimensionally consistent cannot evaluate. Models run their fast numeric path for
// Monte Carlo and recompute the same equations here once per run (and in tests) to prove consistency.
// Pure, no storage, no model call.

export const BASE = Object.freeze(['m', 'kg', 's', 'USD', 'item']);

const dim = (o = {}) => Object.freeze(BASE.map((b) => o[b] || 0));
// Unit name → [scale to SI, dimension].
const UNITS = {
  1: [1, dim()],
  '': [1, dim()],
  m: [1, dim({ m: 1 })],
  km: [1000, dim({ m: 1 })],
  kg: [1, dim({ kg: 1 })],
  g: [0.001, dim({ kg: 1 })],
  s: [1, dim({ s: 1 })],
  min: [60, dim({ s: 1 })],
  h: [3600, dim({ s: 1 })],
  day: [86400, dim({ s: 1 })],
  week: [604800, dim({ s: 1 })],
  // An average Gregorian month (365.2425 / 12 days).
  month: [2629746, dim({ s: 1 })],
  N: [1, dim({ kg: 1, m: 1, s: -2 })],
  J: [1, dim({ kg: 1, m: 2, s: -2 })],
  Wh: [3600, dim({ kg: 1, m: 2, s: -2 })],
  kWh: [3.6e6, dim({ kg: 1, m: 2, s: -2 })],
  W: [1, dim({ kg: 1, m: 2, s: -3 })],
  kW: [1000, dim({ kg: 1, m: 2, s: -3 })],
  Pa: [1, dim({ kg: 1, m: -1, s: -2 })],
  USD: [1, dim({ USD: 1 })],
  item: [1, dim({ item: 1 })],
};

function parseUnit(unit) {
  const text = String(unit ?? '').trim();
  if (Object.hasOwn(UNITS, text)) return UNITS[text];
  // Products and quotients of known units with integer powers: "kg/m^3", "W/kg", "USD/item", "m^2".
  let scale = 1;
  const d = BASE.map(() => 0);
  const [num, ...dens] = text.split('/');
  const apply = (part, sign) => {
    for (const token of part.split(/[·*]/).map((t) => t.trim()).filter(Boolean)) {
      const m = /^([A-Za-z]+)(?:\^(-?\d+))?$/.exec(token);
      if (!m || !Object.hasOwn(UNITS, m[1])) throw new Error(`Unknown unit "${token}" in "${text}".`);
      const p = Number(m[2] || 1) * sign;
      const [s, du] = UNITS[m[1]];
      scale *= s ** p;
      du.forEach((e, i) => { d[i] += e * p; });
    }
  };
  if (num && num !== '1') apply(num, 1);
  for (const den of dens) apply(den, -1);
  return [scale, Object.freeze(d)];
}

/** A quantity from a value in the given unit. */
export function q(value, unit = '1') {
  const [scale, d] = parseUnit(unit);
  return { v: Number(value) * scale, d };
}

const same = (a, b) => a.d.every((e, i) => Math.abs(e - b.d[i]) < 1e-9);
const show = (d) => BASE.map((b, i) => (d[i] ? `${b}^${d[i]}` : '')).filter(Boolean).join(' ') || 'dimensionless';

export function add(a, b) {
  if (!same(a, b)) throw new Error(`Dimension mismatch: ${show(a.d)} + ${show(b.d)}`);
  return { v: a.v + b.v, d: a.d };
}
export function sub(a, b) {
  if (!same(a, b)) throw new Error(`Dimension mismatch: ${show(a.d)} - ${show(b.d)}`);
  return { v: a.v - b.v, d: a.d };
}
export const mul = (a, b) => ({ v: a.v * b.v, d: a.d.map((e, i) => e + b.d[i]) });
export const div = (a, b) => ({ v: a.v / b.v, d: a.d.map((e, i) => e - b.d[i]) });
export const pow = (a, p) => ({ v: a.v ** p, d: a.d.map((e) => e * p) });
export const sqrt = (a) => pow(a, 0.5);
export const scalar = (n) => q(n, '1');

/** The value of a quantity in a unit; throws when the dimensions differ. */
export function as(a, unit) {
  const [scale, d] = parseUnit(unit);
  if (!same(a, { d })) throw new Error(`Cannot express ${show(a.d)} in ${unit} (${show(d)})`);
  return a.v / scale;
}

/** True when the unit strings have the same dimension (for checking owner-reported outcomes). */
export function sameDimension(u1, u2) {
  try { return same({ d: parseUnit(u1)[1] }, { d: parseUnit(u2)[1] }); } catch (_) { return false; }
}

/** Converts a number between two units of the same dimension. */
export function convert(value, from, to) {
  return as(q(value, from), to);
}

export const describeDimension = (unit) => show(parseUnit(unit)[1]);
