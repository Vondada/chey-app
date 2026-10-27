# CHE compute pool (character builds)

**Code:** `server/cloudflare/compute_pool.js` (+ `compute_pool.test.mjs`, `compute_pool_bench.mjs`).
**Where:** `GET /api/creations/pool` (owner), `GET /api/creations/probe/pool` (deploy probe token only),
or say "which computers can build characters" / "why is my character waiting" (`/cloud-gpu pool`).

The pool sits on top of the Creation Engine queue that already existed. It is not a second queue or orchestrator.
- Jobs, leases, checkpoints and resume stay in `gpu_queue.js`.
- `creation_orchestrator.ensureCapacity` still starts the free GitHub CPU worker.

The pool adds these things for the `person_model` (Blender) workload:
- **A provider registry.** Each provider records whether it can run Blender, with the evidence. It records whether a credential is already saved (yes or no only, never the value), its real quota where an API exists, a status and a plain reason.
- **Cooldowns.** Each provider has one. Quota answers wait until the reset time when it is known. Other failures back off exponentially (5 min, 10 min, 20 min …), capped at 6 hours.
- **Bounded attempts.** A job gets at most 3 provider attempts. Then it stays queued with a plain waiting reason. It never fails silently.
- **A handoff log.** Each entry records which computer failed, why, and which one took the job next.
- **One optional GPU route: a Kaggle character kernel.** It is used only if a Kaggle token is already saved in Keys.

Spending stays $0 unless the owner sets a GPU budget. Since 2026-10-25, prepaid RunPod and Vast.ai GPUs can be used, but only after the owner says "allow up to 20 dollars for GPUs" (or sets it on the pool screen). They come after every free route, they are used only for GPU jobs, they never pass the cap, and each machine is deleted after its job. See `docs/CHE_GPU_BUDGET.md`. The pool never asks for a key on its own, never creates an account, never pays and never bypasses a login, quota or access limit.

## Provider matrix

Statuses are `ready`, `cooling_down`, `no_credential`, `incompatible`, `unverified` and `offline`.

| Provider | Runs Blender? | Evidence | Credential (already there?) | Quota read | Meets "no new keys or manual setup"? |
|---|---|---|---|---|---|
| `github_actions_cpu`: free GitHub CPU worker | **Yes, verified** | Run 40153146586 built a full-body rigged GLB in 1.4 min (23,946 vertices, 5 clips) | None for the worker (GitHub OIDC). `CHE_GITHUB_TOKEN` on the Worker starts it. | Repository visibility, re-read hourly; free minutes when public; concurrency cap `max_cloud_workers` | **Yes.** This is the default. |
| `colab_gpu`: owner's Colab T4 | Yes | `notebooks/CHE_GPU_Face_Preview.ipynb` runs `che_gpu_worker.py` with Cycles CUDA/OptiX | The paired worker token | Heartbeat only. Colab has no quota API. Ready only with a heartbeat from the last 90 s. | **No.** The owner must open the notebook each time; free Colab cannot be started remotely. |
| `kaggle`: CHE character kernel | Expected to, but **unverified** | Only through the kernel `characterKernelScript` generates. The Film Studio Kaggle farm runs a video model, which does not prove Blender works there. | `KAGGLE_API_TOKEN` (username:token), from the owner's saved Keys (`provider_keys`, the same store `farmProviders` reads) or the Worker env | **Real:** `GetAcceleratorQuotaStatistics` (weekly GPU seconds, refresh time), re-read at most hourly | **Only if a token is already saved.** As of this change nobody knows whether one is. With none saved, using Kaggle would need a new account and key, so it cannot meet the rule and the pool never asks. |
| `runpod`: RunPod Community Cloud (prepaid) | Expected, **unverified** | The same character kernel in `nvidia/cuda:12.4.1-runtime-ubuntu22.04` (`docs/CHE_GPU_BUDGET.md`) | `RUNPOD_API_KEY` via "CHE, connect RunPod" | **Real:** prepaid balance (`clientBalance`), read at most hourly; billed cost per Pod from `/billing/pods` | **No:** a new account, prepaid credit and a GPU budget, all the owner's |
| `vast`: Vast.ai marketplace (prepaid) | Expected, **unverified** | As for RunPod; the rent body follows vast-cli | `VAST_API_KEY` via "CHE, connect Vast" | Prepaid `credit` from `/users/current` | **No:** as for RunPod |
| `modal`: Modal T4 (included credit) | Expected, **unverified** until a GLB | CHE's own Modal app (`tools/modal/che_modal_app.py`) behind Modal proxy auth runs `che_gpu_worker.py`; see `docs/CHE_MODAL_FREE_FIRST_USAGE_PRIVACY.md` | `MODAL_TOKEN` = Proxy Auth Token + endpoint via "CHE, connect Modal", Connected only after an authenticated `/health` | **None observable** (Starter has no billing API): CHE's own ESTIMATE per month with a stop line below the owner's stated credit | **No:** account, $0 spend limit, deploy workflow, token and the owner's opt-in |
| `hf_zerogpu`: Hugging Face ZeroGPU | **No (incompatible)** | Hugging Face docs, `hub-docs/docs/hub/spaces-zerogpu.md`, read 2026-10-25. Details below. | `HF_TOKEN`: empty in the deploy env | — | No. It also needs a token, which is empty. |
| `workers_ai`: Cloudflare Workers AI | **No (incompatible)** | Hosted inference models only. No custom binaries. | AI binding | — | n/a |
| `cloud_computer` (`CHE_COMPUTER_URL`/`TOKEN`) | Unknown | The endpoint never reports its software | Empty (deploy run 40152765240) | — | **No.** It needs credentials and Blender installed there. |
| `vmware_training` (`CHE_VMWARE_TRAINING_*`) | Unknown | URL/token pair only; no Blender worker | Empty | — | **No.** |
| `hf_training` (`CHE_HF_TRAINING_*`) | Unknown | URL/token pair only; no Blender worker | Empty | — | **No.** |

**What the ZeroGPU docs say:**
- "ZeroGPU Spaces are exclusively compatible with the Gradio SDK".
- "a real GPU is only available inside `@spaces.GPU` functions". Outside them, a "PyTorch CUDA emulation mode" is enabled.
- It is designed for "PyTorch-based GPU Spaces".
- Free accounts get 5 minutes of GPU a day, and each call defaults to 60 s.

Blender Cycles is not PyTorch and runs as its own process. Nothing in those docs says a subprocess can use the GPU, so the pool marks ZeroGPU incompatible.

**Bottom line:**
- The only provider that is both verified and needs nothing new is the free GitHub CPU worker.
- Colab always needs the owner's hands.
- Kaggle is usable only if he already saved a Kaggle token.
- Everything else either cannot run Blender or would need new credentials and setup.

## Scheduling on the existing queue

- **Selection** (`selectProvider`):
  - A ready GPU goes first: Colab with a fresh heartbeat, then a verified Kaggle.
  - Otherwise the free CPU worker, which stays the default.
  - CPU-only work (`requires.gpu: none`) prefers the CPU, which leaves the GPU free.
  - An **unverified** Kaggle is chosen only for a GPU-only job, or when the owner allowed it: `POST /api/creations/pool/settings {"allow_unverified_gpu": true}`.
- **GPU-only jobs never run on a CPU.** `gpu_queue.compatible` decides this; the pool never widens it.
- **Claims** (`gpu_queue.claim` → `poolAllows`). A worker is handed nothing when any of these holds:
  - its provider is out of quota (a cooldown with `block_claims`);
  - the job is reserved for another provider's starting session;
  - the job is held after 3 attempts and this provider was one that failed it.

  A provider that has not failed the job may still take it during a hold.
- **Failures:**
  - A lost session (lease expired), no GPU, a quota answer (429, "quota", "rate limit") or a provider error (out of memory, session ended) is the computer's fault. The job is re-queued **without using one of its 3 job attempts** (`MAX_FAILURES`), and the provider cools down.
  - The first lost session retries at once. A crashed runner says little about the provider, and this keeps the existing immediate redispatch.
  - A job's own failure (checks failed, a missing receipt) uses the existing attempt count, as before.
- **Bounded attempts.** After 3 provider failures in a round, the job is held until the earliest cooldown ends. The hold lasts at least 10 min and at most 6 h. The job carries a reason such as "Waiting until 14:05 UTC: 3 attempts could not finish it (…). It stays queued with its finished stages …". After the hold a new round starts.
- **Resume.** Every handoff resumes from the job's last checkpoint (`gpu_queue` checkpoints and the uploaded GLB). A finished stage is never rebuilt.
- **GitHub dispatch.** A 429 answer, or a rate-limit 403, cools the CPU worker down. CHE does not re-dispatch until the cooldown ends, and the waiting job says so.
- **Receipts.** Every completed job's receipt carries:
  - `provider`: the provider id;
  - `attempts`: the provider attempts it took;
  - `provider_device`: the device the worker reported.

  `tools/creation_accept.mjs` reads these.
- **State.** Pool state lives in Durable Object storage under `pool:state`: cooldowns, the last 50 handoffs, verified receipts, the quota cache, the session record and the token hash. Per-job attempt records live on the job (`job.pool`, at most 6, plus a total count).
- **No schedule.** In line with the owner rule, nothing runs on a timer. The pool acts when the app polls, when a job is created, or when a worker calls in.

## Kaggle character kernel

`characterKernelScript` builds the kernel and `startKaggleCharacterSession` pushes it through `SaveKernel`. The kernel:
- is private and runs on a GPU T4 with internet on;
- has `sessionTimeoutSeconds` set to 3 h, so Kaggle itself stops it.

**What the kernel does:**
- Downloads the official Blender 5.0.1 tarball from download.blender.org and checks it against blender.org's published `.sha256` file. A mismatch stops the kernel. This is the same check the verified GitHub workflow does. No literal hash is pinned, because download.blender.org was unreachable from this development container.
- Downloads CHE's scripts at a pinned commit (`POOL_COMMIT`, or `CHE_POOL_COMMIT` on the Worker), the pinned `che-gpu-assets` commit and the pinned MPFB2 commit, all as codeload tarballs.
- Runs `scripts/che_gpu_worker.py --worker-class colab_t4`. It uses the GPU when Cycles sees one; with no GPU it is handed nothing. The receipt names the device.
- Authenticates with a **scoped pool token**. The token opens only the jobs it was started for, expires with the session, and is stored only as a SHA-256 hash. The owner's Kaggle key never goes into the kernel.

**When it is started:**
- a Kaggle token is already saved;
- internal-only mode and no-export rules are off;
- Kaggle pay-to-scale is off;
- the real quota is above a 2-hour margin;
- there is no cooldown and no live session.

The chosen jobs are reserved for 25 minutes. If the kernel never claims them, the attempt is recorded as `start_timeout`, Kaggle cools down, and the jobs are handed on.

**Status.** Kaggle stays `unverified` until a job completed by provider `kaggle` with a GLB sha256 is recorded. It then becomes `ready`, with that receipt (`verified.kaggle`).

## Benchmarks (measured)

Measured with `node server/cloudflare/compute_pool_bench.mjs` on the development container: Node 22.22.0, 4 vCPU Intel Xeon at 2.80 GHz. Each figure is the median of 11 runs after one warm-up run.

The container was shared with other running agents, so the medians varied between runs. The table gives the range of medians over the runs.

| Measurement | Result |
|---|---|
| Scheduling decision (`heldReason` + `selectProvider` + `poolAllows`) over 10,000 queued jobs | 24.6 to 38.0 ms median across 3 runs (about 2.5 to 3.8 µs per job) |
| The same over 1,000 queued jobs | 3.0 to 11.7 ms median (fastest single run 1.4 ms) |
| `applyPending` over 10,000 jobs with nothing pending (the per-request cost of the pool hook) | 4.0 to 16.9 ms |
| One `person_model` job record (3 views, queued), JSON | 714 bytes |
| The same after two pool attempts (handed off once, then completed) | 1,196 bytes (+482). At the cap of 6 attempts, about +1.4 KB. |
| `pool:state` with 50 handoffs and one cooldown | 11,269 bytes (one storage key) |

For scale, one queue shard holds at most 500 waiting jobs (`MAX_WAITING`) and 200 jobs in all (`MAX_JOBS`). 10,000 jobs is a stress figure, not a real load.

## What is verified and what is not

- **Verified offline** (`compute_pool.test.mjs`):
  - selection order;
  - cooldown on 429 and quota, including the GitHub dispatch;
  - bounded attempts, then waiting with a reason;
  - checkpoint resume after a handoff (a dead CPU worker, then a GPU worker completes with the same GLB);
  - a GPU-only job never runs on a CPU;
  - the Kaggle kernel and its scoped, expiring, hashed token;
  - `start_timeout` handoff;
  - no secret in any response.
- **Not verified live:**
  - a real handoff with real files on the deployed Worker (this needs the deployed acceptance run);
  - any Kaggle character build: no Kaggle token is known to be saved, and no kernel has ever run;
  - the live quota read against Kaggle.
