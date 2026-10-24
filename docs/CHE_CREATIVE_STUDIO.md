# CHE Creative Studio (Create tab)

Owner request, 2026-10-24. The specification came from ChatGPT's written inspection of the owner's screen recording; the recording itself was not reviewed here.

## What changed

Create is now one vertically scrolling page: **Creative Studio, managed by Vale**, in `lib/create/che_creative_studio.dart`. It replaces two things:
- `lib/create_gallery_scene.dart`: a 3D gallery scene of purple stand-in figures above a grid of project frames.
- The `Projects | Art Studio | GPU Jobs` segments.

The page has these parts, in order:

| Part | What it links to (existing code) |
|---|---|
| **Create New** (one sheet) | Video prompt, Film Studio, song prompt, coding-job prompt, image prompt, Character Generator, new project dialog, Invention Studio |
| **Working now** | Real states only: the Worker's coding job (`CheAgentRuntimeController.codingJob`). With none, it says "No active jobs right now". |
| **Film Studio** | `CheFilmStudioScreen` (`_openFilmStudio`), the video prompt, Theater (hub room 8) |
| **Music Studio** | The Music room (hub room 4) and a song prompt |
| **Code Studio** | Coding-job prompt, Office floor (coding job card), Command Center |
| **Art & Character Studio** | Character Generator, `CheArtStudio` (now its own page), image prompt, and `CheGpuJobsCard` (GPU jobs and **Pair Colab**) shown directly on the card |
| **Projects** | The four newest projects plus "See all" (each opens the existing project editor). Also: Data Vault, Invention Studio, Capability Showroom, research, and completed creations (`CheCreationsStrip`) |

**Look.** Black, silver, white and one teal accent (`CheStudioColors`), the same on every app palette. Studio cards are large, with icon disks, capability tags, one primary button and up to two secondary buttons.

**Voice and accessibility.**
- Every control has a VoiceOver label. Nothing is spoken when the page opens; Read aloud reads the studios as a numbered list.
- Voice and typed routes in `lib/home_state/send.dart` (via `_openCreativeStudio`):
  - "open the creative studio / code studio / art studio / character studio / projects" opens Create and scrolls to that studio.
  - "create new" opens the Create New choices.
  - Existing routes still work: "open music", "open create", "open the theater" and "open the character generator". "open the film studio" goes to the Worker as before.

## Mannequin audit (every room)

| File | What it drew | Action |
|---|---|---|
| `lib/widgets/che_native_scene_world.dart` `_addProceduralPerson` | A generic capsule body, sphere head, capsule arms and legs, and hair/hat blobs for **every entity without a GLB**, in all native 3D rooms. This was the source of the purple mannequins: projects were drawn as people in `CheSceneMode.projects` colour `#8E86FF`. | **Removed.** Work items and projects are now `_addWorkMarker`: a silver pedestal with a glass tile in the item's colour, plus a status light only while it is working or speaking. Agent entities (`agent:<id>` or `che`) load their finished crew GLB from `assets/characters/crew/<id>.glb` (`cheCrewModelAsset`). If loading fails, they get the marker, never a figure. |
| `lib/create_gallery_scene.dart` | The Create room: native 3D projects scene (figures) plus painted gallery wall | **Deleted.** Replaced by the Creative Studio. |
| `lib/music_studio_scene.dart`, `lib/rooms/che_art_studio.dart`, `che_theater_room.dart` (native scene), `che_markets_room.dart`, `che_pipeline_room.dart`, `che_store_room.dart`, `che_workshop_room.dart`, `lib/agents/che_war_room_screen.dart` | Their 3D scenes used `CheNativeSceneWorld`, so they showed the same procedural figures | **Fixed at the source** above. Their real data and controls are unchanged. |
| `lib/che_ui/che_agents.dart` `CheMiniPerson` (Office, meeting room, war room, home) | Each agent's own 2D character (name, colours, status pose; a portrait image when the avatar style is set) | **Kept.** These are the agents' identities, not anonymous placeholders. |
| `assets/office3d/*` (Three.js chibi bots) via `Office3DView` / `Che3DRoomView` | Procedural chibi agents in a WebView | **Not mounted anywhere** in `lib/` (no `Office3DView(` or `Che3DRoomView(` call). Left as is and noted here. |
| `lib/avatar/che_character_generator.dart`, `assets/characters/crew/*.glb` | Real character generator and finished crew models | **Kept** (and now used for agents in 3D rooms). |

**Known effect.** The Workshop's "crew looks" choices (skin, outfit, hair, accessory) styled the procedural figure. Agents now render with their crew GLB, so those choices no longer change the 3D view. The choices are still saved.
