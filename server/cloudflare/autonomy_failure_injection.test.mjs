// Failure-injection regression suite for CHE's autonomous engineering
// lifecycle: chat → coding → review → repair → PR → CI → merge → deploy.
// Every test injects a realistic failure and asserts CHE recovers by herself
// (or stops cleanly with the right failure class) without owner homework.
import test from 'node:test';
import assert from 'node:assert/strict';
import { packEvidence, prepareSelfUpdate, focusView } from './self_development.js';
import {
  AgentBudget, FAILURE_CLASS, classifyFailure, isEvidenceRequest, ownerEngineeringMessage,
  stripOwnerHomework, strategyFingerprint, backoffMs, idempotencyKey,
} from './recovery_policy.js';
import { dartStaticCheck, staticRegression, jsStaticCheck } from './dart_check.js';
import { mergeSelfUpdatePr, openSelfUpdatePr, selfUpdateStatus, updateBranchName, validateUpdateFiles, workerDeploymentStatus } from './self_update.js';
import { fitToBudget, resetRouterForTests, routeText } from './ai_router.js';

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
    if (u.includes('/git/trees/')) return ok({ tree: Object.keys(files).map((path) => ({ type: 'blob', path })) });
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
