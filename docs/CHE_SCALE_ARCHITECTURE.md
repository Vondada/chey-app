# CHE at scale: 1 → 1,000 → 100,000 → 1,000,000 users

Owner brief (2026-10-24): CHE should run as a creative platform, not a single-device app. Every user has a private
Brain and asset library. 1-, 10- and 30-minute videos can be made at the same time. Jobs are durable and checkpointed,
and they run on distributed workers with verified receipts. Storage, uploads, isolation and deletion must hold up at a
million users. Every job is estimated before it runs, and nothing billable starts without the owner's yes.

This document records what exists, what this change added, the capacity numbers and their assumptions, and the order in
which to expand. The numbers come from `server/cloudflare/capacity_model.js`. Run `node tools/che_capacity_sim.mjs`
to reproduce them.

## 1. What CHE already had (reused, not rebuilt)

| Piece | Where | Role at scale |
|---|---|---|
| Durable Object `CheState` | `worker.js`, `env.CHE_STATE.getByName('owner')` | Today it holds everything in one object. At scale it becomes **one object per tenant** (`tenantObjectName`), so isolation and sharding are the same boundary. |
| Tenants, enrollment, notifications | `che_platform.js` (`createPersonalTenant`, `memory_scope: 'isolated'`, CORE-PRIVACY-1) | Identity and the tenant id that every key, job and quota uses |
| Creation Engine queue | `gpu_queue.js` (leases, heartbeats, pause/resume, checkpoints, retries ×3, receipts that must match a sha256) | The durable job queue; it is now fair across tenants and admits jobs per tenant |
| Orchestrator | `creation_orchestrator.js` (starts free GitHub CPU workers, $0 gate, no cron) | Autoscaling: it starts workers while jobs wait, up to a limit |
| Worker auth | `gpu_oidc.js` (GitHub OIDC; no stored secret) and the paired Colab token | Provider-neutral worker identity |
| Providers | `cloud_computer.js` (tiers, billing state, approval records) | The registry of authorized compute; paid tiers are refused |
| Media store | `che_media_store.js` (checksummed parts, 512 MB quota, optional R2 binding) | The fallback store until R2 is enabled |
| Film farm | `che-film-render.yml` (10-second segments, up to 20 runners in parallel) | The segment model the capacity math uses |
| Privacy audit | `privacy_policy.js` | Tenant rows carry no text (fixed in this change) |

## 2. What this change added

- **Per-tenant limits, fair scheduling and abuse protection** (`job_quota.js`).
  - Plans set queued jobs, job length, video minutes per day, storage, parallel segments and a rate limit (token bucket).
  - Duplicate requests are suppressed.
  - The **$0 spending gate**: a job that needs paid compute is refused with its estimate.
  - `gpu_queue.js` claims in fair order (priority, then the tenant with the least recent compute, weighted by plan) and admits every new job per tenant.
- **The queue never drops waiting work.** It used to keep only the newest 200 jobs, so a busy queue could silently lose waiting jobs. Now only finished jobs are trimmed. At 500 waiting jobs per shard, new jobs are refused with a reason.
- **Tenant object storage** (`object_storage.js`).
  - Key layout and prefix checks.
  - Per-class retention: temporary render files 7 days, Brain exports 30 days, finished work until the owner deletes it.
  - The account-deletion order.
  - Per-tenant AES-256-GCM data keys wrapped by a platform key, for crypto-shredding.
  - **Direct, resumable uploads**: R2 multipart with Signature V4 presigned part URLs (checked against AWS's published example). The bytes go from the phone or render worker straight to R2. The Worker only sends small start, list, complete and abort requests, so files never pass through it or any AI context.
- **Pre-job estimates and the scale scenarios** at `GET /api/creations/estimate?minutes=30&profile=hybrid&gpus=20` and `GET /api/creations/capacity`, both owner-only and read-only.
- **Tenant privacy fix.** Guest and tenant chat text used to reach the owner-readable AI audit (`GET /api/ai/audit`). Tenant rows now keep no text, and the owner views show owner rows only, with other tenants as counts.
- **Tests**:
  - `job_quota.test.mjs`, including a load test through the real `GpuQueue`: 300 tenants, 5 workers and a flooding tenant. Quotas hold, every light tenant runs, the heavy tenant gets under 10% of the runs, and the p95 claim is under 50 ms.
  - `object_storage.test.mjs`.
  - `capacity_model.test.mjs`.
  - The planning route test in `creation_studio.test.mjs`.
  - The guest-audit tests in `ai_layer.test.mjs`.

## 3. Data separation (what lives where)

| Data | Store | Isolation | Retention |
|---|---|---|---|
| Brain, memories, preferences, projects, conversations | The tenant's own Durable Object (`tenant:<id>`; the owner keeps `owner`), SQLite-backed | A separate object per tenant; no query crosses objects | Until deleted; Brain exports 30 days |
| Search index | Per-tenant namespace (`tenant:<id>`), in the tenant's object first and in a vector index once needed | Namespace per tenant | With the Brain |
| Creative assets: video, thumbnail, model, music, image | R2 (once enabled), `t/<tenant>/<class>/<yyyy-mm>/<asset>/<file>`; until then `che_media_store.js` | Key prefix checked on every read, write and signed URL (`assertTenantKey`) | Until deleted |
| Temporary render files: segments, frames, stems | R2 `t/<tenant>/tmp/...` | Same | 7 days, or sooner once the receipt verifies |
| Job queue and receipts | `gpu_queue.js` in the queue shard | `tenant_id` on every job; fair share per tenant | Finished jobs trimmed past 200 per shard |
| Compute memory | The worker's own disk and RAM (GitHub runner, Colab, GPU host) | One job per worker lease; discarded at exit | None |

Encryption: R2 encrypts objects at rest. Each tenant also has a data key, kept only wrapped by `CHE_TENANT_KEK`. Account
deletion destroys that key first, which makes any backup unreadable. It then cancels jobs, aborts uploads and deletes the
objects, the search index and the tenant's Durable Object, and writes a receipt without content (`deletionPlan`). The
owner never reads another tenant's Brain: the tenant object is not addressable from the owner's routes, and audit rows
carry no tenant text.

## 4. Jobs and GPUs at scale

- **Unit of work: a 10-second segment.** A 30-minute video is 180 segments. Segments are scheduled independently, checkpointed, retried up to 3 times and verified (a sha256 for each output). Then one worker stitches and verifies the whole film. A job is fair-capped at 20 segments in flight (owner plan; free plan 4), so one user never takes the whole pool.
- **Workers are provider-neutral.** Anything that authenticates (GitHub OIDC, the paired token, or a future provider identity), reports its class, device, cores and RAM, heartbeats and returns receipts can take jobs. The scheduler matches `requires.gpu` (`none` / `preferred` / `required`) to the worker class. Leases pause lost work, and any compatible worker resumes it from the last verified checkpoint.
- **Autoscaling.** The orchestrator starts workers while jobs wait, up to `max_cloud_workers`. On paid providers the same loop would size the pool from the queue's backlog in GPU-seconds, never above the owner's spending limit.
- **Render profiles.** How a video is made decides whether a million of them is possible:
  - `composited`: TTS, stills and ffmpeg, which CHE has today.
  - `blender_3d`
  - `gen_fast`: an LTX-class model.
  - `gen_quality`: a Wan-class model.
  - `hybrid`: 10% high-quality generative shots, 20% fast generative and 70% composited. This is the recommended production default.

## 5. Capacity simulations

Peak-hour load assumes:
- an active user sends a chat turn every 60 s;
- per active user per hour, 10% start a 1-minute video, 3% a 10-minute video and 1% a 30-minute video;
- the hybrid profile on H100-class GPUs;
- monthly figures use 4 peak-equivalent hours a day.

| Peak hour (hybrid profile, H100) | 1 user (today) | 1,000 simultaneous users | 100,000 simultaneous users | 1,000,000 simultaneous users |
|---|---:|---:|---:|---:|
| Worker requests/s | 0 | 67 | 6,667 | 66,667 |
| Durable Objects (one per tenant) | 1 | 1,000 | 100,000 | 1,000,000 |
| Video jobs started/hour | 0 | 140 | 14,000 | 140,000 |
| Finished video hours/hour | 0 | 12 | 1,167 | 11,667 |
| GPU-hours/hour (H100) | 0 | 71 | 7,093 | 70,933 |
| GPUs to keep up (70% busy) | 1 | 102 | 10,134 | 101,334 |
| CPU runners to keep up | 1 | 12 | 1,167 | 11,667 |
| 1-min video ready in (min) | 7.2 | 2 | 2 | 2 |
| 10-min video ready in (min) | 61.9 | 4 | 4 | 4 |
| 30-min video ready in (min) | 183.5 | 10.1 | 10.1 | 10.1 |
| New finished video/month (GB) | 5 | 4,922 | 492,188 | 4,921,875 |
| Temporary render files, steady (GB) | 3 | 3,445 | 344,531 | 3,445,313 |
| Brains (GB) | 0 | 20 | 1,953 | 19,531 |
| Download bandwidth/month (GB) | 15 | 14,766 | 1,476,563 | 14,765,625 |
| GPU $/month | $23 | $22,897 | $2,289,728 | $22,897,280 |
| LLM $/month | $6 | $5,760 | $576,000 | $5,760,000 |
| R2 + ops $/month (first month) | $0 | $128 | $12,897 | $128,968 |
| Workers + Durable Objects $/month | $5 | $18 | $1,687 | $16,867 |
| Total $/month (paid capacity) | $34 | $28,960 | $2,895,992 | $28,959,915 |

| 1,000,000 thirty-minute videos | hybrid | composited only | high-quality generative only |
|---|---:|---:|---:|
| Finished video (hours) | 500,000 | 500,000 | 500,000 |
| GPU-hours (H100) | 3,040,000 | 0 | 28,500,000 |
| CPU-runner hours | 350,000 | 500,000 | 0 |
| Days with 10,000 GPUs + 10,000 CPU runners | 18.1 | 3 | 169.6 |
| Storage (TB) | 1716.6 | 1716.6 | 1716.6 |
| Storage $/month (R2) | $26,367 | $26,367 | $26,367 |
| Compute $ (one time) | $8,233,600 | $80,000 | $76,665,000 |


How to read this:
- **Completion times** assume the pool is sized to keep up (70% busy). With the fair cap of 20 segments in flight, a
  30-minute hybrid video takes about 10 minutes. On today's free resources (one T4 or a CPU runner) the same video takes
  about 25 hours (`estimateVideo({minutes: 30, gpu: 't4'})`). CHE says so before it starts.
- **The platform layer is cheap; video is not.** At a million simultaneous users, Workers and Durable Objects come to
  about $17k a month, and each tenant object sees about 0.07 requests/s, far below its ~1,000/s. GPUs dominate
  (≈$23M/month at the assumed mix), then the LLM (≈$5.8M).
- **A million 30-minute videos is 500,000 hours of finished video.**
  - All high-quality generative: 28.5M H100-hours (≈$77M), about 170 days on 10,000 GPUs. That is not a responsible plan.
  - Hybrid: 3.04M H100-hours (≈$8.2M), about 18 days on 10,000 GPUs.
  - Composited: about $80k of CPU, about 3 days on 10,000 runners.
  - Storage for the finished files is about 1.7 PB, roughly $26k/month on R2. Egress is free.
  - Conclusion: long videos must be mostly composited or 3D, with generative shots where they matter.

### Assumptions (all in `ASSUMPTIONS`, with sources)

- **Prices:**
  - R2: $0.015/GB-month, Class A $4.50/M, Class B $0.36/M, no egress fee, 10 GB free.
  - Durable Objects: $0.15/M requests, $0.20/GB-month.
  - GPUs: H100 $2.69/h (RunPod Secure, Lambda $2.99-4.29); L4 $0.44-0.80/h. These are 2026 third-party summaries of public price lists; confirm on the provider's page before buying.
  - T4 $0.35/h, CPU runner and LLM token prices are CHE planning assumptions.
- **Render speeds:**
  - Wan 2.1 720p: 284 s per ~5 s clip on H100 (benchmark; another source says 2× slower).
  - LTX-2.3: 8 s of FHD in ~15 s on H100 (vendor claim).
  - Blender and composited speeds are CHE assumptions. Calibrate them from real receipts: the Creation Engine's per-stage timings, and `che-video-render.yml` run durations.
- **Behaviour:** turn rate, video mix, tokens per turn, Brain size and views per video are planning guesses. Change them in `ASSUMPTIONS` and the tables change.

Sources:
- [Cloudflare R2 pricing summary (Filebase, 2026)](https://filebase.com/blog/cloudflare-r2-pricing-costs-savings-and-alternatives-in-2026/)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing)
- [RunPod H100 pricing 2026](https://www.spheron.network/blog/runpod-h100-pricing-2026/)
- [Lambda H100 pricing 2026](https://www.spheron.network/blog/lambda-cloud-h100-pricing-2026/)
- [Cloud GPU pricing (CloudZero)](https://www.cloudzero.com/blog/cloud-gpu-pricing/)
- [Wan 2.1 across GPUs (InstaSD)](https://instasd.com/post/wan2-1-performance-testing-across-gpus)
- [LTX models (ltx.io)](https://ltx.io/model/alternatives)

## 6. Staged expansion (each stage starts only when its trigger is met, and anything billable waits for the owner's yes)

| Stage | Trigger | Change | Cost | Owner approval |
|---|---|---|---|---|
| 0, now | 1 user | Free GitHub CPU workers (automatic), Colab T4 (manual), `che_media_store.js` | $0 | none |
| 1 | A second real user, or files over 40 MB | Enable R2 (free tier 10 GB), create a bucket-scoped R2 API token, set `CHE_R2_*` and `CHE_TENANT_KEK`; route non-owner tenants to `tenant:<id>` objects | $0 within the free tier; R2 needs a billing profile | **Yes**: enabling R2, the token, the secrets |
| 2 | ~100 users, or queue waits over 15 minutes on free workers | Workers Paid ($5/mo); queue sharded per tenant group; Cloudflare Queues for segment fan-out; a vector index for search | ≈$5-50/mo | **Yes** |
| 3 | ~1,000 users with video demand | Paid GPU pool (one provider first, e.g. L4/H100 on demand) behind the same worker contract; autoscale from backlog GPU-seconds; per-plan quotas enforced; billing for paid plans | ≈$29k/mo at the modelled mix | **Yes**, with a spending cap |
| 4 | 100k+ | Several GPU providers and regions, reserved capacity, the hybrid profile by default, CDN delivery from R2, per-region queues | ≈$2.9M/mo at the modelled mix | **Yes** |

Not done, on purpose:
- No bucket, account, token, GPU or paid plan was created.
- Live tenant traffic still goes to the owner's object. Per-tenant routing (`tenantObjectName`) comes at stage 1, with its migration and tests.
- Cloudflare Queues, a vector index and paid GPU providers are designed for, not added.

## 7. Blockers that only the owner can clear

1. **R2 is not enabled on CHE's Cloudflare account.** The API answers "Please enable R2 through the Cloudflare Dashboard". Enabling it (free tier, billing profile required) and creating an R2 API token are the owner's decisions. Until then, `r2Status()` says so and uploads stay in CHE's own store, up to 40 MB each.
2. **`CHE_TENANT_KEK`** (a 32+ character platform key secret) must be set before tenant data keys are issued.
3. **Paid GPU capacity** at any stage needs the owner's approval and a spending limit above $0. Until then a job that needs it is refused with its estimate.
