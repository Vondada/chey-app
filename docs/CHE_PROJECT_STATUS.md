# CHE project status (continuity snapshot)

Read this first in every session, with `CLAUDE.md`. Each fact carries a state and a time:

- **verified**: checked this session against a receipt (git, a GitHub check run, a deploy run, a test output).
- **reported**: stated by an earlier session or by the owner, not re-checked here. Re-check before relying on it.
- **unknown**: not reachable from the session (for example, the live Worker's stored state). Never filled in by guessing.

Snapshot taken: **2026-10-31 ~18:10 UTC**, by Claude (session `251cdea8`); the full open-work list is
`docs/CHE_MASTER_COMPLETION_LEDGER.md`. Replace this file's facts when a checkpoint
changes them. Do not delete the old values: the change is recorded in `docs/CHE_PROJECT_HISTORY.md`.

## Latest verified main

| Fact | State | Time | Evidence |
|---|---|---|---|
| `main` is `2a93c35b` (#813) | verified | 2026-10-31 ~19:15 UTC | merge receipts |
| `main` is `566bd782` (#806, picture status and GPU health) | reported (superseded above) | 2026-10-31 ~18:05 UTC | `git fetch origin main` |
| `main` is `064a7bb1` (#759, Modal deploy diagnostics) | reported (superseded above) | 2026-10-28 ~20:20 UTC | `git fetch origin main`; GitHub `main` commit |
| `main` is `74760ee3` (M2a scene document, #731) | reported (superseded above) | 2026-10-28 ~03:40 UTC | earlier snapshot, kept for the record |

## Latest deployment

| Fact | State | Time | Evidence |
|---|---|---|---|
| Worker deploy of `845e4128` (#808; includes #804, #805, #807) succeeded; live commit check passed; live probes (memory truth, Command Center, Modal /health, history, Knowledge Atlas, Private Mode, code-switching, study, voice) passed | verified | 2026-10-31 17:58 UTC | deploy run `41226375003` |
| Full 600 certification, fresh, on `9cd42792`: 415 pass, 185 fail, 0 blocked | verified | 2026-11-01 00:36 UTC | run `41256280478` |
| Worker deploy of `9cd42792` (#822; includes #818, #820, #821) succeeded, live commit checked | verified | 2026-11-01 00:02 UTC | deploy run `41254400451` |
| Full 600 certification, fresh, on `fd757ec5`: 420 pass, 180 fail, 0 blocked | verified | 2026-10-31 21:30 UTC | run `41242161747` |
| Full 600 certification, fresh, on `2a93c35b`: 413 pass, 187 fail, 0 blocked | verified | 2026-10-31 19:34 UTC | run `41233462389` |
| Worker deploy of `2a93c35b` (#813) succeeded, live commit checked | verified | 2026-10-31 19:14 UTC | deploy run `41232517948` |
| Full 600 certification, fresh (no resume), on `1a9b414d`: 399 pass, 201 fail, 0 blocked | verified | 2026-10-31 17:35 UTC | run `41222062110`; causes in the master ledger |
| Worker deploy of `82bcdddc` (#758, includes #756) succeeded | reported (superseded above) | 2026-10-28 20:09 UTC | deploy run `40760792805` (success) |
| Modal app deploy of `064a7bb1` succeeded; GPU test skipped | verified | 2026-10-28 ~20:20 UTC | `CHE Modal deploy` run `40762484097`; its authenticated /health check passed (app `che-gpu`, a version) |
| Modal model revision in code is `71153311…` (sdxl-turbo) | verified in code | 2026-10-28 | `tools/modal/txt2img.py`; pinned from run `40745995951` |
| Worker deploy of `74760ee3` succeeded | reported (superseded above) | 2026-10-28 ~03:00 UTC | deploy run `40616639438` (success) |
| Live commit check: `74760ee3` is the live Worker | verified | same | deploy job "live commit check: VERIFIED"; Worker version `5b89270f-7fa7-4cba-b37f-bbed1b4506b3` |
| Live memory, voice and command-center probes passed | verified | same | the same deploy run's live probes |
| Flutter client on the live iPhone build | unknown | — | only the owner's device can confirm installed behaviour |

## Open pull requests

| PR | Title (short) | State | Time |
|---|---|---|---|
| #818 | Coinbase 429 retry for backtests | checks running | 2026-10-31 ~21:40 UTC |

#809-#817 merged on 2026-10-31; see the master ledger.

## Current CI

- verified 2026-10-31 ~18:05 UTC: `main` checks green on the merged PRs (#804-#808); no red check on `main`.
- Earlier note (2026-10-28): the staging gate was red on a Wikipedia 503; #738 fixed it and was merged.

## Active coding jobs

| Fact | State | Time | Evidence |
|---|---|---|---|
| Coding autonomy is paused | reported | owner, 2026-10-28 | owner's message; the flag is `data.autonomy` in the live Worker |
| Job `563823dd` exists and can run | unknown | — | the live Worker's stored state is not readable from a session |
| Resume mechanism | verified (code) | — | the owner's chat words "resume" or "stand by" (after the "CHE," prefix) call `setAutonomy` (`server/cloudflare/worker.js`) |

## Current blockers

Owner accounts and decisions (each listed once in `docs/CHE_MASTER_COMPLETION_LEDGER.md`):
1. Google sign-in expired (live 401): reconnect Google on the Connections page.
2. Smart home, Twilio texts, YouTube channel, Tradovate: not connected.
3. Spend caps for live evals and GPU upgrades (Q-09, Q-35) are $0 until the owner approves.
4. Trading: new automated paper entries stay paused until the cost-vs-R audit; it needs the live journal, not readable
   from a session.
5. Device: nothing after the 2026-10-21 IPA is verified on the iPhone.
6. Review: the picture made for certification question ivg-40 (a real politician, compromising) is still in the
   Gallery; deleting it needs the owner's yes. spt-43's masked reply should be checked in run `41222062110`'s artifact.

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
