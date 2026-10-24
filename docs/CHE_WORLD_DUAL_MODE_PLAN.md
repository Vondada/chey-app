# CHE World — Dual Mode Playable Prototype

Owner approved 2026-10-24: combine GTA-style free roaming with Sims-style office management in ONE CHE World experience.

## Milestone 1: vertical slice
- Reuse the existing Flutter Office and Three.js assets in `assets/office3d/index.html`, `lib/widgets/office_3d_view.dart`, and existing GLB crew in `assets/characters/crew/`. Do not introduce a second agent runtime or duplicate the Create room.
- Provide **Explore** mode: FIRST-PERSON viewpoint inside rooms, accessible on-screen joystick or directional controls, camera look/orbit, walk/run, collisions, approach interaction prompts, enter/exit rooms. Touch + keyboard + spoken command alternatives.
- Provide **Manage** mode: overhead/isometric camera with pinch zoom/pan, select an agent/desk, inspect genuine runtime status, dispatch existing authorized tasks using existing handlers. Never fabricate agent work.
- One shared scene graph, room identity, agent IDs, and authoritative task state; changing mode preserves avatar position, selection, and real job statuses.
- First playable path: start in isometric cutaway HQ overview -> select Vale's studio door -> transition to first-person interior -> interact with Vale and open existing Create/Film Studio -> exit to overview. Manage mode can select Vale and open the same actual feature.
- Add visible **Explore / Manage** mode control with VoiceOver labels and spoken navigation; no unsolicited speech on entry. Clear fallback if WebView/3D unavailable.
- Remove featureless mannequin crowd/placeholders from this experience; use only real verified agent models or clearly labeled temporary non-human markers. Do not delete owner assets.
- Keep existing Office navigation intact; prototype behind a discoverable CHE World entry or feature flag until tests pass.
- Performance: adaptive mobile quality, paused offscreen render loop, graceful low-memory behavior, iPhone thermal limits.

## Owner's visual reference and room navigation (2026-10-24)
- Owner supplied an image in ChatGPT (NOT stored in GitHub) of a polished isometric, cutaway multi-room sci-fi headquarters with visible hallways, furnishings, agents, doors and central lobby. Claude cannot see this image unless the owner separately attaches it; use this detailed description as the reference, not an assertion that Claude saw it.
- Preserve that **overhead Sims-style overview** as the primary HQ view; zoom/pan, select rooms and see authentic activity. Entering a room switches to **first-person**, not third-person. Leaving returns to the same overhead map position.
- Each agent has a dedicated room: Vale—Create/Film; Lyra—Music; Knox—Security; Nova—Operations; Atlas—Code; Mira—Research; Sage—Knowledge; Orion—Trading simulation; Iris—Insights. CHE coordinates the shared central Office. Use existing room mappings as source of truth and reconcile naming before wiring routes.
- Doors connect rooms to navigable corridors. Allow sensible adjacent room-to-room shortcuts, plus a central Collaboration Room/Office. An agent may move or be shown collaborating only when there is a real assigned cross-agent workflow; do not fabricate agent location or activity.
- Navigation must have real accessible routes: choose room by name, enter room, exit room, go to agent, go to collaboration room, return to overview. Never force visually navigating 3D to reach a tool.
- Preserve the polished architectural feel, but do not recreate copyrighted assets or claim to own the supplied reference art. No mannequin crowds or fake staff.

## Real-work mission system
- Missions are guided entry points into CHE's existing authorized work, NOT fake game tasks. Every mission must produce a verifiable real-world artifact or state change (code PR/test, film render/storyboard/MP4, audio file, sourced report, security review, saved research, paper trading journal/backtest).
- Mission lifecycle: available -> accepted -> delegated via existing CHE command/workflow handlers -> real queued/running/review status -> verified result or failed/blocked. Keep receipts, output links, provenance and retries; never show completion without evidence.
- Example: enter Vale Film Studio -> request 30-second video -> real script/storyboard/render job -> playable finished file only after verification. Example: Atlas + Knox collaboration -> real code and security review, with separate evidence.
- Side missions can be short useful tasks (draft a video title, fix one issue, summarize an article, review a PR, create a thumbnail) and may optionally contribute to larger projects. No invented rewards that misrepresent external outcomes.
- All consequential actions remain behind existing permissions and approvals; no automatic live trades, paid actions or publishing.

## GPU role
Colab T4 is for Blender asset generation and offline rendering, NOT the iPhone real-time graphics processor. Reuse #517 GPU Jobs/Pair Colab once actually merged/deployed; no claim of connection until token and worker heartbeat are verified. Export optimized GLB/animations for real-time Three.js and retain high-poly assets for cinematics.

## Acceptance criteria
1. Isometric overview matches owner-described cutaway HQ; selecting Vale's door enters first-person room, interacts with Vale and navigates to Create.
2. Exit returns to overview; agents show real statuses, room-to-room doors work, collaboration hub is accessible.
3. Overview and interiors share world and task state; one side mission produces a verifiable real artifact and receipt.
4. VoiceOver, keyboard/touch, and spoken alternatives; Read This on demand, no auto-narration.
5. Flutter analysis/tests and relevant web scene tests green, plus on-device proof before saying installed.
6. PR review green; merge/deploy/OTA only after verified prerequisites, never report unverified release.

## Scope limits
This milestone is NOT a complete GTA or Sims game, multiplayer, or a promise of five-minute cinematic production. No live trading, purchases, or irreversible actions from game UI without existing authorization rules.

## Next developer action
Inspect current HEAD, AGENTS.md and che-mailbox LIVE-HANDOFF; check whether this branch already has prototype code before writing; integrate into existing office instead of overwriting Claude's active Create/GPU work. Commit tested increments and report exact SHA, PR, and build status.
