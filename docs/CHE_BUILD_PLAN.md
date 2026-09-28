# CHE build plan

Source brief: `docs/CHE_MASTER_PROMPT.txt` (the latest brief) and `docs/CHE_MASTER_SPEC.md` (the full spec).
Older notes: `docs/REBUILD_AUDIT.md`.

## Phase 1 — Current architecture audit

| Area | Where | State |
|---|---|---|
| App shell, chat, voice glue, hub tabs | `lib/main.dart` (~5.9k lines) | Works, but it's one big file. Split it by domain step by step. |
| Voice: Realtime/WebRTC, native fallback, Porcupine wake | `lib/che_realtime_voice.dart`, `che_native_voice.dart`, `che_wake_word.dart`, `che_voice_state.dart` | Works, with tests. One mic owner. Leave alone. |
| Immersive rooms (legacy) | `office_scene.dart`, `create_gallery_scene.dart`, `music_studio_scene.dart`, `devices_hub_scene.dart`, `insights_brain_scene.dart`, `che_immersive_hub_shell.dart` | Works. Visual style is older than the new kit. |
| New UI kit | `lib/che_ui/*` | Builds. The agents, Office floor and room backdrops are in use. The agent chat, brain, log and plugins parts are **not yet wired into `main.dart`**. |
| Backend | `server/cloudflare/worker.js` (one owner `CheState` Durable Object) | Works: pairing, chat (NDJSON), memory, owner context, projects, vault, jobs, plugins, Realtime token. |
| Agent Runtime | `server/cloudflare/agent_runtime.js` | **New.** See Phase 4. |
| CI / build | `.github/workflows/*`, `codemagic.yaml` | Flutter analyze/test and worker tests run in CI. IPA via GitHub Mac + Codemagic. Shorebird is not set up yet. |

## Phase 4 — Agent Runtime + Office (done in this pass)

Backend (`server/cloudflare/agent_runtime.js`, routed from `CheState`):

- `GET /api/agents` returns the roster with live status, CHE's own status, the working count and War Rooms.
- `POST /api/agents` creates an agent. It can be temporary and can take a first task.
- `GET /api/agents/:id` returns the profile, CHE-reviewed task history and meetings.
- `PATCH /api/agents/:id` takes `reassign`, `upgrade`, `downgrade`, `keep`, `retire` or `edit`.
- `POST /api/agents/:id/task` gives an agent a task. It is queued, the agent works it, and CHE reviews the result (APPROVED / NEEDS WORK).
- `POST /api/meetings` and `GET /api/meetings/:id` run the War Room. Agents draft in parallel, then each one cross-checks a teammate in character, then CHE synthesizes decisions, conflicts, recommendations and a final plan.
- `GET /api/agents/live` is a WebSocket that pushes a snapshot on every change (Durable Object hibernation API).
- Work runs from the Durable Object alarm, so it keeps going while the phone is locked. Work stuck in "running" is put back in the queue, so the status never claims work that isn't happening.
- The chat stream emits `{"type":"step"}` lines when CHE delegates.

App:

- `lib/agents/che_agent_runtime.dart` is the client plus a polling controller: fast while work runs, slow when idle.
- `lib/agents/che_office_floor_screen.dart` shows the Office floor, an agent desk sheet (message, reassign, upgrade, retire) and a hire-agent sheet.
- `lib/agents/che_war_room_screen.dart` is the War Room.
- Open it from Hub → Office → **Enter the Office floor + War Room**.

Deliberate trade-off: agents live in the owner's single `CheState` Durable Object instead of one Durable Object per agent. That keeps a single consistent store and needs no new Durable Object migration. The runtime module works on plain data, so moving to one Durable Object per agent later is a storage change, not a rewrite.

## Next phases (in order)

1. **Wire the kit chat into Home.** Use `CheAgentChat` with the `CheWorkerBackend` NDJSON adapter. Show `step` events as live step lines and `CheAgentChip` for "Delegating to Nova…". Put CHE's mini person next to the orb with Office status.
2. **Fix the known label bugs.** These are "Businessiness", "GALGALLERY", "Innovatiaation", "Of Devices", "light jht", the faded duplicate "CHE" title and the crowded 9-tab bar. Replace the tab bar with the room carousel plus a few primary anchors.
3. **Brain.** Add the Soul editor, `che-remember` facts in 7 categories, reflections, and a conversation log that also writes Files-app copies. Mirror it on the Worker.
4. **Plugins v2.** Add the manifest registry (`GET /plugins`), `che-plugin` install cards, rollback and Safe Mode.
5. **Self-development.** Add `che-update` cards, then `POST /self-update`, then a PR, then CI, then a Shorebird patch. The code must tell Shorebird-eligible changes (Dart only) apart from ones that need a full IPA rebuild.
6. **Rooms, one at a time:** Markets desk, Creator/Sound Studio, Art Studio, Devices garage, Browser v2 (tabs, reader, ask CHE). Each shows an honest "Connect" state when its service isn't set up.
7. **Split `main.dart`** into `voice/`, `memory/`, `projects/`, `browser/`, `apps/` and so on while it stays buildable.

## Phone test checklist (this pass)

- [ ] Pair the phone. Open Hub → Office → **Enter the Office floor + War Room**. CHE's desk is shown, and "0 working" when idle.
- [ ] Tap the person icon, hire "Research Partner" with a first task. Nova appears as *Waiting*, then *Researching*, then *Done*.
- [ ] Tap Nova. The history shows the result and "Approved by CHE" or "Needs work".
- [ ] Send Nova a task from the desk sheet. The status changes within about 2 s.
- [ ] Upgrade, then Use fast engine. The pill updates.
- [ ] Tap **War Room**, enter an objective and convene. The screen shows drafts, then cross-checks, then CHE's synthesis, with progress to 100%.
- [ ] Lock the phone mid-meeting and reopen. The meeting still finished on the server.
- [ ] Retire an agent. It leaves the floor, and anything it owned goes back to CHE.
- [ ] Tap CHE's desk. It returns to the conversation.
