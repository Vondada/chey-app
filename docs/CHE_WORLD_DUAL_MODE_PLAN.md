# CHE World — Dual Mode Playable Prototype

Owner approved 2026-10-24: combine GTA-style free roaming with Sims-style office management in ONE CHE World experience.

## Milestone 1: vertical slice
- Reuse the existing Flutter Office and Three.js assets in `assets/office3d/index.html`, `lib/widgets/office_3d_view.dart`, and existing GLB crew in `assets/characters/crew/`. Do not introduce a second agent runtime or duplicate the Create room.
- Provide **Explore** mode: third-person avatar, accessible on-screen joystick or directional controls, camera follow/orbit, walk/run, collisions, approach interaction prompts, enter/exit rooms. Touch + keyboard + spoken command alternatives.
- Provide **Manage** mode: overhead/isometric camera with pinch zoom/pan, select an agent/desk, inspect genuine runtime status, dispatch existing authorized tasks using existing handlers. Never fabricate agent work.
- One shared scene graph, room identity, agent IDs, and authoritative task state; changing mode preserves avatar position, selection, and real job statuses.
- First playable path: spawn at CHE headquarters -> move to Vale -> interact -> open existing Create/Film Studio, then return; manage mode can select Vale and open same actual feature.
- Add visible **Explore / Manage** mode control with VoiceOver labels and spoken navigation; no unsolicited speech on entry. Clear fallback if WebView/3D unavailable.
- Remove featureless mannequin crowd/placeholders from this experience; use only real verified agent models or clearly labeled temporary non-human markers. Do not delete owner assets.
- Keep existing Office navigation intact; prototype behind a discoverable CHE World entry or feature flag until tests pass.
- Performance: adaptive mobile quality, paused offscreen render loop, graceful low-memory behavior, iPhone thermal limits.

## GPU role
Colab T4 is for Blender asset generation and offline rendering, NOT the iPhone real-time graphics processor. Reuse #517 GPU Jobs/Pair Colab once actually merged/deployed; no claim of connection until token and worker heartbeat are verified. Export optimized GLB/animations for real-time Three.js and retain high-poly assets for cinematics.

## Acceptance criteria
1. Explore avatar moves and camera follows; can interact with Vale and navigate to Create.
2. Manage camera switches without reloading scene; agents show real statuses and existing task actions.
3. Modes share world and task state, including after toggling back and forth.
4. VoiceOver, keyboard/touch, and spoken alternatives; Read This on demand, no auto-narration.
5. Flutter analysis/tests and relevant web scene tests green, plus on-device proof before saying installed.
6. PR review green; merge/deploy/OTA only after verified prerequisites, never report unverified release.

## Scope limits
This milestone is NOT a complete GTA or Sims game, multiplayer, or a promise of five-minute cinematic production. No live trading, purchases, or irreversible actions from game UI without existing authorization rules.

## Next developer action
Inspect current HEAD, AGENTS.md and che-mailbox LIVE-HANDOFF; check whether this branch already has prototype code before writing; integrate into existing office instead of overwriting Claude's active Create/GPU work. Commit tested increments and report exact SHA, PR, and build status.
