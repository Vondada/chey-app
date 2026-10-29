# CHE Video Review Loop (standing workflow, owner, 2026-10-28)

The owner sends ChatGPT a video of CHE, of Claude, of another application, or of a feature to recreate. ChatGPT watches
the footage and decides which of four things it needs. Claude then acts on that decision.

## The four outcomes

1. **Bug fix or blocker resolution**: CHE does something wrong, or a workflow is blocked. Claude finds the cause in the
   code, fixes it with a test, and opens a PR.
2. **Feature implementation or recreation**: CHE should do something it does not do yet. Claude first inspects the
   repository and the work queue for an existing or partly built version, then builds only what is missing.
3. **Explanation only**: the video shows something that needs explaining, and no change is wanted. Claude answers from
   the code and the evidence. No PR.
4. **Verification of Claude's progress**: a review of work Claude says it finished. Claude separates what the evidence
   shows (run output, a deploy run, a test) from what was only claimed, and names the next action.

## Clips and what Claude can inspect

- When Claude needs to see the original footage, ChatGPT supplies downloadable clips **no longer than 13 seconds**, with
  a companion analysis prompt.
- Claude says it watched a clip only when the clip itself was received and opened. Written observations from ChatGPT are
  recorded as written observations, with their limits. Claude never describes footage it has not received.

## Steps for each video-derived issue

1. Add a row to the Video Review record (`docs/CHE_VIDEO_REVIEW.md`): video reference, timestamp, evidence type,
   observed behaviour, expected behaviour, outcome type (1–4), and status `open`.
2. Inspect the repository before proposing anything: existing code, `docs/CHE_WORK_QUEUE.md`, and open PRs.
3. Record the root cause only once it is verified from code, logs or a test. Until then it is `unverified`.
4. Implement the smallest fix or feature end to end, with regression tests and, where the behaviour only shows on a
   device, a device or staging test.
5. Open a PR with the evidence. Fix failing checks. **Merge only when the required checks pass and the owner has
   authorised the merge.**
6. Record the PR, commit SHA, test output, deploy evidence and blockers in the Video Review record and in the work queue
   (`docs/CHE_WORK_QUEUE.md`, one row per item; never a duplicate row).
7. Mark `verified` or `done` only with receipts. The check in `tools/video_review_check.mjs` refuses any row marked
   `verified` or `done` without a PR or commit and receipts.

## Limits, always

- Never claim to have inspected footage, run a test, merged, or deployed without the evidence. Say what is unverified.
- No paid services, unauthorised uploads, live trades, or permission or security changes without the owner's approval.
- Keep CHE's safety rules and approval requirements as they are (`AGENTS.md`).
- The loop is session-driven. Nothing runs on a timer; the owner's messages and the project status (`docs/CHE_PROJECT_STATUS.md`)
  decide what happens next.

## Where the loop's records live

- Video Review record: `docs/CHE_VIDEO_REVIEW.md` (added by PR #739; until that merges, the record is on that PR's branch).
- Work queue: `docs/CHE_WORK_QUEUE.md`.
- Project snapshot and history: `docs/CHE_PROJECT_STATUS.md` and `docs/CHE_PROJECT_HISTORY.md`.
- Session routine and owner commands: `CLAUDE.md`.
