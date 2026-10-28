// Plain arithmetic answered by computation, not by a model (owner, 2026-10-28: "CHE, what is 12 times 17?" must give 204).
// Only one binary operation between two plain numbers is read. Anything else returns null and goes the usual way.
// Pure: no storage, no model call, no network.

const OPS = [
  { op: '*', words: /^(?:times|x|×|\*|multiplied\s+by)$/i },
  { op: '/', words: /^(?:divided\s+by|over|÷|\/)$/i },
  { op: '+', words: /^(?:plus|add|\+)$/i },
  { op: '-', words: /^(?:minus|subtract|−|-)$/i },
];

const NUMBER = '[-+]?\\d+(?:\\.\\d+)?|\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?';
const OP_TEXT = 'times|multiplied\\s+by|divided\\s+by|plus|minus|subtract|add|over|x|×|÷|\\*|\\/|\\+|−|-';
const QUESTION = '(?:what\\s+is|what\'s|whats|calculate|compute|solve|work\\s+out|how\\s+much\\s+is|what\\s+does)';
const TAIL = '(?:\\s+(?:equal|equals|make|makes|come\\s+to))?';
const ARITHMETIC = new RegExp(
  `^\\s*(?:(?:chay|chey|shay|che)[, ]+)?(?:please[, ]+)?(?:${QUESTION}\\s+)?(${NUMBER})\\s*(${OP_TEXT})\\s*(${NUMBER})${TAIL}\\s*[?.!]*\\s*$`,
  'i',
);

function toNumber(text) {
  return Number(String(text).replace(/,/g, ''));
}

function opFor(word) {
  const cleaned = String(word).trim();
  const found = OPS.find((entry) => entry.words.test(cleaned));
  return found ? found.op : '';
}

/** Returns { expression, result } for a plain one-operation question, or null. */
export function plainArithmetic(message) {
  const match = ARITHMETIC.exec(String(message || ''));
  if (!match) return null;
  const left = toNumber(match[1]);
  const right = toNumber(match[3]);
  const op = opFor(match[2]);
  if (!op || !Number.isFinite(left) || !Number.isFinite(right)) return null;
  if (op === '/' && right === 0) return { expression: `${match[1]} / ${match[3]}`, error: 'Division by zero has no answer, sir.' };
  const raw = op === '*' ? left * right : op === '/' ? left / right : op === '+' ? left + right : left - right;
  // Round away float noise (0.1 + 0.2) without changing a real answer.
  const result = Number(raw.toPrecision(15));
  const shown = op === '*' ? '×' : op === '/' ? '÷' : op === '+' ? '+' : '−';
  return { expression: `${match[1]} ${shown} ${match[3]}`, result: result.toLocaleString('en-US', { maximumFractionDigits: 10 }) };
}
