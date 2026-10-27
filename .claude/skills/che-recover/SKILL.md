---
name: che-recover
description: Recover a blocked CHE development session and protect unfinished work. Covers a full disk, safe cleanup of regenerable caches, an expired or replaced workspace, interrupted jobs, failed package downloads, timeouts and lost context between AIs. Use when a command says no space left, a session expired or restarted, or work must resume from the handoff.
---

# CHE recover

## 1. Preflight: one read-only command
```
node .claude/skills/che-recover/scripts/preflight.mjs [--need-gb 8] [--json]
```
It prints free disk on the repo's filesystem, regenerable build outputs and their size, and **local-only work**: uncommitted changes, branches with commits that are on no remote, worktrees on a detached HEAD with unpushed commits, and stashes (the stack is shared by every worktree and never pushed). Exit 0 = OK, 3 = low disk, 4 = local-only work.

Run it at session start, before a full `flutter test` or an IPA-sized build (needs ~8 GB), and before you stop. Exit 4 at stop time means work will be lost with this container: commit and push it (prefix `WIP:` if partial).

## 2. Full disk
1. `df -h` can mislead in cloud containers: Avail 0 with low Used means the session allowance is spent.
2. Plan: `preflight.mjs --clean` (lists, deletes nothing).
3. Delete: `preflight.mjs --clean --yes`. Only `build/`, `.dart_tool/` and `server/cloudflare/.wrangler/tmp` in the repo and in `.claude/worktrees/*` are removed; a target holding any git-tracked file is refused. Do not run it while another agent is testing in a worktree.
4. Still low: add `--pub-cache`, then `flutter pub get` before building.
5. Deletes still work on a full disk; writes do not. If even `node` cannot start, `rm -rf build .dart_tool` by hand in the repo is the same allowlist.
6. Never delete source, assets, recordings, credentials, transcripts, handoff files, branches, worktrees or uncommitted changes. If cleanup cannot free enough, ask for a fresh session.

## 3. Fresh or replaced workspace (expired session, lost container)
1. `git fetch origin --prune`, read `AGENTS.md`, then `mailbox/briefs/LIVE-HANDOFF.md` on `che-mailbox` (§2 Current position).
2. Trust git over the handoff: for every branch the handoff names, `git ls-remote --heads origin <branch>`. A lane that is not on the remote is lost; say so plainly and redo it only if still wanted.
3. Install tools the container lacks (Flutter: CI uses the stable channel; Node 22 for the Worker).
4. Rerun the tests that were interrupted before building on top.

## 4. Other blockers
`reference/blockers.md` has the procedure, retry limit and stop condition for: interrupted jobs, dropped workers, failed package downloads, CI failures, build timeouts, deploy errors, and lost context between Claude, Codex and ChatGPT.

## Rules
- Retry only what is safe to repeat, at most the limit in the runbook, and change the approach after a failure; never loop the same failing command.
- Never bypass a security check, skip or disable a test, or delete data to get unblocked.
- Report each blocker with the exact command, its real output and what the owner must do, then continue other independent work.
- Status words: **done** = pushed + tests named with counts; **blocked** = needs something named; **unverified** = built but not proven (iPhone, production).
