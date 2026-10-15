// Guards the REA runner itself: the pinned version, the workflow's permissions and
// inputs, and the archive checks in tools/rea/analyze.mjs (run for real).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REA_PIN } from './rea_evidence.js';

const ROOT = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8');
const WORKFLOW = read('.github/workflows/che-rea-analysis.yml');
const PKG = JSON.parse(read('tools/rea/package.json'));
const LOCK = JSON.parse(read('tools/rea/package-lock.json'));
const ANALYZE = new URL('../../tools/rea/analyze.mjs', import.meta.url).pathname;

function analyze(args, env = {}) {
  return spawnSync('node', [ANALYZE, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
}

test('the runner pins one exact REA version, and the lockfile carries the registry checksum', () => {
  assert.equal(PKG.dependencies['rea-agents'], '6.5.0', 'exact version, no range');
  assert.equal(REA_PIN.version, PKG.dependencies['rea-agents'], 'the Worker and the runner name the same version');
  const pinned = LOCK.packages['node_modules/rea-agents'];
  assert.equal(pinned.version, '6.5.0');
  assert.equal(pinned.integrity, 'sha512-C6BG7LyrAdR74mSjertM6PrxJkcNZ2bfQNOJornPo9erDEp2tyPRVYPnV5Yodr+1RqewCQla68WulXlVnveD+A==');
  assert.match(pinned.resolved, /^https:\/\/registry\.npmjs\.org\/rea-agents\/-\/rea-agents-6\.5\.0\.tgz$/);
});

test('the workflow runs only on dispatch, and the analysis job can read but not write', () => {
  assert.match(WORKFLOW, /^on:\n {2}workflow_dispatch:/m);
  assert.doesNotMatch(WORKFLOW, /^ {2}(push|pull_request|schedule):/m, 'no automatic runs');
  const analyze = WORKFLOW.slice(WORKFLOW.indexOf('  analyze:'), WORKFLOW.indexOf('  publish:'));
  const publish = WORKFLOW.slice(WORKFLOW.indexOf('  publish:'));
  assert.match(analyze, /permissions:\n {6}contents: read/);
  assert.doesNotMatch(analyze, /contents: write/);
  assert.match(publish, /permissions:\n {6}contents: write/);
  assert.doesNotMatch(publish, /npm (ci|install)|node tools\/rea\/analyze\.mjs (reduce|check-archive)/, 'the writer runs no package code');
  assert.match(analyze, /persist-credentials: false/, 'no token is left in the checkout');
  assert.doesNotMatch(WORKFLOW, /secrets\./, 'no secrets reach the analysis');
});

test('the job-level env uses no runner context, which GitHub rejects there (it parses only in steps)', () => {
  const analyze = WORKFLOW.slice(WORKFLOW.indexOf('  analyze:'), WORKFLOW.indexOf('    steps:'));
  assert.doesNotMatch(analyze, /runner\./, 'runner.* is valid only inside steps');
  assert.match(WORKFLOW, /echo "WORK=\$WORK" >> "\$GITHUB_ENV"/, 'the work folder is set inside the first step');
});

test('the install runs no scripts and no optional packages, and the analysis has fixed limits', () => {
  assert.match(WORKFLOW, /npm ci --ignore-scripts --omit=optional/);
  assert.match(WORKFLOW, /timeout --kill-after=30 600 node tools\/rea\/node_modules\/rea-agents\/scripts\/rea\.mjs/);
  assert.match(WORKFLOW, /analyze-javascript-application "\$WORK\/app\/package"/);
  assert.match(WORKFLOW, /--analysis-timeout-ms 300000 --max-heap-mb 1024/);
  assert.match(WORKFLOW, /timeout-minutes: 15/);
  assert.match(WORKFLOW, /node-version: 24/);
});

test('job inputs reach the shell only through environment variables, never by template in a command', () => {
  for (const line of WORKFLOW.split('\n').filter((l) => l.includes('${{ inputs.'))) {
    const allowed = /^ {6,10}[A-Z_]+: \$\{\{ inputs\.[a-z_]+ \}\}$/.test(line)
      || /^ {2}group: che-rea-\$\{\{ inputs\.job_id \}\}$/.test(line)
      || /^ {10}name: rea-summary-\$\{\{ inputs\.job_id \}\}$/.test(line);
    assert.ok(allowed, `unexpected input use: ${line.trim()}`);
  }
});

test('the publisher writes only the mailbox result path on che-mailbox and never overwrites', () => {
  assert.match(WORKFLOW, /path = `mailbox\/rea\/\$\{jobId\}\.json`|const path = `mailbox\/rea\/\$\{jobId\}\.json`;/);
  assert.match(WORKFLOW, /branch: 'che-mailbox'/);
  assert.match(WORKFLOW, /error\.status === 409 \|\| error\.status === 422/);
  assert.match(WORKFLOW, /ANALYZE_RESULT/);
});

test('the archive checker rejects a checksum mismatch and reads a sound tarball', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rea-archive-'));
  const src = join(dir, 'src', 'package');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'index.js'), 'module.exports = 1;\n');
  const pack = spawnSync('tar', ['-czf', join(dir, 'good.tgz'), '-C', join(dir, 'src'), 'package'], { encoding: 'utf8' });
  assert.equal(pack.status, 0);
  const bytes = readFileSync(join(dir, 'good.tgz'));
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

  const ok = analyze(['check-archive', join(dir, 'good.tgz'), integrity]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /archive ok: \d+ entries/);

  const wrong = analyze(['check-archive', join(dir, 'good.tgz'), 'sha512-' + 'A'.repeat(86) + '=='], {});
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /does not match the registry checksum/);
});

test('the archive checker refuses a link that could point outside the analyzed folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rea-link-'));
  const src = join(dir, 'src', 'package');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'index.js'), '1\n');
  symlinkSync('/etc/passwd', join(src, 'escape.js'));
  assert.equal(spawnSync('tar', ['-czf', join(dir, 'link.tgz'), '-C', join(dir, 'src'), 'package'], { encoding: 'utf8' }).status, 0);
  const integrity = `sha512-${createHash('sha512').update(readFileSync(join(dir, 'link.tgz'))).digest('base64')}`;
  const refused = analyze(['check-archive', join(dir, 'link.tgz'), integrity]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /symbolic link/);
});

test('validate accepts one exact package and rejects ranges, tags and paths', () => {
  const good = analyze(['validate'], { JOB_ID: 'rea-0a1b3c4d', TARGET: 'npm:semver@7.7.2', EXPECTED_INTEGRITY: 'sha512-' + 'A'.repeat(86) + '==' });
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /PKG_NAME=semver\nPKG_VERSION=7\.7\.2/);
  for (const target of ['npm:semver@^7.0.0', 'npm:semver@latest', 'https://example.com/app.zip', 'npm:semver']) {
    const refused = analyze(['validate'], { JOB_ID: 'rea-0a1b3c4d', TARGET: target, EXPECTED_INTEGRITY: 'sha512-' + 'A'.repeat(86) + '==' });
    assert.equal(refused.status, 1, target);
  }
  const badJob = analyze(['validate'], { JOB_ID: '../escape', TARGET: 'npm:semver@7.7.2', EXPECTED_INTEGRITY: 'sha512-' + 'A'.repeat(86) + '==' });
  assert.equal(badJob.status, 1);
});
