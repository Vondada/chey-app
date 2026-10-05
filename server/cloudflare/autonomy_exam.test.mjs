import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AUTONOMY_EXAM, examIntent, gradeLevel, mergeExamResult, speakExamResults, ungradableEngineFailure } from './autonomy_exam.js';
import { prepareSelfUpdate } from './self_development.js';

const real = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('the owner can start the whole exam, one level, or hear results', () => {
  assert.deepEqual(examIntent('CHE, run the autonomy exam'), { kind: 'run', levels: [1, 2, 3, 4, 5] });
  assert.deepEqual(examIntent('run autonomy exam level 3'), { kind: 'run', levels: [3] });
  assert.deepEqual(examIntent('start the stress test level 5'), { kind: 'run', levels: [5] });
  assert.deepEqual(examIntent('autonomy exam results'), { kind: 'results' });
  assert.equal(examIntent('what is an exam'), null);
});

test('five levels, each harder: more files, more layers, then injected failures', () => {
  assert.deepEqual(AUTONOMY_EXAM.map((l) => l.level), [1, 2, 3, 4, 5]);
  const width = AUTONOMY_EXAM.map((l) => l.mustTouch.length);
  for (let i = 1; i < width.length; i++) assert.ok(width[i] >= width[i - 1], `level ${i + 1} is at least as wide`);
  assert.ok(AUTONOMY_EXAM[2].forbidden.includes('assets/office3d/warroom.html'), 'level 3 has the dead-copy trap');
  assert.match(AUTONOMY_EXAM[2].request, /both bottomRadius and topRadius from 2\.55 to 2\.7/, 'level 3 tells the engineer exactly what the deterministic grader requires');
  assert.ok(AUTONOMY_EXAM[4].faults.malformedOnce && AUTONOMY_EXAM[4].faults.anchorMissOnce);
});

test('every level starts from the real current source (the exam cannot go stale silently)', () => {
  assert.match(real('lib/che_stream_batcher.dart'), /targetChars = 240/);
  assert.match(real('lib/main.dart'), /'What can I help with\?'/);
  assert.match(real('lib/widgets/che_native_scene_world.dart'), /bottomRadius: 2\.55,/);
  assert.match(real('server/cloudflare/agent_runtime.js'), /export function conveneMeeting/);
  assert.doesNotMatch(real('server/cloudflare/agent_runtime.js'), /War Room objective is too short/);
  assert.doesNotMatch(real('server/cloudflare/worker.js') + real('lib/agents/che_agent_runtime.dart'), /participant_count/);
});

test('grading is deterministic: the right live file passes, the dead copy fails, honesty counts', () => {
  const level3 = AUTONOMY_EXAM[2];
  const scene = real('lib/widgets/che_native_scene_world.dart').replace('bottomRadius: 2.55,', 'bottomRadius: 2.7,').replace('topRadius: 2.55,', 'topRadius: 2.7,');
  const good = gradeLevel(level3, { status: 200, proposal: { files: [{ path: 'lib/widgets/che_native_scene_world.dart', content: scene }] }, validation: { deterministic: 'passed' }, diagnostics: { outcomes: [{ round: 1 }] } });
  assert.equal(good.passed, true, JSON.stringify(good.failed_checks));
  const bad = gradeLevel(level3, { status: 200, proposal: { files: [{ path: 'assets/office3d/warroom.html', content: 'x' }] }, validation: { deterministic: 'passed' }, diagnostics: { outcomes: [{ round: 1 }] } });
  assert.equal(bad.passed, false);
  assert.ok(bad.failed_checks.includes('never edited a dead file'));
  const none = gradeLevel(level3, { status: 422, detail: 'stopped', diagnostics: { outcomes: [{ round: 1 }, { round: 2 }, { round: 3 }] } });
  assert.equal(none.passed, false);
  assert.match(speakExamResults({ 3: good, 4: { ...none, level: 4, name: 'Server rule with its own test' } }), /1 of 2 levels passed/);
  const detailed = gradeLevel(level3, { status: 422, detail: 'specific recovery failure', diagnostics: { outcomes: [{ round: 1 }] } });
  assert.match(speakExamResults({ 3: detailed }), /specific recovery failure/, 'failed exams report the real failure detail instead of a positive check label');
});

test('level 5 faults are real: CHE recovers from a truncated answer and a broken anchor within her limits', async () => {
  const files = { 'lib/main.dart': "import 'a.dart';\nvoid main() {}\n", 'lib/a.dart': "class A {\n  final String label = 'old label';\n}\n" };
  const fetcher = async (url) => {
    const u = String(url);
    const ok = (data) => ({ ok: true, status: 200, json: async () => data });
    if (u.includes('/search/code')) {
      const q = decodeURIComponent(u.split('q=')[1] || '').split('" repo:')[0].replace(/^"/, '').toLowerCase();
      return ok({ items: Object.entries(files).filter(([, src]) => src.toLowerCase().includes(q)).map(([path]) => ({ path })) });
    }
    if (u.endsWith('/o/r')) return ok({ default_branch: 'main' });
    if (u.includes('/git/ref/')) return ok({ object: { sha: 'abc' } });
    if (u.includes('/git/trees/')) return ok({ tree: Object.keys(files).map((path) => ({ type: 'blob', path })) });
    const m = /\/contents\/(.+)\?ref=/.exec(u);
    if (m && files[m[1]]) return ok({ content: Buffer.from(files[m[1]]).toString('base64'), sha: 'b' });
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const env = { CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r', AI: { run: async (_m, input) => {
    const system = input.messages[0].content;
    if (system.includes('Architect')) return { response: JSON.stringify({ plan: 'p', search_terms: ['old label'], paths: ['lib/a.dart'] }) };
    if (system.includes('Review')) return { response: JSON.stringify({ approved: true, target_correct: true, notes: [] }) };
    if (!JSON.parse(input.messages[1].content).inspected) return { response: JSON.stringify({ plan: 'p', search_terms: ['old label'], paths: ['lib/a.dart'] }) };
    return { response: JSON.stringify({ summary: 'new label', edits: [{ path: 'lib/a.dart', find: "final String label = 'old label';", replace: "final String label = 'new label';" }] }) };
  } } };
  const out = await prepareSelfUpdate(env, "Change A's label from 'old label' to 'new label'.", fetcher, null, { faults: { malformedOnce: true, anchorMissOnce: true } });
  assert.equal(out.status, 200, out.detail);
  const outcomes = out.diagnostics.outcomes.map((o) => o.outcome);
  assert.ok(outcomes.includes('invalid_json'), 'the truncated answer happened');
  assert.ok(outcomes.includes('missing_anchor'), 'the broken anchor happened');
  assert.ok(new Set(out.diagnostics.outcomes.map((o) => o.round)).size <= 3);
  assert.match(out.proposal.files[0].content, /new label/);
});

test('voice sync: every new owner-facing autonomy/recovery line follows CHE\'s voice rules (sir, speakable, no "tap", no code)', async () => {
  const { honestFailureMessage } = await import('./self_development.js');
  const { ownerEngineeringMessage, FAILURE_CLASS } = await import('./recovery_policy.js');
  const { verifiedStatusText, verifiedState } = await import('./truth_layer.js');
  const lines = [
    honestFailureMessage({ outcomes: [{ outcome: 'missing_anchor' }], genuinePasses: 3, feedback: 'In lib/a.dart, the "find"' }),
    honestFailureMessage({ outcomes: [{ outcome: 'review_rejected' }], genuinePasses: 2 }),
    honestFailureMessage({ budgetStop: true, genuinePasses: 1 }),
    ownerEngineeringMessage(FAILURE_CLASS.INTERNAL),
    speakExamResults({}),
    speakExamResults({ 1: gradeLevel(AUTONOMY_EXAM[0], { status: 422, detail: 'x', diagnostics: { outcomes: [] } }) }),
    verifiedStatusText(verifiedState([], [], { pendingProposal: { summary: 'War Room table' } })),
  ];
  for (const line of lines) {
    assert.match(line, /\bsir\b/, line);
    assert.doesNotMatch(line, /\btap\b|```|As an AI/i, line);
    assert.ok(line.length <= 700, `speakable length: ${line.length}`);
  }
});


test('exam results are isolated by run and a pass cannot be downgraded', () => {
  const pass = { level: 1, name: 'L1', passed: true, checks: [], failed_checks: [], failed_details: [] };
  const fail = { ...pass, passed: false };
  const first = mergeExamResult({}, 'run-a', 1, pass);
  assert.equal(first.results[1].passed, true);
  const downgrade = mergeExamResult(first, 'run-a', 1, fail);
  assert.equal(downgrade.results[1].passed, true);
  const nextRun = mergeExamResult(first, 'run-b', 1, fail);
  assert.equal(nextRun.run_id, 'run-b');
  assert.equal(nextRun.results[1].passed, false);
});

test('format-only engine failures before implementation are ungradable', () => {
  assert.equal(ungradableEngineFailure({ status: 422, detail: 'stopped after 0 implementation passes because the engines then returned no usable output (empty or malformed answers).', engineering_record: { failed_strategies: [] }, diagnostics: { outcomes: [{ outcome: 'invalid_json' }] } }), true);
  assert.equal(ungradableEngineFailure({ status: 422, detail: 'review rejected', engineering_record: { failed_strategies: [{ outcome: 'review_rejected' }] }, diagnostics: { outcomes: [{ outcome: 'review_rejected' }] } }), false);
});
