// CHE Knowledge Atlas, coding lane (owner issue #346, phase 2). The coding cards are checked as
// data (every field, every link, the whole prerequisite graph), as mathematics (every formula
// against an independent computation), as code (every example, every exercise's reference
// solution against its cases, every drill's bug and fix) and against the repository itself
// (every path, symbol and named test read from disk). Then the owner's phrasings go through the
// real /api/chat, typed, as unpunctuated speech and with "CHE," in front, and the coding,
// REA and research requests that are not lessons keep their own routes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CODING_CARDS, CODING_FORMULAS, answerTokens, bigOClass, checkDrill, checkExercise, excerptFrom } from './atlas_coding.js';
import { replyFromNdjson } from './brain_memory.js';
import { loadCodeIndex, makeIndex, _clearCodeIndexCache } from './code_index.js';
import { currentTurnActionPolicy } from './code_scout.js';
import { RESUME_BACKOFF_MS, RESUME_LIMIT } from './coding_failover.mjs';
import { ATLAS_CARDS, FORMULAS, LEVELS, atlasCard, atlasExport, atlasIntent, findAtlasCard } from './knowledge_atlas.js';
import { backoffMs, strategyFingerprint } from './recovery_policy.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
// A test's name as written in its file, where a quote may be escaped: test('the owner\'s …').
const testNames = (path) => read(path).replace(/\\(['"`])/g, '$1');

const generated = new URL('./.atlas_coding.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

// Offline, and every outbound request is counted: practice reads no network at all.
const requests = [];
globalThis.fetch = async (input) => {
  requests.push(String(input?.url || input));
  throw new TypeError('fetch failed (atlas_coding tests are offline)');
};

const CODING = ATLAS_CARDS.filter((c) => c.domain === 'coding');
const LANE = CODING.filter((c) => c.id.startsWith('c-'));
const EXERCISES = CODING.flatMap((c) => c.exercises.map((x) => ({ card: c, x })));
const DRILLS = CODING.flatMap((c) => c.review_drills.map((d) => ({ card: c, d })));
// Language overviews; every other coding-lane card is craft or autonomy and must point into CHE.
const OVERVIEWS = new Set(['c-python', 'c-javascript-typescript', 'c-html-css']);

// ─── Running code in the languages the cards use ─────────────────────────

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const json = (v) => JSON.parse(JSON.stringify(v));
const has = (cmd) => spawnSync(cmd, ['--version'], { encoding: 'utf8' }).status === 0;
const HAS_PYTHON = has('python3');
const HAS_DART = has('dart');
let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch (_) { sqlite = null; }

async function jsFunction(code, entry, language = 'javascript') {
  const body = language === 'typescript' ? stripTypeScriptTypes(code) : code;
  return new AsyncFunction(`${body}\nreturn ${entry};`)();
}
function runPython(program) {
  const out = spawnSync('python3', ['-I', '-c', program], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout.trim().split('\n').pop());
}
function runDart(program) {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-dart-'));
  try {
    writeFileSync(join(dir, 'main.dart'), program);
    const out = spawnSync('dart', [join(dir, 'main.dart')], { encoding: 'utf8', timeout: 120_000 });
    assert.equal(out.status, 0, out.stderr);
    return JSON.parse(out.stdout.trim().split('\n').pop());
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
// Every statement in order; the rows of each SELECT are kept, and a query plan is read for its index.
function runSql(program) {
  const db = new sqlite.DatabaseSync(':memory:');
  const results = [];
  let plan = '';
  for (const statement of program.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean)) {
    if (/^EXPLAIN QUERY PLAN/i.test(statement)) plan += db.prepare(statement).all().map((r) => r.detail).join(' ');
    else if (/^SELECT/i.test(statement)) results.push(json(db.prepare(statement).all()));
    else db.exec(statement);
  }
  db.close();
  return { results, plan };
}
const sqlValue = (program) => { const rows = runSql(program).results.pop(); return Object.values(rows[0])[0]; };

const SKIPPED = [];
// One exercise's reference solution on one case's arguments.
async function solve(x, args) {
  const s = x.solution;
  if (s.che) {
    const fn = (await import(join(ROOT, s.che)))[s.entry === 'sameStrategy' ? 'strategyFingerprint' : s.entry];
    if (s.entry === 'sameStrategy') return fn(args[0]) === fn(args[1]) ? 'yes' : 'no';
    const value = fn(s.wrap ? { [s.wrap]: args[0] } : args[0]);
    return s.pick ? value[s.pick] : value;
  }
  if (s.language === 'python') return runPython(s.program);
  if (s.language === 'dart') return runDart(s.program);
  if (s.language === 'sql') return sqlValue(s.program);
  return (await jsFunction(s.code, s.entry, s.language))(...structuredClone(args));
}
const canRun = (language) => ({ python: HAS_PYTHON, dart: HAS_DART, sql: Boolean(sqlite) }[language] ?? true);

// ─── The cards are complete ───────────────────────────────────────────────

test('every coding card is complete: levels, analogy, example, quiz, limits, sources and practice', () => {
  assert.ok(CODING.length >= 25 && CODING.length <= 35, `${CODING.length} coding cards, about 25 to 35 as asked`);
  for (const c of LANE) {
    assert.match(c.id, /^c-[a-z0-9-]+$/, c.id);
    assert.ok(LEVELS.includes(c.level), `${c.id} level`);
    assert.ok(c.summary.length >= 30 && c.summary.length <= 140, `${c.id} summary ${c.summary.length}`);
    for (const level of LEVELS) assert.ok(c.levels[level]?.length >= 120, `${c.id} ${level}`);
    assert.match(c.analogy, /\blike\b/, `${c.id} analogy`);
    assert.ok(c.quiz.length >= 3 && c.quiz.every((q) => q.q.endsWith('?') && q.a.length >= 3), `${c.id} quiz`);
    assert.ok(c.misconceptions.length >= 1, `${c.id} misconception`);
    assert.ok(c.limitations.length >= 40, `${c.id} states its limitations`);
    assert.ok(c.sources.length >= 2 || c.sources.some((s) => s.url), `${c.id} sources`);
    assert.ok(c.exercises.length + c.review_drills.length >= 1, `${c.id} has practice`);
    if (!OVERVIEWS.has(c.id)) assert.ok(c.repo_examples.length >= 1, `${c.id} points into CHE's own code`);
    assert.equal(c.example.kind, 'code', `${c.id} example is code`);
  }
  const ids = [...EXERCISES.map(({ x }) => x.id), ...DRILLS.map(({ d }) => d.id)];
  assert.equal(new Set(ids).size, ids.length, 'exercise and drill ids are unique');
  assert.ok(EXERCISES.length >= 30, `${EXERCISES.length} exercises`);
  assert.ok(DRILLS.length >= 10, `${DRILLS.length} review drills`);
  for (const { card, x } of EXERCISES) {
    assert.ok(['returns', 'choice', 'big_o'].includes(x.kind), `${x.id} kind`);
    assert.ok(x.prompt.endsWith('?') && x.explain.length >= 20 && x.topics.length >= 1, `${x.id} prompt, explanation, topics`);
    assert.ok(x.solution && x.cases.length >= 1, `${x.id} has a reference solution and cases`);
    assert.ok(x.id.startsWith(`${card.id}.`), `${x.id} belongs to ${card.id}`);
    if (x.kind !== 'returns') assert.ok(x.options.length >= 2, `${x.id} options`);
  }
});

test('the prerequisite graph of the whole atlas runs in order, with no cycle and no dangling link', () => {
  const order = new Map(ATLAS_CARDS.map((c, i) => [c.id, i]));
  for (const c of ATLAS_CARDS) {
    for (const id of [...c.prerequisites, ...c.related]) assert.ok(atlasCard(id), `${c.id} links to ${id}`);
    for (const pre of c.prerequisites) assert.ok(order.get(pre) < order.get(c.id), `${c.id} builds on ${pre}, which comes first`);
  }
  // An independent check: depth-first search with colours finds no cycle anywhere.
  const colour = new Map();
  const visit = (id, path) => {
    assert.notEqual(colour.get(id), 'grey', `cycle: ${[...path, id].join(' → ')}`);
    if (colour.get(id) === 'black') return;
    colour.set(id, 'grey');
    for (const pre of atlasCard(id).prerequisites) visit(pre, [...path, id]);
    colour.set(id, 'black');
  };
  for (const c of ATLAS_CARDS) visit(c.id, []);
  assert.ok(CODING.some((c) => c.related.some((id) => atlasCard(id).domain === 'trading')), 'a coding card links to a related trading card');
  assert.deepEqual(atlasCard('c-self-repair').prerequisites, ['c-debugging', 'c-checkpoints', 'c-model-failover']);
});

// ─── Formulas, against independent computations ─────────────────────────

test('coding formulas match brute force, simulation or CHE\'s own code', () => {
  assert.ok(Object.keys(CODING_FORMULAS).every((k) => FORMULAS[k] === CODING_FORMULAS[k]), 'registered in the atlas FORMULAS');
  // git bisect: the most tests over every possible first bad commit.
  const bisect = (n, bad) => { let good = 0; let b = n; let tests = 0; while (b - good > 1) { const mid = Math.floor((good + b) / 2); tests += 1; if (mid >= bad) b = mid; else good = mid; } return tests; };
  for (let n = 1; n <= 300; n += 1) {
    let worst = 0;
    for (let bad = 1; bad <= n; bad += 1) worst = Math.max(worst, bisect(n, bad));
    assert.equal(CODING_FORMULAS.bisectSteps({ n }), worst, `bisect ${n}`);
  }
  // Heap height: walk parents from the last index.
  for (let n = 1; n <= 2000; n += 1) {
    let depth = 0;
    for (let i = n - 1; i > 0; i = Math.floor((i - 1) / 2)) depth += 1;
    assert.equal(CODING_FORMULAS.heapHeight({ n }), depth, `heap of ${n}`);
  }
  // Edit distance: a different algorithm, top-down recursion with a memo.
  const slow = (a, b) => { const memo = new Map(); const d = (i, j) => { if (!i) return j; if (!j) return i; const k = `${i},${j}`; if (!memo.has(k)) memo.set(k, Math.min(d(i - 1, j) + 1, d(i, j - 1) + 1, d(i - 1, j - 1) + (a[i - 1] === b[j - 1] ? 0 : 1))); return memo.get(k); }; return d(a.length, b.length); };
  for (const [a, b] of [['kitten', 'sitting'], ['showbird', 'shorebird'], ['', 'abc'], ['flaw', 'lawn'], ['intention', 'execution'], ['same', 'same'], ['cat', 'cut']]) {
    assert.equal(CODING_FORMULAS.editDistance({ a, b }), slow(a, b), `${a} → ${b}`);
  }
  // B-tree levels: divide by the fan-out until one page is left.
  for (const [n, fanout] of [[1, 100], [100, 100], [101, 100], [1000000, 100], [1000001, 100], [5000, 2]]) {
    let levels = 1; let pages = Math.ceil(n / fanout);
    while (pages > 1) { pages = Math.ceil(pages / fanout); levels += 1; }
    assert.equal(CODING_FORMULAS.btreeLevels({ n, fanout }), levels, `${n} rows at fan-out ${fanout}`);
  }
  // Cache: simulate lookups with a fixed hit pattern.
  const pattern = Array.from({ length: 1000 }, (_, i) => i % 10 < 8);
  const simulated = pattern.reduce((t, hit) => t + (hit ? 1 : 100), 0) / pattern.length;
  assert.ok(Math.abs(CODING_FORMULAS.cacheLatency({ h: 0.8, hit: 1, miss: 100 }) - simulated) < 1e-9);
  // CI: enumerate every pass/fail outcome of n tests.
  for (const [p, n] of [[0.1, 2], [0.05, 6], [0.3, 8]]) {
    let green = 0;
    for (let mask = 0; mask < 2 ** n; mask += 1) {
      let prob = 1;
      for (let i = 0; i < n; i += 1) prob *= (mask >> i) & 1 ? p : 1 - p;
      if (mask === 0) green += prob;
    }
    assert.ok(Math.abs(CODING_FORMULAS.ciGreen({ p, n }) - green) < 1e-12, `ci ${p} ${n}`);
  }
  // Backoff: CHE's own recovery_policy.backoffMs.
  for (let attempt = 0; attempt <= 8; attempt += 1) {
    assert.equal(CODING_FORMULAS.backoff({ attempt, base: 60_000, cap: 30 * 60_000 }), backoffMs(attempt), `attempt ${attempt}`);
  }
  assert.ok(Math.abs(CODING_FORMULAS.passwordBits({ length: 12, alphabet: 62 }) - Math.log2(62 ** 12)) < 1e-9);
  assert.equal(CODING_FORMULAS.passwordBits({ length: 10, alphabet: 16 }), (16n ** 10n).toString(2).length - 1);
  assert.equal(CODING_FORMULAS.boxWidth({ width: 200, padding: 20, border: 5 }), 200 + 20 + 20 + 5 + 5);
});

test('CHE\'s notes and examples agree with her own code: failover constants and the action policy', () => {
  const note = atlasCard('c-model-failover').che_note;
  assert.ok(note.includes(`after ${RESUME_BACKOFF_MS.map((ms) => ms / 60_000).slice(0, -1).join(', ')} and then ${RESUME_BACKOFF_MS.at(-1) / 60_000} minutes`), note);
  assert.ok(note.includes(`at most ${RESUME_LIMIT} times`), note);
  // The planning card's three sentences get the same modes from CHE's real policy as from the example.
  const example = atlasCard('c-agent-planning').example;
  const turns = ["Inspect the router but don't change anything", 'Plan how to add dark mode, plan only', 'Fix the login bug in the router'];
  assert.ok(turns.every((t) => example.code.includes(JSON.stringify(t).slice(1, -1)) || example.code.includes(t)));
  assert.deepEqual(turns.map((t) => currentTurnActionPolicy(t).mode), example.expected.map((e) => e.mode));
  // The failover example's backoff is CHE's own, in minutes.
  assert.deepEqual(atlasCard('c-model-failover').example.expected.backoffMinutes, [0, 1, 2, 3, 4, 5].map((a) => backoffMs(a) / 60_000));
});

// ─── Every example, solution and drill runs ───────────────────────────────

test('every non-JavaScript example runs and returns exactly what its card says (Python, TypeScript, Dart, SQL)', async (t) => {
  const others = CODING.filter((c) => c.example.language !== 'javascript');
  assert.deepEqual([...new Set(others.map((c) => c.example.language))].sort(), ['dart', 'python', 'sql', 'typescript']);
  for (const c of others) {
    const e = c.example;
    if (!canRun(e.language)) { SKIPPED.push(`${c.id} (${e.language})`); t.diagnostic(`${c.id}: ${e.language} is not installed here, not run`); continue; }
    if (e.language === 'typescript') assert.deepEqual(await new AsyncFunction(`${stripTypeScriptTypes(`async function run() {\n${e.code}\n}`)}\nreturn run();`)(), e.expected, c.id);
    if (e.language === 'python') assert.deepEqual(runPython(e.code), e.expected, c.id);
    if (e.language === 'dart') assert.deepEqual(runDart(e.code), e.expected, c.id);
    if (e.language === 'sql') {
      const { results, plan } = runSql(e.code);
      assert.deepEqual(results, e.expected.results, c.id);
      assert.match(plan, new RegExp(`USING (?:COVERING )?INDEX ${e.expected.plan_uses_index}\\b`), `${c.id} plan: ${plan}`);
    }
    const numbers = JSON.stringify(e.expected).match(/-?\d+(?:\.\d+)?/g) || [];
    for (const n of numbers) assert.ok(e.explain.includes(n), `${c.id}: the spoken description mentions ${n}`);
  }
});

test('every exercise\'s reference solution passes its cases, and its stored answer is the computed one', async (t) => {
  let run = 0;
  for (const { x } of EXERCISES) {
    const language = x.solution.language || 'javascript';
    if (!canRun(language)) { SKIPPED.push(x.id); t.diagnostic(`${x.id}: ${language} is not installed here, not run`); continue; }
    for (const c of x.cases) assert.deepEqual(json(await solve(x, c.args)), c.expected, `${x.id} on ${JSON.stringify(c.args)}`);
    run += 1;
    const asked = x.cases[x.ask ?? 0].expected;
    const shown = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
    if (x.kind === 'returns') {
      assert.equal(answerTokens(x.answer).join(' '), answerTokens(shown(asked)).join(' '), `${x.id}: the answer is what the solution returns`);
    }
    if (x.kind === 'choice') {
      const values = x.values || x.options;
      const right = values.map((v, i) => [i, answerTokens(v).join(' ') === answerTokens(shown(asked)).join(' ')]).filter(([, ok]) => ok).map(([i]) => i);
      assert.deepEqual(right, ['abcde'.indexOf(x.answer)], `${x.id}: exactly the stored option is the computed one`);
    }
    if (x.kind === 'big_o') {
      assert.ok(x.options.includes(x.answer), `${x.id} answer is an option`);
      const steps = await jsFunction(x.growth.code, x.growth.entry);
      assert.equal(measuredClass(steps), bigOClass(x.answer), `${x.id}: measured growth`);
    }
  }
  assert.ok(run >= 25, `${run} reference solutions ran`);
});

// The Big-O class whose curve the step counts follow most closely, from n = 256 to 4096.
function measuredClass(steps) {
  const sizes = [2 ** 8, 2 ** 10, 2 ** 12];
  const curves = { 1: () => 1, 'log n': (n) => Math.log2(n), n: (n) => n, 'n log n': (n) => n * Math.log2(n), 'n^2': (n) => n * n };
  let best = ''; let spread = Infinity;
  for (const [name, g] of Object.entries(curves)) {
    const ratios = sizes.map((n) => steps(n) / g(n));
    const s = Math.max(...ratios) / Math.min(...ratios);
    if (s < spread) { spread = s; best = name; }
  }
  return best;
}

test('chat checks answers deterministically: values, spoken numbers, option numbers and Big-O words', () => {
  for (const { x } of EXERCISES) {
    const right = x.kind === 'choice' ? String('abcde'.indexOf(x.answer) + 1) : x.answer;
    assert.ok(checkExercise(x, right).correct, `${x.id}: "${right}" is right`);
    assert.ok(checkExercise(x, `I think it's ${right}`).correct, `${x.id}: with a lead-in`);
    for (const [i, option] of (x.options || []).entries()) {
      const isRight = x.kind === 'choice' ? i === 'abcde'.indexOf(x.answer) : bigOClass(option) === bigOClass(x.answer);
      assert.equal(checkExercise(x, option).correct, isRight, `${x.id}: option "${option}"`);
    }
    assert.equal(checkExercise(x, 'banana').correct, false, `${x.id}: nonsense is wrong`);
  }
  const bs = atlasCard('c-binary-search').exercises;
  for (const said of ['3', 'three', 'it returns 3', 'the answer is three']) assert.ok(checkExercise(bs[0], said).correct, said);
  for (const said of ['4', 'minus one', '-1']) assert.equal(checkExercise(bs[0], said).correct, false, said);
  for (const said of ['b', 'option 2', 'two', 'the second one', '1']) assert.ok(checkExercise(bs[1], said).correct, said);
  for (const said of ['O(log n)', 'o of log n', 'big o of log n', 'log n', 'logarithmic', '2']) assert.ok(checkExercise(bs[2], said).correct, said);
  for (const said of ['O(n)', 'linear', 'n squared']) assert.equal(checkExercise(bs[2], said).correct, false, said);
  assert.deepEqual(answerTokens('zero point eight one'), ['0.81']);
  assert.deepEqual(answerTokens('[1, 4, 3, 2]'), answerTokens('one four three two'));
  assert.deepEqual(answerTokens('eighty nine'), ['89']);
  assert.deepEqual(answerTokens('1,346,269'), ['1346269']);
});

test('every review drill\'s bug is real and its fix works; real-fix drills name a test that exists', async (t) => {
  assert.ok(DRILLS.filter(({ d }) => d.from).length >= 5, 'at least five drills come from real CHE fixes');
  for (const { d } of DRILLS) {
    for (const [label, code] of [['buggy', d.code], ['fixed', d.fixed]]) {
      let results;
      if (d.language === 'python') {
        if (!HAS_PYTHON) { SKIPPED.push(d.id); t.diagnostic(`${d.id}: python3 is not installed here`); continue; }
        results = runPython(`import json\n${code}\nresults = []\nfor args in ${JSON.stringify(d.probe.calls)}:\n    results.append(json.loads(json.dumps(${d.entry}(*args))))\nprint(json.dumps(results))`);
      } else {
        if (d.probe.db && !sqlite) { SKIPPED.push(d.id); t.diagnostic(`${d.id}: node:sqlite is not available`); continue; }
        const fn = await jsFunction(code, d.entry);
        const db = d.probe.db ? new sqlite.DatabaseSync(':memory:') : null;
        if (db) db.exec(d.probe.db);
        results = [];
        for (const args of d.probe.calls) results.push(json(await fn(...(db ? [db] : []), ...structuredClone(args))));
        db?.close();
      }
      assert.deepEqual(results, d.probe[label], `${d.id} ${label}`);
    }
    assert.notDeepEqual(d.probe.buggy, d.probe.fixed, `${d.id}: the bug changes behaviour`);
    assert.ok(checkDrill(d, d.finding).correct, `${d.id}: the finding itself passes its own check`);
    assert.equal(checkDrill(d, 'looks fine to me').correct, false, `${d.id}: "looks fine" is not a finding`);
    if (d.from) {
      assert.ok(existsSync(join(ROOT, d.from.test)), `${d.id}: ${d.from.test} exists`);
      assert.ok(testNames(d.from.test).includes(d.from.test_name), `${d.id}: the test "${d.from.test_name}" exists`);
    }
  }
  const named = DRILLS.filter(({ d }) => d.from).map(({ d }) => d.from.what);
  for (const pr of ['#351', '#349', '#352']) assert.ok(named.some((w) => w.includes(pr)), `a drill from ${pr}`);
});

test('every repository example names a real path, a symbol in it, and a test that exercises it', () => {
  const examples = CODING.flatMap((c) => c.repo_examples.map((e) => ({ card: c, e })));
  assert.ok(examples.length >= 25, `${examples.length} repository examples`);
  for (const { card, e } of examples) {
    assert.ok(existsSync(join(ROOT, e.path)), `${card.id}: ${e.path} exists`);
    const text = read(e.path);
    const sym = e.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(text, new RegExp(String.raw`(?:function\*?\s+${sym}\b|(?:const|let|var|class)\s+${sym}\b|\b${sym}\s*[:=(]|\b${sym}\b\s*\()`), `${card.id}: ${e.symbol} is defined in ${e.path}`);
    assert.ok(existsSync(join(ROOT, e.test)), `${card.id}: ${e.test} exists`);
    const testText = read(e.test);
    const base = e.path.split('/').pop().replace(/\.(?:m?js|dart)$/, '');
    assert.ok(testText.includes(e.symbol) || testText.includes(base), `${card.id}: ${e.test} exercises ${e.path}`);
    if (e.test_name) assert.ok(testNames(e.test).includes(e.test_name), `${card.id}: the test "${e.test_name}" exists in ${e.test}`);
    assert.ok(e.what.length >= 20, `${card.id}: says what ${e.symbol} shows`);
    // A quoted excerpt is at most 12 real lines of that file, starting at the symbol.
    const shown = excerptFrom(makeIndex('test-sha', [[e.path, text]]), e);
    assert.ok(shown && shown.lines.length >= 1 && shown.lines.length <= 12, `${card.id}: excerpt of ${e.symbol}`);
    assert.ok(shown.lines[0].includes(e.symbol), `${card.id}: the excerpt starts at ${e.symbol}`);
    assert.deepEqual(shown.lines, text.split('\n').slice(shown.from - 1, shown.to), `${card.id}: the excerpt is the file's own lines`);
  }
});

test('the phone\'s bundled atlas carries the practice fields, and no reference solution runs on the phone', () => {
  const bundled = JSON.parse(read('assets/atlas/knowledge_atlas.json'));
  assert.deepEqual(bundled, json(atlasExport()));
  const recursion = bundled.cards.find((c) => c.id === 'c-checkpoints');
  assert.ok(recursion.exercises.length && recursion.repo_examples.length && recursion.limitations);
  assert.ok(bundled.cards.filter((c) => c.domain === 'trading').every((c) => !('exercises' in c)), 'trading cards are unchanged');
  for (const c of bundled.cards.filter((x) => x.exercises)) {
    for (const x of c.exercises) assert.deepEqual(Object.keys(x), ['id', 'kind', 'prompt', 'language', 'code', 'options', 'answer', 'explain']);
  }
});

// ─── Through /api/chat ────────────────────────────────────────────────────

function storageFor(saved) {
  return {
    get: async (key) => (Array.isArray(key)
      ? new Map(key.filter((k) => saved.has(k)).map((k) => [k, structuredClone(saved.get(k))]))
      : (saved.has(key) ? structuredClone(saved.get(key)) : undefined)),
    put: async (key, value) => {
      if (key && typeof key === 'object') for (const [k, v] of Object.entries(key)) saved.set(k, structuredClone(v));
      else saved.set(key, structuredClone(value));
    },
    delete: async (key) => (Array.isArray(key) ? key.filter((k) => saved.delete(k)).length : saved.delete(key)),
    deleteAll: async () => saved.clear(),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => String(k).startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

async function owner({ saved = new Map() } = {}) {
  let calls = 0;
  const pending = [];
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async () => { calls += 1; return { response: 'MODEL ANSWERED' }; } },
  };
  const state = new CheState({ storage: storageFor(saved), waitUntil: (p) => pending.push(p) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const say = async (message, { history = [] } = {}) => {
    const before = calls;
    const raw = await (await send('/api/chat', { message, history }, token)).text();
    while (pending.length) await pending.shift();
    let held = null;
    try { held = JSON.parse(raw); } catch (_) { held = null; }
    const events = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const done = events.find((e) => e.type === 'done') || {};
    const route = held?.held_for_owner ? 'held' : done.source || (calls > before ? 'model' : 'none');
    return { route, done, reply: held?.message || replyFromNdjson(raw), modelCalls: calls - before };
  };
  return { say, saved };
}

// Typed, as speech recognition hands it over, and with CHE's name in front.
const spoken = (text) => text.replace(/[.,?!]/g, '').replace(/'/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const variants = (phrase) => [phrase, spoken(phrase), `CHE, ${phrase}`, `hey che ${spoken(phrase)}`];
const after = (...replies) => replies.flatMap((r) => [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: r }]);

test('the owner\'s phrasings are answered from the atlas with no model: lessons, Durable Objects, Git', async () => {
  const che = await owner();
  const sent = requests.length;
  const lesson = async (words, history = []) => {
    const out = await che.say(words, { history });
    assert.equal(out.route, 'che_knowledge_atlas', `${words} → ${out.route}: ${out.reply.slice(0, 120)}`);
    assert.equal(out.modelCalls, 0, words);
    return out;
  };
  for (const words of variants('Teach me recursion like a beginner.')) {
    assert.match((await lesson(words)).reply, /^Recursion, beginner level, sir\. Recursion is a function that solves a problem/);
  }
  for (const words of variants('Explain Durable Objects at expert level.')) {
    const out = await lesson(words);
    assert.match(out.reply, /^Cloudflare Workers and Durable Objects, expert level, sir\. A Durable Object runs its requests one at a time/);
    assert.match(out.reply, /Source: Knowledge Atlas card "Cloudflare Workers and Durable Objects" \(coding\)/);
  }
  for (const words of variants('Quiz me on Git.')) {
    assert.match((await lesson(words)).reply, /^Quiz on Git: commits, branches, merge, rebase and bisect, sir\. 3 questions:\n1\. What is the difference between merge and rebase\?/);
  }
  for (const words of variants('Teach me Python.')) assert.match((await lesson(words)).reply, /^Python, beginner level, sir\./);
  const python = (await lesson('Teach me Python')).reply;
  const code = await lesson('show me the code', after(python));
  assert.match(code.reply, /^The Python example, sir, in Python\./, 'the example names its own language');
  assert.match(code.reply, /```python\nimport json/);
  assert.match((await lesson('Teach me recursion in Python')).reply, /^Recursion, beginner level/, 'a language after the topic still names the topic');
  assert.match((await lesson('explain git rebase')).reply, /^Git: commits, branches, merge, rebase and bisect, beginner level/);
  assert.match((await lesson('teach me Cloudflare Workers')).reply, /^Cloudflare Workers and Durable Objects, beginner level/);
  assert.match((await lesson('what is a durable object')).reply, /^Cloudflare Workers and Durable Objects, beginner level/);
  assert.equal(requests.length, sent, 'no lesson made an outbound request');
});

test('a card\'s exact name is a lesson even with a merge, deploy, commit or bug word; the owner\'s own work is not', async () => {
  const che = await owner();
  for (const [phrase, card] of [
    ['Teach me merge sort.', 'Sorting and merge sort'],
    ['Teach me deployment.', 'Deployment: CI, staged rollout and live verification'],
    ['Explain merge vs rebase.', 'Git: commits, branches, merge, rebase and bisect'],
    ['What is a git commit?', 'Git: commits, branches, merge, rebase and bisect'],
    ['Teach me debugging.', 'Debugging: reproduce, locate, fix narrowly, prove'],
    ['Explain bugs vs errors.', 'Debugging: reproduce, locate, fix narrowly, prove'],
  ]) {
    for (const words of [phrase, spoken(phrase)]) {
      const out = await che.say(words);
      assert.equal(out.route, 'che_knowledge_atlas', `${words} → ${out.route}`);
      assert.equal(out.modelCalls, 0, words);
      assert.ok(out.reply.startsWith(`${card}, beginner level, sir.`), `${words}: ${out.reply.slice(0, 80)}`);
    }
  }
  assert.match((await che.say('explain bugs vs errors')).reply, /A bug is the mistake in the code; an error is what you see when it goes wrong/);
  // Never a card's exact name: the owner's or CHE's own deploys, merges, commits, fixes and changes.
  for (const [words, route] of [
    ['teach me how your last deploy went', 'model'],
    ['explain the merge you did', 'model'],
    ['walk me through the commit you made', 'model'],
    ['help me understand the bug you fixed yesterday', 'model'],
    ['why the GitHub deploy failed', 'model'],
    ['explain the code you changed in PR 352', 'model'],
    ['walk me through your last code change', 'che_read_only'],
    ['help me understand the bug in my python code', 'model'],
  ]) {
    for (const said of [words, `CHE, ${words}`]) assert.equal((await che.say(said)).route, route, said);
  }
});

test('"give me a coding exercise on binary search", then answering it: right, wrong, spoken and revealed', async () => {
  const che = await owner();
  const sent = requests.length;
  for (const words of variants('Give me a coding exercise on binary search.')) {
    const out = await che.say(words);
    assert.equal(out.route, 'che_knowledge_atlas', words);
    assert.equal(out.modelCalls, 0);
    assert.match(out.reply, /^Exercise 1 of 4 on Binary search and two pointers, sir, in JavaScript\. What does binarySearch\(\[1, 3, 5, 7, 9\], 7\) return/);
    assert.match(out.reply, /```javascript\nfunction binarySearch/);
    assert.match(out.reply, /exercise 1 of 4, open\./);
    assert.equal(out.done.atlas_kind, 'coding_exercise');
    assert.equal(out.done.atlas_card, 'c-binary-search');
  }
  const set = (await che.say('Give me a coding exercise on binary search')).reply;
  for (const words of ['3', 'three', 'It returns 3.', 'CHE, the answer is three']) {
    const out = await che.say(words, { history: after(set) });
    assert.equal(out.route, 'che_knowledge_atlas', words);
    assert.match(out.reply, /^Right, sir: 3\. Indexes start at 0/, words);
    assert.match(out.reply, /exercise 1 of 4, checked\./);
  }
  const wrong = await che.say('4', { history: after(set) });
  assert.match(wrong.reply, /^Not quite, sir\. I heard "4"; the answer is 3\./);
  assert.equal(wrong.done.ok, false);
  assert.match((await che.say("I don't know", { history: after(set) })).reply, /^The answer, sir: 3\./);
  // A checked exercise is closed: the same words now go on as usual, and "another one" moves on.
  const checked = (await che.say('3', { history: after(set) })).reply;
  assert.notEqual((await che.say('3', { history: after(checked) })).route, 'che_knowledge_atlas');
  const second = await che.say('another exercise', { history: after(checked) });
  assert.match(second.reply, /^Exercise 2 of 4 on Binary search and two pointers, sir\. |^Exercise 2 of 4 on Binary search and two pointers, sir, in JavaScript\. A lower-bound search/);
  assert.match(second.reply, /Options:\n1\. 0\.\n2\. 1\.\n3\. 3\.\n4\. 4\./, 'options are read as a numbered list');
  for (const words of ['1', 'number two', 'option b', 'the second one']) {
    assert.match((await che.say(words, { history: after(second.reply) })).reply, /^Right, sir: 2, 1\./, words);
  }
  const third = (await che.say('next exercise', { history: after((await che.say('1', { history: after(second.reply) })).reply) })).reply;
  assert.match(third, /^Exercise 3 of 4 .* What is the worst-case Big-O of binary search/);
  for (const words of ['O of log n', 'log n', 'big o log n']) assert.match((await che.say(words, { history: after(third) })).reply, /^Right, sir: O\(log n\)\./, words);
  assert.match((await che.say('linear', { history: after(third) })).reply, /^Not quite, sir\./);
  // Other topics, a numbered list, and a topic with no exercise.
  assert.match((await che.say('Give me an exercise on recursion')).reply, /^Exercise 1 of 1 on Recursion, sir, in JavaScript\. sumDigits/);
  assert.match((await che.say('give me a python exercise')).reply, /^Exercise 1 of 2 on Python, sir, in Python\./);
  const list = await che.say('Give me a coding exercise');
  assert.match(list.reply, /^Coding exercises in the Knowledge Atlas, sir: \d+ cards have them\.\n1\. Variables and data types, 1 exercise\./);
  const git = list.reply.split('\n').find((l) => l.includes('Git: commits'));
  const picked = await che.say(git.split('.')[0], { history: after(list.reply) });
  assert.match(picked.reply, /^Exercise 1 of 1 on Git: commits, branches, merge, rebase and bisect, sir/, 'a spoken number picks from the list');
  // A topic with no card goes on to the usual routes, unless the atlas itself is asked.
  assert.equal((await che.say('give me a coding exercise on kubernetes')).route, 'model');
  const none = await che.say('/learn give me a coding exercise on kubernetes');
  assert.equal(none.route, 'che_knowledge_atlas');
  assert.match(none.reply, /^I don't have a coding exercise on "kubernetes" yet, sir, so I won't make one up\./);
  assert.equal(requests.length, sent, 'no outbound request');
});

test('"review this code with me" and "give me a review drill": a real CHE bug, checked by its key ideas', async () => {
  const che = await owner();
  for (const words of [...variants('Review this code with me.'), ...variants('Give me a review drill.')]) {
    const out = await che.say(words);
    assert.equal(out.route, 'che_knowledge_atlas', words);
    assert.equal(out.modelCalls, 0);
    assert.match(out.reply, /^Review drill 1 of \d+, sir: The message that was cut to fit\. Adapted from a real CHE fix: PR #349/);
    assert.match(out.reply, /```javascript\nfunction intake/);
  }
  const drill = (await che.say('Give me a review drill')).reply;
  const right = await che.say("It cuts the message silently, so the don't at the end is lost", { history: after(drill) });
  assert.match(right.reply, /^Right, sir, that's the bug\. slice cuts the message silently/);
  assert.match(right.reply, /The fix:\n```javascript\nfunction intake[\s\S]*status: 413/);
  assert.match(right.reply, /pinned by the test "a chat message too long to take is refused whole, saying so; nothing runs \(issue #345\)" in server\/cloudflare\/worker_autonomy\.test\.mjs/);
  const wrong = await che.say('the variable names are too short', { history: after(drill) });
  assert.match(wrong.reply, /^Not quite, sir\. The bug: slice cuts/);
  assert.match((await che.say('tell me the answer', { history: after(drill) })).reply, /^The bug, sir: slice cuts/);
  const next = await che.say('another drill', { history: after(right.reply) });
  assert.match(next.reply, /^Review drill 2 of \d+, sir: /);
  // The #351 drill, asked for by its card.
  const gate = await che.say('give me a review drill on secure coding');
  assert.match(gate.reply, /The "don't" that swallowed a payment\. Adapted from a real CHE fix: PR #351/);
  assert.match((await che.say('the prohibition runs past the comma so the payment is not held', { history: after(gate.reply) })).reply, /^Right, sir, that's the bug\./);
});

test('"where does CHE do checkpoints in its own code?" and "how does CHE recover when a model fails?"', async () => {
  _clearCodeIndexCache();
  const che = await owner();
  for (const words of variants('Where does CHE do checkpoints in its own code?')) {
    const out = await che.say(words);
    assert.equal(out.route, 'che_knowledge_atlas', words);
    assert.equal(out.modelCalls, 0);
    assert.match(out.reply, /^In CHE's own code, sir, Checkpoints and resumable jobs is in 3 places:\n1\. tools\/che_coding_checkpoint\.mjs, verify: /);
    assert.match(out.reply, /Tested by tools\/che_coding_checkpoint\.test\.mjs, in "a verified attempt becomes checkpoint 1/);
    assert.match(out.reply, /No code index is loaded for the current commit, so I quote no code/, 'never invents code');
  }
  for (const words of variants('How does CHE recover when a model fails?')) {
    const out = await che.say(words);
    assert.equal(out.route, 'che_knowledge_atlas', words);
    assert.match(out.reply, /^CHE classifies each failed coding attempt once \(coding_failover\.mjs classifyModelFailure\)/);
    assert.match(out.reply, /server\/cloudflare\/coding_failover\.mjs, classifyModelFailure: /);
  }
  assert.match((await che.say('how do you recover when the model fails')).reply, /^CHE classifies each failed coding attempt once/);
  assert.match((await che.say('Where does CHE do binary search in its own code?')).reply, /^In CHE's own code, sir, Binary search and two pointers is in 1 place:\n1\. server\/cloudflare\/knowledge_atlas\.js, binarySearchWorst/);
  // With the index for a commit in memory, a short excerpt is quoted, labelled with its path and SHA.
  const saved = new Map();
  const sha = 'a'.repeat(40);
  const path = 'tools/che_coding_checkpoint.mjs';
  saved.set('codeidx_meta', { sha, chunks: 1, files: 1 });
  saved.set('codeidx:0', [[path, read(path)]]);
  const index = await loadCodeIndex(storageFor(saved), {}, sha);
  assert.equal(index.sha, sha, 'loaded from storage, no download');
  const indexed = await owner({ saved });
  const out = await indexed.say('Where does CHE do checkpoints in its own code?');
  const m = /From tools\/che_coding_checkpoint\.mjs at commit (\w{12}), lines (\d+) to (\d+):\n```javascript\n([\s\S]+?)\n```/.exec(out.reply);
  assert.ok(m, out.reply);
  assert.equal(m[1], sha.slice(0, 12));
  const quoted = m[4].split('\n');
  assert.ok(quoted.length <= 12 && /export function verify\(/.test(quoted[0]));
  assert.deepEqual(quoted, read(path).split('\n').slice(Number(m[2]) - 1, Number(m[3])), 'the quote is the file\'s own lines');
  _clearCodeIndexCache();
});

test('counter-cases keep their routes: coding jobs, PR review, REA, research, and non-coding exercise', async () => {
  const che = await owner();
  const routes = async (words, history = []) => (await che.say(words, { history })).route;
  const drill = (await che.say('Give me a review drill')).reply;
  const exercise = (await che.say('Give me a coding exercise on binary search')).reply;
  for (const history of [[], after(drill), after(exercise)]) {
    assert.equal(await routes('fix the login bug', history), 'che_self_development');
    assert.equal(await routes("What's the status of my coding job?", history), 'che_coding_history');
    assert.equal(await routes('Start a coding job to add a dark mode toggle', history), 'model');
    assert.equal(await routes('review PR 352', history), 'model');
    assert.equal(await routes('research the best python web frameworks', history), 'model');
    assert.equal(await routes('Investigate the Notion app', history), 'held');
    assert.equal(await routes('CHE, explain what your REA system can actually do right now, show your most recent verified investigation, and tell me whether it successfully produced evidence. Do not start a new investigation.', history), 'che_rea');
  }
  for (const words of ['give me an exercise for my back', 'give me a back exercise', 'where do you keep my passwords', 'how do you feel', 'review the code in PR 352 with me', 'Teach me recursion and buy the course']) {
    assert.notEqual(await routes(words), 'che_knowledge_atlas', words);
  }
  assert.equal(atlasIntent('give me a coding exercise on binary search and pay for the course'), null, 'money words still reach the gate');
  // The concept rule of #357 holds for the coding cards: the owner's own code, bugs, changes and
  // bills, a "why", a PR number or a second request are never taken by a lesson or a practice.
  for (const [words, route] of [
    ['help me understand the bug in my python code', 'model'],
    ['walk me through your last code change', 'che_read_only'],
    ['how do i calculate the average of a list in python', 'model'],
    ['explain why the git push failed', 'model'],
    ['help me understand our Cloudflare bill', 'model'],
    ['explain the bug in my binary search', 'model'],
    ['give me an exercise on my code', 'model'],
    ['where did you change the router', 'model'],
    ['where does che do checkpoints for PR 352', 'model'],
    ['how did you recover from the last failed deploy', 'model'],
    ['give me a coding exercise on recursion and email it to Mark', 'model'],
  ]) assert.equal(await routes(words), route, words);
  for (const words of ['explain git', 'teach me Cloudflare Workers', 'explain dynamic programming', 'quiz me on secure coding']) {
    assert.equal(await routes(words), 'che_knowledge_atlas', words);
  }
  assert.equal(findAtlasCard('binary search')?.id, 'c-binary-search');
  assert.equal(findAtlasCard('graph theory'), null);
});

test('summary: every language that could run here did', () => {
  // CI's Worker job has Python and node:sqlite; Dart runs where the Flutter SDK is on PATH.
  if (HAS_PYTHON && sqlite) assert.ok(SKIPPED.every((s) => /dart/.test(s) || atlasCard(s.split(' ')[0])?.example?.language === 'dart' || EXERCISES.some(({ x }) => x.id === s && x.language === 'dart')), SKIPPED.join(', '));
  assert.ok(CODING_CARDS.length >= 18);
});
