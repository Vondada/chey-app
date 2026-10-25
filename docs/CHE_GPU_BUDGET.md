# CHE GPU budget (free GPUs first, then prepaid GPUs within a cap)

Owner request (2026-10-25, paraphrased): "I may put $20 toward GPUs. Split the money across different GPUs so it lasts almost forever, using the free ones first. Can't you just put the API key into CHE, and I tell her to connect and she's connected?"

What was built is an extension of the existing compute pool (`docs/CHE_COMPUTE_POOL.md`) and service onboarding (`docs/CHE_SERVICE_ONBOARDING.md`). It is not a second pool or a second onboarding system.

**Rules held in code:**
- CHE never pays, never adds a payment method and never buys credit. The owner creates the accounts and loads prepaid credit himself.
- A paid GPU is used only after the owner sets a GPU budget above $0. He does that with an explicit command ("allow up to 20 dollars for GPUs") or from the pool screen with `confirm: true`. CHE records the time and his words. The default is $0, which means paid GPUs are off.
- CHE never promises "forever". It states the real runway from recent use and the money left.

## What runs where

| Part | File |
|---|---|
| Budget ledger: caps, margin, approval, per-session cost, runway, budget words | `server/cloudflare/compute_budget.js` |
| RunPod and Vast.ai adapters: balance read, start one machine, billed cost, delete | `server/cloudflare/gpu_providers.js` |
| Registry entries, free-first selection, starting and deleting paid sessions (`startPaidSession`, `reapPaid`), `budgetCommand`, `poolSay`, `paidWakes` | `server/cloudflare/compute_pool.js` |
| Guided connect for Kaggle, RunPod, Vast.ai and Modal (free verification read) | `server/cloudflare/service_onboarding.js` (`gpuGuided`), with `resilience.js` `KEY_PROVIDERS` entries |
| Voice and typing | `cloud_computer.js` `cloudIntent` → `/cloud-gpu budget …` (the existing `cloud-gpu` command; no new catalog entry) |
| Paid machine deleted on worker calls and on the Durable Object alarm | `gpu_queue.js` `gpuWorkerRoute` (complete and heartbeat); `worker.js` `wakeTimes` and `alarm` |
| Onboarding screen: provider names, numbered steps, **Paste copied key**, **Read aloud** | `lib/connect/che_service_onboarding.dart` |
| Tests | `server/cloudflare/compute_budget.test.mjs` (14), `test/che_service_onboarding_test.dart` (+2) |

## Research (primary sources, read 2026-10-25)

What this container could reach:
- The egress proxy refuses runpod.io, modal.com, vast.ai, kaggle.com, lightning.ai, paperspace.com and saturncloud.io. Every request returned connection status `000`.
- Reachable: GitHub (raw files from providers' own repositories), PyPI and npm.
- Web search worked, but page fetches failed DNS.

So API facts come from the providers' own repositories. Prices come from web search results of the providers' pages, marked where only third-party sources were found.

### RunPod

**API.** The REST API v1 is defined by the OpenAPI file in [runpod/docs `api-reference/openapi.json`](https://github.com/runpod/docs/blob/main/api-reference/openapi.json). Server `https://rest.runpod.io/v1`, Bearer key.
- `POST /pods` (`PodCreateInput`) takes `imageName`, `gpuTypeIds`, `gpuTypePriority`, `cloudType` `COMMUNITY|SECURE`, `computeType`, `containerDiskInGb`, `volumeInGb`, `env`, `dockerStartCmd` and `interruptible`.
- `POST /pods/{id}/stop` and `DELETE /pods/{id}`.
- `GET /billing/pods` with `grouping=podId`. `BillingRecord.amount` is in USD.
- `Pod.costPerHr` is the real hourly price.

**Balance.** The [runpodctl `user` reference](https://github.com/runpod/docs/blob/main/runpodctl/reference/runpodctl-user.mdx) shows `clientBalance`, `currentSpendPerHr` and `spendLimit`. CHE reads `clientBalance` through GraphQL `myself { clientBalance }` at `https://api.runpod.io/graphql`. The field name comes from that CLI output, not from a published GraphQL schema, so it is unverified until the first real read.

**Billing** ([runpod/docs `accounts-billing/billing.mdx`](https://github.com/runpod/docs/blob/main/accounts-billing/billing.mdx)):
- prepaid credits, billed per second;
- "When your balance reaches $0, Runpod automatically stops all of your running Pods";
- "To deploy a new Pod, your account must have at least one hour's worth of credits";
- default spend limit $80 per hour;
- credits are non-refundable;
- "Prepaid cards should deposit at least $100 per transaction".

Auto-pay exists, but it needs a saved card. **The owner should leave auto-pay off.**

**Pod variables.** `RUNPOD_POD_ID` and a Pod-scoped `RUNPOD_API_KEY` ([pod environment variables](https://docs.runpod.io/pods/references/environment-variables), via search).

**Prices**, Community Cloud, from runpod.io/gpu-instance/pricing via search:

| GPU | Community Cloud | Secure Cloud |
|---|---|---|
| RTX A4000 16 GB | $0.17/h | $0.32/h |
| RTX 3090 24 GB | $0.22/h | $0.43/h |
| RTX 4090 24 GB | $0.34/h | $0.69/h |

Prices change. CHE uses the price RunPod returns when the Pod starts.

**Blender/ComfyUI suitability.** Any CUDA container works, and Blender Cycles runs on NVIDIA GPUs with CUDA or OptiX. This is not verified on RunPod yet.

### Vast.ai

**API**, from the official CLI ([vast-ai/vast-cli `vast.py`](https://github.com/vast-ai/vast-cli/blob/master/vast.py)). Base `https://console.vast.ai/api/v0`, Bearer key.
- `GET /users/current` (has `credit`)
- `POST /bundles/` (offer search: rows in `offers`, price `dph_total`)
- `PUT /asks/{offer}/` (rent, with `image`, `disk`, `onstart`, `runtype`; returns `new_contract`)
- `DELETE /instances/{id}/`

**Billing.** Marketplace prices vary per offer. Bandwidth is billed on top of the $/hr figure ([docs.vast.ai/billing](https://docs.vast.ai/billing), via search). An RTX 3090 costs about $0.22/h on demand, but that figure is third-party ([getdeploying.com](https://getdeploying.com/gpus/nvidia-rtx-3090), March 2026). CHE refuses offers above its cap and reads the live `dph_total`.

**Unverified:** the exact rent body beyond what the CLI sends, and the per-instance billing read. For Vast, the ledger uses wall time × the live offer price.

### Modal

**Free credit.** The Starter plan is reported to include **$30 of compute a month**, with T4 at $0.000164/s (about $0.59/h) and L4 at $0.000222/s (about $0.80/h). This comes from modal.com/pricing search snippets and third-party pages. It was **not confirmed on the page itself.**

**Budget controls.** Modal has workspace budgets and a separate spend limit ([modal.com/docs/guide/budgets](https://modal.com/docs/guide/budgets), via search).

**API.** Deploying needs the Modal SDK/CLI (`ak-…`/`as-…` API token), so it runs from `.github/workflows/che-modal-deploy.yml` with repository secrets. Once deployed, CHE's app is a web endpoint protected by Modal proxy auth (`Modal-Key`/`Modal-Secret` headers of a `wk-…`/`ws-…` Proxy Auth Token; 401 without them, no container started), which the Worker calls over HTTPS.

**Status (2026-10-25, branch `lane/modal-gpu`):** wired as an included-credit provider, not a paid one. Connected only after an authenticated `/health`; used only for GPU-only jobs after Colab and Kaggle, only after the owner opts in, confirms a $0 Modal spend limit and states his credit; CHE stops at its own estimate (e.g. $25 of $30). Details and acceptance tests: `docs/CHE_MODAL_FREE_FIRST_USAGE_PRIVACY.md`. Modal beyond the credit (paid) is not used.

### Kaggle

**Free quota.** Commonly reported as about **30 GPU hours a week** (T4 or P100). Kaggle does not publish a fixed number, and the real quota is read from `GetAcceleratorQuotaStatistics`. GPU use needs a **phone-verified** account. Sessions run at most 12 h.

**Status:** the adapter already existed in the pool (unverified). It is now wired to onboarding: "CHE, connect Kaggle" verifies the key by reading the weekly quota and reports the hours left.

### Lightning AI, Paperspace, Saturn Cloud

Their pages were unreachable from here. Nothing was found that confirms both an API to start and stop GPUs from a server and a free tier without a card. **They are not added.**

## How "connect" works now

| Say or type | What happens |
|---|---|
| "CHE, connect Kaggle", "CHE, connect RunPod", "CHE, connect Vast", "CHE, connect Modal" (or `/connect-service runpod`) | The existing `connect-service` route (`che_onboarding`), with no model call. CHE says what you do once, as a numbered list, and opens the onboarding screen with the provider's key page and the **secure field**. CHE says: "Never paste a key into chat." |
| On the screen: **Paste copied key** (a single control a blind owner can use after copying) or type it into the secure field | The key goes from the clipboard or field straight to `POST /api/onboarding/<id>/secret`. It is never shown or spoken, and the clipboard is cleared afterwards. |
| The Worker | It tests the key with a free read: the RunPod or Vast balance, or the Kaggle weekly quota. Only then does it store the key in the runtime key store. It reports three separate lines: `Token saved: … fingerprint sha256:…`, `Secret configured: …` and `Connection verified: … prepaid balance $12.50 (a read-only balance check; nothing was started or spent)`. Modal stays at "saved, not verified". |
| "allow up to 20 dollars for GPUs" (optionally "…, 5 dollars a month") | Records the approval (time and words), keeps a 5% margin (at least $0.25) and confirms aloud. |
| "limit GPUs to 5 dollars a month" | Sets the monthly cap; it never exceeds the total. |
| "how long will my GPU money last?" | Runway: the money left, the recent paid GPU hours a week and the weeks left (or the hours left on the cheapest GPU), plus Kaggle hours left. |
| "what GPUs can CHE use" | A numbered list of every computer that can build characters, free or paid, with its status and reason. |
| "use paid GPUs for speed" / "only use free GPUs" | Allows or forbids paid GPUs for GPU-preferred jobs. CPU-only work never goes to a paid GPU. |
| "stop paid GPUs" | The cap goes to $0. Every running paid machine is deleted at once, and a failed delete is said aloud. |

## Scheduling order (free first)

Implemented in `selectProvider`, `poolSchedule` and `startPaidSession`:
1. **CPU-only work:** the free GitHub CPU worker. Never a paid GPU.
2. **GPU work:** your Colab while it is open, then Kaggle's free weekly quota. Kaggle is used even unverified for GPU-only jobs, as before.
3. **Paid prepaid GPUs come last**, and only when all of these hold:
   - the job needs a GPU (or you asked for speed);
   - a key is saved;
   - the budget allows at least 20 minutes on that machine;
   - the prepaid balance covers RunPod's one-hour minimum.

   CHE picks the cheapest provider first. Within RunPod, it asks for RTX A4000, then 3090, then 4090 (`gpuTypePriority: custom`). Only one paid machine runs at a time.

## Never past the cap; no machine left running

**Before a start:**
- `money left = min(total cap − all spend, monthly cap − this month's spend, prepaid balance) − margin`.
- A session may start only if that buys at least 20 minutes.
- It gets a hard deadline when the money left would reach the margin, and never more than 2 hours.
- A machine whose live price is above CHE's accepted maximum is deleted at once.

**Deleting the machine:**
- `reapPaid` deletes the machine (RunPod `DELETE /pods/{id}`, Vast `DELETE /instances/{id}/`) when any of these holds:
  - its jobs are finished;
  - it never picked up a job within 20 minutes;
  - its deadline or the budget is reached;
  - you said "stop paid GPUs".
- `reapPaid` runs:
  - on every worker heartbeat and completion;
  - on every app poll (`ensureCapacity`, pool view);
  - on the Durable Object alarm, which `paidWakes` arms at the deadline and at the end of the start window. That is a timer, but it makes no AI call; it exists only to stop spending.
- The RunPod machine also deletes itself when its worker exits, using its Pod-scoped key, as a second guard.

**Recording the cost:**
- The ledger closes the session with RunPod's billed amount when `/billing/pods` lists it, otherwise with wall time × the hourly price.
- `reconcilePaid` replaces estimates with the bill later.

**When a delete fails:**
- The session stays open and keeps counting against the budget.
- CHE retries.
- CHE says: "I could not delete … It may still be charging … delete it in that provider's console."

Secrets: the owner's provider keys never go into the machine. The machine gets a **scoped pool token** that opens only its jobs, expires at the session deadline and is stored only as a SHA-256 hash. Responses carry booleans, balances and fingerprints only (tested).

## Worked example: $20

Recommendation: put the $20 in **one** provider, RunPod. It is where CHE can read the real bill and balance. Splitting $20 across several paid accounts fragments it:
- each account needs its own minimum (RunPod needs one hour of credit to start);
- RunPod credit is non-refundable.

CHE already splits the work across different GPUs: the free ones first, then the cheapest RunPod GPU type that is available. Vast.ai stays optional.

| Step | Amount |
|---|---|
| Owner loads on RunPod | $20 prepaid (card; prepaid cards must deposit at least $100 per RunPod's billing page, so a $20 load needs a regular card) |
| Says "allow up to 20 dollars for GPUs, 5 dollars a month" | Cap $20, at most $5 a month |
| Safety margin CHE never spends | $1.00 |
| Usable | $19.00 |
| On RTX A4000 at $0.17/h | about 111 GPU hours |
| On RTX 3090 at $0.22/h | about 86 GPU hours |

**Realistic runway.**
- Free GPUs take most GPU work: about 30 Kaggle hours a week once Kaggle is connected and verified, and Colab when you open it.
- Paid time is used only when those are busy or out of quota.
- If paid use is 2 GPU hours a week (about $0.34 a week on an A4000), $19 lasts about **56 weeks**.
- The $5-a-month cap also limits it to at most $5 a month: about 29 A4000 hours a month, so even at full use the $19 lasts about **3.8 months**.
- Each paid session also pays for machine start, image pull and the Blender download. That has not been measured on RunPod; it is probably several minutes per session.
- "Forever" is not true: the money runs out at the pace you use it. CHE says the real number when asked.

## What the owner must do once, per provider

| Provider | Free or paid | Do once | Then say |
|---|---|---|---|
| Kaggle | Free (about 30 GPU hours a week, reported) | Create the account, **verify your phone** in settings, then Settings → API → create a token (`username:token`) | "CHE, connect Kaggle" |
| RunPod | Paid, prepaid | Create the account, add prepaid credit on Billing (leave auto-pay off), then Settings → API Keys → create a key | "CHE, connect RunPod", then "allow up to 20 dollars for GPUs" |
| Vast.ai | Paid, prepaid | Create the account, add prepaid credit, then create an API key on the Keys page | "CHE, connect Vast", plus a budget |
| Modal | Monthly credit reported ($30, unconfirmed) | Create the account, set the spend limit to $0, add `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET` GitHub secrets, run "CHE Modal deploy", create a Proxy Auth Token | "CHE, connect Modal" (`wk-ID:ws-SECRET@endpoint`), then "use Modal's free credit" |
| Colab | Free | Open the CHE GPU notebook when you want it (unchanged) | "Connect GPU" |

## Verified and unverified

**Verified offline** (`compute_budget.test.mjs`, 14 tests):
- ledger maths, including the month boundary and the billed amount replacing the estimate;
- cap enforcement, including a property test that sessions run to their deadlines never pass cap − margin;
- approval required, and a misheard amount refused;
- free-first selection, and CPU-only work never sent to a paid GPU;
- a full RunPod lifecycle against a fake API: Community Cloud, cheapest first, no volume, a scoped hashed token in the boot script, the owner's key absent, claim, build, complete, Pod deleted, billed cost recorded, token revoked, provider verified;
- deletion after a missed start window and at the budget deadline;
- "stop paid GPUs", including a failed delete that is reported and retried;
- free Kaggle chosen before RunPod;
- runway wording, with no "forever";
- adapter behaviour against fake RunPod and Vast APIs;
- no secrets in any response;
- "CHE, connect RunPod", Modal and Kaggle through the real `/api/chat` and `/api/onboarding`;
- budget voice commands through `/api/chat` with no model call.

**Not verified live:**
- no real RunPod, Vast.ai, Modal or Kaggle account was used;
- no machine was ever started;
- the GraphQL `clientBalance` field, the RunPod billing row shape, the Vast rent body and self-delete from inside a Pod are taken from the providers' repositories and CLI, not observed;
- whether Blender 5.0.1 runs in `nvidia/cuda:12.4.1-runtime-ubuntu22.04` on those GPUs is expected but unproven.

Each paid provider stays `unverified` until a real character GLB is built there.

**Owner pages:** the key-page URLs (`runpod.io/console/user/settings`, `cloud.vast.ai/manage-keys/`, `modal.com/settings/tokens`) could not be opened from here. If one has moved, the owner can open the provider's console from its home page.
