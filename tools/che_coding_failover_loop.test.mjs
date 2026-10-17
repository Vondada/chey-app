// Runs the workflow's real "Run OpenCode in the isolated checkout" step against a temp
// git repo and a fake `opencode` whose plan says what each model edits and how it fails.
// Covers: a free model failing and another taking over, verified checkpoints carried to
// the next model, unverified edits reverted, honest failure, paid fallback withheld, and
// a resume from a checkpoint saved by an earlier run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const workflow = readFileSync(join(ROOT, '.github/workflows/che-opencode-runtime.yml'), 'utf8');

function runStep() {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line.trim() === '- name: Run OpenCode in the isolated checkout');
  assert.ok(start > 0, 'the run step exists');
  const at = lines.findIndex((line, i) => i > start && line === '        run: |');
  const body = [];
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line !== '' && !line.startsWith(' '.repeat(10))) break;
    body.push(line.slice(10));
  }
  return body.join('\n');
}

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'che-loop-'));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  git(root, ['init', '-q', repo]);
  writeFileSync(join(repo, 'src/a.mjs'), 'export const a = 1;\n');
  // The step runs the repo's own tools, exactly as the runner has them checked out.
  mkdirSync(join(repo, 'tools'), { recursive: true });
  mkdirSync(join(repo, 'server/cloudflare'), { recursive: true });
  cpSync(join(ROOT, 'tools/che_coding_checkpoint.mjs'), join(repo, 'tools/che_coding_checkpoint.mjs'));
  cpSync(join(ROOT, 'tools/che_coding_paid_gate.mjs'), join(repo, 'tools/che_coding_paid_gate.mjs'));
  cpSync(join(ROOT, 'server/cloudflare/coding_failover.mjs'), join(repo, 'server/cloudflare/coding_failover.mjs'));
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'base']);
  const base = git(repo, ['rev-parse', 'HEAD']).trim();
  // The runner stages the same tools from the base into a trusted directory before any attempt.
  const trusted = join(root, 'trusted');
  mkdirSync(join(trusted, 'tools'), { recursive: true });
  mkdirSync(join(trusted, 'server/cloudflare'), { recursive: true });
  cpSync(join(ROOT, 'tools/che_coding_checkpoint.mjs'), join(trusted, 'tools/che_coding_checkpoint.mjs'));
  cpSync(join(ROOT, 'tools/che_coding_paid_gate.mjs'), join(trusted, 'tools/che_coding_paid_gate.mjs'));
  cpSync(join(ROOT, 'server/cloudflare/coding_failover.mjs'), join(trusted, 'server/cloudflare/coding_failover.mjs'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'opencode'), `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const args = process.argv.slice(2);
const model = args[args.indexOf('--model') + 1];
const prompt = args[args.length - 1];
const plan = JSON.parse(fs.readFileSync(process.env.FAKE_PLAN, 'utf8'));
const step = plan[model] || { exit: 1, stderr: 'model does not exist or you do not have access' };
const a = fs.existsSync('src/a.mjs') ? fs.readFileSync('src/a.mjs', 'utf8').trim() : 'missing';
fs.appendFileSync(process.env.FAKE_CALLS, model + '|' + (prompt.includes('VERIFIED PROGRESS') ? 'progress' : 'base') + '|' + a + '\\n');
for (const [file, content] of Object.entries(step.writes || {})) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
if (step.stderr) process.stderr.write(step.stderr + '\\n');
process.exit(step.exit === undefined ? 0 : step.exit);
`);
  chmodSync(join(bin, 'opencode'), 0o755);
  const runnerTemp = join(root, 'runner');
  mkdirSync(runnerTemp);
  const tmp = join(root, 'tmp');
  mkdirSync(tmp);
  writeFileSync(join(tmp, 'che-runtime-prompt.txt'), 'ORIGINAL REQUEST: finish the change.');
  return { root, repo, base, bin, runnerTemp, tmp, trusted, calls: join(root, 'calls.log'), plan: join(root, 'plan.json') };
}

// Runs the real step. Its /tmp paths are redirected into the sandbox so tests never collide.
function run(box, { plan, free, paid = '', env = {} }) {
  writeFileSync(box.plan, JSON.stringify(plan));
  const output = join(box.root, 'github-output');
  writeFileSync(output, '');
  const script = runStep().replaceAll('/tmp/', `${box.tmp}/`);
  const result = spawnSync('bash', ['-c', script], {
    cwd: box.repo,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      PATH: `${box.bin}:${process.env.PATH}`,
      HOME: box.root,
      RUNNER_TEMP: box.runnerTemp,
      CHE_TRUSTED_TOOLS: box.trusted,
      BASE_SHA: box.base,
      FREE_CANDIDATES: free,
      PAID_CANDIDATES: paid,
      K_OPENROUTER: 'fake-free-key',
      K_PAID_OPENROUTER: '',
      FAKE_PLAN: box.plan,
      FAKE_CALLS: box.calls,
      GITHUB_OUTPUT: output,
      ...env,
    },
  });
  const outputs = Object.fromEntries(readFileSync(output, 'utf8').split('\n').filter(Boolean).map((line) => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1)];
  }));
  const calls = existsSync(box.calls) ? readFileSync(box.calls, 'utf8').trim().split('\n').filter(Boolean) : [];
  return { status: result.status, stderr: result.stderr, stdout: result.stdout, outputs, calls };
}

const FREE_A = 'openrouter/free-a:free';
const FREE_B = 'openrouter/free-b:free';
const FREE_C = 'openrouter/free-c:free';
const PAID = 'openrouter/qwen/qwen3-coder';

test('a free model fails after a verified edit, and the next free model continues from that checkpoint', () => {
  const box = sandbox();
  const result = run(box, {
    free: `${FREE_A} ${FREE_B}`,
    plan: {
      [FREE_A]: { writes: { 'src/a.mjs': 'export const a = 2;\n' }, stderr: 'You exceeded your current quota', exit: 1 },
      [FREE_B]: { writes: { 'src/b.mjs': 'export const b = 3;\n' }, exit: 0 },
    },
  });
  assert.equal(result.outputs.exit_code, '0', result.stderr);
  assert.equal(result.outputs.model, FREE_B);
  assert.equal(result.calls[1], `${FREE_B}|progress|export const a = 2;`, 'the second model starts from the verified change');
  assert.match(result.stdout + result.stderr, /left verified progress/);
});

test('an edit that does not parse is reverted, so the next free model starts from the base', () => {
  const box = sandbox();
  const result = run(box, {
    free: `${FREE_A} ${FREE_B}`,
    plan: {
      [FREE_A]: { writes: { 'src/a.mjs': 'export const a = ;\n' }, stderr: 'rate limit reached', exit: 1 },
      [FREE_B]: { writes: { 'src/b.mjs': 'export const b = 3;\n' }, exit: 0 },
    },
  });
  assert.equal(result.outputs.exit_code, '0', result.stderr);
  assert.equal(result.calls[1], `${FREE_B}|base|export const a = 1;`, 'the broken edit never reaches the next model');
  assert.match(result.stdout + result.stderr, /did not verify; reverted/);
});

test('every free model out of capacity: the run is blocked, names the cause and is resumable; paid is not used without authorization', () => {
  const box = sandbox();
  const result = run(box, {
    free: `${FREE_A} ${FREE_B}`,
    paid: PAID,
    plan: {
      [FREE_A]: { stderr: 'exceeded your current quota', exit: 1 },
      [FREE_B]: { stderr: 'exceeded your current quota', exit: 1 },
      [PAID]: { writes: { 'src/a.mjs': 'export const a = 9;\n' }, exit: 0 },
    },
  });
  assert.notEqual(result.outputs.exit_code, '0');
  assert.equal(result.outputs.failure_kind, 'quota');
  assert.equal(result.outputs.resumable, 'true');
  assert.deepEqual(result.calls.map((line) => line.split('|')[0]), [FREE_A, FREE_B], 'paid never ran');
  assert.match(result.stdout + result.stderr, /Paid fallback not authorized/);
});

test('paid fallback is withheld when enabled but no verified capped key exists, and no paid request is made', () => {
  const box = sandbox();
  const result = run(box, {
    free: FREE_A,
    paid: PAID,
    env: { CHE_CODING_PAID_FALLBACK: 'true', K_PAID_OPENROUTER: '' },
    plan: { [FREE_A]: { stderr: 'exceeded your current quota', exit: 1 }, [PAID]: { exit: 0 } },
  });
  assert.notEqual(result.outputs.exit_code, '0');
  assert.deepEqual(result.calls.map((line) => line.split('|')[0]), [FREE_A]);
  assert.match(result.stdout + result.stderr, /Paid coding withheld/);
});

test('resume: a later run restores the checkpoint saved by an earlier run and finishes from it', () => {
  const first = sandbox();
  const blocked = run(first, {
    free: `${FREE_A} ${FREE_B}`,
    plan: {
      [FREE_A]: { writes: { 'src/a.mjs': 'export const a = 2;\n' }, stderr: 'exceeded your current quota', exit: 1 },
      [FREE_B]: { stderr: 'rate limit reached', exit: 1 },
    },
  });
  assert.notEqual(blocked.outputs.exit_code, '0');
  assert.equal(blocked.outputs.resumable, 'true');
  const saved = join(first.runnerTemp, 'che-checkpoint');
  assert.ok(existsSync(join(saved, 'checkpoint.patch')), 'the verified checkpoint was kept');

  // The actual runner checks out the exact commit SHA that made the checkpoint.
  // Independent mock repos may contain identical files but different commit IDs;
  // reusing an arbitrary commit here would (correctly) fail the integrity gate.
  const later = sandbox();
  git(later.repo, ['fetch', '-q', first.repo, 'HEAD']);
  git(later.repo, ['checkout', '-q', first.base]);
  later.base = first.base;
  const resumedDir = join(later.runnerTemp, 'che-checkpoint');
  mkdirSync(resumedDir, { recursive: true });
  cpSync(join(saved, 'checkpoint.patch'), join(resumedDir, 'checkpoint.patch'));
  cpSync(join(saved, 'checkpoint.json'), join(resumedDir, 'checkpoint.json'));
  const done = run(later, {
    free: FREE_C,
    plan: { [FREE_C]: { writes: { 'src/c.mjs': 'export const c = 1;\n' }, exit: 0 } },
  });
  assert.equal(done.outputs.exit_code, '0', done.stderr);
  assert.match(done.stdout, /Restored verified checkpoint/);
  assert.equal(done.calls[0], `${FREE_C}|base|export const a = 2;`, 'the model sees the restored change');
  assert.equal(readFileSync(join(later.repo, 'src/a.mjs'), 'utf8'), 'export const a = 2;\n');
  assert.equal(readFileSync(join(later.repo, 'src/c.mjs'), 'utf8'), 'export const c = 1;\n');
});

test('a resumed checkpoint that no longer applies is discarded, and the run starts clean from the base', () => {
  const first = sandbox();
  run(first, {
    free: FREE_A,
    plan: { [FREE_A]: { writes: { 'src/a.mjs': 'export const a = 2;\n' }, stderr: 'exceeded your current quota', exit: 1 } },
  });
  const saved = join(first.runnerTemp, 'che-checkpoint');
  const later = sandbox();
  const resumedDir = join(later.runnerTemp, 'che-checkpoint');
  mkdirSync(resumedDir, { recursive: true });
  cpSync(join(saved, 'checkpoint.patch'), join(resumedDir, 'checkpoint.patch'));
  cpSync(join(saved, 'checkpoint.json'), join(resumedDir, 'checkpoint.json'));
  // The base moved: the same file was changed on main, so the old patch cannot apply.
  writeFileSync(join(later.repo, 'src/a.mjs'), 'export const a = 7;\n');
  git(later.repo, ['commit', '-q', '-am', 'drift']);
  const result = run(later, { free: FREE_B, plan: { [FREE_B]: { exit: 0 } } });
  assert.match(result.stdout + result.stderr, /no longer applies to this base/);
  assert.equal(result.calls[0], `${FREE_B}|base|export const a = 7;`);
  assert.equal(existsSync(join(resumedDir, 'checkpoint.patch')), false);
});
