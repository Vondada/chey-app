# Create Room demonstration video (lane E, 2026-10-25)

The owner asked for a playable video of the finished Create Room experience: describe a character, press Create, get a
customizable rigged full-body character in three styles, see it move and speak, change it, place it in the Office,
save it, reopen it, export it. The pipeline is not finished, so the video is a **clearly labelled prototype**: every
segment carries an on-screen label.

- **REAL**: built by CHE's pipeline. Actual MPFB2 + Blender output from the real job script
  (`scripts/che_gpu_face_preview.py --model`, the script the free GitHub CPU worker runs), shown in CHE's own viewer.
- **PROTOTYPE**: planned. Staged or approximated for the video, not yet in the app.
- **NOT AT $0**: would need paid services or new API keys (the owner ruled those out).

The character "Ava" is fictional. She was invented for the demo from a written description. No photo of any real person
was used.

The video file is not committed. It is about 2 minutes, 1280x720, H.264 + AAC, at 24 fps. `tools/demo/run_all.sh`
rebuilds it from scratch.

## The finished experience, voice first (what the owner says, what CHE does)

This is the target flow. The segment table below shows which parts work today.

1. **Owner:** "Open Create." CHE opens the Creative Studio silently, as passive navigation (AGENTS.md rule of
   2026-10-11). Read aloud lists the choices as a numbered list: "1 Create Person, 2 Create Object, 3 Create Room, ...
   5 My Creations ...". Every tile has a VoiceOver label.
2. **Owner:** "Create a person: Ava, a fictional woman in her thirties, warm brown skin, dark hair, terracotta top. All
   three styles." CHE repeats the parsed settings and queues three `person_model` jobs on the Worker. She replies:
   "Creating Ava in three styles on the free CPU worker. I'll tell you when she's ready." The status line is shown as
   large text, and a banner plus a haptic pattern mark the job start. The job keeps running if the app closes.
3. When the jobs finish, CHE speaks this reply because the owner asked for the creation: "Ava is ready in three styles.
   One, photoreal. Two, game-like. Three, stylized. Say a number to choose."
4. **Owner:** "Two." Live Studio opens the GLB. The owner can then say "show her skeleton", "walk", "run", "wave",
   "turn left", "zoom in", "let her speak". Each command reports what actually happened, using the viewer's own reply
   (for example "Playing walk.").
5. **Owner:** "Make her hair copper, outfit blue, taller and stronger." CHE queues a new version with the same rig and
   says which changes keep the rig and clips. A version list gives undo and redo.
6. **Owner:** "Give her voice seven." Ava speaks with Kokoro speaker 7. Her mouth follows the audio.
7. **Owner:** "Put her in my office." She walks to a desk, sits and gestures at the screen.
8. **Owner:** "Save her." "Open My Creations." CHE replies "My Creations: 2. Say a number to open one." "One" reopens
   the saved GLB in Live Studio. "Export for Roblox" builds the R15 FBX. Publishing stays the owner's step in Roblox
   Studio.

## Segments, labels and evidence

| # | Segment | Label | Evidence |
|---|---|---|---|
| 1 | Title and legend | (card) | — |
| 2 | Describe + Create | PROTOTYPE input card; REAL job log | The card is a mock in the app's colours, because free-text Create is lane B work (G5). The log lines and times come from the photoreal job's `receipt.json` (stage seconds, Cycles view seconds, model bytes and vertices) and from `build_times.json`. |
| 3 | Three styles | REAL renders; PROTOTYPE "true hyperrealism" | Three job builds (photoreal / hybrid / stylized) rendered in Cycles on the CPU by the job, plus face close-ups from `render_glb.py`. Honest finding: in the full-body build the three looks differ only slightly (eye size, nose, head roundness, skin shading). The full body has no brows, lashes or strand hair; the hair is a scalp cap. |
| 4 | Skeleton | REAL | Live Studio (`assets/characters/app/studio.html`, unmodified) runs its own `skeleton` command, a three.js SkeletonHelper over the GLB's 53 bones. The evidence box is read from the file by `inspect_glbs.py`: 53 skin joints, clips idle 2 s / walk 1 s / run 0.667 s / wave 2 s / talk 3 s, and morphs blink_l, blink_r, brows_up, mouth_open, smile. `verify_glb.py` reports rig OK. |
| 5 | Facial expressions | REAL | The GLB's own shape keys, which come from MakeHuman expression units. The demo sets them one at a time through Live Studio's `setMorph`. |
| 6 | Walk, turn, run, wave | REAL clips; PROTOTYPE turn | Clips played by Live Studio's `animate` command. The turn is a root rotation the demo applies over the walk clip; no turn clip exists. Walk and run are in-place cycles with declared ground speeds of 1.0 and 2.96 m/s. |
| 7 | Speaking + lip-sync | REAL TTS, REAL lip-sync; PROTOTYPE visemes | The speech comes from Kokoro int8 en v0.19 through sherpa-onnx 1.13.8, the same model and runtime version as the iPhone app (`lib/che_kokoro_voice.dart`, `pubspec.yaml`). It runs locally with no key. Live Studio's `lipsync` command takes the audio's loudness envelope (30 Hz) and drives `mouth_open`. Only the jaw moves: there are no phoneme visemes, because the model has no viseme shape keys. Rhubarb cues are accepted by the viewer but were not generated here. |
| 8 | Hair, outfit, body changes | REAL; PROTOTYPE hair style and app sliders | Four separate job builds, each shown in its own Live Studio frame playing the same clip. `inspect_glbs.py` checks each one against the photoreal build. All four have the same 53 joint names in the same order, and the same clip channels (node + path), so the clips play unchanged. The body change moves joints by up to 0.20 m, because the skeleton is placed on each body. Hair colour, outfit colours and body shape are real pipeline settings (`HAIR_SRGB`, `OUTFIT_SRGB` / `TROUSERS_SRGB` / `SHOES_SRGB`, MakeHuman height/muscle/weight targets through the job's `FACE` setting). Hair-style geometry and the app's body sliders are lane A/B work. |
| 8b | Another voice | REAL voice; PROTOTYPE per-character voice | Kokoro speaker 7 (bf_emma) from CHE's local voice list (`lib/che_native_voice.dart`). Saving a voice per character is lane B work (G6). |
| 9 | Office | REAL GLB and clips; PROTOTYPE staging | `tools/demo/web/office.html` reuses the Office geometry from `assets/office3d/index.html` (tiles, walls, windows, plants, desk with monitor, keyboard and mug) at metre scale. The walk path (the root moves at the clip's 1.0 m/s), the turn, the chair and the sitting pose are staged by the page. The sitting pose aims the thighs, calves and feet in world space while the real wave clip drives the upper body. No sit clip exists. |
| 10 | Save, reopen, export | PROTOTYPE My Creations card; REAL reopen and export | The list is a mock that uses the app's wording (`lib/create/che_creative_studio.dart`). The reopen is the saved `model.glb` loaded into Live Studio, and the box shows the page's own report (meshes, vertices, triangles, clips, mouth morph, height). The GLB is the job's file. Roblox: `tools/avatar_body/roblox_export.py` built an R15 FBX (17 joints, 10,293 triangles, `studio_import_ready: true`, not Marketplace-ready: no cages or attachments). |
| 11 | Summary table | (card) | — |

**NOT AT $0** in this video: GPU-speed renders on demand (no free unattended GPU exists in this setup, so the free CPU
worker is used and times are measured), and neural photo-to-3D or voice-cloning services (these need paid APIs or keys).

## What each tool contributes

- **MPFB2 / MakeHuman data (CC0):** the base body, ethnic mix, sex and age macros, face targets, height and weight
  targets, the 53-bone `game_engine` skeleton with its joint placement and skin weights, and the expression units the
  face shape keys come from.
- **Blender 5.0.1 (here the pip `bpy` module, on the worker the official build):** builds the mesh and clothing, places
  the rig, skins, keys the clips (walk and run with two-bone IK foot targets), adds shape keys, exports glTF, re-imports
  it to verify, renders in Cycles (the `final` profile, OIDN), and exports the Roblox R15 FBX.
- **three.js r160 (Live Studio):** the in-app viewer. It handles clips, skeleton overlay, lip-sync from cues or an
  envelope, blinking and camera control. The office stage uses the same build.
- **Cloudflare Worker:** queue, storage and routing only. It has no GPU and no Blender.
- **Free GitHub Actions CPU worker:** runs the same job script (verified live earlier: run 40153146586, 1.4 min).
- **Kokoro + sherpa-onnx:** local TTS with the same model as the phone.
- **Playwright + headless Chromium (SwiftShader):** captures the real viewer pages on a virtual clock, so every frame
  is exactly 1/24 s of animation time. **ffmpeg:** encodes the video.

## Measured times (this container: 4 CPU cores shared with another lane's renders)

- Job builds, wall time per job, including three Cycles views at 720 px and 48 samples: photoreal 83 s, hybrid 156 s,
  stylized 149 s, hair 112 s, outfit 122 s, body 129 s. Of that, model + rig + animate + verify take about 7–20 s; the
  rest is Cycles. A single view took 18–51 s.
- Face close-ups (480 px, 32 samples): 24–25 s each. Roblox export: 8 s.
- TTS for all 22 lines: under a minute on 2 threads.
- Capture: Live Studio frames take about 0.2–0.5 s each; office frames take about 0.75 s (shadows on).
  `capture_times.json` holds the per-segment numbers.

## Rebuild

```
MPFB=/path/to/mpfb2/src/mpfb/data TTS_PY=/path/venv/bin/python KOKORO=/path/kokoro-int8-en-v0_19 \
  tools/demo/run_all.sh WORK_DIR /path/to/blender PROJECT_DIR      # PROJECT_DIR: che.blend + fit.json
```

The scripts are `characters.json` (description → job settings), `build_models.py`, `render_closeups.py`,
`roblox_receipt.py`, `inspect_glbs.py`, `storyboard.json` + `tts.py`, `capture.mjs` + `web/shell.html` +
`web/office.html`, and `assemble.py`.

## Reuse by other lanes (lane G realism)

- `tools/demo/tts.py`: Kokoro speech plus a 30 Hz loudness envelope in the exact shape Live Studio's `lipsync` takes.
  Swap the envelope for Rhubarb cues once visemes exist; the viewer already accepts `{cues}`.
- `tools/demo/web/office.html`: an Office stage at metre scale with a walk path at the clip's ground speed, a turn,
  a chair and a world-space sitting pose. A real sit clip or mocap should replace `sitPose()`.
- `tools/demo/capture.mjs`: the virtual-clock capture of the unmodified Live Studio page (skeleton overlay, close-ups,
  lip-sync, several frames side by side), plus the honesty label and caption overlay.
- `tools/demo/inspect_glbs.py`: a no-Blender check that two GLBs share joint names, order and clip channels.

## What remains planned

Free-text Create in the app (G5), voice per character (G6), the reopen screen (G7), hair-style geometry and body
sliders (G3/G4), photo-fit faces (G1), real brows, lashes and strand hair on the full body, turn and sit clips (lane G
mocap), viseme lip-sync (lane G Rhubarb), and an iPhone check by the owner. Nothing in this video was tested on the
iPhone.
