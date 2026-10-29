// CHE numeric truth: deterministic arithmetic for the numbers in a reply.
//
// A language model states numbers from memory, and an order-of-magnitude error (stars in the observable universe,
// light-years in kilometres, a travel time) reads as fluent prose. This module checks what can be checked by
// arithmetic, with exact definitions (the speed of light and the light-year are defined exactly by the SI and IAU),
// and checks the rest against reference ranges that are labelled as estimates. It never looks anything up and never
// invents a source: a number it cannot check is "unverified", not "true".
//
// Statuses: verified (arithmetic agrees), estimate (inside a commonly cited range), doubtful (outside the range but
// not absurd), contradicted (arithmetic disagrees, or far outside the range). Corrections are appended beside the
// reply by the numeric_check stage in truth_pipeline.js; the owner's text is never silently rewritten.

import { checkEquations } from './arithmetic.js';

export const C_M_PER_S = 299792458; // exact (SI definition of the metre)
const JULIAN_YEAR_S = 31557600; // 365.25 days
export const LIGHT_YEAR_M = C_M_PER_S * JULIAN_YEAR_S; // 9.4607e15 m, the light-year used by the IAU

const UNITS = {
  m: ['length', 1],
  km: ['length', 1e3],
  mi: ['length', 1609.344],
  au: ['length', 149597870700], // exact (IAU 2012)
  pc: ['length', 3.0856775814913673e16],
  ly: ['length', LIGHT_YEAR_M],
  'light-second': ['length', C_M_PER_S],
  'light-minute': ['length', 60 * C_M_PER_S],
  'light-hour': ['length', 3600 * C_M_PER_S],
  'm/s': ['speed', 1],
  'km/s': ['speed', 1e3],
  c: ['speed', C_M_PER_S],
  s: ['time', 1],
  min: ['time', 60],
  h: ['time', 3600],
  day: ['time', 86400],
  yr: ['time', JULIAN_YEAR_S],
  kg: ['mass', 1],
  msun: ['mass', 1.98847e30],
};
const COUNT_UNITS = new Set(['stars', 'galaxies', 'atoms']);
const MAGNITUDE = { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12, quadrillion: 1e15, quintillion: 1e18, sextillion: 1e21, septillion: 1e24, octillion: 1e27 };

// Commonly cited ranges. These are estimates from the literature, not measured counts, and each carries its label.
// `doubt` is the wider band outside which a figure is contradicted rather than merely doubtful.
export const REFERENCE_ESTIMATES = Object.freeze([
  { key: 'stars in the observable universe', unit: 'stars', test: (s) => /\bstars?\b/i.test(s) && /observable universe/i.test(s), low: 1e22, high: 1e24, doubt: [1e21, 1e25], label: 'commonly cited estimate of 10^22 to 10^24 stars; not a measured count' },
  { key: 'galaxies in the observable universe', unit: 'galaxies', test: (s) => /\bgalax(?:y|ies)\b/i.test(s) && /observable universe/i.test(s), low: 1e11, high: 2e12, doubt: [1e10, 2e13], label: 'commonly cited estimate of about 10^11 to 2 × 10^12 galaxies; not a measured count' },
  { key: 'atoms in the observable universe', unit: 'atoms', test: (s) => /\batoms?\b/i.test(s) && /observable universe/i.test(s), low: 1e78, high: 1e82, doubt: [1e77, 1e83], label: 'commonly cited estimate of 10^78 to 10^82 atoms; an order-of-magnitude estimate' },
]);

const UNIT_PATTERN = 'light[- ]?(?:years?|seconds?|minutes?|hours?)|kilomet(?:er|re)s?(?: (?:per|a) second)?|km(?: per second|\\/s)?|km|metres?|meters?|miles?|mi|astronomical units?|au|parsecs?|pc|ly|m\\/s|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|years?|yrs?|kg|kilograms?|solar masses?|stars?|galax(?:y|ies)|atoms?';
const QTY_RE = new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?(?:e[+-]?\\d+)?)(?:\\s+(${Object.keys(MAGNITUDE).join('|')}))?\\s*(${UNIT_PATTERN})?(?![a-z])`, 'gi');
const SENTENCE_SPLIT = /(?<=[.!?])\s+|\n+/;
const EQUALS_GAP = /^(?:is|are|=|equals|≈|is about|is roughly|is approximately|is around|is close to)$/i;
const TRAVEL_CUE = /\b(?:takes?|taking|needs?|arrives?|reach(?:es)?|travel(?:s|ling|ing)? (?:for|in))\b/i;
const IMPLIED_LIGHT = /(?<![\w-])light(?![\w-])|speed of light/i;

export function canonUnit(raw) {
  const r = String(raw || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (/^light[- ]?second/.test(r)) return 'light-second';
  if (/^light[- ]?minute/.test(r)) return 'light-minute';
  if (/^light[- ]?hour/.test(r)) return 'light-hour';
  if (/^light[- ]?year/.test(r) || r === 'ly') return 'ly';
  if (/^(?:km\/s|km per second|kilomet(?:er|re)s? (?:per|a) second)$/.test(r)) return 'km/s';
  if (/^(?:m\/s|metres? per second|meters? per second)$/.test(r)) return 'm/s';
  if (/^(?:km|kilomet(?:er|re)s?)$/.test(r)) return 'km';
  if (/^(?:metres?|meters?)$/.test(r)) return 'm';
  if (/^(?:miles?|mi)$/.test(r)) return 'mi';
  if (/^(?:au|astronomical units?)$/.test(r)) return 'au';
  if (/^(?:parsecs?|pc)$/.test(r)) return 'pc';
  if (/^(?:seconds?|secs?)$/.test(r)) return 's';
  if (/^(?:minutes?|mins?)$/.test(r)) return 'min';
  if (/^(?:hours?|hrs?)$/.test(r)) return 'h';
  if (/^days?$/.test(r)) return 'day';
  if (/^(?:years?|yrs?)$/.test(r)) return 'yr';
  if (/^(?:kg|kilograms?)$/.test(r)) return 'kg';
  if (/^solar masses?$/.test(r)) return 'msun';
  if (/^stars?$/.test(r)) return 'stars';
  if (/^galax/.test(r)) return 'galaxies';
  if (/^atoms?$/.test(r)) return 'atoms';
  return null;
}

const dimOf = (unit) => (UNITS[unit] ? UNITS[unit][0] : COUNT_UNITS.has(unit) ? 'count' : null);
const siOf = (unit) => (UNITS[unit] ? UNITS[unit][1] : 1);

// Scientific notation written as "10^22", "× 10^22" or "x 10^22" becomes "1e22" before parsing.
function normalizeNumbers(text) {
  return String(text || '')
    .replace(/(\d+(?:\.\d+)?)\s*(?:×|x|\*)\s*10\s*\^\s*\(?(-?\d+)\)?/gi, '$1e$2')
    .replace(/\b10\s*\^\s*\(?(-?\d+)\)?/g, '1e$1');
}

/** Every number with its unit, if it has one. `index` points into the normalized text. */
export function quantitiesIn(text = '') {
  const src = normalizeNumbers(text);
  const out = [];
  for (const m of src.matchAll(QTY_RE)) {
    const value = Number(m[1].replace(/,/g, '')) * (m[2] ? MAGNITUDE[m[2].toLowerCase()] : 1);
    if (!Number.isFinite(value)) continue;
    const unit = m[3] ? canonUnit(m[3]) : null;
    out.push({ value, unit, dim: dimOf(unit), index: m.index, end: m.index + m[0].length, raw: m[0].trim() });
  }
  return out;
}

/** Plain formatting for an owner-facing note: small numbers in full, large ones as a power of ten. */
export function formatNumber(n) {
  if (!Number.isFinite(n)) return 'not a finite number';
  const abs = Math.abs(n);
  if (abs === 0) return '0';
  if (abs >= 1e6 || abs < 1e-3) {
    const exp = Math.floor(Math.log10(abs));
    return `${(n / 10 ** exp).toPrecision(3)} × 10^${exp}`;
  }
  return n.toLocaleString('en-US', { maximumFractionDigits: 3 });
}

const relErr = (claimed, expected) => Math.abs(claimed - expected) / Math.abs(expected);

function checkConversion(sentence, qs) {
  const src = normalizeNumbers(sentence);
  const claims = [];
  for (let i = 0; i < qs.length - 1; i += 1) {
    const [a, b] = [qs[i], qs[i + 1]];
    if (!a.unit || !b.unit) continue;
    const gap = src.slice(a.end, b.index).trim().toLowerCase();
    if (!EQUALS_GAP.test(gap)) continue;
    if (a.dim !== b.dim) {
      if (a.value === 1 && a.dim !== 'count' && b.dim !== 'count') {
        claims.push({ kind: 'unit_mismatch', status: 'contradicted', sentence, claimed: b.raw, unit: b.unit, expected: null, note: `${a.raw} is a ${a.dim}, so it cannot equal ${b.raw} (a ${b.dim}).` });
      }
      continue;
    }
    if (a.dim === 'count') continue;
    const expected = (a.value * siOf(a.unit)) / siOf(b.unit);
    const status = relErr(b.value, expected) <= 0.03 ? 'verified' : 'contradicted';
    claims.push({ kind: 'conversion', status, sentence, claimed: b.value, unit: b.unit, expected,
      note: status === 'verified' ? `${a.raw} is ${formatNumber(expected)} ${b.unit}, which agrees.` : `${a.raw} is ${formatNumber(expected)} ${b.unit}, not ${b.raw}.` });
  }
  return claims;
}

function checkTravel(sentence, qs) {
  if (!TRAVEL_CUE.test(sentence)) return [];
  const lengths = qs.filter((q) => q.dim === 'length');
  const speeds = qs.filter((q) => q.dim === 'speed');
  const times = qs.filter((q) => q.dim === 'time');
  if (lengths.length !== 1 || times.length !== 1) return [];
  let speedSi = null;
  let speedLabel = '';
  if (speeds.length === 1) {
    speedSi = speeds[0].value * siOf(speeds[0].unit);
    speedLabel = speeds[0].raw;
  } else if (speeds.length === 0 && IMPLIED_LIGHT.test(sentence)) {
    speedSi = C_M_PER_S;
    speedLabel = 'the speed of light';
  } else {
    return [];
  }
  const [L, T] = [lengths[0], times[0]];
  const expectedSeconds = (L.value * siOf(L.unit)) / speedSi;
  const expected = expectedSeconds / siOf(T.unit);
  const status = relErr(T.value, expected) <= 0.05 ? 'verified' : 'contradicted';
  return [{ kind: 'travel_time', status, sentence, claimed: T.value, unit: T.unit, expected,
    note: status === 'verified' ? `${L.raw} at ${speedLabel} takes ${formatNumber(expected)} ${T.unit}, which agrees.` : `${L.raw} at ${speedLabel} takes about ${formatNumber(expected)} ${T.unit}, not ${T.raw}.` }];
}

function checkConstant(sentence, qs) {
  if (!/speed of light/i.test(sentence)) return [];
  const speed = qs.find((q) => q.dim === 'speed');
  if (!speed) return [];
  const expected = C_M_PER_S / siOf(speed.unit);
  const status = relErr(speed.value, expected) <= 0.01 ? 'verified' : 'contradicted';
  return [{ kind: 'constant', status, sentence, claimed: speed.value, unit: speed.unit, expected,
    note: status === 'verified' ? `The speed of light is ${formatNumber(expected)} ${speed.unit}, which agrees.` : `The speed of light is ${formatNumber(expected)} ${speed.unit}, not ${speed.raw}.` }];
}

function checkReference(sentence) {
  const found = [];
  for (const ref of REFERENCE_ESTIMATES) {
    if (!ref.test(sentence)) continue;
    const count = quantitiesIn(sentence).find((q) => q.unit === ref.unit);
    if (!count) continue;
    const v = count.value;
    let status = 'contradicted';
    if (v >= ref.low && v <= ref.high) status = 'estimate';
    else if (v >= ref.doubt[0] && v <= ref.doubt[1]) status = 'doubtful';
    const shown = `${formatNumber(v)} ${ref.unit}`;
    found.push({ kind: 'reference', status, sentence, claimed: count.raw, unit: ref.unit, expected: null, key: ref.key, value: v,
      note: status === 'estimate'
        ? `${shown} is inside the ${ref.label} (${ref.key}).`
        : `${shown} is outside the ${ref.label} (${ref.key}).` });
  }
  return found;
}

/**
 * Check every numeric claim in a reply. Returns { claims } with one entry per checked figure. Sentences that carry no
 * unit, no reference subject and no equality are ignored, so ordinary numbers never produce a note.
 */
export function checkNumericClaims(text = '') {
  const claims = [];
  for (const sentence of String(text || '').split(SENTENCE_SPLIT)) {
    if (!sentence.trim()) continue;
    const qs = quantitiesIn(sentence);
    claims.push(...checkConversion(sentence, qs), ...checkTravel(sentence, qs), ...checkConstant(sentence, qs), ...checkReference(sentence), ...checkEquations(sentence));
  }
  // Internal consistency: the same reference subject stated twice with figures more than 2x apart.
  const seen = new Map();
  for (const claim of claims) {
    if (claim.kind !== 'reference') continue;
    const first = seen.get(claim.key);
    if (first === undefined) { seen.set(claim.key, claim.value); continue; }
    const ratio = Math.max(first, claim.value) / Math.min(first, claim.value);
    if (ratio > 2) {
      claim.status = 'contradicted';
      claim.note = `${formatNumber(claim.value)} ${claim.unit} disagrees with the ${formatNumber(first)} ${claim.unit} this reply gives earlier for ${claim.key}.`;
    }
  }
  return { claims };
}

/** The owner-facing notes for every non-verified figure, at most three. Empty when everything checked out. */
export function numericNotes(text = '') {
  const flagged = checkNumericClaims(text).claims.filter((c) => c.status !== 'verified');
  if (!flagged.length) return '';
  const label = { contradicted: 'Correction (arithmetic, not memory)', estimate: 'Estimate', doubtful: 'Unverified' };
  return flagged.slice(0, 3).map((c) => `${label[c.status]}: ${c.note}`).join(' ');
}
