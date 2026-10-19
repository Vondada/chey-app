// CHE Knowledge Atlas (owner issue #346, phase 1): concept cards for coding and trading,
// each from beginner to expert, with an analogy, the exact formula where one exists, a
// worked example that the tests run or recompute, a short quiz and links to related cards.
//
// The cards are static, curated teaching content: this module is their one source, and
// tool/dump_knowledge_atlas.mjs exports them for the phone (assets/atlas/). Answers are
// deterministic and never call a model. A topic with no card is said plainly, never made
// up. A trading card that cites statistics reads them from CHE's own records (the paper
// journal and the stored backtest, trading_evidence.js / trading_live.js); with no record
// it says "no recorded data yet". Lessons never act: nothing here reaches the trading
// desk, a broker or any other tool.

import { BRAIN_REGIONS, CheBrainStore, atlasFolder, contentHash, fnv1a32, learningRecords, normalizeRecord, recordLearning, resetLearning } from './brain_store.js';
import { queryTerms } from './library.js';
import { classifyOwnerActions } from './owner_action_gate.js';
import { CANDIDATES, COSTS, CONTRACTS, INTRADAY_CANDIDATES, MIN_TRADES, readTrades, summarize } from './trading_evidence.js';
import { MODE_NAME, readDesk } from './trading_desk.js';
import { evidenceIntent } from './trading_evidence_runner.js';
import { LIVE_BACKTEST } from './trading_live.js';

export const ATLAS_VERSION = 1;
export const LEVELS = Object.freeze(['beginner', 'intermediate', 'expert']);
export const DOMAINS = Object.freeze({ coding: 'Coding', trading: 'Trading' });
export const ATLAS_SOURCE = 'che_knowledge_atlas';

// A reference link is where the idea is taught; the card text is CHE's own words, so no
// text is copied. Links were not opened by CHE when the card was written.
const ref = (title, author, url = '') => Object.freeze({ title, author, url, license: 'reference link only; card text is original', text_scope: 'own-words summary' });
const CHE_CODE = (file) => ref(`CHE source: server/cloudflare/${file}`, 'CHE repository', '');

// ─── Formulas: one implementation each, recomputed by the tests ──────────

const ceilLog2 = (n) => { let k = 0; while (2 ** k < n) k += 1; return k; };
const floorLog2 = (n) => { let k = 0; while (2 ** (k + 1) <= n) k += 1; return k; };
const fibonacci = (k) => { let a = 0; let b = 1; for (let i = 0; i < k; i += 1) [a, b] = [b, a + b]; return a; };

export const FORMULAS = Object.freeze({
  triangular: ({ n }) => (n * (n + 1)) / 2,
  binarySearchWorst: ({ n }) => floorLog2(n) + 1,
  fibCalls: ({ n }) => 2 * fibonacci(n + 1) - 1,
  loadFactor: ({ n, m }) => n / m,
  mergeSortWorst: ({ n }) => n * ceilLog2(n) - 2 ** ceilLog2(n) + 1,
  amdahl: ({ p, n }) => 1 / ((1 - p) + p / n),
  spreadCost: ({ bid, ask, tick, tickValue, contracts }) => ((ask - bid) / tick) * tickValue * contracts,
  futuresPnl: ({ points, pointValue, contracts }) => points * pointValue * contracts,
  rMultiple: ({ entry, stop, exit, side = 'long' }) => (side === 'short' ? (entry - exit) / (stop - entry) : (exit - entry) / (entry - stop)),
  positionSize: ({ risk, stopPoints, pointValue }) => Math.floor(risk / (stopPoints * pointValue)),
  expectancy: ({ p, win, loss }) => p * win - (1 - p) * loss,
  wilson: ({ wins, n, z = 1.96 }) => {
    const p = wins / n;
    const d = 1 + (z * z) / n;
    const centre = (p + (z * z) / (2 * n)) / d;
    const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
    return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
  },
  profitFactor: ({ pnl }) => {
    const won = pnl.filter((x) => x > 0).reduce((s, x) => s + x, 0);
    const lost = -pnl.filter((x) => x < 0).reduce((s, x) => s + x, 0);
    return lost > 0 ? won / lost : null;
  },
  maxDrawdown: ({ pnl }) => {
    let equity = 0; let peak = 0; let worst = 0;
    for (const x of pnl) { equity += x; peak = Math.max(peak, equity); worst = Math.max(worst, peak - equity); }
    return worst;
  },
  vwap: ({ bars }) => bars.reduce((s, b) => s + ((b.h + b.l + b.c) / 3) * b.v, 0) / bars.reduce((s, b) => s + b.v, 0),
  meanCi: ({ mean, sd, n, z = 1.96 }) => ({ low: mean - (z * sd) / Math.sqrt(n), high: mean + (z * sd) / Math.sqrt(n) }),
});

// ─── The cards ────────────────────────────────────────────────────────────

const card = (c) => Object.freeze({ revision: 1, source_kind: 'curated', formula: null, che_note: '', measured: null, misconceptions: [], ...c });

const CODING = [
  card({
    id: 'variables', domain: 'coding', title: 'Variables and data types', level: 'beginner',
    summary: 'A variable is a named box that holds a value; the value\'s type decides what you can do with it.',
    aliases: ['variables', 'variable', 'data types', 'data type', 'variables and data types', 'variables and types', 'types of data'],
    tags: ['fundamentals', 'javascript'], prerequisites: [], related: ['functions', 'hash-maps'],
    levels: {
      beginner: 'A variable is a name that points at a value, like price = 20. Every value has a type: a number, text called a string, true or false called a boolean, or a list. The type decides what makes sense: you can add two numbers, but adding a number to text glues them together instead.',
      intermediate: 'In JavaScript, let makes a variable you can reassign and const makes one you cannot. Numbers and strings are copied when you assign them, but objects and arrays are shared: two names can point at the same list, so a change made through one shows through the other. typeof tells you a value\'s type while the program runs.',
      expert: 'A type is a contract about which operations are valid. Static type systems such as TypeScript and Dart check that contract before the program runs; dynamic ones such as JavaScript and Python check it while it runs, and JavaScript also converts types on its own, so "5" + 1 is "51" while "5" - 1 is 4. JavaScript numbers are binary floating point, so 0.1 + 0.2 is not exactly 0.3, which is why money is best kept in whole cents.',
    },
    analogy: 'A variable is like a labelled jar in a kitchen: the label is the name, what is inside is the value, and whether it holds flour or water is the type, which decides what you can do with it.',
    example: {
      kind: 'code', language: 'javascript',
      explain: 'It checks three types (number, string, boolean), shows that "5" + 1 joins into "51" while "5" - 1 is 4, that a shared list seen through a second name grows to 3 items, and that 0.1 + 0.2 === 0.3 is false.',
      code: [
        "const price = 20;           // a number",
        "const symbol = 'MNQ';       // a string",
        "const shared = [1, 2];",
        "const sameList = shared;    // the same list, not a copy",
        "sameList.push(3);",
        "return {",
        "  types: [typeof price, typeof symbol, typeof true],",
        "  joined: '5' + 1,",
        "  subtracted: '5' - 1,",
        "  sharedLength: shared.length,",
        "  exact: 0.1 + 0.2 === 0.3,",
        "};",
      ].join('\n'),
      expected: { types: ['number', 'string', 'boolean'], joined: '51', subtracted: 4, sharedLength: 3, exact: false },
    },
    quiz: [
      { q: 'What type is the value "hello"?', a: 'A string, which is text.' },
      { q: 'Two names point at the same array and you push through one. Does the other see it?', a: 'Yes. Arrays are shared, so both names see the change.' },
      { q: 'Why is 0.1 + 0.2 not exactly 0.3 in JavaScript?', a: 'Numbers are binary floating point, which cannot store 0.1 exactly. Keep money in whole cents.' },
    ],
    misconceptions: ['const does not freeze a value: it only stops the name being reassigned, and the array or object it holds can still change.'],
    sources: [
      ref('MDN Web Docs: Grammar and types', 'Mozilla', 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Grammar_and_types'),
      ref('MDN Web Docs: typeof', 'Mozilla', 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/typeof'),
      ref('IEEE 754 floating point', 'Wikipedia', 'https://en.wikipedia.org/wiki/IEEE_754'),
    ],
  }),
  card({
    id: 'loops', domain: 'coding', title: 'Loops and iteration', level: 'beginner',
    summary: 'A loop repeats the same steps for each item, or until a condition is met.',
    aliases: ['loops', 'loop', 'for loops', 'for loop', 'while loops', 'while loop', 'iteration', 'loops and iteration'],
    tags: ['fundamentals', 'javascript'], prerequisites: ['variables'], related: ['big-o', 'recursion'],
    levels: {
      beginner: 'A loop repeats the same steps for each item, or until a condition is met. A for loop counts through things; a while loop keeps going while something is still true. Every loop needs a way to stop, or it runs forever.',
      intermediate: 'Loop over an array with for...of and keep a running total in a variable outside the loop. Watch the boundaries: starting at 0 and stopping before the length visits every item once and avoids the classic off-by-one error. break leaves a loop early and continue skips to the next round.',
      expert: 'Reason about a loop with an invariant: a statement that is true before and after every round, such as "total is the sum of the items seen so far". If the invariant holds and the loop ends, the loop is correct. The work done is the number of rounds times the cost of one round, which is where Big-O comes from.',
    },
    analogy: 'A loop is like dealing cards around a table: the same move, one player at a time, until the deck is empty.',
    formula: {
      name: 'Sum of the first n whole numbers', expression: '1 + 2 + … + n = n(n + 1) / 2',
      spoken: 'the sum of 1 to n equals n times n plus 1, divided by 2',
      variables: [{ symbol: 'n', meaning: 'the last number counted', unit: 'a whole number, zero or more' }],
      assumptions: 'n is a whole number of zero or more.', compute: 'triangular', example: { inputs: { n: 100 }, result: 5050 },
    },
    example: {
      kind: 'code', language: 'javascript',
      explain: 'A for loop adds 1 to 100 and gets 5050, the same as the formula 100 times 101 divided by 2.',
      code: [
        'let total = 0;',
        'for (let i = 1; i <= 100; i += 1) total += i;   // invariant: total = 1 + … + i',
        'return { total, formula: (100 * 101) / 2 };',
      ].join('\n'),
      expected: { total: 5050, formula: 5050 },
    },
    quiz: [
      { q: 'What must every loop have so it does not run forever?', a: 'A condition that eventually becomes false, or a break.' },
      { q: 'A loop runs i from 0 while i < length. How many items does it visit?', a: 'Exactly length items, from index 0 to length minus 1.' },
      { q: 'What is 1 + 2 + … + 10?', a: '55, from 10 times 11 divided by 2.', check: { compute: 'triangular', inputs: { n: 10 }, result: 55, shown: ['55'] } },
    ],
    misconceptions: ['Stopping at i <= length visits one item too many: the last index is length minus 1.'],
    sources: [ref('MDN Web Docs: Loops and iteration', 'Mozilla', 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Loops_and_iteration')],
  }),
  card({
    id: 'functions', domain: 'coding', title: 'Functions and scope', level: 'beginner',
    summary: 'A function is a named recipe: inputs in, steps, a result out.',
    aliases: ['functions', 'function', 'scope', 'functions and scope', 'closures', 'closure', 'pure functions'],
    tags: ['fundamentals', 'javascript'], prerequisites: ['variables'], related: ['recursion', 'testing'],
    levels: {
      beginner: 'A function is a named recipe: you give it inputs, it does its steps and hands back a result. Write the steps once, call the function many times, and each piece of the program stays short and easy to check.',
      intermediate: 'Parameters are the inputs a function declares; arguments are the values you pass when you call it. return sends the result back and ends the function. Scope is where a name can be seen: a variable made inside a function is invisible outside it, which keeps functions from tripping over each other.',
      expert: 'A closure is a function that keeps the variables of the place where it was made, even after that code has finished running, which gives private state without a class. A pure function, whose result depends only on its inputs and which changes nothing outside itself, is the easiest kind to test, cache and run in parallel.',
    },
    analogy: 'A function is like a coffee machine: put in beans and water, press the button and coffee comes out; you don\'t need to know what happens inside to use it.',
    example: {
      kind: 'code', language: 'javascript',
      explain: 'makeCounter returns a closure with its own private count: the first counter reaches 3 after three calls, a second counter starts again at 1, and count itself is not visible outside, so its type there is undefined.',
      code: [
        'function makeCounter() {',
        '  let count = 0;                       // private: only the inner function sees it',
        '  return () => { count += 1; return count; };',
        '}',
        'const next = makeCounter();',
        'next(); next();',
        'const other = makeCounter();',
        "return { first: next(), other: other(), outside: typeof count };",
      ].join('\n'),
      expected: { first: 3, other: 1, outside: 'undefined' },
    },
    quiz: [
      { q: 'What is the difference between a parameter and an argument?', a: 'A parameter is the name in the function\'s definition; an argument is the value passed when it is called.' },
      { q: 'Can code outside a function read a variable declared with let inside it?', a: 'No. It is local to the function\'s scope.' },
      { q: 'What does a closure remember?', a: 'The variables of the place where it was made, even after that code finished running.' },
    ],
    misconceptions: ['A function that changes a shared variable is not pure, even if it returns the right answer.'],
    sources: [
      ref('MDN Web Docs: Functions', 'Mozilla', 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Functions'),
      ref('MDN Web Docs: Closures', 'Mozilla', 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Closures'),
    ],
  }),
  card({
    id: 'testing', domain: 'coding', title: 'Unit testing', level: 'beginner',
    summary: 'A test is a small program that checks another program and fails loudly when it breaks.',
    aliases: ['testing', 'unit testing', 'unit tests', 'unit test', 'tests', 'software testing', 'test driven development', 'tdd', 'automated tests'],
    tags: ['engineering', 'quality'], prerequisites: ['functions'], related: ['functions', 'sorting'],
    levels: {
      beginner: 'A test is a small program that checks another program: it runs a function with known inputs and compares the answer with the one you expect. If someone breaks the function later, the test fails and says so right away.',
      intermediate: 'A good unit test is fast, independent and gives the same answer every run: no network, no clock and no randomness unless it is seeded. Arrange the inputs, act by calling the code, assert the result. Write the failing test first to prove it can catch the bug, then fix the code until it passes.',
      expert: 'Unit tests check pieces, integration tests check pieces together, and end-to-end tests check the real path a user takes. Property-based tests state an invariant, such as "sorting twice gives the same as sorting once", and try many generated inputs. A test that can never fail proves nothing, so break the code on purpose and make sure a test notices.',
    },
    analogy: 'A test is like a smoke alarm: quiet while everything is fine, loud the moment something burns, and only worth having once you have checked that it really goes off.',
    che_note: 'CHE\'s own Worker is checked this way: its tests (server/cloudflare/*.test.mjs) run offline with node --test.',
    example: {
      kind: 'code', language: 'javascript',
      explain: 'Two checks on an add function both pass, and the same check catches a broken version that subtracts, so caught is true.',
      code: [
        'const add = (a, b) => a + b;',
        'const results = [];',
        "const check = (name, actual, expected) => results.push(`${actual === expected ? 'pass' : 'FAIL'}: ${name}`);",
        "check('adds two numbers', add(2, 3), 5);",
        "check('adds a negative', add(2, -3), -1);",
        'const broken = (a, b) => a - b;        // a bug, on purpose',
        'const caught = broken(2, 3) !== 5;     // the same check catches it',
        'return { results, caught };',
      ].join('\n'),
      expected: { results: ['pass: adds two numbers', 'pass: adds a negative'], caught: true },
    },
    quiz: [
      { q: 'What three steps make up a typical unit test?', a: 'Arrange the inputs, act by calling the code, assert the result.' },
      { q: 'Why write the failing test before the fix?', a: 'To prove the test can actually catch the bug.' },
      { q: 'Why should a unit test avoid the network?', a: 'So it is fast and gives the same answer every run.' },
    ],
    misconceptions: ['Full coverage does not mean correct: a line can run in a test without any assertion checking its result.'],
    sources: [
      ref('Node.js documentation: Test runner', 'OpenJS Foundation', 'https://nodejs.org/api/test.html'),
      ref('The Practical Test Pyramid', 'Ham Vocke', 'https://martinfowler.com/articles/practical-test-pyramid.html'),
    ],
  }),
  card({
    id: 'big-o', domain: 'coding', title: 'Big-O notation', level: 'intermediate',
    summary: 'Big-O describes how the work grows when the input grows.',
    aliases: ['big o', 'big-o', 'big o notation', 'big-o notation', 'time complexity', 'algorithm complexity', 'algorithmic complexity', 'binary search'],
    tags: ['algorithms', 'computer science'], prerequisites: ['loops'], related: ['sorting', 'hash-maps', 'recursion'],
    levels: {
      beginner: 'Big-O describes how the work grows when the input grows. O(n) means twice the data takes about twice the time; O(1) means the time stays the same however much data there is; O(n²) means twice the data takes about four times as long.',
      intermediate: 'Count the steps that grow with the input and keep only the fastest-growing term, dropping constants: 3n + 7 is O(n), and two nested loops over n items are O(n²). Binary search halves what is left on every step, so on a sorted list it needs at most the floor of log₂ n, plus 1, comparisons: 10 for a thousand items and 20 for a million.',
      expert: 'Formally, f(n) is O(g(n)) when there are constants c > 0 and n₀ such that f(n) ≤ c·g(n) for every n ≥ n₀: an upper bound. Big-Omega is the matching lower bound, and Big-Theta means both. Big-O hides constants and assumes large inputs, so for small n a simple O(n²) method can beat an O(n log n) one; memory use, worst versus average case, and amortized cost, like an array that doubles when it is full, each need stating on their own.',
    },
    analogy: 'Big-O is like asking how a trip\'s time grows with distance rather than how long today\'s drive took: walking, driving and flying grow at different rates whatever the traffic.',
    formula: {
      name: 'Binary search, worst case', expression: 'comparisons(n) = ⌊log₂ n⌋ + 1',
      spoken: 'the worst-case number of comparisons for binary search is the floor of log base 2 of n, plus 1',
      variables: [{ symbol: 'n', meaning: 'the number of items in the sorted list', unit: 'items, at least 1' }],
      assumptions: 'The list is sorted, and each comparison rules out half of what is left.', compute: 'binarySearchWorst', example: { inputs: { n: 1000 }, result: 10 },
    },
    example: {
      kind: 'code', language: 'javascript',
      explain: 'Binary search for a missing value, its worst case, takes 10 comparisons on 1000 sorted items and 20 on a million, where checking every item would take 1000.',
      code: [
        '// Counts binary search comparisons for a value larger than every item: its worst case.',
        'function comparisons(n) {',
        '  const list = Array.from({ length: n }, (_, i) => i * 2);   // sorted even numbers',
        '  const target = list[n - 1] + 1;                             // not in the list',
        '  let low = 0, high = n - 1, count = 0;',
        '  while (low <= high) {',
        '    const mid = Math.floor((low + high) / 2);',
        '    count += 1;',
        '    if (list[mid] < target) low = mid + 1; else high = mid - 1;',
        '  }',
        '  return count;',
        '}',
        'return { thousand: comparisons(1000), million: comparisons(1000000), linear: 1000 };',
      ].join('\n'),
      expected: { thousand: 10, million: 20, linear: 1000 },
    },
    quiz: [
      { q: 'Two nested loops each run over n items. What is the Big-O?', a: 'O(n²): n rounds of n steps.' },
      { q: 'What is 5n + 100 in Big-O?', a: 'O(n). Constants and smaller terms are dropped.' },
      { q: 'At most how many comparisons does binary search need for 1,000 sorted items?', a: '10, because the floor of log₂ 1000 is 9, plus 1.', check: { compute: 'binarySearchWorst', inputs: { n: 1000 }, result: 10, shown: ['10'] } },
    ],
    misconceptions: ['O(n) is not always faster than O(n²): Big-O says how time grows, not how long a particular small input takes.'],
    sources: [
      ref('MIT OpenCourseWare 6.006 Introduction to Algorithms', 'MIT', 'https://ocw.mit.edu/courses/6-006-introduction-to-algorithms-spring-2020/'),
      ref('Big O notation', 'Wikipedia', 'https://en.wikipedia.org/wiki/Big_O_notation'),
      ref('Binary search algorithm', 'Wikipedia', 'https://en.wikipedia.org/wiki/Binary_search_algorithm'),
    ],
  }),
  card({
    id: 'recursion', domain: 'coding', title: 'Recursion', level: 'intermediate',
    summary: 'A function that solves a problem by calling itself on a smaller piece of it.',
    aliases: ['recursion', 'recursive functions', 'recursive function', 'recursive calls', 'recursive', 'recursion depth'],
    tags: ['functions', 'algorithms'], prerequisites: ['functions'], related: ['big-o', 'sorting', 'loops'],
    levels: {
      beginner: 'Recursion is a function that solves a problem by calling itself on a smaller version of the same problem, until the problem is so small the answer is obvious. That obvious case is the base case, and without it the function never stops.',
      intermediate: 'Every recursive function needs a base case that answers directly and a recursive case that moves toward it: factorial(n) = n × factorial(n − 1), with factorial(1) = 1. Each call waits on the call stack until the one below it returns, so factorial(n) goes n calls deep. Naive Fibonacci calls itself twice per step and makes 2·F(n+1) − 1 calls, which explodes; remembering answers already worked out, called memoization, cuts that to about n.',
      expert: 'Model the cost with a recurrence: naive Fibonacci\'s calls follow C(n) = C(n − 1) + C(n − 2) + 1, whose solution 2·F(n+1) − 1 grows exponentially, while divide and conquer such as merge sort\'s T(n) = 2T(n/2) + n gives O(n log n). The call stack is limited, and JavaScript engines throw a RangeError after some thousands of frames depending on the engine, so very deep recursion should become a loop with an explicit stack; JavaScript does not reliably remove tail calls.',
    },
    analogy: 'Recursion is like Russian nesting dolls: to reach the smallest doll you open a doll, then do the same thing to the doll inside, until you reach one that does not open.',
    formula: {
      name: 'Calls made by naive Fibonacci', expression: 'calls(n) = 2·F(n+1) − 1, with F(1) = F(2) = 1',
      spoken: 'naive Fibonacci of n makes 2 times the Fibonacci number n plus 1, minus 1, calls',
      variables: [
        { symbol: 'n', meaning: 'the Fibonacci index asked for', unit: 'a whole number, zero or more' },
        { symbol: 'F(k)', meaning: 'the k-th Fibonacci number', unit: 'a count' },
      ],
      assumptions: 'fib(0) and fib(1) are base cases that return without calling again. Depth is separate: factorial(n) is n calls deep for n of 1 or more.',
      compute: 'fibCalls', example: { inputs: { n: 10 }, result: 177 },
    },
    example: {
      kind: 'code', language: 'javascript',
      explain: 'Naive fib(10) returns 55 but takes 177 calls; factorial(5) returns 120 at a depth of 5 calls.',
      code: [
        'let calls = 0;',
        'function fib(n) { calls += 1; return n < 2 ? n : fib(n - 1) + fib(n - 2); }',
        'let deepest = 0;',
        'function factorial(n, depth = 1) {',
        '  deepest = Math.max(deepest, depth);',
        '  return n <= 1 ? 1 : n * factorial(n - 1, depth + 1);   // base case: n <= 1',
        '}',
        'const fib10 = fib(10);',
        'return { fib10, calls, factorial5: factorial(5), depth: deepest };',
      ].join('\n'),
      expected: { fib10: 55, calls: 177, factorial5: 120, depth: 5 },
    },
    quiz: [
      { q: 'What two parts does every recursive function need?', a: 'A base case that answers directly, and a recursive case that moves toward it.' },
      { q: 'How many calls deep does factorial(6) go?', a: '6 calls deep, from factorial 6 down to factorial 1.' },
      { q: 'How many calls does naive fib(5) make?', a: '15, which is 2 times F(6), 8, minus 1.', check: { compute: 'fibCalls', inputs: { n: 5 }, result: 15, shown: ['15'] } },
    ],
    misconceptions: ['Recursion is not always slower than a loop, but naive recursion that repeats the same subproblem can be exponentially slower.'],
    sources: [
      ref('MDN Web Docs glossary: Recursion', 'Mozilla', 'https://developer.mozilla.org/en-US/docs/Glossary/Recursion'),
      ref('Recursion (computer science)', 'Wikipedia', 'https://en.wikipedia.org/wiki/Recursion_(computer_science)'),
      ref('Structure and Interpretation of Computer Programs, section 1.2', 'Harold Abelson and Gerald Jay Sussman'),
    ],
  }),
  card({
    id: 'hash-maps', domain: 'coding', title: 'Hash maps', level: 'intermediate',
    summary: 'A hash map finds a value straight from its key, without searching.',
    aliases: ['hash maps', 'hash map', 'hashmap', 'hashmaps', 'hash tables', 'hash table', 'hashing', 'map data structure', 'key value stores'],
    tags: ['data structures', 'computer science'], prerequisites: ['variables', 'big-o'], related: ['big-o', 'http-apis'],
    levels: {
      beginner: 'A hash map stores pairs: a key and its value, like a word and its meaning. You find a value straight from its key, without searching the whole collection, so looking things up stays fast even with millions of entries.',
      intermediate: 'A hash function turns each key into a number that picks a bucket, so lookups, inserts and deletes take O(1) time on average. Two keys can land in the same bucket, a collision; the map keeps both and compares the keys to tell them apart. In JavaScript use a Map, in Python a dict.',
      expert: 'The load factor α = n / m, entries per bucket, sets the speed: with chaining, a successful search checks about 1 + α/2 entries on average under uniform hashing. Maps grow, often doubling, when α passes a threshold, so one insert can cost O(n) while the amortized cost stays O(1). A bad or attacker-chosen hash piles keys into one bucket and drags lookups toward O(n), which is why runtimes randomize their hash seeds.',
    },
    analogy: 'A hash map is like a coat check: you hand over your coat and get a numbered ticket, and the ticket takes the attendant straight to the right hook instead of searching every coat.',
    formula: {
      name: 'Load factor', expression: 'α = n / m',
      spoken: 'the load factor alpha equals the number of entries n divided by the number of buckets m',
      variables: [{ symbol: 'n', meaning: 'entries stored', unit: 'a count' }, { symbol: 'm', meaning: 'buckets', unit: 'a count, at least 1' }],
      assumptions: 'Keys spread evenly over the buckets, called uniform hashing.', compute: 'loadFactor', example: { inputs: { n: 750, m: 1000 }, result: 0.75 },
    },
    example: {
      kind: 'code', language: 'javascript',
      explain: 'Counting words with a Map: "buy" appears 2 times, "the" 3 times, a missing word counts 0, and there are 6 different words.',
      code: [
        "const words = 'buy the dip buy the rip sell the news'.split(' ');",
        'const counts = new Map();',
        'for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);',
        "return { buy: counts.get('buy'), the: counts.get('the'), missing: counts.get('hold') ?? 0, distinct: counts.size };",
      ].join('\n'),
      expected: { buy: 2, the: 3, missing: 0, distinct: 6 },
    },
    quiz: [
      { q: 'What is the average time to look up a key in a hash map?', a: 'O(1), constant time on average.' },
      { q: 'What is a collision?', a: 'Two different keys landing in the same bucket; the map keeps both and compares the keys.' },
      { q: 'A map holds 600 entries in 800 buckets. What is its load factor?', a: '0.75, which is 600 divided by 800.', check: { compute: 'loadFactor', inputs: { n: 600, m: 800 }, result: 0.75, shown: ['0.75'] } },
    ],
    misconceptions: ['O(1) on average is not a promise for every single operation: a resize or a crowded bucket can be slow.'],
    sources: [
      ref('MDN Web Docs: Map', 'Mozilla', 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map'),
      ref('Hash table', 'Wikipedia', 'https://en.wikipedia.org/wiki/Hash_table'),
      ref('Introduction to Algorithms, chapter on hash tables', 'Cormen, Leiserson, Rivest and Stein'),
    ],
  }),
  card({
    id: 'sorting', domain: 'coding', title: 'Sorting and merge sort', level: 'intermediate',
    summary: 'Merge sort splits a list in halves, sorts them and merges them back in order.',
    aliases: ['sorting', 'sort', 'sorting algorithms', 'sorting algorithm', 'merge sort', 'mergesort'],
    tags: ['algorithms', 'computer science'], prerequisites: ['recursion', 'big-o'], related: ['big-o', 'testing'],
    levels: {
      beginner: 'Sorting puts items in order, smallest to largest or A to Z. Merge sort does it by splitting the list in half again and again until every piece has one item, then merging the pieces back together in order, like combining two sorted piles of cards.',
      intermediate: 'Merging two sorted lists takes at most one comparison per item placed, and a list can be halved about log₂ n times, so merge sort makes about n·log₂ n comparisons: O(n log n) in every case, against O(n²) for simple methods like insertion sort. It is stable, keeping equal items in their original order, and it needs extra memory for the merge.',
      expert: 'Merge sort\'s cost follows T(n) = 2T(n/2) + n, which solves to Θ(n log n); its comparisons never exceed n⌈log₂ n⌉ − 2^⌈log₂ n⌉ + 1, which is below n⌈log₂ n⌉. No comparison sort can beat about n log₂ n in the worst case, because it must tell apart n! possible orders and log₂(n!) ≈ n log₂ n. Real libraries use hybrids such as Timsort, which finds runs that are already sorted and uses insertion sort for small pieces.',
    },
    analogy: 'Merge sort is like two people each sorting half a deck of cards, then laying the two sorted piles side by side and always taking the smaller top card.',
    formula: {
      name: 'Merge sort comparisons, worst case', expression: 'comparisons(n) ≤ n⌈log₂ n⌉ − 2^⌈log₂ n⌉ + 1',
      spoken: 'merge sort makes at most n times the ceiling of log base 2 of n, minus 2 to the power of that ceiling, plus 1, comparisons',
      variables: [{ symbol: 'n', meaning: 'the number of items', unit: 'items, at least 1' }],
      assumptions: 'Top-down merge sort that compares two items at a time.', compute: 'mergeSortWorst', example: { inputs: { n: 8 }, result: 17 },
    },
    example: {
      kind: 'code', language: 'javascript',
      explain: 'Merge sort puts 5, 2, 8, 1, 9, 3, 7, 4 in order with 17 comparisons, exactly the worst case for 8 items: 8 times 3, minus 8, plus 1.',
      code: [
        'let comparisons = 0;',
        'function mergeSort(list) {',
        '  if (list.length <= 1) return list;                  // base case',
        '  const mid = Math.floor(list.length / 2);',
        '  const left = mergeSort(list.slice(0, mid));',
        '  const right = mergeSort(list.slice(mid));',
        '  const out = [];',
        '  while (left.length && right.length) {',
        '    comparisons += 1;',
        '    out.push(left[0] <= right[0] ? left.shift() : right.shift());',
        '  }',
        '  return [...out, ...left, ...right];',
        '}',
        'const sorted = mergeSort([5, 2, 8, 1, 9, 3, 7, 4]);',
        'return { sorted, comparisons, worstCase: 8 * 3 - 8 + 1 };',
      ].join('\n'),
      expected: { sorted: [1, 2, 3, 4, 5, 7, 8, 9], comparisons: 17, worstCase: 17 },
    },
    quiz: [
      { q: 'What is merge sort\'s running time?', a: 'O(n log n), in the best, average and worst case.' },
      { q: 'What does a stable sort keep?', a: 'Equal items in their original order.' },
      { q: 'At most how many comparisons does merge sort need for 8 items?', a: '17, from 8 times 3, minus 8, plus 1.', check: { compute: 'mergeSortWorst', inputs: { n: 8 }, result: 17, shown: ['17'] } },
    ],
    misconceptions: ['O(n log n) does not mean merge sort is always fastest: for small or nearly sorted lists insertion sort can win.'],
    sources: [
      ref('Merge sort', 'Wikipedia', 'https://en.wikipedia.org/wiki/Merge_sort'),
      ref('MIT OpenCourseWare 6.006 Introduction to Algorithms', 'MIT', 'https://ocw.mit.edu/courses/6-006-introduction-to-algorithms-spring-2020/'),
      ref('The Art of Computer Programming, volume 3: Sorting and Searching', 'Donald E. Knuth'),
    ],
  }),
  card({
    id: 'http-apis', domain: 'coding', title: 'HTTP and APIs', level: 'intermediate',
    summary: 'An API is the menu one program offers another; on the web its requests travel over HTTP.',
    aliases: ['http', 'apis', 'api', 'rest apis', 'rest api', 'http and apis', 'web apis', 'status codes', 'http status codes', 'http requests'],
    tags: ['web', 'networking'], prerequisites: ['functions'], related: ['concurrency', 'testing', 'hash-maps'],
    levels: {
      beginner: 'An API is a menu one program offers another: the requests it accepts and what it sends back. On the web those requests travel over HTTP: an app asks a server for something at an address, and the server answers with a status code and some data.',
      intermediate: 'An HTTP request has a method (GET reads, POST creates or sends, PUT and PATCH change, DELETE removes), a URL with an optional query string, headers such as Content-Type and Authorization, and sometimes a JSON body. The status code\'s first digit says what happened: 2xx success, 3xx redirect, 4xx the caller\'s mistake, 5xx the server\'s failure.',
      expert: 'GET, PUT and DELETE are idempotent, meaning that repeating them leaves the same result, so they can be retried safely; POST is not, unless the API takes an idempotency key. Retry 408, 429 and 5xx answers with exponential backoff and jitter, never other 4xx ones, and put a timeout on every call. Credentials never belong in a URL, where they end up in logs: they go in a header, over HTTPS.',
    },
    analogy: 'An API is like a restaurant menu and waiter: you order from the menu in a set way, the kitchen does work you can\'t see, and the waiter brings back your dish or tells you it\'s sold out.',
    che_note: 'CHE\'s phone app talks to her Worker this way: every chat turn is a POST to /api/chat over HTTPS.',
    example: {
      kind: 'code', language: 'javascript',
      explain: 'It builds the address https://api.example.com/v1/bars?symbol=MNQ&interval=5m and sorts status codes into their classes: 200 is success, 404 a client error and 503 a server error.',
      code: [
        "const url = new URL('https://api.example.com/v1/bars');",
        "url.searchParams.set('symbol', 'MNQ');",
        "url.searchParams.set('interval', '5m');",
        "const kind = (status) => ['informational', 'success', 'redirect', 'client error', 'server error'][Math.floor(status / 100) - 1];",
        'return { url: url.toString(), ok: kind(200), notFound: kind(404), down: kind(503) };',
      ].join('\n'),
      expected: { url: 'https://api.example.com/v1/bars?symbol=MNQ&interval=5m', ok: 'success', notFound: 'client error', down: 'server error' },
    },
    quiz: [
      { q: 'Which status code class means the caller made a mistake?', a: '4xx, such as 404 Not Found or 401 Unauthorized.' },
      { q: 'Which methods are idempotent?', a: 'GET, PUT and DELETE: repeating them gives the same result.' },
      { q: 'Should a 400 Bad Request be retried?', a: 'No. Fix the request. Retry only 408, 429 and 5xx answers, with backoff.' },
    ],
    misconceptions: ['A 200 status does not always mean the work succeeded: some APIs return 200 with an error inside the body, so check the body too.'],
    sources: [
      ref('MDN Web Docs: An overview of HTTP', 'Mozilla', 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Overview'),
      ref('MDN Web Docs: HTTP response status codes', 'Mozilla', 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status'),
      ref('RFC 9110: HTTP Semantics', 'IETF', 'https://www.rfc-editor.org/rfc/rfc9110'),
    ],
  }),
  card({
    id: 'concurrency', domain: 'coding', title: 'Concurrency and async', level: 'expert',
    summary: 'Concurrency keeps several jobs in progress at once, so waiting does not waste time.',
    aliases: ['concurrency', 'async', 'asynchronous', 'async await', 'async and await', 'promise all', 'parallelism', 'amdahls law', 'amdahl'],
    tags: ['advanced', 'javascript', 'performance'], prerequisites: ['functions', 'http-apis'], related: ['big-o', 'testing'],
    levels: {
      beginner: 'Concurrency means juggling several jobs at once instead of finishing one before starting the next. While one job waits, for example for a website to answer, the program gets on with another, so the waiting doesn\'t waste time.',
      intermediate: 'In JavaScript, slow work returns a Promise, a placeholder for a result that arrives later, and await pauses only that one function until it settles. Promise.all starts several waits together and finishes when all are done, so three one-second requests take about one second instead of three. It fails as soon as any one fails; Promise.allSettled reports every result instead.',
      expert: 'Concurrency is about structure, many tasks in progress; parallelism is about execution, many at the same instant on several cores. Shared changing state invites race conditions, so prefer messages, unchanging data or one owner per piece of state, which is what a Durable Object gives CHE\'s Worker. Amdahl\'s law caps the speed-up: if a share p of the work can run in parallel on N workers, the speed-up is 1 / ((1 − p) + p / N), never more than 1 / (1 − p).',
    },
    analogy: 'Concurrency is like a cook with three pans on the stove: while the pasta boils, the sauce gets stirred, instead of watching one pot until it is done.',
    formula: {
      name: 'Amdahl\'s law', expression: 'S(N) = 1 / ((1 − p) + p / N)',
      spoken: 'the speed-up on N workers equals 1 divided by the serial share, 1 minus p, plus the parallel share p divided by N',
      variables: [
        { symbol: 'p', meaning: 'the share of the work that can run in parallel', unit: 'a fraction from 0 to 1' },
        { symbol: 'N', meaning: 'parallel workers or cores', unit: 'a count' },
        { symbol: 'S', meaning: 'the speed-up compared with one worker', unit: 'times faster' },
      ],
      assumptions: 'The parallel part splits perfectly and the problem size stays fixed.', compute: 'amdahl', example: { inputs: { p: 0.9, n: 4 }, result: 3.0769 },
    },
    example: {
      kind: 'code', language: 'javascript',
      explain: 'Three timed tasks run together under Promise.all: all 3 are in flight at once, they finish fastest first, and the results still come back in the order they were asked for.',
      code: [
        'let running = 0, peak = 0;',
        'const finished = [];',
        'const task = (name, ms) => new Promise((resolve) => {',
        '  running += 1; peak = Math.max(peak, running);',
        '  setTimeout(() => { running -= 1; finished.push(name); resolve(name.toUpperCase()); }, ms);',
        '});',
        "const results = await Promise.all([task('slow', 30), task('fast', 10), task('medium', 20)]);",
        'return { results, finished, peak };',
      ].join('\n'),
      expected: { results: ['SLOW', 'FAST', 'MEDIUM'], finished: ['fast', 'medium', 'slow'], peak: 3 },
    },
    quiz: [
      { q: 'What does await do?', a: 'It pauses only that async function until the Promise settles; the rest of the program keeps running.' },
      { q: 'Three one-second requests run with Promise.all. About how long does it take?', a: 'About one second, because they wait at the same time.' },
      { q: 'With 90% parallel work on 4 cores, what speed-up does Amdahl\'s law give?', a: 'About 3.08 times: 1 divided by 0.1 plus 0.9 over 4.', check: { compute: 'amdahl', inputs: { p: 0.9, n: 4 }, result: 3.0769, shown: ['3.08'] } },
    ],
    misconceptions: ['async does not make code run in parallel on its own: JavaScript still runs one piece of code at a time, it just stops waiting idly.'],
    sources: [
      ref('MDN Web Docs: Using promises', 'Mozilla', 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Using_promises'),
      ref('MDN Web Docs: Promise.all()', 'Mozilla', 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/all'),
      ref('Amdahl\'s law', 'Wikipedia', 'https://en.wikipedia.org/wiki/Amdahl%27s_law'),
    ],
  }),
];

const MNQ = CONTRACTS.MNQ;
const NQ = CONTRACTS.NQ;
const CME_MNQ = ref('CME Group: Micro E-mini Nasdaq-100 contract specs', 'CME Group', 'https://www.cmegroup.com/markets/equities/nasdaq/micro-e-mini-nasdaq-100.contractSpecs.html');
const CME_NQ = ref('CME Group: E-mini Nasdaq-100 contract specs', 'CME Group', 'https://www.cmegroup.com/markets/equities/nasdaq/e-mini-nasdaq-100.contractSpecs.html');
const THARP = ref('Trade Your Way to Financial Freedom', 'Van K. Tharp');
const PARDO = ref('The Evaluation and Optimization of Trading Strategies', 'Robert Pardo');

const TRADING = [
  card({
    id: 'tick-value', domain: 'trading', title: 'Ticks, points and contract value', level: 'beginner',
    summary: 'Futures prices move in ticks, and each contract sets how many dollars a point is worth.',
    aliases: ['tick value', 'tick size', 'point value', 'points and ticks', 'ticks and points', 'contract multiplier', 'contract value', 'mnq tick value', 'nq tick value', 'contract specs'],
    tags: ['futures', 'fundamentals'], prerequisites: [], related: ['bid-ask-spread', 'risk-management', 'r-multiple'],
    levels: {
      beginner: 'Futures prices move in fixed steps called ticks. Each contract also has a point value: how many dollars one full point of price movement is worth. On MNQ, the Micro Nasdaq-100 future, a point is $2 and the smallest step, a tick, is a quarter point, so one tick is $0.50.',
      intermediate: 'Profit or loss is points moved × point value × contracts, before costs. NQ and MNQ follow the same index, but an NQ point is worth $20 and an MNQ point $2, so one NQ is the exposure of ten MNQ. A 10-point move on 2 MNQ is 10 × $2 × 2 = $40; the same move on 1 NQ is $200.',
      expert: 'The multiplier sets the notional exposure, index level × point value: at 21,000 one MNQ controls about $42,000 and one NQ about $420,000, which is why a small margin deposit carries large leverage. Ticks make stops discrete: a stop 10 points away is 40 ticks. Commissions are fixed per contract while a point\'s value scales with the multiplier, so on micros the costs are a larger share of each point.',
    },
    analogy: 'Point value is like the price per gallon at a pump: the display moves the same way for everyone, but how many dollars each step costs you depends on the size of your tank, the contract.',
    che_note: `CHE's paper engine uses MNQ with a ${MNQ.tick}-point tick and $${MNQ.pointValue} a point, and NQ with a ${NQ.tick}-point tick and $${NQ.pointValue} a point (trading_evidence.js).`,
    formula: {
      name: 'Futures profit and loss', expression: 'P&L = points × point value × contracts;  tick value = tick size × point value',
      spoken: 'profit or loss equals points moved times point value times contracts, and tick value equals tick size times point value',
      variables: [
        { symbol: 'points', meaning: 'price moved, exit minus entry for a long', unit: 'index points' },
        { symbol: 'point value', meaning: 'dollars per point per contract', unit: '$ per point' },
        { symbol: 'contracts', meaning: 'how many contracts', unit: 'a count' },
      ],
      assumptions: 'Before commissions, fees, spread and slippage.', compute: 'futuresPnl', example: { inputs: { points: 10, pointValue: 2, contracts: 2 }, result: 40 },
    },
    example: {
      kind: 'numeric', inputs: { points: 10, pointValue: 2, contracts: 2 }, compute: 'futuresPnl', result: 40, unit: '$',
      steps: ['10 points × $2 per point × 2 MNQ contracts = $40, before costs', 'An MNQ tick is 0.25 × $2 = $0.50; an NQ tick is 0.25 × $20 = $5.00'],
    },
    quiz: [
      { q: 'How many dollars is one MNQ tick?', a: '$0.50: a quarter point times $2.', check: { compute: 'futuresPnl', inputs: { points: 0.25, pointValue: 2, contracts: 1 }, result: 0.5, shown: ['$0.50'] } },
      { q: 'What is a 5-point move on 3 MNQ worth, before costs?', a: '$30: 5 × $2 × 3.', check: { compute: 'futuresPnl', inputs: { points: 5, pointValue: 2, contracts: 3 }, result: 30, shown: ['$30'] } },
      { q: 'How many MNQ contracts match one NQ in exposure?', a: 'Ten, because $20 ÷ $2 = 10.' },
    ],
    misconceptions: ['A micro is not a smaller-risk version of the same trade by magic: ten micros carry exactly the risk of one full contract.'],
    sources: [CME_MNQ, CME_NQ, CHE_CODE('trading_evidence.js')],
  }),
  card({
    id: 'bid-ask-spread', domain: 'trading', title: 'Bid, ask and spread', level: 'beginner',
    summary: 'The bid is the best price to sell at now, the ask the best price to buy at; the gap is the spread.',
    aliases: ['bid ask spread', 'bid-ask spread', 'bid and ask', 'bid ask', 'spread', 'spreads', 'ask price', 'bid price', 'slippage'],
    tags: ['market structure', 'fundamentals', 'costs'], prerequisites: ['tick-value'], related: ['tick-value', 'vwap', 'expectancy'],
    levels: {
      beginner: 'Every market shows two prices at once. The bid is the highest price a buyer is offering right now; the ask, or offer, is the lowest price a seller will take. The gap between them is the spread. Buy at market and you pay the ask; sell at market and you get the bid, so crossing the spread is a cost you pay straight away.',
      intermediate: 'Spread = ask − bid, often counted in ticks. On MNQ a tick is 0.25 points, worth $0.50 a contract, so a one-tick spread costs $0.50 a contract to cross, and a round trip with market orders pays it going in and coming out, about half on each side. A limit order can wait at the bid or ask to avoid paying the spread, but it might not fill.',
      expert: 'The quoted spread is only the visible cost. The effective spread, 2 × |fill price − midpoint|, measures what fills really paid, and slippage adds the price moving between the decision and the fill. Spreads widen when liquidity is thin: around economic releases, near the open and overnight. A strategy whose average edge per trade is close to its round-trip costs has no real edge, which is why CHE\'s paper engine charges spread and slippage on every simulated trade.',
    },
    analogy: 'The spread is like a currency booth at the airport: it buys your dollars at one price and sells them at a higher one, and the difference is its fee for being there when you need it.',
    che_note: `CHE's paper engine assumes a ${COSTS.spreadTicks}-tick spread, half paid on each side, and ${COSTS.slippageTicks} tick of slippage per side on market orders. These are planning assumptions, not measured fills (trading_evidence.js).`,
    formula: {
      name: 'Spread and its cost', expression: 'spread = ask − bid;  cost = (spread ÷ tick size) × tick value × contracts',
      spoken: 'the spread equals the ask minus the bid, and its cost equals the spread in ticks times the tick value times the contracts',
      variables: [
        { symbol: 'ask, bid', meaning: 'the best offer to sell to you and the best bid to buy from you', unit: 'index points' },
        { symbol: 'tick size', meaning: 'the smallest price step', unit: 'index points' },
        { symbol: 'tick value', meaning: 'dollars per tick per contract', unit: '$' },
        { symbol: 'contracts', meaning: 'how many contracts', unit: 'a count' },
      ],
      assumptions: 'One market order crosses the whole quoted spread; CHE\'s paper engine charges half the spread on each side of a round trip.',
      compute: 'spreadCost', example: { inputs: { bid: 21000, ask: 21000.5, tick: 0.25, tickValue: 0.5, contracts: 2 }, result: 2 },
    },
    example: {
      kind: 'numeric', inputs: { bid: 21000, ask: 21000.5, tick: 0.25, tickValue: 0.5, contracts: 2 }, compute: 'spreadCost', result: 2, unit: '$',
      steps: ['spread = 21,000.50 − 21,000.00 = 0.50 points', '0.50 ÷ 0.25 = 2 ticks', '2 ticks × $0.50 × 2 MNQ contracts = $2.00 to cross it'],
    },
    quiz: [
      { q: 'The bid is 100.00 and the ask is 100.25. What is the spread?', a: '0.25 points, one tick when the tick is 0.25.' },
      { q: 'When you buy with a market order, which price do you pay?', a: 'The ask.' },
      { q: 'On MNQ, what does crossing a one-tick spread cost per contract?', a: '$0.50: one tick of 0.25 points times $2 a point.', check: { compute: 'spreadCost', inputs: { bid: 0, ask: 0.25, tick: 0.25, tickValue: 0.5, contracts: 1 }, result: 0.5, shown: ['$0.50'] } },
    ],
    misconceptions: ['The last traded price is not the price you will get: a market buy fills at the ask, which can be above it.'],
    sources: [
      ref('Bid–ask spread', 'Wikipedia', 'https://en.wikipedia.org/wiki/Bid%E2%80%93ask_spread'),
      CME_MNQ, CHE_CODE('trading_evidence.js'),
    ],
  }),
  card({
    id: 'r-multiple', domain: 'trading', title: 'R-multiples', level: 'beginner',
    summary: 'R is what you planned to risk on a trade; results in R compare trades of any size.',
    aliases: ['r multiple', 'r multiples', 'r-multiple', 'r-multiples', 'risk multiple', 'r units', 'risk reward', 'risk to reward', 'risk reward ratio', 'reward to risk', 'reward to risk ratio'],
    tags: ['risk', 'statistics', 'fundamentals'], prerequisites: ['tick-value'], related: ['expectancy', 'risk-management', 'drawdown'],
    levels: {
      beginner: 'R is the amount you planned to risk on a trade: the distance from your entry to your stop. Measuring results in R makes trades comparable: winning twice what you risked is +2R, and getting stopped out is −1R, whatever the contract or size.',
      intermediate: 'For a long, R-multiple = (exit − entry) ÷ (entry − stop); for a short, (entry − exit) ÷ (stop − entry). The planned reward-to-risk is the same sum with the target in place of the exit. Bought at 100 with a stop at 98 and sold at 105, the trade made 5 points on 2 points of risk: +2.5R. CHE\'s paper engine records both r_gross, before costs, and r_net, after them.',
      expert: 'A strategy\'s list of R-multiples is the raw material for its statistics: their mean is the expectancy and their spread sets how deep losing streaks go. The initial risk must be fixed at entry; moving the stop later changes what the trade really risked, and slippage through a stop can make a loss worse than −1R. R removes position size, so different sizes compare fairly, but it also hides how many dollars were at stake.',
    },
    analogy: 'R is like measuring a trip in tanks of fuel instead of miles: three tanks means the same thing whether you drive a small car or a truck.',
    formula: {
      name: 'R-multiple of a long trade', expression: 'R = (exit − entry) ÷ (entry − stop)',
      spoken: 'R equals the exit minus the entry, divided by the entry minus the stop',
      variables: [
        { symbol: 'entry', meaning: 'the entry price', unit: 'price' },
        { symbol: 'stop', meaning: 'the initial stop, below the entry for a long', unit: 'price' },
        { symbol: 'exit', meaning: 'the exit price', unit: 'price' },
      ],
      assumptions: 'A long trade with the initial stop fixed at entry; before costs unless the exit includes them. For a short, R = (entry − exit) ÷ (stop − entry).',
      compute: 'rMultiple', example: { inputs: { entry: 100, stop: 98, exit: 105 }, result: 2.5 },
    },
    example: {
      kind: 'numeric', inputs: { entry: 100, stop: 98, exit: 105 }, compute: 'rMultiple', result: 2.5, unit: 'R',
      steps: ['risk = 100 − 98 = 2 points', 'gain = 105 − 100 = 5 points', 'R = 5 ÷ 2 = +2.5R'],
    },
    quiz: [
      { q: 'A long enters at 50 with a stop at 48 and exits at 54. What is its R-multiple?', a: '+2R: 4 points gained on 2 points risked.', check: { compute: 'rMultiple', inputs: { entry: 50, stop: 48, exit: 54 }, result: 2, shown: ['+2R'] } },
      { q: 'A trade stopped out exactly at its stop is worth how many R?', a: '−1R, before costs.' },
      { q: 'Why measure trades in R?', a: 'It makes results comparable across contracts and position sizes.' },
    ],
    misconceptions: ['A high reward-to-risk plan is not better by itself: a 5R target that is rarely reached can have a worse expectancy than a 1R target.'],
    sources: [THARP, CHE_CODE('trading_evidence.js')],
  }),
  card({
    id: 'risk-management', domain: 'trading', title: 'Risk management and position sizing', level: 'beginner',
    summary: 'Decide the loss you can take before entering, and size the position from it.',
    aliases: ['risk management', 'managing risk', 'position sizing', 'position size', 'sizing', 'risk per trade', 'how much to risk', 'stop loss', 'stop losses', 'risk', 'money management'],
    tags: ['risk', 'fundamentals'], prerequisites: ['tick-value', 'r-multiple'], related: ['drawdown', 'expectancy', 'r-multiple'],
    levels: {
      beginner: 'Risk management means deciding, before you enter, how much you can lose on a trade, and placing a stop where you will get out if you are wrong. A common rule is to risk only a small fixed slice of the account, often 1% or less, so a run of losses hurts but does not end the account.',
      intermediate: 'The position size comes from the risk, not the other way round: contracts = risk budget ÷ (stop distance in points × point value), rounded down. With $100 to risk and a 10-point stop on MNQ at $2 a point, each contract risks $20, so the size is 5 contracts. If even one contract would risk more than the budget, the trade is skipped.',
      expert: 'Fixed-fraction sizing shrinks positions after losses and grows them after wins, which slows the damage of a drawdown. Losing streaks are normal: at a 40% win rate the chance that any given 10 trades all lose is 0.6¹⁰, about 0.6%, yet over hundreds of trades a streak like that becomes likely. Correlated positions, gaps through stops and leverage all make the real risk bigger than the plan, so a daily loss limit and a maximum size per order are a second line of defence.',
    },
    analogy: 'Position sizing is like deciding how much water to pour into each bucket before carrying them over a rickety bridge: if one bucket falls, you lose only what was in it.',
    che_note: 'CHE\'s trading desk sends no live order until you set live risk limits, the most contracts and the most dollars at risk per order, and even then each live order waits for your yes (trading_desk.js).',
    formula: {
      name: 'Position size', expression: 'contracts = floor(risk budget ÷ (stop distance × point value))',
      spoken: 'contracts equal the risk budget divided by the stop distance times the point value, rounded down',
      variables: [
        { symbol: 'risk budget', meaning: 'the most you accept losing on this trade', unit: '$' },
        { symbol: 'stop distance', meaning: 'entry to stop', unit: 'index points' },
        { symbol: 'point value', meaning: 'dollars per point per contract', unit: '$ per point' },
      ],
      assumptions: 'The stop fills at its price; gaps and slippage can make the real loss bigger. Costs come on top.',
      compute: 'positionSize', example: { inputs: { risk: 100, stopPoints: 10, pointValue: 2 }, result: 5 },
    },
    example: {
      kind: 'numeric', inputs: { risk: 100, stopPoints: 10, pointValue: 2 }, compute: 'positionSize', result: 5, unit: 'contracts',
      steps: ['risk per contract = 10 points × $2 = $20', '$100 ÷ $20 = 5', 'size = 5 MNQ contracts'],
    },
    quiz: [
      { q: 'You risk $60 with a 15-point stop on MNQ. How many contracts?', a: '2: each contract risks 15 × $2 = $30, and $60 ÷ $30 = 2.', check: { compute: 'positionSize', inputs: { risk: 60, stopPoints: 15, pointValue: 2 }, result: 2, shown: ['2', '$30'] } },
      { q: 'Which comes first, the position size or the stop?', a: 'The stop, where the idea is proven wrong; the size follows from it.' },
      { q: 'What does a 1% risk rule mean on a $10,000 account?', a: 'Risk at most $100 on one trade.' },
    ],
    misconceptions: ['A tight stop is not automatically lower risk: it can mean a bigger size, more stop-outs and more slippage.'],
    sources: [
      ref('Money management', 'Wikipedia', 'https://en.wikipedia.org/wiki/Money_management'),
      THARP, CME_MNQ, CHE_CODE('trading_desk.js'),
    ],
  }),
  card({
    id: 'expectancy', domain: 'trading', title: 'Expectancy', level: 'intermediate',
    summary: 'What a strategy makes or loses on an average trade, over many trades.',
    aliases: ['expectancy', 'expected value', 'statistical edge', 'expected r', 'average r', 'expected return per trade'],
    tags: ['statistics', 'performance'], prerequisites: ['r-multiple'], related: ['win-rate-ci', 'profit-factor', 'sample-size'],
    levels: {
      beginner: 'Expectancy is what a strategy makes or loses on an average trade, over many trades. A strategy can lose more often than it wins and still have a positive expectancy if its wins are big enough, and one that wins often can still lose money if its losses are bigger.',
      intermediate: 'In R: expectancy = win rate × average win − loss rate × average loss, which is the same as the mean of all the trades\' R-multiples. Winning 40% of the time at +2R and losing 60% at −1R gives 0.4 × 2 − 0.6 × 1 = +0.2R a trade: risking $50 a trade, about $10 a trade on average over the long run, before costs.',
      expert: 'Expectancy is an estimate with uncertainty: its 95% range is roughly the mean ± 1.96 × s ÷ √n, so a positive mean whose range includes zero is not yet evidence of an edge. Measure it after costs and slippage, out of sample, on trades taken by fixed rules; tuning rules on the same data that measures them inflates it. CHE\'s promotion test asks for a 95% range above zero, at least 30 out-of-sample trades and profitable walk-forward folds.',
    },
    analogy: 'Expectancy is like a shop\'s average profit per customer: some buy nothing and some buy a lot, but the average over many days decides whether the shop survives.',
    formula: {
      name: 'Expectancy in R', expression: 'E[R] = p × W − (1 − p) × L',
      spoken: 'expectancy equals the win rate times the average win, minus the loss rate times the average loss, all in R',
      variables: [
        { symbol: 'p', meaning: 'win rate', unit: 'a fraction from 0 to 1' },
        { symbol: 'W', meaning: 'average winning trade', unit: 'R' },
        { symbol: 'L', meaning: 'average losing trade, as a positive number', unit: 'R' },
      ],
      assumptions: 'No breakeven trades (otherwise use the mean of all R-multiples); measured after costs on many out-of-sample trades taken by fixed rules.',
      compute: 'expectancy', example: { inputs: { p: 0.4, win: 2, loss: 1 }, result: 0.2 },
    },
    example: {
      kind: 'numeric', inputs: { p: 0.4, win: 2, loss: 1 }, compute: 'expectancy', result: 0.2, unit: 'R',
      steps: ['wins: 0.4 × 2R = 0.8R', 'losses: 0.6 × 1R = 0.6R', 'expectancy = 0.8 − 0.6 = +0.2R per trade'],
    },
    quiz: [
      { q: 'Win rate 50%, average win 1.5R, average loss 1R. What is the expectancy?', a: '+0.25R: 0.5 × 1.5 − 0.5 × 1.', check: { compute: 'expectancy', inputs: { p: 0.5, win: 1.5, loss: 1 }, result: 0.25, shown: ['+0.25R'] } },
      { q: 'Can a strategy that wins only 30% of the time have a positive expectancy?', a: 'Yes, if its average win is more than about 2.33 times its average loss.' },
      { q: 'Why isn\'t a positive average over 12 trades proof of an edge?', a: 'The sample is too small: the 95% range of the mean is wide and usually includes zero.' },
    ],
    misconceptions: ['A high win rate is not a positive expectancy: what matters is win rate and payoff together.'],
    measured: { metric: 'expectancy', label: 'expectancy' },
    sources: [ref('Expected value', 'Wikipedia', 'https://en.wikipedia.org/wiki/Expected_value'), THARP, CHE_CODE('trading_evidence.js')],
  }),
  card({
    id: 'win-rate-ci', domain: 'trading', title: 'Win rate and its confidence interval', level: 'intermediate',
    summary: 'The share of winning trades, always read with its honest range.',
    aliases: ['win rate', 'win rates', 'winning percentage', 'hit rate', 'strike rate', 'win rate confidence interval', 'confidence interval', 'confidence intervals', 'wilson interval', 'wilson score interval', 'win rate ci'],
    tags: ['statistics', 'performance'], prerequisites: ['r-multiple'], related: ['expectancy', 'sample-size', 'profit-factor'],
    levels: {
      beginner: 'Win rate is the share of trades that made money: 12 winners out of 20 trades is 60%. On its own it says little: a 90% win rate loses money if the rare losses are huge, and with only a few trades the rate is mostly luck.',
      intermediate: 'Report a win rate with its range. The Wilson 95% interval for w wins in n trades stays honest even with few trades: 12 wins in 20 gives about 38.7% to 78.1%, so the true rate could easily be under 50%. The range narrows with 1 ÷ √n, so four times the trades halves its width.',
      expert: 'Wilson\'s centre is (p̂ + z²/2n) ÷ (1 + z²/n) and its half-width z·√(p̂(1 − p̂)/n + z²/4n²) ÷ (1 + z²/n), with z = 1.96 for 95%. Unlike the simple p̂ ± z·√(p̂(1 − p̂)/n), it never goes below 0 or above 100% and still works at 0 or n wins. It assumes independent trades with one fixed win probability, which regime changes and clustered trades break, and a win rate must always be read with the payoff, which is why CHE never reports it alone.',
    },
    analogy: 'A win rate from a few trades is like judging a basketball player on five free throws: they might hit four by luck, so you give a range, not a single number, until you\'ve seen a few hundred.',
    formula: {
      name: 'Wilson 95% interval', expression: 'centre = (p̂ + z²/2n) ÷ (1 + z²/n);  half-width = z·√(p̂(1 − p̂)/n + z²/4n²) ÷ (1 + z²/n);  p̂ = w ÷ n',
      spoken: 'the Wilson interval is a centre plus or minus a half-width: the centre is the win rate plus z squared over 2 n, divided by 1 plus z squared over n, and the half-width is z times the square root of the win rate times the loss rate over n, plus z squared over 4 n squared, divided by the same 1 plus z squared over n',
      variables: [
        { symbol: 'w', meaning: 'winning trades', unit: 'a count' },
        { symbol: 'n', meaning: 'all trades', unit: 'a count' },
        { symbol: 'z', meaning: '1.96 for a 95% interval', unit: 'standard deviations' },
      ],
      assumptions: 'Independent trades with one fixed win probability; z = 1.96 for 95%.',
      compute: 'wilson', example: { inputs: { wins: 12, n: 20 }, result: { low: 0.3866, high: 0.7812 } },
    },
    example: {
      kind: 'numeric', inputs: { wins: 12, n: 20 }, compute: 'wilson', result: { low: 0.3866, high: 0.7812 }, unit: 'win probability',
      steps: ['p̂ = 12 ÷ 20 = 0.60', 'centre = (0.60 + 0.096) ÷ 1.192 = 0.584', 'half-width = 1.96 × √(0.012 + 0.0024) ÷ 1.192 = 0.197', '95% range = about 38.7% to 78.1%'],
    },
    quiz: [
      { q: 'You won 6 of your last 10 trades. Is your win rate 60%?', a: 'Measured, yes, but the 95% range is about 31% to 83%, so the true rate is very uncertain.', check: { compute: 'wilson', inputs: { wins: 6, n: 10 }, result: { low: 0.3127, high: 0.8318 }, shown: ['31%', '83%'] } },
      { q: 'Why can a 90% win rate still lose money?', a: 'If the average loss is more than nine times the average win, the losses outweigh the wins.' },
      { q: 'How many more trades roughly halve the width of the range?', a: 'About four times as many, because the width shrinks with 1 ÷ √n.' },
    ],
    misconceptions: ['A 60% win rate from 10 trades is not "a 60% strategy": the honest range runs from about 31% to 83%.'],
    measured: { metric: 'win_rate', label: 'win rate' },
    sources: [
      ref('Binomial proportion confidence interval (Wilson score interval)', 'Wikipedia', 'https://en.wikipedia.org/wiki/Binomial_proportion_confidence_interval'),
      ref('Probable Inference, the Law of Succession, and Statistical Inference (1927)', 'Edwin B. Wilson', 'https://doi.org/10.1080/01621459.1927.10502953'),
      CHE_CODE('trading_evidence.js'),
    ],
  }),
  card({
    id: 'profit-factor', domain: 'trading', title: 'Profit factor', level: 'intermediate',
    summary: 'Dollars won for every dollar lost: gross profit divided by gross loss.',
    aliases: ['profit factor', 'profit factors', 'gross profit to gross loss', 'gross profit and gross loss'],
    tags: ['statistics', 'performance'], prerequisites: ['r-multiple'], related: ['expectancy', 'drawdown', 'win-rate-ci'],
    levels: {
      beginner: 'Profit factor is how many dollars a strategy made for every dollar it lost: all the winning trades added up, divided by all the losing trades added up. Above 1 it made money overall, below 1 it lost, and exactly 1 broke even.',
      intermediate: 'Profit factor = gross profit ÷ gross loss, with the loss counted as a positive number, after costs: $600 won and $400 lost gives 1.5. It folds win rate and payoff into one number, but it ignores the order of trades, so two strategies with the same profit factor can have very different drawdowns. With no losing trades it is undefined, not infinite proof of skill.',
      expert: 'Profit factor ties to the payoff: with win rate p and payoff ratio b, average win ÷ average loss, PF = p·b ÷ (1 − p) when there are no breakeven trades. A few outliers move it a lot, so one huge win can carry a weak strategy; check it with the largest trade removed and fold by fold in a walk-forward test. CHE\'s promotion test asks for a profit factor above 1.2 after costs, out of sample, together with a positive expectancy range.',
    },
    analogy: 'Profit factor is like a farmer comparing what the harvest sold for with what the seed and fuel cost: above 1 the season paid, below 1 it cost him.',
    formula: {
      name: 'Profit factor', expression: 'PF = gross profit ÷ gross loss',
      spoken: 'profit factor equals gross profit divided by gross loss',
      variables: [
        { symbol: 'gross profit', meaning: 'the winning trades added up, after costs', unit: '$' },
        { symbol: 'gross loss', meaning: 'the losing trades added up, as a positive number', unit: '$' },
      ],
      assumptions: 'After costs; undefined when no trade lost.',
      compute: 'profitFactor', example: { inputs: { pnl: [200, -100, 250, -150, 150, -150] }, result: 1.5 },
    },
    example: {
      kind: 'numeric', inputs: { pnl: [200, -100, 250, -150, 150, -150] }, compute: 'profitFactor', result: 1.5, unit: 'ratio',
      steps: ['trades: +200, −100, +250, −150, +150, −150', 'gross profit = 200 + 250 + 150 = $600', 'gross loss = 100 + 150 + 150 = $400', 'profit factor = 600 ÷ 400 = 1.5'],
    },
    quiz: [
      { q: 'Winners total $900 and losers $600. What is the profit factor?', a: '1.5: 900 ÷ 600.', check: { compute: 'profitFactor', inputs: { pnl: [900, -600] }, result: 1.5, shown: ['1.5'] } },
      { q: 'What does a profit factor of 0.8 mean?', a: 'The strategy lost money: 80 cents won for every dollar lost.' },
      { q: 'Win rate 50% and an average win twice the average loss: what is the profit factor?', a: '2: 0.5 × 2 ÷ 0.5.', check: { compute: 'profitFactor', inputs: { pnl: [2, -1] }, result: 2, shown: ['2'] } },
    ],
    misconceptions: ['A profit factor above 1 in a backtest is not an edge until it holds out of sample and after costs.'],
    measured: { metric: 'profit_factor', label: 'profit factor' },
    sources: [PARDO, CHE_CODE('trading_evidence.js')],
  }),
  card({
    id: 'drawdown', domain: 'trading', title: 'Maximum drawdown', level: 'intermediate',
    summary: 'How far the account fell from its highest point; the maximum is the worst such fall.',
    aliases: ['drawdown', 'drawdowns', 'max drawdown', 'maximum drawdown', 'mdd', 'peak to trough', 'equity drawdown'],
    tags: ['risk', 'statistics'], prerequisites: ['r-multiple'], related: ['risk-management', 'profit-factor', 'sample-size'],
    levels: {
      beginner: 'Drawdown is how far your account has fallen from its highest point. If it grew to $11,000 and then dropped to $9,900, the drawdown is $1,100, or 10%. The maximum drawdown is the deepest fall over the whole history: the worst stretch you would have had to sit through.',
      intermediate: 'Follow the equity trade by trade, keep the highest value so far, the peak, and the drawdown at each point is peak − equity; the maximum drawdown is the largest of those. Profits of +100, −50, −80, +200 and −30 give equity of 100, 50, −30, 170 and 140, and a maximum drawdown of 130, from the peak of 100 down to −30. Recovery is harder than the fall: a 50% loss needs a 100% gain to get back.',
      expert: 'Maximum drawdown depends on the order of trades, so one backtest shows only one path; reshuffling the same trades, a Monte Carlo of the sequence, shows how deep it could plausibly have been. Drawdowns get deeper with more trades and more volatility, so the worst is usually still ahead of a short record. After a fractional drawdown d, recovery needs a gain of d ÷ (1 − d). Ratios such as Calmar, return ÷ maximum drawdown, compare strategies on this pain.',
    },
    analogy: 'Drawdown is like a hiker\'s drop from the highest point reached so far: the summit only counts until the trail goes down, and what matters is how deep the valley gets before the next climb.',
    formula: {
      name: 'Maximum drawdown', expression: 'MDD = max over t of (highest equity up to t − equity at t)',
      spoken: 'maximum drawdown is the largest gap between the highest equity reached so far and the equity at any later point',
      variables: [{ symbol: 'equity at t', meaning: 'closed-trade equity after trade t, starting from zero', unit: '$ or R' }],
      assumptions: 'Closed trades in time order, starting from zero; swings while a trade is open can make the real drawdown deeper.',
      compute: 'maxDrawdown', example: { inputs: { pnl: [100, -50, -80, 200, -30] }, result: 130 },
    },
    example: {
      kind: 'numeric', inputs: { pnl: [100, -50, -80, 200, -30] }, compute: 'maxDrawdown', result: 130, unit: '$',
      steps: ['equity: 100, 50, −30, 170, 140', 'peak so far: 100, 100, 100, 170, 170', 'drawdown: 0, 50, 130, 0, 30', 'maximum drawdown = $130'],
    },
    quiz: [
      { q: 'An account falls from $20,000 to $15,000. What is the drawdown in percent?', a: '25%: $5,000 ÷ $20,000.' },
      { q: 'After a 25% drawdown, what gain gets back to the peak?', a: 'About 33.3%: 0.25 ÷ 0.75.' },
      { q: 'Why can the next drawdown be deeper than the backtest\'s?', a: 'The backtest shows one order of trades; other orders and a longer history can go deeper.' },
    ],
    misconceptions: ['A backtest\'s maximum drawdown is not the worst you will see: it is the worst of one path.'],
    measured: { metric: 'max_drawdown', label: 'maximum drawdown' },
    sources: [ref('Drawdown (economics)', 'Wikipedia', 'https://en.wikipedia.org/wiki/Drawdown_(economics)'), CHE_CODE('trading_evidence.js')],
  }),
  card({
    id: 'vwap', domain: 'trading', title: 'VWAP', level: 'intermediate',
    summary: 'The session\'s average traded price, weighted by volume.',
    aliases: ['vwap', 'volume weighted average price', 'volume-weighted average price', 'anchored vwap'],
    tags: ['indicators', 'intraday'], prerequisites: ['bid-ask-spread'], related: ['bid-ask-spread', 'sample-size'],
    levels: {
      beginner: 'VWAP, the volume-weighted average price, is the average price traded so far in the session, where prices that traded more volume count more. Traders use it as a fair-value line: price above VWAP means buyers have paid up on average, below it means sellers have pushed it down.',
      intermediate: 'VWAP = Σ(typical price × volume) ÷ Σ volume, added up bar by bar from the session start, with typical price = (high + low + close) ÷ 3 on bar data. It starts again each session, so it is an intraday tool. Big traders judge their own fills against it: buying below VWAP counts as a good execution.',
      expert: 'On bars the typical price is an approximation; the true VWAP adds up every trade\'s price × size. The session start decides the value, so a futures VWAP from the 6 p.m. open differs from one anchored at the 9:30 New York open, and an anchored VWAP starts from a chosen event instead. Deviation bands use the volume-weighted standard deviation of price around VWAP. VWAP describes, it does not predict: price crossing it is not an edge without tested evidence.',
    },
    analogy: 'VWAP is like the average price per gallon a gas station sold at today, where a truck filling 100 gallons counts for more than a scooter filling one.',
    che_note: 'CHE computes a session VWAP from her stored, delayed MNQ bars when you ask for a market read, for example "analyze MNQ with VWAP" (trading_live_chat.js); /trade-liquidity marks swing highs and lows and does not compute it. The numbers on this card are a worked example, not a market reading.',
    formula: {
      name: 'VWAP', expression: 'VWAP = Σ(TPᵢ × Vᵢ) ÷ ΣVᵢ,  TP = (H + L + C) ÷ 3',
      spoken: 'VWAP equals the sum of typical price times volume, divided by the sum of volume, where typical price is high plus low plus close, divided by 3',
      variables: [
        { symbol: 'TP', meaning: 'typical price of a bar', unit: 'price' },
        { symbol: 'V', meaning: 'volume traded in the bar', unit: 'contracts or shares' },
        { symbol: 'H, L, C', meaning: 'the bar\'s high, low and close', unit: 'price' },
      ],
      assumptions: 'Summed from the session start; the bar typical price approximates the true trade-by-trade VWAP.',
      compute: 'vwap', example: { inputs: { bars: [{ h: 101, l: 99, c: 100, v: 100 }, { h: 104, l: 100, c: 102, v: 200 }, { h: 103, l: 98, c: 99, v: 100 }] }, result: 101 },
    },
    example: {
      kind: 'numeric', inputs: { bars: [{ h: 101, l: 99, c: 100, v: 100 }, { h: 104, l: 100, c: 102, v: 200 }, { h: 103, l: 98, c: 99, v: 100 }] }, compute: 'vwap', result: 101, unit: 'price',
      steps: ['typical prices: 100, 102 and 100', 'price × volume: 10,000 + 20,400 + 10,000 = 40,400', 'volume: 100 + 200 + 100 = 400', 'VWAP = 40,400 ÷ 400 = 101'],
    },
    quiz: [
      { q: 'Two trades: 100 contracts at 10 and 300 at 12. What is the VWAP?', a: '11.5: 100 × 10 plus 300 × 12, divided by 400.', check: { compute: 'vwap', inputs: { bars: [{ h: 10, l: 10, c: 10, v: 100 }, { h: 12, l: 12, c: 12, v: 300 }] }, result: 11.5, shown: ['11.5'] } },
      { q: 'Does VWAP carry over from yesterday?', a: 'No. It starts again at each session, unless you anchor it somewhere else on purpose.' },
      { q: 'Is a close above VWAP a buy signal?', a: 'Not by itself. VWAP describes the session; only tested evidence turns a rule into an edge.' },
    ],
    misconceptions: ['VWAP is not a support line that price must respect: it is an average of what already traded.'],
    sources: [ref('Volume-weighted average price', 'Wikipedia', 'https://en.wikipedia.org/wiki/Volume-weighted_average_price'), CHE_CODE('trading_live_chat.js (marketRead)')],
  }),
  card({
    id: 'sample-size', domain: 'trading', title: 'Sample size and out-of-sample testing', level: 'expert',
    summary: 'A few trades can look great by luck; only many trades, on untouched data, are evidence.',
    aliases: ['sample size', 'sample sizes', 'out of sample', 'out-of-sample', 'out of sample testing', 'walk forward', 'walk-forward', 'walk forward testing', 'walk forward analysis', 'overfitting', 'curve fitting', 'standard error', 'statistical significance', 'backtest overfitting'],
    tags: ['statistics', 'research', 'advanced'], prerequisites: ['expectancy', 'win-rate-ci'], related: ['drawdown', 'profit-factor', 'expectancy'],
    levels: {
      beginner: `A handful of trades can look great by pure luck, the way a coin can land heads five times in a row. Results start to mean something only after many trades, and only on data the strategy was not tuned on. CHE treats fewer than ${MIN_TRADES} trades as anecdote, not evidence.`,
      intermediate: 'The uncertainty of an average shrinks with the square root of the sample: the standard error of the mean R is s ÷ √n, and the 95% range is the mean ± 1.96 × s ÷ √n. A mean of 0.2R with a spread of 1.2R over 36 trades has a standard error of 0.2R, so the range is about −0.19R to +0.59R: it includes zero, so no edge is shown yet. Walk-forward testing tunes nothing on the test period: the rules are frozen, then measured on later data, fold by fold.',
      expert: `Testing many variants and keeping the best is selection bias: the winner's backtest overstates its future, the more so the more variants were tried, so the bar for evidence must rise with the number tested. Look-ahead (using data not yet known at the time), survivorship (only instruments that still exist) and leaving out costs all inflate results. CHE's evidence engine computes indicators from past bars only, journals losing trades and failed experiments, and promotes nothing without ${MIN_TRADES} or more out-of-sample trades, an expectancy range above zero, a profit factor above 1.2 and mostly profitable walk-forward folds.`,
    },
    analogy: 'A small sample is like judging a restaurant on one meal: maybe the chef had a great night. You trust the rating only after many meals, ideally ones the restaurant didn\'t know you were judging.',
    formula: {
      name: '95% range of the mean R', expression: 'mean ± 1.96 × s ÷ √n',
      spoken: 'the 95 percent range is the mean plus or minus 1.96 times the standard deviation divided by the square root of n',
      variables: [
        { symbol: 'mean', meaning: 'average R per trade', unit: 'R' },
        { symbol: 's', meaning: 'sample standard deviation of R', unit: 'R' },
        { symbol: 'n', meaning: 'trades', unit: 'a count' },
      ],
      assumptions: `Independent trades; the normal approximation is rough below about ${MIN_TRADES} trades.`,
      compute: 'meanCi', example: { inputs: { mean: 0.2, sd: 1.2, n: 36 }, result: { low: -0.192, high: 0.592 } },
    },
    example: {
      kind: 'numeric', inputs: { mean: 0.2, sd: 1.2, n: 36 }, compute: 'meanCi', result: { low: -0.192, high: 0.592 }, unit: 'R',
      steps: ['standard error = 1.2 ÷ √36 = 0.2R', '1.96 × 0.2 = 0.392R', '95% range = 0.2 ± 0.392 = −0.192R to +0.592R, which includes zero'],
    },
    quiz: [
      { q: 'Mean 0.3R, standard deviation 1.5R, 100 trades: what is the 95% range?', a: 'About +0.006R to +0.594R: 0.3 ± 1.96 × 0.15, just above zero.', check: { compute: 'meanCi', inputs: { mean: 0.3, sd: 1.5, n: 100 }, result: { low: 0.006, high: 0.594 }, shown: ['+0.006R', '+0.594R'] } },
      { q: 'How many trades does it take to halve the standard error?', a: 'Four times as many, because it shrinks with √n.' },
      { q: 'You tested 50 variants and kept the best. Why is its backtest too optimistic?', a: 'Selection bias: the best of many is partly the luckiest, so its future is likely worse.' },
    ],
    misconceptions: ['More backtest variants do not make the best one more trustworthy: they make it more likely to be luck.'],
    measured: { metric: 'sample', label: 'sample size' },
    sources: [
      ref('Standard error', 'Wikipedia', 'https://en.wikipedia.org/wiki/Standard_error'),
      ref('Walk forward optimization', 'Wikipedia', 'https://en.wikipedia.org/wiki/Walk_forward_optimization'),
      ref('The Probability of Backtest Overfitting', 'David H. Bailey, Jonathan M. Borwein, Marcos López de Prado and Qiji Jim Zhu'),
      PARDO, CHE_CODE('trading_evidence.js'),
    ],
  }),
];

/** Every card, coding first, each domain in curriculum order (the order "what's next" follows). */
export const ATLAS_CARDS = Object.freeze([...CODING, ...TRADING]);
const BY_ID = new Map(ATLAS_CARDS.map((c) => [c.id, c]));
export function atlasCard(id) { return BY_ID.get(String(id || '')) || null; }
const inDomain = (domain) => ATLAS_CARDS.filter((c) => c.domain === domain);

// ─── Understanding the owner's words ──────────────────────────────────────

// Spoken and typed forms meet here: CHE's name, politeness, apostrophes and end punctuation go.
function speech(message) {
  return String(message || '').trim().toLowerCase().replace(/[’‘]/g, "'")
    .replace(/^(?:(?:hey|hi|ok|okay)[\s,.!]+)?(?:che|chay|chey|shay)(?![a-z'])[\s,.:;!?-]*/, '')
    .replace(/^(?:(?:please|can you|could you|would you|will you)\s+)+/, '')
    .replace(/\s+(?:please|for me|sir)$/, '')
    .replace(/[.!?]+$/, '').replace(/\s+/g, ' ').trim();
}

// Words that carry no topic: "teach me about how recursion works" is about recursion.
const FILLER = new Set(['about', 'on', 'in', 'the', 'a', 'an', 'how', 'what', 'to', 'of', 'me', 'some', 'is', 'are', 'works', 'work', 'means', 'mean', 'concept', 'idea', 'basics', 'basic', 'again', 'now', 'today', 'detail', 'step', 'by', 'more', 'please', 'that', 'this', 'with', 'it', 'its', 'and', 'for', 'python', 'javascript', 'js', 'dart', 'code', 'programming', 'trading', 'futures', 'whole', 'topic', 'lesson', 'card']);
const stemWord = (w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const words = (text) => String(text || '').toLowerCase().replace(/'/g, '').replace(/[^a-z0-9²]+/g, ' ').trim().split(' ').filter(Boolean);
/** A topic as the matcher compares it: lower case, no punctuation, no filler words, light singulars. */
export function topicKey(text) {
  return words(text).filter((w) => !FILLER.has(w)).map(stemWord).join(' ');
}
const ALIAS_KEYS = new Map();
for (const c of ATLAS_CARDS) {
  for (const name of [c.id, c.title, ...c.aliases]) {
    const key = topicKey(name);
    if (key && !ALIAS_KEYS.has(key)) ALIAS_KEYS.set(key, c);
  }
}

/** The card a topic names exactly (after filler words are set aside), or null. Never a near guess. */
export function findAtlasCard(topic) {
  const key = topicKey(topic);
  return key ? ALIAS_KEYS.get(key) || null : null;
}

// Whole words only: "trade-offs", "trader-joe's" or "options" inside a longer word never count, so a
// word that is part of a hyphenated or possessive word is not a domain word.
const wholeWords = (alternatives) => new RegExp(`(?<![\\w'’-])(?:${alternatives})(?![\\w'’-])`);
const CODING_WORDS = wholeWords('code|coding|coder|programs?|programming|programmers?|software|algorithms?|data structures?|python|javascript|typescript|java|dart|flutter|swift|kotlin|rust|golang|sql|databases?|apis?|https?|git|github|compilers?|debugging|debuggers?|linux|bash|regex|regular expressions?|object oriented|oop|inheritance|threads?|docker|kubernetes|cloudflare|durable objects?|react|html|css|web development|frontend|backend|machine learning|neural networks?|llms?|linked lists?|binary trees?|graph algorithms?|dynamic programming|garbage collection|encryption|cryptography|oauth|websockets?|unit tests?|devops');
const TRADING_WORDS = wholeWords('trade|trades|trading|traders?|markets?|stocks?|shares|equities|futures|options?|forex|crypto|bitcoin|ethereum|nq|mnq|nasdaq|s&p|spx|spy|qqq|backtests?|backtesting|strateg(?:y|ies)|risk|charts?|candles?|candlesticks?|orders?|brokers?|brokerage|leverage|margin|volatility|atr|ema|sma|moving averages?|rsi|macd|bollinger|fvg|fair value gaps?|order blocks?|liquidity|ict|smart money|scalping|day trading|swing trading|sharpe|sortino|calmar|greeks|delta|gamma|theta|vega|implied volatility|monte carlo|portfolios?|hedging|short selling|dividends?|etfs?|paper trading|live trading');
const domainOf = (text) => (TRADING_WORDS.test(text) ? 'trading' : CODING_WORDS.test(text) ? 'coding' : '');
const BARE_DOMAIN = { coding: 'coding', code: 'coding', programming: 'coding', trading: 'trading', 'the markets': 'trading', markets: 'trading' };

// A lesson is about a concept. These mark a request about the owner's or CHE's own data and work
// instead ("my trading performance", "every trade you made", "the code you changed in PR 352",
// "why the deploy failed"), which belongs to the routes that hold those records.
const PERSONAL = wholeWords("my|mine|your|yours|our|ours|their|theirs|his|her|you|we|i|me|us");
const NOT_A_CONCEPT = new RegExp(`${wholeWords('why|which|whose|when|where|did|does|made|changed?|changes|changing|failed|fails?|failure|bugs?|errors?|commits?|diffs?|deploy(?:ed|s|ment)?|merged?|branch|pull requests?|pr|job|jobs|today|yesterday|last|latest|recent').source}|#\\d+|\\bpr\\s*\\d+|\\b[\\w-]+\\.(?:js|mjs|cjs|ts|tsx|dart|py|json|ya?ml|md|swift|kt|java|go|rs|html|css)\\b`);
// A second request in the same sentence ("... and email it to Mark", "... and switch to live
// trading") is never swallowed by a lesson: the whole turn goes on to the normal routes.
const SECOND_ACTION = /(?:,|;|\band\b|\bthen\b|\balso\b|\bplus\b)\s+(?:then\s+|also\s+|please\s+|you\s+)?(?:e-?mail|send|text|message|mail|switch|turn|open|close|start|stop|pause|resume|run|launch|deploy|merge|buy|sell|pay|order|delete|remove|book|call|post|upload|publish|place|schedule|remind|save|share|connect|disconnect|cancel|play|make|build|create|write|draft|set|change|move|go|put|add|fix|update|check|look|research|find|search|tell|ask|read)\b/;
// "for MNQ", "on futures": a contract or market named after a concept does not change the concept.
const QUALIFIER = /\s+(?:for|on|in|with|of)\s+(?:an?\s+|the\s+|one\s+)?(?:mnq|nq|es|mes|micros?|minis?|e-?minis?|futures?|contracts?|trades?|stocks?|shares|options?|the market|markets?)$/;

const conceptTopic = (topic) => !PERSONAL.test(topic) && !NOT_A_CONCEPT.test(topic);

// "like I'm a beginner", "the expert version", "simply": the depth the owner asked for.
const LEVEL_PHRASES = [
  [/\b(?:like|as if|as though) (?:i'?m|im|i am) (?:a |an )?(?:complete |total )?(?:beginner|newbie|new(?: to (?:this|it))?|novice|five|5|kid|child)\b|\blike (?:a |an )?(?:complete |total )?(?:beginner|newbie|novice)\b|\b(?:for|to) (?:a |an )?(?:complete |total )?(?:beginners?|newbies?|novices?|kids?)\b|\bin (?:simple|plain|easy) (?:terms|words|english)\b|\b(?:simply|simple version|beginner version|beginner level|basic version|easy version)\b|\bat (?:a |the )?beginner level\b/, 'beginner'],
  [/\b(?:like|as if|as though) (?:i'?m|im|i am) (?:an? )?(?:expert|pro|professional)\b|\blike (?:an? )?(?:expert|pro|professional)\b|\b(?:for|to) (?:an? )?(?:experts?|pros?|professionals?)\b|\b(?:in depth|in full depth|advanced version|expert version|expert level|advanced level|the hard version)\b|\bat (?:an |the )?(?:expert|advanced) level\b/, 'expert'],
  [/\b(?:intermediate version|intermediate level|practical version|middle version)\b|\bat (?:an |the )?intermediate level\b/, 'intermediate'],
];
function takeLevel(text) {
  for (const [re, level] of LEVEL_PHRASES) {
    if (re.test(text)) return { level, rest: text.replace(re, ' ').replace(/\s+/g, ' ').trim() };
  }
  return { level: '', rest: text };
}
const EXPLAIN_LEVEL = { simple: 'beginner', normal: 'intermediate', deeper: 'expert' };
const LEVEL_WORDS = { beginner: 'beginner', simple: 'beginner', simpler: 'beginner', basic: 'beginner', easy: 'beginner', easier: 'beginner', intermediate: 'intermediate', practical: 'intermediate', middle: 'intermediate', expert: 'expert', advanced: 'expert', hard: 'expert', harder: 'expert', full: 'expert', deeper: 'expert' };

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, for: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
const numberOf = (w) => (/^\d{1,2}$/.test(w) ? Number(w) : NUMBER_WORDS[w] || null);

const CARD_MARK = /Knowledge Atlas card "([^"]+)"/;
/** What CHE's last reply was about, read from that reply's own source line. Older turns don't count. */
export function atlasContext(history = []) {
  const last = [...(Array.isArray(history) ? history : [])].reverse().find((h) => String(h?.role) === 'assistant');
  const text = String(last?.content || last?.text || '');
  const title = CARD_MARK.exec(text)?.[1] || '';
  const found = ATLAS_CARDS.find((c) => c.title === title) || null;
  const level = /^.+?, (beginner|intermediate|expert) level, sir\./.exec(text)?.[1] || '';
  // A numbered list CHE just read: number -> card id. Only her own atlas lists count.
  const numbered = /^(?:(?:Coding|Trading) cards in the Knowledge Atlas|The Knowledge Atlas has)/.test(text)
    ? [...text.matchAll(/(?:^|\n)(\d{1,2})\. ([^\n]+?), (?:beginner|intermediate|expert)\./g)]
    : [];
  const list = numbered.length ? numbered.reduce((m, [, n, t]) => (m[n] = ATLAS_CARDS.find((c) => c.title === t)?.id || '', m), {}) : null;
  // A graded answer ("Question 2 on Recursion, sir: correct.") keeps the quiz open for the next one.
  const graded = /^Question (\d{1,2}) on /.exec(text);
  return { card: found, level, quiz: /^Quiz on /.test(text) || Boolean(graded), quizAt: graded ? Number(graded[1]) : 0, quizList: /for a quiz, sir/.test(text), list, progress: /^(?:Your (?:coding |trading )?Knowledge Atlas progress|No (?:coding |trading )?lessons recorded yet)/.test(text) };
}

const THIS = /^(?:this|that|it|this one|that one|this card|that card|this topic|that topic|the same|the same one)$/;

/**
 * The owner's request to the Knowledge Atlas, or null when it is not one. A lesson is answered
 * only when a card names the concept exactly and the sentence asks for nothing else; a topic
 * with no card goes on to the usual routes unless the atlas itself was asked ("/learn ...",
 * "... from the knowledge atlas"). A sentence that asks to pay, buy or delete is never a lesson.
 */
export function atlasIntent(message, history = [], { explainLevel = '' } = {}) {
  const raw = String(message || '');
  if (!raw.trim() || raw.length > 400) return null;
  if (classifyOwnerActions(raw).length) return null;
  let t = speech(raw);
  if (!t) return null;
  const ctx = atlasContext(history);
  const preferred = EXPLAIN_LEVEL[explainLevel] || 'beginner';

  // The atlas asked for by name: the /learn command's request, or "... from the knowledge atlas".
  const prefixed = /^knowledge atlas\s*[:,-]?\s*(.*)$/.exec(t);
  const suffixed = prefixed ? null : /^(.+?)\s+(?:from|in|using|with) (?:the |your )?knowledge atlas$/.exec(t);
  const explicit = Boolean(prefixed || suffixed);
  if (prefixed) {
    t = prefixed[1].trim();
    if (!t) return { kind: 'overview' };
  } else if (suffixed) {
    t = suffixed[1].trim();
  }
  // "Teach me recursion and email it to Mark": two requests, so neither is swallowed here.
  if (!explicit && SECOND_ACTION.test(t)) return null;

  if (/^(?:open|use|show(?: me)?|go to|bring up|read|what(?:'s| is)? in|whats in)\s+(?:the |my |your |che's )?knowledge atlas(?: page)?$/.test(t)) return { kind: 'overview' };

  const list = /^(?:(?:list|show|read|tell|give)(?: me)?|what are) (?:all )?(?:of )?(?:the |your )?(?:(coding|code|programming|trading|all) )?(?:knowledge atlas )?(?:cards|lessons|knowledge atlas topics)(?: (?:in|of|from) (?:the |your )?knowledge atlas)?(?: (?:you have|there are))?$/.exec(t)
    || /^what (?:cards|lessons|topics) (?:do you have|are there|are in the knowledge atlas|can you teach(?: me)?)$/.exec(t)
    || /^(coding|trading) cards$/.exec(t);
  if (list) {
    const d = { coding: 'coding', code: 'coding', programming: 'coding', trading: 'trading' }[list[1] || ''] || 'all';
    return { kind: 'list', domain: d };
  }

  // A number right after CHE read a numbered atlas list.
  const pick = /^(?:(?:number|option|card|lesson) )?(\d{1,2}|[a-z]+)$/.exec(t);
  if (pick && ctx.list && numberOf(pick[1])) {
    const id = ctx.list[String(numberOf(pick[1]))];
    const chosen = atlasCard(id);
    if (chosen) return ctx.quizList ? { kind: 'quiz', card: chosen } : { kind: 'teach', card: chosen, level: preferred };
    return { kind: 'pick_missing', number: numberOf(pick[1]) };
  }

  // Quiz answers, only right after a quiz.
  if (/^(?:(?:give|tell|read|show) me (?:the )?|what (?:are|were) the |the )?(?:quiz )?answers?(?: (?:to|for) (?:the |that |this )?quiz)?$/.test(t)) {
    if (ctx.card && ctx.quiz) return { kind: 'answers', card: ctx.card };
    return /quiz/.test(t) ? { kind: 'no_quiz' } : null;
  }

  const learning = learningIntent(t, ctx);
  if (learning) return learning;

  // "Ask me a question" is a quiz only right after a lesson; "quiz me" with no topic asks which one.
  if (/^ask me (?:a question|some questions|questions)(?: about (?:this|it|that))?$/.test(t)) return ctx.card ? { kind: 'quiz', card: ctx.card } : null;
  const quiz = /^(?:quiz me|test me|give me a quiz)(?: (?:on|about|in|for|with))?(?: (.+))?$/.exec(t);
  if (quiz) {
    const topic = String(quiz[1] || '').trim();
    if (!topic || /^(?:something|anything)$/.test(topic)) return { kind: 'ask_topic', purpose: 'quiz', domain: '' };
    if (THIS.test(topic)) return ctx.card ? { kind: 'quiz', card: ctx.card } : { kind: 'ask_topic', purpose: 'quiz', domain: '' };
    return resolveTopic(topic, { kind: 'quiz', explicit });
  }

  // The formula, by name or for the card just discussed. "How do I calculate my position size" asks
  // for the method, so "my" there names the concept, not a record.
  const formula = /^(?:(?:what(?:'s| is| are)|whats|give me|tell me|show me|read me|say|and)\s+)?(?:the |a )?(?:formula|formulas|equation|math|maths)(?:\s+(?:for|of|behind|in|to))?(?:\s+(.+))?$/.exec(t)
    || /^how (?:do (?:you|i|we)|to|can i|would i|should i) (?:calculate|compute|work out|measure)\s+(?:my\s+|a\s+|an\s+|the\s+)?(.+)$/.exec(t)
    || /^how (?:is|are) (?:the\s+|a\s+|an\s+)?(.+?) (?:calculated|computed|worked out|measured)$/.exec(t);
  if (formula) {
    const topic = String(formula[1] || '').trim();
    if (!topic || THIS.test(topic)) return ctx.card ? { kind: 'formula', card: ctx.card } : null;
    return resolveTopic(topic, { kind: 'formula', explicit });
  }

  // A worked example or the code behind it.
  const example = /^(?:(?:give me|show me|read me|what(?:'s| is)|whats|and)\s+)?(?:an |the |a )?(worked example|example|code example|code|numeric example|numerical example|code for it)(?:\s+(?:for|of|on))?(?:\s+(.+))?$/.exec(t);
  if (example && (example[2] || ctx.card) && !/^(?:code)$/.test(t)) {
    const wantsCode = /code/.test(example[1]);
    const topic = String(example[2] || '').trim();
    if (!topic || THIS.test(topic)) return ctx.card ? { kind: 'example', card: ctx.card, code: wantsCode } : null;
    const found = conceptTopic(topic) ? findAtlasCard(topic) : null;
    return found ? { kind: 'example', card: found, code: wantsCode } : null;
  }

  // Another depth of the card just discussed: "give me the expert version", "go deeper", "simpler".
  const levelOnly = /^(?:(?:give|show|tell|read) me |let'?s (?:do|try|hear) |switch to |go to |now |and )?(?:the |an? )?(beginner|simple|simpler|basic|easy|easier|intermediate|practical|middle|expert|advanced|hard|harder|full|deeper) (?:version|level|explanation|one|take)(?: (?:of|for|on) (.+))?$/.exec(t);
  const nudge = /^(?:go deeper|deeper|more depth|in more depth|more advanced|go more advanced|harder|level up|make it (?:simpler|easier)|simpler|easier|explain (?:it|that) (?:simpler|more simply|more deeply))$/.exec(t);
  if (levelOnly || nudge) {
    const named = levelOnly?.[2] && conceptTopic(levelOnly[2]) ? findAtlasCard(levelOnly[2]) : null;
    const target = named || ctx.card;
    if (!target) return null;
    let level = levelOnly ? LEVEL_WORDS[levelOnly[1]] : '';
    if (!level) {
      const at = Math.max(0, LEVELS.indexOf(ctx.level || 'beginner'));
      level = /simpl|easi/.test(t) ? LEVELS[Math.max(0, at - 1)] : LEVELS[Math.min(LEVELS.length - 1, at + 1)];
    }
    return { kind: 'teach', card: target, level };
  }

  if (/^(?:what(?:'s| is)|whats) next(?: after (?:this|that|this one|this card|it))?$|^(?:next|next card|next lesson|next topic|the next one|what comes next|what should i learn next|what do i learn next)$/.test(t)) {
    if (ctx.card) return { kind: 'next', card: ctx.card };
    // With no card just discussed, "what should I learn next" asks what to study, from his progress.
    return /\b(?:learn|study) next$/.test(t) ? { kind: 'study_next', domain: '' } : null;
  }

  // Lessons: "teach me X", "explain X like I'm a beginner", "what is X".
  const { level: asked, rest } = takeLevel(t);
  const teach = /^(?:teach me|help me (?:learn|understand)|i (?:want|would like|'d like|d like|wanna) to (?:learn|understand)|i want to learn about|give me a lesson (?:on|about|in)|lesson on|walk me through|explain to me)(?:\s+(.*))?$/.exec(rest);
  if (teach) {
    const topic = String(teach[1] || '').replace(/\s+to me$/, '').trim();
    // Only a bare "teach me" asks which topic; "help me understand" or "walk me through" alone
    // continues the lesson just given, or goes on to the usual routes.
    if (!topic || /^(?:something|anything|stuff)$/.test(topic)) {
      if (/^teach me/.test(rest)) return { kind: 'ask_topic', purpose: 'teach', domain: '' };
      return ctx.card ? { kind: 'teach', card: ctx.card, level: asked || ctx.level || preferred } : null;
    }
    if (THIS.test(topic)) return ctx.card ? { kind: 'teach', card: ctx.card, level: asked || preferred } : null;
    return resolveTopic(topic, { kind: 'teach', level: asked || preferred, explicit });
  }
  // "Explain X", "what is X", "define X", "tell me about X": a lesson only when a card names X.
  const ask = /^(?:explain|define|describe|tell me about)\s+(.+?)(?:\s+to me)?$/.exec(rest);
  const what = ask ? null : /^(?:what(?:'s| is| are)|whats|what does)\s+(?:an? )?(.+?)(?:\s+mean)?$/.exec(rest);
  if (ask || what) {
    const topic = (ask || what)[1];
    // "What is the spread?", "what's my win rate?": a reading of something, not a lesson.
    if (what && !explicit && /^(?:the|my|your|our|his|today'?s|current|this|that)\b/.test(topic)) return null;
    // A bare "what is win rate" asks for CHE's measured numbers, which the evidence route answers.
    if (what && !asked && !explicit && evidenceIntent(raw)) return null;
    return resolveTopic(topic, { kind: 'teach', level: asked || preferred, explicit });
  }
  if (explicit) return resolveTopic(t, { kind: 'teach', level: asked || preferred, explicit: true });
  return null;
}

function resolveTopic(rawTopic, { kind, level = 'beginner', explicit = false }) {
  const topic = rawTopic.replace(QUALIFIER, '').trim();
  const found = conceptTopic(topic) ? findAtlasCard(topic) : null;
  if (found) return kind === 'teach' ? { kind, card: found, level } : { kind, card: found };
  const purpose = kind === 'quiz' ? 'quiz' : 'teach';
  const domain = domainOf(topic);
  // "Quiz me on trading", "/learn coding": the whole domain, so its cards are offered.
  const bare = BARE_DOMAIN[topic.replace(/^the /, '').trim()] || (!topicKey(topic) && domain);
  if (bare && (explicit || kind === 'quiz')) return { kind: 'ask_topic', purpose, domain: bare };
  // No card: the turn goes on to the usual routes, unless the atlas itself was asked.
  return explicit ? { kind: 'missing', topic: topic.slice(0, 80), domain } : null;
}

// ─── The owner's own study: progress, quiz answers, corrections ───────────

const DOMAIN_WORD = { coding: 'coding', code: 'coding', programming: 'coding', trading: 'trading' };
// "… on trading", "… in coding so far": the domain he asks about, taken off the end of the sentence.
const DOMAIN_TAIL = /^(.+?)(?: (?:on|in|with|at|for|of) (?:the |my )?(coding|code|programming|trading)(?: (?:cards|lessons|side))?)?(?: so far| until now| up to now)?$/;
// Always about the atlas: the owner names learning, lessons or a quiz.
const PROGRESS_STRONG = /^(?:what (?:have|did) i (?:learn(?:ed|t)?|stud(?:y|ied)|cover(?:ed)?)|what (?:lessons|cards|topics) (?:have|did) i (?:do(?:ne)?|stud(?:y|ied)|learn(?:ed|t)?|finish(?:ed)?|complete(?:d)?|take|taken)|how many (?:lessons|cards|quizzes|quiz questions) (?:have|did) i (?:do(?:ne)?|stud(?:y|ied)|learn(?:ed|t)?|finish(?:ed)?|complete(?:d)?|take|taken|answer(?:ed)?|get right|got right)|(?:what(?:'s| is| are)?|whats|show(?: me)?|tell me|read(?: me)?|give me) (?:my |the )?(?:learning|study|studying|atlas|knowledge atlas|lesson|quiz) (?:progress|scores?|results|history)|how(?:'s| is) my (?:learning|studying|study)(?: going)?|how am i doing (?:on|in|with) (?:my |the )?(?:lessons|quizzes|knowledge atlas|learning|studies))$/;
// Needs a domain ("how am I doing on trading") or a lesson just before: alone it could mean anything.
const PROGRESS_WEAK = /^(?:how am i doing|how(?:'s| is) my progress(?: going)?|(?:what(?:'s| is)?|whats|show(?: me)?|tell me|read(?: me)?|give me) my (?:progress|scores?))$/;
// "What should I do next" or "suggest a topic" alone is not about study: the lesson words are required.
const STUDY_NEXT = /^(?:what (?:should|do|can|shall) i (?:study|learn) next|what(?:'s| is)? next (?:for me )?to (?:study|learn)|whats next (?:for me )?to (?:study|learn)|(?:what|which) (?:card|lesson) (?:should i|do i|to|shall i) (?:study|learn|take|do)(?: next)?|(?:what|which) topic (?:should i|do i|to|shall i) (?:study|learn)(?: next)?|(?:suggest|recommend|pick) (?:me )?(?:a|the next|my next|the) (?:lesson|card)(?: to (?:study|learn))?|(?:suggest|recommend|pick) (?:me )?(?:a|the next|my next|the) topic to (?:study|learn)|what(?:'s| is)? my next (?:lesson|card)|whats my next (?:lesson|card))$/;
const QUESTION_NUMBER = String.raw`(\d{1,2}|one|two|three|four|five|six|seven|eight|first|second|third|fourth|fifth)`;
const NUMBERED_ANSWER = new RegExp(String.raw`^(?:(?:my |the )?answer (?:to |for )?|for |on )?(?:question |number |no )?${QUESTION_NUMBER}(?:\s*[.:),=-]\s*|\s+(?:is|was)\s+|\s+)(?:(?:the answer is|my answer is|i think it'?s|i think it is|i think|i'?d say|i say|it'?s|its|it is)\s+)?(.+)$`);
const NEXT_ANSWER = /^(?:my answer is|the answer is|i think it'?s|i think it is|i think|i'?d say|i say|is it|answer)\s+(.+)$/;
const CARD_FIX = /^(?:no[, ]+)?(?:(?:that(?:'s| is)|thats|this is|the card is|your card is|that card is|the lesson is|that lesson is|that answer is|your answer is) (?:wrong|not right|incorrect|a mistake|mistaken|outdated)|you(?:'re| are) wrong(?: about (?:that|this|it))?|(?:that|the card|this card) has a mistake)(?:\s*[,:;.-]\s*|\s+)?(.*)$/;

/** Progress, "what should I study next", a quiz answer or a card correction; null for anything else. */
function learningIntent(t, ctx) {
  const tail = DOMAIN_TAIL.exec(t);
  const core = tail ? tail[1] : t;
  const domain = DOMAIN_WORD[tail?.[2] || ''] || '';
  if (PROGRESS_STRONG.test(core) || (PROGRESS_WEAK.test(core) && (domain || ctx.card || ctx.progress))) return { kind: 'progress', domain };
  // Right after a lesson, "what should I learn next" keeps its curriculum meaning: the card after that one.
  if (STUDY_NEXT.test(core) && !(ctx.card && !domain && /\blearn next$/.test(core))) return { kind: 'study_next', domain };
  if (ctx.card && ctx.quiz) {
    const numbered = NUMBERED_ANSWER.exec(t);
    if (numbered) return { kind: 'grade', card: ctx.card, index: numberOf(numbered[1]) - 1, answer: numbered[2].slice(0, 300) };
    const next = NEXT_ANSWER.exec(t);
    if (next) return { kind: 'grade', card: ctx.card, index: ctx.quizAt, answer: next[1].slice(0, 300) };
  }
  const fix = ctx.card ? CARD_FIX.exec(t) : null;
  if (fix) return { kind: 'correction', card: ctx.card, detail: fix[1].slice(0, 400) };
  return null;
}

/** "Reset my progress", "clear my trading quiz scores": a delete, so it runs only after the owner's yes. */
export function atlasResetIntent(message) {
  const t = speech(message);
  const m = /^(?:reset|clear|delete|erase|wipe|remove)(?: out)?(?: all)?(?: of)? my (?:(coding|trading) )?(?:(?:learning|study|atlas|knowledge atlas|lesson|quiz|practice) )*(?:progress|scores|history|records)(?: (?:in|on|for|from) (?:the )?(?:(coding|trading)|knowledge atlas))?$/.exec(t);
  return m ? { kind: 'reset', domain: m[1] || m[2] || '' } : null;
}

const NUMBER_VALUES = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
// Spoken numbers as speech recognition sometimes leaves them: "fifty five" -> 55, "minus two" -> -2.
function spokenDigits(text) {
  return String(text).toLowerCase()
    .replace(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[\s-](one|two|three|four|five|six|seven|eight|nine)\b/g, (_, a, b) => String(NUMBER_VALUES[a] + NUMBER_VALUES[b]))
    .replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/g, (w) => String(NUMBER_VALUES[w]))
    .replace(/\b(?:minus|negative)\s+(?=[$\d])/g, '-').replace(/\b(?:plus|positive)\s+(?=[$\d])/g, '+')
    .replace(/(\d)\s+point\s+(\d)/g, '$1.$2').replace(/(\d)\s+percent\b/g, '$1%');
}
/** The numbers in an answer: "$0.50" is 0.5, "31%" is 0.31, "+2R" is 2, "50 cents" is 0.5. */
function answerNumbers(text) {
  const out = [];
  for (const m of spokenDigits(text).matchAll(/([-+−]?)\$?(\d+(?:,\d{3})*(?:\.\d+)?|\.\d+)\s*(%|cents?\b)?/g)) {
    let x = Number(m[2].replace(/,/g, ''));
    if (!Number.isFinite(x)) continue;
    if (m[1] === '-' || m[1] === '−') x = -x;
    out.push({ x: m[3] ? x / 100 : x, raw: x, marked: Boolean(m[3]) });
  }
  return out;
}
const near = (x, v) => Math.abs(x - v) <= Math.max(0.006, Math.abs(v) * 0.01);
const yesNo = (text) => (/^\s*(?:yes|yeah|yep|yup|correct|true|it does|they do|it is|right)\b/i.test(text) ? 'yes' : /^\s*(?:no|nope|false|it doesn'?t|it does not|they don'?t|not)\b/i.test(text) ? 'no' : '');
const stem5 = (w) => w.replace(/'/g, '').slice(0, 5);

/**
 * Grades one quiz answer with no model. A question with a check is graded by its number, recomputed
 * from the card's formula; a yes-or-no question by the yes or no; any other by the key words of the
 * card's own answer (half of them, at least one), which is a rough check and is said to be one.
 */
export function gradeQuizAnswer(c, index, answer) {
  const q = c?.quiz?.[index];
  if (!q) return null;
  if (q.check && FORMULAS[q.check.compute]) {
    const result = FORMULAS[q.check.compute](q.check.inputs);
    const want = typeof result === 'object' && result ? Object.values(result) : [result];
    const percent = (q.check.shown || []).some((x) => /%/.test(x));
    const nums = answerNumbers(answer).map((n) => (percent && !n.marked ? n.raw / 100 : n.x));
    const correct = want.every((v) => nums.some((x) => near(x, v)));
    return { correct, method: 'the number, recomputed from the card\'s formula', expected: q.a };
  }
  const yn = /^(yes|no)\b/i.exec(q.a);
  if (yn && yesNo(answer)) return { correct: yesNo(answer) === yn[1].toLowerCase(), method: 'the yes or no', expected: q.a };
  const keys = [...new Set(queryTerms(q.a).filter((w) => w.length >= 4 && !/^(?:yes|because|which|that|only|than|more|less|each|every|once|also)$/.test(w)).map(stem5))];
  const said = new Set(queryTerms(spokenDigits(answer)).map(stem5));
  const hits = keys.filter((k) => said.has(k));
  const need = Math.max(1, Math.ceil(keys.length / 2));
  return { correct: hits.length >= need, method: `key words of the card's answer (${hits.length} of ${keys.length}), a rough check`, expected: q.a };
}

// The Brain store for a storage with SQL (the Durable Object); null in plain key-value tests.
function brainOf(storage) {
  if (!storage?.sql) return null;
  try { const store = new CheBrainStore(storage); return store.init() ? store : null; } catch (_) { return null; }
}

const day = (iso) => String(iso || '').slice(0, 10);
const cardName = (id) => atlasCard(id)?.title || String(id || 'a card that is no longer in the atlas');

/**
 * The one recorder for any card in ATLAS_CARDS: { card_id, item_id, kind, correct } plus optional
 * level, question, answer, expected and method. kind is 'lesson', 'quiz', 'correction' or a practice
 * kind such as 'exercise' or 'drill'. A plain key-value storage (no SQL) records nothing and says so.
 */
export function recordAtlasPractice(storage, { card_id, ...event } = {}, { now } = {}) {
  const c = atlasCard(card_id);
  const brain = brainOf(storage);
  if (!c || !brain) return { outcome: 'rejected', reason: c ? 'Brain storage is not available.' : 'No such card.' };
  return recordLearning(brain, { card: c, ...event }, { now });
}

/** "What have I learned so far?": the real counts and the latest results, from his practice records only. */
export function progressText(records, domain = '') {
  const rows = domain ? records.filter((r) => r.source?.domain === domain) : records;
  const where = domain ? `${domain} ` : '';
  if (!rows.length) {
    return `No ${where}lessons recorded yet, sir. Your Knowledge Atlas progress starts when you study a card: say "teach me" and a topic, or "what should I study next".`;
  }
  const lessons = rows.filter((r) => r.source?.event === 'lesson');
  const corrections = rows.filter((r) => r.source?.event === 'correction');
  const graded = rows.filter((r) => !['lesson', 'correction'].includes(r.source?.event));
  const quiz = graded.filter((r) => r.source?.event === 'quiz');
  const practice = graded.filter((r) => r.source?.event !== 'quiz');
  const score = (list) => {
    const marked = list.filter((r) => typeof r.source?.correct === 'boolean');
    const right = marked.filter((r) => r.source.correct).length;
    return marked.length ? `${right} correct (${Math.round((100 * right) / marked.length)}%)` : 'none graded';
  };
  const studied = new Set(lessons.map((r) => r.source.card_id));
  const total = domain ? inDomain(domain).length : ATLAS_CARDS.length;
  const parts = [`${plural(lessons.length, 'lesson')} studied, on ${studied.size} of ${total} ${where}cards`];
  parts.push(`${plural(quiz.length, 'quiz answer')}${quiz.length ? `, ${score(quiz)}` : ''}`);
  if (practice.length) parts.push(`${plural(practice.length, 'practice result')}, ${score(practice)}`);
  if (corrections.length) parts.push(`${plural(corrections.length, 'correction')} you gave me`);
  const lines = [`Your ${where}Knowledge Atlas progress, sir, measured from this chat: ${parts.join('; ')}.`];
  if (lessons.length) lines.push(`Latest lessons: ${lessons.slice(0, 3).map((r) => `${cardName(r.source.card_id)}, ${r.source.level || 'any'} level, ${day(r.created_at)}`).join('; ')}.`);
  if (graded.length) lines.push(`Latest answers: ${graded.slice(0, 3).map((r) => `${cardName(r.source.card_id)}${r.source.item_id ? ` ${r.source.item_id}` : ''}, ${r.source.correct === true ? 'correct' : r.source.correct === false ? 'not correct' : 'not graded'}`).join('; ')}.`);
  lines.push('Say "what should I study next", or "quiz me on" a topic.');
  if (domain === 'trading') lines.push('This is your study of the trading cards; for CHE\'s paper trading results, say "what\'s my win rate".');
  lines.push(`Source: ${plural(rows.length, 'practice record')} in CHE's Brain, Knowledge Atlas folder, labelled owner practice. They record your study in this chat, not facts you told me.`);
  return lines.join('\n');
}

/** The first card, in curriculum order, not yet studied whose prerequisites all are. */
export function nextToStudy(records, domain = '') {
  const studied = new Set(records.filter((r) => r.source?.event === 'lesson').map((r) => r.source.card_id));
  const latest = records.find((r) => r.source?.event === 'lesson' && DOMAINS[r.source?.domain]);
  const order = domain ? [domain] : latest ? [latest.source.domain, latest.source.domain === 'coding' ? 'trading' : 'coding'] : Object.keys(DOMAINS);
  for (const d of order) {
    const card = inDomain(d).find((c) => !studied.has(c.id) && c.prerequisites.every((p) => studied.has(p)));
    if (card) return { card, studied };
  }
  return { card: null, studied };
}

function studyNextText(records, domain) {
  const { card, studied } = nextToStudy(records, domain);
  const where = domain ? `${domain} ` : '';
  if (!card) {
    const total = domain ? inDomain(domain).length : ATLAS_CARDS.length;
    return { text: `You have studied every ${where}card in the Knowledge Atlas, sir: ${total} of ${total}. Say "quiz me on" a topic to test yourself, or "how am I doing" for your scores.`, card: null };
  }
  const pre = card.prerequisites.map((id) => atlasCard(id).title);
  const why = !studied.size
    ? 'No lessons are recorded yet, so this is where the curriculum starts.'
    : pre.length
      ? `Its prerequisite${pre.length === 1 ? '' : 's'}, ${pre.join(' and ')}, ${pre.length === 1 ? 'is' : 'are'} in your studied lessons.`
      : 'It has no prerequisites, and it is the next card you have not studied.';
  const other = !domain && !studied.size ? inDomain(card.domain === 'coding' ? 'trading' : 'coding')[0] : null;
  const also = other ? ` For ${other.domain}, the first card is ${other.title}.` : '';
  return { text: `Next for you, sir: ${card.title}, ${card.level} level. ${card.summary} ${why}${also} Say "teach me ${firstAlias(card)}" to start it.\n${sourceLine(card)}`, card };
}

/** "Reset my progress", after the owner's yes: his practice records become tombstones; the cards stay. */
export function resetAtlasProgress(storage, { domain = '', now } = {}) {
  const brain = brainOf(storage);
  const where = domain ? `${domain} ` : '';
  if (!brain) return { ok: false, deleted: 0, text: 'I could not reach the Brain just now, sir, so nothing was deleted. Please say it again.' };
  const before = learningRecords(brain, { domain }).length;
  if (!before) return { ok: true, deleted: 0, text: `There was no ${where}progress to reset, sir: no lessons recorded yet. Nothing was deleted.` };
  const deleted = resetLearning(brain, { domain, now });
  const left = learningRecords(brain, { domain }).length;
  return {
    ok: deleted === before && !left,
    deleted,
    text: left
      ? `I deleted ${deleted} of your ${where}Knowledge Atlas practice records, sir, but ${left} remain. Say "reset my progress" again to finish.`
      : `Done, sir. I deleted ${plural(deleted, 'practice record')} of your ${where}Knowledge Atlas progress: lessons studied, quiz answers and practice results. The cards themselves are unchanged, and your progress now starts from zero.`,
  };
}

// ─── What CHE says ───────────────────────────────────────────────────────

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
/** How every card names its references, in Chat and on the phone (che-fact-check: a link is not proof). */
export const REFERENCES_LABEL = 'Reference links, not opened or checked by CHE';
const refName = (s) => (s.url || s.title.startsWith('CHE source') ? s.title : `${s.title}, by ${s.author}`);
const sourceLine = (c) => {
  const refs = c.sources.map(refName).join('; ');
  return `Source: Knowledge Atlas card "${c.title}" (${DOMAINS[c.domain].toLowerCase()}), curated teaching content, revision ${c.revision}; CHE's tests check its arithmetic and run its code. ${REFERENCES_LABEL}: ${refs}.`;
};
const firstAlias = (c) => c.aliases[0];
const exampleWords = (c) => (c.example.kind === 'code' ? `${c.example.explain} Say "show me the code" to see it.` : `${c.example.steps.join('; ')}.`);
const formulaWords = (c) => `Formula: ${c.formula.spoken}. Written: ${c.formula.expression}.`;

const fmtR = (x) => (x == null ? 'not measured' : `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(2)}R`);
const money = (x) => (x == null ? 'not measured' : `${x < 0 ? '−' : ''}$${Math.abs(x).toFixed(2)}`);
const range = (values, show) => {
  const v = values.filter((x) => Number.isFinite(x));
  if (!v.length) return '';
  const lo = Math.min(...v); const hi = Math.max(...v);
  return lo === hi ? show(lo) : `${show(lo)} to ${show(hi)}`;
};
const SAMPLE = {
  insufficient: `fewer than the ${MIN_TRADES} trades needed, so this is anecdote, not evidence`,
  low: 'a low sample, still uncertain',
  adequate: 'an adequate sample',
};

/** CHE's records a measured card reads: every closed paper trade, and the latest stored backtest. */
export async function loadAtlasRecords(storage) {
  if (!storage) return { paper: [], backtest: null };
  try {
    const [paper, backtest] = await Promise.all([readTrades(storage, (t) => t?.environment === 'paper'), storage.get(LIVE_BACKTEST)]);
    return { paper: Array.isArray(paper) ? paper : [], backtest: backtest || null };
  } catch (_) {
    return { paper: [], backtest: null, unreadable: true };
  }
}

// One paper portfolio's name: its strategy, contract and bar size, as the journal records them.
function portfolioName(t) {
  const strategy = INTRADAY_CANDIDATES[t?.strategy]?.name || CANDIDATES[t?.strategy]?.name || String(t?.strategy || 'unnamed strategy');
  const bars = t?.data?.resolution === '5m' ? 'five-minute bars' : t?.data?.resolution ? `${t.data.resolution} bars` : 'daily bars';
  return `${cap(strategy)} on ${t?.contract || t?.symbol || 'MNQ'}, ${bars}`;
}

// A 95% range needs at least two trades; below that the sample is only a number.
const rangeOr = (s, show) => {
  if (s.trades < 2) return `too few trades for a range (n = ${s.trades})`;
  // Identical results have no spread, so the formula gives a zero-width range that means nothing.
  if (s.low === s.high) return `no range: all ${s.trades} results are identical, so they show no spread to estimate from`;
  return `95% range ${show(s.low)} to ${show(s.high)}`;
};
// A drawdown is a size of loss, spoken as a plain magnitude: never "plus 4R".
const fmtDepthR = (x) => (x == null ? 'not measured' : `${Math.abs(x).toFixed(2)}R`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The measured line for a trading card, from records only; empty for a card that cites no statistic.
 * Every paper portfolio is its own strategy and its own record, so figures are given per portfolio
 * (a range across them, and the largest one in full), never pooled into one account.
 */
export function measuredText(c, records = { paper: [], backtest: null }) {
  if (!c?.measured) return '';
  if (records.unreadable) return `Your records: I could not read CHE's paper journal just now, so I give no measured ${c.measured.label}.`;
  const groups = new Map();
  for (const t of records.paper || []) {
    const key = String(t?.portfolio || '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const books = [...groups.values()].map((trades) => ({ name: portfolioName(trades[0]), s: summarize(trades) }))
    .sort((a, b) => b.s.trades - a.s.trades || a.name.localeCompare(b.name));
  const parts = [];
  if (!books.length) {
    parts.push(`Your records: no recorded data yet. CHE's paper journal has no closed paper trades, so there is no measured ${c.measured.label}.`);
  } else {
    const total = books.reduce((n, b) => n + b.s.trades, 0);
    const many = books.length > 1;
    const top = books[0];
    const s = top.s;
    const across = (values, show, what) => (many ? ` Across the ${books.length} portfolios, ${what} ranged ${range(values, show)}.` : '');
    const line = {
      expectancy: () => `${top.name}: expectancy ${fmtR(s.expectancy_r)} per trade after assumed costs, ${rangeOr({ trades: s.trades, low: s.expectancy_r_95ci.low, high: s.expectancy_r_95ci.high }, fmtR)}.${across(books.map((b) => b.s.expectancy_r), fmtR, 'expectancy')}`,
      win_rate: () => `${top.name}: win rate ${s.win_rate}%, ${plural(s.wins, 'win')} and ${s.losses} loss${s.losses === 1 ? '' : 'es'}, ${rangeOr({ trades: s.trades, ...(s.win_rate_95ci || {}) }, (x) => `${x}%`)}.${across(books.map((b) => b.s.win_rate), (x) => `${x}%`, 'win rate')}`,
      profit_factor: () => `${top.name}: profit factor ${s.profit_factor ?? 'not defined, because no trade lost'}.${many && range(books.map((b) => b.s.profit_factor), (x) => `${x}`) ? across(books.map((b) => b.s.profit_factor), (x) => `${x}`, 'profit factor') : ''}`,
      max_drawdown: () => `${top.name}: maximum drawdown ${money(s.max_drawdown)}, or ${fmtDepthR(s.max_drawdown_r)}, within that portfolio's own record.${across(books.map((b) => b.s.max_drawdown), money, 'maximum drawdown')} None of these is an account balance.`,
      sample: () => `${books.filter((b) => b.s.trades >= MIN_TRADES).length} of ${plural(books.length, 'portfolio')} reached the ${MIN_TRADES}-trade minimum. ${many ? 'The largest is' : 'It is'} ${top.name}, with ${plural(s.trades, 'closed trade')}: expectancy ${fmtR(s.expectancy_r)}, ${rangeOr({ trades: s.trades, low: s.expectancy_r_95ci.low, high: s.expectancy_r_95ci.high }, fmtR)}.`,
    }[c.measured.metric]();
    const lead = c.measured.metric === 'sample' ? '' : many ? 'The largest is ' : 'It is ';
    const where = many ? `in ${books.length} separate paper portfolios, each its own strategy, so nothing is pooled into one account.` : 'in 1 paper portfolio, one strategy.';
    parts.push(`Your records, measured from CHE's paper journal: ${plural(total, 'closed paper trade')} ${where} ${lead}${line} Largest sample: n = ${s.trades}, ${SAMPLE[s.sample]}.`);
  }
  const bt = records.backtest;
  const rows = bt?.ok && Array.isArray(bt.rows) ? bt.rows.filter((r) => Number(r?.stats?.trades) > 0) : [];
  if (rows.length) {
    const total = rows.reduce((n, r) => n + r.stats.trades, 0);
    const across = {
      expectancy: () => `expectancy ranged ${range(rows.map((r) => r.stats.expectancy_r), fmtR)} across them`,
      win_rate: () => `win rate ranged ${range(rows.map((r) => r.stats.win_rate), (x) => `${x}%`)} across them`,
      profit_factor: () => { const r = range(rows.map((x) => x.stats.profit_factor), (x) => `${x}`); return r ? `profit factor ranged ${r} across them` : 'none had a defined profit factor'; },
      max_drawdown: () => `maximum drawdown ranged ${range(rows.map((r) => r.stats.max_drawdown), money)} across them`,
      sample: () => `${rows.filter((r) => r.stats.trades >= MIN_TRADES).length} of them reached ${MIN_TRADES} trades`,
    }[c.measured.metric]();
    parts.push(`Latest stored backtest, ${String(bt.at || '').slice(0, 10)}, ${bt.data || 'unnamed data'}: ${rows.length} strategy portfolio${rows.length === 1 ? '' : 's'} with ${total} trades; ${across}. A backtest is history, not a forward result.`);
  } else {
    parts.push('No stored backtest with trades yet.');
  }
  return parts.join(' ');
}

const nextOf = (c) => {
  const list = inDomain(c.domain);
  return list[list.indexOf(c) + 1] || null;
};

function speakList(domain, { forQuiz = false } = {}) {
  const shown = domain === 'all' ? ATLAS_CARDS : inDomain(domain);
  const lines = shown.map((c, i) => `${i + 1}. ${c.title}, ${c.level}.`);
  const say = forQuiz ? 'Say a number, or "quiz me on" and a name.' : 'Say a number, or "teach me" and a name.';
  if (domain === 'all') {
    const coding = inDomain('coding').length;
    return `The Knowledge Atlas has ${shown.length} cards${forQuiz ? ', for a quiz' : ''}, sir: ${coding} coding, then ${shown.length - coding} trading.\n${lines.join('\n')}\n${say}`;
  }
  return `${DOMAINS[domain]} cards in the Knowledge Atlas${forQuiz ? ', for a quiz' : ''}, sir: ${shown.length}.\n${lines.join('\n')}\n${say}`;
}

function teachText(c, level, records) {
  const lines = [`${c.title}, ${level} level, sir. ${c.levels[level]}`];
  if (level === 'beginner') lines.push(`Analogy, and only an analogy: ${c.analogy}`);
  if (level !== 'beginner' && c.formula) lines.push(formulaWords(c));
  lines.push(`Worked example: ${exampleWords(c)}`);
  if (level === 'expert' && c.misconceptions.length) lines.push(`Common mistake: ${c.misconceptions[0]}`);
  if (c.che_note) lines.push(`In CHE: ${c.che_note}`);
  const measured = measuredText(c, records);
  if (measured) lines.push(measured);
  const other = LEVELS.filter((l) => l !== level).map((l) => `"the ${l} version"`).join(' or ');
  lines.push(`Next, say ${other}, ${c.formula ? '"what\'s the formula", ' : ''}"quiz me on ${firstAlias(c)}", or "what's next".`);
  lines.push(sourceLine(c));
  return lines.join('\n');
}

/** The reply to an atlasIntent result. Deterministic: records are read, no model is called. */
export async function answerAtlas(intent, { storage = null, now } = {}) {
  const c = intent?.card || null;
  // The Brain holds the cards as curated reference and the owner's practice; the first atlas turn
  // projects the cards (a no-op once their hashes match), and each lesson or graded answer is one record.
  const brain = brainOf(storage);
  if (brain) { try { projectAtlasToBrain(brain, { now }); } catch (_) { /* the lesson still answers */ } }
  const practice = (event) => {
    if (!brain) return { outcome: 'rejected' };
    try { return recordLearning(brain, { card: c, ...event }, { now }); } catch (_) { return { outcome: 'rejected' }; }
  };
  const recorded = (r) => ['created', 'updated', 'unchanged', 'merged'].includes(r?.outcome);
  const total = ATLAS_CARDS.length;
  const coding = inDomain('coding').length;
  const needsRecords = Boolean(c?.measured) && ['teach', 'formula'].includes(intent.kind);
  const records = needsRecords ? await loadAtlasRecords(storage) : { paper: [], backtest: null };
  // A plain hyphen reads aloud as "minus"; the typographic minus is kept for the phone's cards.
  const out = (text, ok = true) => ({ ok, text: text.replace(/−/g, '-'), card_id: c?.id || '', kind: intent?.kind || '' });
  switch (intent?.kind) {
    case 'overview':
      return out(`The Knowledge Atlas has ${total} cards, sir: ${coding} coding and ${total - coding} trading, each from beginner to expert, with an analogy, the formula where there is one, a worked example and a short quiz. On the phone it is in More, under Knowledge Atlas, or say "open the knowledge atlas". Say "list the coding cards", "list the trading cards", or "teach me" and a topic.`);
    case 'list':
      return out(speakList(intent.domain));
    case 'ask_topic':
      if (intent.domain) return out(speakList(intent.domain, { forQuiz: intent.purpose === 'quiz' }));
      return out(`Which topic should I ${intent.purpose === 'quiz' ? 'quiz you on' : 'teach you'}, sir? For example recursion, Big-O, expectancy or risk management. Say "${intent.purpose === 'quiz' ? 'quiz me on' : 'teach me'}" and the topic, or "list the coding cards" or "list the trading cards" to hear them all.`);
    case 'missing': {
      const trading = intent.domain === 'trading' || TRADING_WORDS.test(String(intent.topic || ''));
      const topic = String(intent.topic || '').replace(/^(?:(?:how |about |the )?to |about |the )/, '');
      // The desk is read, never written: a lesson only reports the mode it found.
      const desk = trading ? await Promise.resolve(storage && readDesk(storage)).catch(() => null) : null;
      const mode = !trading ? '' : desk?.mode
        ? `This lesson changed nothing: you are still on ${MODE_NAME[desk.mode]}. `
        : 'This lesson changed nothing about your trading. ';
      return out(`I don't have a Knowledge Atlas card on "${topic}" yet, sir, so I won't make one up. ${mode}The atlas has ${coding} coding and ${total - coding} trading cards so far; say "list the coding cards" or "list the trading cards" to hear them.`, false);
    }
    case 'pick_missing':
      return out(`There is no number ${intent.number} on that list, sir. Say a number from the list, or "teach me" and a name.`, false);
    case 'no_quiz':
      return out('There is no quiz open right now, sir. Say "quiz me on" and a topic first.', false);
    case 'teach': {
      const level = LEVELS.includes(intent.level) ? intent.level : 'beginner';
      practice({ kind: 'lesson', level });
      return out(teachText(c, level, records));
    }
    case 'formula': {
      if (!c.formula) {
        return out(`${c.title} has no single formula, sir: it is a concept, not a calculation, so I won't invent one. ${c.levels.intermediate}\nWorked example: ${exampleWords(c)}\n${sourceLine(c)}`);
      }
      const f = c.formula;
      const lines = [
        `The formula for ${c.title}, sir: ${f.spoken}.`,
        `Written: ${f.expression}.`,
        `Where: ${f.variables.map((v) => `${v.symbol} is ${v.meaning}, in ${v.unit}`).join('; ')}.`,
        `Assumptions: ${f.assumptions}`,
        `Worked example: ${exampleWords(c)}`,
      ];
      if (c.che_note) lines.push(`In CHE: ${c.che_note}`);
      const measured = measuredText(c, records);
      if (measured) lines.push(measured);
      lines.push(sourceLine(c));
      return out(lines.join('\n'));
    }
    case 'example': {
      if (intent.code && c.example.kind === 'code') {
        return out(`The ${c.title} example, sir, in JavaScript. ${c.example.explain}\n\n\`\`\`javascript\n${c.example.code}\n\`\`\`\n${sourceLine(c)}`);
      }
      const noCode = intent.code && c.example.kind !== 'code' ? ' This card\'s example is a calculation, not code.' : '';
      return out(`Worked example for ${c.title}, sir.${noCode} ${exampleWords(c)}\n${sourceLine(c)}`);
    }
    case 'quiz':
      return out(`Quiz on ${c.title}, sir. ${c.quiz.length} questions:\n${c.quiz.map((q, i) => `${i + 1}. ${q.q}`).join('\n')}\nTo answer one, say "number 1 is" and your answer. Say "quiz answers" when you want to hear the answers.\n${sourceLine(c)}`);
    case 'answers':
      return out(`Answers for ${c.title}, sir:\n${c.quiz.map((q, i) => `${i + 1}. ${q.a}`).join('\n')}\n${sourceLine(c)}`);
    case 'next': {
      const n = nextOf(c);
      if (!n) {
        const other = c.domain === 'coding' ? 'trading' : 'coding';
        return out(`${c.title} is the last ${c.domain} card for now, sir. Related cards: ${c.related.map((id) => atlasCard(id).title).join(', ')}. Say "list the ${other} cards" to keep going.\n${sourceLine(c)}`);
      }
      return { ...out(`After ${c.title} comes ${n.title}, ${n.level} level, sir: ${n.summary} Say "teach me ${firstAlias(n)}" to start it.\n${sourceLine(n)}`), card_id: n.id };
    }
    case 'grade': {
      const q = c.quiz[intent.index];
      if (!q) return out(intent.index >= c.quiz.length && intent.index === c.quiz.length ? `That was the last question on ${c.title}, sir. Say "how am I doing" for your scores, or "quiz answers" to hear them all.\n${sourceLine(c)}` : `There is no question ${intent.index + 1} in the ${c.title} quiz, sir: it has ${c.quiz.length}. Say "number 1 is" and your answer.\n${sourceLine(c)}`, false);
      const grade = gradeQuizAnswer(c, intent.index, intent.answer);
      const saved = recorded(practice({ kind: 'quiz', item_id: `question ${intent.index + 1}`, correct: grade.correct, question: q.q, answer: intent.answer, expected: q.a, method: grade.method }));
      const next = c.quiz[intent.index + 1];
      return out([
        `Question ${intent.index + 1} on ${c.title}, sir: ${grade.correct ? 'correct' : 'not quite'}. You said: ${intent.answer}. The card's answer: ${q.a}`,
        `Graded by ${grade.method}. ${saved ? 'Recorded in your Brain as owner practice.' : 'I could not record it in the Brain just now, so it is not in your progress.'}`,
        next ? `Question ${intent.index + 2}: ${next.q} Say "my answer is" and your answer.` : 'That was the last question. Say "how am I doing" for your scores.',
        sourceLine(c),
      ].join('\n'));
    }
    case 'correction': {
      const saved = recorded(practice({ kind: 'correction', item_id: 'owner correction', detail: intent.detail ? `What the owner said is wrong: ${intent.detail}` : 'The owner said the card is wrong, without saying what.' }));
      const ask = intent.detail ? '' : ' Tell me what is wrong, and I will add your words to it.';
      return out(`${saved ? `Thank you, sir. I recorded your correction to the ${c.title} card in your Brain.` : `I could not record your correction to the ${c.title} card just now, sir.`}${ask} The card's own text changes only when it is fixed and its tests pass, so until then I keep it labelled curated teaching content, not settled fact.\n${sourceLine(c)}`, saved);
    }
    case 'progress': {
      const rows = brain ? learningRecords(brain) : null;
      if (!rows) return out('I could not read your practice records just now, sir, so I give no counts.', false);
      return out(progressText(rows, intent.domain));
    }
    case 'study_next': {
      const rows = brain ? learningRecords(brain) : [];
      const next = studyNextText(rows, intent.domain);
      return { ...out(`${brain ? '' : 'I could not read your practice records just now, sir, so this starts from the beginning. '}${next.text}`), card_id: next.card?.id || '' };
    }
    default:
      return out('I could not tell which Knowledge Atlas card you meant, sir. Say "list the coding cards" or "list the trading cards".', false);
  }
}

// ─── For the phone and the Brain ──────────────────────────────────────────

/** The cards as the phone reads them (assets/atlas/knowledge_atlas.json). Text and numbers only. */
export function atlasExport() {
  return {
    version: ATLAS_VERSION,
    generated_from: 'server/cloudflare/knowledge_atlas.js',
    levels: LEVELS,
    domains: DOMAINS,
    references_label: REFERENCES_LABEL,
    matching: { filler: [...FILLER], numbers: NUMBER_WORDS },
    cards: ATLAS_CARDS.map((c) => ({
      id: c.id, domain: c.domain, title: c.title, level: c.level, summary: c.summary, revision: c.revision, source_kind: c.source_kind,
      aliases: c.aliases, tags: c.tags, prerequisites: c.prerequisites, related: c.related,
      levels: c.levels, analogy: c.analogy, formula: c.formula, example: c.example, quiz: c.quiz.map(({ q, a }) => ({ q, a })),
      misconceptions: c.misconceptions, che_note: c.che_note, measured: c.measured, sources: c.sources,
    })),
  };
}

/**
 * A card in the Brain's own record shape (brain_store.normalizeRecord): one region per domain, in the
 * folder Knowledge Atlas/<Coding|Trading>/<card>, prerequisites as builds_upon and related cards as
 * related_to. It is a curated_lesson: CHE's own tested teaching text, neither the owner's memory nor a
 * measured result (its reference links were not opened when it was written).
 */
export function atlasBrainRecord(c) {
  return {
    id: `atlas:${c.id}`,
    kind: 'concept_card',
    region: c.domain === 'coding' ? BRAIN_REGIONS.coding : BRAIN_REGIONS.trading,
    path: atlasFolder(c),
    title: c.title,
    body: [c.summary, ...LEVELS.map((l) => `${cap(l)}: ${c.levels[l]}`), c.formula ? `Formula: ${c.formula.expression}` : ''].filter(Boolean).join('\n'),
    source: { kind: 'knowledge_atlas', card_id: c.id, revision: c.revision, source_kind: c.source_kind, provenance: 'curated teaching content, not the owner\'s words', references: c.sources.map((s) => s.url).filter(Boolean) },
    verification: 'curated_lesson',
    links: [...c.prerequisites.map((to) => ({ type: 'builds_upon', to: `atlas:${to}` })), ...c.related.map((to) => ({ type: 'related_to', to: `atlas:${to}` }))],
  };
}

const MAX_PROJECTION_WRITES = 200;
const projectionHash = (record) => {
  const n = normalizeRecord(record);
  return fnv1a32(JSON.stringify([contentHash(n), n.links, n.places])).toString(16).padStart(8, '0');
};

/**
 * Every card into the Brain as curated reference, so the Brain Room and the phone's replica hold them
 * offline. Keyed by card id and a hash of its record (brain_meta atlas_projection): a second run writes
 * nothing, and a changed card rewrites only itself. Bounded per run. A card the owner deleted from his
 * Brain stays deleted, a record the atlas did not write is never touched, and a card that left the
 * atlas leaves the Brain. Runs from the Brain sync (worker.js projectAll) and on the first atlas turn.
 */
export function projectAtlasToBrain(store, { now } = {}) {
  if (!store?.init?.()) return { available: false, written: 0, unchanged: 0, skipped: 0, removed: 0 };
  const meta = store.meta('atlas_projection', null);
  const before = meta && typeof meta.hashes === 'object' && meta.hashes ? meta.hashes : {};
  const hashes = { ...before };
  let written = 0; let unchanged = 0; let skipped = 0; let removed = 0;
  const live = new Set();
  for (const c of ATLAS_CARDS) {
    const record = atlasBrainRecord(c);
    live.add(record.id);
    const hash = projectionHash(record);
    if (hashes[record.id] === hash) { unchanged += 1; continue; }
    if (written >= MAX_PROJECTION_WRITES) { skipped += 1; continue; }
    const current = store.get(record.id);
    if (current && (current.deleted || current.source?.kind !== 'knowledge_atlas')) { hashes[record.id] = hash; skipped += 1; continue; }
    const result = store.put(record, { origin: 'atlas', now });
    if (!['created', 'updated', 'merged', 'unchanged'].includes(result.outcome)) { skipped += 1; continue; }
    hashes[record.id] = hash;
    if (result.outcome === 'unchanged') unchanged += 1; else written += 1;
  }
  for (const id of Object.keys(hashes)) {
    if (live.has(id)) continue;
    const current = store.get(id);
    if (current && !current.deleted && current.kind === 'concept_card' && current.source?.kind === 'knowledge_atlas') {
      if (store.delete(id, { origin: 'atlas', now }).outcome === 'deleted') removed += 1;
    }
    delete hashes[id];
  }
  if (JSON.stringify(hashes) !== JSON.stringify(before)) {
    store.setMeta('atlas_projection', { at: now || new Date().toISOString(), version: ATLAS_VERSION, cards: ATLAS_CARDS.length, written, removed, hashes });
  }
  return { available: true, written, unchanged, skipped, removed };
}

// ─── A few relevant cards for the language model ──────────────────────────

export const ATLAS_PROMPT_MAX = 600;
const ATLAS_PROMPT_HEAD = 'Knowledge Atlas (curated teaching cards: reference, not the owner\'s words, not measured results):';
const CARD_NAMES = ATLAS_CARDS.map((c) => ({ c, keys: [...new Set([c.id.replace(/-/g, ' '), c.title, ...c.aliases].map(topicKey).filter(Boolean))] }));

// The coding or trading words in a question, as topic keys ('' for a word that is only a domain, like "python").
const domainHits = (re, text) => [...text.matchAll(new RegExp(re.source, 'g'))].map((m) => topicKey(m[0]));

/**
 * The cards a coding or trading question names, best first: a card counts when one of its names
 * appears whole in the question (the atlas's own topicKey), and scores its name's length in words plus
 * one when another word of the question is in the card's domain. Below 2 is too weak: a lone word such
 * as "scope", "loop" or "risk" in a question about something else never brings a card in.
 */
export function atlasRelevantCards(message, { limit = 2 } = {}) {
  const text = speech(message);
  if (!text) return [];
  const key = ` ${topicKey(text)} `;
  const hits = { coding: domainHits(CODING_WORDS, text), trading: domainHits(TRADING_WORDS, text) };
  const scored = [];
  for (const { c, keys } of CARD_NAMES) {
    const named = keys.filter((k) => key.includes(` ${k} `)).sort((a, b) => b.split(' ').length - a.split(' ').length)[0];
    if (!named) continue;
    // The card's own name is not evidence of its domain: "the risk of rain" is not about trading.
    const domain = hits[c.domain].some((h) => !h || !` ${named} `.includes(` ${h} `));
    const score = named.split(' ').length + (domain ? 1 : 0);
    if (score >= 2) scored.push({ c, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.c);
}

/**
 * The compact excerpt the model reads for a coding or trading question that the atlas did not answer
 * itself: each relevant card's definition and formula, at most ATLAS_PROMPT_MAX characters in all.
 * Empty when nothing is relevant, so other questions cost nothing.
 */
export function atlasPromptContext(message, { limit = 2, max = ATLAS_PROMPT_MAX } = {}) {
  const lines = [];
  for (const c of atlasRelevantCards(message, { limit })) {
    const line = `- ${c.title}: ${c.summary}${c.formula ? ` Formula: ${c.formula.expression}.` : ''}`;
    const next = [ATLAS_PROMPT_HEAD, ...lines, line].join('\n');
    if (next.length <= max) lines.push(line);
    else if (!lines.length) lines.push(line.slice(0, Math.max(0, max - ATLAS_PROMPT_HEAD.length - 2)).replace(/\s+\S*$/, '…'));
  }
  return lines.length ? [ATLAS_PROMPT_HEAD, ...lines].join('\n') : '';
}
