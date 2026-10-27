# Colab helpers for CHE's face

The Colab GPU pipeline is `notebooks/CHE_GPU_Face_Preview.ipynb` with `scripts/che_gpu_face_preview.py`; see
`docs/CHE_GPU_PIPELINE.md`. This folder holds `check_project.py`, which the job runs first inside Blender: Blender 5.0,
CHE's objects and materials, packed textures, and the OptiX/CUDA devices Cycles sees (exit 4 on a failure).
