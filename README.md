# CHE GPU preview inputs (not code)

Inputs for `scripts/che_gpu_face_preview.py` (see `docs/CHE_GPU_PIPELINE.md` on main / PR #517):

- `project/che.blend`: CHE's existing scene (rig, hair cards, textures packed), Blender 5.0.1.
- `project/fit.json`: the face_fit.py identity fit (MPFB2 sliders) for the rebuilt head.
- `project/che_landmarks.npz`: CHE's measured face landmarks used by the fit.

No photographs of real people are stored here. The notebook clones this branch with the owner's read-only token.
