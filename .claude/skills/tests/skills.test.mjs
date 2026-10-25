// Tests for the Claude Code project skills in .claude/skills: selection by
// description, correct execution of every script on the owner's real cases,
// evidence integrity, token budgets and failure recovery.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(skillsDir, '../..');
const fixtures = join(skillsDir, 'tests/fixtures');
const SKILLS = ['che-debug', 'che-fact-check', 'che-recover', 'che-release', 'che-youtube'];
const script = (skill, file) => join(skillsDir, skill, 'scripts', file);
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: repo, encoding: 'utf8', timeout: 120000, ...opts });
const node = (args, opts) => run(process.execPath, ['--no-warnings', ...args], opts);

function readSkill(name) {
  const text = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(m, `${name}: SKILL.md needs YAML frontmatter`);
  const field = (key) => (new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(m[1]) || [])[1]?.trim() || '';
  return { name: field('name'), description: field('description'), body: m[2], text };
}

// ─── Structure and token budgets ────────────────────────────────────────────

test('every skill has valid frontmatter, a focused description and a small body', () => {
  let alwaysLoaded = 0;
  for (const dir of SKILLS) {
    const skill = readSkill(dir);
    assert.equal(skill.name, dir, 'name matches its folder');
    assert.match(skill.name, /^[a-z0-9-]{1,64}$/);
    assert.ok(skill.description.length >= 120 && skill.description.length <= 1024, `${dir}: description length ${skill.description.length}`);
    assert.match(skill.description, /\bUse when\b/, `${dir}: description says when to use it`);
    // Only name + description load up front; the body loads on demand.
    alwaysLoaded += skill.name.length + skill.description.length;
    const words = skill.body.split(/\s+/).filter(Boolean).length;
    assert.ok(words <= 700, `${dir}: body is ${words} words; keep detail in reference/`);
    assert.ok(skill.body.split('\n').length <= 120, `${dir}: body over 120 lines`);
  }
  assert.ok(alwaysLoaded <= 2400, `always-loaded skill metadata is ${alwaysLoaded} characters`);
});

test('every file a skill points to exists', () => {
  const tracked = new Set(run('git', ['ls-files']).stdout.split('\n').filter(Boolean));
  const local = (rel) => existsSync(join(repo, rel));
  for (const dir of SKILLS) {
    const refDir = join(skillsDir, dir, 'reference');
    const refs = existsSync(refDir) ? readdirSync(refDir).map((f) => readFileSync(join(refDir, f), 'utf8')) : [];
    const text = [readFileSync(join(skillsDir, dir, 'SKILL.md'), 'utf8'), ...refs].join('\n');
    for (const [, path] of text.matchAll(/`(\.claude\/skills\/[^`\s*]+?\.(?:mjs|md|json|sh|py))`/g)) assert.ok(local(path), `${dir}: ${path} is missing`);
    for (const [, rel] of text.matchAll(/`((?:scripts|reference|examples|cases)\/[^`\s*]+?\.(?:mjs|md|json|sh|py))`/g)) assert.ok(existsSync(join(skillsDir, dir, rel)), `${dir}: ${rel} is missing`);
    // Code files the skill names must still exist in the repo (stale maps mislead).
    for (const [, file] of text.matchAll(/`([a-z][a-z0-9_]*\.(?:js|dart|py|yml))`/g)) {
      assert.ok([...tracked].some((p) => p.endsWith(`/${file}`) || p === file), `${dir}: names ${file}, which is not in the repo`);
    }
  }
});

// ─── Selection ─────────────────────────────────────────────────────────────
// Claude chooses a skill by reading these descriptions. This deterministic
// proxy keeps them distinct and in the owner's vocabulary: each request must
// share more description words with its own skill than with any other.
const STOP = new Set('a an the and or but of to in on at for with from by is are was be it its this that these those i me my you your he she his her we our they them what which who when where why how do does did not no can could should would will just about into as so than then there here also only any all each every some such have has had che'.split(' '));
const stem = (w) => w.replace(/ies$/, 'y').replace(/(?:ing|ed|es|s)$/, '');
const words = (text) => new Set(String(text).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).map(stem));
function pick(request) {
  const want = words(request);
  const scored = SKILLS.map((dir) => {
    const have = words(`${dir.replace('che-', '')} ${readSkill(dir).description}`);
    return { dir, score: [...want].filter((w) => have.has(w)).length };
  }).sort((a, b) => b.score - a.score);
  return scored[0].score >= 2 && scored[0].score > scored[1].score ? scored[0].dir : null;
}

test('skill selection: the owner\'s kinds of requests reach the right skill, and unrelated ones reach none', () => {
  const cases = {
    'che-fact-check': [
      'CHE said I confirmed something I never said; check her memory claim',
      'check this drafted CHE reply for an invented source before the owner sees it',
      'review a change to the retractions in memory_provenance.js',
      'CHE claims a tool action and a source she never used; is that a hallucination?',
    ],
    'che-debug': [
      'the owner sent a screenshot of a wrong CHE reply; reproduce the bug',
      'a Worker test fails in CI; fix the defect',
      'fix this broken screen in the Flutter app',
      'replay the owner\'s chat turns to find the defect',
    ],
    'che-release': [
      'is PR 300 merged and deployed?',
      'verify the live production commit after the merge',
      'ship a Shorebird patch for the iPhone',
      'is the newest IPA release installable?',
    ],
    'che-recover': [
      'no space left on device; the disk is full',
      'the session expired; resume from the handoff',
      'recover the lost context and continue where the last AI stopped',
    ],
    'che-youtube': [
      'write a script for a faceless YouTube video about octopuses',
      'make the title and thumbnail for the video',
      'publish the Short to YouTube',
      'change the video pipeline in faceless_video.js',
    ],
  };
  for (const [skill, requests] of Object.entries(cases)) {
    for (const request of requests) assert.equal(pick(request), skill, request);
  }
  for (const request of ['write me a poem about the sea', 'what is the weather tomorrow', 'translate good morning into Spanish', 'tell me a joke']) {
    assert.equal(pick(request), null, request);
  }
});

// ─── Execution on the owner's real cases ───────────────────────────────────

test('che-debug replay: the owner\'s screenshot conversations run through the real /api/chat and meet every expectation', () => {
  for (const file of readdirSync(join(skillsDir, 'che-fact-check/cases'))) {
    const out = node([script('che-debug', 'replay_chat.mjs'), join(skillsDir, 'che-fact-check/cases', file)]);
    assert.equal(out.status, 0, `${file}:\n${out.stdout}${out.stderr}`);
    assert.match(out.stdout, /(\d+)\/\1 expectations met/);
    assert.ok(out.stdout.length < 2500, `${file}: replay output is ${out.stdout.length} bytes`);
  }
});

test('che-debug replay counts model calls truthfully and fails a missed expectation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'replay-'));
  const file = join(dir, 'case.json');
  writeFileSync(file, JSON.stringify({
    model: 'Plants convert light into chemical energy.',
    turns: [
      { message: 'Explain photosynthesis in one sentence', expect: { route: 'model', model_calls: 1 } },
      { message: 'Explain photosynthesis again', expect: { match: 'this text is not in the reply' } },
    ],
  }));
  const out = node([script('che-debug', 'replay_chat.mjs'), file, '--json']);
  assert.equal(out.status, 1, out.stderr);
  const report = JSON.parse(out.stdout);
  assert.equal(report.turns[0].check, 'PASS');
  assert.equal(report.turns[0].model_calls, 1);
  assert.match(report.turns[1].check, /^FAIL: reply does not match/);
});

test('che-fact-check claim_check: CHE\'s own guards block invented owner claims and unreceipted searches', () => {
  const check = (args) => node([script('che-fact-check', 'claim_check.mjs'), ...args]);
  const invented = check(['--reply', 'You confirmed that the new office security protocol requires a two-step biometric check because you personally tested the system last Tuesday. The weather today is mild.']);
  assert.equal(invented.status, 1);
  assert.match(invented.stdout, /VERDICT: BLOCKED/);
  assert.match(invented.stdout, /OWNER SEES: The weather today is mild\./, 'the rest of a short reply survives');
  const supported = check(['--reply', 'You told me your favorite food is pizza, sir.', '--owner', 'my favorite food is pizza']);
  assert.equal(supported.status, 0);
  assert.match(supported.stdout, /VERDICT: PASS/);
  const steps = check(['--reply', '1. **Searched fresh sources** – pulled the most recent articles.']);
  assert.equal(steps.status, 1);
  assert.match(steps.stdout, /no execution receipt/);
  const receipted = check(['--reply', 'I searched the web and found two sources.', '--tool', 'browser/web_search', '--source', 'https://example.org/a']);
  assert.equal(receipted.status, 0);
  const route = check(['--route', "How do you know that's correct? Research a fact, check your sources, and explain what you verified."]);
  assert.match(route.stdout, /ROUTE: che_evidence_receipt \+ rest[\s\S]*che_clarify/);
  assert.match(check(['--route', 'Octopuses have nine brains, is that true?']).stdout, /general pipeline/);
});

// Owner report 2026-10-24: "I retrieved memory IDs 8829, 8830 and 8831 from storage" passed claim_check, which did not run
// the chat pipeline's execution_claims stage. It runs it now, so an invented record id or storage read is BLOCKED.
test('che-fact-check claim_check: invented memory ids and storage reads are blocked like the chat route blocks them', () => {
  const check = (args) => node([script('che-fact-check', 'claim_check.mjs'), ...args]);
  const invented = check(['--reply', 'I retrieved memory IDs 8829, 8830 and 8831 from storage, sir. Record 8829 says your favorite color is blue.']);
  assert.equal(invented.status, 1);
  assert.match(invented.stdout, /VERDICT: BLOCKED/);
  assert.match(invented.stdout, /record, storage or execution claim with no receipt removed: "Record 8829 says/);
  assert.doesNotMatch(invented.stdout.split('OWNER SEES:')[1], /8829|8830|8831/);
  const partial = check(['--reply', 'Your favorite color is red, sir. Memory IDs 8829 and 8830 confirm it.', '--json']);
  assert.equal(partial.status, 1);
  assert.equal(JSON.parse(partial.stdout).owner_sees.startsWith('Your favorite color is red, sir.'), true);
  const plain = check(['--reply', 'The record 2024 sales were strong, and order number 4521 shipped.']);
  assert.equal(plain.status, 0, plain.stdout);
});

test('evidence integrity: claim_check agrees with the deployed chat route on every fixture', () => {
  const replies = [
    ['You personally tested the new door lock last Tuesday.', true],
    ['I remember you confirming that you prefer short replies. Want me to use that?', true],
    ['I searched the web and compared three sources; they agree.', true],
    ['1. Searched fresh sources – I used the browser tool.', true],
    ['According to my research, the bridge opened in 1932.', true],
    ['I googled it and three websites agree.', true],
    ['Plants convert light into chemical energy.', false],
    ['If you tell me your favorite color, I will remember it.', false],
  ];
  const dir = mkdtempSync(join(tmpdir(), 'agree-'));
  for (const [reply, blocked] of replies) {
    const local = node([script('che-fact-check', 'claim_check.mjs'), '--reply', reply]);
    assert.equal(local.status === 1, blocked, `claim_check: ${reply}\n${local.stdout}`);
    const file = join(dir, 'c.json');
    writeFileSync(file, JSON.stringify({ model: reply, turns: ['Tell me about your day in one sentence.'] }));
    const live = JSON.parse(node([script('che-debug', 'replay_chat.mjs'), file, '--json']).stdout).turns[0];
    const corrected = /no record of you saying or confirming that|do not have execution receipts/.test(live.reply);
    assert.equal(corrected, blocked, `/api/chat: ${reply}\n${live.reply}`);
  }
});

// ─── che-release: read-only status with recorded GitHub responses ──────────

const MERGE = '2b0c66e9f5f0103845eaec91c45b60605a7f33cb';
const HEAD = 'c9bc4198b89d0c80a06a7d642798fe98ad69055b';
function fakeGitHub({ liveCommit = 'success', fail = null, health = null } = {}) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push(String(url));
    if (fail === 'throw') throw new Error('network down');
    if (fail && String(url).includes('api.github.com')) return new Response('{}', { status: fail });
    const u = String(url);
    const json = (data) => new Response(JSON.stringify(data), { status: 200 });
    if (u.endsWith('/health')) return health ? json(health) : Promise.reject(new Error('fetch failed'));
    if (u.endsWith('/commits/main')) return new Response(MERGE, { status: 200 });
    if (u.endsWith('/commits/2b0c66e')) return new Response(MERGE, { status: 200 });
    if (u.endsWith('/pulls/300')) return json({ title: 'Memory truth', state: 'closed', merged: true, draft: false, head: { sha: HEAD }, merge_commit_sha: MERGE, mergeable_state: 'unknown' });
    if (u.includes(`/commits/${HEAD}/check-runs`)) return json({ check_runs: [
      { name: 'analyze', status: 'completed', conclusion: 'success' },
      { name: 'Worker syntax and unit tests', status: 'completed', conclusion: 'success' },
      { name: 'Workers Builds: chey-app', status: 'completed', conclusion: 'failure' },
    ] });
    if (u.includes('/actions/runs?head_sha=')) return json({ workflow_runs: [
      { id: 1, name: 'Deploy CHE Worker', status: 'completed', conclusion: liveCommit === 'success' ? 'success' : 'failure', html_url: 'x' },
      { id: 2, name: 'CHE Shorebird', status: 'completed', conclusion: 'success', html_url: 'x' },
    ] });
    if (u.endsWith('/actions/runs/1/jobs')) return json({ jobs: [{ id: 9, steps: [
      { name: 'Deploy', conclusion: 'success' },
      { name: 'Verify live deployed commit', conclusion: liveCommit },
      { name: "Check CHE's ElevenLabs voice through the live Worker (one real call)", conclusion: 'success' },
      { name: "Check CHE's memory truth through the live Worker (real chat test)", conclusion: liveCommit === 'success' ? 'success' : 'skipped' },
    ] }] });
    if (u.endsWith('/check-runs/9/annotations')) return json(liveCommit === 'success' ? [
      { annotation_level: 'notice', title: 'Memory truth', message: '10/10 steps passed; memory answers used 0 model calls; slowest 842 ms' },
      { annotation_level: 'notice', title: '', message: 'The ubuntu-latest label will migrate' },
    ] : [{ annotation_level: 'failure', title: '', message: 'Live CHE did not confirm commit 2b0c66e9f5f0' }]);
    if (u.includes('/releases')) return json([
      { tag_name: 'che-ios-v1.4.10-b1', draft: true, published_at: null, assets: [] },
      { tag_name: 'che-ios-v1.4.1024729463-b3851546996201', draft: false, published_at: '2026-10-14T05:25:25Z', assets: [{ name: 'CHE-unsigned.ipa', size: 42962266, digest: 'sha256:030eca16' }] },
    ]);
    return new Response('{}', { status: 404 });
  };
  return { fetcher, calls };
}
const releaseLib = () => import(pathToFileURL(script('che-release', 'release_status.mjs')).href);

test('che-release status: a merged, deployed PR is reported with what the deploy verified', async () => {
  const { releaseStatus, formatStatus } = await releaseLib();
  const { fetcher, calls } = fakeGitHub();
  const text = formatStatus(await releaseStatus({ pr: 300, fetcher, token: '' }));
  assert.match(text, /MERGED as 2b0c66e9f5f0/);
  assert.match(text, /checks on c9bc4198b89d: GREEN/);
  assert.match(text, /\(non-gating: Workers Builds: chey-app=failure\)/);
  assert.match(text, /live commit check: VERIFIED 2b0c66e9f5f0 is live/);
  assert.match(text, /note: Memory truth: 10\/10 steps passed/);
  assert.doesNotMatch(text, /ubuntu-latest/, 'runner notices are filtered out');
  assert.match(text, /che-ios-v1\.4\.1024729463-b3851546996201 .*sha256 030eca16/, 'drafts are skipped');
  assert.match(text, /not reachable .*rely on the deploy's live commit check/);
  assert.ok(text.length < 1500, `status is ${text.length} bytes`);
  assert.ok(calls.every((url) => !/\/merges|\/dispatches|method=POST/.test(url)), 'read-only');
});

test('che-release evidence integrity: a failed live check, an API outage or a mismatched /health is never reported as live', async () => {
  const { releaseStatus, formatStatus } = await releaseLib();
  const failed = formatStatus(await releaseStatus({ pr: 300, fetcher: fakeGitHub({ liveCommit: 'failure' }).fetcher, token: '' }));
  assert.match(failed, /live commit check: FAILURE \(not verified\)/);
  assert.match(failed, /error: .*did not confirm commit/);
  assert.doesNotMatch(failed, /VERIFIED/);
  for (const fail of [500, 'throw']) {
    const status = await releaseStatus({ pr: 300, fetcher: fakeGitHub({ fail }).fetcher, token: '' });
    const text = formatStatus(status);
    assert.doesNotMatch(text, /VERIFIED|GREEN|MERGED/);
    assert.match(text, /UNKNOWN main head/);
    assert.ok(status.unknown.length >= 3);
  }
  const mismatch = formatStatus(await releaseStatus({ pr: 300, fetcher: fakeGitHub({ health: { ok: true, version_tag: '0123456789ab' } }).fetcher, token: '' }));
  assert.match(mismatch, /version_tag 0123456789ab \(DOES NOT match target\)/);
});

test('che-release retries without a stale token instead of reporting a public repo as unreadable', async () => {
  const { releaseStatus } = await releaseLib();
  const { fetcher } = fakeGitHub();
  const seen = [];
  const strict = async (url, init) => {
    seen.push(Boolean(init?.headers?.Authorization));
    if (init?.headers?.Authorization) return new Response('{}', { status: 401 });
    return fetcher(url, init);
  };
  const status = await releaseStatus({ pr: 300, fetcher: strict, token: 'stale' });
  assert.equal(status.pr.merged, true);
  assert.ok(seen.includes(true) && seen.includes(false));
});

test('che-release expands an abbreviated SHA before matching runs and /health', async () => {
  const { releaseStatus, formatStatus } = await releaseLib();
  const { fetcher, calls } = fakeGitHub({ health: { ok: true, version_tag: MERGE.slice(0, 12) } });
  const status = await releaseStatus({ sha: '2b0c66e', fetcher, token: '' });
  assert.equal(status.target_sha, MERGE);
  assert.ok(calls.some((url) => url.includes(`head_sha=${MERGE}`)), 'runs are looked up by the full SHA');
  assert.match(formatStatus(status), /version_tag 2b0c66e9f5f0 \(matches target\)/);
  const missing = await releaseStatus({ sha: 'deadbee', fetcher, token: '' });
  assert.ok(missing.unknown.some((u) => /^commit deadbee/.test(u)));
});

// ─── che-youtube ────────────────────────────────────────────────────────────

test('che-youtube check_package: a sourced example is ready to render but not to publish', () => {
  const out = node([script('che-youtube', 'check_package.mjs'), join(skillsDir, 'che-youtube/examples/package.example.json'), '--json']);
  assert.equal(out.status, 0, out.stdout);
  const r = JSON.parse(out.stdout);
  assert.equal(r.ready_to_render, true);
  assert.equal(r.ready_to_publish, false, 'no owner approval, no publish');
  assert.equal(r.stats.uncited_factual, 0);
});

test('che-youtube check_package: every publishing problem in a bad package is caught', () => {
  const out = node([script('che-youtube', 'check_package.mjs'), join(fixtures, 'bad_package.json'), '--json']);
  assert.equal(out.status, 1);
  const { errors, warnings, ready_to_publish } = JSON.parse(out.stdout);
  const all = errors.join('\n');
  assert.match(all, /title: \d+ characters; YouTube and CHE's uploader allow 100/);
  assert.match(all, /unsourced factual claim: "Scientists found that octopuses can live 400 years\."/);
  assert.match(all, /script cites \[2\] but there is no source 2/);
  assert.match(all, /thumbnail_text: "9" does not appear in the script/);
  assert.match(all, /privacy: public needs owner_publish_approval/);
  assert.match(warnings.join('\n'), /hype wording/);
  assert.equal(ready_to_publish, false);
});

// ─── Failure recovery and token use of the helpers ──────────────────────────

test('helpers fail loudly and cleanly on bad input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bad-'));
  writeFileSync(join(dir, 'broken.json'), '{ not json');
  writeFileSync(join(dir, 'empty.json'), '{"turns": []}');
  const before = readdirSync(join(repo, 'server/cloudflare')).filter((f) => f.includes('.generated.')).length;
  for (const args of [[join(dir, 'broken.json')], [join(dir, 'empty.json')], []]) {
    const out = node([script('che-debug', 'replay_chat.mjs'), ...args]);
    assert.equal(out.status, 2, `replay ${args}: ${out.stderr}`);
    assert.match(out.stderr, /^replay_chat: /);
  }
  assert.equal(readdirSync(join(repo, 'server/cloudflare')).filter((f) => f.includes('.generated.')).length, before, 'no generated module left behind');
  assert.equal(node([script('che-fact-check', 'claim_check.mjs')]).status, 2);
  assert.equal(node([script('che-fact-check', 'claim_check.mjs'), '--reply', 'x', '--records', join(dir, 'broken.json')]).status, 2);
  assert.equal(node([script('che-youtube', 'check_package.mjs'), join(dir, 'missing.json')]).status, 2);
  assert.equal(node([script('che-release', 'release_status.mjs'), '--pr', 'abc']).status, 2);
});

test('run_checks summaries: a passing suite is one line, a failure keeps its diagnostic, a cut-off run is not a pass', async () => {
  const { summarizeTap } = await import(pathToFileURL(script('che-debug', 'summarize_tap.mjs')).href);
  const raw = readFileSync(join(fixtures, 'tap_fail.txt'), 'utf8');
  const failed = summarizeTap(raw);
  assert.equal(failed.failed, 1);
  assert.match(failed.text, /not ok 2 - the last one keeps the subject/);
  assert.match(failed.text, /did not match the regular expression \/short, friendly\//);
  assert.match(failed.text, /FAIL: 1\/2 passed, 1 failed/);
  const passing = summarizeTap(raw.replace(/not ok 2/, 'ok 2').replace('# pass 1', '# pass 2').replace('# fail 1', '# fail 0'));
  assert.equal(passing.text, 'PASS: 2/2 passed');
  assert.match(summarizeTap('TAP version 13\nok 1 - a\n').text, /did not finish/);
  assert.equal(run('bash', ['-n', script('che-debug', 'run_checks.sh')]).status, 0, 'run_checks.sh parses');
});

test('workflow checker: catches a broken inline script and passes the real workflows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-'));
  writeFileSync(join(dir, 'bad.yml'), "on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - name: broken\n        run: |\n          node --input-type=module <<'JS'\n          const x = ;\n          JS\n");
  const bad = run('python3', [script('che-debug', 'check_workflows.py'), join(dir, 'bad.yml')]);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /bad\.yml › a › broken/);
  const real = run('python3', [script('che-debug', 'check_workflows.py'), ...readdirSync(join(repo, '.github/workflows')).map((f) => join(repo, '.github/workflows', f))]);
  assert.equal(real.status, 0, real.stdout);
});

test('scripts use the checkout they run in, and fall back to their own outside git', () => {
  const outside = node([script('che-fact-check', 'claim_check.mjs'), '--route', 'Is that true, sir?'], { cwd: mkdtempSync(join(tmpdir(), 'nogit-')) });
  assert.equal(outside.status, 0, outside.stderr);
  assert.match(outside.stdout, /ROUTE: che_evidence_receipt/);
});

// ─── che-recover: cleanup removes only regenerable outputs and finds local-only work ───

test('che-recover preflight: cleans build outputs, refuses tracked files, reports unpushed work', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recover-'));
  const sh = (...a) => run('git', a, { cwd: dir });
  sh('init', '-q', '-b', 'main');
  sh('config', 'user.email', 't@example.org');
  sh('config', 'user.name', 't');
  writeFileSync(join(dir, 'keep.dart'), 'void main() {}\n');
  run('mkdir', ['-p', join(dir, 'build/ios'), join(dir, '.dart_tool')]);
  writeFileSync(join(dir, 'build/ios/out.bin'), 'x'.repeat(1000));
  writeFileSync(join(dir, '.dart_tool/state.json'), '{}');
  writeFileSync(join(dir, '.dart_tool/tracked.txt'), 'someone committed this');
  sh('add', 'keep.dart', '-f', '.dart_tool/tracked.txt');
  sh('commit', '-q', '-m', 'init');
  const pre = (...a) => node([script('che-recover', 'preflight.mjs'), '--repo', dir, '--need-gb', '0', '--json', ...a]);

  const read = pre();
  const report = JSON.parse(read.stdout);
  assert.equal(read.status, 4, 'a never-pushed branch is local-only work');
  assert.ok(report.local_only.some((w) => w.kind === 'never pushed' && w.where === 'main'));
  assert.ok(existsSync(join(dir, 'build')), 'read-only by default');

  const plan = JSON.parse(pre('--clean').stdout);
  assert.deepEqual(plan.cleaned, [], '--clean without --yes deletes nothing');
  assert.ok(existsSync(join(dir, 'build/ios/out.bin')));

  const done = JSON.parse(pre('--clean', '--yes').stdout);
  assert.ok(!existsSync(join(dir, 'build')), 'build/ removed');
  assert.ok(existsSync(join(dir, '.dart_tool/tracked.txt')), 'a target holding a tracked file is refused');
  assert.match(done.refused[0].reason, /tracked/);
  assert.ok(existsSync(join(dir, 'keep.dart')), 'source untouched');
});
