# Failure inventory: voice routing, navigation and accessibility, deploy/CI/disk/IPA/Shorebird, agent coordination, iPhone version truth

Reliability lane `lane/rel-infra-app`, 2026-10-25. Base: `main` `afb8de1` (PR #524). Sources: `mailbox/briefs/LIVE-HANDOFF.md` and `mailbox/*.jsonl` on `che-mailbox`, `git log` on main, `docs/CHE_READINESS.md`, `docs/CHE_A11Y_AUDIT.md`, the tests named below, and replays run in this lane through the real `/api/chat` (offline, fake model). A row is **FIXED** only when a commit and a passing test back it; a handoff or mailbox claim with no test is marked as such.

| Status | Meaning |
|---|---|
| **FIXED** | A commit fixed it and a named test covers it (passing on this branch). |
| **REGRESSION** | It was fixed once and came back. |
| **PARTIAL** | Part fixed; what remains is named. |
| **BLOCKED** | Needs the owner or a third party; the blocker is named. |
| **UNVERIFIED** | Fixed in code, or never reproduced, but not proven where it matters (usually the owner's iPhone). |

## Counts

| | FIXED | REGRESSION | PARTIAL | BLOCKED | UNVERIFIED | Total |
|---|---|---|---|---|---|---|
| Voice routing | 11 | 0 | 1 | 0 | 0 | 12 |
| Voice engine and native voice | 2 | 0 | 1 | 0 | 3 | 6 |
| Navigation and accessibility | 2 | 0 | 1 | 0 | 1 | 4 |
| Deploy, CI, disk, IPA, Shorebird | 5 | 0 | 2 | 3 | 1 | 11 |
| Agent coordination | 2 | 0 | 1 | 0 | 1 | 4 |
| iPhone version truth | 4 | 0 | 0 | 0 | 1 | 5 |
| **All** | **26** | **0** | **6** | **3** | **7** | **42** |

No REGRESSION was found. The closest case, R6, was a fix on the Worker only: the phone still sent no build report, so the owner heard "unavailable" (L1). It counts as FIXED now that both sides read one shared phrase fixture.

## Fixed in this lane (root cause, test, commit)

| # | Failure | Root cause | Fix and test | Commit |
|---|---|---|---|---|
| L1 | "Is the new build installed on my phone?", "Did the update go through?", "What's on my iPhone right now?": CHE answered "installed version unavailable" | The Worker routed them to `che_runtime_status` (`server/cloudflare/self_update.js` `appStatusIntent`), but the phone's `cheIsAppStatusRequest` (`lib/self_update/che_self_update_intent.dart`) did not match them, so `lib/home_state/streaming.dart:280` never attached the native build report | Phone mirrors the Worker's install phrasings; one fixture both sides read: `test/fixtures/app_status_phrases.json`. Tests: `test/che_app_status_test.dart` "every install or version phrase the Worker answers carries the phone build report" (failed first), `server/cloudflare/version_truth.test.mjs` | `cefb749` |
| L2 | The phone sends its Shorebird patch number; the Worker always said "This does not identify a Shorebird patch" | `appStatusReport` ignored `client.patch` | Patch reported when read (`none` or a number), never guessed. `version_truth.test.mjs` | `cefb749` |
| L3 | A phone on an old release (handoff: 1.4.1025342820 vs newest 1.4.1025652491) was never told it was behind, nor that a Shorebird patch for another release cannot reach it | No comparison of the installed build with the newest verified IPA | `appStatusReport` compares installed vs `mobile_update.js` `latestVerifiedRelease` (current / behind / ahead / unknown) and the release commit vs the backend commit; `release_status.mjs --installed VERSION+BUILD` does the same from the terminal. Tests: `version_truth.test.mjs` (7, incl. `/api/chat`, 0 model calls), `.claude/skills/tests/skills.test.mjs` "che-release --installed" | `cefb749`, `b6fb794` |
| L4 | "what is the coding job doing", "where is the coding job at" went to the model, which has no job record | `server/cloudflare/code_scout.js` `codingHistoryIntent` had no "what is <job> doing / where is <job>" anchor (`questionEnd`) | Anchor added. `server/cloudflare/voice_command_routing.test.mjs` "voice and typed forms reach che_coding_history" | `8d49330` |
| L5 | "chay whats on my iphone right now", "whats the backend version" went to the model | Speech recognition drops the apostrophe; `appStatusIntent` (self_update.js:696-697) and the phone's copy only accepted `what's` / `what is` | `what(?:'?s| is)` on both sides; ASR forms added to the shared fixture. `voice_command_routing.test.mjs`, `che_app_status_test.dart` | `8d49330` |
| L6 | "whats on my screen" went to the Worker instead of the on-device screen description | Same apostrophe gap in `lib/che_ui/che_screen_awareness.dart` `cheAsksAboutScreen` | `test/che_voice_route_order_test.dart` | `8d49330` |
| L7 | CHE's own reply tells the owner "say save my password for, then the site" (`lib/home_state/send.dart`, secret-scan reply), but that sentence matched no parser and went to the Worker as ordinary chat | `lib/security/che_password_vault.dart` `CheVaultCommand.parse` only knew "save my <site> password <pw>" | Parser takes "save my password for <site> [as <pw>]" (asks for the password when missing) and "read my password for <site>"; send.dart gains an additive `ask_password` case. Nothing leaves the phone. `che_voice_route_order_test.dart` | `8d49330` |
| L8 | Commits on a detached-HEAD worktree and stashes were invisible to the preflight; five lanes were lost from `.claude/worktrees` on 2026-10-25 | `preflight.mjs` scanned only `refs/heads` and uncommitted files | Detached-HEAD worktree commits and stashes reported as local-only work (exit 4). `skills.test.mjs` "che-recover preflight" | `a868aa7` |

## Voice routing

| # | Failure | Evidence | Status | Test |
|---|---|---|---|---|
| R1 | Spoken status forms without punctuation/apostrophes misrouted | L5, L6 | FIXED | `voice_command_routing.test.mjs`, `che_voice_route_order_test.dart` |
| R2 | "what is the coding job doing" answered by the model | L4 | FIXED | `voice_command_routing.test.mjs` |
| R3 | "save my password for X" (CHE's own suggested phrase) sent to the Worker | L7 | FIXED | `che_voice_route_order_test.dart` |
| R4 | "Is the MNQ data live?" / "Is the crypto feed live?" answered as a Worker deployment check | `docs/CHE_READINESS.md` bug 3; fixed on main 2026-10-25 | FIXED | `e2e_owner_status_phrases.test.mjs` |
| R5 | Same phrases now reach the model instead of a deterministic feed-freshness answer (the truth guard keeps the model's "live" claim out) | Replay in this lane: route=model, 1-3 model calls, web research attempted for "is the crypto feed live" | PARTIAL (trading lane owns the route) | `voice_command_routing.test.mjs` 2 `todo` tests |
| R6 | Install/update phrasings fell through to the model (CHE_READINESS gap 10) | Worker fix on main; phone side was missing (L1) | FIXED | `e2e_owner_status_phrases.test.mjs`, `version_truth.test.mjs`, `che_app_status_test.dart` |
| R7 | The single follow-up word "Collectively" came back as only "Stopped." (ChatGPT live iPhone report, 2026-10-22) | `0049056` (#472) | FIXED | `command_center.test.mjs` "Collectively is an ordinary follow-up" |
| R8 | "Disable/Enable the 86 model" not routed to the strategy controls | `584d6bb` (#501) | FIXED | `p2p86_model.test.mjs` |
| R9 | Commit questions answered with the deployment status | `bb0f557` (#485) | FIXED | `deploy_receipt.test.mjs`, `app_status.test.mjs` |
| R10 | Existing actions routed into self-development | `4001b2d` | FIXED | `code_scout.test.mjs`, `command_center.test.mjs` |
| R11 | Engineering prompts that mention "clear the chat" cleared the visible chat | `lib/home/screen_command.dart` | FIXED | `test/screen_command_test.dart` "engineering instructions never act on the visible conversation" |
| R12 | Invention requests hijacked trading turns | `0049056` (#472) | FIXED | `invention_chat.test.mjs` |

## Voice engine and native voice

| # | Failure | Evidence | Status | Test / what remains |
|---|---|---|---|---|
| V1 | A dead Porcupine wake-word listener left CHE deaf | `92296ed` (this lane, earlier session) | FIXED | `test/che_wake_word_test.dart` |
| V2 | Unsolicited speech on launch and passive screens (owner rule 2026-10-11) | AGENTS.md; code in `lib/che_voice_*` | FIXED in code; device UNVERIFIED | `che_voice_privacy_quiet_test.dart`, `che_voice_startup_guard_test.dart` |
| V3 | One reply switched between ElevenLabs and Fish mid-sentence (owner recording, handoff §8d) | Worker turn lock #338, ElevenLabs-only #426 | PARTIAL: native gapless clip queue (Swift in `tool/bootstrap.sh`) never built | `phone_voice.test.mjs`, `test/che_voice_turn_test.dart`; native queue: missing |
| V4 | Hands-free: no live transcript, long end-of-turn wait (handoff §8f) | Native partials merged in #524 (`afb8de1`, live transcript) | UNVERIFIED: needs the new full IPA on the phone | Dart side only; native behavior has no automated test |
| V5 | ElevenLabs "Out of credits" on the owner's phone (2026-10-22 screenshot) | Handoff §8g; deploy probe 2026-10-25 returned 52,287 bytes in 625 ms | UNVERIFIED on the device (the Worker probe passes) | deploy probe in `che-worker-deploy.yml` |
| V6 | Wake word behavior on the device | Handoff dashboard: "wake word UNKNOWN on device" | UNVERIFIED | `che_wake_match_test.dart`, `che_wake_word_test.dart` (logic only) |

## Navigation and accessibility

| # | Failure | Evidence | Status | Test |
|---|---|---|---|---|
| N1 | Overflows on 19 screens across 6 viewports and text scale 1.3; targets under 44 pt | `324cc49` (#498) | FIXED | `che_responsive_layout_test.dart`, `che_chat_responsive_guard_test.dart` |
| N2 | Home header overflowed; VoiceOver labels merged into one node | `c5b57d7` | FIXED | `che_responsive_layout_test.dart`, `che_icon_button_label_test.dart` |
| N3 | Opening Commands by voice waited behind a stalled voice clip | `lib/home_state/send.dart` `sendMessage` (early screen command) | UNVERIFIED: fixed in code, no test | missing (no test drives a stalled clip) |
| N4 | 15 GestureDetector/InkWell controls without a VoiceOver label | `docs/CHE_A11Y_AUDIT.md` | PARTIAL: ratchet stops new ones; the 15 remain | `test/e2e_a11y_tap_targets_test.dart` (ratchet) |

## Deploy, CI, disk, IPA, Shorebird

| # | Failure | Evidence | Status | Test / blocker |
|---|---|---|---|---|
| D1 | Full disk, then a replaced container: lanes brain-visual, studio-engine, studio-tutorials, creation-gaps, reliability lost (never pushed) | Handoff §2, 2026-10-25 02:30 | FIXED (prevention): preflight + AGENTS.md push rule; detached/stash gap closed by L8. Lanes rebuilt | `skills.test.mjs` "che-recover preflight" |
| D2 | Flagstaff wake ran on pushes with no new mailbox line; Autopilot looped on `check_run` | `5e2b9d9` | FIXED | `tool/test_workflow_triggers.py` |
| D3 | Command Center e2e counts hard-coded, broke CI when commands were added | `5272c59` (#483) | FIXED | `command_center.test.mjs` (fixture), `test/che_command_center_e2e_test.dart` |
| D4 | Coding-history wording broke the skills replay in CI | `4083400` | FIXED | `.claude/skills/tests/skills.test.mjs` replay cases |
| D5 | Edge returned 403 (error 1010) to the creation worker's Python-urllib User-Agent | Handoff, Codex 2026-10-24; fixed in #523 | FIXED | `tools/test_che_gpu_worker.py` |
| D6 | Office golden image 0.9% different locally vs CI | `cf48aa2` | PARTIAL: CI fixed; local platform drift remains | `test/*golden*` (Linux CI is gating) |
| D7 | Shorebird patches target releases the phone does not run (Patch 12 → 1.4.1025573394; Patch 1 → 1.4.1025652491; phone 1.4.1025342820) | Handoff §2 and Codex checkpoint | BLOCKED: the owner must sideload the new IPA; CHE now says so (L3) | `version_truth.test.mjs` (detection) |
| D8 | Public IPA release workflow `che-ipa-release.yml` is `disabled_manually` | GitHub API (Codex 2026-10-24, CHE_READINESS) | BLOCKED: owner's publishing authorization | `release_status.mjs` reports it |
| D9 | `Workers Builds: chey-app` check fails on every PR branch | `release_status.mjs` NON_GATING comment (owner, 2026-10-08) | BLOCKED: Cloudflare dashboard setting, owner | `skills.test.mjs` "non-gating" |
| D10 | Bundled assets (studio.html, GLBs) need a full IPA; a Shorebird patch silently excludes them | Shorebird CLI warning, run 40135088615 | PARTIAL: documented in the release checklist; no automated guard warns when a Dart-only patch carries asset changes | `docs/CHE_READINESS.md` §4; missing |
| D11 | Local Windows suites fail on paths and goldens | Codex 2026-10-24 | UNVERIFIED (Linux CI is the gate) | n/a |

## Agent coordination

| # | Failure | Evidence | Status | Test |
|---|---|---|---|---|
| A1 | Parallel Flagstaff model calls from one mailbox push failed on the first try | `worker.js` `serializeFlagstaffModel` comment | FIXED | `worker.test.mjs` "Flagstaff model calls run one at a time, so a batch cannot fail together" |
| A2 | A wake push and the mailbox alarm both answered the same message | `worker.js` `replyToFlagstaffMessage` | FIXED | `worker.test.mjs` "Flagstaff duplicate deliveries at the same moment share one peer reply", `worker_autonomy.test.mjs` "the same new packet delivered twice is answered once" |
| A3 | CHE answered Claude's last three mailbox messages with "I couldn't finish a checked answer after several tries" (2026-10-24 23:53, 10-25 00:08, 02:22) | `mailbox/claude.jsonl` on che-mailbox; the text is the terminal `failed` receipt in `worker.js` `replyToFlagstaffMessageOnce` | UNVERIFIED: root cause not reproduced offline (needs the live reply log: model failures vs truth-guard rejections) | missing |
| A4 | "What is Claude currently working on?" answered "Nothing is running" from CHE's own job list (owner live test 2026-10-25) | `lane/rel-trust` `ee33064` (WIP, not merged) | PARTIAL: fix exists on the trust lane only | trust lane's `coding_history` tests |

## iPhone version truth

| # | Failure | Evidence | Status | Test |
|---|---|---|---|---|
| I1 | Install questions answered "unavailable" | L1 | FIXED | `che_app_status_test.dart`, `version_truth.test.mjs` |
| I2 | Shorebird patch ignored | L2 | FIXED | `version_truth.test.mjs` |
| I3 | No "behind the newest build" answer | L3 | FIXED | `version_truth.test.mjs`, `skills.test.mjs` |
| I4 | A short /health tag was presented as a full SHA | `app_status.test.mjs` | FIXED | `app_status.test.mjs` "only a matching verified deployment lookup can expand a short tag" |
| I5 | Nothing after 2026-10-22 is shown to be on the phone (last device evidence: 1.4.1025342820, build 3956317271501, patch 9) | Handoff §8g | UNVERIFIED | owner device check (checklist row "backend vs installed iPhone version") |

## Tests added in this lane that found no defect

- `server/cloudflare/mission_checkpoint_recovery.test.mjs`: a mission step cut off on every attempt is dead-lettered at `MAX_JOB_ATTEMPTS`, the recovery ladder stops (`needs_replan`), step 1 is never re-run, no artifact is sealed, and "Mission status" says "1 of 2 steps done, 0 running, 1 failed". Passed on first run.
- `server/cloudflare/coding_resume_restart.test.mjs`: a pending OpenCode resume driven by fresh `CheState` instances: backoff kept across restarts, one dispatch of the same session, no duplicate dispatch or team job, clean claim. Passed on first run.
