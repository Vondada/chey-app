# CHE regression checklist

One checklist for every area. Each row is a scenario the owner depends on, the test that proves it and how to run that test. "missing" means no automated test covers it yet; those rows say what would. Run the rows for the area you touched before you ask for a merge; run the end-to-end block before every release. Every row is offline (fake model, no network) unless it says otherwise.

Started 2026-10-25 by the reliability lanes. Failures behind these rows: `docs/failure_inventory/*.md`. Release steps: `.claude/skills/che-release/SKILL.md` and the release-readiness checklist in `docs/CHE_READINESS.md`.

## How to run

| Kind | Command (from the repo root) |
|---|---|
| Worker test file | `node --test server/cloudflare/<file>.test.mjs` |
| Whole Worker suite | `node --test server/cloudflare/*.test.mjs` (≈4,000 tests, ~3 min) |
| Flutter test file | `flutter test test/<file>_test.dart` |
| Flutter analysis | `dart analyze --fatal-infos lib test` |
| Skills (release, recovery, replay) | `node --test .claude/skills/tests/skills.test.mjs` |
| Python tool tests | `python3 -m unittest discover -s tool -p '<file>.py'` (or `-s tools`) |
| Only what CI runs for your change | `bash .claude/skills/che-debug/scripts/run_checks.sh` |
| A test on another lane before it merges | `git worktree add /tmp/lane origin/<lane>` then run the command inside `/tmp/lane`. Read only: `git show origin/<lane>:<path>` |

"lane/rel-trust" and "lane/rel-markets-studio" rows name tests on those branches; after those lanes merge the path is the same on main.

## End to end (run before every release)

| # | Scenario | Test (file: name) | Run |
|---|---|---|---|
| E1 | **Memory after restart:** the owner saves a fact, CHE restarts, recall cites the same record id and provenance | `server/cloudflare/e2e_memory_restart.test.mjs`: "e2e memory: save → durable record → restart → recall cites the same record id and its provenance"; `personal_recall_chat.test.mjs`: "after an app restart the corrected fact is what comes back…". Trust-lane changes to recall (`lane/rel-trust` `ee33064`: verified save receipt, multi-favorite recall) carry no new test file yet | `node --test server/cloudflare/e2e_memory_restart.test.mjs server/cloudflare/personal_recall_chat.test.mjs` |
| E2 | **Correction, latest wins:** "No, strawberry Sprite" replaces the old answer, keeps the history, and survives a restart | `memory_truth.test.mjs`: "E: an owner correction replaces the old answer and keeps the history", "memory retrieval 3: conflicting confirmed preferences resolve to the newest, and the conflict is named"; `personal_recall_chat.test.mjs`: "recording, spoken variants: … are the same correction" | `node --test server/cloudflare/memory_truth.test.mjs server/cloudflare/personal_recall_chat.test.mjs` |
| E3 | **Coding job resume:** a capacity-blocked coding session waits its backoff, resumes the same session from its verified checkpoint, never twice, across Worker restarts | `coding_resume.test.mjs` (7 tests); `coding_resume_restart.test.mjs`: "a pending coding resume survives restarts…"; `tools/che_coding_checkpoint.test.mjs`: "resume: a fresh checkout of the same base restores the verified checkpoint" | `node --test server/cloudflare/coding_resume.test.mjs server/cloudflare/coding_resume_restart.test.mjs tools/che_coding_checkpoint.test.mjs` |
| E4 | **Voice command routing:** owner phrases, typed and as speech recognition delivers them (lowercase, no punctuation, "chay …"), reach the right route with no model call; ordinary chat still reaches the model | `voice_command_routing.test.mjs` (10 routes + negatives; 2 `todo`: "is the mnq data live" still reaches the model, trading lane); `test/che_voice_route_order_test.dart` (phone parser order); `command_center.test.mjs`: "3. a slash command and its plain-English request reach the same handler" | `node --test server/cloudflare/voice_command_routing.test.mjs server/cloudflare/command_center.test.mjs` and `flutter test test/che_voice_route_order_test.dart` |
| E5 | **Crypto events → candles:** exchange WebSocket messages (Coinbase, Kraken, documentation-shaped) become trades, 1m/5m candles, merge over REST history and set the LIVE/STALE line | `lane/rel-markets-studio`: `test/che_crypto_docs_e2e_test.dart`: "e2e (offline): Coinbase doc-shaped messages → trades → 1m/5m candles → merged over REST → LIVE line", "e2e (offline): Kraken v2 doc-shaped messages …"; main: `test/che_crypto_stream_test.dart` | `flutter test test/che_crypto_stream_test.dart test/che_crypto_docs_e2e_test.dart` (second file on that lane) |
| E6 | **Replay without lookahead:** the trade replay at a cursor shows no bar after the cursor; the backtest's past trades do not change when future bars arrive | `e2e_trading_journal.test.mjs`: "e2e trading: journal → trade evidence → replay show the recorded entry, exit and the hand-computed P&L" (asserts "no bar after the cursor is shown"); `trading_lab.test.mjs`: "backtest has no look-ahead: future bars do not change past trades" | `node --test server/cloudflare/e2e_trading_journal.test.mjs server/cloudflare/trading_lab.test.mjs` |
| E7 | **Media artifact reopen:** a saved PNG, CHE's GLB and an MP4 reopen after a restart by id, with the same SHA-256, and decode | `lane/rel-markets-studio`: `server/cloudflare/e2e_media_artifacts.test.mjs` (3 tests: PNG, GLB, MP4); main: `media_retrieval.test.mjs` | `node --test server/cloudflare/e2e_media_artifacts.test.mjs server/cloudflare/media_retrieval.test.mjs` (first file on that lane) |
| E8 | **Mission checkpoint recovery:** a workflow started by voice is checkpointed in DO storage, survives an eviction mid-step and a restart, resumes without redoing step 1, seals a verified artifact; a step cut off every time is bounded and reported failed, never done | `mission_engine_proof.test.mjs`: "one persistent mission: chat start → DO checkpoints → eviction mid-step → restart → alarm resumes → verified artifact → shown on reopen"; `mission_checkpoint_recovery.test.mjs`: "a mission step that is cut off on every attempt is bounded, failed (never done)…" | `node --test server/cloudflare/mission_engine_proof.test.mjs server/cloudflare/mission_checkpoint_recovery.test.mjs` |
| E9 | **Backend vs installed iPhone version:** "Is the new build installed on my phone?" carries the phone's own build and patch; CHE compares it with the newest verified IPA and the backend commit, says "behind" when it is, and never substitutes a release listing for the phone | `version_truth.test.mjs` (7, incl. through `/api/chat` with 0 model calls); `test/che_app_status_test.dart` (shared fixture `test/fixtures/app_status_phrases.json`); `app_status.test.mjs`; `skills.test.mjs`: "che-release --installed …" | `node --test server/cloudflare/version_truth.test.mjs server/cloudflare/app_status.test.mjs`, `flutter test test/che_app_status_test.dart`, `node --test .claude/skills/tests/skills.test.mjs`. **Device step (owner):** ask "is the new build installed on my phone?" and compare the reply with the CHE Updates screen; from a terminal, `release_status.mjs --installed <version>+<build>` |

## Memory and truth

| Scenario | Test | Run |
|---|---|---|
| CHE never presents an unsupported memory as the owner's confirmation | `memory_truth.test.mjs` (A–E) | `node --test server/cloudflare/memory_truth.test.mjs` |
| Recall answers only the subject asked (no other vault's phrase) | `e2e_memory_restart.test.mjs`: "a different subject is not answered from a stored statement after a restart" | as E1 |
| Questions are never stored as facts | `personal_recall_chat.test.mjs` | as E1 |
| The live memory probe after a deploy | `che-worker-deploy.yml` step "memory truth" (live, owner's Worker) | `release_status.mjs --sha <merge sha>` |
| Replay cases of the owner's screenshots | `.claude/skills/che-fact-check/cases/*.json` | `node --test .claude/skills/tests/skills.test.mjs` |

## Coding, agents, workflows

| Scenario | Test | Run |
|---|---|---|
| Coding status, receipts and "last completed work" come from records, never invented | `e2e_coding_receipts.test.mjs`, `coding_history.test.mjs`, `coding_receipts.test.mjs` | `node --test server/cloudflare/e2e_coding_receipts.test.mjs server/cloudflare/coding_history.test.mjs` |
| Cancel a coding job by voice: no model, no approval, no delete hold | `command_center.test.mjs`: "/che-cancel-job and its spoken forms reach the coding-job cancel route…"; `coding_cancel.test.mjs` | `node --test server/cloudflare/command_center.test.mjs server/cloudflare/coding_cancel.test.mjs` |
| Objective graph: failures touch only their step, finished steps never re-run, replans bounded | `objective_graph.test.mjs` | `node --test server/cloudflare/objective_graph.test.mjs` |
| Command and workflow runs survive a restart | `command_center.test.mjs`: "11. command runs and workflow runs survive a restart" | as above |
| Flagstaff mailbox: duplicate deliveries share one reply; model calls run one at a time | `worker.test.mjs`: "Flagstaff duplicate deliveries at the same moment share one peer reply", "Flagstaff model calls run one at a time…"; `worker_autonomy.test.mjs`: "the same new packet delivered twice is answered once" | `node --test server/cloudflare/worker.test.mjs server/cloudflare/worker_autonomy.test.mjs` |
| CHE's mailbox replies to peers actually succeed (not "couldn't finish a checked answer") | missing (inventory A3: needs the live reply log to reproduce) | — |
| "What is Claude working on?" quotes that AI's mailbox report | `lane/rel-trust` `ee33064` (WIP); no test file on the lane yet | — |

## Voice and native

| Scenario | Test | Run |
|---|---|---|
| Wake word: a dead listener restarts; matching rules | `test/che_wake_word_test.dart`, `test/che_wake_match_test.dart` | `flutter test test/che_wake_word_test.dart test/che_wake_match_test.dart` |
| Silent on launch and passive screens; Read This still works | `test/che_voice_privacy_quiet_test.dart`, `test/che_voice_startup_guard_test.dart` | `flutter test test/che_voice_privacy_quiet_test.dart test/che_voice_startup_guard_test.dart` |
| One voice per reply (turn lock); ElevenLabs for conversation | `phone_voice.test.mjs`, `preferred_elevenlabs_voice.test.mjs`, `test/che_voice_turn_test.dart` | `node --test server/cloudflare/phone_voice.test.mjs` and `flutter test test/che_voice_turn_test.dart` |
| UI commands by voice ("dark mode", "volume down") and no false matches | `test/che_ui_voice_command_test.dart` | `flutter test test/che_ui_voice_command_test.dart` |
| Screen edits only on explicit requests | `test/screen_command_test.dart` | `flutter test test/screen_command_test.dart` |
| Password vault phrases stay on the phone, including "save my password for X" | `test/che_voice_route_order_test.dart`, `test/che_theater_vault_apps_test.dart` | `flutter test test/che_voice_route_order_test.dart test/che_theater_vault_apps_test.dart` |
| Live ElevenLabs voice through the deployed Worker | deploy step "ElevenLabs voice through the live Worker" (live) | `release_status.mjs --sha <merge sha>` |
| Hands-free live transcript and gapless native clip queue | missing: native Swift (`tool/bootstrap.sh`) has no automated test; device only | owner device test after a new IPA |

## Navigation and accessibility

| Scenario | Test | Run |
|---|---|---|
| Every IconButton has a VoiceOver label | `test/che_icon_button_label_test.dart` | `flutter test test/che_icon_button_label_test.dart` |
| No new unlabeled tap targets (ratchet over the 15 known) | `test/e2e_a11y_tap_targets_test.dart` | `flutter test test/e2e_a11y_tap_targets_test.dart` |
| 19 screens × 6 viewports × text 1.0/1.3 without overflow; 44 pt targets | `test/che_responsive_layout_test.dart`, `test/che_chat_responsive_guard_test.dart` | `flutter test test/che_responsive_layout_test.dart test/che_chat_responsive_guard_test.dart` |
| "What is on my screen?" answered from the page's own report | `test/che_voice_route_order_test.dart`, `test/che_owner_phrases_test.dart` | `flutter test test/che_owner_phrases_test.dart` |
| Help: "what does this button do" from the screen's real controls | `test/che_help_test.dart` | `flutter test test/che_help_test.dart` |
| Brain Room navigation by voice | `test/che_brain_navigation_test.dart` | `flutter test test/che_brain_navigation_test.dart` |
| Opening Commands by voice does not wait behind a stalled clip | missing (a widget test with a never-finishing speech fake would cover it) | — |

## Trading and market data (paper only)

| Scenario | Test | Run |
|---|---|---|
| Status answers say paper, live orders off, prices DELAYED; no model | `.claude/skills/che-fact-check/cases/owner-trading-status.json`; `trading_honesty.test.mjs` | `node --test .claude/skills/tests/skills.test.mjs server/cloudflare/trading_honesty.test.mjs` |
| A delayed bar older than 45 min is refused | `trading_live.test.mjs` | `node --test server/cloudflare/trading_live.test.mjs` |
| BTC/ETH stream: LIVE only with a trade in the last minute | `lane/rel-markets-studio` `test/che_crypto_stream_test.dart` | as E5 |
| The chart survives malformed payloads | `lane/rel-markets-studio` `test/che_trading_chart_malformed_test.dart` | `flutter test test/che_trading_chart_malformed_test.dart` |
| "Is the MNQ data live?" gets a deterministic freshness answer | `voice_command_routing.test.mjs` (`todo`) | as E4 |
| Live trading stays disabled | `trading_environments.test.mjs`, `trading_honesty.test.mjs` | `node --test server/cloudflare/trading_environments.test.mjs` |

## Deploy, CI, disk, IPA, Shorebird

| Scenario | Test | Run |
|---|---|---|
| Status of a PR / commit: checks, merge, deploy probes, IPA; never "live" without the deploy's live check | `skills.test.mjs`: "che-release status …", "evidence integrity …" | `node --test .claude/skills/tests/skills.test.mjs`; live: `node .claude/skills/che-release/scripts/release_status.mjs --pr N` |
| Preflight finds local-only work (uncommitted, unpushed branches, detached worktrees, stashes) and cleans only build outputs | `skills.test.mjs`: "che-recover preflight …" | `node .claude/skills/che-recover/scripts/preflight.mjs` (exit 4 = push first) |
| Workflow triggers do not waste runs (Flagstaff wake, Autopilot) | `tool/test_workflow_triggers.py` | `python3 -m unittest discover -s tool -p 'test_workflow_triggers.py'` |
| Inline workflow scripts parse | `skills.test.mjs`: "workflow checker …" | `python3 .claude/skills/che-debug/scripts/check_workflows.py` |
| IPA version and build numbers increase across build providers | `tool/test_mobile_version.py`, `tool/test_ipa_metadata.py` | `python3 -m unittest discover -s tool -p 'test_mobile_version.py'` |
| Update feed: only verified releases (sha256, bundle id) are offered; SideStore source shape | `mobile_update.test.mjs`, `test/che_mobile_update_test.dart` | `node --test server/cloudflare/mobile_update.test.mjs`, `flutter test test/che_mobile_update_test.dart` |
| Deploy receipt for a commit ("what changed in commit X") | `deploy_receipt.test.mjs` | `node --test server/cloudflare/deploy_receipt.test.mjs` |
| A Dart-only Shorebird patch never carries asset or native changes as if delivered | missing (checklist item in `docs/CHE_READINESS.md` §3-5; a CI guard on `assets/**` and `tool/bootstrap.sh` diffs would cover it) | — |
| Command Center catalog fixture matches the Worker | `command_center.test.mjs`: "the Flutter catalog fixture matches what the Worker serves" | `node tool/dump_command_catalog.mjs` to regenerate |

## Device-only checks (owner, on the iPhone; no automated test can stand in)

1. CHE Updates screen: version, build, patch. Then ask CHE "is the new build installed on my phone?" and check both agree (E9).
2. Wake word, hands-free live transcript, one voice per reply, no gap between clips.
3. VoiceOver on: every new control is read; actions report their real result aloud; passive screens stay silent.
4. Relaunch and repeat (Shorebird patches apply on relaunch).
5. Record the result with the date in the handoff §2; until then the item stays UNVERIFIED.
