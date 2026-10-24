# Creation Engine tools: research, choices and measured results

Owner request (2026-10-24): "Upgrade CHE's Creation Engine for speed and photorealism. Keep Blender as CHE's main 3D
engine… Benchmark the existing pipeline against the upgraded pipeline using the same scenes and hardware. Report real
render times, memory usage, visual quality, and completed files. Do not invent speed improvements."

Blender stays the engine. Nothing here is a second engine or queue: the upgrades live in the existing pipeline
(`server/cloudflare/creation_profiles.js` → `gpu_queue.js` job settings → `scripts/che_gpu_worker.py` →
`scripts/che_gpu_face_preview.py` → `tools/avatar_body/render_glb.py` with `render_profiles.py`, plus
`roblox_export.py`).

## What CHE now chooses automatically (creation_profiles.js)

| Kind | Pipeline | Tools | Exports | GPU | Status |
|---|---|---|---|---|---|
| person | Blender full body | MPFB2 body, skeleton and weights; clothing, hair cap, face morphs; 5 clips; rig check; quick look; Cycles final | GLB | preferred | built |
| roblox | the person pipeline + R15 export | `roblox_export.py`: 17 R15 joints, 15 `_Geo` parts in Roblox's triangle budget, ≤4 influences, FBX read back and validated | GLB, R15 FBX, walk FBX | not needed | built |
| movie | Film Studio (`tools/che_film_render.py`) | characters come from the person pipeline as GLB | MP4 | preferred | separate pipeline |
| object | parametric object generator (Create Object lane) | quick look, Cycles final | GLB | not needed | separate lane |
| room | parametric room generator (Create Room lane) | quick look, Cycles final | GLB | preferred | separate lane |
| invention | `invention_model` job on the same queue and runner as objects (`scripts/che_creation_job.py`) | the template's named parts from `invention_visuals.js`; `tools/avatar_body/inventions.py` bevels and subdivides each part, PBR metal and emissive materials; `verify_glb.py --static` measures it; Cycles views | GLB | not needed | built |

### Inventions: placeholder first, refined model from the Creation Engine

"Open it in 3D" works in two steps:
1. The Worker builds an instant box-parts GLB, labelled "instant box-parts placeholder model, not the Blender build".
2. It queues an `invention_model` job with the same parts and palette. CHE says it is queued.

The refined GLB is served at `/api/inventions/<id>/model.glb?refined=1` once the job completes, and at
`/api/gpu/jobs/<job>/model.glb`.

Real local run on the inv-8a637dad Iron Man-style suit (30 parts, 3,565-character spec from the Worker's own code),
CPU only:
- Exit 0 in 21 s.
- 30 meshes, 23,040 triangles, 4 materials, measured 0.79 × 1.87 × 0.41 m and verified against the parts.
- 3 Cycles views at 32 samples, about 4–9 s each.

What it shows: bevelled painted-red armour, gold machined-metal panels, dark joints, and emissive eyes, chest core and
palm lights. It is still blocky, because the template's parts are boxes; the refinement is edges and materials, not
new shapes.

`kindFromText` picks the kind from the owner's words ("CHE, create a Roblox character" → roblox). In Creation Studio,
"make it Roblox ready" turns the Roblox export on for a person; "no Roblox" turns it off.

## Render profiles (render_profiles.py)

- **legacy**: the pipeline as it was. Cycles at the quality preset's samples with Blender 5.0.1's defaults, which already
  include adaptive sampling (threshold 0.01) and OpenImageDenoise (checked with `bpy` on 2026-10-24).
- **preview** (quick look): rendered before the final views, in its own Blender process. EEVEE is tried first when
  `PREVIEW_ENGINE` is auto. Where Blender has no OpenGL/EGL context, EEVEE aborts the process (measured here: exit -6,
  "Couldn't open libEGL.so.1"), so the runner falls back to Cycles at 4 samples, OpenImageDenoise and half size. Quick looks
  are stored apart (`quick_previews`) and never count as a finished view. The app shows them, labelled "quick look; the
  final render is still in progress", until each final view arrives.
- **final**: Cycles with
  - an adaptive stop at threshold 0.02 after at least 16 samples, with the preset's samples as the ceiling;
  - OpenImageDenoise with albedo and normal passes (on the GPU too, when a GPU renders);
  - light paths capped (6 total, 3 diffuse, 3 glossy, no caustics, indirect clamp 6);
  - persistent data across the views of one session.

  Materials: skin subsurface scattering (radius 1.0/0.2/0.1, scale 0.008 m), a pore micro-normal and a thin coat; cloth
  sheen tinted with the cloth's own colour, plus a woven micro-normal; a wet cornea coat on the eyes; strand-direction
  micro-normal on the hair. All procedural nodes, no downloaded textures.
- GPU: `render_device.py` already selects OptiX or CUDA on a Colab T4 and never falls back to the CPU silently. The final
  profile runs the same way there. **No GPU benchmark has been run** (no GPU is connected).

## Benchmark: how it runs

`tools/creation_benchmark.py` builds CHE's full-body character once (`mpfb_body.py`, CC0 MPFB2 data at the pinned
commit). Then, each in its own Blender process, measured with `os.wait4` (wall time and that process's own peak RSS),
it renders:
- legacy and final in `--repeat` alternating rounds;
- the quick look;
- the face close-up in both pipelines;
- each pipeline's 512-sample converged reference.

Quality is measured three ways:
- SSIM and PSNR against the pipeline's own reference: is it converged?
- An Immerkær noise estimate on every picture.
- The pictures themselves.

The materials differ between the pipelines on purpose.

- **Reproducible run:** `.github/workflows/che-creation-benchmark.yml` runs it on a free GitHub-hosted runner with the
  creation worker's exact Blender. It triggers on `workflow_dispatch` and on pull requests that change the benchmark or
  render files, uploads the pictures and JSON, and writes the numbers to the job summary.
- **Local run:** done 2026-10-24 on the cloud dev box. Results in `docs/benchmarks/creation_local_2026-10-24.json`.

## Measured results so far (local dev box: CPU only, shared, contended)

Machine: Intel Xeon @ 2.10 GHz, 4 cores, 15.7 GiB, Blender 5.0.1 as the `bpy` module. Other agents were running on it,
and the 1-minute load before the timed runs was **2.7–13.7 on 4 cores**: every time below is inflated and noisy. Scene:
CHE full body, 12,759 vertices, 1,141,472-byte GLB, three views (0°, 45°, 90°), 320×480, Standard preset (64 samples).
File: `docs/benchmarks/creation_local_2026-10-24.json`, from the run with the corrected first-picture formula.

| Measure | Legacy | Upgraded |
|---|---|---|
| Time to the first picture CHE can show | median 12.7 s over 4 rounds (11.2–17.7 s; the first final view) | **3.7 s** (one Cycles quick-look run; EEVEE could not start here) |
| Render time, 3 views, median of 4 alternating rounds | 34.7 s | 38.1 s |
| Final vs legacy, per-round range | | 0.77× to 1.91× (inconclusive: the box was contended) |
| Peak memory (RSS, per process) | 487 MiB | 492 MiB final, 391 MiB quick look |
| Convergence vs own 512-sample reference (front) | SSIM 0.9981, PSNR 46.2 dB | SSIM 0.9981, PSNR 46.5 dB |

An earlier run under lighter load (2.7–8.2) showed the same pattern: quick look 1.4 s against a legacy first picture of
5.6–10.9 s, and final at 0.85× of legacy at the median with a 0.37–2.18× spread. Its stored first-picture figure was
wrong: a bug subtracted the median render time instead of the run's own. That bug is fixed and covered by a test, and
the run was redone.

What this shows, and what it does not:
- **Proven on this machine:** the first real picture of the model appears several times sooner (3.7 s against a median
  of 12.7 s here; 1.4 s against 5.6–10.9 s under lighter load). Both pipelines converge equally well at Standard.
- **Not proven:** that the final renders are faster. On this contended box they were not faster at the median. The
  GitHub-runner benchmark is the clean comparison; until it runs, CHE claims no speed-up for the final renders.
- **Visual detail:** at 320×480 the final profile's skin and cloth changes are subtle. A full-body view hides them, and
  the face close-up shows softer, slightly warmer skin, not visible pores. Two regressions found in the first pictures
  were fixed before these numbers: untinted sheen made the dark hair grey and the trousers shiny. **The limiting factor for
  "much finer detail" is the model, not the renderer.** The body has no skin, eye or cloth textures. The next real step is
  CC0 MakeHuman skin and eye textures (MakeHuman system assets). Their download servers answered 403 from this sandbox,
  but a GitHub runner can fetch them.

## Roblox export: measured

On CHE's real body GLB (2026-10-24, local):
- 25,384 input triangles became 9,934 across the 15 `_Geo` parts (budget 10,742; Head 3,880 / 4,000).
- 17 joints in Roblox's R15 hierarchy, at most 4 influences, nothing weighted to the Root.
- `character_r15.fbx` is 624,092 bytes; `walk_r15.fbx` is 115,660 bytes.
- Read back, the walk FBX moves the hips up to 52°, the knees 43° and the shoulders 35°.
- Verdict: **Studio-import ready by the documented rules; not Marketplace-ready.** There are no `_OuterCage` meshes, no
  `_Att` attachments, and the parts are not capped watertight.
- Face morphs are not exported: Roblox Dynamic Heads use FACS poses.
- Finger and spine bends are merged into the hand and torso.
- **Not verified in Roblox Studio itself** (it doesn't run here).

How to use it: in Roblox Studio, open the Avatar tab, choose Import 3D, pick `character_r15.fbx` and set the rig type to
R15. Then import `walk_r15.fbx` in the Animation Editor. CHE serves both at `/api/gpu/jobs/<id>/fbx_r15.fbx` and
`/api/gpu/jobs/<id>/fbx_r15_walk.fbx`.

## Research verdicts (sources read 2026-10-24)

| Tool | Licence / cost | Hardware | Free-tier fit | Verdict |
|---|---|---|---|---|
| Blender 5.0.1 Cycles (CPU) | GPL, free | GitHub runner CPU | yes, used now | keep; final profile |
| Cycles OptiX/CUDA | free | NVIDIA GPU (Colab T4) | only while the owner's Colab session runs | supported by `render_device.py`; not benchmarked (no GPU connected) |
| EEVEE | free | needs OpenGL/EGL; Blender falls back to headless EGL on Linux ([commit 3195a38](https://developer.blender.org/rB3195a38)) | unknown on runners (Mesa `libegl1` installed); aborted here without libEGL | tried first for quick looks, with an automatic Cycles fallback |
| OpenImageDenoise | Apache-2.0 (bundled) | CPU or GPU | yes | used (albedo and normal passes) |
| MPFB2 / MakeHuman assets | code GPL/AGPL; core assets CC0, some packs CC-BY ([licence](https://static.makehumancommunity.org/about/license.html), [asset packs](https://static.makehumancommunity.org/assets/assetpacks/index.html)) | any | yes | keep; next step is CC0 skin and eye textures (check each pack's licence) |
| Human Generator Ultimate | paid, $51–$128 ([Superhive](https://superhivemarket.com/products/humgen3d)) | — | **no** (costs money) | not used |
| Rigify | bundled with Blender (GPL) | any | yes | not needed for the game-engine skeleton; the R15 export maps MPFB's skeleton directly |
| Rhubarb Lip Sync | MIT ([LICENSE](https://github.com/DanielSWolf/rhubarb-lip-sync/blob/master/LICENSE.md)) | CPU | yes | fits CHE's existing `mouth_open` morph and the Live Studio lip sync; not added in this change |
| Mixamo | free for commercial and non-commercial projects; raw files may not be redistributed; no ML training ([Adobe FAQ via the community forum](https://community.adobe.com/questions-696/mixamo-faq-licensing-royalties-ownership-eula-and-tos-589400)) | — | needs the owner's Adobe account (manual) | not automated |
| CMU Mocap | research use free; inclusion in commercial products allowed; no direct resale (CMU notice as quoted by [4TU](https://data.4tu.nl/datasets/0448aab2-3332-449f-a8e2-d208cb58c7df)); derivatives vary (one is CC BY-NC) | — | yes, with attribution | candidate source for more clips; not added |
| Unreal Engine + MetaHuman | free under $1M revenue; since 5.6 (June 2025) MetaHumans may be used in other engines and DCC tools ([metahuman.com/license](https://www.metahuman.com/en-US/license), [CG Channel](https://www.cgchannel.com/2025/06/you-can-now-sell-metahumans-or-use-them-in-unity-or-godot/)); reported to bar AI/ML training (verify in the EULA) | Epic recommends 16 cores, 32 GB RAM, RTX 3070-class 8 GB GPU ([Epic](https://dev.epicgames.com/documentation/metahuman/metahuman-hardware-requirements-in-unreal-engine)) | **no** free cloud fits (runners have no GPU; the Colab T4 is not an Unreal workstation) | interop only: CHE's GLB and FBX import into Unreal. No MetaHuman render is claimed or attempted |
| Roblox Studio import | free | — | yes | built (above). Rules from Roblox's own docs: [character body specs](https://github.com/Roblox/creator-docs/blob/main/content/en-us/avatar/character-bodies/specifications.md), [general specs](https://github.com/Roblox/creator-docs/blob/main/content/en-us/art/modeling/specifications.md) (20,000 triangles per mesh, 4 influences), [texture specs](https://github.com/Roblox/creator-docs/blob/main/content/en-us/art/modeling/texture-specifications.md) (1024 maps), [Blender export settings](https://github.com/Roblox/creator-docs/blob/main/content/en-us/art/modeling/export-requirements.md) |

## Caching, checkpoints, batching, resume (existing, extended)

- The model, rig and animation are checkpointed by sha256, and a resumed job reuses them (unchanged).
- A finished view is reused while its PNG and receipt hash match (unchanged).
- Quick looks are kept per view (`quick_<view>.png`, `receipt.quick_previews`) and are not rendered again.
- The Roblox export is reused while the model's sha256 is unchanged.
- All views of a run render in one Blender session, and the final profile keeps the scene data between views.

## Next steps (not done)

1. Run the GitHub-runner benchmark (automatic on the PR) and replace the local numbers above with its clean ones.
2. CC0 skin and eye textures from the MakeHuman system assets: the real path to finer visual detail.
3. A Colab T4 benchmark when the owner's GPU session is online (final profile on OptiX).
4. Roblox: outer cages and attachments for Marketplace bodies, and FACS poses for Dynamic Heads.
5. Rhubarb visemes driving the existing `mouth_open` morph from real speech audio.
