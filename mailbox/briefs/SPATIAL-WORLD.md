# CHE Spatial World: a visual, grounded AI workspace (design, 2026-10-20)

Status: design only. Nothing here is built yet. Written by Claude from a read of `main` at
`502cf47` (plus open PR #376), for the owner and every AI that continues this work.

## 1. Concept brief

CHE's work today reaches the owner mostly as text: agent drafts, task states, Brain records,
trade ledgers, CI results. The Spatial World turns that same state into scenes and objects:
- agents are avatars;
- tasks are mission objects that move between stages;
- meetings happen at a visible table;
- suggestions are cards;
- knowledge is connected nodes;
- workflow state shows as place, colour and motion.

The one rule that keeps it honest:

> **Every visible object is a projection of one real record, and every change on screen is a
> change in that record.** No ambient "busy" animation, no decorative agents, no invented
> progress. If CHE cannot name the record behind an object, the object does not exist.

This is already the rule in the Office world (`che_office_world.dart`: "Nothing is animated as fake
work"), the War Room ("Every line on the board is a real message produced by the backend Agent
Runtime") and the Brain space ("Nothing here invents a memory"). The Spatial World generalises it
into one contract every room uses.

Voice-first and accessible by construction:
- every scene is also a spoken summary and a numbered list of its objects;
- every object can be inspected and read aloud;
- every action is reachable by voice, typing and VoiceOver;
- passive scene changes stay silent, under the October 11 owner rule. Speech starts only when the
  owner asks or acts.

## 2. What already exists (reuse, do not rebuild)

| Need | Already in CHE | File |
| --- | --- | --- |
| Agents with real status and location | `AGENT_STATUSES` (idle, researching, building, analyzing, meeting, waiting, reviewing, talking, done, offline), `agentLocation` → `WORLD_ROOMS`, `runtimeSnapshot` | `server/cloudflare/agent_runtime.js` |
| Avatars walking between rooms from real state | Office world, Office floor, avatar workshop | `lib/agents/che_office_world.dart`, `che_office_floor_screen.dart`, `/api/office/workshop` |
| Meetings with real outputs | War Room: `conveneMeeting` → participants, `board` (brief, draft, critique, synthesis), `decisions`, `conflicts`, `recommendations`, `final_plan`, `status`, `progress`; `GET/POST /api/meetings` | `agent_runtime.js`, `lib/agents/che_war_room_screen.dart` |
| Tasks with stages and dependencies | Objective graph (DAG): nodes, `runnableNodes`, approvals, `recordMissionEvent`, `speakObjective`; `/api/objectives` | `server/cloudflare/objective_graph.js` |
| Knowledge with provenance and links | Brain store (regions, `verification`, typed links), room events, relationship discovery (`source.relations`: basis, status) | `brain_store.js`, `brain_rooms.js`, `brain_relations.js` (PR #376) |
| A 3D/2.5D knowledge scene | Brain space (lobes, orbit, travel inside), navigation, frame budget | `lib/brain/che_brain_space*.dart`, `che_frame_budget.dart` |
| Coding state | Receipts and change history (PR, CI, merged, deployed), coding jobs | `truth_layer.js` (`loadChangeHistory`), `job_activity.js` |
| Trading state by source | Five ledgers never summed, equity curves, feed health | `trading_ledgers.js`, `lib/rooms/che_trading_ledgers.dart` |
| Screen and page awareness | Page reports, "look at my screen" | `lib/che_ui/che_screen_awareness.dart`, `che_screen_capture.dart` |
| Voice commands | One command catalog over existing handlers | `server/cloudflare/command_catalog.js`, `lib/home_state/send.dart` |
| Rendering budget and GPU plan | Native vs WebGL vs WebGPU benchmark, safe fallbacks | `docs/CHE_GPU_RENDERING.md`, `lib/widgets/che_native_scene_world.dart` |

## 3. Technical architecture

```
 real stores (unchanged)                 scene projection (new, pure)            phone (new views)
 ───────────────────────                 ────────────────────────────            ─────────────────
 agent runtime: team, meetings  ─┐
 objective graph: nodes, events ─┤      world_scene.js                          CheSceneModel (parse)
 Brain: records, links, status  ─┼──▶   sceneFor(room, id, data) ──▶ GET /api/world/scene ──▶ CheSceneView (draw)
 receipts / change history      ─┤      pure functions, no writes,              CheSceneList (VoiceOver/
 trading ledgers, feeds         ─┘      no model calls, deterministic             spoken numbered list)
                                              │                                 CheSceneInspector (record)
 actions ◀── existing routes only ◀──────── object.actions[] ◀────────────────── tap / voice / VoiceOver
```

**One contract: the Scene.** A scene is a read-only projection, recomputed from the stores on
every request. It adds no new state, so it can never disagree with the records.

```json
{
  "scene": "meeting", "id": "<meeting id>", "version": "<hash of inputs>",
  "title": "War Room: plan the Music Room launch",
  "spoken": "Five agents at the table. Nova and Knox are cross-checking. 3 suggestions, 1 recommended path.",
  "state": "drafting | cross_checking | synthesizing | complete | failed",
  "objects": [
    { "id": "agent:nova", "kind": "avatar", "label": "Nova, Research Partner",
      "status": "talking", "zone": "seat:1",
      "source": { "store": "agent_runtime.team", "id": "<agent id>" },
      "provenance": "live", "spoken": "Nova is drafting the research slice." },
    { "id": "post:3", "kind": "card", "label": "Knox → Nova: critique",
      "status": "proposed", "zone": "table",
      "source": { "store": "meeting.board", "id": "3" },
      "provenance": "model_output", "links": ["agent:knox", "agent:nova"],
      "actions": [{ "id": "inspect" }, { "id": "read_aloud" }] },
    { "id": "plan", "kind": "path", "label": "Recommended path", "status": "proposed",
      "zone": "center", "source": { "store": "meeting.final_plan" },
      "provenance": "che_synthesis_unverified",
      "actions": [{ "id": "inspect" }, { "id": "make_objective", "route": "POST /api/objectives", "confirm": true }] }
  ],
  "edges": [{ "from": "post:3", "to": "post:1", "type": "critiques" }]
}
```

Rules the contract enforces:
1. **`source` is mandatory.** The projection drops any object it cannot tie to a record, and a
   test asserts that every object resolves.
2. **`provenance` uses the che-fact-check labels.** That's `verified`, `derived`, `observed`,
   `inferred`, `proposed`, `model_output`, `che_synthesis_unverified`, `owner_attested` and
   `unknown`. The renderer maps each label to a fixed visual style (§4) and never changes a label.
3. **Motion comes only from diffs.** The client keeps the last scene and animates only objects
   whose `status` or `zone` changed between two versions: a card arrives, an avatar walks to a
   seat, a mission moves a column. Nothing moves when nothing changed.
4. **Actions are existing routes.** An object offers only actions an existing handler performs
   (open the War Room, approve an objective node, open a PR, read a ledger). The money and delete
   holds and the app-permission gates apply unchanged.
5. **The spoken list is part of the scene.** `spoken`, each object's `spoken`, and a numbered
   order come from the same projection. VoiceOver and "read the scene" use them, so the visual
   and spoken versions can never drift apart.
6. **Owner-only.** Scenes use the same `ownerDevice` gate as the rooms. Guests get nothing
   private.

Transport: a poll every 2–5 s while a scene is open, the same as the Office live view. Later,
the Brain change feed and room events can push changes. The `version` hash makes an unchanged
poll free on the phone.

Rendering, in layers:
- Start with a 2.5D Flutter `CustomPainter` scene, the same technique as the Office world. It's
  cheap on iPhone, works offline from the last scene, and is fully accessible through
  `Semantics`.
- 3D (the Brain space renderer, or GPU per `CHE_GPU_RENDERING.md`) is a later skin over the same
  scene JSON, never a different data path.

## 4. Mapping: data → visual object

| Real data | Visual object | State shown by | Inspect shows |
| --- | --- | --- | --- |
| Agent (`team[]`, `agentView`) | Avatar (existing workshop look) | Seat or room from `agentLocation`; pose from `status` (talking = speech bubble, building = at desk, waiting = seated idle, offline = greyed) | Role, persona, current assignment, recent history |
| Meeting (`meetings[]`) | Table in the Meeting Room, objective on the centre display | `status` + `progress`: gathering → drafting → cross-check → synthesis → complete/failed | Objective, participants, timeline of posts |
| Meeting post: brief, draft, critique | Card in front of its author; a critique card points (edge) at the draft it critiques | Arrives when the post exists; `failed` drafts show as a torn card | Full text, author, time, "model output, unverified" |
| `recommendations[]`, `decisions[]`, `conflicts[]` | Suggestion notes, decision pins, conflict markers (two cards joined by a red thread) | Appear only after synthesis | The text, and which posts it came from |
| `final_plan` | The one "Recommended path" on the table centre: numbered steps with owner avatars | `proposed` until the owner turns it into an objective | The plan; the action "make this an objective" (asks first) |
| Objective (`/api/objectives`) | Mission board | — | Objective, constraints, approvals |
| Objective node | Mission object (token) in a column: queued, active, blocked (awaiting approval or failed), done | Column + colour; dependency edges from the DAG; a blocked node shows its blocker (`awaitingApproval`, failure kind) | Node prompt, job id, outcome, retries, receipts |
| Brain record | Knowledge node in its region | Shape by `verification`: solid = verified, outlined = observed or inferred, dashed = proposed or hypothesis, struck = superseded or contradicted | Title, body, source room, evidence, status |
| Brain link (`links`, `source.relations`) | Edge | Solid = derived (shared exact reference), dotted = candidate (shared words); label = basis | "Same pull request #374", "shared words (…)" |
| Coding receipt / change history | PR objects on the Coding Room conveyor: opened → checks → merged → deployed (or failed) | Station on the conveyor, from receipts only | Number, summary, files, CI, deploy, live version |
| Trading ledger | One cabinet per ledger (simulation, paper journal, evidence pass, Lab book, Alpaca PAPER), never merged | Equity sparkline; feed light green/amber/red; "unreadable" when the reader fails | Trades by strategy, feed health, source |
| Screen observation | Temporary "window" object in the room it belongs to; fades after 15 minutes | Age; observed, not verified | Vision summary, engine, time |

The visual vocabulary is fixed, so the owner learns it once:
- **Colour** means status.
- **Line style** means provenance.
- **Place** means stage.
- **Motion** means change.

## 5. Phased plan

Each phase ships on its own, with tests, and changes no store.

**MVP 1: Team Meeting Room** (Worker + Dart; Shorebird patch; no new IPA)
1. Voice and typed command: "start a meeting with the team [about X]".
   - It's a `command_catalog.js` entry over the existing `POST /api/meetings` (`conveneMeeting`).
   - "War room" stays with the multi-AI panel it already opens. The new phrases are "meeting
     with the team" and "team meeting".
   - With no topic, CHE uses the newest active objective. If there's none, she asks one question.
2. `server/cloudflare/world_scene.js` exposes `meetingScene(meeting, runtime)`: a pure projection
   to the Scene contract. `GET /api/world/scene?scene=meeting&id=…` is owner-only.
3. `lib/world/che_scene_model.dart` parses the scene. `lib/world/che_meeting_room.dart` draws it:
   - a 2.5D table, with avatars walking to seats as participants join;
   - the objective on the centre display;
   - cards that appear as posts arrive, with critique edges;
   - after synthesis, one highlighted Recommended path.
4. Inspect sheet: the full text, author, and the provenance label ("model output, unverified",
   "CHE's synthesis, unverified").
   - Read aloud and "make this the plan" are there; the latter creates an objective and asks first.
   - Voice: "read the suggestions", "open suggestion 2", "what's the recommendation?".
5. Accessibility:
   - A numbered list mirrors the scene for VoiceOver.
   - Passive arrival of cards is silent text with a light haptic.
   - When the meeting completes, CHE speaks once, because the owner started it.
6. Tests:
   - the projection (every object has a source; no source means no object);
   - stage mapping and diff-only animation;
   - the voice parse;
   - a widget test of the list and inspect;
   - a chat-route test of the command.

**MVP 2: Mission board** (Dart + projection). Build `objectiveScene`: nodes become mission objects
in four columns, with DAG dependency edges and the reason a node is blocked. Approve and retry use
the existing `approveNode` / `retryNode` routes, behind the same confirmations. The meeting's
"make this the plan" lands here, so MVP 1 → MVP 2 is one visible journey.

**MVP 3: Brain knowledge view.** Build `brainScene(topic)`:
- the topic's records and their `source.relations` as nodes and edges;
- the provenance styles from §4.
It reuses the Brain space renderer and adds the provenance styling and relationship edges, with
no new store. "Show me what's connected to PR 374" opens it, through the related intent from
PR #376.

**MVP 4: Coding and Trading Rooms.**
- `codingScene`: the PR conveyor from receipts and change history, with the live version.
- `tradingScene`: ledger cabinets from `readLedgers`, feed lights and equity sparklines.
Both reuse the existing readers and panels.

**Later:**
- push updates over the change feed;
- a 3D/GPU skin;
- screen windows in rooms;
- REA investigations as "specimen" objects;
- the Music Room;
- multi-room navigation by voice ("take me to the Coding Room").

## 6. First files to read

1. `server/cloudflare/agent_runtime.js`: `conveneMeeting` (≈ line 751), the meeting run (drafts,
   critiques, synthesis ≈ 1230–1300), `meetingSummary`, `runtimeSnapshot`, `agentLocation`,
   `WORLD_ROOMS`.
2. `lib/agents/che_war_room_screen.dart` and `che_agent_runtime.dart` (`CheMeeting`,
   `CheMeetingPost`, polling client): the current text War Room to replace with the scene.
3. `lib/agents/che_office_world.dart`: the avatar drawing, walking and "Got it" hop to reuse.
4. `server/cloudflare/command_catalog.js` + `command_center.test.mjs`: where the meeting command
   goes (one entry, route asserted).
5. `server/cloudflare/objective_graph.js` + `/api/objectives` in `worker.js` (≈ line 7834): MVP 2.
6. `lib/brain/che_brain_space_model.dart`, `brain_relations.js`: MVP 3.
7. `trading_ledgers.js`, `lib/rooms/che_trading_ledgers.dart`, `truth_layer.js`
   (`loadChangeHistory`): MVP 4.
8. `docs/CHE_GPU_RENDERING.md`, `lib/brain/che_frame_budget.dart`: rendering limits on iPhone.

## 7. The smallest practical first build

"Start a meeting with the team about X" → the Meeting Room scene for that real War Room meeting:
- avatars at the table;
- the objective in the centre;
- the real posts as cards;
- one recommended path;
- inspect and read aloud;
- a VoiceOver list.

It's built from three new files plus small changes in three existing ones:

| New | Changed |
| --- | --- |
| `server/cloudflare/world_scene.js` (+ test) | `command_catalog.js` (one entry) |
| `lib/world/che_scene_model.dart` | `worker.js` (one owner-only GET route) |
| `lib/world/che_meeting_room.dart` (+ widget test) | `send.dart` (open the room after the command) |

No new store, no new model calls (the meeting already makes its own), no IPA. Estimated at one
PR.

Known cost and risk:
- A War Room meeting already makes model calls: each participant drafts and critiques, and CHE
  synthesizes. The scene adds none, but starting a meeting by voice makes those calls happen more
  easily. The command says so and runs only on the owner's request.
- Drafts and the plan are model output, and the scene must never style them as verified. The
  projection test enforces that.
