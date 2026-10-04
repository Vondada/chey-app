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

## 2. Current position (updated by: Claude, 2026-10-04 13:40 UTC)

**Merged to main today**, on the owner's "merge". Every merge with a Worker change carried `[worker-deploy]`.

| PR | Merge SHA | What |
|---|---|---|
| #170 | 1af29cf | Voice: no mic on launch (hands-free opt-in), longer end-of-turn waits, fluent Kokoro prefetch, Hide-keyboard button |
| #169 | d437935 | Agent group chats and the CHE World globe |
| #168 | 5c93bb1 | Brain: brain-shaped living neural network, every owner chat turn becomes a memory (`brain_memory.js`), 3D orbs, inverted offline brain, callout card |
| #167 | 60f2de1 | Trading Room live chart, voice switching, spoken price |
| #171 | dbf370b | This live-handoff rule in AGENTS.md and CHE's self-knowledge |

**State of main (dbf370b):**
- `dart analyze --fatal-infos`: clean.
- `flutter test`: 201 pass.
- Worker `npm test`: 497 pass.

**Pending checks:**
- The Shorebird OTA patch (`che-shorebird.yml`, `mode=patch`) was dispatched on main. Check that the run went green.
- The Swift end-of-turn timing in #170 needs a full app build to reach the phone.
- The Worker deploys (from `[worker-deploy]`) are not yet confirmed. Check the Deploy workflow runs.

**Not Claude's:** #166 (`chatgpt/autonomy-orchestration-hardening`) belongs to ChatGPT.

**Since then (2026-10-04 evening):**
- #175 merged (c8804a1): Codex review fixes for the group chats. Shorebird OTA patch dispatched.
- ChatGPT merged #173 and #174 earlier; Claude reviewed both, no conflicts.
- **Open PR #176** (`claude/autonomy-edit-recovery`, head 8d15113; adds deterministic code-graph discovery `traceSourceGraph` + the autonomy exam `discovery_exam.test.mjs`, 524 Worker tests pass. GROUND TRUTH: the War Room renders through lib/widgets/che_native_scene_world.dart; assets/office3d/warroom.html is DEAD, never edit it). Owner said "do NOT merge yet". It fixes the live War Room autonomy stress-test failure at its root causes:
  - evidence packing hid the target file's real code;
  - failed anchors gave no usable feedback;
  - "Create the PR. Continue…" started a new job;
  - status contradicted itself (stale receipts, a failed job beside a waiting change, stale pending changes);
  - false "three approaches" failure wording.
  Worker tests: 519 pass. Needs `[worker-deploy]`, then re-run the War Room stress test live.
- **Owner's starred repos**, from his screenshots, in GitHub's order:
  - affaan-m/ECC (agent harness: skills, instincts, memory, security);
  - Panniantong/Agent-Reach (agent web reading/search CLI);
  - fffaraz/awesome-cpp;
  - papers-we-love/papers-we-love;
  - jaywcjlove/awesome-mac;
  - Hack-with-Github/Awesome-Hacking.
  Verify exact names on GitHub before integrating (queue item 4).
- **Note:** "Chase" means **CHE**.

**PR #176 (head 21e94b0) now also adds:**
- **Full coding autonomy up to the owner's merge:** CHE opens the draft PR herself after independent review.
- **The 5-level autonomy exam** (`server/cloudflare/autonomy_exam.js`). Owner commands: "run the autonomy exam", "run autonomy exam level N", "autonomy exam results".
- Worker tests: 531 pass.
- After merge plus `[worker-deploy]`, the owner runs the exam live. Record the results here.

**Next:** queue item 1 (Trading Room learning engine). Nothing is half-done; no WIP branches.

**Owner answers still pending (don't guess):**
- His 5 starred repo names.
- The exact NinjaTrader login error text.

## 3. Queue: the owner's open requests, in order

Do them top to bottom. Mark each one `DONE (PR #, SHA)` or `WIP (branch, next step)` here.

1. **Trading Room learning engine.**
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
- No fake data anywhere: real memories, tasks and agent state only.

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
