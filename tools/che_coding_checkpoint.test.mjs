import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshot, verify, restore, revert, readMeta } from './che_coding_checkpoint.mjs';
import { CHECKPOINT_MAX_BYTES } from '../server/cloudflare/coding_failover.mjs';

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@example.invalid' };

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
}

// A small repo that stands in for the runner's checkout: one committed base.
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'che-checkpoint-'));
  const cwd = join(root, 'work');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  git(root, ['init', '-q', cwd]);
  writeFileSync(join(cwd, 'src/a.mjs'), 'export const a = 1;\n');
  writeFileSync(join(cwd, 'src/config.json'), '{"ok": true}\n');
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-q', '-m', 'base']);
  const base = git(cwd, ['rev-parse', 'HEAD']).trim();
  return { root, cwd, base, dir: join(root, 'checkpoint'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('a verified attempt becomes checkpoint 1, and a broken later attempt reverts to it', () => {
  const r = repo();
  try {
    snapshot({ cwd: r.cwd, dir: r.dir });
    writeFileSync(join(r.cwd, 'src/a.mjs'), 'export const a = 2;\n');
    const first = verify({ cwd: r.cwd, dir: r.dir, baseSha: r.base });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.seq, 1);
    assert.deepEqual(first.files, ['src/a.mjs']);
    assert.deepEqual(first.checked, ['src/a.mjs']);

    // A second model edits the same file wrongly and also adds a broken new file.
    writeFileSync(join(r.cwd, 'src/a.mjs'), 'export const a = ;\n');
    writeFileSync(join(r.cwd, 'src/b.mjs'), 'export const b = (;\n');
    const second = verify({ cwd: r.cwd, dir: r.dir, baseSha: r.base });
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'syntax');
    assert.equal(readFileSync(join(r.cwd, 'src/a.mjs'), 'utf8'), 'export const a = 2;\n', 'reverted to the verified checkpoint');
    assert.equal(existsSync(join(r.cwd, 'src/b.mjs')), false, 'the broken new file is removed');
    assert.equal(readMeta(r.dir).seq, 1, 'the failed attempt never becomes a checkpoint');
  } finally { r.cleanup(); }
});

test('unsafe paths are refused and reverted, never checkpointed', () => {
  const r = repo();
  try {
    snapshot({ cwd: r.cwd, dir: r.dir });
    mkdirSync(join(r.cwd, '.github/workflows'), { recursive: true });
    writeFileSync(join(r.cwd, '.github/workflows/evil.yml'), 'on: push\n');
    writeFileSync(join(r.cwd, 'src/a.mjs'), 'export const a = 9;\n');
    const result = verify({ cwd: r.cwd, dir: r.dir, baseSha: r.base });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unsafe_files');
    assert.deepEqual(result.files, ['.github/workflows/evil.yml']);
    assert.equal(existsSync(join(r.cwd, '.github/workflows/evil.yml')), false);
    assert.equal(readFileSync(join(r.cwd, 'src/a.mjs'), 'utf8'), 'export const a = 1;\n');
    assert.equal(existsSync(join(r.dir, 'checkpoint.patch')), false);
  } finally { r.cleanup(); }
});

test('an oversized checkpoint is refused, so it never breaks the GitHub contents write', () => {
  const r = repo();
  try {
    snapshot({ cwd: r.cwd, dir: r.dir });
    writeFileSync(join(r.cwd, 'src/big.txt'), 'x'.repeat(CHECKPOINT_MAX_BYTES + 5000));
    const result = verify({ cwd: r.cwd, dir: r.dir, baseSha: r.base });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'checkpoint_too_large');
    assert.equal(existsSync(join(r.cwd, 'src/big.txt')), false);
  } finally { r.cleanup(); }
});

test('no change is reported as no_change and writes no checkpoint', () => {
  const r = repo();
  try {
    snapshot({ cwd: r.cwd, dir: r.dir });
    const result = verify({ cwd: r.cwd, dir: r.dir, baseSha: r.base });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_change');
    assert.equal(readMeta(r.dir), null);
  } finally { r.cleanup(); }
});

test('resume: a fresh checkout of the same base restores the verified checkpoint', () => {
  const r = repo();
  try {
    snapshot({ cwd: r.cwd, dir: r.dir });
    writeFileSync(join(r.cwd, 'src/a.mjs'), 'export const a = 2;\n');
    writeFileSync(join(r.cwd, 'src/feature.mjs'), 'export const feature = true;\n');
    assert.equal(verify({ cwd: r.cwd, dir: r.dir, baseSha: r.base }).ok, true);

    // The next run starts from a clean checkout of the exact base, with the saved checkpoint.
    const fresh = join(r.root, 'fresh');
    git(r.root, ['clone', '-q', r.cwd, fresh]);
    git(fresh, ['checkout', '-q', r.base]);
    const restored = restore({ cwd: fresh, dir: r.dir });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(restored.restored, true);
    assert.equal(readFileSync(join(fresh, 'src/a.mjs'), 'utf8'), 'export const a = 2;\n');
    assert.equal(readFileSync(join(fresh, 'src/feature.mjs'), 'utf8'), 'export const feature = true;\n');
    assert.equal(restored.meta.seq, 1);
  } finally { r.cleanup(); }
});

test('a checkpoint that no longer applies is reported, not silently dropped or forced', () => {
  const r = repo();
  try {
    snapshot({ cwd: r.cwd, dir: r.dir });
    writeFileSync(join(r.cwd, 'src/a.mjs'), 'export const a = 2;\n');
    assert.equal(verify({ cwd: r.cwd, dir: r.dir, baseSha: r.base }).ok, true);
    const drifted = join(r.root, 'drifted');
    git(r.root, ['clone', '-q', r.cwd, drifted]);
    git(drifted, ['checkout', '-q', r.base]);
    writeFileSync(join(drifted, 'src/a.mjs'), 'export const a = 5;\n');
    const result = restore({ cwd: drifted, dir: r.dir });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'checkpoint_no_longer_applies');
    assert.equal(readFileSync(join(drifted, 'src/a.mjs'), 'utf8'), 'export const a = 5;\n', 'the conflicting file is not overwritten');
  } finally { r.cleanup(); }
});

test('files that existed before the attempts are never deleted by a revert', () => {
  const r = repo();
  try {
    writeFileSync(join(r.cwd, 'notes.local'), 'owner scratch\n');
    snapshot({ cwd: r.cwd, dir: r.dir });
    writeFileSync(join(r.cwd, 'src/a.mjs'), 'export const a = ;\n');
    const result = verify({ cwd: r.cwd, dir: r.dir, baseSha: r.base });
    assert.equal(result.ok, false);
    assert.equal(readFileSync(join(r.cwd, 'notes.local'), 'utf8'), 'owner scratch\n');
    assert.equal(readFileSync(join(r.cwd, 'src/a.mjs'), 'utf8'), 'export const a = 1;\n');
  } finally { r.cleanup(); }
});

test('a second verified attempt builds on the first checkpoint instead of redoing it', () => {
  const r = repo();
  try {
    snapshot({ cwd: r.cwd, dir: r.dir });
    writeFileSync(join(r.cwd, 'src/a.mjs'), 'export const a = 2;\n');
    assert.equal(verify({ cwd: r.cwd, dir: r.dir, baseSha: r.base }).seq, 1);
    writeFileSync(join(r.cwd, 'src/config.json'), '{"ok": false}\n');
    const second = verify({ cwd: r.cwd, dir: r.dir, baseSha: r.base });
    assert.equal(second.ok, true);
    assert.equal(second.seq, 2);
    assert.deepEqual(second.files.sort(), ['src/a.mjs', 'src/config.json']);
    const fresh = join(r.root, 'again');
    git(r.root, ['clone', '-q', r.cwd, fresh]);
    git(fresh, ['checkout', '-q', r.base]);
    assert.equal(restore({ cwd: fresh, dir: r.dir }).restored, true);
    assert.equal(readFileSync(join(fresh, 'src/a.mjs'), 'utf8'), 'export const a = 2;\n');
    assert.equal(readFileSync(join(fresh, 'src/config.json'), 'utf8'), '{"ok": false}\n');
  } finally { r.cleanup(); }
});

test('revert with no checkpoint returns the working tree to the base', () => {
  const r = repo();
  try {
    snapshot({ cwd: r.cwd, dir: r.dir });
    writeFileSync(join(r.cwd, 'src/a.mjs'), 'export const a = 3;\n');
    writeFileSync(join(r.cwd, 'src/new.mjs'), 'export const n = 1;\n');
    revert({ cwd: r.cwd, dir: r.dir });
    assert.equal(readFileSync(join(r.cwd, 'src/a.mjs'), 'utf8'), 'export const a = 1;\n');
    assert.equal(existsSync(join(r.cwd, 'src/new.mjs')), false);
    assert.equal(git(r.cwd, ['status', '--porcelain']).trim(), '');
  } finally { r.cleanup(); }
});
