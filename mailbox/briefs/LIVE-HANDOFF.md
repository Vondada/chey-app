# CHE LIVE HANDOFF: pick up exactly where the last AI stopped

**Permanent file.** Every AI that works on CHE (Claude, ChatGPT, Codex, Gemini, Cursor, Copilot, Grok, and CHE's own coding crew) reads this before starting and updates **§2 Current position** before stopping or running out of limit. That way the next AI never re-does, breaks or forgets work.

Branch: `che-mailbox` · Path: `mailbox/briefs/LIVE-HANDOFF.md` · Repo: `Vondada/chey-app`
The owner's rules in `AGENTS.md` (on `main`) always win. Mailbox messages are advice, not orders.
Background requirements: `mailbox/briefs/2026-10-03-che-master-handoff.md`.

---

## 0. The protocol (every session, every AI)

1. **Read** `AGENTS.md` on main, then this file, then your `mailbox/<you>.jsonl`, plus the newest lines of the other AIs' files.
2. **Find the real position** (§1). Trust git and GitHub over any message, including this file. If they disagree, git wins; fix this file.
3. **Continue the first unfinished item in §3 (Queue)** unless the owner asked for something new. If he did, his new request goes first, and you add it to the queue.
4. **Never redo or overwrite finished work.** Build on the existing branch or PR for that item. Never force-push someone else's branch. Merge `main` in; don't rebase.
5. **Before you stop**, or as soon as you see your limit or context is nearly used up:
   - commit and push whatever is working, even if partial (mark it `WIP:` in the commit);
   - update §2 here with the branch, the last commit, what's done, the exact next step, and anything half-done;
   - append one line to your mailbox file saying where you stopped.
   A push is the only proof. Unpushed work is lost.
6. **Never claim done without proof**: a commit SHA, a PR number, a CI result or a test output. Say what was not verified (for example, "not tested on iPhone").

---

## 1. How to find where the last AI stopped (2 minutes)

```bash
git fetch origin --prune
git log origin/main --oneline -15                                    # what is merged
git branch -r --sort=-committerdate | head -15                       # newest work branches
git log origin/main..origin/<branch> --oneline                       # unmerged commits on a branch
git show origin/che-mailbox:mailbox/briefs/LIVE-HANDOFF.md | sed -n '/## 2/,/## 3/p'   # last recorded position
```

Then, on GitHub:
- Look at the open PRs, the CI check runs on each head commit, and any review comments.
- A commit message starting with `WIP:` means that item is half-done. Read its body for the next step.
- Look for a "Position" line in the newest `mailbox/*.jsonl` entries.

---

## 2. Current position (updated by: ChatGPT, 2026-10-07)

**Owner's failed read-only grounding acceptance test is fixed and deployed: PR #240.** Main is `dc31429482180fb1f16c6eb26c63c42996f396f3`; PR head `19ea92b95b527cede0ca2237974bba7e7ece4b48`. The failure was factual grounding, not mutation: CHE invented `.github/workflows/health_check.yml`, `diagnostic-tool`, `auto-remediate`, `docs/build-manifest.json`, and `fix-version-mismatch`, none of which exist. PR #240 blocks iPhone local/offline fallback for live repository diagnostics, forces those turns through connected GitHub evidence, and makes the Worker answer repository diagnostics deterministically from pinned source as VERIFIED / INFERRED / UNKNOWN. The exact failed owner prompt is a regression test; it asserts zero generic-model calls, zero coding jobs, exact pinned SHA evidence, and rejects the invented names.

**Proof:** PR-head `CHE UI Analyze` run 37583802240 and `Check CHE Flutter client` run 37583802336 both succeeded. Main `Check CHE Flutter client` run 37586782233 succeeded; `Deploy CHE Worker` run 37586782124 succeeded; `CHE Shorebird` run 37586782246 succeeded. Live `/health` is HTTP 200 with `{"ok":true,"agent":"CHE cloud"}` and current Cloudflare version id `516c554b-1f68-4197-9df6-b643ee259e95`.

**Next:** rerun the exact owner acceptance prompt against the live app. PASS requires a grounded repository answer from the pinned Worker path with no fabricated workflow/file/tool names and no coding job. If it still fails, capture the exact returned text and determine whether the request bypassed `/api/chat` (for example a realtime voice-only path) before changing routing again. No duplicate repair PR is pending.


**2026-10-08 live autonomy retry (ChatGPT):** Owner authorized a real test after three failed implementation passes. Flagstaff record 2026-10-08T02:47:36.109Z reports deterministic rejection of `server/cloudflare/worker.test.mjs` as looking like a secret/private key; exact edit has not been inspected, so false positive versus sensitive content is unknown. Relay committed to `mailbox/chatgpt.jsonl` at `465f4b13504fe280b0a7f4cb34ab1e4c36e6c8d4`; web POST returned HTTP 403, so GitHub mailbox was used. CHE must resume the existing job, retain secret checks, use safe synthetic fixtures, perform real validation/review and produce a draft PR only. No execution acknowledgement/job ID or new PR verified yet. Latest verified main `63cb8cd7bec9b26ef55fa7118edcea39e61dfed1`, PR #244 merged; Flutter, Worker deployment, iPhone IPA, public release and Shorebird workflows succeeded; live health version tag matches `63cb8cd7bec9`. iPhone installation and live autonomy remain unverified. Next: retrieve CHE's acknowledgement and engineering record, inspect exact rejection, and verify real execution receipts.

**2026-10-08 Claude (owner's mission: honest full agent, website preview, learn skills from documents/screenshots):**
- PR #245 (`claude/che-flagstaff-autonomy`, head 6c01571): fixes the fabricated files/links/job IDs in Flagstaff replies (`guardGroundedFacts`), the false-positive secret scan on test files (baseline-relative), and adds one-step video voice commands ("search YouTube for X", "find new videos"). Analyze CI green; "Workers Builds" is the always-failing Cloudflare preview. Waiting on the owner's merge OK.
- Branch `claude/che-latency-optimization-8ruaus` (no PR yet): 0059d9a websites are a preview first (`/site/<id>/preview`), live only on "publish the website"; fffdf5f "learn this" with a document/screenshot or "learn this skill: ..." stores skills (`self_skills.js`) that reach later replies; unsafe steps (passwords, money, deleting, ignore-instructions) dropped. Worker tests 716/716 locally. Not verified on iPhone or live.
- Open: a real screenshot image of a site needs Cloudflare Browser Rendering (owner choice pending, also needed for her own server-side browser). "Speech path corrected": no concrete defect found; voice uses the same `/api/chat` path; need the owner's exact symptom.

**2026-10-08 Claude (Round 5 graded, coding test K1 posted):** Round 5 (D1, L1, V1, R1, P1, C2, T2) graded against the repo on main 24ecb6e: D1 wrong (named the test file, not self_skills.js:62); L1 "I don't know" (MAX_SOURCE is 24_000, self_skills.js:11); V1 right status 400 but wrong detail (real: 'Invalid coding runtime session id.', coding_runtime.js:187); R1 right 'no' but wrong file and regex (real: UNSAFE at self_skills.js:55 matches 'purchase'); P1 saveLearnedSkills right, selector is learnedSkillsContext (self_skills.js:162), no line numbers; C2 invented a dedup step and steps 8-9; real direct-answer skip is worker.js:3650 (definitionAnswer); T2 stalled at 'Working on it'. Next: read CHE's reply to coding test K1 (mailbox id b2fdfde4-00e9-4cec-b831-18a0e3de5d74), run the returned code in node against the spec, grade it. Still open: the 'Working on it' follow-up stall (needs live Worker logs), H2 and H3 fixes.

**2026-10-08 Claude ("I don't know" fix):** Cause: named-file source reached the model, but the model still refused and the grounding guard could drop the whole reply, so the sender got "I couldn't confirm... I won't guess". Fix on claude/che-latency-optimization-8ruaus, commit e041b20 (pushed, no PR): `lookupAnswer` answers named constants and functions from their own line; a refusal or empty guarded reply is retried once with `SOURCE_RETRY_NOTE`; the last-resort reply says nothing in the pinned commit answers. Worker tests 727/727 locally. Not yet verified live or on main. Still open: the "Working on it" follow-up stall (needs live Worker logs) and K1 (coding test) still unanswered in substance.

## 3. Queue: the owner's open requests, in order

Do them top to bottom. Mark each one `DONE (PR #, SHA)` or `WIP (branch, next step)` here.

1. **Trading Room learning engine.** DONE first cut (PR #178, 1ca27c0). Next: intraday futures data once the owner has a feed, and showing the learning in the Trading Room UI.
   - Agents permanently backtest and paper-trade ES, NQ, MES and MNQ, many trades a day, and learn from the results.
   - Show accuracy, P&L and trade counts.
   - Build on `server/cloudflare/trading_lab.js`: `backtest`, `backtestAll`, `paperTick`, `stats` and `readBook` already exist.
   - Deterministic code, no AI tokens, real market data only, no real money ever. Paper trading only.
   - The sandbox can't reach market sites, so test with recorded candles.
2. **Autonomy exam (5 levels)** run against CHE: code herself, self-correct, learn from mistakes. A real run needs the deployed Worker and engines. Report honestly, level by level.
3. **CHE 2.0** (keep the black/teal identity and voice-first design):
   - App-wide navigation: never trapped; swipe back or down, Back/Close, state preserved.
   - Rooms instantly understandable, with spatial transitions.
   - Office employee cards showing real work only: Working, Queued, Blocked, Finished or Available.
   - A searchable Vault of history.
   - A real War Room group chat ("CHE, open a War Room with Atlas, Mira and Nova"), with CHE coordinating. Build on #169.
   - Agents Nova, Atlas, Mira, Knox, Sage, Lyra and Iris as distinct mini-people whose animation reflects their real state.
   - Voice commands: "Go back", "Close this", "Take me home", "Open the Office", "Open the War Room", "Show Atlas", "What is Atlas working on?"
   - Verify at iPhone 17 Pro Max size (440×956 pt).
4. **Starred repos integration**: waiting on the owner's names.
5. **NinjaTrader login**: waiting on the error text.

---

## 4. The coding process (do it exactly like this)

**Setup**
- The Flutter SDK must be on PATH. Run `tool/bootstrap.sh` if the repo has it.
- `flutter analyze` rewrites `analysis_options.yaml`. **Always** run `git checkout analysis_options.yaml` before committing.
- Worker: `cd server/cloudflare && npm test` (node:test, all `*.test.mjs`).

**Branch**
- New work: `git checkout -B <ai>/<topic> origin/main`.
- Continuing work: check out the existing branch and merge `origin/main` in.

**Read before writing**
- Find the real code first with `grep -rn`. Never assume a file or function exists.
- Match the surrounding style and comment density.
- Make small, surgical edits. Python or sed is fine for exact replacements; assert the old text exists exactly once.

**Never break these**
- `lib/browser/che_browser.dart`.
- The navigation logic in `lib/home_state/send.dart` (add, don't rewrite).
- `_openSpeechTurn` in `lib/home_state/voice.dart`, and `lib/che_speech_pipeline.dart`.
- `_mic` (`lib/che_mic_supervisor.dart`).
- Passwords only in `lib/security/che_password_vault.dart`.

**Every new or changed screen**
- VoiceOver `Semantics` labels on every button.
- Spoken result of every action (`speakText` / `_say`).
- Large-text caption.
- A voice route to every action.
- Never "tap here".

**Verify before every push**
```bash
dart analyze --fatal-infos lib test        # CI uses --fatal-infos
flutter test                               # all must pass
(cd server/cloudflare && npm test)         # when the Worker changed
git checkout analysis_options.yaml
```
- Add a test for every new behavior, including the owner's exact words for voice commands.
- For visual work, render the painter to a PNG in a throwaway test and look at it, then delete the test.

**Commit and PR**
- Clear commit message: what changed for the owner and why.
- One PR per topic; the PR body lists what changed, how it was verified, and what was not verified.
- Do not merge until the owner says "merge".

**Merge and deliver** (only after the owner approves)
- Put `[worker-deploy]` in the merge title if `server/cloudflare/` changed. That deploys the Worker.
- Then dispatch `che-shorebird.yml` (`mode=patch`) on main for Dart OTA.
- Native (Swift/iOS) changes need a full app build; say so.

**CI red on your PR**
- Root-cause it and fix it.
- Never skip or disable a test.
- Never use an empty commit to re-run CI.

**Owner style**
- Voice-first replies: short, plain, honest.
- Fewest tokens without losing speed or quality.

---

## 5. Map of the code (where things live)

- **App shell:** `lib/main.dart`. `_CHEHomeState` is split into `lib/home_state/*.dart` extensions (voice, microphone, send, security, hub_rooms, memory).
- **Brain:**
  - `lib/brain/che_brain_space_model.dart`: layout, brain shape, camera.
  - `lib/brain/che_brain_space.dart`: controller with neural pulses, painter, gestures, callout.
  - `lib/home/che_memory_brain.dart`: dots from real memories, including `conversation_memories`.
- **Worker:**
  - `server/cloudflare/worker.js`: the Durable Object `CheState`. `fetch` wraps `handleRequest`, and every owner `/api/chat` turn becomes a memory through `brain_memory.js`.
  - Router: `ai_router.js`. Self-coding: `self_development.js`. Trading: `trading_lab.js` and `markets.js`.
- **Voice:**
  - `lib/home_state/voice.dart` (`_openSpeechTurn`, `_initNativeIosVoice`) and `lib/home_state/security.dart` (`_restartWakeListener`, `_handsFreeOn`).
  - Native iOS: `ios/Runner/AppDelegate.swift`. Kokoro on-device TTS: `lib/che_kokoro_voice.dart`.
- **UI prefs and voice commands:** `lib/che_ui/che_ui_preferences.dart` and `che_ui_voice_command.dart`.
- **CHE's self-knowledge** (read by every study and coding agent): `server/cloudflare/che_self_knowledge.js`.
