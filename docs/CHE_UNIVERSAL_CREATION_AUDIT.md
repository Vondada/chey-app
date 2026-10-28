# CHE universal creation engine: Phase 1 audit (2026-10-28)

Scope: what already exists in `main` (bc… / b21d55d9 and later), what each GPU route really is, and what must be built.
Status key: **live** = a deploy probe passed on the live Worker in this session; **code** = read in the repo, not run
live; **missing** = not in the repo.

## 1. GPU and compute routes

| Route | What it is | Evidence | Status |
|---|---|---|---|
| Owner's Colab T4 worker | `scripts/che_gpu_worker.py`, runs Blender and uploads results; queued by `gpu_queue.js`; `creation_studio.js` uses it for head/person models | Creation Engine end-to-end probe was **skipped** (opt-in) in deploy run 40609806059 | **code**; not proven live. The worker runs in the owner's Google session, which I cannot reach from here. |
| Modal GPU | `modal_gpu.js` + `tools/modal/che_modal_app.py`, bearer-protected `/health`, `/blender_preview`, `/status`, `/cancel` | "Check CHE's Modal GPU connection through the live Worker (authenticated /health, no GPU)" **passed** in run 40609806059 | **live** for `/health`. Dispatch is gated by the owner's opt-in and a $0 spend limit in code (`modal_gpu.js` header). No GPU job has been run live. |
| Paid GPU adapters | `gpu_providers.js` (RunPod and others) | Read-only balance and start/stop code; no live run | **code**, paid. Needs the owner's approval and a cap above $0. |
| Hugging Face | Referenced by `ai_router.js`, `model_discovery.js`, `fine_tuning.js`, `film_pipeline.js` | Not probed in deploy logs | **code**; no verified inference endpoint in this session |
| Free GPU in the phone's browser | WebGPU in Safari 26 (search summaries only) | Not built or tested | **missing** |

Nothing above is a verified free route that needs no account. The only verified free route for real rendering is the
owner's Colab worker, once its session is running.

## 2. Editor and scene code that already exists

| Piece | What it does | Gap against the brief |
|---|---|---|
| `creation_studio.js` (Live Creation Studio) | Person presets, versions with undo/redo, plain-sentence edits ("bigger eyes"), queues `person_model` jobs to the GPU queue, shows GLB only after upload | Head and body presets, not sculpting; no brushes, skin pores or scars |
| `creation_freeform.js`, `creation_orchestrator.js`, `creation_profiles.js` | Free-form creation and render profiles | Not verified against natural-language scene editing |
| `avatar_identity.js` and `character_registry.js` | Identity parameters and persistent character records | Good base for persistent character IDs (Phase 2) |
| `world_scene.js` | Read-only projection of records into objects | **Not an editor**; no geometry, no edits |
| `internal_renderer.js` | Software rasterizer in JavaScript, procedural scenes, PNG output | Not a 3D editor; CPU-bound |
| Flutter `CheNativeSceneWorld` (`flutter_scene` 0.23) | Native 3D scenes with GLB assets and quality tiers | Viewer only |
| `assets/office3d/` (Three.js) | Office 3D viewer, offline bundle | Viewer only |
| `assets/characters/`, `assets/avatars/` | Character assets | Need an inventory before reuse |

## 3. What is missing for the brief

- **Phase 2 (persistent editable scene and asset system):** no scene-graph format for editable objects, materials, or
  versions. The creation project format covers characters only.
- **Phase 3 (touch editing of terrain, objects and materials):** no brushes, no sculpt, no layers, no masks, no
  symmetry, no snapping in the phone UI.
- **Phase 4 (character sculpting and materials):** no facial sculpting, skin detail, scars or freckles; the existing
  presets are the only edit path.
- **Phase 5 (natural-language creation):** plain-sentence edits exist for characters only, not scenes or terrain.
- **Phase 6 (physics, animation, game systems):** nothing in the repo.
- **Phase 7 (Office World integration and end-to-end tests):** the Office viewer is separate from the editor.

## 4. Decisions I'm taking (reversible, reasonable defaults)

1. **One scene format on top of the existing creation project** (`creation_studio.js` versions), not a second system.
   Objects reference GLB assets by ID; edits are versioned like character edits.
2. **Phone editing in the existing Flutter viewer**, not a new engine. Brushes and sliders are Flutter widgets; the GPU
   work stays on the Colab or Modal route when it's expensive.
3. **No paid GPU and no new account by default.** Paid routes stay behind the owner's approval (`gpu_providers.js`).

## 5. Milestones (each one a PR with tests; merge only when checks pass)

- **M2a:** scene document format (versioned, asset-ID based) with validation tests, no UI. Worker side in
  `server/cloudflare/`, tests with `node --test`.
- **M2b:** persist a character as a scene object and read it back, tested through the existing creation project store.
- **M3:** slider and pinch controls for one object's transform and material, in Flutter, with widget tests.
- **M4:** one sculpt brush (inflate) on a character mesh, measured on the iPhone before any claim.
- **M5:** plain-sentence edits for scene objects through the existing edit vocabulary (no model call).
- **M6, M7:** later; not started.

## 6. Blockers I cannot clear from here

- A real iPhone test for any touch feature (M3 onward).
- The Colab worker's live status (needs the owner's Google session).
- Any paid GPU or new account (owner approval).
