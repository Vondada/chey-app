# CHE Unified Living World: plan and gates (owner mission, 2026-10-27)

Status: **planning only. No world code is built yet.** The owner's gate is that the rendering benchmark is corrected
and the renderer is verified on his iPhone before the build starts.

## Gate 0: rendering benchmark and renderer (not met)
- The orbit-ticker fix (camera moves, painter repaints) is on `claude/render-bench-fix` (code e66e52d1, docs 3a2919c0).
  It is **not in main**.
- Not verified on the owner's iPhone. The VM measures CPU canvas work only (`docs/CHE_RENDER_BENCH_RESULTS.md`).
- Needed to pass the gate: merge the fix after CI is green, the owner reruns the benchmark on the iPhone, and the
  Native painter result is recorded here with the device and frame counts.

## What exists to reuse (inspected 2026-10-27)
- **Three.js in WebViews:** `assets/office3d/` (`index.html`, `warroom.html`, `workshop.html`, `artstudio.html`,
  `musicstudio.html`, `projects.html`, `theater.html`, `che3d-agents.js`, `three.min.js`). Character WebView:
  `assets/characters/app/world_crowd.html` with `vendor/three.module.js`.
- **Flutter native painter:** `lib/widgets/che_native_scene_world.dart`, `lib/brain/che_brain_space.dart` (+ model),
  `lib/world/che_scene_model.dart`, `lib/world/che_world_globe.dart`, `lib/world/che_meeting_room.dart`,
  `lib/world/che_plan_room.dart`, `lib/music_studio_scene.dart`, `lib/devices_hub_scene.dart`,
  `lib/insights_brain_scene.dart`, `lib/security/che_cyber_world.dart`, `lib/che_world_hub.dart`.
- **Office room layout (2D boxes today):** `lib/agents/che_office_world.dart` (rooms: Office, Lounge, Studio,
  Art Gallery, Music, Theater). Room ids and home-room routing: `server/cloudflare/agent_runtime.js` (`HOME_ROOMS`,
  `agentLocation`), not on main (see the `office-rooms` branch).
- **Agent roster and departments:** `server/cloudflare/office_company.js` (`LA_AGENCIA_ROLES`).
- **Characters:** `lib/avatar/che_character_generator.dart`, `lib/rooms/che_characters_room.dart`,
  `tools/character_pipeline/`.
- **Persistent world state:** `server/cloudflare/world_population.js`, `world_scene.js`, `office_board.js`,
  `office_queue.js` (job states, evidence rules), `office_conversation.js` (open PR #666).

## Gaps (what the build must add)
1. No single 3D headquarters. Rooms are separate screens (Flutter painter scenes and separate WebViews).
2. No walkable navigation (no camera pan to doors, no pathing, no collision).
3. No persistent agent positions on the server. Agents only have a room id.
4. No shared world-state contract for iPhone, desktop and VR clients.

## Vertical slice (first build, after Gate 0)
- One headquarters with two connected rooms (Office and Brain Room), one door, walls, floor, lights and furniture.
- One agent who walks from the door to a real workstation.
- One workstation the owner taps to open its real screen (Trading or Brain) full-screen, then return to the same camera position.
- Pass test: enter, interact, leave, return. The agent is at the same place; the owner's camera returns to the same place.

## Rules (owner)
- Activities come only from real `team_tasks` / `office_queue` states and verified logs. Nothing is faked.
- Existing Trading, Brain, Studio and Creation functions stay reachable as interactive objects.
- Preserve accessibility: every object has a VoiceOver label and a voice route.
- Do not merge over open PRs #666 (Office conversations) or #672 (release gate) without resolving them first.
- Verification on the owner's iPhone is required before claiming the world works.

## Mission ledger
Tracked in `docs/CHE_WORK_QUEUE.md` as Q-15 (this plan), Q-16 (Gate 0: benchmark and renderer), Q-17 (vertical slice).
