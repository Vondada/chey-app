# CLAUDE.md: how Claude Code works on CHE

The owner's rules are in `AGENTS.md`; they always win. This file says how a session recovers context and what the owner's
short commands mean for a Claude Code session.

## At the start of every session

1. Run `node .claude/skills/che-recover/scripts/preflight.mjs` (nothing unpushed).
2. Read `docs/CHE_PROJECT_STATUS.md` (current snapshot) and `docs/CHE_PROJECT_HISTORY.md` (timeline).
3. Read `docs/CHE_MISSION_LEDGER.md` and `docs/CHE_WORK_QUEUE.md`, and the latest handoff in `mailbox/briefs/LIVE-HANDOFF.md`
   on the `che-mailbox` branch.
4. Refresh the GitHub state: open PRs and their checks, and the latest commit on `main`.
5. Reconcile: `node tools/continuity_check.mjs --base origin/main --main-sha <sha of origin/main>`. Stale or conflicting facts
   are reported, not merged silently.
6. Give the owner a short summary before continuing: verified state, blockers, and the next authorised action.

## Session checkpoints

After each meaningful milestone: record the changed files, commits, PRs, tests and remaining blockers in the status
snapshot and the history; keep the history's old lines (append only). A claim that an action happened needs an execution
receipt (a commit SHA, a PR number, a test output or a run ID). Without one, say it is unverified.

## Owner commands

These are session workflows for Claude Code. They are not in-app CHE commands.

- **CHE STATUS**: show the verified progress from the snapshot, with times and evidence. Refresh GitHub first. Mark anything
  stale.
- **CHE HISTORY**: show the timeline from `docs/CHE_PROJECT_HISTORY.md`, newest first.
- **CHE BLOCKERS**: show the unresolved problems: blockers in the snapshot, open queue items and failing checks.
- **CHE CONTINUE**: recover context (above), then do the next authorised task. Merge only when green and the owner has
  authorised it; ask before anything that spends money, trades live, deletes, or changes a permission.
- **CHE LOOP**: process a video-derived issue as set out in `docs/CHE_VIDEO_REVIEW_LOOP.md`.

## Never

- Invent a PR, job, test result, merge or deployment.
- Store passwords, tokens or private conversations in these documents.
- Spend money, place a live trade, or change a security permission without the owner's authorisation.
