# CHE readiness audit

Reliability lane, 2026-10-25. Written from **repository and GitHub evidence only**. A claim from the handoff, the mailbox or an AI's chat is listed only when something in git, a CI run or a test backs it, and it is marked **CLAIM** when nothing does.

Baseline: `main` = `0c43197c66529ee0902ee373fc0889467490ee71` (PR #523).

## Evidence used

| Evidence | What it proves | How it was checked (2026-10-25) |
|---|---|---|
| Worker suite at `0c43197` | `node --test server/cloudflare/*.test.mjs`: **3934 tests, 3927 pass, 0 fail, 7 skipped** | Run in this lane, Node 22, offline |
| Flutter suite at `0c43197` | `flutter test`: **1294 pass, 1 skipped, 0 fail** | Run in this lane, Flutter at `/opt/flutter` |
| Deploy CHE Worker run 40135088611 (push) and 40143945084 (dispatch, `creation_check`) | Both `success` at `0c43197`. The 40143945084 notices: "VERIFIED 0c43197c6652 is live", memory truth 22/22 with 0 model calls, ElevenLabs voice 53,959 bytes in 448 ms, Command Center 5/5, Knowledge Atlas 11/11, Creation Engine end to end (job `gpu_aa40ade12d98`, CPU worker, Blender 5.0.1, GLB 1,149,516 bytes, sha matches the receipt, worker name printed as `?`) | GitHub REST API + `.claude/skills/che-release/scripts/release_status.mjs --sha 0c43197…` |
| CHE iPhone IPA run 40135088469 | `success` at `0c43197`: an **unsigned artifact** (version 1.4.1025652491 per the handoff) | GitHub REST API |
| CHE Shorebird run 40135088615 | `success` at `0c43197`. The handoff says it published Patch 12 **for release 1.4.1025573394** | GitHub REST API (run state); the patch target is a CLAIM from the run log as quoted in the handoff |
| Newest *published* IPA release | `che-ios-v1.4.1025342820-b3956317271501` (2026-10-21). No release run exists for `0c43197`; `che-ipa-release.yml` is `disabled_manually` | `release_status.mjs` |
| Last device evidence | Owner screenshot 2026-10-22 07:45 local (handoff §8g): **CHE 1.4.1025342820, build 3956317271501, patch 9** | Reported in the handoff; no newer device evidence anywhere in the repo or mailbox |
| Open PR #524 (`claude/che-latency-optimization-8ruaus`, head `cf48aa2`) | NOT merged, NOT deployed, NOT in any IPA. Checks at the time of writing: Worker tests, analyze and compile still running | GitHub REST API |
| Branches `lane/crypto-stream` (`219ad7e`), `lane/mission-engine` (`e390d1e`, also merged into #524) | Branch work only | `git ls-remote` |

**Deployed** below means merged at or before `0c43197` and in `server/cloudflare` (deploy 40135088611/40143945084 verified that commit live). **In full IPA** means merged at or before `0c43197` and in `lib/`, `assets/` or native code (IPA run 40135088469). **Installed on iPhone** is UNVERIFIED for everything after 2026-10-22: the last device evidence shows release 1.4.1025342820, and the newest Shorebird patch targets a different release (1.4.1025573394), so **Patch 12 cannot reach a phone still on 1.4.1025342820**. Only a sideload of the new IPA (not evidenced) changes that.

Legend: **Y** yes, with the evidence named; **N** no; **UNVERIFIED** nothing in the repo or CI proves it either way; **CLAIM** asserted in the handoff or mailbox without evidence here; **BLOCKED** needs the owner or a third party.

## 1. Memory, Brain, Conversations

| Capability | Code exists | Automated tests (pass now?) | Backend deployed | In full IPA | Installed on iPhone | Real-iPhone test | External service verified |
|---|---|---|---|---|---|---|---|
| Save a fact from chat, recall it after a restart, cite the record | `server/cloudflare/personal_recall.js`, `memory_provenance.js`, `brain_memory.js`, `brain_store.js` | `owner_recall.test.mjs`, `memory_truth.test.mjs`, `personal_recall*.test.mjs`, **new** `e2e_memory_restart.test.mjs` (pass; 1 todo = known bug, see Bugs) | Y (live probe: memory truth 22/22, 0 model calls) | n/a (Worker) | UNVERIFIED | UNVERIFIED. Handoff dashboard asks for an owner-device check ("No, strawberry Sprite" after a recall); no result recorded | n/a |
| Provenance follow-up ("where did that come from") | `memory_provenance.js` (`che_evidence_receipt`) | `owner_recall.test.mjs`, `e2e_memory_restart.test.mjs` (pass) | Y | n/a | UNVERIFIED | UNVERIFIED | n/a |
| Brain screens and memory dots | `lib/brain/**`, `lib/home/che_memory_brain.dart`, `insights_brain_scene.dart` | `test/che_brain_*_test.dart` (all pass, 130+ tests) | n/a | Y (at `0c43197`) | UNVERIFIED | UNVERIFIED | n/a |
| Brain Room redesign (owner reference image) | On #524 / lost lane `lane/brain-visual` (handoff §2: lost, never pushed) | N/A on main | N | N | N | N | n/a |
| Conversations list / relaunch keeps last turns | `lib/conversations/che_conversations_screen.dart`, `lib/che_conversation_state.dart` | `test/che_conversations_test.dart` (4 pass) | n/a | Y | UNVERIFIED | UNVERIFIED | n/a |
| ChatGPT history import | `/api/brain/import/chatgpt` (worker.js) | `owner_recall.test.mjs` (pass) | Y | Phone import screen: **N** (the Worker reply says none exists yet) | N | N | n/a |
| Shared pgvector memory | `vector_memory.js` | `vector_memory.test.mjs` (pass) | code deployed | n/a | n/a | n/a | **BLOCKED**: owner must set `CHE_PGVECTOR_REST_URL` + token (handoff §6 K9) |
| Office agents on one shared memory | none found | none | N | N | N | N | n/a (handoff §6 K10: NOT-STARTED) |

## 2. Trading and market data (paper only; live orders disabled)

| Capability | Code exists | Automated tests (pass now?) | Backend deployed | In full IPA | Installed on iPhone | Real-iPhone test | External service verified |
|---|---|---|---|---|---|---|---|
| Trade journal, trade evidence, replay with entry/exit markers | `trading_evidence.js` (append-only journal), `trading_visual.js` (`journalView`, `replayFrame`), `trade_evidence.js` | `trading_visual.test.mjs`, `trade_replay_ids.test.mjs`, **new** `e2e_trading_journal.test.mjs` (pass: P&L matches hand arithmetic, no look-ahead) | Y | `lib/trading/che_trade_replay.dart`, `che_my_trades.dart`: Y | UNVERIFIED | UNVERIFIED. The 2026-10-24 ETH replay bug came from an owner recording; its fix is in `trade_replay_ids.test.mjs` | n/a |
| MNQ/NQ chart freshness | `trading_chart.js` (source/status), `trading_live.js:163` `staleBarProblems` (a DELAYED bar older than `MAX_DELAYED_BAR_AGE_MS` = 45 min, `trading_delayed_training.js:14`, is refused) | `trading_live.test.mjs` ("delayed data older than the maximum age"), `trading_chart.test.mjs`, `trading_honesty.test.mjs` (pass) | Y | Y (`lib/rooms/che_trading_chart.dart`) | UNVERIFIED | UNVERIFIED | **Delayed public data only** (Yahoo research bars). Live CME data: **BLOCKED** (needs a Tradovate sign-in and a CME real-time subscription, as CHE herself says in replay) |
| Rithmic (FundYourEdge/Tradesea) recording on the phone | `lib/rithmic/*.dart`, `rithmic_dataset.js` | `test/rithmic_*_test.dart`, `che_rithmic_screen_test.dart` (pass), `rithmic_dataset.test.mjs` (pass) | Y | Y | UNVERIFIED | UNVERIFIED | **BLOCKED / NOT CONNECTED** (handoff: valid Rithmic API access and terms needed) |
| Crypto (BTC/ETH) simulation and candles | `strategy_sim.js`, `crypto_markets.js`, `trade_evidence.js` (Coinbase/Kraken minutes) | `crypto_markets.test.mjs`, `trade_replay_ids.test.mjs` (pass) | Y | `lib/trading/che_crypto_desk.dart`: Y | UNVERIFIED | UNVERIFIED | Coinbase/Kraken public APIs used by the live Worker; the deploy's trading audit (1,109 closed sim trades) shows real reads happened |
| Crypto real-time streaming (WebSocket, LIVE/STALE/DELAYED) | Branch `lane/crypto-stream` `219ad7e` only (`lib/trading/che_crypto_stream.dart`) | Branch tests only; not run on main | N | N | N | N | N |
| Crypto paper replay, Alpaca paper fills, "audit September 22", Diagnose Rithmic | PR #524 only | PR #524 CI pending | N | N | N | N | Alpaca paper: UNVERIFIED |
| Simulation P&L honesty | `trading_audit.js` | `trading_audit.test.mjs` (pass) | Y (deploy note: −8,144.41 R total, costs 7,927.86 R, 325 trades with costs over risk) | n/a | n/a | n/a | n/a. The owner's ≈ −$1,018 on 2026-09-22 is in none of the ledgers (handoff); the broker side is unchecked |
| Live trading | none by design (`liveOrdersStatus()` everywhere) | `trading_honesty.test.mjs`, `trading_environments.test.mjs` | disabled | disabled | disabled | n/a | disabled until the owner separately approves (AGENTS.md) |

## 3. Recording Studio (music)

| Capability | Code exists | Automated tests (pass now?) | Backend deployed | In full IPA | Installed on iPhone | Real-iPhone test | External service verified |
|---|---|---|---|---|---|---|---|
| Record takes, tracks, mixer (WAV) | `lib/music/che_recording_studio.dart`, `che_studio_controller.dart`, `che_studio_audio.dart`, `che_dsp.dart`, `che_wav.dart`; native recorder `tool/bootstrap.sh` (`AVAudioRecorder`, ~line 1595) | `test/che_recording_studio_test.dart` (30 pass) | n/a (`music_audio.js` and others: Y) | Y | UNVERIFIED | UNVERIFIED (native audio is only provable on a device) | n/a |
| M4A export, MP3/M4A import, live monitoring, sung-voice pitch correction | PR #524 only (`lib/music/*`, `tool/bootstrap.sh` +279 lines) | `test/che_pitch_voice_test.dart` etc. on #524 only | N | **N: needs a NEW full IPA** (native Swift) | N | N | n/a |
| Beat producer, Engineer Mode, BandLab preset import, Studio Tutorials | Lost lanes `lane/studio-engine`, `lane/studio-tutorials` (handoff §2: never pushed) | none | N | N | N | N | n/a |

## 4. GPU, Creation Engine, Browser

| Capability | Code exists | Automated tests (pass now?) | Backend deployed | In full IPA | Installed on iPhone | Real-iPhone test | External service verified |
|---|---|---|---|---|---|---|---|
| Creation queue → worker → GLB → viewport | `gpu_queue.js`, `creation_orchestrator.js`, `creation_studio.js`, `cloud_computer.js`; viewer `assets/characters/app/studio.html` | `gpu_queue.test.mjs`, `creation_*.test.mjs` (pass); `test/che_live_studio_test.dart` (23), `che_creations_test.dart` (pass) | Y | Y (bundled assets need the IPA, not Shorebird) | UNVERIFIED | UNVERIFIED | **Y for the free GitHub CPU worker** (deploy 40143945084 `creation_check`). Worker name shows `?` (defect, handoff) |
| Colab T4 GPU | `gpu_queue.js`, `gpu_oidc.js`, `lib/che_gpu_jobs.dart` | `gpu_oidc.test.mjs`, `test/che_gpu_jobs_test.dart` (pass) | Y | Y | UNVERIFIED | UNVERIFIED | **UNVERIFIED**: no GPU heartbeat or GPU receipt in any run; "connected" is a CLAIM nowhere backed |
| GPU Browser (retained WebView, Google sign-in handoff) | `lib/create/che_gpu_browser.dart`, `lib/browser/che_browser.dart` | `test/che_gpu_browser_test.dart` (2 pass) | n/a | Y | UNVERIFIED | UNVERIFIED (handoff: sign-in/WebView on device unverified) | UNVERIFIED |
| Create Object/Room/new animations, free-form objects, CC0 textures | Lost lane `lane/creation-gaps` | none | N | N | N | N | n/a |
| Cinematic renders | paused by the owner | — | — | — | — | — | — |

## 5. Coding, Agents, Mission engine

| Capability | Code exists | Automated tests (pass now?) | Backend deployed | In full IPA | Installed on iPhone | Real-iPhone test | External service verified |
|---|---|---|---|---|---|---|---|
| Coding status / receipts from records | `coding_history.js`, `coding_runtime.js` | `coding_history.test.mjs`, `coding_receipts.test.mjs`, **new** `e2e_coding_receipts.test.mjs` (pass; 2 todo = known bug: a merge/PR claimed without a PR number) | Y | n/a | n/a | UNVERIFIED | OpenCode runner on GitHub Actions: **UNVERIFIED** (no completed CHE-runtime PR with receipts in the evidence above) |
| "Last completed work + GitHub proof" | `coding_history.js` `completedWorkProof` (job record only) | `e2e_coding_receipts.test.mjs`, `coding_history.test.mjs` (pass) | Y | n/a | n/a | UNVERIFIED | Live GitHub check: **N** (handoff §6 C5: NOT BUILT; the answer says "not a live GitHub check") |
| Commit evidence `/api/evidence/commit/:sha` | `deploy_receipt.js`, worker.js | `deploy_receipt.test.mjs` (pass) | Y | n/a | n/a | UNVERIFIED | needs `CHE_GITHUB_TOKEN` in production: UNVERIFIED |
| Mission engine (objective graph, workflows) | `objective_graph.js`, `workflow_engine.js`, `workflow_governor.js` | `objective_graph.test.mjs`, `workflow_engine.test.mjs` (pass) | Y | n/a | n/a | UNVERIFIED | n/a |
| Persistent mission proof (SHA-256 result on reopen); objectives owner-only | PR #524 / `lane/mission-engine` (`mission_artifact.js`, `mission_engine_proof.test.mjs`) | branch only | **N** (the owner-only guard on `/api/objectives` is defence in depth: per `8664423`, the profile gate on main already returns 403 to family devices) | n/a | n/a | N | n/a |
| Office agents, War Room | `agent_runtime.js`, `agent_rooms.js`, `lib/office/**` | `agent_*.test.mjs` (pass) | Y | Y | UNVERIFIED | UNVERIFIED | n/a |
| Autonomy exam (5 levels) | `autonomy_exam.js` | `autonomy_exam.test.mjs` (pass) | Y | n/a | n/a | n/a | Real run: **N** (held; handoff 2026-10-08) |

## 6. Voice and accessibility

| Capability | Code exists | Automated tests (pass now?) | Backend deployed | In full IPA | Installed on iPhone | Real-iPhone test | External service verified |
|---|---|---|---|---|---|---|---|
| TTS (ElevenLabs main, Fish backup) | `phone_voice.js`, `fish_audio_voice.js`, `lib/che_speech_*.dart` | `phone_voice.test.mjs`, `fish_audio_voice.test.mjs`, `test/che_elevenlabs_voice_test.dart`, `che_fish_voice_test.dart` (pass) | Y | Y | UNVERIFIED | Last device evidence 2026-10-22: ElevenLabs **out of credits**, Fish working (handoff §8f/8g) | **Y**: deploy probe, ElevenLabs 53,959 bytes in 448 ms at `0c43197` |
| Hands-free live transcript while speaking | not on main: `tool/bootstrap.sh` emits no `partial` event (handoff §8f fix plan) | none | n/a | **N** (needs a native change and a new IPA) | N | N | n/a |
| Wake word | `lib/che_wake_word.dart`, `che_wake_match.dart` | `test/che_wake_*` (pass) | n/a | Y | UNVERIFIED | UNVERIFIED (handoff dashboard: UNKNOWN on device) | n/a |
| Silent on launch / passive screens (owner rule 2026-10-11) | `lib/che_voice_*`, `che_voice_privacy_quiet_test.dart` | `che_voice_privacy_quiet_test.dart` (9 pass), `che_voice_startup_guard_test.dart` | n/a | Y | UNVERIFIED | UNVERIFIED | n/a |
| VoiceOver labels | IconButtons: tooltip on every one; GestureDetector/InkWell: 15 flagged (see `docs/CHE_A11Y_AUDIT.md`) | `test/che_icon_button_label_test.dart`, **new** `test/e2e_a11y_tap_targets_test.dart` (ratchet, pass) | n/a | Y | UNVERIFIED | UNVERIFIED | n/a |
| Status questions answered honestly | `che_self_update`, `che_runtime_status`, `che_trading_desk`, `che_trading_live` routes in worker.js | **new** replay cases `owner-release-status.json`, `owner-trading-status.json` (6/6); `e2e_owner_status_phrases.test.mjs` (2 pass, 5 todo = misroutes) | Y | n/a | n/a | UNVERIFIED | n/a |

## Top gaps by severity (evidence)

1. **No proof that anything after 2026-10-22 is on the iPhone.** Last device evidence: 1.4.1025342820 + patch 9 (§8g). The newest Shorebird patch (12) targets 1.4.1025573394; the newest IPA at `0c43197` is an unsigned artifact; the public release workflow is `disabled_manually` and the newest published IPA is 1.4.1025342820. Every Flutter/asset feature merged since then (GPU Browser, bundled CHE, Creation viewer, Brain changes) is **not shown to be installed**.
2. **Live market data does not exist for futures.** MNQ/NQ are delayed research bars (45-minute staleness gate); Rithmic and Tradovate are not connected (external blockers). Status answers say DELAYED correctly (replay case), but the owner's "Is the MNQ data live?" is **misrouted to a deployment check** (bug 3).
3. **A coding receipt can claim a merge or an opened PR with no PR number** (bug 1). Same reply says "Pull request: none recorded", so the owner hears a contradiction. Direct conflict with the owner's "never claim coding work without evidence" (§6 C6).
4. **Recall can answer a question about a different named subject** from another stored statement (bug 2), with the wrong vault's phrase. The record is quoted, so it is visible, but the answer is wrong for the question asked.
5. **Owner-requested work exists nowhere in git.** The lanes brain-visual (the owner-approved Brain Room design), studio-engine (beat producer, Engineer Mode, BandLab import), studio-tutorials and creation-gaps were never pushed (handoff §2, 2026-10-25 02:30). PR #524 (trading gaps, Recording Studio gaps, mission proof) is open and unmerged; its CI was still running when this was written.
6. **Colab GPU never verified.** The only verified creation ran on a free CPU worker; there is no GPU heartbeat or GPU receipt. The worker name is printed as `?` in the receipt.
7. **Hands-free voice: no live transcript, long end-of-turn wait** (§8f). Not fixed on main; needs a native change and a new IPA.
8. **Recording Studio gaps (M4A export, import, monitoring, pitch) are on #524 and change `tool/bootstrap.sh` (native Swift), so they need a new full IPA**, not a Shorebird patch. Native recording on main has never been verified on a device.
9. **Coding proof is record-only.** No live GitHub check of commits/PRs/CI (§6 C5 NOT BUILT), and no evidence that the OpenCode runtime finished a real PR recently.
10. **Release/device phrasings fall through to the model.** "Is the new build installed on my phone?", "What's on my iPhone right now?", "Did the update go through?" reach the model and the reply is replaced with an unrelated activity line ("Nothing is running right now"). Honest, but no answer; `che_runtime_status` already answers "What version is installed on my iPhone?".

## Bugs found (no production code changed in this lane)

1. **Merge / PR claimed without a receipt.** `server/cloudflare/coding_runtime.js` `speakRuntimeStatus`, `case 'merged'` (~line 399) and `case 'pr_open'` (~line 396): with no `pr_number` in the runtime record, it says "Done. I recorded no change count, tests passed, my reviewer approved, and I merged its pull request." / "…opened a pull request." `coding_history.js` then appends "Pull request: none recorded." Repro: `codingHistoryReceipt({ kind: 'runtime', sessionId: 'ocr-test', status: { status: 200, state: 'merged' } })`, or `e2e_coding_receipts.test.mjs` (todo tests) through `/api/chat` "coding status" with a fake GitHub result file `{ "state": "merged" }`.
2. **Recall matches a different named subject.** `server/cloudflare/personal_recall.js` `recallStoredStatement` (~lines 420-433): key words keep "what" and "the" (not in `ASK_WORDS`), and a match needs only ≥ 3 shared words and ≥ 60%. Stored "the fictional vault Amber Kestrel opens with the phrase Quiet Harbor Twelve"; asked "What phrase opens the fictional vault Copper Lantern?" → 5/8 shared → CHE answers "Quiet Harbor Twelve". Repro: `e2e_memory_restart.test.mjs` (todo test).
3. **"Is the MNQ data live?" / "Is the crypto feed live?" answered as a Worker deployment check.** `server/cloudflare/worker.js` `selfUpdateChatIntent` (~line 2662): the negative lookahead `live(?!\s+(?:…feed|data|chart…))` excludes "live data" but not "data live". Repro: `.claude/skills/che-debug/scripts/replay_chat.mjs` with those turns → `route=che_self_update`, "I could not verify the Worker deployment from GitHub"; `e2e_owner_status_phrases.test.mjs` (todo tests).
4. **(Gap, not a crash)** install/update phrasings fall through to the model (see gap 10); `e2e_owner_status_phrases.test.mjs` todo tests.

Todo tests run in every suite and print `# TODO`; they do not fail CI. When a route owner fixes a bug, the test passes and the `todo` option should be removed.

## New tests from this lane

| File | Tests | Result |
|---|---|---|
| `server/cloudflare/e2e_memory_restart.test.mjs` | 2 (1 pass, 1 todo bug 2) | pass |
| `server/cloudflare/e2e_trading_journal.test.mjs` | 3 | pass |
| `server/cloudflare/e2e_coding_receipts.test.mjs` | 8 (6 pass, 2 todo bug 1) | pass |
| `server/cloudflare/e2e_owner_status_phrases.test.mjs` | 7 (2 pass, 5 todo bug 3 + gap 10) | pass |
| `.claude/skills/che-fact-check/cases/owner-release-status.json` | 3 turns | 3/3 expectations met |
| `.claude/skills/che-fact-check/cases/owner-trading-status.json` | 3 turns | 3/3 expectations met |
| `test/e2e_a11y_tap_targets_test.dart` | 2 (scanner + ratchet) | pass |

Full Worker suite with these files: **3954 tests, 3939 pass, 0 fail, 7 skipped, 8 todo** (the 8 known-bug/gap tests above). Skills tests (`.claude/skills/tests`, which replay every case file): 18/18.

---

## Release-readiness checklist

The **how** of merging, deploying, patching and verifying lives in the che-release skill: [`.claude/skills/che-release/SKILL.md`](../.claude/skills/che-release/SKILL.md) (authorization gate, `release_status.mjs`, never-list). This checklist decides **what a given change needs** before anyone may call it shipped. Every box needs evidence (a SHA, a run id, a test output), not a statement.

### 1. Source and tests
- [ ] Change is on a pushed branch with a PR; the PR body says what was verified and what was not (iPhone, production).
- [ ] `bash .claude/skills/che-debug/scripts/run_checks.sh` passes for the changed paths (Worker syntax and suite, skills tests including every `che-fact-check/cases/*.json`, `flutter analyze --fatal-infos`, `flutter test`). "Flutter NOT RUN" is reported as not verified.
- [ ] Chat behavior changes have a replay case or an `/api/chat` test using the owner's words; status/claim routes keep `model_calls: 0`.
- [ ] No test skipped or weakened to get green; known bugs are `todo`, with file:line in the PR.

### 2. Backend change → deploy receipt
- [ ] Anything under `server/cloudflare/` changed → the squash title carries `[worker-deploy]` (che-release gate).
- [ ] After merge: `release_status.mjs --sha <merge sha>` shows `live commit check: VERIFIED <sha> is live`, and memory/voice/Command Center probes `success`. A green PR or a running deploy is not "live".

### 3. Native iOS dependencies → full IPA required
- [ ] Changes to `tool/bootstrap.sh` (generated Swift: audio session, recorder, speech recognition, playback), `ios/**`, plugins in `pubspec.yaml` with native code, entitlements or Info.plist keys → **a new full IPA**. Shorebird cannot change Swift. Examples now pending: PR #524 Recording Studio (M4A export, monitoring), the §8f live transcript.
- [ ] `[ios-build]` in the title or a dispatched `che-iphone-ipa.yml`, owner-authorized; record the run id, version and build number.

### 4. Bundled assets → IPA, not Shorebird
- [ ] Changes under `assets/**` (e.g. `assets/characters/app/studio.html`, GLBs, `assets/office3d/`, `assets/brain3d/`) → full IPA. Shorebird excludes asset changes (its CLI warns; handoff, run 40135088615).

### 5. Shorebird compatibility (Dart-only changes)
- [ ] Only `lib/**` Dart changed, no native/asset change.
- [ ] The patch targets the **release actually installed** on the owner's phone. Today the last device evidence is 1.4.1025342820, while Patch 12 targeted 1.4.1025573394: confirm the installed release on the device (CHE Updates screen) before calling a patch delivered, or dispatch `che-shorebird.yml` with `release_version` for that release (owner-authorized).
- [ ] The patch applies on relaunch; delivery is proven only by the device's Updates screen.

### 6. Storage migrations
- [ ] Durable Object keys or record shapes changed (`che` data blob, `evr:` journal, `trd_ds:` datasets, `strategy_sim_*`, memory records, Brain SQLite tables) → old records still read (a test that loads the previous shape), nothing deleted, and a new field has a default.
- [ ] A one-time migration is idempotent (re-running changes nothing) and leaves the old data readable for rollback.

### 7. Credentials
- [ ] No secret in source, tests, logs, replies, chat history or memory. Passwords stay in the on-device Keychain vault (`lib/security/che_password_vault.dart`) only.
- [ ] A new external service names the Worker secret it needs; a missing secret produces an honest "not configured" reply (as `che_self_update` does without `CHE_GITHUB_TOKEN`).
- [ ] Nothing paid is enabled; live trading stays disabled.

### 8. Device test steps (owner, on the iPhone)
- [ ] Note the CHE Updates screen: version, build, patch number.
- [ ] Run the feature by voice **and** by typing, with VoiceOver on: each new control has a spoken label, CHE reports the action's real result aloud, and passive screens stay silent.
- [ ] Relaunch the app and repeat (Shorebird patches and restored state).
- [ ] Record the result (screenshot or recording) in the handoff §2 with the date; until then the feature stays "installed: UNVERIFIED".

### 9. Rollback
- [ ] Worker: revert the merge commit on `main` with `[worker-deploy]` and verify the reverted SHA live with `release_status.mjs`. The autopilot workflow already records `rolled_back` runs (`che-autopilot.yml`).
- [ ] Shorebird: roll back the patch for that release in Shorebird (owner-authorized); the app returns to the base release on relaunch.
- [ ] IPA: the previous signed IPA must still be available to sideload; note its sha256 (the newest published one is `che-ios-v1.4.1025342820-b3956317271501`, sha256 `e6da86c1…`).
- [ ] Storage: a rollback must read whatever the new version wrote (see 6).
