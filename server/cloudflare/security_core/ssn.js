// Security Core: Social Security number guard. Portable: no imports from any product module.
//
// Owner rule (2026-10-25, Privacy Center stage 5): CHE never stores a full SSN in memory, logs, prompts,
// analytics, the Brain or the mailbox. This finds one in text so every write path can remove it first.
// Mirrored on the phone in lib/security/che_ssn_guard.dart (the phone removes it before text leaves the device;
// this is the Worker's defense in depth).
//
// What counts as an SSN:
//   - "123-45-6789": the dashed 3-2-4 shape, when the number is a valid SSN (area not 000, 666 or 900-999;
//     group not 00; serial not 0000). No context word is needed for this shape.
//   - nine digits written any other way ("123 45 6789", "123456789", "one two three four five six seven eight
//     nine", "1 2 3 dash 4 5 ...") when an SSN word is near: SSN, social security, my social, SS#, ITIN.
// What does not: phone numbers (ten digits, or the 3-3-4 shape), the last four digits alone, order numbers and
// other nine-digit numbers with no SSN word near them.

export const SSN_REDACTION = '[SSN removed]';

const DIGIT_WORDS = { zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };
const SEPARATOR_WORDS = new Set(['dash', 'hyphen']);
const CONTEXT = /\bsocial\s+security\b|\bsocial\s*(?:#|no\b|num(?:ber)?\b)|\bmy\s+social(?=\s*(?:is\b|was\b|number\b|no\b|#|:|,|$|\d|zero\b|one\b|two\b|three\b|four\b|five\b|six\b|seven\b|eight\b|nine\b))|\bssn\b|\bs\.\s?s\.\s?n\b|\bss\s*(?:#|no\b|number\b)|\bitin\b|\btaxpayer\s+id(?:entification)?\b/i;
const DASHED = /(?<![\d-])(\d{3})-(\d{2})-(\d{4})(?![\d]|-\d)/g;

/** True when the dashed number is shaped like a real SSN (SSA's never-issued ranges excluded). */
export function validSsnDigits(digits) {
  const d = String(digits || '');
  if (!/^\d{9}$/.test(d)) return false;
  const area = d.slice(0, 3);
  return area !== '000' && area !== '666' && area[0] !== '9' && d.slice(3, 5) !== '00' && d.slice(5) !== '0000';
}

function hasContext(text, start, end) {
  return CONTEXT.test(text.slice(Math.max(0, start - 80), start)) || CONTEXT.test(text.slice(end, end + 40));
}

// Runs of digits and spoken digit words joined by spaces, dashes, dots or commas.
function digitRuns(text) {
  const runs = [];
  let run = null;
  let lastEnd = 0;
  const close = () => { if (run && run.digits) runs.push(run); run = null; };
  for (const m of text.matchAll(/\d+|[A-Za-z]+/g)) {
    const token = m[0];
    const lower = token.toLowerCase();
    const isNumber = /^\d+$/.test(token);
    const word = DIGIT_WORDS[lower];
    const joins = run && /^[\s.,–-]{0,3}$/.test(text.slice(lastEnd, m.index));
    if (!joins) close();
    if (isNumber || (word && (lower !== 'oh' || run))) {
      if (!run) run = { start: m.index, end: m.index, digits: '' };
      run.digits += isNumber ? token : word;
      run.end = m.index + token.length;
      lastEnd = run.end;
    } else if (run && SEPARATOR_WORDS.has(lower)) {
      lastEnd = m.index + token.length;
    } else {
      close();
    }
  }
  close();
  return runs;
}

/** Every SSN in the text: { index, length }. Never the value. */
export function findSsns(value) {
  const text = String(value ?? '');
  if (!/\d|zero|one|two|three|four|five|six|seven|eight|nine/i.test(text)) return [];
  const found = [];
  for (const m of text.matchAll(DASHED)) {
    if (validSsnDigits(m[1] + m[2] + m[3]) || hasContext(text, m.index, m.index + m[0].length)) found.push({ index: m.index, length: m[0].length });
  }
  for (const run of digitRuns(text)) {
    if (run.digits.length !== 9) continue;
    if (found.some((f) => run.start < f.index + f.length && f.index < run.end)) continue;
    if (hasContext(text, run.start, run.end)) found.push({ index: run.start, length: run.end - run.start });
  }
  return found.sort((a, b) => a.index - b.index);
}

export function containsSsn(value) {
  return findSsns(value).length > 0;
}

/** The text with every SSN replaced by [SSN removed]; `count` is how many were removed. */
export function redactSsn(value) {
  const text = String(value ?? '');
  const found = findSsns(text);
  if (!found.length) return { text, count: 0 };
  let out = '';
  let at = 0;
  for (const f of found) {
    if (f.index < at) continue;
    out += text.slice(at, f.index) + SSN_REDACTION;
    at = f.index + f.length;
  }
  return { text: out + text.slice(at), count: found.length };
}

/** Deep SSN removal over a JSON-like value. Long strings (attachments) and data: URIs are left alone. */
export function redactSsnDeep(value, counter = { count: 0 }) {
  if (typeof value === 'string') {
    if (value.length > 50000 || value.startsWith('data:')) return value;
    const r = redactSsn(value);
    counter.count += r.count;
    return r.text;
  }
  if (Array.isArray(value)) return value.map((v) => redactSsnDeep(v, counter));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactSsnDeep(v, counter);
    return out;
  }
  return value;
}
