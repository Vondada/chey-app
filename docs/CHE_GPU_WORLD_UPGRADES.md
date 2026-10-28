# CHE GPU and 3D world upgrades (25 items)

Owner goal (2026-10-28): CHE builds a whole 3D world on her own, renders it, and keeps creating in the background
without the owner watching. This file lists 25 upgrades grounded in what the repo already has, with the next step for
each. Nothing here is built yet. Every item needs its own measurement before it is called done.

Existing pieces this builds on (read from the repo, not assumed):
- Brain Room: Flutter `CustomPainter`, batched `drawRawAtlas` (`docs/CHE_GPU_RENDERING.md`).
- Native scenes: `CheNativeSceneWorld` on `flutter_scene` 0.23, Performance / Balanced / Realistic tiers.
- Three.js office: `assets/office3d/*.html` with `three.min.js`, bundled offline.
- Colab T4 render worker: `scripts/che_gpu_worker.py`, Blender Cycles, queue in `che-gpu-assets`.
- Paid GPU adapters: `server/cloudflare/gpu_providers.js`, `compute_pool.js`, `gpu_queue.js`, `compute_budget.js`.

Spending rule: a paid GPU run needs the owner's yes and a daily cap above $0. The owner sets it, not CHE.

## A. Free and local GPU routes (no spend)

1. **WebGPU in the iPhone WebView, with fallback.** Detect WebGPU, fall back to WebGL, then to the native CustomPainter. Measure init failures on the real phone first.
2. **Flutter GPU compute for particles and fields.** Move the Brain's orb update into a compute pass where `flutter_scene` allows it. Benchmark against the current painter.
3. **Instancing for repeated world objects.** One draw call per mesh type, not per object, in `CheNativeSceneWorld`.
4. **Frustum and distance culling.** Skip objects outside the camera and fade distant ones. Count drawn objects per frame in the bench.
5. **Level of detail (LOD) per object class.** Three steps: full mesh, simplified, impostor sprite. Switch by distance and the tier.
6. **Baked lighting and light maps.** Bake lighting offline into textures so the phone does no real-time shadow work.
7. **Texture atlases and compressed textures.** Pack small textures and use GPU-compressed formats (ASTC on iOS) to cut memory.
8. **Thermal and Low Power guard.** Drop the tier automatically under thermal pressure or Low Power Mode. Keep the owner's choice when they set it.
9. **Frame-budget scheduler.** Spread world updates across frames so one heavy step never stalls the UI.

## B. The owner's own GPU (Colab T4, already exists)

10. **Persistent render queue with receipts.** Every job writes a receipt (scene hash, settings, time, GPU, output hash). Reuse finished frames.
11. **Scene caching by hash.** Skip a render when the scene and settings match a finished one.
12. **Progressive renders.** Render a low-sample preview first, then refine. The owner sees something early.
13. **Automatic GPU wake and release.** Start the Colab worker only when a queued job exists; keep the existing 45-minute idle stop.
14. **Blender scene export from CHE's own world format.** One validated JSON scene, not arbitrary code, so CHE can build the world and send it.

## C. Paid or rented GPU routes (owner approval and a cap above $0 first)

15. **Provider choice by price and availability.** Compare the adapters in `gpu_providers.js` on cost per render hour and queue time. Choose cheapest that meets the deadline.
16. **Spend guard in `compute_budget.js`.** Refuse any job that would pass the cap. Log every refusal with the reason.
17. **Spot or preemptible instances with checkpoints.** Save progress so a preempted job resumes instead of restarting.
18. **Batch many frames into one rented session.** Pay the start-up cost once for a whole animation, not per frame.
19. **Fallback order.** Owner's Colab first (free), then the cheapest approved rented GPU, then the local CPU preview, with the reason shown.

## D. World building and rendering quality

20. **Procedural world generation with seeds.** Same seed, same world. Saved seed plus parameters goes in the receipt.
21. **Physics-light placement rules.** Objects settle on ground and do not clip. Test with a placement checker, not by eye.
22. **Scene graph validation.** Reject broken scenes (missing models, out-of-bounds objects) before any render starts.

## E. Background creation

23. **Background job runner with state on the server.** CHE keeps building while the phone is closed; progress is saved and resumable. Uses the existing queue, not a new engine.
24. **Owner-visible progress, quiet by default.** Muted text on a banner; no spoken updates (AGENTS.md passive-status rule).

## F. Measurement

25. **Benchmark harness on the phone and in CI.** Measure FPS, frame time, draw calls, memory and thermal state per tier. Publish the numbers, never a claim without them.

## Next step

Start with items 1, 4, 5 and 25 (free, local, measurable). Items 15 to 19 wait for the owner's spend decision. Item 14 is the bridge CHE needs before she can build a world for the owner's Colab.
