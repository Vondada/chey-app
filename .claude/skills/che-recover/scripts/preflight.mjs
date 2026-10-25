#!/usr/bin/env node
// CHE development preflight and safe recovery (owner, 2026-10-25).
//
//   node .claude/skills/che-recover/scripts/preflight.mjs [--need-gb N] [--json]
//   node .claude/skills/che-recover/scripts/preflight.mjs --clean [--pub-cache] [--yes]
//
// Default: read-only. Reports free disk on the repo's filesystem, the size of
// regenerable build outputs, and work that exists only on this machine
// (uncommitted changes, commits on branches or worktrees that were never pushed).
// A full container or an expired session loses exactly that work.
//
// --clean lists what it would delete; add --yes to delete. It only ever removes
// the regenerable targets below, and refuses any target that holds a file git
// tracks. Source, assets, recordings, credentials, handoff files, branches and
// worktrees are never touched. --pub-cache adds ~/.pub-cache (run
// `flutter pub get` afterwards to restore it).
//
// Exit codes: 0 ok, 3 low disk (below --need-gb), 4 local-only work found, 2 usage.

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, rmSync, statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const known = new Set(['--need-gb', '--json', '--clean', '--pub-cache', '--yes', '--repo']);
for (const a of args) {
  if (a.startsWith('--') && !known.has(a)) {
    console.error(`unknown option ${a}`);
    process.exit(2);
  }
}

const git = (cwd, ...cmd) => {
  try {
    return execFileSync('git', cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

const repo = resolve(value('--repo', git(process.cwd(), 'rev-parse', '--show-toplevel') || process.cwd()));
const needGb = Number(value('--need-gb', '8'));
const GB = 1024 ** 3;

function freeBytes(path) {
  const s = statfsSync(path);
  return s.bavail * s.bsize;
}

function sizeOf(path) {
  let total = 0;
  const stack = [path];
  while (stack.length) {
    const p = stack.pop();
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      let names = [];
      try {
        names = readdirSync(p);
      } catch {
        continue;
      }
      for (const n of names) stack.push(join(p, n));
    } else {
      total += st.size;
    }
  }
  return total;
}

// Regenerable outputs only. Each is recreated by `flutter pub get`, `flutter
// build`/`flutter test`, or `npm ci`.
function cleanTargets() {
  const roots = [repo];
  const wt = join(repo, '.claude', 'worktrees');
  if (existsSync(wt)) for (const n of readdirSync(wt)) roots.push(join(wt, n));
  const targets = [];
  for (const root of roots) {
    for (const rel of ['build', '.dart_tool', join('server', 'cloudflare', '.wrangler', 'tmp')]) {
      const p = join(root, rel);
      if (existsSync(p)) targets.push({ path: p, why: 'build output', root });
    }
  }
  if (flag('--pub-cache')) {
    const p = process.env.PUB_CACHE || join(homedir(), '.pub-cache');
    if (existsSync(p)) targets.push({ path: p, why: 'package cache (restore: flutter pub get)', root: null });
  }
  return targets;
}

// A target holding a file git tracks is not disposable: refuse it.
function trackedInside(target) {
  if (!target.root) return 0;
  const out = git(target.root, 'ls-files', '--', target.path);
  return out ? out.split('\n').filter(Boolean).length : 0;
}

// Work that exists only here: uncommitted changes and unpushed commits.
function localOnlyWork() {
  const found = [];
  const worktrees = (git(repo, 'worktree', 'list', '--porcelain') || '')
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice(9));
  for (const wt of worktrees.length ? worktrees : [repo]) {
    const dirty = (git(wt, 'status', '--porcelain') || '').split('\n').filter(Boolean).length;
    if (dirty) found.push({ where: wt, kind: 'uncommitted', count: dirty });
  }
  const branches = (git(repo, 'for-each-ref', '--format=%(refname:short)|%(upstream:short)', 'refs/heads') || '')
    .split('\n')
    .filter(Boolean);
  for (const line of branches) {
    const [branch, upstream] = line.split('|');
    // Unpushed = reachable from the branch but from no remote ref at all.
    const n = Number(git(repo, 'rev-list', '--count', branch, '--not', '--remotes') || 0);
    if (n > 0) found.push({ where: branch, kind: upstream ? 'unpushed' : 'never pushed', count: n });
  }
  return found;
}

const before = freeBytes(repo);
const report = {
  repo,
  free_gb: +(before / GB).toFixed(2),
  need_gb: needGb,
  disk_ok: before >= needGb * GB,
  targets: cleanTargets().map((t) => ({ ...t, bytes: sizeOf(t.path), tracked: trackedInside(t) })),
  local_only: localOnlyWork(),
  cleaned: [],
  refused: [],
};

if (flag('--clean')) {
  for (const t of report.targets) {
    if (t.tracked) {
      report.refused.push({ path: t.path, reason: `${t.tracked} tracked file(s) inside` });
      continue;
    }
    if (flag('--yes')) {
      rmSync(t.path, { recursive: true, force: true });
      report.cleaned.push(t.path);
    }
  }
  report.free_gb_after = +(freeBytes(repo) / GB).toFixed(2);
  report.disk_ok = freeBytes(repo) >= needGb * GB;
}

const code = !report.disk_ok ? 3 : report.local_only.length ? 4 : 0;

if (flag('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const gb = (b) => `${(b / GB).toFixed(2)} GB`;
  console.log(`DISK: ${report.free_gb} GB free on ${repo} (need ${needGb}) -> ${report.disk_ok ? 'OK' : 'LOW'}`);
  for (const t of report.targets) {
    const state = report.cleaned.includes(t.path) ? 'DELETED' : t.tracked ? 'REFUSED (tracked files)' : flag('--clean') ? 'would delete (add --yes)' : 'regenerable';
    console.log(`  ${gb(t.bytes).padStart(10)}  ${t.path}  [${t.why}] ${state}`);
  }
  if (report.free_gb_after !== undefined) console.log(`DISK AFTER: ${report.free_gb_after} GB free`);
  if (report.local_only.length) {
    console.log('LOCAL-ONLY WORK (lost if this container ends; commit and push it):');
    for (const w of report.local_only) console.log(`  ${w.kind}: ${w.where} (${w.count})`);
  } else {
    console.log('LOCAL-ONLY WORK: none; everything is pushed.');
  }
}
process.exit(code);
