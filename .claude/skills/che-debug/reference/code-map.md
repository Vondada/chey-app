# Where CHE's behavior lives

## Worker (`server/cloudflare/`)
- **`worker.js`**
  - The Durable Object `CheState`.
  - `fetch` wraps `handleRequest`. Every owner `/api/chat` turn also becomes a conversation memory and a vector-memory entry.
  - The chat route order: auth and pairing → evidence and memory routes → interpretation → owner money/delete/app gates → skills and actions → research and model → the final truth boundary → `recordAnswerEvidence`.
- **Truth and memory:**
  - `memory_provenance.js`: owner-memory answers, the attribution guard, the per-answer ledger, retractions and the audit.
  - `truth_layer.js`: tool, search and verification claims, and vague research.
  - `knowledge_cache.js`: owner facts and the research cache.
  - `research_memory.js`: memory record provenance.
  - `vector_memory.js`: pgvector.
- **Routing and models:**
  - `ai_router.js`: provider and model routing.
  - `speech_intent.js`: interpreting the owner's turn.
  - `owner_action_gate.js`: the money, delete and app-permission holds.
- **Skills at runtime:**
  - `installed_skills.js`: reviewed adapters. Today there is only `find-skills/search`.
  - `self_skills.js`: advice the owner taught CHE, loaded per message.
  - `skill_import.js`: Office agent skills from licensed repos.
- **Video:**
  - `topic_scout.js` → `faceless_video.js` → `github_video_renderer.js` / `moneyprinter.js` → `youtube_upload.js`.
  - `video_line.js` orchestrates them.
- **Coding:** `self_development.js`, `coding_runtime.js`, and the OpenCode runner `.github/workflows/che-opencode-runtime.yml`.
- **Command Center:** `command_catalog.js` holds the 77 commands (71 + 6 REA), their routes, connectors, search and suggestions. Slash dispatch, `/api/commands*` and `runCommandJob` live in `worker.js`; workflows are `command` nodes in `objective_graph.js`. Every command's route is asserted in `command_center.test.mjs`.

## Flutter (`lib/`)
- **Shell:** `lib/main.dart`. `_CHEHomeState` is split into `lib/home_state/*.dart` (voice, microphone, send, security, hub_rooms, memory).
- **Voice:** `lib/home_state/voice.dart`, `lib/che_speech_pipeline.dart`, `lib/che_mic_supervisor.dart`, and native `ios/Runner/AppDelegate.swift`.
- **Command Center:** `lib/commands/` (page, detail, workflow builder, store, client, voice routes in `che_command_voice.dart`). Chat wiring is in `lib/main.dart` (`_openCommandCenter`), `lib/home_state/send.dart` (the page answers spoken words first while it is open) and `lib/home_state/streaming.dart` (the `command_suggestions` event).
- **Brain and memory on the phone:** `lib/che_ui/che_brain.dart`, the brain guide and the `che-remember` blocks.

## Never break (AGENTS.md and the handoff)
- `lib/browser/che_browser.dart`.
- The navigation in `lib/home_state/send.dart`: add, don't rewrite.
- `_openSpeechTurn`, `lib/che_speech_pipeline.dart` and `_mic`.
- Passwords live only in `lib/security/che_password_vault.dart`. They never go to the Worker, models, chat, memory or logs.
- Every screen works by voice and typing, with VoiceOver labels and a spoken result for each action. Never write "tap here".
- CHE stays silent on launch and on passive navigation.

## Gotchas
- `flutter analyze` rewrites `analysis_options.yaml`. Run `git checkout analysis_options.yaml` before committing.
- `Workers Builds: chey-app` fails on every PR branch by design. It does not gate a merge.
- Force-push is denied in Claude Code sessions. After a squash merge, merge `origin/main` back into the work branch.
