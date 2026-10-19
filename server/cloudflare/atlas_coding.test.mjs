// CHE Knowledge Atlas, coding lane (owner issue #346, phase 2). The coding cards are checked as
// data (every field, every link, the whole prerequisite graph), as mathematics (every formula
// against an independent computation), as code (every example, every exercise's reference
// solution against its cases, every drill's bug and fix) and against the repository itself
// (every path, symbol and named test read from disk). Then the owner's phrasings go through the
// real /api/chat, typed, as unpunctuated speech and with "CHE," in front, and the coding,
// REA and research requests that are not lessons keep their own routes.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CODING_CARDS, CODING_FORMULAS, answerTokens, bigOClass, checkDrill, checkExercise, drillAnswer, excerptFrom, exerciseAnswer } from './atlas_coding.js';
import { replyFromNdjson } from './brain_memory.js';
import { loadCodeIndex, makeIndex, _clearCodeIndexCache } from './code_index.js';
import { currentTurnActionPolicy } from './code_scout.js';
import { RESUME_BACKOFF_MS, RESUME_LIMIT } from './coding_failover.mjs';
import { ATLAS_CARDS, FORMULAS, LEVELS, atlasCard, atlasExport, atlasIntent, findAtlasCard } from './knowledge_atlas.js';
import { backoffMs, idempotencyKey, strategyFingerprint } from './recovery_policy.js';

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
// Node 22.13+ strips TypeScript types; on an older Node the TypeScript runs are skipped with a note.
const { stripTypeScriptTypes = null } = await import('node:module');
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
const canRun = (language) => ({ python: HAS_PYTHON, dart: HAS_DART, sql: Boolean(sqlite), typescript: Boolean(stripTypeScriptTypes) }[language] ?? true);

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
    assert.ok(c.limitations.join(' ').length >= 40, `${c.id} states its limitations`);
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
  // A flake k times in a row: enumerate every pass/fail outcome of k runs and keep the all-fail one.
  for (const [p, k] of [[0.1, 3], [0.05, 2], [0.3, 5], [0.5, 1]]) {
    let allFail = 0;
    for (let mask = 0; mask < 2 ** k; mask += 1) {
      let prob = 1;
      for (let i = 0; i < k; i += 1) prob *= (mask >> i) & 1 ? p : 1 - p;
      if (mask === 2 ** k - 1) allFail += prob;
    }
    assert.ok(Math.abs(CODING_FORMULAS.flakeStreak({ p, k }) - allFail) < 1e-12, `flake ${p} ${k}`);
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

test('the inspection, reasoning, CI and recovery cards agree with CHE\'s own code, skills and workflows', async () => {
  // Code inspection: her two entry points, as the trace defines them.
  assert.ok(read('server/cloudflare/self_development.js').includes("const ENTRY_POINTS = new Set(['lib/main.dart', 'server/cloudflare/worker.js']);"));
  assert.match(atlasCard('c-code-inspection').levels.intermediate, /lib\/main\.dart on the phone and server\/cloudflare\/worker\.js on the server/);
  // Reasoning: the che-debug order and its rule, word for word from the skill.
  const debug = read('.claude/skills/che-debug/SKILL.md');
  assert.ok(debug.includes('Order: **reproduce → locate → fix narrowly → prove → review.** Do not edit before the defect is reproduced.'));
  assert.ok(debug.includes('It counts as reproduced only when the output shows the wrong behavior.'));
  assert.ok(atlasCard('c-reasoning').che_note.includes('reproduce, locate, fix narrowly, prove, review'));
  // CI: the exercise's checks are CHE's real job names, and its verdicts are release_status.mjs's own.
  const ci = atlasCard('c-ci-validation');
  const workflow = read('.github/workflows/flutter-check.yml');
  assert.match(workflow, /^  analyze:$/m);
  assert.match(workflow, /^    name: Worker syntax and unit tests$/m);
  assert.ok(read('.claude/skills/che-release/scripts/release_status.mjs').includes("const NON_GATING = new Set(['Workers Builds: chey-app']);"));
  const { releaseStatus } = await import(pathToFileURL(join(ROOT, '.claude/skills/che-release/scripts/release_status.mjs')).href);
  const SHA = 'c'.repeat(40);
  for (const c of ci.exercises[0].cases) {
    const fetcher = async (url) => {
      if (String(url).endsWith('/commits/main')) return new Response(SHA);
      if (String(url).includes(`/commits/${SHA}/check-runs`)) return Response.json({ check_runs: c.args[0] });
      return new Response('{}', { status: 404 });
    };
    assert.equal((await releaseStatus({ sha: SHA, fetcher, token: '' })).checks.verdict, c.expected, JSON.stringify(c.args[0]));
  }
  // The deploy's live check, as the card's note describes it.
  const deploy = read('.github/workflows/che-worker-deploy.yml');
  assert.ok(deploy.includes('- name: Verify live deployed commit'));
  assert.ok(deploy.includes('const expected = process.env.EXPECTED_TAG.slice(0, 12);') && deploy.includes('health.version_tag === expected'));
  assert.ok(ci.che_note.includes('"Verify live deployed commit"') && ci.che_note.includes('first 12 characters'));
  // run_checks.sh and summarize_tap.mjs say what the card says they say.
  assert.ok(read('.claude/skills/che-debug/scripts/run_checks.sh').includes('NOT RUN here (no flutter/dart on PATH)'));
  assert.ok(read('.claude/skills/che-debug/scripts/summarize_tap.mjs').includes('the test run did not finish'));
  assert.ok(debug.includes('2026-10-14 a "research the market" test passed here and failed in CI'));
  // Recovery: the stale windows, the attempt ceiling and the backoff in the note are worker.js's.
  const { MAX_JOB_ATTEMPTS, enqueueJob, jobStaleMs } = mod;
  const note = atlasCard('c-recovery').che_note;
  assert.equal(MAX_JOB_ATTEMPTS, 4);
  assert.ok(note.includes(`after ${MAX_JOB_ATTEMPTS} attempts it is dead-lettered`), note);
  assert.deepEqual([jobStaleMs({ kind: 'chat' }), jobStaleMs({ kind: 'self_development' }), jobStaleMs({ kind: 'autonomy_exam' })], [5 * 60_000, 20 * 60_000, 20 * 60_000]);
  assert.ok(note.includes('5 minutes for most jobs and 20 for coding and exam jobs'));
  assert.ok(read('server/cloudflare/worker.js').includes('job.retry_at = now + backoffMs(attempts, 60_000, 15 * 60_000);'));
  assert.equal(idempotencyKey('job:chat', 'Draft the weekly report'), idempotencyKey('job:chat', '  draft the WEEKLY report '));
  // The recovery drill's fixed rule is what enqueueJob does today, at the same job ages.
  const drill = atlasCard('c-recovery').review_drills[0];
  drill.probe.calls.forEach(([job, now], i) => {
    const age = now - Date.parse(job.created_at);
    const at = new Date(Date.now() - age).toISOString();
    const data = { jobs: [{ id: `j${i}`, kind: 'chat', idempotency_key: 'k', status: job.status, retry_count: job.retry_count, created_at: at, updated_at: at }] };
    assert.equal(enqueueJob(data, { prompt: 'p', idempotency_key: 'k' }).deduplicated, drill.probe.fixed[i], JSON.stringify(job));
  });
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
    const right = x.kind === 'choice' ? `option ${'abcde'.indexOf(x.answer) + 1}` : x.answer;
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
  // "Option N", "number N", "the Nth one" and a letter are the Nth option; a bare value is that value.
  for (const said of ['b', 'option 2', 'number two', 'the second one', '1', 'one']) assert.ok(checkExercise(bs[1], said).correct, said);
  for (const said of ['option one', 'number one', 'the first one', 'a', '0']) assert.equal(checkExercise(bs[1], said).correct, false, said);
  const failover = atlasCard('c-model-failover').exercises[0];
  for (const said of ['too large', 'too_large', 'option 2', 'two']) assert.ok(checkExercise(failover, said).correct, said);
  assert.ok(checkExercise(atlasCard('c-checkpoints').exercises[0], 'limit reached').correct, 'a value said with spaces');
  for (const [id, said] of [['c-dynamic-programming', 'eighty-nine'], ['c-deployment', '.81'], ['c-deployment', '81%'], ['c-deployment', '81 percent']]) {
    assert.ok(checkExercise(atlasCard(id).exercises[0], said).correct, `${id}: ${said}`);
  }
  assert.ok(checkExercise(atlasCard('http-apis').exercises[0], '4xx').correct);
  for (const said of ['O(log n)', 'o of log n', 'big o of log n', 'log n', 'logarithmic', '2']) assert.ok(checkExercise(bs[2], said).correct, said);
  for (const said of ['O(n)', 'linear', 'n squared']) assert.equal(checkExercise(bs[2], said).correct, false, said);
  assert.deepEqual(answerTokens('zero point eight one'), ['0.81']);
  assert.deepEqual(answerTokens('[1, 4, 3, 2]'), answerTokens('one four three two'));
  assert.deepEqual(answerTokens('eighty nine'), ['89']);
  assert.deepEqual(answerTokens('1,346,269'), ['1346269']);
});

test('every review drill\'s bug is real and its fix works; real-fix drills name a test that exists', async (t) => {
  assert.ok(DRILLS.filter(({ d }) => d.from).length >= 2, 'drills from real CHE fixes');
  const gitHas = (sha) => { try { execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: ROOT, stdio: 'ignore' }); return true; } catch (_) { return false; } };
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
    const self = checkDrill(d, d.finding);
    assert.ok(self.named && self.correct === null, `${d.id}: the finding itself names both key ideas, and is still not graded "right"`);
    assert.equal(d.concepts.length, 2, `${d.id}: two key concepts`);
    assert.equal(checkDrill(d, 'looks fine to me').correct, false, `${d.id}: "looks fine" is not a finding`);
    const pin = d.from || d.pins;
    if (pin) {
      assert.ok(existsSync(join(ROOT, pin.test)), `${d.id}: ${pin.test} exists`);
      assert.ok(testNames(pin.test).includes(pin.test_name), `${d.id}: the test "${pin.test_name}" exists`);
    }
    // "Adapted from a real CHE fix" only when the commit's own diff holds the change. The pinned excerpts
    // (checked here, git or not) tie the drill's own text to the diff's lines.
    if (d.from) {
      assert.ok(d.from.pinned?.length >= 1, `${d.id}: pins an excerpt of its diff`);
      for (const p of d.from.pinned) {
        const field = p.drill === 'probe' ? JSON.stringify(d.probe.calls) : d[p.drill];
        assert.ok(field.includes(p.text), `${d.id}: its ${p.drill} holds "${p.text}"`);
        assert.ok(d.from[p.diff].includes(p.text), `${d.id}: the ${p.diff} line holds "${p.text}"`);
      }
      assert.match(d.from.commit, /^[0-9a-f]{7,40}$/, `${d.id}: names a commit`);
      if (!gitHas(d.from.commit)) { t.diagnostic(`${d.id}: commit ${d.from.commit} is not in this clone (shallow?), so its diff was not checked`); continue; }
      const diff = execFileSync('git', ['show', d.from.commit, '--', d.from.file], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n');
      assert.ok(diff.some((l) => l.startsWith('+') && l.includes(d.from.added)), `${d.id}: ${d.from.commit} adds "${d.from.added}"`);
      if (d.from.removed) assert.ok(diff.some((l) => l.startsWith('-') && l.includes(d.from.removed)), `${d.id}: ${d.from.commit} removes "${d.from.removed}"`);
    }
  }
  const named = DRILLS.filter(({ d }) => d.from).map(({ d }) => d.from.what);
  for (const pr of ['#351', '#349', '#328']) assert.ok(named.some((w) => w.includes(pr)), `a drill from ${pr}`);
  for (const id of ['c-model-failover.d1', 'c-architecture.d1']) {
    assert.equal(DRILLS.find(({ d }) => d.id === id).d.from, undefined, `${id} is illustrative: its rule was in CHE's code from its first commit`);
  }
  // Drill judging: whole words; both key concepts are "named", never graded "right"; "can't judge" otherwise.
  const drill = (id) => DRILLS.find(({ d }) => d.id === id).d;
  for (const [id, said, want] of [
    ['testing.d1', 'it records the failures correctly', false], ['testing.d1', 'push it', false], ['http-apis.d1', 'the server is fine', false],
    ['c-databases.d1', 'it returns a string', false], ['c-binary-search.d1', 'nothing is equal', false], ['c-python.d1', 'once upon a time', null],
    ['c-python.d1', 'none of it', false], ['c-security.d1', 'ask about the bill, the rest is fine', false], ['c-self-repair.d1', 'I own it', false],
    ['c-debugging.d1', 'it cuts the message silently so the dont at the end is lost', null],
  ]) assert.equal(checkDrill(drill(id), said).correct, want, `${id}: ${said}`);
  assert.equal(checkDrill(drill('c-debugging.d1'), 'it cuts the message silently so the dont at the end is lost').named, true);
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
  assert.ok(recursion.exercises.length && recursion.repo_examples.length && recursion.limitations.length);
  assert.ok(bundled.cards.filter((c) => c.domain === 'trading').every((c) => !('exercises' in c)), 'trading cards are unchanged');
  for (const c of bundled.cards.filter((x) => x.exercises)) {
    for (const x of c.exercises) assert.deepEqual(Object.keys(x), ['id', 'kind', 'topic', 'prompt', 'language', 'code', 'options', 'answer', 'explain']);
  }
});

// ─── Through /api/chat ────────────────────────────────────────────────────

// With `sql`, the Durable Object's SQLite store too, as the Brain uses it (atlas_brain.test.mjs).
function storageFor(saved, { sql = false } = {}) {
  const db = sql && sqlite ? new sqlite.DatabaseSync(':memory:') : null;
  return {
    ...(db ? { sql: { exec: (q, ...p) => { const stmt = db.prepare(q); return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []); } } } : {}),
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

async function owner({ saved = new Map(), sql = false, heard = null } = {}) {
  let calls = 0;
  const pending = [];
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async (_m, opts = {}) => {
      calls += 1;
      heard?.push(String([...(opts.messages || [])].reverse().find((m) => m.role === 'user')?.content || ''));
      return { response: 'MODEL ANSWERED' };
    } },
  };
  const state = new CheState({ storage: storageFor(saved, { sql }), waitUntil: (p) => pending.push(p) }, env);
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
  assert.match(second.reply, /Option 1: 0\.\nOption 2: 1\.\nOption 3: 3\.\nOption 4: 4\./, 'options are read as a numbered list');
  for (const words of ['1', 'number two', 'option b', 'the second one']) {
    assert.match((await che.say(words, { history: after(second.reply) })).reply, /^Right, sir: option 2, 1\./, words);
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

test('"give me a review drill" and "drill me on code review": a real CHE bug, checked by its key ideas', async () => {
  const che = await owner();
  for (const words of [...variants('Give me a review drill.'), ...variants('Drill me on code review.')]) {
    const out = await che.say(words);
    assert.equal(out.route, 'che_knowledge_atlas', words);
    assert.equal(out.modelCalls, 0);
    assert.match(out.reply, /^Review drill 1 of \d+, sir: The message that was cut to fit\. Adapted from a real CHE fix: PR #349/);
    assert.match(out.reply, /```javascript\nfunction intake/);
  }
  const drill = (await che.say('Give me a review drill')).reply;
  const right = await che.say("It cuts the message silently, so the don't at the end is lost", { history: after(drill) });
  assert.match(right.reply, /^You named both key ideas, sir: "cuts" and "silently"\. I don't grade review findings automatically, so compare yours with the finding: slice cuts the message silently/);
  assert.match(right.reply, /The fix:\n```javascript\nfunction intake[\s\S]*status: 413/);
  assert.match(right.reply, /pinned by the test "a chat message too long to take is refused whole, saying so; nothing runs \(issue #345\)" in server\/cloudflare\/worker_autonomy\.test\.mjs/);
  const wrong = await che.say('the bug is that the variable names are too short', { history: after(drill) });
  assert.match(wrong.reply, /^Not quite, sir\. The bug: slice cuts/);
  assert.match((await che.say('tell me the answer', { history: after(drill) })).reply, /^The bug, sir: slice cuts/);
  const next = await che.say('another drill', { history: after(right.reply) });
  assert.match(next.reply, /^Review drill 2 of \d+, sir: /);
  // The #351 drill, asked for by its card.
  const gate = await che.say('give me a review drill on secure coding');
  assert.match(gate.reply, /The "don't" that swallowed a payment\. Adapted from a real CHE fix: a review finding on PR #351[^\n]*commit f2992a7/);
  assert.match((await che.say('the prohibition runs past the comma so the payment is not held', { history: after(gate.reply) })).reply, /^You named both key ideas, sir: /);
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
  assert.notEqual((await che.say('how do you recover when the model fails')).route, 'che_knowledge_atlas', '"you" questions keep their usual routes');
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

test("review of #360: event words, CHE's own work, C and C++, generic words and ordinary sentences keep main's routes", async () => {
  const che = await owner();
  const route = async (words, history = []) => (await che.say(words, { history })).route;
  const turns = async (...words) => {
    let history = [];
    let last = null;
    for (const w of words) { last = await che.say(w, { history }); history = after(last.reply); }
    return last.route;
  };
  // B1: "the deploy" or "the commits" is never a card's exact name.
  for (const [words, want] of [
    ['explain the deploy', 'model'], ['tell me about the deployment', 'model'], ['walk me through the deployment', 'model'],
    ['tell me about the CI', 'model'], ['show me the code for the deploy', 'che_self_update'], ['show me the code for the commit', 'che_self_update'],
    ['what is the code for the deployment', 'che_self_update'],
  ]) assert.equal(await route(words), want, words);
  assert.equal(await turns('why did the deploy fail', 'walk me through the deployment'), 'model');
  assert.equal(await turns('review PR 360', 'explain the commits'), 'model');
  // B2: CHE's own deploys, commits and code keep their routes; a drill needs a drill word.
  for (const [words, want] of [
    ['where did you deploy it', 'che_self_update'], ['where did you deploy', 'che_self_update'], ['where did you commit that', 'model'],
    ['show me your code for checkpoints', 'che_repository_inspection'], ['review this code', 'model'], ['can we review this code', 'model'],
    ['lets review some code', 'model'],
  ]) assert.equal(await route(words), want, words);
  // B4 and S4: no card is C, C++ or C#, and a word with an everyday sense is not a coding lesson.
  for (const words of ['teach me C', 'teach me C++', 'explain C#', 'what is c++', 'teach me c programming', 'tell me about the inspection',
    'tell me about profiling', 'explain performance', 'what is security', 'what is a python', 'tell me about pythons',
    'explain the stack in trading', 'explain latency in trading', 'explain the database of trades']) {
    assert.equal(await route(words), 'model', words);
  }
  for (const words of ['explain code performance', 'teach me software security', 'explain stacks and queues', 'teach me Python']) {
    assert.equal(await route(words), 'che_knowledge_atlas', words);
  }
  // B3: after an exercise or a drill, only an answer is graded; anything else goes on as usual.
  const exercise = (await che.say('Give me a coding exercise on binary search')).reply;
  for (const words of ['what time is it', 'how is the weather today', 'I need to go to the store', 'never mind', 'yes', 'two tickets please',
    'no one told me', 'I think we should stop', 'its raining outside']) {
    assert.notEqual(await route(words, after(exercise)), 'che_knowledge_atlas', `after an exercise: ${words}`);
  }
  assert.equal(await route('calculate VWAP from the latest bars', after(exercise)), await route('calculate VWAP from the latest bars'), 'the trading lane answers it as it would anyway');
  for (const words of ['buy two tickets', 'delete my notes']) assert.equal(await route(words, after(exercise)), 'held', `${words}: held, never graded or lost`);
  for (const words of ['3', 'it returns 3', 'the answer is three', 'my answer is 3', "it's 3"]) {
    assert.match((await che.say(words, { history: after(exercise) })).reply, /^Right, sir: 3\./, words);
  }
  const drill = (await che.say('Give me a review drill')).reply;
  for (const words of ['what time is it', 'never mind', 'send the report to Bob on Friday']) {
    assert.notEqual(await route(words, after(drill)), 'che_knowledge_atlas', `after a drill: ${words}`);
  }
  assert.match((await che.say('the bug is that the end of the message is lost', { history: after(drill) })).reply, /^I can't judge that one automatically, sir\. The finding: /);
  // The answer forms themselves, without chat.
  const bs = atlasCard('c-binary-search').exercises[0];
  assert.equal(exerciseAnswer(bs, 'what time is it'), null);
  assert.equal(exerciseAnswer(bs, 'never mind, it returns 3'), null, '"never mind" is never an answer');
  assert.equal(exerciseAnswer(bs, 'my answer is 3'), '3');
  assert.equal(drillAnswer(atlasCard('c-debugging').review_drills[0], 'send the report to Bob on Friday'), null);
});

test('re-review of #360: word answers, the language name, CHE\'s parts and answer forms', async () => {
  const che = await owner();
  const route = async (words, history = []) => (await che.say(words, { history })).route;
  // Blocker 1: a word-answer exercise grades only its own words; voice control and small talk go on as usual.
  const ordinary = ['repeat that', 'slow down', 'louder', 'pause', 'continue', 'speak up', 'huh', 'sorry', 'hang on', 'not sure', 'good morning', 'the weather', 'is it raining'];
  for (const id of ['variables', 'http-apis']) {
    const x = atlasCard(id).exercises[0];
    for (const words of ordinary) assert.equal(exerciseAnswer(x, words), null, `${x.id}: ${words}`);
    const set = (await che.say(`give me an exercise on ${x.topics[0]}`)).reply;
    assert.match(set, new RegExp(`^Exercise 1 of 1 on ${atlasCard(id).title}`));
    for (const words of ordinary) assert.notEqual(await route(words, after(set)), 'che_knowledge_atlas', `after ${x.id}: ${words}`);
  }
  const typeofEx = atlasCard('variables').exercises[0];
  assert.match((await che.say('string', { history: after((await che.say('give me an exercise on typeof')).reply) })).reply, /^Not quite, sir\. I heard "string"; the answer is object\./, 'another typeof result is a real, wrong answer');
  assert.ok(checkExercise(typeofEx, 'object').correct);
  // Blocker 2: only the language's own name is the language lesson.
  for (const words of ['explain this python code', 'explain the python code', 'help me understand this python code', 'walk me through the python code',
    'explain this js code', 'explain this dart code', 'explain that javascript', 'explain this python']) {
    assert.equal(await route(words), 'model', words);
  }
  for (const words of ['teach me python', 'teach me the python language', 'explain javascript', 'teach me python programming']) {
    assert.equal(await route(words), 'che_knowledge_atlas', words);
  }
  // CHE's own parts keep their routes; the concept phrase is the lesson.
  for (const [words, want] of [
    ['explain the cloudflare worker', 'che_repository_inspection'], ['show me the code for checkpoints', 'che_self_update'],
    ['show me the code for failover', 'che_self_update'], ['show me the code for self repair', 'che_self_update'],
    ['tell me about the checkpoint', 'model'], ['explain the checkpoint', 'model'], ['show me CHEs code for checkpoints', 'che_self_update'],
  ]) assert.equal(await route(words), want, words);
  for (const words of ['teach me checkpoints', 'explain model failover', 'where in CHEs code is backoff used', '/learn checkpoints code']) {
    assert.equal(await route(words), 'che_knowledge_atlas', words);
  }
  // Correct sentence answers and code-word findings are taken.
  const ex = (id) => atlasCard(id).exercises[0];
  assert.ok(checkExercise(ex('c-model-failover'), 'the request is too large').correct);
  assert.ok(checkExercise(ex('c-checkpoints'), 'the resume limit is reached').correct);
  assert.ok(checkExercise(ex('c-self-repair'), 'yes they are the same').correct);
  assert.equal(checkExercise(ex('c-model-failover'), 'it is not too large').correct, false, 'a denied option is not that option');
  // A polite "no thanks" on a yes/no exercise is not an answer.
  for (const words of ['no thanks', 'no problem', 'no thank you', 'no worries']) assert.equal(exerciseAnswer(ex('c-self-repair'), words), null, words);
  const drill = (id) => DRILLS.find(({ d }) => d.id === id).d;
  for (const [id, words] of [['c-debugging.d1', 'slice cuts the message silently so the last words are lost'], ['c-databases.d1', 'sql injection, use a parameter'],
    ['testing.d1', 'check does not record failures so the test can never fail']]) {
    assert.ok(drillAnswer(drill(id), words), `${id}: "${words}" is a finding`);
    assert.equal(checkDrill(drill(id), words).named, true, `${id}: ${words}`);
  }
  // A key concept said the other way round from the finding is not judged, and correct answers phrased
  // that way are never called wrong.
  assert.equal(checkDrill(drill('c-python.d1'), 'the default is not shared').correct, null);
  assert.equal(checkDrill(drill('c-python.d1'), 'the default is not shared').named, false);
  assert.equal(checkDrill(drill('c-python.d1'), 'the default list is shared by every call').named, true);
  for (const [id, words] of [['c-binary-search.d1', 'it never checks the last item'], ['c-binary-search.d1', 'the loop is not inclusive, so the last item is skipped'],
    ['c-security.d2', 'it does not check 127.0.0.1, only the word localhost'], ['c-performance.d1', 'the cache key does not include the currency'],
    ['c-debugging.d1', 'slice cuts it without refusing'], ['c-security.d1', 'the comma does not end the dont, so the payment is not held'],
    ['c-architecture.d1', 'the frame is not lossless, it drops not today'], ['c-model-failover.d1', 'too large is not checked first, so it is retried forever'],
    ['c-python.d1', 'the default list is not fresh, every call shares it']]) {
    assert.notEqual(checkDrill(drill(id), words).correct, false, `${id}: a correct finding is never called wrong: ${words}`);
  }
  // "It's fine" is still not quite.
  assert.equal(checkDrill(drill('c-python.d1'), 'the default list is fine').correct, false);
  // The same ideas said of the fixed code describe the fix, not the bug: a drill is never graded "right".
  for (const [id, words] of [['c-performance.d1', 'the key includes the currency'], ['c-performance.d1', 'the key already has the currency in it'],
    ['c-binary-search.d1', 'the loop is inclusive and checks the last item'], ['c-databases.d1', 'it uses a parameter so there is no injection'],
    ['testing.d1', 'it records every failure'], ['c-debugging.d1', 'it refuses the whole message instead of cutting it'],
    ['http-apis.d1', 'it only retries 5xx and never 400'], ['concurrency.d1', 'for of waits for every callback'],
    ['c-python.d1', 'the default list is fresh on every call'], ['c-security.d2', 'it already blocks 127.0.0.1 and private addresses'],
    ['c-security.d1', 'the payment is held because the comma ends the dont'], ['c-model-failover.d1', 'too large is checked first so it is never retried'],
    ['c-self-repair.d1', 'the gate is protected so an attempt cannot edit it'], ['c-architecture.d1', 'the frame keeps not today and is lossless']]) {
    assert.notEqual(checkDrill(drill(id), words).correct, true, `${id}: the fixed behaviour is not the bug: ${words}`);
  }
  for (const { d } of DRILLS) for (const words of [d.finding, 'it is fine', 'the key includes the currency', 'the loop is inclusive']) {
    assert.notEqual(checkDrill(d, words).correct, true, `${d.id}: never graded right: ${words}`);
  }
  // The bug said plainly names both key ideas.
  for (const [id, words] of [['c-performance.d1', 'the key ignores the currency'], ['c-self-repair.d1', 'the gate is not protected, an attempt can edit it'],
    ['c-architecture.d1', 'it drops not today but still says lossless'], ['c-debugging.d1', 'the message is cut silently instead of refused']]) {
    assert.equal(checkDrill(drill(id), words).named, true, `${id}: ${words}`);
  }
});

test('through /api/chat with SQLite: exercise and drill answers are graded, never learned as speech corrections', { skip: sqlite ? false : 'node:sqlite unavailable' }, async () => {
  const heard = [];
  const saved = new Map();
  const che = await owner({ saved, sql: true, heard });
  const check = async (ask, answer, kind, reply) => {
    const set = (await che.say(ask)).reply;
    const out = await che.say(answer, { history: [{ role: 'user', content: ask }, { role: 'assistant', content: set }] });
    assert.equal(out.route, 'che_knowledge_atlas', `${answer} → ${out.route}`);
    assert.equal(out.done.atlas_kind, kind, answer);
    assert.match(out.reply, reply, answer);
  };
  await check('give me a review drill on python', 'the default is not shared', 'coding_drill_answer', /^I can't judge that one automatically, sir\./);
  await check('give me a review drill', 'it does not cut anything', 'coding_drill_answer', /^(?:I can't judge that one automatically|Not quite), sir\./);
  await check('give me a review drill on binary search', 'it never checks the last item', 'coding_drill_answer', /^(?:I can't judge that one automatically|Right), sir/);
  await check('give me an exercise on dynamic programming', 'eighty nine not ninety', 'coding_answer', /^Right, sir: 89\./);
  await check('give me a review drill on concurrency', 'forEach does not wait for the async callbacks', 'coding_drill_answer', /^You named both key ideas, sir: /);
  assert.deepEqual(saved.get('speech_corrections') || [], [], 'no speech correction was learned');
  const next = await che.say('what is the weather like in Paris');
  assert.equal(next.route, 'model');
  assert.ok(heard.at(-1).endsWith('what is the weather like in Paris'), `the model read his own words: ${heard.at(-1)}`);
});

test('code inspection, reasoning, CI validation and recovery: lessons reach the atlas; inspection, job, CI and "your reasoning" turns keep main\'s routes', async () => {
  const che = await owner();
  const sent = requests.length;
  const route = async (words, history = []) => (await che.say(words, { history })).route;
  // The new cards by name, typed, spoken and with CHE's name in front: no model, no network.
  for (const [phrase, start] of [
    ['Teach me code inspection', 'Code inspection: reading unfamiliar code before changing it, beginner level, sir.'],
    ['Explain CI validation at an advanced level', 'CI validation: what a green check proves, expert level, sir.'],
    ['Quiz me on recovery', 'Quiz on Recovery: resuming after a crash without repeating work, sir.'],
    ['Teach me reasoning about code', 'Reasoning about code: invariants, small cases and evidence, beginner level, sir.'],
    ['What is idempotency?', 'Recovery: resuming after a crash without repeating work, beginner level, sir.'],
    ['Explain invariants', 'Reasoning about code: invariants, small cases and evidence, beginner level, sir.'],
    ['What is a flaky test?', 'CI validation: what a green check proves, beginner level, sir.'],
  ]) {
    for (const words of variants(phrase)) {
      const out = await che.say(words);
      assert.equal(out.route, 'che_knowledge_atlas', words);
      assert.equal(out.modelCalls, 0, words);
      assert.ok(out.reply.startsWith(start), `${words}: ${out.reply.slice(0, 120)}`);
    }
  }
  const exercise = await che.say('Give me an exercise on code inspection');
  assert.match(exercise.reply, /^Exercise 1 of 2 on Code inspection: reading unfamiliar code before changing it, sir, in JavaScript\./);
  const right = await che.say('5', { history: after(exercise.reply) });
  assert.match(right.reply, /^Right, sir/);
  // The second one is graded by CHE's own read-only rule; its options are answers, never commands.
  const second = await che.say('next one', { history: after(right.reply) });
  assert.match(second.reply, /^Exercise 2 of 2 on Code inspection/);
  for (const [said, ok] of [['a request to change code', true], ['option 2', true], ['an inspection only', false]]) {
    const out = await che.say(said, { history: after(second.reply) });
    assert.equal(out.route, 'che_knowledge_atlas', said);
    assert.equal(/^Right, sir/.test(out.reply), ok, `${said}: ${out.reply.slice(0, 80)}`);
  }
  const drill = await che.say('Give me a review drill on recovery');
  assert.match(drill.reply, /The retry that stopped blocking its duplicate/);
  const how = await che.say('How does CHE recover interrupted jobs?');
  assert.equal(how.route, 'che_knowledge_atlas');
  assert.match(how.reply, /server\/cloudflare\/worker\.js, enqueueJob/);
  assert.match(how.reply, /server\/cloudflare\/worker\.js, processJobs/);
  // Counter-cases, as main routes them, fresh and right after an atlas exercise or drill.
  for (const history of [[], after(exercise.reply), after(drill.reply)]) {
    for (const [words, want] of [
      ['inspect the code', 'model'],
      ['inspect my repo', 'model'],
      ['inspect your code', 'che_repository_inspection'],
      ['inspect your repository', 'che_repository_inspection'],
      ['explain your code', 'che_repository_inspection'],
      ['recover my job', 'che_self_development'],
      ['recover the job', 'che_self_development'],
      ['resume the coding job', 'che_coding_resume'],
      ['run CI', 'model'],
      ['why did CI fail', 'model'],
      ['did CI pass', 'model'],
      ['rerun the failed checks', 'model'],
      ["what's your reasoning", 'model'],
      ['explain your reasoning', 'model'],
      ['teach me reasoning', 'model'],
      ['teach me reading', 'model'],
      ['what are entry points', 'che_trading_desk'],
    ]) assert.equal(await route(words, history), want, `${words} after ${history.length ? 'practice' : 'nothing'}`);
  }
  assert.equal(findAtlasCard('code inspection')?.id, 'c-code-inspection', 'the name moved from the planning card');
  assert.equal(findAtlasCard('ci validation')?.id, 'c-ci-validation', 'the name moved from the self-repair card');
  assert.equal(requests.length, sent, 'no network');
});

test('summary: every language that could run here did', () => {
  // CI's Worker job has Python and node:sqlite; Dart runs where the Flutter SDK is on PATH.
  if (HAS_PYTHON && sqlite) assert.ok(SKIPPED.every((s) => /dart/.test(s) || atlasCard(s.split(' ')[0])?.example?.language === 'dart' || EXERCISES.some(({ x }) => x.id === s && x.language === 'dart')), SKIPPED.join(', '));
  assert.ok(CODING_CARDS.length >= 18);
});
