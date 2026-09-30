# CHE Core Rebuild Audit

## Voice / microphone / audio

Current voice-related files before this rebuild:

- `lib/main.dart` — owns the app-level wake/conversation flow and still contains legacy `speech_to_text` / `flutter_tts` fallback setup.
- `lib/che_native_voice.dart` — bridge to the native iOS wake/fallback voice implementation.
- `lib/che_realtime_voice.dart` — WebRTC/OpenAI Realtime transport used for normal iPhone conversation.
- `lib/che_voice_state.dart` — deterministic voice state.
- `lib/che_voice_ui.dart` — voice orb and diagnostics.
- `tool/bootstrap.sh` — generates the native iOS speech / AVAudioSession bridge at build time.
- `lib/che_live_voice.dart` — older optional WebView Realtime surface. It is not the normal conversation path.

### Mic ownership problem being fixed

The important failure mode was that native wake/fallback speech and WebRTC could both exist in the app lifecycle, while the UI could report Realtime as connected before actual OpenAI audio was proven. The rebuild makes normal conversation prefer one verified Realtime path and treats native voice as a labeled fallback only.

## Agent / Office

- `server/cloudflare/worker.js` — capability routing, Office coworker staffing, chat orchestration, memory, projects, plugins, background work and Realtime session minting.
- `lib/office_scene.dart` — Office presentation.
- `lib/main.dart` — Office state loading and owner actions.

The old full-agent path automatically added General Intelligence Partner and Execution Partner to ordinary turns. This rebuild removes those always-on coworkers. CHE remains the owner-facing manager and delegates only for concrete capability needs.

## Plugins / tools

- `server/cloudflare/worker.js` — server-side plugin catalog, capability routing and connectors.
- `lib/che_plugin_manager.dart` — plugin UI.
- `lib/che_app_portal.dart` — connected app portal.
- `lib/che_account_bridge.dart` — secure owner/account bridge.

## Memory

- `server/cloudflare/worker.js` — saved memory and inferred preference logic.
- `lib/main.dart` — local state hydration and explicit owner memory actions.

## Immersive rooms

- `lib/office_scene.dart`
- `lib/create_gallery_scene.dart`
- `lib/music_studio_scene.dart`
- `lib/devices_hub_scene.dart`
- `lib/insights_brain_scene.dart`
- `lib/che_immersive_hub_shell.dart`

The existing visuals are retained. Real data/actions already back projects, Office coworkers/jobs, device connection states and insight nodes. Remaining purely decorative room props must stay decorative; anything presented as tappable must resolve to real CHE data/action or clearly say that a connector is not connected.

## Rebuild decisions

1. OpenAI Realtime must prove real inbound audio before the UI may say `OpenAI Realtime`.
2. If Realtime session creation or audio proof fails, CHE visibly enters `Native fallback`.
3. Wake/App Intent starts Realtime instead of playing an Apple TTS acknowledgement first.
4. CHE is the primary owner-facing manager. Work Agent Mode (`agent_mode=full`, composer Agent) may queue La Agencia Office jobs and panel specialists for actionable work; it still must not spawn generic busywork on casual chat.
5. Office delegation must correspond to a concrete capability, La Agencia specialty match, or useful multi-step owner work (see `docs/CHE_WORK_AGENT_MODE.md`).
