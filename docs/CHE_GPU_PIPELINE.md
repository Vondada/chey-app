# CHE GPU face preview (Colab T4)

GPU-only Blender Cycles previews of CHE's face, run in the owner's own Google Colab session. One pipeline:

| Piece | What it does |
|---|---|
| `notebooks/CHE_GPU_Face_Preview.ipynb` | Checks the GPU, mounts Drive, fetches the code and inputs with the owner's read-only token, installs Blender 5.0.1 (checksum-verified, cached in Drive), runs the job, shows the pictures and receipt, and (optional) pushes a copy to the separate results repository. |
| `scripts/che_gpu_push_results.py` | Copies only the view PNGs, `receipt.json` and `log.txt` of one job to `Vondada/che-gpu-results` (its own token, scoped to that repository). The token goes to git through environment variables: never printed, saved or on a command line. A rerun with nothing new pushes nothing. |
| `scripts/che_gpu_face_preview.py` | The job: probes OptiX then CUDA, refuses to render without a GPU (exit 3) or when a render reports anything but the GPU (exit 4), runs the face pre-render checks (exit 2 on a failure), renders front/three-quarter/side, writes `receipt.json` after every view and resumes finished jobs. |
| `tools/avatar_face/` | CHE's face build (`mpfb_dress.py`, the MPFB2 head fitted to her), `render_device.py` (device + size), `bl_run.py` (runs a face script inside the Blender binary), `colab/check_project.py` (Blender version, scene, packed textures, GPU list). |
| `che-gpu-assets` branch | The inputs: `che.blend`, the identity fit and landmarks. No photographs of real people. |
| `Vondada/che-gpu-results` (separate private repository) | What the notebook pushes back: `results/<job>/` with pictures, `receipt.json`, `log.txt`. Separate so the write token cannot reach `chey-app`, whose `main` branch is not protected. |

## Owner steps (once)

1. GitHub → Settings → Developer settings → Fine-grained tokens → new token, repository access **only `Vondada/chey-app`**,
   *Contents: Read-only*. In Colab: key icon → secret `GITHUB_TOKEN`, *Notebook access* on.
2. Optional, so Claude can verify the result: create an empty private repository `Vondada/che-gpu-results`, then a
   second fine-grained token with repository access **only `che-gpu-results`**, *Contents: Read and write*. Colab secret
   `RESULTS_TOKEN`, *Notebook access* on. Without it the pictures and receipt stay in Drive only.
3. Runtime → Change runtime type → T4 GPU; Runtime → Run all; allow Google Drive.

Later runs: open the notebook and Run all. Free Colab sessions are interactive and time-limited; a run cannot be
started from outside Colab. A disconnected job resumes on the next run.

## Receipt

`My Drive/CHE_GPU/jobs/<job>/receipt.json`: `status`, `nvidia_smi` (GPU name, driver, memory), `cycles_gpus`, `device`
(OPTIX or CUDA), `render_device_line` (what Cycles rendered on), `blender_version`, `checks`, and per view the file,
SHA-256 and render seconds. A GPU render counts only when its receipt says `complete` and names the GPU.

## Local tests

`python3 -m unittest tools/test_che_gpu_face_preview.py` (a stand-in Blender: GPU, CUDA-only, no GPU, CPU refused,
failed check, resume after an interruption, no re-render of finished views) and
`python3 -m unittest tools/test_che_gpu_push_results.py` (a local bare repository: only results files pushed, rerun
pushes nothing, second job added beside the first, no token pushes nothing, a failed push never prints the token).
