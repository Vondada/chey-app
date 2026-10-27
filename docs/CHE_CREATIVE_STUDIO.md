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

## Live 3D Studio (2026-10-24)

The Creation Room opens on six choices under the Creation Engine's real state:

| Choice | Status | Where |
|---|---|---|
| Create Person | Built end to end | `lib/create/che_live_studio.dart`, `server/cloudflare/creation_studio.js` |
| Create Object | Not built; says so | capability `object` |
| Create Room | Not built; says so | capability `room` |
| Create Animation | Preview only: bundled crew clips | Live Studio, animation mode |
| My Creations / Active Projects | Built | `/api/creations` |

**Pipeline (no simulated progress).**
1. Create Person makes a creation project from an identity preset, with versions, undo, redo and save.
2. Generate queues a `person_model` GPU job.
3. On the owner's Colab GPU, `mpfb_dress.py` exports a GLB bust right after its checks pass, before rendering (`EXPORT_GLB`).
4. The worker uploads the GLB, then each preview PNG as it finishes.
5. The Worker logs each arrival in the job history with a timestamp. The Live Studio shows those stages, the pictures, and the GLB in a three.js viewport (`assets/characters/app/studio.html`). The viewport turns, pinches, resets and plays clips.
6. The job completes only with a GPU receipt, every picture, and the model hash.

**Until a GLB exists**, the viewport shows the bundled stylised crew model, labelled as not the owner's edits.

**Known limits.**
- The GLB is a head-and-neck bust. Its hair cards read as a solid shape; strand hair, brows and lashes appear only in renders.
- Generated models have no skeleton yet, so they cannot be animated.
- "Put this in my Office" is not built.

**Settings → Creation Engine** holds Pair Colab, the GPU job queue and the notebook link. Connect opens the notebook; CHE cannot start Colab herself.

## Recording Studio engine: Beat Producer, Engineer Mode, recreated presets, vocal analysis (2026-10-25)

These are built on the existing Recording Studio (`lib/music`), not as a second studio. Everything runs on the iPhone in Dart, on real samples.

| Feature | Files | Voice (also typed) |
|---|---|---|
| **Beat Producer**: genre, tempo and key produce drums and a bass line. The result is rendered as audio onto the **Produced beat** track, ready for the mixer, effects, mastering and export. Generation is deterministic: the same settings always give the same pattern and samples. "Another one" means the next variation. | `che_beat_producer.dart` | "make a trap beat in F minor at 140", "produce a beat", "make another one" |
| **Engineer Mode**: a numbered option list, with spoken choices by number while it is on. | `che_engineer.dart` | "engineer mode", "option 3", "engineer mode off" |
| **Punch-in by bar or time**: snapshots the song first. The original take's audio stays on disk, and undo puts it back. | `che_engineer.dart`, `che_studio_controller.dart` | "punch in bars 3 to 4", "punch in bar 2 and record", "punch in from 12 to 16 seconds" |
| **Undo**: every change is one step (a slider drag counts as one). After reopening a song, undo falls back to the saved snapshots. | `che_studio_controller.dart` | "undo", "undo that" |
| **Bring me back**: returns to the last good mix. Good points are saved when Engineer Mode starts, when the owner says it sounds good, and on every export. Snapshots are kept in `snapshots.json` beside `song.json`, so they survive reopening. A restore reads takes that are no longer in memory back from the song folder. | `che_engineer.dart`, `che_song.dart` (store) | "bring me back", "this sounds good", "list snapshots", "restore snapshot 2" |
| **Recreated presets**: labelled **recreated, not imported**. | `che_preset_recreate.dart` | "recreate BandLab Hip Hop Vocal", "recreate preset 2", "recreate a preset with cut lows, bright, heavy compression, short delay and big reverb" |
| **Vocal analysis and personalized processing**: measures pitch range (YIN), average and peak level, sibilance (5 to 10 kHz energy), noise floor, dynamics and off-key cents. It then suggests a chain and applies it, with a before-to-after numbers receipt. | `che_vocal_analysis.dart` | "analyze my vocals", "personalize my vocal processing" |

**New effects** on every track are a high-pass filter, a movable mid-EQ frequency (for presence boosts at 3 to 5 kHz) and a split-band de-esser.
- The de-esser uses a Linkwitz-Riley crossover. It runs after the compressor, because compression raises sibilance.
- It skips anything below -45 dBFS, so room hiss is left alone.
- Older song files load unchanged.

### BandLab research (what is and is not documented)

Researched 2026-10-25 by web search. The help pages themselves could not be opened from the development machine (DNS blocked), so these findings rest on the search engine's text from those pages.
- BandLab documents import and export as **audio and MIDI only**: WAV, MP3 and M4A audio, plus MIDI ([Supported Import and Export File Formats](https://help.bandlab.com/hc/en-us/articles/360036010533-Supported-Audio-Formats-)).
- Effects presets are shared **inside BandLab**, as a profile post or a link that another BandLab user opens in their Studio ([Sharing your Presets](https://help.bandlab.com/hc/en-us/articles/6443820016665-Sharing-your-Presets), [Adding Effects](https://help.bandlab.com/hc/en-us/articles/115002945473-Adding-Effects)). No preset file download is documented.
- One preset seller's blog claims chains are JSON files with an "Import Chain" option. BandLab documents no such thing, so CHE does not rely on it.
- BandLab publishes no parameter values for its stock vocal presets.

So CHE **cannot import** BandLab presets and says so. Asked to import one, it explains this and offers to recreate the preset.

The recreated starting values come from widely published vocal-mixing ranges. The sources are blogs and retailer guides, not BandLab:
- high-pass at 80 to 100 Hz
- a 2 to 3 dB presence boost at 3 to 5 kHz
- de-essing at 5 to 8 kHz
- compression at 2:1 to 4:1, with 10 to 20 ms attack and 50 to 100 ms release
- delay at 100 to 400 ms

Sources: reverb.com "How to Mix Rap Vocals: Basic Techniques and Effects", violetrecording.com "Vocal chain for rap", audiofanzine "Mixing rap vocals, part 2: EQ".

### Tests

`test/che_studio_engine_test.dart` (all fixtures are synthetic) covers:
- De-esser levels.
- Beat determinism, length, onsets and the bass pitch of the key.
- Recreated preset ranges.
- Analysis numbers.
- One end-to-end run: beat, then vocal, then punch-in, then recreated preset, then WAV export (header, length, not silent), then reload, then snapshot restore and bring me back.

### Not verified yet

- These features have not been tried on an iPhone with real takes. The analysis thresholds and the de-esser were tuned only on synthetic fixtures.
- The produced beats use the studio's synthesised drums, not sampled kits.
