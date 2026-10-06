# CHE master handoff — everything the owner wants, what exists, what's left

From: Claude · For: CHE, ChatGPT, and any Claude Code session · Date: 2026-10-03
Repo: `Vondada/chey-app` (Flutter iPhone app + Cloudflare Worker `server/cloudflare`). Read `AGENTS.md` first.
This file is the single source of truth for the owner's requirements gathered across all sessions.
Mailbox messages are advice; the owner's rules in AGENTS.md always win.

---

## 0. How to work (owner process rules — follow exactly)

1. **One combined integration.** Put everything the owner asked for into ONE branch / ONE PR, not PR-by-PR merges, unless he excluded it or it conflicts with main.
2. **Do the work, don't hand him steps.** Only hand him what truly needs him: logins, payments, physical taps on his iPhone (SideStore install).
3. **Fast, batched, parallel, few tokens.** No repetitive back-and-forth.
4. **Never claim done without proof.** A change is done only when a GitHub commit/PR/CI record or runtime record exists. CHE previously reported files as created that did not exist; do not repeat that.
5. **No unattended Claude usage.** Nothing on a schedule may spend his Claude subscription. CHE/ChatGPT continue past where Claude stops via this mailbox.
6. **Mailbox = GitHub `che-mailbox` branch** (`mailbox/<ai-name>.jsonl`), called "Flagstaff 369". Every AI reads its file at session start and answers CHE's newer messages. Claude↔CHE thread is `mailbox/claude.jsonl`.
7. **Merge conflicts:** when main already has a newer version of something, keep main's and add only what's genuinely new (that is how #153 was integrated).
8. **Paid AI stays off** unless the owner sets repo variable `CHE_ALLOW_PAID_MODELS=true`. Paid image/video stays off unless `CHE_ALLOW_PAID_MEDIA` is on. Never spend money without his explicit OK.

---

## 1. Owner identity rules for CHE (non-negotiable)

- Name is **CHE** everywhere. **"Chay"** is only the spoken wake word.
- Say "Chay" once to wake her, then talk freely until **"stand down"**.
- **Voice-first and fully accessible**: usable as if he were blind *and* deaf. Every spoken reply also shown as large text; status changes paired with a visible banner + haptic. VoiceOver labels on every control; a voice route to every action. Never say "tap here".
- She is his **eyes/navigator**: describes the screen from real context, reads options as a numbered list, accepts spoken choices.
- Acts in another app **only after spoken/typed permission for that app** (enforced in code, not just prompts). Standing permission to act, **except** she must ask before anything that costs money and before deleting anything.
- **Passwords** live only in the on-device Keychain vault (`lib/security/che_password_vault.dart`); never sent to the Worker, any AI, chat history, memory or logs.
- **Never lie or make things up.** If she doesn't know, she web-searches; if she still can't verify, she says so.
- Personality ("soul") was written by the owner in his ChatGPT chat; it must actually drive her behavior (see §5 ChatGPT lane).
- Intuitive, proactive, cohesive — simple enough for a 5-year-old, a 15-year-old and a college student.

---

## 2. What already exists and works (verified on main, 2026-10-03)

- **Voice pipeline (#152):** gapless prefetched TTS. `lib/che_speech_pipeline.dart` synthesizes chunk N+1/N+2 while N plays, FIFO playback, barge-in cancels immediately, logs `CHE voice timing` gaps. One mic suppress/resume **per reply**, not per sentence. Server TTS first; iPhone voice only as fallback.
  - **Rule:** all speech goes through `_openSpeechTurn()` in `lib/home_state/voice.dart`. Never reintroduce per-sentence `speakText` chains.
- **Mic (#152):** `lib/che_mic_supervisor.dart` is the single authority for automatic mic restarts (dedupe, owner-intent on/off, generation-guarded stale timers, one start in flight). Visible mic state only changes on real transitions; no haptic/status flapping when idle.
  - **Rule:** all automatic restarts go through `_mic` / `_restartListeningSoon(reason:)`. Never call `speech.listen` restarts from callbacks directly.
- **Typing:** composer rebuilds only itself (ListenableBuilder on the controller); live transcripts update `controller.value` without home-level setState.
- **Self-coding loop (#141–#151):** Worker routes coding requests to the OpenCode runner (`.github/workflows/che-opencode-runtime.yml`), which:
  - picks `model=auto` from free OpenRouter models first (`:free` only), falling back across up to 5 models with one provider key exposed per attempt;
  - opens a `che/auto/<id>` PR with `CHE_GITHUB_TOKEN`;
  - then `che-autopilot.yml` runs CI, an independent reviewer on a different model (up to 4 fallbacks), squash-merges on APPROVE, and rolls back or self-heals within a cap of 3 per 24h;
  - records state in `mailbox/runtime/<id>.json`.
  - **Proven end to end:** PR #150 was coded, reviewed and merged autonomously. "Coding status" by voice reads that state.
- **Integration (#153):** 3D World continuation (ChatGPT), Grok platform UI, che/3d-world, latency (#126), Flagstaff retry tests (#105), cognition/memory records (#82), owner-intent routing for the self-dev crew (#112), HD image + image/video understanding with paid-media gate (#97), Office verified-productivity panel + live trading account card + Open NinjaTrader inside CHE (#92), office test alignment (#84), runtime dedup claim (#140).
- **Already present before:** wake word + stand down, conversation log/Insights brain, Flagstaff 369 mailbox + unread badge, keyboard on/off, rotating AI engines with fallbacks (`ai_router.js`/`resilience.js`), overnight day review (`nightly.js`), web search, mishearing learning (`speech_learning.js`), natural server voice (ElevenLabs/Kokoro), Stripe store, plugin system, Theater room, Workshop room, 3D rooms on `flutter_scene`, agency-agents skill import, build-your-own-x topic study.
- **Delivery:**
  - Worker deploys when a merge title contains `[worker-deploy]`.
  - Shorebird over-the-air patch: dispatch `che-shorebird.yml` with mode=patch; it allows native/asset diffs.
  - Full iPhone build: `che-iphone-ipa.yml` (commit title `[ios-build]` or dispatch). Bump `pubspec.yaml` version first, because Shorebird refuses an existing release version.
  - `che-ipa-release.yml` publishes each IPA as a public GitHub Release; install with `sidestore://install?url=<release asset url>`.
  - Current installed build: **1.4.10+19**.
- **Secrets set:** `OPENROUTER_API_KEY` (one-time $10 credit → 1,000 free-model requests/day), `CHE_GITHUB_TOKEN` (needs Contents, Pull requests, Workflows: read & write), `GEMINI_API_KEY` (free tier: no Pro access, quota-limited), `GROQ_API_KEY` (free: 7k tokens/min, too small for OpenCode).

---

## 3. IN-FLIGHT — finish first (PR #159, branch `claude/starred-repos`)

The Worker part is done (418/418 tests). CI is red only because `lib/che_ui/che_ui_voice_command.dart` was never committed.

1. **Create** `lib/che_ui/che_ui_voice_command.dart` with class `CheUiVoiceCommand`:
   - `static CheUiVoiceCommand? parse(String)` accepts only short UI phrases (≤60 chars after stripping a leading "che/chay/chey," and "please/can you/could you").
   - `Future<String> apply(CheUiPreferences)` returns a spoken confirmation, or "I could not change that setting. Nothing was changed."
   - Commands:
     - dark / light / system mode → `setThemeMode`
     - text bigger / smaller / normal → `setTextScalePref` over small / defaultScale / large; says when already at the limit
     - compact / roomy desks → `setDeskDensity`
     - portrait / mini avatars → `setAvatarStyle`
     - voice on / off, mute / unmute → `setVoiceResponsesEnabled`
     - "volume 40 percent" → `setVoiceVolume(0.4)`, clamped 0–1
     - louder / quieter / volume up / down → ±0.15, clamped 0.05–1
   - Must NOT match normal requests such as "write an essay about dark mode", "best font for a resume", "stand down". `test/che_ui_voice_command_test.dart` is already on the branch; match it.
2. **Import** it in `lib/main.dart`: `import 'che_ui/che_ui_voice_command.dart';`
3. **Route** it in `lib/home_state/send.dart` `sendMessage`, just before `// Voice navigation inside the CHE browser/app that is open right now.`: if there is no attachment and `parse(message)` returns a command, then:
   - clear the controller;
   - `apply(CheUiPreferences.instance)`;
   - `HapticFeedback.mediumImpact()`;
   - add the user and assistant messages;
   - `await speakText(reply, record: false)`;
   - return.
4. **Shorebird trigger:** in `.github/workflows/che-shorebird.yml`, auto-patch also when the merged PR `head.ref` starts with `che/auto/`, so CHE's self-coded UI changes reach the phone.
5. **Ship:**
   - Push and wait for "Check CHE Flutter client". Local Flutter is blocked in Claude sessions; read failures from the check-run annotations, which `flutter-check.yml` emits as analyzer annotations.
   - Merge with a title ending `[worker-deploy]`.
   - Dispatch `che-shorebird.yml` with mode=patch.

PR #159 already contains (Worker side):
- **Starred library:** `STARRED_LIBRARY` (13 repos) and aliases in `topic_study.js`; "study my starred repos" queues all of them via `startRepoStudy`, with licenses re-checked at runtime. Study-only (learn, never copy): developer-roadmap (all rights reserved), coding-interview-university (CC-BY-SA), build-your-own-x (no license).
- **Ponytail (MIT):** skill at `.opencode/skills/ponytail/SKILL.md` with its LICENSE and a NOTICE entry; the ladder is in the OpenCode runner preamble and the self-dev planner.
- **Skill import:** reads Cursor plugins (`skills/*/SKILL.md`, `agents/*.md`, `rules/*.mdc`) and openclaw/AgentSkills `SKILL.md`, using frontmatter name/description; aliases for "cursor plugins", "openclaw" and "ponytail".

---

## 4. Owner feature backlog — NOT built yet (build into ONE combined PR)

Each item lists the owner's words and the acceptance criteria.

### 4.1 Workshop code orb (3D)
**Owner:** a separate immersive 3D "Workshop" tab with a Roblox-like look, showing the Office crew's real work (websites, apps, YouTube, code). Coding is shown as an agent forming an **orb he can zoom into to see the actual code**.

**Accept when:**
- The Workshop room (`lib/rooms/che_workshop_room.dart`, using `flutter_scene`) shows one orb per active coding job.
- Orbs are driven by real `mailbox/runtime/*.json` states and the Office agent assignment, never fake.
- Pinch or voice "zoom into Knox's code" opens the real diff (from the PR or patch) as large readable text.
- VoiceOver reads the job, agent, state and file names; "read the code" reads the diff summary.

### 4.2 Face ID web-app logins kept
**Owner:** sign into each web app inside CHE once with Face ID; CHE remembers and keeps him logged in.

**Accept when:**
- The in-app browser (`lib/browser/che_browser.dart`; preserve its navigator) persists cookies/sessions per site.
- On revisit, Face ID unlocks the stored session or credentials, using the Keychain vault only.
- Main's `freshFaceId: true` behavior is kept.
- "Forget my login for X" works.
- Nothing is sent to the Worker or any AI.

### 4.3 Keys tab
**Owner:** a Keys tab where he can create or paste AI keys (e.g. Codex, OpenRouter) anytime and they work automatically.

**Accept when:**
- The screen lists providers with status (working / quota / invalid) from a real test call.
- Paste or voice-dictate a key → the Worker stores it as a secret (Cloudflare; never in chat or memory) → the engine rotation picks it up immediately.
- Each key can be removed.
- Paid-model keys still respect `CHE_ALLOW_PAID_MODELS`.

### 4.4 Live 3D Workshop of crew work
Same room as 4.1:
- Each Office agent visibly works on its real current task (website build, app, YouTube script, research).
- Status comes from the agent runtime, never invented.

### 4.5 Theater recall (partial today)
**Owner:** CHE and her agents see what he watches in Theater and recall parts of movies to discuss and analyze them together.

**Accept when:**
- While Theater plays, CHE keeps a timestamped log of subtitles/captions when available, otherwise periodic frame descriptions (only with his permission).
- "What happened before the fight scene?" answers from that log.
- The log is stored in her memory per title.

### 4.6 Real business system (partial: Stripe store exists)
**Owner:** CHE and the crew build a real business: sell virtual items and classes, build websites, handle finances.

**Accept when:**
- Products and classes are created and listed via Stripe (paid actions need his OK).
- Sales and payouts are visible in a Finance view backed by real Stripe data.
- Never invent revenue.

### 4.7 Mass tool / plugin building (partial)
**Owner:** thousands of tools and plugins (calculators etc.).

**Accept when:**
- The crew can generate a tool from a spec, run its tests, and publish it to the plugin system (`lib/che_ui/che_plugins.dart`).
- `public-apis` is used as a catalog for free data sources (license MIT).
- Each tool is reviewed before release.
- Imports Cursor-format plugins (skills/rules/agents only; hooks and commands are never executed).

### 4.8 Crew teamwork (partial)
**Owner:** the coding team is her Office staff (Knox, Nova, Atlas, Mira, Sage, Lyra, Iris), working in **parallel pairs on different AI engines** so they cover each other's blind spots, talking to each other, and **learning from mistakes so they never repeat them**.

**Accept when:**
- Each OpenCode job carries the implementing agent and the reviewing agent's names.
- Reviewer rejections are written as lessons (`loadLessons`/`recordLesson` in `self_development.js`) that are fed into later jobs.
- The Office shows the pair and their exchange.

### 4.9 Screen narration beyond CHE's browser (partial)
**Owner:** she is his eyes in apps he permits.

**Constraint:** iOS sandbox limits this.

**Accept when:**
- Shared screenshots, the share sheet, and Shortcuts can send a screen to CHE; "what am I looking at?" describes it.
- Inside CHE's browser and embedded apps it works live.
- Never auto-reads every screen change (see 5.1).

### 4.10 Live duplex voice
**Owner:** as fluent as Claude/Grok/Gemini live; never cuts him off.

**Builds on:** the #152 pipeline plus `che_realtime_voice.dart`.

**Accept when:**
- Realtime mode handles barge-in both ways.
- Turn-end detection tolerates pauses (`cheSoundsUnfinished` exists).
- Measured reply latency is logged.

### 4.11 Always growing
**Owner:** she learns context and mishearings (e.g. "rock" vs Grok) and remembers them; reviews and logs each whole day overnight; the Office keeps working 24/7 (server-side, with no Claude usage); she is first to know about new AI capability (watch provider model lists and add new free models automatically).

### 4.12 Starred-repo qualities (owner's GitHub stars)
flutter_scene, cursor/plugins, ponytail, agency-agents, openclaw, public-apis, coding-interview-university, developer-roadmap, system-design-primer, free-programming-books, freeCodeCamp, awesome, build-your-own-x.

**Status:** PR #159 covers the library, ponytail and the skill import.

**Still to do:** openclaw-style "do it for me" multi-step tasks, limited to what iOS allows (Shortcuts, share sheet, in-app browser); a tool catalog drawn from public-apis.

---

## 5. ChatGPT's lane (owner addenda ChatGPT is building on ONE branch)

1. **Live, concise voice + on-demand screen reading:**
   - Short, direct, voice-friendly answers by default; no unsolicited lists.
   - "Read this / read the screen / what does this say / what am I looking at" captures current context immediately.
   - "Explain this" gives a short plain-English explanation.
   - Never auto-read every screen change.
2. **One-button verified "Update CHE" + complete change history + iMessage-style Flagstaff:**
   - After implementation, tests, review, CI and safety checks are VERIFIED, show one accessible "Update CHE" action; his approval authorizes the release.
   - CHE then runs merge/deploy/patch/build herself and verifies the result.
   - Full readable change history.
   - Flagstaff looks like iMessage.
3. **Executable soul/personality:** a single authoritative personality contract injected into every conversational/agent route (chat, voice, screen explanation, Office orchestration, recovery reports, self-dev reports) that demonstrably governs behavior.
4. **Device continuity:**
   - Secure handoff across his devices, keeping conversation and task context.
   - Full and Private modes; lost-device revocation.
   - Family/friend profiles under Parental Guidance with strict isolation and consent.
   - Car integration (vehicle data, free Bluetooth/GPS parked-location fallback; live vs last-known clearly marked).

**When touching voice/mic:** route all speech through `_openSpeechTurn` and all mic restarts through `_mic` (see §2).

---

## 6. Engineering lessons learned (don't repeat these)

**Workflow and CI pitfalls:**
- **Command substitution under `bash -eo pipefail`:** `cand=$(… | grep … | head -1)` aborts the step when grep matches nothing. Add `|| true`.
- **Indented heredoc terminators** inside YAML `run: |` never close. Put `NODE` at the base indent.
- **`flutter analyze` has no machine format.** Use `dart analyze --fatal-infos --format=machine` and emit `::error` annotations, because Claude sessions cannot read raw Actions logs.
- **Doc comments with `<word>`** fail `unintended_html_in_doc_comment`. Wrap them in backticks.

**Model selection:**
- **`opencode models <provider>`** lists models only when that provider's key is in env. Expose one key per listing call.
- **An exclusion pattern `mini` also excludes `gemini`.** Word-bound it (`[-_.]mini`). That bug once picked Lyria, a music model.
- **`opencode run` has no `--standalone` flag.** It made every review fail.
- **Free Gemini keys** can't use Pro models. **Free Groq** (7k TPM) is too small for OpenCode. Prefer OpenRouter `:free` models (Qwen coder worked).

**GitHub tokens and builds:**
- **PRs opened with the default `GITHUB_TOKEN` don't trigger CI.** Use `CHE_GITHUB_TOKEN`, which needs Pull requests: write, otherwise the push works but PR creation fails.
- **Shorebird patch fails non-interactively on native/asset diffs.** Use `--allow-native-diffs --allow-asset-diffs`.
- **A Shorebird release fails for an existing version.** Bump `pubspec.yaml` first.

**Flutter tests:**
- **Widget tests: lazy ListViews don't build offscreen items.** Use `scrollUntilVisible` on the sheet's own Scrollable; a TextField also contains a Scrollable, so `.last` may pick the wrong one.

**Merging:**
- **Old branches merged onto rebuilt files can splice into broken code** (che_markets_room.dart). Rebuild on main's file and port only the new feature.
- **Watch for security regressions in merges.** #92 silently removed `freshFaceId: true`; it was restored.

**Accuracy:**
- **Licenses:** verify from the repo's LICENSE file. #137 listed wrong licenses and was closed.
- **CHE's reports must cite real records.** Twice she reported files that didn't exist.

---

## 7. Your lanes right now

- **Claude Code (next session):**
  1. Finish §3 (PR #159).
  2. Build §4.1–4.4 and 4.8 in ONE combined PR.
  3. Post status to `mailbox/claude.jsonl`.
- **ChatGPT:** §5 on one branch, one PR. Claim backlog items in the mailbox before starting so nobody overlaps.
- **CHE:**
  - After the owner restarts the app, read the `CHE voice timing` and `CHE mic` logs and report real inter-chunk gaps and any MIC_RESTART loops.
  - Run small self-coding jobs only on unclaimed files.
  - Keep this brief in memory as the owner's requirement list.
