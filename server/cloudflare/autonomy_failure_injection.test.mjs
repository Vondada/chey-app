// Failure-injection regression suite for CHE's autonomous engineering
// lifecycle: chat → coding → review → repair → PR → CI → merge → deploy.
// Every test injects a realistic failure and asserts CHE recovers by herself
// (or stops cleanly with the right failure class) without owner homework.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEdits, packEvidence, prepareSelfUpdate, focusView } from './self_development.js';
import {
  AgentBudget, FAILURE_CLASS, classifyFailure, isEvidenceRequest, ownerEngineeringMessage,
  stripOwnerHomework, strategyFingerprint, backoffMs, idempotencyKey,
} from './recovery_policy.js';
import { dartStaticCheck, staticRegression, jsStaticCheck } from './dart_check.js';
import { mergeSelfUpdatePr, openSelfUpdatePr, selfUpdateStatus, updateBranchName, validateUpdateFiles, workerDeploymentStatus } from './self_update.js';
import { fitToBudget, resetRouterForTests, routeText, routedEnv } from './ai_router.js';
import { _clearCodeIndexCache, cachedCodeIndex } from './code_index.js';
import { gradeLevel } from './autonomy_exam.js';

const HOMEWORK = /(?:provide|send|paste|share|copy)\s+(?:me\s+)?(?:the\s+)?(?:source|code|file|filename|exact text|line)|source (?:code )?(?:was|is) not provided|cannot inspect|tell me the file|token|stack trace|retry trace|\b429\b|\b503\b/i;

const MAIN = `import 'package:flutter/material.dart';\n\nclass Home {\n  String _statusBanner = 'Ready. Type or speak a request.';\n  String greet(Map m) => 'Hi \${m['name']}';\n}\n`;
const HELPER = `class Helper {\n  int add(int a, int b) => a + b;\n}\n`;

function memoryStore() {
  const m = new Map();
  return { get: async (k) => m.get(k), put: async (k, v) => m.set(k, v), m };
}

// Configurable fake GitHub. `heads` is a list of commit SHAs returned by
// successive ref reads (main moving); `files` maps sha → { path: text }.
function fakeGitHub({
  files = { 'lib/main.dart': MAIN, 'lib/helper.dart': HELPER },
  filesAt = null,
  heads = ['sha1'],
  searchStatus = 200,
  searchItems = null,
  flakyReads = new Set(),
  readLog = [],
} = {}) {
  let refReads = 0;
  const flaky = new Set(flakyReads);
  return async (url) => {
    const u = String(url);
    const ok = (data) => ({ ok: true, status: 200, json: async () => data });
    const fail = (status) => ({ ok: false, status, json: async () => ({ message: `status ${status}` }) });
    if (u.includes('/search/code')) {
      if (searchStatus !== 200) return fail(searchStatus);
      if (searchItems) return ok({ items: searchItems.map((path) => ({ path })) });
      const q = decodeURIComponent(u.split('q=')[1]);
      const term = q.split('"')[1] || '';
      return ok({ items: Object.entries(files).filter(([, src]) => term && src.includes(term)).map(([path]) => ({ path })) });
    }
    if (u.endsWith('/o/r')) return ok({ default_branch: 'main' });
    if (u.includes('/git/ref/heads/main')) {
      const sha = heads[Math.min(refReads, heads.length - 1)];
      refReads += 1;
      return ok({ object: { sha } });
    }
    if (u.includes('/git/trees/')) {
      const sha = /\/git\/trees\/([^?]+)/.exec(u)?.[1];
      return ok({ tree: Object.keys(filesAt?.[sha] || files).map((path) => ({ type: 'blob', path })) });
    }
    const m = /\/contents\/(.+)\?ref=(.+)$/.exec(u);
    if (m) {
      const path = m[1];
      const ref = decodeURIComponent(m[2]);
      readLog.push({ path, ref });
      if (flaky.has(path)) { flaky.delete(path); return fail(503); }
      const set = filesAt?.[ref] || files;
      if (!(path in set)) return fail(404);
      return ok({ sha: `blob-${ref}-${path}`, content: Buffer.from(set[path]).toString('base64') });
    }
    return fail(404);
  };
}

const json = (value) => ({ response: JSON.stringify(value) });
const roleOf = (input) => input.messages[0].content;
const payloadOf = (input) => JSON.parse(input.messages[1].content);
const GOOD_EDIT = { summary: 'Friendlier ready banner', edits: [{ path: 'lib/main.dart', find: "'Ready. Type or speak a request.'", replace: "'Ready when you are.'" }] };

function scriptedAI(handlers, log = []) {
  return {
    run: async (_model, input) => {
      const system = roleOf(input);
      log.push({ system, input });
      // Every agent payload must be valid JSON and carry the evidence floor.
      JSON.parse(input.messages[1].content);
      assert.ok(input.che_min_input_chars >= input.messages[1].content.length, 'router must be told not to clip evidence');
      if (system.includes('Source Recovery Architect')) return handlers.recovery ? handlers.recovery(input) : json({ plan: 'look at main', search_terms: ['Ready'], paths: ['lib/main.dart'] });
      if (system.includes('Architect')) return handlers.planner ? handlers.planner(input) : json({ plan: 'improve banner', search_terms: ['Ready. Type or speak a request.'], paths: ['lib/main.dart'] });
      if (system.includes('No-Change')) return handlers.noChange ? handlers.noChange(input) : json({ approved: false, notes: ['A concrete change is still possible.'] });
      if (system.includes('Review')) return handlers.review ? handlers.review(input) : json({ approved: true, target_correct: true, notes: ['ok'] });
      return handlers.engineer ? handlers.engineer(input) : json(GOOD_EDIT);
    },
  };
}

const env = (ai) => ({ CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r', AI: ai });

function assertNoHomework(out) {
  for (const text of [out.owner_message, out.next].filter(Boolean)) assert.doesNotMatch(String(text), HOMEWORK, String(text));
}

// ─── Recovery policy units ───────────────────────────────────────────────────

test('recovery policy classifies failures into the four owner-facing classes', () => {
  assert.equal(classifyFailure({ status: 429 }).failure_class, FAILURE_CLASS.TEMPORARY_EXTERNAL);
  assert.equal(classifyFailure({ status: 503 }).failure_class, FAILURE_CLASS.TEMPORARY_EXTERNAL);
  assert.equal(classifyFailure(Object.assign(new Error('x'), { category: 'temporary_cloud_unavailable' })).failure_class, FAILURE_CLASS.TEMPORARY_EXTERNAL);
  assert.equal(classifyFailure({ status: 401, detail: 'Bad credentials' }).failure_class, FAILURE_CLASS.PERMANENT_EXTERNAL);
  assert.equal(classifyFailure({ status: 403, detail: 'Resource not accessible' }).failure_class, FAILURE_CLASS.PERMANENT_EXTERNAL);
  assert.equal(classifyFailure('Unable to inspect the current repository because the source code was not provided.').failure_class, FAILURE_CLASS.INTERNAL);
  assert.equal(classifyFailure('In lib/a.dart the find text does not exist').failure_class, FAILURE_CLASS.INTERNAL);
  assert.equal(classifyFailure({ owner_authorization_required: true }).failure_class, FAILURE_CLASS.AUTHORIZATION);
});

test('evidence-request detector catches agent homework and strips it from owner text', () => {
  for (const text of [
    'Unable to inspect the current repository because the source code was not provided.',
    'Please provide the source code for lib/main.dart.',
    'Send me the filename and line numbers.',
    'Copy the exact text you want changed.',
    'I cannot review the implementation without seeing the actual source.',
    'Tell me which file contains the banner.',
  ]) assert.equal(isEvidenceRequest(text), true, text);
  for (const text of ['Edited lib/main.dart around line 4.', 'The diff changes the wrong banner.', 'Reject: missing semicolon in lib/a.dart.']) {
    assert.equal(isEvidenceRequest(text), false, text);
  }
  assert.equal(stripOwnerHomework('Wrong widget edited. Please provide the source code.'), 'Wrong widget edited.');
  for (const cls of Object.values(FAILURE_CLASS)) assert.doesNotMatch(ownerEngineeringMessage(cls), HOMEWORK);
});

test('materially equivalent strategies share a fingerprint across providers', () => {
  const a = { edits: [{ path: 'lib/a.dart', find: "  foo('x');", replace: "foo('y');" }] };
  const b = { edits: [{ path: 'lib/a.dart', find: '12| foo("x");', replace: '  foo("y");  ' }] };
  const c = { edits: [{ path: 'lib/a.dart', find: "foo('x');", replace: "foo('z');" }] };
  assert.equal(strategyFingerprint(a), strategyFingerprint(b));
  assert.notEqual(strategyFingerprint(a), strategyFingerprint(c));
});

test('agent budget enforces per-stage and per-job ceilings', () => {
  const budget = new AgentBudget({ maxCalls: 3, maxTokens: 1000, stageLimits: { reviewer: 1 } });
  budget.spend('reviewer', 10);
  assert.throws(() => budget.spend('reviewer', 10), /budget/);
  budget.spend('engineer', 10);
  assert.throws(() => budget.spend('engineer', 5000), /budget/);
  budget.spend('engineer', 10);
  assert.throws(() => budget.spend('planner', 1), /budget/);
  assert.equal(backoffMs(0, 1000), 1000);
  assert.equal(backoffMs(3, 1000), 8000);
  assert.equal(backoffMs(30, 1000, 5000), 5000);
  assert.equal(idempotencyKey('job', 'Fix  the BANNER'), idempotencyKey('job', 'fix the banner'));
});

// ─── Static validation ───────────────────────────────────────────────────────

test('Dart scanner handles interpolation with quotes and chained calls (no false failures)', () => {
  const src = `import 'package:http/http.dart' as http;\nclass A {\n  String s(Map m) => 'x \${m['k']} \${m["j"]} y';\n  Future f() => http\n      .get(Uri.parse('u'));\n  String r = r'\\d{3}';\n}\n`;
  assert.equal(dartStaticCheck('lib/a.dart', src), null);
  assert.match(dartStaticCheck('lib/a.dart', 'class A {\n'), /unclosed/);
  assert.equal(jsStaticCheck('server/cloudflare/a.js', 'const re = /[{(]/g;\nconst t = `a ${b ? `x${c}` : "}"}`;\nexport default { a: 1 };\n'), null);
  assert.match(jsStaticCheck('server/cloudflare/a.js', 'function f() {\n'), /unclosed/);
});

test('static validation is baseline-relative: pre-existing quirks never block edits', () => {
  const quirky = "class A {\n  // TODO: legacy\n  int x = 1;\n}\n";
  assert.equal(staticRegression('lib/a.dart', quirky, quirky.replace('1', '2')), null);
  assert.match(staticRegression('lib/a.dart', 'class A {}\n', 'class A {}\n// TODO: later\n') || '', /placeholder/);
  assert.equal(validateUpdateFiles([{ path: 'lib/a.dart', content: quirky.replace('1', '2') }], { baseline: { 'lib/a.dart': quirky } }).error, undefined);
  assert.ok(validateUpdateFiles([{ path: 'lib/a.dart', content: 'class A {' }], { baseline: { 'lib/a.dart': 'class A {}' } }).error);
});

// ─── Evidence packing ────────────────────────────────────────────────────────

test('large files: relevant code far beyond the first window still reaches agents, inside budget', () => {
  const big = Array.from({ length: 6000 }, (_, i) => (i === 5200 ? "  String banner = 'Deep target text';" : `  // filler ${i} ................................`)).join('\n');
  const view = focusView(big, ['Deep target text'], 3000);
  assert.match(view.text, /5201\| {3}String banner = 'Deep target text';/);
  assert.ok(view.text.length <= 3000);
  const packed = packEvidence(new Map([['lib/big.dart', big], ['lib/small.dart', HELPER]]), { terms: ['Deep target text'], budget: 6000 });
  assert.ok(JSON.stringify(packed).length < 7500);
  assert.match(packed[0].source, /Deep target text/);
  assert.equal(packed[1].whole_file, true);
});

// ─── Pipeline failure injection ──────────────────────────────────────────────

test('vague request + malformed planners + failing code search still yields a real reviewed diff', async () => {
  const log = [];
  const ai = scriptedAI({
    planner: () => ({ response: 'Sure! Here is my plan: improve things.' }),
    recovery: () => ({ response: 'not json either' }),
  }, log);
  const out = await prepareSelfUpdate(env(ai), 'CHE, make one small real improvement to the app.', fakeGitHub({ searchStatus: 500 }), memoryStore());
  assert.equal(out.status, 200, out.detail);
  assert.deepEqual(out.proposal.files.map((f) => f.path), ['lib/main.dart']);
  assert.equal(out.proposal.expected_base_sha, 'sha1');
  assert.equal(out.proposal.base_files['lib/main.dart'], 'blob-sha1-lib/main.dart');
  assert.equal(out.approval_required, true);
  assertNoHomework(out);
});

test('hallucinated planner paths and zero search hits fall back to real files', async () => {
  const ai = scriptedAI({ planner: () => json({ plan: 'p', search_terms: ['no-such-token'], paths: ['lib/ghost.dart', 'server/x/none.js'] }) });
  const out = await prepareSelfUpdate(env(ai), 'polish the home banner wording', fakeGitHub({ searchItems: [] }), memoryStore());
  assert.equal(out.status, 200, out.detail);
  assert.ok(!JSON.stringify(out.proposal).includes('ghost'));
});

test('transient source read failure is retried; reads are pinned to the inspected commit', async () => {
  const readLog = [];
  const out = await prepareSelfUpdate(env(scriptedAI({})), 'change the home status wording', fakeGitHub({ flakyReads: new Set(['lib/main.dart']), readLog }), memoryStore());
  assert.equal(out.status, 200, out.detail);
  assert.ok(readLog.every((r) => r.ref === 'sha1'), 'reads use the commit SHA, not the moving branch name');
});

test('engineer claiming source was not supplied is an agent failure, not owner homework', async () => {
  let engineerCalls = 0;
  const mem = memoryStore();
  const ai = scriptedAI({
    engineer: (input) => {
      engineerCalls += 1;
      assert.ok(payloadOf(input).inspected.some((v) => v.source.includes('Ready. Type or speak a request.')), 'engineer receives source');
      return engineerCalls === 1
        ? json({ no_change: true, summary: 'The source code was not provided, please send the file.', evidence: ['source not provided'] })
        : json(GOOD_EDIT);
    },
  });
  const out = await prepareSelfUpdate(env(ai), 'change the home status wording', fakeGitHub(), mem);
  assert.equal(out.status, 200, out.detail);
  assert.ok(out.diagnostics.outcomes.some((o) => o.outcome === 'agent_evidence_request'));
  const lessons = mem.m.get('che_team_lessons') || [];
  assert.ok(!lessons.some((l) => isEvidenceRequest(l.text)));
});

test('engineer editing a real but uninspected file gets it fetched automatically', async () => {
  const ai = scriptedAI({
    planner: () => json({ plan: 'p', search_terms: ['Ready. Type or speak a request.'], paths: ['lib/main.dart'] }),
    engineer: () => json({ summary: 'helper', edits: [{ path: 'lib/helper.dart', find: 'a + b', replace: '(a + b)' }] }),
  });
  const out = await prepareSelfUpdate(env(ai), 'make the helper math explicit', fakeGitHub({ searchItems: ['lib/main.dart'] }), memoryStore());
  assert.equal(out.status, 200, out.detail);
  assert.deepEqual(out.proposal.files.map((f) => f.path), ['lib/helper.dart']);
  assert.equal(out.proposal.base_files['lib/helper.dart'], 'blob-sha1-lib/helper.dart');
});

test('nonexistent, protected, missing-anchor, ambiguous and identical edits each recover inside three strategies', async () => {
  const bad = [
    { summary: 'ghost', edits: [{ path: 'lib/ghost.dart', find: 'x', replace: 'y' }] },
    { summary: 'workflow', edits: [{ path: '.github/workflows/x.yml', find: 'a', replace: 'b' }] },
    { summary: 'missing', edits: [{ path: 'lib/main.dart', find: 'not in file', replace: 'y' }] },
    { summary: 'same', edits: [{ path: 'lib/main.dart', find: "'Ready. Type or speak a request.'", replace: "'Ready. Type or speak a request.'" }] },
    { summary: 'ambiguous', edits: [{ path: 'lib/main.dart', find: 'String', replace: 'final String' }] },
  ];
  let n = 0;
  const ai = scriptedAI({ engineer: () => json(n < bad.length ? bad[n++] : GOOD_EDIT) });
  const out = await prepareSelfUpdate(env(ai), 'change the home status wording', fakeGitHub(), memoryStore());
  assert.equal(out.status, 200, out.detail);
  const outcomes = out.diagnostics.outcomes.map((o) => o.outcome);
  for (const expected of ['nonexistent_path', 'protected_path', 'missing_anchor', 'no_diff', 'ambiguous_anchor']) assert.ok(outcomes.includes(expected), expected);
});

test('live missing-anchor failure refreshes exact-head source before the next engineer and recovery architect', async () => {
  let calls = 0;
  let recoveries = 0;
  const readLog = [];
  const current = MAIN.replace('Ready. Type or speak a request.', 'Current ready banner.');
  const bad = { summary: 'stale banner', edits: [{ path: 'lib/main.dart', find: "'Old ready banner.'", replace: "'Ready when you are.'" }] };
  const ai = scriptedAI({
    recovery: (input) => {
      recoveries += 1;
      const p = payloadOf(input);
      assert.equal(p.repository_sha, 'sha2');
      assert.ok(p.inspected.some((f) => f.source.includes('Current ready banner.')));
      assert.ok(!p.inspected.some((f) => f.source.includes('Type or speak a request.')));
      return json({ plan: 'use current _statusBanner', paths: ['lib/main.dart'], search_terms: ['_statusBanner'] });
    },
    engineer: (input) => {
      calls += 1;
      if (calls <= 2) return json(bad);
      const p = payloadOf(input);
      assert.equal(p.repository_sha, 'sha2');
      assert.ok(readLog.some((r) => r.ref === 'sha2' && r.path === 'lib/main.dart'));
      assert.ok(p.failed_anchors.length > 0);
      assert.ok(p.inspected.some((f) => f.source.includes('Current ready banner.')));
      return json({ summary: 'Current banner', edits: [{ path: 'lib/main.dart', find: "'Current ready banner.'", replace: "'Ready when you are.'" }] });
    },
  });
  const out = await prepareSelfUpdate(env(ai), 'change the home status wording', fakeGitHub({ heads: ['sha1', 'sha2'], filesAt: { sha1: { 'lib/main.dart': MAIN }, sha2: { 'lib/main.dart': current } }, readLog }), memoryStore());
  assert.equal(out.status, 200, out.detail);
  assert.ok(recoveries > 0);
  assert.equal(out.proposal.expected_base_sha, 'sha2');
  assert.equal(out.proposal.base_files['lib/main.dart'], 'blob-sha2-lib/main.dart');
  assert.ok(out.proposal.files[0].content.includes('Ready when you are.'));
  assert.equal(out.validation.deterministic, 'passed');
  assert.ok(out.review.every((r) => r.approved));
  assertNoHomework(out);
});

test('a target moved to a new file is rediscovered from the current tree and graph after anchor failure', async () => {
  let calls = 0;
  const ai = scriptedAI({ engineer: (input) => {
    if (++calls <= 2) return json({ edits: [{ path: 'lib/main.dart', find: 'obsolete banner', replace: 'Hi' }] });
    const p = payloadOf(input);
    assert.equal(p.repository_sha, 'sha2');
    assert.ok(p.inspected.some((f) => f.path === 'lib/home.dart' && f.source.includes('_statusBanner')));
    assert.ok(!p.inspected.some((f) => f.path === 'lib/main.dart' && f.source.includes('_statusBanner')));
    return json({ ...GOOD_EDIT, edits: GOOD_EDIT.edits.map((e) => ({ ...e, path: 'lib/home.dart' })) });
  } });
  const out = await prepareSelfUpdate(env(ai), 'change the home status wording', fakeGitHub({ heads: ['sha1', 'sha2'], filesAt: { sha1: { 'lib/main.dart': MAIN }, sha2: { 'lib/main.dart': "import 'home.dart';\nvoid main() { Home(); }\n", 'lib/home.dart': MAIN } } }), memoryStore());
  assert.equal(out.status, 200, out.detail);
  assert.deepEqual(out.proposal.files.map((f) => f.path), ['lib/home.dart']);
  assert.equal(out.proposal.expected_base_sha, 'sha2');
});

test('anchor recovery bypasses and replaces cached source, including same-SHA search evidence', async () => {
  _clearCodeIndexCache();
  const mem = memoryStore();
  const sha = 'cached-anchor-recovery';
  mem.m.set('codeidx_meta', { sha, chunks: 1 });
  mem.m.set('codeidx:0', [['lib/main.dart', MAIN.replace('Ready. Type or speak a request.', 'Obsolete evidence.'), 'obsolete-blob']]);
  let calls = 0;
  const ai = scriptedAI({ engineer: (input) => {
    if (++calls <= 2) return json({ summary: 'bad anchor', edits: [{ path: 'lib/main.dart', find: 'No such banner', replace: 'Hi' }] });
    assert.ok(payloadOf(input).inspected.some((f) => f.source.includes('Type or speak a request.')));
    assert.deepEqual(cachedCodeIndex(sha).search('Obsolete evidence'), []);
    return json(GOOD_EDIT);
  } });
  try {
    const out = await prepareSelfUpdate(env(ai), 'change the home status wording', fakeGitHub({ heads: [sha] }), mem);
    assert.equal(out.status, 200, out.detail);
    assert.equal(out.proposal.base_files['lib/main.dart'], `blob-${sha}-lib/main.dart`);
  } finally { _clearCodeIndexCache(); }
});

test('source refresh outage checkpoints zero genuine passes and resumes without reusing the failed anchor', async () => {
  let calls = 0;
  let sourceReads = 0;
  let outage = true;
  const github = fakeGitHub();
  const fetcher = async (url, init) => {
    if (String(url).includes('/contents/lib/main.dart?ref=sha1') && ++sourceReads > 1 && outage) return { ok: false, status: 503, json: async () => ({}) };
    return github(url, init);
  };
  const ai = scriptedAI({ engineer: () => ++calls <= 2 ? json({ edits: [{ path: 'lib/main.dart', find: 'obsolete source', replace: 'Hi' }] }) : json(GOOD_EDIT) });
  const first = await prepareSelfUpdate(env(ai), 'change the home status wording', fetcher, memoryStore());
  assert.equal(first.status, 503, first.detail);
  assert.equal(first.checkpoint.genuine_passes, 0);
  assert.ok(first.checkpoint.failed_anchors.length > 0);
  assert.ok(first.checkpoint.files.includes('lib/main.dart'));
  outage = false;
  const resumed = await prepareSelfUpdate(env(ai), 'change the home status wording', fetcher, memoryStore(), { checkpoint: first.checkpoint });
  assert.equal(resumed.status, 200, resumed.detail);
});

test('four rounds of invalid anchors never consume genuine passes; changing replacement cannot reuse an anchor', async () => {
  let calls = 0;
  const readLog = [];
  const ai = scriptedAI({ engineer: () => {
    const round = Math.floor(calls++ / 2);
    if (round < 4) return json({ summary: 'invalid', edits: [{ path: 'lib/main.dart', find: round === 0 ? 'String' : 'stale banner', replace: `different replacement ${round}` }] });
    return json(GOOD_EDIT);
  } });
  const out = await prepareSelfUpdate(env(ai), 'change the home status wording', fakeGitHub({ readLog }), memoryStore());
  assert.equal(out.status, 200, out.detail);
  assert.ok(out.diagnostics.outcomes.some((o) => o.outcome === 'ambiguous_anchor'));
  assert.ok(out.diagnostics.outcomes.some((o) => o.outcome === 'missing_anchor'));
  assert.ok(out.diagnostics.outcomes.some((o) => o.outcome === 'duplicate_anchor'));
  assert.ok(readLog.filter((r) => r.path === 'lib/main.dart').length >= 5);
  assert.equal(calls, 10, 'stays inside the existing engineer call ceiling');
  assert.equal(out.diagnostics.genuine_passes, 1);
  const grade = gradeLevel({ level: 1, name: 'Anchor recovery', mustTouch: [['lib/main.dart']], allowed: [/^lib\//] }, out);
  assert.equal(grade.passed, true, JSON.stringify(grade.failed_checks));
  assert.equal(grade.passes, 1, 'the autonomy grader counts applicable strategies, not invalid-anchor rounds');
});

test('endlessly invalid anchors stop at the existing budget with zero genuine implementation passes', async () => {
  let calls = 0;
  const ai = scriptedAI({ engineer: () => json({ summary: 'invalid', edits: [{ path: 'lib/main.dart', find: `missing-${calls++}`, replace: 'replacement' }] }) });
  const out = await prepareSelfUpdate(env(ai), 'change the home status wording', fakeGitHub(), memoryStore());
  assert.equal(out.status, 422);
  assert.equal(calls, 10);
  assert.match(out.detail, /engineering budget after 0 implementation passes/);
  assert.doesNotMatch(out.owner_message, /3 implementation passes/);
  assert.ok(out.engineering_record.failed_anchors.length > 0);
});

test('overlapping exact matches are ambiguous and whitespace rebasing requires a unique real source span', () => {
  assert.ok(applyEdits(new Map([['lib/a.dart', 'aaa']]), [{ path: 'lib/a.dart', find: 'aa', replace: 'b' }]).error);
  const source = 'class A {\n  String banner = \'Ready\';\n}\n';
  const rebased = applyEdits(new Map([['lib/a.dart', source]]), [{ path: 'lib/a.dart', find: "String banner = 'Ready';", replace: "  String banner = 'Hi';" }]);
  assert.equal(rebased.error, undefined);
  assert.ok(rebased.sources.get('lib/a.dart').includes("'Hi'"));
});

test('deterministic validation rejects a broken edit before any reviewer is paid', async () => {
  let reviews = 0;
  let n = 0;
  const ai = scriptedAI({
    review: () => { reviews += 1; return json({ approved: true, target_correct: true, notes: [] }); },
    engineer: () => json(n++ === 0
      ? { summary: 'broken', edits: [{ path: 'lib/main.dart', find: "  String _statusBanner = 'Ready. Type or speak a request.';", replace: "  String _statusBanner = 'Hi' {" }] }
      : GOOD_EDIT),
  });
  const out = await prepareSelfUpdate(env(ai), 'change the home status wording', fakeGitHub(), memoryStore());
  assert.equal(out.status, 200, out.detail);
  assert.ok(out.diagnostics.outcomes.some((o) => o.outcome === 'validation_failed'));
  assert.equal(reviews, 2, 'only the valid change was reviewed');
});

test('reviewer that cannot inspect source is retried with evidence on another engine; its excuse never becomes a lesson', async () => {
  const mem = memoryStore();
  const seen = [];
  const ai = scriptedAI({
    review: (input) => {
      const payload = payloadOf(input);
      seen.push(input.che_provider);
      assert.ok(payload.changed_source.some((v) => v.source.includes('Ready when you are.')), 'reviewer sees post-change source');
      assert.ok(payload.inspected_source.some((v) => v.source.includes('Ready. Type or speak a request.')), 'reviewer sees verified pre-change source');
      return seen.length <= 1
        ? json({ approved: false, target_correct: false, notes: ['Unable to inspect the current repository because the source code was not provided.'], repair_instructions: 'Provide source code.' })
        : json({ approved: true, target_correct: true, notes: ['Verified.'] });
    },
  });
  const out = await prepareSelfUpdate(env(ai), 'change the home status wording', fakeGitHub(), mem);
  assert.equal(out.status, 200, out.detail);
  assert.ok(new Set(seen).size >= 2, 'retry used a different engine');
  assert.ok(!(mem.m.get('che_team_lessons') || []).some((l) => /not provided|provide source/i.test(l.text)));
});

test('reviewer malformed JSON is retried instead of rejecting a valid change', async () => {
  let reviews = 0;
  const ai = scriptedAI({ review: () => (++reviews === 1 ? { response: 'Looks fine to me!' } : json({ approved: true, target_correct: true, notes: [] })) });
  const out = await prepareSelfUpdate(env(ai), 'change the home status wording', fakeGitHub(), memoryStore());
  assert.equal(out.status, 200, out.detail);
  assert.ok(!out.diagnostics.outcomes.some((o) => ['review_rejected', 'review_unavailable'].includes(o.outcome)), 'no engineering strategy was burned by a reviewer glitch');
});

test('reviewer rejection feeds actionable repair notes into the next attempt', async () => {
  let reviews = 0;
  let sawRepair = false;
  const ai = scriptedAI({
    review: () => (++reviews <= 2
      ? json({ approved: false, target_correct: true, notes: ['Keep the trailing period.'], repair_instructions: "In lib/main.dart use 'Ready when you are.' exactly." })
      : json({ approved: true, target_correct: true, notes: [] })),
    engineer: (input) => {
      if (/Keep the trailing period/.test(payloadOf(input).previous_attempt_problem)) sawRepair = true;
      return json(sawRepair ? GOOD_EDIT : { summary: 'v1', edits: [{ path: 'lib/main.dart', find: "'Ready. Type or speak a request.'", replace: "'Ready when you are'" }] });
    },
  });
  const out = await prepareSelfUpdate(env(ai), 'change the home status wording', fakeGitHub(), memoryStore());
  assert.equal(out.status, 200, out.detail);
  assert.equal(sawRepair, true);
});

test('both engineers wrongly claiming no-change are overruled by evidence-based review and then implement', async () => {
  let calls = 0;
  const ai = scriptedAI({
    engineer: () => json(++calls <= 2 ? { no_change: true, summary: 'Already fine', evidence: ['lib/main.dart has a banner'] } : GOOD_EDIT),
    noChange: (input) => {
      assert.ok(payloadOf(input).inspected_source.length > 0, 'no-change reviewer inspects real source');
      return json({ approved: false, notes: ['The banner wording can still be improved in lib/main.dart.'] });
    },
  });
  const out = await prepareSelfUpdate(env(ai), 'change the home status wording', fakeGitHub(), memoryStore());
  assert.equal(out.status, 200, out.detail);
  assert.equal(out.already_satisfied, undefined);
});

test('all AI engines down → class B retryable result, nothing proposed, no raw traces for the owner', async () => {
  const ai = {
    run: async () => {
      const error = new Error("I'm having trouble reaching my cloud engines, sir.");
      error.category = 'temporary_cloud_unavailable';
      error.diagnostic = 'groq: 429 rate limit | gemini: 503 | cerebras: timeout';
      throw error;
    },
  };
  const out = await prepareSelfUpdate(env(ai), 'change the home status wording', fakeGitHub(), memoryStore());
  assert.equal(out.status, 503);
  assert.equal(out.failure_class, FAILURE_CLASS.TEMPORARY_EXTERNAL);
  assert.equal(out.retryable, true);
  assert.equal(out.proposal, undefined);
  assertNoHomework(out);
});

test('engines failing halfway (reviewers down) never ship an unreviewed change', async () => {
  const ai = scriptedAI({
    review: () => { const e = new Error('provider 503'); e.status = 503; throw e; },
  });
  const out = await prepareSelfUpdate(env(ai), 'change the home status wording', fakeGitHub(), memoryStore());
  assert.equal(out.status, 503);
  assert.equal(out.failure_class, FAILURE_CLASS.TEMPORARY_EXTERNAL);
  assert.equal(out.proposal, undefined);
});

test('runaway protection: endless rejection stops within the AI-call ceiling', async () => {
  let calls = 0;
  let variant = 0;
  const ai = scriptedAI({
    review: () => { calls += 1; return json({ approved: false, target_correct: true, notes: [`Try again ${calls}.`] }); },
    engineer: () => { calls += 1; variant += 1; return json({ summary: 'v', edits: [{ path: 'lib/main.dart', find: "'Ready. Type or speak a request.'", replace: `'Ready ${variant}.'` }] }); },
    planner: () => { calls += 1; return json({ plan: 'p', search_terms: ['Ready'], paths: ['lib/main.dart'] }); },
    recovery: () => { calls += 1; return json({ plan: 'p', search_terms: ['Ready'], paths: ['lib/main.dart'] }); },
  });
  const out = await prepareSelfUpdate(env(ai), 'change the home status wording', fakeGitHub(), memoryStore());
  assert.equal(out.status, 422);
  assert.equal(out.failure_class, FAILURE_CLASS.INTERNAL);
  assert.ok(out.diagnostics.budget.calls <= 32, `calls=${out.diagnostics.budget.calls}`);
  assert.ok(out.diagnostics.budget.tokens_estimated <= 160000);
  assert.equal(new Set(out.diagnostics.outcomes.map((o) => o.round)).size, 3, 'three bounded strategies');
  assertNoHomework(out);
});

test('main moving during the job re-reads source at the new head before proposing', async () => {
  let n = 0;
  const ai = scriptedAI({ engineer: () => json(n++ < 2 ? { summary: 'noop', edits: [{ path: 'lib/main.dart', find: 'class Home', replace: 'class Home' }] } : GOOD_EDIT) });
  const fetcher = fakeGitHub({ heads: ['sha1', 'sha2'], filesAt: { sha2: { 'lib/main.dart': MAIN.replace('import', '// moved\nimport'), 'lib/helper.dart': HELPER } } });
  const out = await prepareSelfUpdate(env(ai), 'change the home status wording', fetcher, memoryStore());
  assert.equal(out.status, 200, out.detail);
  assert.equal(out.proposal.expected_base_sha, 'sha2');
  assert.match(out.proposal.files[0].content, /\/\/ moved/);
  assert.equal(out.proposal.base_files['lib/main.dart'], 'blob-sha2-lib/main.dart');
});

test('GitHub auth failure on discovery is a class C blocker with a clean owner message', async () => {
  const fetcher = async () => ({ ok: false, status: 401, json: async () => ({ message: 'Bad credentials' }) });
  const out = await prepareSelfUpdate(env(scriptedAI({})), 'change the home status wording', fetcher, memoryStore());
  assert.equal(out.failure_class, FAILURE_CLASS.PERMANENT_EXTERNAL);
  assert.match(out.owner_message, /token/i);
  assert.doesNotMatch(out.owner_message, /source|filename|paste/i);
});

// ─── Router ──────────────────────────────────────────────────────────────────

test('router skips engines too small for evidence instead of clipping it', async () => {
  resetRouterForTests();
  const sent = [];
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ url, size: body.messages.reduce((n, m) => n + String(m.content).length, 0) });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
  };
  const big = 'x'.repeat(15000);
  const out = await routeText({ GROQ_API_KEY: 'g', MISTRAL_API_KEY: 'm', CHE_DISABLE_KEYLESS_AI: '1' }, '@cf/x', {
    che_provider: 'groq', che_capability: 'coding', che_min_input_chars: 15100,
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: big }],
  }, fetcher);
  assert.notEqual(out.engine, 'groq');
  assert.ok(sent.every((s) => !String(s.url).includes('groq')));
  assert.ok(sent[0].size >= 15000, 'evidence arrived intact');
  // Without the floor, the old behavior (clip to fit) still applies.
  assert.ok(JSON.stringify(fitToBudget({ messages: [{ role: 'user', content: big }] }, 8000)).length < 9000);
});

// ─── PR / CI / merge / deploy ────────────────────────────────────────────────

function fakeRepo({ head = 'base2', fileShas = {}, existingBranch = false, prs = [], checks = {}, pr = null, runs = [], failPr = 0 } = {}) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const method = init.method || 'GET';
    const path = String(url).replace('https://api.github.com/repos/o/r', '');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path, body });
    const reply = (data, status = 200) => new Response(JSON.stringify(data), { status });
    if (url === 'https://api.github.com/graphql') return reply({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
    if (method === 'GET' && path === '') return reply({ default_branch: 'main' });
    if (method === 'GET' && path.startsWith('/git/ref/heads/che')) return existingBranch ? reply({ object: { sha: 'branch-sha' } }) : reply({ message: 'Not Found' }, 404);
    if (method === 'GET' && path.startsWith('/git/ref/heads/main')) return reply({ object: { sha: head } });
    const content = /^\/contents\/(.+)\?ref=/.exec(path);
    if (method === 'GET' && content) {
      const sha = fileShas[content[1]];
      return sha ? reply({ sha, content: Buffer.from('class A {}\n').toString('base64') }) : reply({ message: 'Not Found' }, 404);
    }
    if (method === 'GET' && path.startsWith('/git/commits/')) return reply({ tree: { sha: 'tree0' } });
    if (method === 'POST' && path === '/git/trees') return reply({ sha: 'tree1' }, 201);
    if (method === 'POST' && path === '/git/commits') return reply({ sha: 'commit1' }, 201);
    if (method === 'POST' && path === '/git/refs') return reply({}, 201);
    if (method === 'GET' && path.startsWith('/pulls?state=all')) return reply(prs);
    if (method === 'POST' && path === '/pulls') {
      if (failPr) return reply({ message: 'A pull request already exists' }, failPr);
      return reply({ number: 9, html_url: 'u9', head: { sha: 'h9' } }, 201);
    }
    if (method === 'GET' && /^\/pulls\/\d+$/.test(path)) return reply(pr);
    if (method === 'GET' && /^\/pulls\/\d+\/files/.test(path)) return reply([{ filename: 'server/cloudflare/worker.js' }]);
    if (method === 'PUT' && /\/merge$/.test(path)) return reply({ sha: 'merge123' });
    const run = /^\/commits\/([^/]+)\/check-runs/.exec(path);
    if (method === 'GET' && run) return reply({ check_runs: checks[run[1]] || [] });
    if (method === 'GET' && path.startsWith('/actions/runs')) return reply({ workflow_runs: runs });
    return reply({ message: `unexpected ${method} ${path}` }, 500);
  };
  return { calls, fetcher };
}
const E = { CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r' };
const FILES = [{ path: 'lib/a.dart', content: 'class A { int x = 2; }\n' }];

test('main moved but the touched file did not: approved contents land on the new base', async () => {
  const { calls, fetcher } = fakeRepo({ head: 'base2', fileShas: { 'lib/a.dart': 'blobA' } });
  const out = await openSelfUpdatePr(E, { summary: 'Tweak A', files: FILES, expected_base_sha: 'base1', base_files: { 'lib/a.dart': 'blobA' } }, fetcher);
  assert.equal(out.status, 200, out.detail);
  assert.deepEqual(calls.find((c) => c.path === '/git/commits' && c.method === 'POST').body.parents, ['base2']);
});

test('touched file changed after review: write refused, nothing created', async () => {
  const { calls, fetcher } = fakeRepo({ head: 'base2', fileShas: { 'lib/a.dart': 'blobB' } });
  const out = await openSelfUpdatePr(E, { summary: 'Tweak A', files: FILES, expected_base_sha: 'base1', base_files: { 'lib/a.dart': 'blobA' } }, fetcher);
  assert.equal(out.status, 409);
  assert.deepEqual(out.changed_files, ['lib/a.dart']);
  assert.ok(!calls.some((c) => c.method !== 'GET'), 'no writes');
});

test('approval replay is idempotent: same proposal reuses the same branch and PR', async () => {
  const branch = updateBranchName('Tweak A', FILES);
  const { calls, fetcher } = fakeRepo({ existingBranch: true, prs: [{ number: 5, html_url: 'u5', head: { ref: branch, sha: 'h5' } }] });
  const out = await openSelfUpdatePr(E, { summary: 'Tweak A', files: FILES }, fetcher);
  assert.equal(out.status, 200);
  assert.equal(out.number, 5);
  assert.equal(out.reused, true);
  assert.ok(!calls.some((c) => c.method === 'POST'), 'no second branch, commit or PR');
});

test('PR create race (422 already exists) resolves to the existing PR', async () => {
  const branch = updateBranchName('Tweak A', FILES);
  const { fetcher } = fakeRepo({ failPr: 422, prs: [{ number: 6, html_url: 'u6', head: { ref: branch, sha: 'h6' } }] });
  const out = await openSelfUpdatePr(E, { summary: 'Tweak A', files: FILES }, fetcher);
  assert.equal(out.number, 6);
});

test('GitHub network failure while opening a PR is temporary (class B), never a crash', async () => {
  const out = await openSelfUpdatePr(E, { summary: 'Tweak A', files: FILES }, async () => { throw new Error('fetch failed'); });
  assert.equal(out.status, 503);
  assert.equal(out.failure_class, FAILURE_CLASS.TEMPORARY_EXTERNAL);
  assert.equal(out.retryable, true);
});

const OPEN_PR = (extra = {}) => ({ number: 9, html_url: 'u9', state: 'open', merged: false, draft: true, mergeable: true, mergeable_state: 'clean', node_id: 'N', title: 'CHE update: x', head: { sha: 'h9', ref: 'che/update-abc' }, base: { sha: 'b9' }, ...extra });

test('CI classification: a check that also fails on base is pre-existing, not this change', async () => {
  const { fetcher } = fakeRepo({ pr: OPEN_PR(), checks: {
    h9: [{ name: 'Workers Builds: chey-app', status: 'completed', conclusion: 'failure' }, { name: 'analyze', status: 'completed', conclusion: 'success' }],
    b9: [{ name: 'Workers Builds: chey-app', status: 'completed', conclusion: 'failure' }],
  } });
  const status = await selfUpdateStatus(E, 9, fetcher);
  assert.equal(status.ci, 'passed');
  assert.deepEqual(status.preexisting_failed_checks, ['Workers Builds: chey-app']);
  const { fetcher: f2 } = fakeRepo({ pr: OPEN_PR(), checks: { h9: [{ name: 'Worker tests', status: 'completed', conclusion: 'failure' }] } });
  const broken = await selfUpdateStatus(E, 9, f2);
  assert.equal(broken.ci, 'failed');
  assert.deepEqual(broken.failure_classes, ['tests']);
});

test('merge requires CI, a CHE branch, no conflict, and pins the checked head; Worker merges trigger deploy', async () => {
  const green = { h9: [{ name: 'analyze', status: 'completed', conclusion: 'success' }] };
  const { calls, fetcher } = fakeRepo({ pr: OPEN_PR(), checks: green });
  const merged = await mergeSelfUpdatePr(E, 9, fetcher);
  assert.equal(merged.status, 200, merged.detail);
  const put = calls.find((c) => c.method === 'PUT');
  assert.equal(put.body.sha, 'h9');
  assert.match(put.body.commit_title, /\[worker-deploy\]$/);
  assert.equal(merged.worker_deploy, true);

  const running = await mergeSelfUpdatePr(E, 9, fakeRepo({ pr: OPEN_PR(), checks: { h9: [{ name: 'analyze', status: 'in_progress' }] } }).fetcher);
  assert.equal(running.retryable, true);
  const red = await mergeSelfUpdatePr(E, 9, fakeRepo({ pr: OPEN_PR(), checks: { h9: [{ name: 'Worker tests', status: 'completed', conclusion: 'failure' }] } }).fetcher);
  assert.equal(red.status, 409);
  const foreign = await mergeSelfUpdatePr(E, 9, fakeRepo({ pr: OPEN_PR({ head: { sha: 'h9', ref: 'feature/human' } }), checks: green }).fetcher);
  assert.equal(foreign.status, 403);
  const conflict = await mergeSelfUpdatePr(E, 9, fakeRepo({ pr: OPEN_PR({ mergeable: false, mergeable_state: 'dirty' }), checks: green }).fetcher);
  assert.equal(conflict.merge_conflict, true);
});

test('deployment is only "deployed" when the workflow succeeded and the live version matches', async () => {
  const runs = [{ name: 'Deploy CHE Worker', status: 'completed', conclusion: 'success', html_url: 'run' }];
  const ok = await workerDeploymentStatus(E, 'merge123456789', fakeRepo({ runs }).fetcher, { version_tag: 'merge1234567' });
  assert.equal(ok.deployed, true);
  assert.equal(ok.production_matches_merge, true);
  const stale = await workerDeploymentStatus(E, 'merge123456789', fakeRepo({ runs }).fetcher, { version_tag: 'oldversion00' });
  assert.equal(stale.deployed, false, 'workflow success alone is not deployment truth when production reports another version');
  const failedRun = await workerDeploymentStatus(E, 'merge123456789', fakeRepo({ runs: [{ ...runs[0], conclusion: 'failure' }] }).fetcher, {});
  assert.equal(failedRun.workflow, 'failed');
  assert.equal(failedRun.deployed, false);
  const pending = await workerDeploymentStatus(E, 'merge123456789', fakeRepo({ runs: [] }).fetcher, {});
  assert.equal(pending.workflow, 'not_started');
});

test('a comments/docs-only change is never accepted as an implementation', async () => {
  const { substantiveChange, wantsDocsOnly } = await import('./self_development.js');
  const before = new Map([['lib/main.dart', MAIN]]);
  assert.equal(substantiveChange(before, [{ path: 'lib/main.dart', content: MAIN.replace('class Home {', '// Brain room renders a starfield\nclass Home {') }]), false);
  assert.equal(substantiveChange(before, [{ path: 'docs/brain.md', content: '# Brain\n- colors' }]), false);
  assert.equal(substantiveChange(before, [{ path: 'lib/main.dart', content: MAIN.replace('Ready. Type', 'Ready now. Type') }]), true);
  assert.equal(wantsDocsOnly('update the README for the brain room'), true);
  assert.equal(wantsDocsOnly('rebuild the Brain room to match this design'), false);

  let n = 0;
  const ai = scriptedAI({
    engineer: () => json(n++ === 0
      ? { summary: 'Brain room', edits: [{ path: 'lib/main.dart', find: 'class Home {', replace: '// The Brain room renders a neural starfield.\nclass Home {' }] }
      : GOOD_EDIT),
  });
  const out = await prepareSelfUpdate(env(ai), 'rebuild the home banner to match the new design', fakeGitHub(), memoryStore());
  assert.equal(out.status, 200, out.detail);
  assert.ok(out.diagnostics.outcomes.some((o) => o.outcome === 'no_substance'));
  assert.match(out.proposal.files[0].content, /Ready when you are/);
});

test('a change that adds code nothing calls is sent back, not proposed', async () => {
  let n = 0;
  const ai = scriptedAI({
    engineer: () => json(n++ === 0
      ? { summary: 'Indexing cache', edits: [{ path: 'lib/main.dart', find: 'class Home {', replace: "extension HomeIndex on Home {\n  String? cachedBanner(String id) => null;\n}\n\nclass Home {" }] }
      : GOOD_EDIT),
  });
  const out = await prepareSelfUpdate(env(ai), 'rebuild the home banner to match the new design', fakeGitHub(), memoryStore());
  assert.equal(out.status, 200, out.detail);
  assert.ok(out.diagnostics.outcomes.some((o) => o.outcome === 'dead_code'), 'the unused method was caught deterministically');
  assert.doesNotMatch(out.proposal.files[0].content, /cachedBanner/);
});

test('budget stops after more than 3 identical errors and after the time limit', () => {
  let t = 0;
  const budget = new AgentBudget({ maxElapsedMs: 1000, now: () => t });
  for (let i = 0; i < 3; i += 1) budget.recordError('engineer:groq:temporary_external:timeout');
  assert.equal(budget.canSpend('engineer', 10), true);
  budget.recordError('engineer:groq:temporary_external:timeout');
  assert.equal(budget.canSpend('engineer', 10), false);
  assert.throws(() => budget.spend('engineer', 10), (e) => e.budget_exhausted === true);
  assert.match(budget.snapshot().stopped_on_repeated_error, /timeout/);

  const timed = new AgentBudget({ maxElapsedMs: 1000, now: () => t });
  t = 1001;
  assert.equal(timed.canSpend('planner', 10), false);
});

// ─── Empty / malformed engine output (Advanced Autonomy Test, Oct 3 2026) ────
// The owner's real key set: Groq, Gemini and OpenRouter keys; the crew's other
// engines (Cerebras, Mistral, GitHub Models, Hugging Face) have no key. Groq's
// 8k context budget is below the engineers' evidence floor, so it is skipped.
// After an outage Gemini/OpenRouter are rate-limited and every call lands on
// Workers AI, whose 8B model returns an empty answer for the big JSON task.
function ownerKeyEnv({ cloudflare, providerStatus = 429, providerBody = null, calls = [] }) {
  const github = fakeGitHub();
  const fetcher = async (url, init) => {
    const u = String(url);
    if (u.includes('api.github.com')) return github(url, init);
    if (u.endsWith('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    const body = init?.body ? JSON.parse(init.body) : {};
    calls.push({ url: u, system: String(body.messages?.[0]?.content || '') });
    if (providerBody) {
      const answer = providerBody(u, body);
      if (answer) return new Response(JSON.stringify({ choices: [{ message: { content: answer } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: 'rate limit reached' } }), { status: providerStatus });
  };
  const base = { CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r', GROQ_API_KEY: 'g', GEMINI_API_KEY: 'k', OPENROUTER_API_KEY: 'o', CHE_DISABLE_KEYLESS_AI: '1', AI: cloudflare };
  return { env: routedEnv(base, fetcher), fetcher };
}

const cloudflareCrew = (engineer, log = []) => ({
  run: async (_model, input) => {
    const system = roleOf(input);
    log.push(system.includes('Engineer') ? 'engineer' : system.includes('Review') ? 'review' : 'other');
    if (system.includes('Source Recovery Architect')) return json({ plan: 'look at main', search_terms: ['Ready'], paths: ['lib/main.dart'] });
    if (system.includes('Architect')) return json({ plan: 'improve banner', search_terms: ['Ready. Type or speak a request.'], paths: ['lib/main.dart'] });
    if (system.includes('Review')) return json({ approved: true, target_correct: true, notes: ['ok'] });
    return engineer(input);
  },
});

test('Oct 3 recording, root cause: engines returning nothing no longer end the job as "exhausted 3 passes"; it stays retryable', async () => {
  resetRouterForTests();
  const log = [];
  const { env: routed, fetcher } = ownerKeyEnv({ cloudflare: cloudflareCrew(() => ({ response: '' }), log) });
  const out = await prepareSelfUpdate(routed, 'change the home status wording', fetcher, memoryStore());
  // Before the fix: status 422, class A, "The coding team exhausted 3
  // implementation passes … Your last answer was empty. Return only the JSON
  // object, with small edits." — a terminal failure with nothing implemented.
  assert.equal(out.status, 503);
  assert.equal(out.failure_class, FAILURE_CLASS.TEMPORARY_EXTERNAL);
  assert.equal(out.retryable, true);
  assert.equal(out.proposal, undefined);
  assert.doesNotMatch(String(out.detail), /exhausted|Your last answer was empty/);
  assert.ok(!log.includes('review'), 'no reviewer is paid when nothing was implemented');
  assertNoHomework(out);
});

test('1. empty engineer answer is re-requested once on another engine (same job and evidence) and the change ships', async () => {
  const engineer = [];
  const ai = scriptedAI({
    engineer: (input) => {
      engineer.push({ avoid: input.che_avoid_providers || [], provider: input.che_provider || '', system: roleOf(input), evidence: payloadOf(input).inspected });
      return engineer.length <= 2 ? { response: '', engine: input.che_provider || 'x' } : json(GOOD_EDIT);
    },
  });
  const out = await prepareSelfUpdate(env(ai), 'change the home status wording', fakeGitHub(), memoryStore());
  assert.equal(out.status, 200, out.detail);
  const retries = engineer.slice(2);
  assert.ok(retries.length >= 1);
  for (const r of retries) {
    assert.equal(r.provider, '', 'retry goes to another engine, not the same one');
    assert.ok(r.avoid.length >= 1, 'the engine that returned nothing is avoided');
    assert.match(r.system, /FORMAT: another engine returned an empty answer/);
    assert.deepEqual(r.evidence, engineer[0].evidence, 'same inspected evidence');
  }
  assert.ok(!out.diagnostics.outcomes.some((o) => o.outcome === 'empty'), 'a recovered empty answer is not a failed attempt');
});

test('2. non-JSON engineer answer is re-requested with the concrete format problem', async () => {
  let n = 0;
  const hints = [];
  const ai = scriptedAI({
    engineer: (input) => {
      n += 1;
      hints.push(roleOf(input));
      return n <= 2 ? { response: 'Sure! I would change the banner text to something friendlier.' } : json(GOOD_EDIT);
    },
  });
  const out = await prepareSelfUpdate(env(ai), 'change the home status wording', fakeGitHub(), memoryStore());
  assert.equal(out.status, 200, out.detail);
  assert.ok(hints.slice(2).every((h) => /FORMAT: another engine's answer was unusable\. Your last answer contained no JSON object/.test(h)));
});

test('malformed-only zero-pass engine output stays retryable with the same checkpoint', async () => {
  const ai = scriptedAI({ engineer: () => ({ response: 'not json' }) });
  const out = await prepareSelfUpdate(env(ai), 'change the home status wording', fakeGitHub(), memoryStore());
  assert.equal(out.status, 503, out.detail);
  assert.equal(out.retryable, true);
  assert.equal(out.engines_unusable, true);
  assert.equal(out.checkpoint.genuine_passes, 0);
  assert.equal(out.checkpoint.resumes, 1);
  assert.match(out.detail, /retries later/i);
  assert.match(out.detail, /malformed answers/);
  assert.ok(out.diagnostics.outcomes.every((o) => o.outcome === 'invalid_json'));
});

test('3. valid structured answer: no re-request, one engineer call each', async () => {
  let engineerCalls = 0;
  const ai = scriptedAI({ engineer: () => { engineerCalls += 1; return json(GOOD_EDIT); } });
  const out = await prepareSelfUpdate(env(ai), 'change the home status wording', fakeGitHub(), memoryStore());
  assert.equal(out.status, 200, out.detail);
  assert.equal(engineerCalls, 2);
  assert.ok(!out.diagnostics.notes?.some?.((d) => d.kind === 'format_retry'));
});

test('4. router: an empty Workers AI answer is a failed engine, the next engine answers; avoided engines are skipped', async () => {
  resetRouterForTests();
  const urls = [];
  const fetcher = async (url, init) => {
    urls.push(String(url));
    if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
  };
  const base = { GEMINI_API_KEY: 'k', OPENROUTER_API_KEY: 'o', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: '' }) } };
  // Not strongest/keyed-first: Cloudflare is tried first, returns nothing, routing continues.
  const out = await routeText(base, '@cf/x', { messages: [{ role: 'user', content: 'hi there, how are you' }] }, fetcher);
  assert.equal(out.response, '{"ok":true}');
  assert.notEqual(out.engine, 'cloudflare');
  // Avoided engines are never called for the re-request.
  resetRouterForTests();
  urls.length = 0;
  const again = await routeText(base, '@cf/x', { messages: [{ role: 'user', content: 'x' }], che_capability: 'coding', che_strongest: true, che_avoid_providers: ['gemini', 'cloudflare'] }, fetcher);
  assert.equal(again.engine, 'openrouter');
  assert.ok(!urls.some((u) => u.includes('generativelanguage') && u.includes('chat/completions')));
  // Nothing usable anywhere: an honest temporary engine error, never "".
  resetRouterForTests();
  await assert.rejects(routeText({ CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: '  ' }) } }, '@cf/x', { messages: [{ role: 'user', content: 'x' }] }, fetcher),
    (error) => /temporary|engines/i.test(`${error.category} ${error.message}`));
});

test('5. an empty pass is not a strategy: it does not use up one of the three passes', async () => {
  let n = 0;
  let variant = 0;
  const ai = scriptedAI({
    // Pass 1: both engineers and both re-requests return nothing. Then real
    // strategies that review keeps rejecting.
    engineer: () => { n += 1; if (n <= 4) return { response: '' }; variant += 1; return json({ summary: 'v', edits: [{ path: 'lib/main.dart', find: "'Ready. Type or speak a request.'", replace: `'Ready ${variant}.'` }] }); },
    review: () => json({ approved: false, target_correct: true, notes: ['Not friendly enough.'] }),
  });
  const out = await prepareSelfUpdate(env(ai), 'change the home status wording', fakeGitHub(), memoryStore());
  assert.equal(out.status, 422);
  const rounds = new Set(out.diagnostics.outcomes.map((o) => o.round));
  assert.equal(rounds.size, 4, 'one empty pass + three genuine passes');
  assert.match(out.detail, /exhausted 3 implementation passes/);
  assert.doesNotMatch(out.detail, /Your last answer was empty/, 'format hints are not engineering findings');
  assert.ok(out.engineering_record.failed_strategies.every((f) => f.outcome !== 'empty'));
});

test('6. three genuinely failed strategies still hit the hard stop (and never more than five passes in total)', async () => {
  let variant = 0;
  const ai = scriptedAI({
    engineer: () => { variant += 1; return json({ summary: 'v', edits: [{ path: 'lib/main.dart', find: "'Ready. Type or speak a request.'", replace: `'Ready ${variant}.'` }] }); },
    review: () => json({ approved: false, target_correct: true, notes: ['Rejected.'] }),
  });
  const out = await prepareSelfUpdate(env(ai), 'change the home status wording', fakeGitHub(), memoryStore());
  assert.equal(out.status, 422);
  assert.equal(out.failure_class, FAILURE_CLASS.INTERNAL);
  assert.equal(new Set(out.diagnostics.outcomes.map((o) => o.round)).size, 3);
  assert.ok(out.diagnostics.outcomes.filter((o) => o.outcome === 'review_rejected').length >= 3);
  // Endless empty output is bounded: three free passes at most, then retryable.
  let calls = 0;
  const empty = scriptedAI({ engineer: () => { calls += 1; return { response: '' }; } });
  const stopped = await prepareSelfUpdate(env(empty), 'change the home status wording', fakeGitHub(), memoryStore());
  assert.equal(stopped.status, 503);
  assert.ok(new Set(stopped.diagnostics.outcomes.map((o) => o.round)).size <= 5);
  assert.ok(calls <= 12, `engineer calls ${calls}: two engineers × (answer + one re-request) × at most three free passes`);
});

test('9. no loop or token runaway: unusable output and rejections together stay inside the call ceiling', async () => {
  let n = 0;
  const ai = scriptedAI({
    engineer: () => { n += 1; return n % 3 === 0 ? json({ summary: 'v', edits: [{ path: 'lib/main.dart', find: "'Ready. Type or speak a request.'", replace: `'Ready ${n}.'` }] }) : { response: n % 2 ? '' : 'no json here' }; },
    review: () => json({ approved: false, target_correct: true, notes: ['Rejected.'] }),
  });
  const out = await prepareSelfUpdate(env(ai), 'change the home status wording', fakeGitHub(), memoryStore());
  assert.ok([422, 503].includes(out.status));
  assert.ok(out.diagnostics.budget.calls <= 40, `calls=${out.diagnostics.budget.calls}`);
  assert.ok(new Set(out.diagnostics.outcomes.map((o) => o.round)).size <= 5);
});

test('10. reviewer rejection stays distinct from a reviewer that returned nothing', async () => {
  const avoided = [];
  const ai = scriptedAI({
    review: (input) => { avoided.push(input.che_avoid_providers || []); return { response: '', engine: input.che_provider || 'gemini' }; },
  });
  const out = await prepareSelfUpdate(env(ai), 'change the home status wording', fakeGitHub(), memoryStore());
  assert.equal(out.status, 503, 'a reviewer that returned nothing never rejects (or approves) a change');
  assert.equal(out.failure_class, FAILURE_CLASS.TEMPORARY_EXTERNAL);
  assert.ok(out.diagnostics.outcomes.some((o) => o.outcome === 'review_unavailable'));
  assert.ok(!out.diagnostics.outcomes.some((o) => o.outcome === 'review_rejected'));
  assert.ok(avoided.some((list) => list.length >= 1), 'the second review attempt avoids the engine that returned nothing');
  const rejected = await prepareSelfUpdate(env(scriptedAI({ review: () => json({ approved: false, target_correct: true, notes: ['Wrong banner.'] }) })), 'change the home status wording', fakeGitHub(), memoryStore());
  assert.equal(rejected.status, 422);
  assert.ok(rejected.diagnostics.outcomes.some((o) => o.outcome === 'review_rejected'));
});

// ─── Independent review findings on the empty-output fix ─────────────────────
const variantEdit = (n) => json({ summary: 'v', edits: [{ path: 'lib/main.dart', find: "'Ready. Type or speak a request.'", replace: `'Ready ${n}.'` }] });

test('control plane: engines going empty after a genuine pass checkpoint the SAME job; resuming never adds strategies or repeats one', async () => {
  let n = 0;
  const ai = scriptedAI({
    engineer: () => { n += 1; return n <= 2 ? variantEdit(n) : { response: '' }; },
    review: () => json({ approved: false, target_correct: true, notes: ['Breaks the VoiceOver label.'] }),
  });
  const out = await prepareSelfUpdate(env(ai), 'change the home status wording', fakeGitHub(), memoryStore());
  // Empty engines are infrastructure, not a failed implementation attempt.
  assert.equal(out.status, 503);
  assert.equal(out.failure_class, FAILURE_CLASS.TEMPORARY_EXTERNAL);
  assert.equal(out.retryable, true);
  assert.equal(out.checkpoint.genuine_passes, 1);
  assert.ok(out.checkpoint.fingerprints.length >= 1, 'tried strategies are remembered');
  assert.ok(out.checkpoint.failed_strategies.length >= 1, 'genuine evidence kept');
  assert.equal(out.checkpoint.resumes, 1);
  assert.ok(out.checkpoint.round_offset >= 2, 'the resume starts on the next engine pair, not the one that went empty');
  // Resume on healthy engines: only the passes that were left are used, and a
  // strategy already tried is rejected as a duplicate instead of re-run.
  let m = 0;
  const resumedAI = scriptedAI({
    engineer: () => { m += 1; return variantEdit(m); },
    review: () => json({ approved: false, target_correct: true, notes: ['Still breaks the label.'] }),
  });
  const resumed = await prepareSelfUpdate(env(resumedAI), 'change the home status wording', fakeGitHub(), memoryStore(), { checkpoint: out.checkpoint });
  assert.equal(resumed.status, 422);
  assert.match(resumed.detail, /exhausted 3 implementation passes/, 'the same three-pass limit, not three more');
  assert.ok(resumed.diagnostics.outcomes.some((o) => o.outcome === 'duplicate_strategy'), 'the earlier strategy is not repeated');
  // Bounded: after three resumes the job stops instead of looping.
  let k = 0;
  const emptyAgain = scriptedAI({ engineer: () => { k += 1; return k <= 2 ? variantEdit(k + 10) : { response: '' }; }, review: () => json({ approved: false, target_correct: true, notes: ['no'] }) });
  const capped = await prepareSelfUpdate(env(emptyAgain), 'change the home status wording', fakeGitHub(), memoryStore(), { checkpoint: { ...out.checkpoint, resumes: 3 } });
  assert.equal(capped.status, 422);
  assert.notEqual(capped.failure_class, FAILURE_CLASS.TEMPORARY_EXTERNAL);
});

test('review: a model that always returns cut-off JSON is retryable before any implementation pass', async () => {
  const ai = scriptedAI({ engineer: () => ({ response: '{"summary":"x","edits":[{"path":"lib/main.dart","find":"Ready' }) });
  const out = await prepareSelfUpdate(env(ai), 'change the home status wording', fakeGitHub(), memoryStore());
  assert.equal(out.status, 503);
  assert.equal(out.failure_class, FAILURE_CLASS.TEMPORARY_EXTERNAL);
  assert.equal(out.retryable, true);
  assert.equal(out.engines_unusable, true);
  assert.ok(out.diagnostics.outcomes.every((o) => o.outcome === 'invalid_json'));
});

test('review: a re-request outage stays retryable when malformed output came before any implementation pass', async () => {
  const ai = scriptedAI({
    engineer: (input) => {
      if (input.che_avoid_providers) { const e = new Error('all engines resting'); e.category = 'temporary_cloud_unavailable'; throw e; }
      return { response: 'no json at all' };
    },
  });
  const out = await prepareSelfUpdate(env(ai), 'change the home status wording', fakeGitHub(), memoryStore());
  assert.ok(out.diagnostics.outcomes.every((o) => o.outcome === 'invalid_json'), JSON.stringify(out.diagnostics.outcomes));
  assert.equal(out.status, 503);
  assert.equal(out.failure_class, FAILURE_CLASS.TEMPORARY_EXTERNAL);
  assert.equal(out.retryable, true);
  assert.equal(out.engines_unusable, true);
});

test('review: hitting the engineering budget is reported as a budget stop, never "engines failed" or "exhausted"', async () => {
  let n = 0;
  const ai = scriptedAI({
    engineer: () => { n += 1; return variantEdit(n); },
    review: () => json({ approved: false, target_correct: true, notes: ['no'] }),
  });
  const out = await prepareSelfUpdate(env(ai), 'change the home status wording', fakeGitHub(), memoryStore(), { budgetLimits: { maxCalls: 9 } });
  assert.equal(out.status, 422);
  assert.match(out.detail, /stopped at its engineering budget/);
  assert.doesNotMatch(out.detail, /no usable output|exhausted/);
});

test('review: a failed site repair keeps the first draft', async () => {
  const { writeSite } = await import('./site_builder.js');
  let calls = 0;
  const ai = { run: async () => { calls += 1; if (calls === 1) return { response: '<!doctype html><html><body><button>x</button></body></html>' }; throw new Error('engines down'); } };
  const out = await writeSite({ AI: ai }, { brief: 'a page' }, '@cf/x');
  assert.equal(calls, 2);
  assert.match(out.html, /<button>x<\/button>/);
});

test('final review: a reviewer outage after a genuine pass checkpoints the consumed pass and strategy; the resume cannot get them back', async () => {
  const ai = scriptedAI({
    engineer: () => variantEdit(1),
    review: () => { const e = new Error('provider 503'); e.status = 503; throw e; },
  });
  const out = await prepareSelfUpdate(env(ai), 'change the home status wording', fakeGitHub(), memoryStore());
  assert.equal(out.status, 503);
  assert.equal(out.failure_class, FAILURE_CLASS.TEMPORARY_EXTERNAL);
  assert.equal(out.proposal, undefined, 'an unreviewed change never ships');
  assert.ok(out.checkpoint, 'the outage saved a durable checkpoint');
  assert.ok(out.checkpoint.genuine_passes >= 1, 'the genuine pass stays consumed');
  assert.ok(out.checkpoint.fingerprints.length >= 1, 'the strategy stays consumed');
  assert.ok(out.checkpoint.failed_strategies.some((s) => s.outcome === 'review_unavailable'));
  // The same job resumes with reviewers back: the identical change is a
  // duplicate strategy, and the three-pass limit is not reset.
  let m = 0;
  const resumedAI = scriptedAI({
    engineer: () => { m += 1; return variantEdit(m); },
    review: () => json({ approved: false, target_correct: true, notes: ['Breaks the VoiceOver label.'] }),
  });
  const resumed = await prepareSelfUpdate(env(resumedAI), 'change the home status wording', fakeGitHub(), memoryStore(), { checkpoint: out.checkpoint });
  assert.equal(resumed.status, 422);
  assert.match(resumed.detail, /exhausted 3 implementation passes/);
  assert.ok(resumed.diagnostics.outcomes.some((o) => o.outcome === 'duplicate_strategy'), 'the consumed strategy is not re-run');
});

test('final review: injected exam faults fire exactly once across durable checkpoint resumes', async () => {
  const faults = { malformedOnce: true, anchorMissOnce: true };
  const ai = scriptedAI({
    engineer: () => variantEdit(1),
    review: () => { const e = new Error('provider 503'); e.status = 503; throw e; },
  });
  const out = await prepareSelfUpdate(env(ai), 'change the home status wording', fakeGitHub(), memoryStore(), { faults });
  assert.equal(out.status, 503);
  assert.equal(out.checkpoint.faults_used.malformed, true, 'the malformed fault was consumed and recorded');
  const injected = (o) => /injected exam fault/.test(o.detail || '');
  assert.ok(out.diagnostics.outcomes.some(injected));
  let m = 0;
  const healthy = scriptedAI({ engineer: () => { m += 1; return variantEdit(m + 20); }, review: () => json({ approved: true, target_correct: true, notes: ['ok'] }) });
  const resumed = await prepareSelfUpdate(env(healthy), 'change the home status wording', fakeGitHub(), memoryStore(), { faults, checkpoint: out.checkpoint });
  assert.ok(!resumed.diagnostics.outcomes.some((o) => /injected exam fault: truncated/.test(o.detail || '')), 'the consumed malformed fault is not re-injected');
  if (out.checkpoint.faults_used.anchor) {
    assert.ok(!resumed.diagnostics.outcomes.some(injected), 'no consumed fault fires again');
  }
});

test('review fix: a reviewer outage on the LAST pass never buys extra implementation passes', async () => {
  let n = 0;
  const ai = scriptedAI({
    engineer: () => { n += 1; return variantEdit(n + 40); },
    review: () => { const e = new Error('provider 503'); e.status = 503; throw e; },
  });
  let checkpoint = { genuine_passes: 2, fingerprints: [], failed_strategies: [], resumes: 1, round_offset: 2, faults_used: {} };
  let out = await prepareSelfUpdate(env(ai), 'change the home status wording', fakeGitHub(), memoryStore(), { checkpoint });
  assert.equal(out.status, 503, 'the valid final candidate is checkpointed for review-only resume');
  assert.equal(out.checkpoint.genuine_passes, 3, 'the final pass stays consumed');
  assert.ok(out.checkpoint.pending_review);
  const coded = n;
  // Reviewers stay down: resumes retry review only, then end honestly.
  for (let i = 0; i < 4 && out.status === 503; i++) {
    out = await prepareSelfUpdate(env(ai), 'change the home status wording', fakeGitHub(), memoryStore(), { checkpoint: out.checkpoint });
  }
  assert.equal(n, coded, 'no resume grants another implementation pass');
  assert.equal(out.status, 422, 'bounded resumes end in an honest final result');
  assert.notEqual(out.failure_class, FAILURE_CLASS.TEMPORARY_EXTERNAL);
  assert.equal(out.proposal, undefined);
});

test('review fix: an oversized final candidate is not checkpointed into shared job storage; the job ends honestly', async () => {
  const ai = scriptedAI({
    engineer: () => variantEdit(41),
    review: () => { const e = new Error('provider 503'); e.status = 503; throw e; },
  });
  const big = MAIN + `\n// ${'x'.repeat(190_000 - MAIN.length)}\n`;
  const checkpoint = { genuine_passes: 2, fingerprints: [], failed_strategies: [], resumes: 0, round_offset: 2, faults_used: {} };
  const out = await prepareSelfUpdate(env(ai), 'change the home status wording', fakeGitHub({ files: { 'lib/main.dart': big, 'lib/helper.dart': HELPER } }), memoryStore(), { checkpoint });
  assert.ok(!out.diagnostics.outcomes.some((o) => o.outcome === 'validation_failed'), 'the candidate itself is valid');
  assert.equal(out.status, 422, out.detail);
  assert.equal(out.checkpoint?.pending_review, undefined);
});
