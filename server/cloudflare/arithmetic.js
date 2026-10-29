// CHE exact arithmetic (owner, 2026-10-28). One evaluator for the chat route (plainArithmetic) and for checking the
// equations in a reply (checkEquations, used by numeric_truth.js). Numbers are exact rationals (BigInt), so 0.1 + 0.2 is
// exactly 0.3 and a long product is never rounded. Supports + - * / ^ (integer powers), parentheses, decimals,
// thousands separators, percentages ("15% of 80") and the words the owner uses. Anything else is refused, not guessed.
// Pure: no storage, no model call, no network.

export class ArithmeticError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArithmeticError';
  }
}

const gcd = (a, b) => {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y) [x, y] = [y, x % y];
  return x;
};

function rat(n, d = 1n) {
  if (d === 0n) throw new ArithmeticError('Division by zero has no answer, sir.');
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n, d) || 1n;
  return { n: n / g, d: d / g };
}

const add = (a, b) => rat(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a, b) => rat(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a, b) => rat(a.n * b.n, a.d * b.d);
const div = (a, b) => {
  if (b.n === 0n) throw new ArithmeticError('Division by zero has no answer, sir.');
  return rat(a.n * b.d, a.d * b.n);
};
const pow = (a, e) => {
  if (e.d !== 1n || e.n > 64n || e.n < -64n) throw new ArithmeticError('Only whole-number powers up to 64 are worked out.');
  const k = Number(e.n);
  const base = k < 0 ? div(rat(1n), a) : a;
  let out = rat(1n);
  for (let i = 0; i < Math.abs(k); i += 1) out = mul(out, base);
  return out;
};
const same = (a, b) => a.n * b.d === b.n * a.d;

/** Exact rational from a plain decimal string ("1,000", "-2.5"). Throws when it is not one. */
export function parseDecimal(text) {
  const m = /^\s*(-)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*$/.exec(String(text));
  if (!m) throw new ArithmeticError(`"${text}" is not a plain number.`);
  const whole = m[2].replace(/,/g, '');
  const frac = m[3] || '';
  const n = BigInt(whole + frac) * (m[1] ? -1n : 1n);
  return rat(n, 10n ** BigInt(frac.length));
}

/** Plain decimal text for an exact rational: an exact decimal when it has one, else up to 10 places. */
export function formatRational(r) {
  const neg = r.n < 0n;
  const abs = neg ? -r.n : r.n;
  const whole = abs / r.d;
  let rem = abs % r.d;
  let frac = '';
  for (let i = 0; i < 10 && rem !== 0n; i += 1) {
    rem *= 10n;
    frac += (rem / r.d).toString();
    rem %= r.d;
  }
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg && (whole || frac) ? '-' : ''}${grouped}${frac ? `.${frac}` : ''}`;
}

// Words the owner uses for operators, turned into symbols before reading. Only applied where a number is on each side.
const WORDS = [
  [/\bmultiplied\s+by\b/gi, '*'], [/\bdivided\s+by\b/gi, '/'], [/\btimes\b/gi, '*'], [/\bplus\b/gi, '+'], [/\bminus\b/gi, '-'],
  [/\bto\s+the\s+power\s+of\b/gi, '^'], [/\bpercent\b/gi, '%'],
];

/** Symbols only: × ÷ − x between numbers, thousands commas. Used for equations inside a sentence. */
export function symbols(text) {
  let s = String(text || '').replace(/[−–]/g, '-').replace(/[×·]/g, '*').replace(/÷/g, '/');
  s = s.replace(/(\d)\s*[xX]\s*(?=[\d(])/g, '$1*');
  s = s.replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
  return s;
}

/** Symbols plus the owner's words ("12 times 17", "7 divided by 2") and "P% of N". */
export function normalizeExpression(text) {
  let s = symbols(text);
  for (const [pattern, replacement] of WORDS) s = s.replace(pattern, replacement);
  s = s.replace(/%\s*of\b/gi, '%*');
  return s.trim();
}

const TOKEN = /\d+(?:\.\d+)?|\.\d+|[-+*/^()%]/y;

function tokenize(s) {
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i])) { i += 1; continue; }
    TOKEN.lastIndex = i;
    const m = TOKEN.exec(s);
    if (!m) throw new ArithmeticError('This has words or symbols I cannot work out.');
    tokens.push(m[0]);
    i = TOKEN.lastIndex;
  }
  return tokens;
}

/** Evaluates an arithmetic expression exactly. Throws ArithmeticError when it cannot. */
export function evaluate(text) {
  const tokens = tokenize(normalizeExpression(text));
  let pos = 0;
  const peek = () => tokens[pos];
  const take = () => tokens[pos++];
  const expect = (t) => { if (take() !== t) throw new ArithmeticError('The brackets or operators do not line up.'); };

  function primary() {
    const t = take();
    if (t === undefined) throw new ArithmeticError('The sum is unfinished.');
    if (t === '(') { const v = expr(); expect(')'); return v; }
    if (!/^[\d.]/.test(t)) throw new ArithmeticError('A number is missing.');
    let v = parseDecimal(t);
    if (peek() === '%') { take(); v = div(v, rat(100n)); }
    return v;
  }
  // School precedence: a leading minus is applied after the power, so -2^2 is -(2^2) = -4. The exponent may carry its
  // own sign (2^-1 = 1/2) and powers are right-associative (2^3^2 = 2^9).
  function unary() {
    if (peek() === '-') { take(); return mul(rat(-1n), unary()); }
    if (peek() === '+') { take(); return unary(); }
    return power();
  }
  function power() {
    const base = primary();
    if (peek() === '^') { take(); return pow(base, unary()); }
    return base;
  }
  function term() {
    let v = unary();
    while (peek() === '*' || peek() === '/') v = take() === '*' ? mul(v, unary()) : div(v, unary());
    return v;
  }
  function expr() {
    let v = term();
    while (peek() === '+' || peek() === '-') v = take() === '+' ? add(v, term()) : sub(v, term());
    return v;
  }

  if (!tokens.length) throw new ArithmeticError('There is nothing to work out.');
  const value = expr();
  if (pos !== tokens.length) throw new ArithmeticError('The sum has an extra part I cannot read.');
  return value;
}

const QUESTION_LEAD = /^\s*(?:(?:chay|chey|shay|che)[, ]+)?(?:please[, ]+)?(?:(?:what\s+is|what's|whats|calculate|compute|solve|work\s+out|how\s+much\s+is|what\s+does)\s+)?/i;
const QUESTION_TAIL = /\s*(?:equal|equals|make|makes|come\s+to)?\s*[?.!]*\s*$/i;

/**
 * A question that is only a sum ("what is 12 times 17?", "15% of 80", "(3 + 4) * 5 - 2"). Returns null for anything else,
 * so a sentence about maths goes the usual way. The result is computed, never recalled.
 */
export function plainArithmetic(message) {
  const raw = String(message || '');
  const body = raw.replace(QUESTION_LEAD, '').replace(QUESTION_TAIL, '');
  if (!body || body === raw.trim()) {
    if (!QUESTION_LEAD.test(raw) && !/\d/.test(raw)) return null;
  }
  const normalized = normalizeExpression(body);
  // Only numbers and operator symbols may remain; any word means this is not a bare sum.
  if (!/^[\d\s.+\-*/^()%,]+$/.test(normalized) || !/[-+*/^%]/.test(normalized)) return null;
  try {
    const value = evaluate(normalized);
    return { expression: symbolsForShow(normalized), result: formatRational(value) };
  } catch (error) {
    // Only a sum that is well-formed but cannot be answered (division by zero, a huge power) is said so. An unfinished
    // or unreadable one goes the usual way, as a sentence about maths does.
    if (error instanceof ArithmeticError && /Division by zero|Only whole-number powers/.test(error.message)) {
      return { expression: symbolsForShow(normalized), error: error.message };
    }
    if (error instanceof ArithmeticError) return null;
    throw error;
  }
}

function symbolsForShow(s) {
  return s.replace(/\*/g, ' × ').replace(/\//g, ' ÷ ').replace(/(\d)\s*-\s*(?=[\d(])/g, '$1 − ').replace(/\s+\+\s+/g, ' + ').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Every "expression = number" in a sentence, checked exactly. A correct equation is 'verified'; a wrong one is
 * 'contradicted' with the exact answer. Only equations with an operator and a number on each side are read.
 */
export function checkEquations(text = '') {
  const s = symbols(text);
  const out = [];
  for (let i = s.indexOf('='); i !== -1; i = s.indexOf('=', i + 1)) {
    const before = s.slice(0, i);
    const left = /[-+*/^()%\d.,\s]+$/.exec(before);
    const right = /^\s*(-?\d[\d,]*(?:\.\d+)?)/.exec(s.slice(i + 1));
    if (!left || !right) continue;
    const lhsText = left[0].trim();
    if (!/\d/.test(lhsText) || !/[-+*/^]/.test(lhsText.replace(/^-/, ''))) continue;
    let lhs;
    let rhs;
    try {
      lhs = evaluate(lhsText);
      rhs = parseDecimal(right[1]);
    } catch (_) {
      continue;
    }
    const shown = symbolsForShow(normalizeExpression(lhsText));
    out.push(same(lhs, rhs)
      ? { kind: 'equation', key: shown, status: 'verified', value: formatRational(lhs), note: `${shown} = ${formatRational(lhs)}.` }
      : { kind: 'equation', key: shown, status: 'contradicted', value: formatRational(lhs), claimed: right[1], note: `${shown} = ${formatRational(lhs)}, not ${right[1]}.` });
  }
  return out;
}
