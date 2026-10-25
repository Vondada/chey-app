# CHE realism stack: what each tool does, measured numbers, and how close the sample is to the references

Lane G (`lane/char-realism`). Written 2026-10-25 from code in this branch and runs in this container; every number
below says where it was measured. Reference notes: `docs/CHE_REALISM_REFERENCES.md` (the owner's two videos are
AI-generated Instagram drama footage). Checklist: `docs/CHE_CHARACTER_REALISM_CHECKLIST.md`, row G15.

**Rule: AI-generated video is never proof of rig motion.** The realism sample is a Blender render of CHE's rigged
model; every frame comes from the armature. Generated video (Wan2.2 or any other model) is a separate cinematic path,
always labelled as generated, and never shown as evidence that the rig can walk, sit or speak.

## The sample (owner's first deliverable)

`tools/cinematic/sample.py` builds CHE (identity preset `che`, photoreal, through the real `mpfb_body.py` pipeline)
and renders 17.75 s at 24 fps (426 frames), 1280x720:

| Time | Shot | What happens |
|---|---|---|
| 0.0-8.1 s | wide, 30 mm | walks into the office on an arc, turns around and sits on the stool |
| 8.1-9.9 s | medium, 45 mm | seated, settles, looks to camera, hands start gesturing |
| 9.9-14.9 s | face close-up, 50 mm f/2.8 | speaks the line (lip-sync from the audio), blinks, saccades, smile and brow beats |
| 14.9-17.75 s | skeleton overlay | the same armature drawn as bones (octahedra + joints) over a see-through body, still gesturing |

Line: "Hi, I'm CHE. Welcome back to your office. Everything is ready when you are." (Kokoro, 5.18 s, speech at 10.07 s).

Outputs: frames, `che_realism_sample.mp4` (H.264 + AAC, captions say what each segment is and that it is a Blender
render), `che_interactive.glb` (the rigged character with 15 animations and 25 face morph targets), `receipt.json`
(device, stage and per-frame times, peak memory, rig check, foot contact, seam, lip-sync lag, licences).

How to run:
- CI (free GitHub CPU runners): Actions → **CHE Creation Worker** → mode `realism_sample` (on this branch:
  `gh workflow run che-creation-worker.yml --ref lane/char-realism -f mode=realism_sample`). Six render shards plus a
  mux job; the MP4, GLB and receipt are uploaded as the `che-realism-sample` artifact and pushed to
  `che-character-samples/realism/<run id>`. **Not run yet** (no CI run was dispatched from this session).
- Locally: `blender -b --factory-startup -P tools/cinematic/sample.py -- --out OUT --line-wav
  tools/cinematic/assets/che_line.wav --rhubarb CUES.json --fit FIT.json`, then
  `python3 tools/cinematic/mux.py --dir OUT --line-wav tools/cinematic/assets/che_line.wav`.

## What each tool contributes

| Tool | Role in the stack | Status |
|---|---|---|
| **Blender 5.0.1** | Scene assembly, armature evaluation, glTF export, rendering. Same version as the creation worker. | used |
| **Cycles (CPU)** | The renderer for the sample: path tracing, subsurface skin, Principled Hair BSDF strands, depth of field, OpenImageDenoise. 8 samples (12 in the close-up), adaptive threshold 0.04, 5 bounces, AgX. | used |
| **Eevee** | Not usable here: in this GPU-less container a 640x360 Eevee render ran 63 s, printed `EGL_BAD_MATCH` and wrote a blank frame (measured 2026-10-25). It needs a GPU (or a working software OpenGL context). GitHub runners have no GPU either. | not used |
| **MPFB2 (MakeHuman)** | Body mesh from the identity preset, the 53-bone `game_engine` skeleton, clothing, mesh hair, the 16 expression units added as shape keys (CC0 targets), teeth and tongue from the helper meshes. | used |
| **Skeleton** | Never changed: bone names and count are checked before export (`character.check_skeleton`). `rig_check` plays the action in Blender and reads the evaluated feet, pelvis and head back every frame. | used |
| **Mocap clips** | CMU subject 86 trial 15 (walk-turn-sit and seated gesture of the same take), retargeted onto CHE (`tools/avatar_motion`), crossfaded over 0.58 s, foot-locked, with breathing and finger curl layered on. Ten clips in `clips.json` are pinned by URL and SHA-256 and also exported as GLB animations. | used |
| **Rhubarb Lip Sync 1.13.0** | Mouth cues from the WAV (with the dialogue text as a hint), offline, deterministic. 9.1 s for the 5.2 s line on this container's CPU; 31 cues. `face_anim.visemes` turns cues into unit blends with lead and coarticulation. | used |
| **MediaPipe** | Evaluated for speech-driven mouth and rejected for that job: Face Landmarker reads a *face in an image or video* (52 blendshapes); it has no audio-to-mouth model. It stays the right tool for capturing the owner's own face from a camera (lane A already uses it for the photo fit). | not used here |
| **Kokoro-82M** (sherpa-onnx) | The spoken line, offline, speaker 0 at 0.94 speed (the iPhone app's model). The 248 KB WAV is committed as an asset so CI renders the same line. | used |
| **Poly Haven** | HDRI `hotel_room` at 1K (CC0), the copy Blender bundles as `studiolights/world/interior.exr`, so nothing is downloaded. Furniture and props are procedural (`rooms.py`, `objects.py`); no third-party models. | used |
| **ffmpeg** | Muxes frames, the delayed line and captions into the MP4. | used |
| **ComfyUI + Wan2.2** | GPU-only cinematic path for reference-level frames (video diffusion conditioned on a CHE render). Wan2.2 is Apache-2.0 (as recorded in `server/renderfarm/LICENSES.md`); the TI2V-5B model targets a 24 GB-class GPU per its model card (from memory: Hugging Face is not reachable from this container). ComfyUI must run with `--disable-api-nodes` (flag verified in ComfyUI v0.3.60 `comfy/cli_args.py`) so no paid partner node can load. CHE has no free unattended GPU, so this path is **not built** and nothing in the sample uses it. | not built |

## Measured numbers

Device for all local numbers: this dev container, 4 vCPU (shared with other sessions; load average recorded with the
render), 15 GB RAM, no GPU; Blender 5.0.1 as the pip `bpy` module.

| What | Result | Where |
|---|---|---|
| Scene build (body, rig, clips, face, GLB export, cinematic layers) | 28-39 s | `--no-render` runs |
| Render, 1280x720, per shot (single probe frames, 8/12 samples) | wide 28 s, medium 32 s, close-up 46 s, skeleton 15.5 s | probe run, load avg about 10 |
| Same frame uncontended (wide, 8 samples) | 14.4 s, of which OIDN denoise about 5.7 s; 1.1 s per sample | `exp_time3` |
| Full 426-frame render | see "Local full render" below | |
| Interactive GLB | 4.95 MB, 27,607 vertices, 54,534 triangles, 53 bones, 15 animations, 25 morph targets; within budget | receipt `interactive` |
| Rig check (Blender-evaluated vs planned) | 0.00 mm max deviation over 426 frames (feet, pelvis, head) | receipt `rig_check` |
| Foot contact, walk steps (first 4.8 s) | 0-10 mm slip per contact (heel or ball while grounded) | `test_realism_sample` |
| Foot contact, turn-and-sit and seated | up to 61 mm (left, long seated segment) and 46 mm (right, the pivot before sitting) | receipt `rig_check.contact` |
| Crossfade seam (walk → seated gesture) | max 6.3° per frame inside the fade vs 23.7° (99th pct) elsewhere: ratio 0.27, no pop | receipt `timeline.seam` |
| Lip-sync timing | lag 0 ms (within one 41.7 ms frame), mouth/audio-envelope correlation 0.31 over the speech span | receipt `face` |
| Head roll while talking | 10.6° → 3.8° mean after the counter-roll layer | receipt `head_roll_deg` |

The lip-sync correlation used to be reported as 0.73: the silence around the line was counted, so it was inflated.
`lip_sync_lag` now scores only the speech span. 0.31 is the honest figure for "mouth opening vs loudness"; a mouth
does not open in proportion to loudness (closed-lip consonants are loud), so the lag, not the correlation, is the
timing check.

### Local full render

PENDING (filled in from the finished run's receipt).

### CI estimate

GitHub-hosted `ubuntu-latest` runners are also 4 vCPU without a GPU. At the probe's 15-46 s per frame, 426 frames are
about 2-3.5 hours on one runner, so the job is split into 6 shards of about 71 frames (roughly 20-45 minutes each plus
about 3 minutes of setup), under the 150-minute shard timeout. Unverified until the workflow runs.

## Against the reference checklist (honest)

| Area | References (AI-generated) | This sample (Blender, CPU) | Gap |
|---|---|---|---|
| Skin | pores, sheen, uneven tone | SSS, pore and crease bump, T-zone roughness, mottling, blush, lip gloss | reads as good CG skin at 720p; no scanned albedo or micro-displacement |
| Eyes | wet highlights, lids track gaze | wet coat, saccades, blinks (9), lid follow, look at camera | no caruncle/tear line or separate cornea bulge; eyes look slightly heavy-lidded |
| Hair | individual curls, flyaways, volume | 420 guide strands x 36 children in the close-up, 1/4 of them in wider shots; follows head and upper spine | straight long hair, no curls or physics; the mesh cap shows at the parting |
| Expression | micro-expressions | 16 expression units, smile/brow/squint beats, lip press | limited by MakeHuman units; no wrinkle maps |
| Body | weight shifts, settling, breathing | real mocap (walk, turn, sit, gesture), breathing, seat matched to hip height | foot slide during the turn-and-sit pivot (up to 61 mm); no hand-prop contact |
| Hands | holding phone/cable | mocap hands + procedural finger curl | no finger mocap, no props, no hand IK |
| Cloth | folds, drape | MPFB top and trousers with woven bump and sheen | no cloth simulation; the neckline of the top clips at the collarbone in the close-up |
| Camera/light | handheld, DOF, practical light | smooth handheld shake, DOF, lamp practical, window fill, rim, HDRI bounce | close to the references' grammar, CG look remains |
| Identity | same faces across shots | same rig and preset in every shot | n/a |

Bottom line: the sample shows that CHE's own rig walks, turns, sits, gestures and speaks with timed lip-sync, and the
skeleton pass shows the bones doing it. It looks like a decent CG character, not like the references: those frames come
from a video diffusion model, which needs a GPU CHE does not have unattended.

## Files

- `tools/cinematic/sample.py` scene, timeline, camera plan, face tracks, rig check, render loop (`--shard`, `--resume`)
- `tools/cinematic/timeline.py` body timeline, crossfade seam report, shard ranges (no Blender)
- `tools/cinematic/scene.py` office set, lights, handheld camera, skeleton overlay
- `tools/cinematic/realism.py` cinematic skin, eyes, cloth, teeth/tongue, strand brows, lashes and hair
- `tools/cinematic/interactive.py` GLB export with the budget check
- `tools/cinematic/mux.py` shard merge, MP4, licences in the receipt
- `tools/avatar_motion/` clip library, retargeting, foot lock, `contact_slip`
- `tools/avatar_facial/` expression units, visemes, blinks, gaze, lip-sync lag
- `tools/test_realism_sample.py`, `tools/test_avatar_motion.py`, `tools/test_avatar_facial.py`
- `.github/workflows/che-creation-worker.yml` mode `realism_sample`
