# CHE project status (continuity snapshot)

Read this first in every session, with `CLAUDE.md`. Each fact carries a state and a time:

- **verified**: checked this session against a receipt (git, a GitHub check run, a deploy run, a test output).
- **reported**: stated by an earlier session or by the owner, not re-checked here. Re-check before relying on it.
- **unknown**: not reachable from the session (for example, the live Worker's stored state). Never filled in by guessing.

Snapshot taken: **2026-10-28 ~03:40 UTC**, by Claude (session `251cdea8`). Replace this file's facts when a checkpoint
changes them. Do not delete the old values: the change is recorded in `docs/CHE_PROJECT_HISTORY.md`.

## Latest verified main

| Fact | State | Time | Evidence |
|---|---|---|---|
| `main` is `74760ee3` (M2a scene document, #731) | verified | 2026-10-28 ~03:40 UTC | `git fetch origin main`; GitHub `main` commit |

## Latest deployment

| Fact | State | Time | Evidence |
|---|---|---|---|
| Worker deploy of `74760ee3` succeeded | verified | 2026-10-28 ~03:00 UTC | deploy run `40616639438` (success) |
| Live commit check: `74760ee3` is the live Worker | verified | same | deploy job "live commit check: VERIFIED"; Worker version `5b89270f-7fa7-4cba-b37f-bbed1b4506b3` |
| Live memory, voice and command-center probes passed | verified | same | the same deploy run's live probes |
| Flutter client on the live iPhone build | unknown | — | only the owner's device can confirm installed behaviour |

## Open pull requests

| PR | Title (short) | Head | Checks | State | Time |
|---|---|---|---|---|---|
| #739 | Video-to-implementation workflow | `feat/video-review-workflow` `7b82db5d` | pending | verified (list), checks in progress | 03:37 UTC |
| #738 | Wikipedia 503 retry (unblocks staging) | `fix/wikipedia-retry` `ad616d21` | pending | verified (list), checks in progress | 03:37 UTC |
| #737 | Arithmetic computed; save-command routing | `fix/relevance-and-command-intent` `da353443` | non-staging green; `live (staging)` red (study probe, Wikipedia 503) | verified | 03:00 UTC |
| #736 | Chat reliability: named error, partial text kept | `fix/chat-reply-reliability` `30c68a17` | `live (staging)` red (study probe, Wikipedia 503) | verified | 03:00 UTC |
| #735 | Create Studio navigation and live probe | `build/m2d-scene-live-probe` `752619f2` | not checked this session | unknown | — |
| #734 | M2c Create Studio editor | `build/m2c-create-studio-screen` `2afb2942` | not checked this session | unknown | — |
| #733 | M2b persistent scenes | `build/m2b-scene-persistence` `8f1d54f7` | `live (staging)` red (study probe) | verified | 02:40 UTC |
| #727–#732 | Docs: free 3D tools, creation engine audit, Create Studio requirements | docs branches | not checked this session | unknown | — |

## Current CI

- verified: the `live (staging)` gate is red on #733, #736 and #737. The cause in each recorded log is the study probe's Wikipedia
  checks, after Wikipedia returned HTTP 503. Verified in the logs of runs `40616814157`, `40621739146`, `40623541767`.
- #738 is the change meant to clear that gate. Its checks were in progress at snapshot time. Result: unknown until re-checked.

## Active coding jobs

| Fact | State | Time | Evidence |
|---|---|---|---|
| Coding autonomy is paused | reported | owner, 2026-10-28 | owner's message; the flag is `data.autonomy` in the live Worker |
| Job `563823dd` exists and can run | unknown | — | the live Worker's stored state is not readable from a session |
| Resume mechanism | verified (code) | — | the owner's chat words "resume" or "stand by" (after the "CHE," prefix) call `setAutonomy` (`server/cloudflare/worker.js`) |

## Current blockers

1. Staging gate red on the study probe (Wikipedia 503). #738 is the fix; it is not yet merged or re-verified.
2. verified: #736 and #737 cannot merge until #738 is in and `main` is merged back into them.
3. reported: coding autonomy is paused; the flag and job state can only be read from the owner's device or the live Worker.
4. Trading: new automated paper entries are to be paused until a verified audit. The live market feed, journal and trade
   records are unknown from a session. No audit has been completed.
5. verified: the Video workflow (#739) is not merged yet; the Video Review record and loop depend on it.

## Owner priorities

1. Reliability: 12 × 17 = 204 answered correctly; unrelated follow-ups not contaminated; coding instructions not saved
   as library documents; autonomy status reported honestly.
2. Coding autonomy restored only if safe and authorised.
3. Trading intelligence: verified feed, real journal, safeguards, learning loop. No live trades. No new automated paper
   entries until the audit is verified.
4. Video-to-implementation loop (`docs/CHE_VIDEO_REVIEW_LOOP.md`).

## Next authorised actions

| Action | Authority | Status |
|---|---|---|
| Merge #738 once its required checks are green | reported: owner, 2026-10-28 ("merge only when green") | ready to check |
| Merge `main` into #736 and #737, re-run, merge when green | reported: same owner rule | waiting on #738 |
| Verify the deployed CHE on 12 × 17, follow-ups, library and autonomy status | reported: owner, 2026-10-28 | waiting on the deploy after the merges |
| Merge #739 and this continuity PR once green | reported: owner's standing rule for PRs | ready to check |
| Resume coding autonomy | reported: the owner must say "CHE, resume" from the device, or confirm in writing | not authorised for a session to do |
| Trading entries | reported: owner asked to pause automated entries; no live trades | pause not verified |

## Stop conditions

Stop and ask the owner before: a paid service or spend, a live trade, a deletion, a permission or security change, an
upload to a public place, or a merge of anything not green.
