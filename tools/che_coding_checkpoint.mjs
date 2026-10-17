// Verified checkpoints for CHE's OpenCode coding runner. A model that edits
// files and then fails does not throw its progress away, and a bad partial change
// never reaches the next model. The working tree always equals
// base + the last verified checkpoint.
//
//   snapshot  record untracked files that exist before any attempt (never deleted)
//   verify    accept the working tree as the next checkpoint, or revert it
//   advance   verify, and on success write the next model's prompt
//   restore   re-apply a saved checkpoint to a fresh checkout of the same base
//   revert    drop unverified edits, then re-apply the last checkpoint
//   classify  read a failed attempt's error text (stdin) into a failure kind
//   unsafe    print the paths the final patch would refuse
//
// Only syntax is checked here (node --check for JS, JSON.parse). Tests and review
// still run on the final change. Dependency-free: the runner calls a trusted copy.
// Exit codes: 0 ok, 1 refused (reverted), 2 the revert itself failed (stop attempts).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKPOINT_MAX_BYTES, classifyModelFailure, progressPrompt, unsafeCodingPaths } from '../server/cloudflare/coding_failover.mjs';

export const CHECKPOINT_PATCH = 'checkpoint.patch';
export const CHECKPOINT_META = 'checkpoint.json';
export const SNAPSHOT = 'untracked-before.txt';
export const NEXT_PROMPT = 'next-prompt.txt';
export const REVERT_FAILED = 2;

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// NUL-separated git output is exact: no quoting of unusual names, no rename pairing.
function nulList(text) {
  return String(text || '').split('\0').filter(Boolean);
}

function untrackedNow(cwd) {
  return nulList(git(cwd, ['ls-files', '-z', '--others', '--exclude-standard']));
}

function baselineUntracked(dir) {
  const path = join(dir, SNAPSHOT);
  if (!existsSync(path)) return new Set();
  return new Set(JSON.parse(readFileSync(path, 'utf8')));
}

export function readMeta(dir) {
  const path = join(dir, CHECKPOINT_META);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (_) { return null; }
}

export function snapshot({ cwd, dir }) {
  mkdirSync(dir, { recursive: true });
  const untracked = untrackedNow(cwd);
  writeFileSync(join(dir, SNAPSHOT), JSON.stringify(untracked));
  return { ok: true, untracked: untracked.length };
}

// Everything the model changed: tracked edits plus new files, minus files that were
// already there before the attempts. Renames show as a delete and an add, so the old
// path is checked too.
function changedPaths(cwd, dir) {
  const before = baselineUntracked(dir);
  const tracked = nulList(git(cwd, ['diff', '--no-renames', '-z', '--name-only', 'HEAD']));
  const fresh = untrackedNow(cwd).filter((path) => !before.has(path));
  // Intent-to-add makes new files part of `git diff HEAD` without committing them.
  if (fresh.length) git(cwd, ['add', '-N', '--', ...fresh]);
  return [...new Set([...tracked, ...fresh])];
}

function syntaxCheck(cwd, path) {
  const absolute = join(cwd, path);
  if (!existsSync(absolute)) return { path, checked: null }; // a deletion has nothing to parse
  try {
    if (/\.(?:m?js|cjs)$/i.test(path)) {
      execFileSync(process.execPath, ['--check', absolute], { stdio: 'pipe' });
      return { path, checked: 'node' };
    }
    if (/\.json$/i.test(path)) {
      JSON.parse(readFileSync(absolute, 'utf8'));
      return { path, checked: 'json' };
    }
    return { path, checked: null };
  } catch (error) {
    return { path, error: String(error?.stderr || error?.message || error).split('\n').slice(0, 3).join(' ').slice(0, 240) };
  }
}

function verifyTree({ cwd, dir, baseSha }) {
  const files = changedPaths(cwd, dir);
  if (!files.length) return { ok: false, reason: 'no_change', files: [] };
  const unsafe = unsafeCodingPaths(files);
  if (unsafe.length) return { ok: false, reason: 'unsafe_files', files: unsafe };
  const patch = git(cwd, ['diff', '--no-renames', '--binary', 'HEAD']);
  const bytes = Buffer.byteLength(patch);
  if (bytes > CHECKPOINT_MAX_BYTES) return { ok: false, reason: 'checkpoint_too_large', bytes };
  const checks = files.map((path) => syntaxCheck(cwd, path));
  const problems = checks.filter((item) => item.error);
  if (problems.length) return { ok: false, reason: 'syntax', problems };
  let additions = 0;
  let deletions = 0;
  for (const row of git(cwd, ['diff', '--no-renames', '--numstat', 'HEAD']).split('\n').filter(Boolean)) {
    const [a, d] = row.split('\t');
    if (/^\d+$/.test(a)) additions += Number(a);
    if (/^\d+$/.test(d)) deletions += Number(d);
  }
  const checked = checks.filter((item) => item.checked).map((item) => item.path);
  const meta = {
    seq: (readMeta(dir)?.seq || 0) + 1,
    base_sha: String(baseSha || ''),
    files,
    additions,
    deletions,
    checked,
    unchecked: files.filter((path) => !checked.includes(path)),
    bytes,
    at: new Date().toISOString(),
  };
  writeCheckpoint(dir, patch, meta);
  return { ok: true, ...meta };
}

// The patch and its metadata are one checkpoint. If either write fails, both are removed,
// so a half-written pair can never be re-applied by a later revert.
function writeCheckpoint(dir, patch, meta) {
  try {
    writeFileSync(join(dir, CHECKPOINT_PATCH), patch);
    writeFileSync(join(dir, CHECKPOINT_META), JSON.stringify(meta));
  } catch (error) {
    for (const name of [CHECKPOINT_PATCH, CHECKPOINT_META]) {
      try { unlinkSync(join(dir, name)); } catch (_) { /* already absent, or not removable */ }
    }
    throw error;
  }
}

// Accept the working tree as the next checkpoint when it is safe, small and parses.
// Anything else is reverted, including when verification itself throws.
export function verify({ cwd, dir, baseSha = '' }) {
  let verdict;
  try {
    verdict = verifyTree({ cwd, dir, baseSha });
  } catch (error) {
    verdict = { ok: false, reason: 'verify_error', detail: String(error?.message || error).slice(0, 200) };
  }
  if (verdict.ok) return verdict;
  try {
    revert({ cwd, dir });
  } catch (error) {
    return { ok: false, reason: 'revert_failed', detail: String(error?.message || error).slice(0, 200) };
  }
  return verdict;
}

// Verify, and on success write the prompt the next model receives: the original request
// plus what is already verified.
export function advance({ cwd, dir, baseSha = '', basePrompt = '', attempt = 1 }) {
  const verdict = verify({ cwd, dir, baseSha });
  if (verdict.ok) {
    writeFileSync(join(dir, NEXT_PROMPT), progressPrompt({
      basePrompt,
      files: verdict.files,
      additions: verdict.additions,
      deletions: verdict.deletions,
      attempt,
    }));
  }
  return verdict;
}

export function restore({ cwd, dir }) {
  const patchPath = join(dir, CHECKPOINT_PATCH);
  if (!existsSync(patchPath)) return { ok: true, restored: false };
  try {
    git(cwd, ['apply', '--check', patchPath]);
    git(cwd, ['apply', patchPath]);
    return { ok: true, restored: true, meta: readMeta(dir) };
  } catch (error) {
    return { ok: false, restored: false, reason: 'checkpoint_no_longer_applies', detail: String(error?.stderr || error?.message || error).slice(0, 240) };
  }
}

// Base first, then the saved checkpoint. Files that existed before the attempts are
// never deleted.
export function revert({ cwd, dir }) {
  const before = baselineUntracked(dir);
  // Unstage intent-to-add entries first so they show as untracked and can be removed.
  git(cwd, ['reset', '-q']);
  git(cwd, ['checkout', '-q', 'HEAD', '--', '.']);
  for (const path of untrackedNow(cwd)) {
    if (!before.has(path)) unlinkSync(join(cwd, path));
  }
  return restore({ cwd, dir });
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : '';
}

function main(argv) {
  const [command, ...rest] = argv;
  const cwd = argValue(rest, '--cwd') || process.cwd();
  const dir = argValue(rest, '--dir') || join(process.env.RUNNER_TEMP || '/tmp', 'che-checkpoint');
  let result;
  if (command === 'snapshot') result = snapshot({ cwd, dir });
  else if (command === 'verify') result = verify({ cwd, dir, baseSha: argValue(rest, '--base') });
  else if (command === 'advance') {
    const promptFile = argValue(rest, '--prompt-file');
    const basePrompt = promptFile && existsSync(promptFile) ? readFileSync(promptFile, 'utf8') : '';
    result = advance({ cwd, dir, baseSha: argValue(rest, '--base'), basePrompt, attempt: Number(argValue(rest, '--attempt')) || 1 });
  } else if (command === 'classify') {
    // The failure text arrives on stdin; the kind decides whether a resume may follow.
    const verdict = classifyModelFailure({ text: readFileSync(0, 'utf8'), exitCode: Number(argValue(rest, '--exit')) || 0 });
    const field = argValue(rest, '--field');
    if (field) {
      process.stdout.write(`${verdict[field]}\n`);
      return 0;
    }
    result = verdict;
  } else if (command === 'restore') result = restore({ cwd, dir });
  else if (command === 'revert') result = revert({ cwd, dir });
  else if (command === 'unsafe') result = unsafeCodingPaths(rest.filter((arg) => !arg.startsWith('--')));
  else if (command === 'status') result = readMeta(dir) || { seq: 0 };
  else throw new Error(`Unknown checkpoint command: ${command || '(none)'}`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result?.reason === 'revert_failed') return REVERT_FAILED;
  return result && result.ok === false ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
