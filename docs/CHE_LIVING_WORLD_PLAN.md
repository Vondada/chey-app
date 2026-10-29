# CHE Living World Engine: audit and staged plan

Status: plan only. Nothing here is built or verified. Each stage below is a separate PR that must pass CI and be tested in the app before the next one starts.

## 1. What already exists (audited, file references from main)

| Piece | Where | What it does now | Reuse for the world |
|---|---|---|---|
| Scene document | `server/cloudflare/scene_document.js` | Pure, versioned scene: references to assets by ID, transforms, editable properties, undo/redo, no geometry copies | The persistent world scene graph (Stage 1) |
| Scene store | `server/cloudflare/scene_store.js` | Saves and lists scenes on the Worker; optimistic save (`expected_version`); 409 on reused IDs | Persistence of the world version |
| Scene timeline | `server/cloudflare/scene_timeline.js` | Turns one request into a checked plan; refuses unknown actions and characters without models | Planner for the morning construction plan |
| World population | `server/cloudflare/world_population.js` | Seeded character records; rigged GLB buckets built by the existing `person_model` job | Character reuse; no duplicate models per record |
| Spatial world view | `server/cloudflare/world_scene.js` | Read-only projection of records into objects; pure and deterministic | Morning view and before/after comparison |
| Creation objects and rooms | `server/cloudflare/creation_objects.js`, `creation_studio.js` | Versioned object and room specs (`createThing`, `editThing`) | Furniture and props as spec records |
| GPU queue | `server/cloudflare/gpu_queue.js` | Render queue in a Durable Object, worked by the owner's Colab T4 **only while the owner's session is open** | Only for explicitly authorised GPU jobs |
| Compute budget | `server/cloudflare/compute_budget.js` | Paid GPUs OFF until the owner sets a cap above $0; "stop paid GPUs" sets it back | Budget guard for billable jobs |
| Durable Object alarms | `server/cloudflare/worker.js` (13 `setAlarm` uses) | Retries and reconciles jobs without a phone open | Overnight scheduler |
| Creation Room (Flutter) | `lib/create/che_scene_studio_page.dart`, `che_scene_list_page` | Editor for a character or scene; list of saved projects | Editor for the world scene |

## 2. Constraints the audit found

1. **No unattended GPU.** `gpu_queue.js` states Colab runs only while the owner's browser session is open. Overnight generation therefore cannot use the GPU queue. Overnight work must be **non-billable and CPU or procedural** (placement, reuse, material and lighting parameters, Blender-on-worker jobs that already exist).
2. **No animal models exist.** The repo has character and room specs but no animal asset, rig, or animation set. Animals need a new, separate asset pipeline. They are a later stage, not part of the first one.
3. **Phone rendering budget.** The 3D viewer is in `lib/world/`. Its performance on the owner's iPhone has not been measured for a larger world. Every stage that adds objects must record a frame-time measurement on device.
4. **No world-wide style guide exists.** Style is currently per asset. A World Design Bible (rules per room, palette, materials, scale) must be created from approved assets before autonomous changes.
5. **The owner's approval rules are not yet in code.** No lock, protected-area, or approval queue exists for the world.

## 3. Staged plan (each stage is one focused PR)

**Stage 1: persistent world scene and locks (no autonomous changes).**
- A world scene document built on `scene_document.js`: rooms, objects, transforms, asset IDs, provenance, approval status, lock flags.
- Lock per room, object, character, or design. Locked items are never modified by any autonomous job.
- Tests: versioning, rollback to any earlier version, lock refusal, persistence across Worker restart (the Durable Object storage).
- Verification: load the world in the Creation Room and show its objects in the app.

**Stage 2: design bible and style checks.**
- Bible generated from approved assets: palette, materials, scale rules per room. Read-only checker that scores a proposed object against the bible.
- Tests: a deliberately off-style object is refused; an approved object passes.

**Stage 3: procedural decoration in approved areas (non-billable).**
- Placement of props and furniture from existing assets only (no new model generation), with collision, walkway and door clearance checks.
- A scheduled overnight job (Durable Object alarm) runs one bounded cycle: read instructions, inspect world, produce plan, check, apply low-risk changes, record each change.
- Budget guard: the job has a per-run limit of zero billable units unless the owner has set a cap.
- Tests: scheduling, retry of a failed non-billable step, recovery after an interrupted run, and a morning report built from the real change log.

**Stage 4: morning report and "What's New" view.**
- Report built only from recorded changes, with before and after snapshots and tap-to-visit.
- Undo of any autonomous change through the scene history.
- Verification: a real overnight run, then the report shown in the app.

**Stage 5+ (only after Stages 1–4 are verified in the app):** animated doors, lighting and reflection parameters, environmental sounds, and animals. Animals require a separate asset pipeline and a licence check for any third-party models before use.

## 4. Approval rules (to implement in Stage 1)

Automatic: low-risk, reversible decoration inside unlocked, approved areas, within the owner's non-billable limits.

Requires approval: removing or significantly changing an approved building or character; major architecture; publishing untested executable code; any spend beyond an authorised budget; connecting a new paid service; any change that cannot be rolled back.

## 5. Explicitly not claimed yet

- No overnight run has happened.
- No animal exists in the project.
- No iPhone frame-time measurement exists for a larger world.
- The $0.02 blue cube render is a separate, one-off authorisation and does not cover recurring spend.
