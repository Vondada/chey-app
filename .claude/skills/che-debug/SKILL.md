---
name: che-debug
description: Reproduce and fix a CHE defect with a narrow, tested change. Use when the owner reports a bug or sends a screenshot of a wrong CHE reply or broken screen, when a test or CI check fails, or when CHE's behavior differs from AGENTS.md. Replays the owner's exact chat turns through the real /api/chat locally (no network, fake model), points to the files that own the behavior, and runs only the checks CI runs for what changed.
---

# CHE debug

Order: **reproduce → locate → fix narrowly → prove → review.** Do not edit before the defect is reproduced.

## 1. Reproduce
- **Chat or Worker behavior:** put the owner's exact words in a case file and replay them through the real route:
  `node .claude/skills/che-debug/scripts/replay_chat.mjs case.json`
  - Each turn prints the route (`done.source`, or `model` when the language model answered), the model calls, the time and the reply the owner would see.
  - Add `expect` to a turn, and the replay becomes a pass/fail check (exit 1 on a miss).
  - The case format, including how to seed a screenshot's earlier turns as `history`, is in `reference/replay-format.md`.
  - Ready examples: `.claude/skills/che-fact-check/cases/*.json`.
- **Flutter:** write a failing test under `test/` that uses the owner's exact words.
- It counts as reproduced only when the output shows the wrong behavior. Keep the case: it becomes the regression test.

## 2. Locate
- Search for the route name from the replay, or for a phrase from the bad reply: `rg -n "che_evidence_receipt" server/cloudflare lib`.
- Where things live and what never to break: `reference/code-map.md`.
- Before editing a file, check the open PRs for overlapping files. Use `.claude/skills/che-release/scripts/release_status.mjs --pr N` or the GitHub PR file list.

## 3. Fix
- Make the smallest change, in the module that owns the behavior. Extend existing systems; never add a parallel router, memory store, planner or registry.
- Fix the mechanism, not the screenshot. A special case for one sentence breaks the next phrasing (see che-fact-check's lessons).
- Keep voice and typing parity, owner-device vs guest gates, and the money/delete holds.

## 4. Prove
- Turn the replay into a test in the owning `*.test.mjs`, through `/api/chat`; `server/cloudflare/memory_truth.test.mjs` has an `owner()` helper to copy. Then re-run the replay and show the corrected output.
- `bash .claude/skills/che-debug/scripts/run_checks.sh` runs exactly the checks CI runs for the changed paths (Worker syntax and tests, skills tests, Dart analyze/test, tools, workflow scripts). It prints failures with their diagnostics, and one line per passing check.
- When `flutter` is not on PATH, the script says Flutter was NOT RUN. Report that; never call it verified.

## 5. Review
- Re-read the diff as a reviewer would:
  - Could ordinary owner sentences trip the new rule?
  - Does it hold for guests?
  - Does a failure path report honestly?
- The PR body says what changed, how it was verified, and what was **not** verified (the iPhone, production).

## Measured (2026-10-14; add new measurements with date and method)
- **Full Worker suite (976 tests):** raw TAP output is 290,737 bytes (≈72k tokens). Through `run_checks.sh` the passing run prints one 21-byte line. Failures print with up to 14 diagnostic lines each.
- **Reproducing the owner's 12:34 screenshots, the same day:** before this skill it took three throwaway harness scripts (6,716 bytes of model-written code). With it, a 2,280-byte case file that stays as a regression check, one command, and 1,281 bytes of output.
