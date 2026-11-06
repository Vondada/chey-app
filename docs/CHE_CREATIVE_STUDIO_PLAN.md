# CHE all-in-one creative studio: audit and staged plan

Owner, 2026-11-06: "I want CHE to become my complete, all-in-one AI creative studio … CHE must do everything herself
from inside her app." The test sentence: "CHE, make Nova walk into my office, sit beside me, and start talking",
then "Change her outfit, make the camera circle around us, slow down the last five seconds, and add music", done
without rebuilding anything, and Nova selectable by touch.

This plan builds on what already works. Nothing here replaces a working system with a demo.

## What CHE already has (audit, 2026-11-06)

| Area | Working today | Where |
|---|---|---|
| Video editing project | Visual Studio: a non-destructive JSON document (clips, trims, speed, reverse, freeze, transitions, colour, text, captions, audio with ducking) with 30-step undo/redo, named versions, compare, templates and brand kits, rendered by ffmpeg on GitHub Actions and checked by ffprobe | `server/cloudflare/visual_studio.js`, `visual_api.js`, `tools/che_edit_render.py`, `lib/visual/` |
| 3D scene document | Characters, objects, rooms, lights and cameras with transforms and a few properties, undo/redo, versioned saves (no time, no renderer) | `scene_document.js`, `scene_store.js`, `lib/create/che_scene_studio_page.dart` |
| Character, object, room creation | Live Studio: versioned parametric creations, voice edits (hair, eyes, skin, body, outfit tops), Blender GLB builds on the GPU queue | `creation_studio.js`, `creation_orchestrator.js`, `lib/create/che_live_studio.dart` |
| Crew 3D models | 8 rigged GLBs (CHE, Nova, Atlas, Mira, Knox, Sage, Lyra, Iris), 31 bones, 11 clips (idle, walk, run, wave, sit, stand, talk, think, celebrate, nod, shake), no face shapes; Orion and Vale have none | `assets/characters/crew/`, `tools/character_pipeline/` |
| 3D in the app | Native flutter_scene renderer in nine rooms (bind pose only, no clip playback); three.js crew room with clips and a joystick; Live Studio GLB viewport with lip-sync morphs | `lib/widgets/che_native_scene_world.dart`, `lib/rooms/che_characters_room.dart`, `assets/characters/app/` |
| Films | Film Studio: screenplay, stills, voices, Kaggle LTX clips, lip sync, ffmpeg assembly; editable only by "remake shot N" | `film_studio.js`, `film_pipeline.js`, `film_farm.js` |
| Gallery | One media index (200 items), bytes in R2 or CHE's own store | `media.js`, `che_media_store.js` |
| Compute | Four separate routers: GPU queue (free first, then Modal credit, then prepaid; Blender only), Film farm (Kaggle, HF), Modal-or-Workers-AI pictures, Cloud Computer Manager | `compute_pool.js`, `compute_budget.js`, `modal_gpu.js`, `film_studio.js`, `chat_image_provider.js` |
| Self-development | Coding jobs open PRs through two lanes with independent review; merges, deploys, workflow edits and Modal redeploys need the owner | `self_development.js`, `che-opencode-runtime.yml`, `che-autopilot.yml` |

## Gaps against the goal

1. Nothing turned a sentence into a 3D scene in which a crew member walks, sits and talks, or rendered such a scene to
   video. (`scene_timeline.js` existed, but was not wired in and had no renderer.)
2. The native 3D renderer plays no animations; positions are fixed grids; the Office itself is a 2D floor plan.
3. No touch selection with edit handles, no stylus support, no material, texture or lighting edits in 3D.
4. Visual Studio has one video track: no overlay tracks, keyframes, masks, tracking or speed ramps.
5. Three project models (Visual Studio, scenes, creations) that do not link; films are not editable projects.
6. Two rigs (crew 31 bones/11 clips, generated people 53 bones/5 clips) with no retargeting; no dance or emotion
   clips; the crew look cartoon-like, not like the owner's CHE WORLD sheets; Orion and Vale have no model.
7. No single compute router; two Modal budgets that do not talk; Kaggle quota counted twice.
8. Export is MP4, PNG and GLB only (no USDZ for iPhone AR).

## The editing target: the owner's Higgsfield "Miracle" reference clips (2026-11-06)

| Shown in the clips | How CHE does it | Stage |
|---|---|---|
| "Vectorize" / "all videos have layers": a video split into its person, tree and background | CHE's own 3D scenes are layered by construction; Cycles can render each object as its own layer. Filmed video needs SAM 2 segmentation (Apache-2.0) on the free Kaggle GPU | 3D: 2-3; footage: after 3 |
| Select a person, move and rotate them with a 3D gizmo; add a prop (an umbrella) | Tap to select in the live scene, drag or pinch to move and scale, then re-render; props from the object library | 2 |
| Localized editing (change only the hair or the dog) | In 3D: per-object material and look edits (the outfit colour is the first). On footage: segmentation plus generative inpainting on GPU | 1 (outfit), 2, later |
| Compositing / "control every pixel": change a car's livery, swap elements | Per-layer renders combined on Visual Studio overlay tracks | 3 |
| Selective speed control: one skater slowed, the rest at normal speed | Each actor's clips are separate NLA strips, so one actor's time can be scaled alone; whole-scene spans already retime | 1 (spans), 2 (per actor) |
| Relight with a time-of-day dial | The office lighting presets: warm, cool, morning, sunset, night | 1 (this PR) |
| HDR and colour | Colour curves and LUTs in the Visual Studio document and renderer | 3 |
| "World knowledge" (a city in 1996 vs 2026) | Needs generative imagery; not planned yet | later |

## Stages

Each stage ships as focused PRs with tests, CI and rendered evidence. Free compute first; paid GPU only within the
owner's cap.

**Stage 1: Scene Director (this PR).** The test sentence becomes an editable scene project, rendered for real.
- `server/cloudflare/scene_director.js`: words → spec (actor from the crew GLBs, walk → sit → talk timeline, the
  office set, camera); versioned project with undo and redo; one sentence can carry several edits (outfit colour,
  camera orbit, slow-motion spans, music, the spoken line). Edits that change only timing, words or sound reuse the
  frames already rendered.
- `tools/che_scene_render.py`: Blender (Cycles) draws the real GLBs with their real clips: walking along the path,
  sitting on the chair (seat height measured from the sit pose), talking from the waist up while seated, the
  camera holding or circling (the back wall hides while the camera passes behind it), the outfit colour, and relighting
  (warm, cool, morning, sunset, night).
- `tools/che_scene_finish.py`: ffmpeg retimes spans, places the Piper voice lines after the retime, mixes ducked music,
  encodes H.264/AAC and checks the file itself.
- `.github/workflows/che-scene-render.yml`: up to 20 free runners render frame ranges at once, then one finishes.
- The video is saved in the media library only after CHE reads the MP4.

**Stage 2: live 3D and touch editing in the app.** Clip playback in `CheNativeSceneWorld` (flutter_scene
`createAnimationClip`); the scene spec drawn live in the app as a preview; tap Nova to select her, with simple
controls (outfit colour, move, scale, light) and Apple Pencil input; a 3D Office mode. The chat sends the selection,
so "make her bigger" acts on what is touched.

**Stage 3: one timeline.** Scene renders and films open as Visual Studio projects; add overlay tracks,
keyframes (position, scale, opacity), speed ramps and colour curves/LUTs to the document and to
`tools/che_edit_render.py`. Masks and tracking come after, with a segmentation model on the GPU farm.
- Stage 3a (built): "edit my scene in the studio" / "open my film in the editor" open the newest scene render or
  film as a Visual Studio project (`projectFromMedia`, API action `from_media`); video documents are version 2 with
  overlay tracks (pictures or videos with start, length, position, size, opacity, track order) and keyframes on
  position, size and opacity (linear or eased), migrated from one-track documents on load; speed ramps play as
  steps (the renderer cuts the clip into pieces, audio follows with atempo); four LUT looks (warm film, teal and
  orange, mono, film; .cube files built by the renderer) and six ffmpeg curve presets. All are voice edits ("add the
  sunset photo on top", "fade it in over two seconds", "slide it in from the left", "ramp the speed up at the end",
  "give it a warm film look"); the app's controls send the same words. Evidence: a real two-track render with
  keyframes, a ramp and a LUT in `tools/test_che_edit_render.py`, its length matching the editor's timeline.

**Stage 4: identity everywhere.** One rig and clip library for crew and created people (retarget or rebuild); add
dance, emotion and gesture clips; face shapes on the crew for real lip sync; rebuild the crew to the CHE WORLD sheets;
models for Orion and Vale; USDZ export for iPhone.

**Stage 5: one compute router.** Every heavy job type (pictures, clips, lip sync, 3D builds, scene renders) goes
through one router: free providers first (Workers AI, GitHub Actions, Kaggle), then Modal within one shared monthly
ledger and the owner's cap, with Kaggle counted once.

**Stage 6: the director loop and self-development.** CHE plans a scene from loose words, picks tools, renders, checks
frames against the request, and fixes what fails. A missing capability becomes a coding job that opens a tested PR.

## Needs from the owner

- A Modal spending cap, before any paid GPU use. The owner named $10 a month when choosing the free Kaggle path.
- Merges, deploys and iPhone builds as before; Modal app redeploys are manual.

## Measured so far (2026-11-06, local Blender 4.2, 4 CPU cores)

- Cycles at 540x960, 8 samples with denoising: about 6.4 s a frame. A 10-second scene is 240 frames; on 12 runners
  that is about 20 frames each, about 2 to 3 minutes plus runner start-up.
- A 9-second test scene rendered end to end (216 frames), retimed to 14.0 s with the last 5 s at half speed; the MP4
  read back as H.264/AAC at exactly 14.0 s.
