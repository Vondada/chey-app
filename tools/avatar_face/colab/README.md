# CHE face tests on a free Colab T4

Small 480px face stills of CHE's existing scene on Colab's free GPU. Stills only: no video renders, no paid services,
no body work. The same scripts run here on the CPU, so CPU and GPU tests stay comparable.

| File | What it does |
|---|---|
| `che_face_gpu.ipynb` | The notebook: GPU, Drive storage, Blender 5.0.1, project, compatibility check, GPU render check, face test with comparison sheet |
| `make_bundle.sh` | Packs the tools, `che.blend`, the fitted identity, landmarks, reference and progress files into one zip with a checksum manifest |
| `check_project.py` | Blender version, CHE's objects and materials, packed textures, Cycles OptiX/CUDA devices (exit 4 on a failure) |
| `../bl_run.py` | Runs a face script inside the Blender binary with the same arguments as `python3 SCRIPT` |
| `../render_device.py` | `CYCLES_DEVICE` (CPU, CUDA, OPTIX; a missing GPU exits 3, never a silent CPU fallback) and `TEST_RES` (long edge) |

## Connect

1. Put `che_face_bundle.zip` in **My Drive/CHE_face/** (create the folder).
2. Open `che_face_gpu.ipynb` in Colab (File → Upload notebook), then Runtime → Change runtime type → **T4 GPU**.
3. Run the cells in order. Cell 2 asks for Drive access. Cell 3 downloads Blender 5.0.1 once into the Drive cache and
   checks it against blender.org's SHA-256.
4. Cells 5 and 6 must show `CHECK PASS` lines and a `DEVICE OPTIX ['Tesla T4']` line before any face test.
5. Cell 7 runs the pre-render checks, renders one still and saves `tests/<time>/sheet.png` beside the reference.

Optional: a read-only GitHub token saved as the Colab secret `GITHUB_TOKEN` lets cell 4 pull the latest tools from the
work branch. Keep it in Colab Secrets only.

## Rebuild the bundle

```
bash colab/make_bundle.sh OUT.zip che.blend fit.json che_landmarks.npz reference.png [progress.blend ...]
```
