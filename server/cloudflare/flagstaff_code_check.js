// Syntax guard for code CHE sends in Flagstaff replies. JavaScript regex literals
// accept only the flags d g i m s u v y. The verbose x flag from other languages is
// a syntax error, so a reply that uses it would not load. Only fenced code blocks are
// checked, so ordinary prose is never flagged.
const JS_REGEX_FLAGS = new Set(['d', 'g', 'i', 'm', 's', 'u', 'v', 'y']);
const CODE_BLOCK = /```(?:js|javascript)?\n([\s\S]*?)```/g;
// A regex literal starts where an operator or opening punctuation comes before it, so
// division such as total / count is never read as a regex.
const REGEX_LITERAL = /(^|[=(,:[!&|?{};]|\breturn)\s*\/((?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^\/\\\[\n])+)\/([a-z]*)/gm;
// A verbose regex split over several lines closes with /x at the end of a line.
const VERBOSE_CLOSE = /[$\])*+?]\/[a-z]*x[a-z]*\s*[;,)]?\s*$/gm;

export function jsRegexFlagProblems(text) {
  const problems = new Set();
  for (const block of String(text || '').matchAll(CODE_BLOCK)) {
    const code = block[1];
    for (const literal of code.matchAll(REGEX_LITERAL)) {
      const bad = [...literal[3]].filter((flag) => !JS_REGEX_FLAGS.has(flag));
      if (bad.length) problems.add(`regex flag ${bad.join(', ')} does not exist in JavaScript`);
    }
    if (VERBOSE_CLOSE.test(code)) problems.add('a multi-line regex ends with /x, the verbose flag JavaScript does not have');
    VERBOSE_CLOSE.lastIndex = 0;
  }
  return [...problems];
}
