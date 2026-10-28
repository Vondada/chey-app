# Character realism: persistent checklist (owner request 2026-10-25)

Owner ask: realistic, animated characters from the Create room, reference photos supported, free compute only (Blender,
freely licensed models, CPU/GPU CHE already has), honest GPU detection with a CPU fallback, jobs that continue after the
app closes, retries, finished files viewable in CHE, measured render times. No new keys, accounts or paid services.

Branch: `claude/che-character-realism` (pushed after each milestone). Update this file at each step; a box is ticked
only with evidence (commit, test command and count, or run id).

## Already true before this work (verified in code, 2026-10-25)
- [x] Server-side queue keeps jobs after the app closes, with checkpoints and resume (`gpu_queue.js`, `che_creation_job.py` CHECKPOINT/RESUME).
- [x] GPU detection: `nvidia-smi` + Cycles OptiX/CUDA probe; no silent CPU fallback on the GPU path (exit 3).
- [x] Free CPU worker on GitHub Actions; live check `afb8de1` run 40153146586: full-body GLB in 1.4 min, 23,946 vertices, viewport played walk.
- [x] Finished GLB viewable in CHE's Live Studio viewport (`assets/characters/app/studio.html`).
- [x] `final` render profile: Cycles, adaptive sampling, OIDN, skin subsurface, procedural pores (`render_profiles.py`).

## Contract between the two workstreams
- Job settings gain `REFERENCE` (JSON text): `{"url": "<Worker URL the worker fetches with its worker token>", "sha256": "<hex>", "bytes": n, "consent": "self"|"fictional"}`.
- The person job's receipt gains `reference_fit`: `{sha256, method, landmarks, sliders:{...}, colors:{skin, hair, eyes}, fit_error, limits}`
  and `device_summary`: `{kind: "GPU"|"CPU", name, threads, limits}`; stage seconds are measured, never estimated.

## Workstream A: photo → character (Python/Blender), lane `lane/char-photo`
- [ ] Reference photo → face landmarks with a freely licensed CPU model; refuse no-face / multi-face photos with the reason.
- [ ] Landmarks → MPFB face sliders (reusing `face_fit.py`/`landmarks.py` ideas) + skin, hair and eye colours.
- [ ] Wired into the person_model job; receipt `reference_fit`; resumable.
- [ ] Synthetic fixtures with known sliders (no real people); recovery error measured.
- [ ] Measured CPU timing for a full person job with the final profile; sample GLB + renders inspected.

## Workstream B: Worker + app plumbing, lane `lane/char-photo-app`
- [ ] Upload a reference photo to a creation project (consent: me or fictional; size/type limits; stored by SHA-256).
- [ ] Worker passes `REFERENCE` to the person job; worker fetch route authorised by the worker token only.
- [ ] Create room shows the device (GPU or CPU), its limits and measured times; voice + VoiceOver routes.
- [ ] Tests (Worker + Flutter).

## Integration and release
- [ ] Both lanes merged into this branch; full Worker + Flutter suites green.
- [ ] PR, required checks green on the exact head, merge, deploy verified live.
- [ ] Live creation_check with a reference fixture: measured time, GLB + renders.
- [ ] Full IPA if native code changed (not expected).
- [ ] iPhone: NOT VERIFIED until the owner tries it.
