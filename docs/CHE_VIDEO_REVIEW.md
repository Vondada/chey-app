# CHE video-to-implementation workflow (owner, 2026-10-28)

The owner sends ChatGPT screen recordings of bugs, blocked workflows, Claude's progress and examples of features CHE should
reproduce. ChatGPT watches them and writes evidence-based implementation instructions. Claude turns each instruction into a
development task. This file is the standing process and the record of every video-derived task.

## What counts as having watched a video

Claude reports a video as watched only when its contents were received and inspected. In practice that means one of:
- the clip itself was supplied to the session and opened, or
- ChatGPT's written observations were supplied, and each claim is labelled with its source ("ChatGPT, written observation").

Written observations are evidence with limits: they are not frame-by-frame proof. Every task notes which kind of evidence it used.

## The steps for every video-derived task

1. **Observed problem or wanted behaviour**, with the video reference and timestamp.
2. **Inspect the repository first.** Search the existing code, the work queue (`docs/CHE_WORK_QUEUE.md`) and open PRs before
   proposing anything. Decide: already exists, partly built, or missing.
3. **Relevant files, services, dependencies and runtime blockers**, named from the code, not guessed.
4. **Smallest reliable end-to-end fix or feature**, with the owner's safety rules kept (paid spending, live trading and
   deletions need the owner's yes).
5. **Regression tests**, and a device or staging test where the behaviour is only visible on a device.
6. **A PR** with the evidence, the tests run and the commit SHA.
7. **Fix failing checks. Merge only when the required checks pass** and the owner has authorised the merge.
8. **Report separately**: implemented, tested, deployed, verified. Code written is not "verified".
9. **Keep unfinished work in the work queue** (one row per item, no duplicates).

## The Video Review record

Each video-derived task has one row in the table below. Columns:

- `id`: `VR-` and a number, in order.
- `video`: the reference the owner or ChatGPT gave (file name, link or message time).
- `timestamp`: the time in the video, or `n/a` for written observations.
- `evidence`: `clip inspected`, `ChatGPT written observation` or `owner description`.
- `observed`: what happened or what the owner wants to see.
- `expected`: the behaviour that should happen.
- `root_cause`: only once verified from code, logs or a test; otherwise `unverified`.
- `files`: the relevant repository paths.
- `status`: one of `open`, `in progress`, `built, not verified`, `verified`, `done`, `blocked`.
- `pr_commit`: PR number and commit SHA.
- `receipts`: test output, CI result or deploy evidence. Required for `verified` and `done`.
- `blockers`: what still stops it.

Rules the checker (`tools/video_review_check.mjs`) enforces: every row has all columns, the status is one of the values above,
and a `verified` or `done` row has receipts and a PR or commit.

| id | video | timestamp | evidence | observed | expected | root_cause | files | status | pr_commit | receipts | blockers |
|---|---|---|---|---|---|---|---|---|---|---|---|
