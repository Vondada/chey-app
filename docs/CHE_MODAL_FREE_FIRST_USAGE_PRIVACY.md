# CHE: Modal GPU + Free-First Compute + Usage & Privacy Control — Owner Setup

Status: design and human activation checklist ONLY. No Modal account/token has been created, no services connected, no costs authorized, no GPU jobs dispatched.

## Existing source of truth
- Reuse `server/cloudflare/cloud_computer.js` PROVIDERS, `creation_orchestrator.js` CREATION_PROVIDERS, existing Durable Object cloud_task queue, `/api/cloud-computer` routes and `lib/rooms/che_cloud_computer_room.dart`.
- Continue PR #524 without overlapping files or discarding work. Read `AGENTS.md`, `mailbox/briefs/LIVE-HANDOFF.md`, all relevant existing usage/security implementations.
- No alternate provider scheduler, vault, or job database.

## Stage 1 — Modal human setup (owner-only)
1. Visit https://modal.com and create/sign into the owner's workspace; accept service terms and complete any required verification themselves.
2. In Workspace > Usage and Billing, inspect Starter allowance, turn on spending budget/alerts, and configure the lowest provider-supported spend restriction. **Do not assume a budget is a hard block until confirmed.**
3. Create a scoped Modal token via its official token management flow. Owner enters it **only** into a secure secret-management interface. Never paste tokens into chat, GitHub issues, commits, Cloudflare logs, analytics, memory, or the app's ordinary text input.
4. Owner explicitly approves this new external provider dependency. No charged deployment or GPU job without separately verified billing/approval controls.
5. Verify official pricing and terms again at implementation time. Starter currently advertises $30/month of compute; Modal Shared Endpoints token charges are excluded. These are not unlimited free GPUs.

## Stage 2 — Provider implementation
- Add `modal_gpu` to the existing registry with clear capabilities, external provider consent, default disabled state, cost tier, health probe, account/credit data **only if API supports it**, and per-job measured usage.
- Execution is allowlisted only: e.g. `modal_blender_preview` with JSON-schema-validated arguments; no arbitrary user text as code or shell commands.
- Authenticate Worker ↔ Modal through secrets; use short-lived/signature-protected requests, per-user isolation, idempotency keys and audit receipts.
- Use the existing job queue/checkpoints; allow cancel, timeout and retry with bounded attempts. Store result artifacts in CHE's existing media store and verify by fetching and checking SHA-256 before marking COMPLETE.
- Scale to zero when idle, configure appropriate container idle timeout. Confirm network/storage/CPU charges besides GPU metering.
- Never claim a connected provider without a successful authenticated probe; disconnected/unverified is displayed honestly.

## Stage 3 — Free-first, no surprise spending
- Default spend policy: automatic provider dispatch only when billing is VERIFIED FREE and within the provider's authorized program terms, quotas and rate limits. Otherwise queue for owner approval or explain blockers.
- Preferred order: existing included Cloudflare CPU → proven free GitHub CPU for eligible repositories → already-authorized available free GPU resources → Modal Starter included compute, **only after owner account setup, approval and remaining credit visibility verified** → paid compute only after explicit per-job approval.
- Free Colab is interactive and requires user action; do not automate around restrictions, hoard runtimes, rotate accounts, or evade service quotas.
- A provider with no authoritative remaining-credit API must not be assumed free based on estimates; display estimate and require approval.
- `$0 paid authorization` default. Protect with enforcement in dispatch code, not just prompt words.
- Provider failover must not cause duplicate billing; cancel/check original job status before dispatching a replacement.

## Stage 4 — Usage Center, one evidence-backed view
Build a voice-first accessible Usage Center via existing room/navigation framework with:
- Providers connected/not connected/needs owner sign-in; purpose and scopes.
- For each connected and permissioned service: subscriptions, billing cycle, renewal amount/date where officially available, quota reset, free credits, current balance, tokens in/out, GPU seconds, CPU hours, storage and egress, jobs, estimated cost, actual invoiced cost, API provenance and last sync time.
- Distinguish OBSERVED, ESTIMATED, USER-ENTERED and UNAVAILABLE data. Never fabricate subscription discovery or token counts; per-provider APIs and account authorization vary.
- Alerts for approaching quota or spending thresholds and unknown charges. Require owner confirmation before purchase/cancellation/account changes.
- Per-job budgets and user quotas, dedicated owner-only admin view, least-privilege connector access; do not expose secrets.

## Stage 5 — Privacy / identity / personal-data footprint
Separate privacy features from GPU functionality. Never store an SSN in CHE's memory, logs, prompts, analytics, or general indexing.
- Offer opt-in privacy inventory of services/accounts the owner has connected or explicitly submitted, searchable breach notifications from reputable permitted providers, credit monitoring via an authorized provider, public data-broker/people-search discovery and links to official opt-out processes.
- **Do not promise 'everywhere my SSN exists'**: no universal searchable inventory of private organizational records exists. Prefer last four digits only if needed and a dedicated compliant provider for full-SSN checks, with owner-entered data directly at that provider.
- Provide per-item actions: MONITOR, REQUEST REMOVAL, IGNORE, MARK RESOLVED. Deletion requests go through each service's authorized procedure, with owner confirmation, receipts and follow-ups. Do not claim data was erased without confirmation.
- Location history/tracking requires separate opt-in, explicit permissions, device-supported background capabilities, retention controls, pause/delete/export, and no covert tracking. This is not equivalent to identifying all businesses holding location data.
- Keep identity and location data separated from GPU workers and AI model prompts.

## Acceptance tests
1. Without credentials: provider shows NOT CONNECTED; never runs/costs money.
2. With scoped credentials: authenticated probe confirms provider and capabilities, no fake credits.
3. With exhausted/unknown free credit: new GPU job waits for approval; does not spend.
4. Submit simple cube render; job receipt, verified saved GLB/preview, Cloud Computer status, persistence through iPhone app closure.
5. Failover never bills twice for the same idempotency key; worker error is visible.
6. Usage Center shows actual vs estimated vs unavailable, including token charge distinction.
7. Privacy Center never collects a full SSN in chat/worker; opt-outs require explicit consent.
8. VoiceOver and voice navigation are functional, with owner-initiated Read Aloud only.
9. Test, review, merge and deploy only with green CI and verified live evidence; new IPA only if native code needs it.

## Human-only blocker status
Modal account and authorization are not available to ChatGPT's current connected tools. CHE cannot start Modal GPU jobs until owner signs in, configures spend limits, and provides credentials through an approved vault/secret-management path.

## Official references
- https://modal.com/pricing
- https://modal.com/docs/cli/latest
- https://modal.com/docs/cli/latest/secret
- https://www.consumerfinance.gov/ask-cfpb/what-is-a-credit-freeze-or-security-freeze-on-my-credit-report-en-1341/

## Status (Claude, 2026-10-25, branch `lane/modal-gpu`; not merged, not deployed)
The top-of-file status line above was ChatGPT's at design time. Stages 2 and 3 and acceptance tests 1-5 are now implemented in code and tested offline against a fake Modal app. **Nothing has run on Modal**: no account, token, deploy or GPU job exists, and no credential was used. Stages 4 and 5 (Usage Center, Privacy Center) belong to other lanes; this lane exposes the ledger they read.

### Researched facts this is built on
- Web functions created with `requires_proxy_auth=True` (on `fastapi_endpoint`, `asgi_app`, `wsgi_app` or `web_server`) accept only requests carrying a workspace Proxy Auth Token in the `Modal-Key` / `Modal-Secret` headers (`wk-…` / `ws-…`); others get HTTP 401 before a container starts. https://modal.com/docs/guide/webhook-proxy-auth
- Deploying needs the Modal CLI/SDK with `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET`, so it runs in GitHub Actions with repository secrets. https://modal.com/docs/cli/latest
- Programmatic billing reports (`modal billing`, `modal.billing.workspace_billing_report`) are Team/Enterprise only and show costs **before** credits. On Starter, CHE cannot observe the credit left. https://modal.com/docs/guide/billing
- Modal has a workspace budget and a spend limit: a monthly cap on net charges after credits, past which Modal stops workloads. https://modal.com/docs/guide/budgets
- "$30/month of compute on Starter" comes from third-party listings. It was not confirmed on modal.com, which this build container cannot reach. CHE never assumes it: the owner states his figure.
- T4 price used for estimates: $0.000164/s, about $0.59/h (`compute_budget.js` `PAID_GPU_PRICES.modal`, from a modal.com/pricing search snippet).

### How this reconciles with Stage 3's "no remaining-credit API → require approval"
Modal publishes no remaining-credit number on Starter, so CHE never treats Modal as verified free on its own. Automatic dispatch needs **all** of these, each recorded USER-ENTERED with its time and exact words:
1. the owner's opt-in ("use Modal's free credit");
2. his confirmation that Modal's spend limit is $0 ("I set Modal's spend limit to zero"). That limit is the provider-side hard stop that keeps the bill at $0;
3. his stated monthly credit ("my Modal credit is 30 dollars").

On top of that, CHE stops early at its own ESTIMATE: measured GPU seconds plus cold-start and idle time, times the published price, per calendar month. The stop line is 15% (at least $5) below the stated credit, so $25 of $30. Past it, or with the credit unknown, the job waits with "Waiting for approval: …". The owner can approve one job at a time ("approve the next Modal job"). Paid GPU authorization stays $0 (`compute_budget.js`), and Modal beyond the credit is not used.

### What was built
| Piece | File |
|---|---|
| Modal app: allowlisted `GET /health` (CPU) and `POST /blender_preview` (T4), plus `/status` and `/cancel`, on one proxy-auth endpoint (`label="che-gpu"`). Arguments are JSON-schema validated with no unknown fields, so no code or shell comes from text. `che_base` must be on a deploy-time allowlist. Image: Blender 5.0.1 (SHA-256 checked) plus CHE's scripts, project files and MPFB2 at the same pins as `compute_pool.js` / `che-creation-worker.yml`. Scale to zero (`scaledown_window=60`), 45-minute call timeout, `max_containers=1`, idempotency through a `modal.Dict` (`put(..., skip_if_exists=True)`) | `tools/modal/che_modal_app.py` |
| Deploy workflow: `workflow_dispatch` only. It skips with a notice when the secrets are empty, runs the arg tests, deploys, and prints the endpoint URL (no secrets) | `.github/workflows/che-modal-deploy.yml` |
| Credential `wk-ID:ws-SECRET@https://<workspace>--che-gpu.modal.run`, saved by the existing "CHE, connect Modal" secure field into the existing DO key store (`MODAL_TOKEN`, fingerprints only). Only che-gpu `*.modal.run` hosts are accepted. An `ak-…:as-…` API token is refused with the hint that it belongs in GitHub secrets | `server/cloudflare/modal_gpu.js`, `service_onboarding.js`, `resilience.js` |
| Verification: an authenticated `/health` that must return `che-gpu` / `che-modal-1`. Only then is Modal "Connected". 401 → "token rejected"; 404 → "run the CHE Modal deploy workflow first"; a wrong version → redeploy | `modal_gpu.modalHealth` |
| Free-first order, enforced in dispatch code: GitHub CPU (free) for CPU-capable work → owner's Colab with a fresh heartbeat → Kaggle free quota → Modal included credit → paid (RunPod/Vast within the GPU budget). Only GPU-only jobs reach Modal | `compute_pool.selectProvider`, `poolSchedule` |
| One job per call, one idempotency key per attempt (`job:<id>:modal:<n>`). An unanswered dispatch is settled by `/status` on that key before anything else; nothing is re-posted. An open call is cancelled by key, or confirmed ended, before its job goes to any other metered GPU. A call whose job finished or went elsewhere is cancelled at once (no idle billing) | `compute_pool.reconcileModal`, `releaseModalFor` |
| A Modal job's GLB is fetched back from CHE's media store and SHA-256 checked before COMPLETE. The receipt (`j.receipt.compute`, `j.compute[]`) records provider, idempotency key, GPU seconds (OBSERVED from the app, else ESTIMATED wall time), estimated cost (ESTIMATED) and billed cost (UNAVAILABLE) | `gpu_queue.js`, `modal_gpu.callReceipt` |
| `computeUsageLedger(storage, { month })` for the Usage Center: per-provider, per-job receipts with provenance | `modal_gpu.js` |
| Voice, no model call, through the existing `/cloud-gpu` path (no new Command Center entry): "use Modal's free credit", "I set Modal's spend limit to zero", "my Modal credit is 30 dollars", "approve the next Modal job", "stop using Modal's credit" (also cancels running calls), "how much Modal credit have I used?" | `cloud_computer.cloudIntent`, `compute_pool.modalCommand` |

### Acceptance tests (offline, fake Modal; `server/cloudflare/modal_gpu.test.mjs`)
1. No credentials: NOT CONNECTED, zero requests to `*.modal.run`, zero cost in the ledger.
2. A valid proxy token plus `/health` → Connected. 401 → rejected, nothing stored. 404 → deploy first. An old version → redeploy. A format-only key (`ak-…`, wrong host) is refused before any request.
3. Credit unknown, or CHE's estimate at $24.9 of a $30 credit → the job waits "Waiting for approval", with no `/blender_preview`. One "approve the next Modal job" → exactly one dispatch, then CHE asks again.
4. Simulated cube render: allowlisted dispatch with a scoped token (stored only as a hash); the worker claims, uploads the GLB and completes; the GLB is re-read and its SHA-256 verified; the receipt carries GPU seconds 95 (OBSERVED) and the cost (ESTIMATED); the state survives a Durable Object restart; the ledger entry is present. 4b: a GLB corrupted at rest is not accepted.
5. A lost dispatch reply is found by its key: one container, never re-posted. A worker error ("CUDA error: out of memory") shows in the job's history and cools Modal down. Failover cancels the Modal call before RunPod starts, and starts nothing while the cancel cannot be confirmed. The ledger shows one receipt per key.
Also: `tools/test_che_modal_app.py` (13 tests: argument validation, idempotency, argv, pins match `compute_pool.js`, version matches the Worker).

### Human-only steps (the owner)
1. Create or sign in to a Modal account at modal.com. Accept the terms and do any verification yourself.
2. On Usage and Billing, set the workspace **spend limit to $0**, and check what included credit your plan shows.
3. Settings → API Tokens: create a token. In GitHub (repo Settings → Secrets and variables → Actions), add `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`. Never paste them into chat.
4. Actions → "CHE Modal deploy" → Run workflow. Copy the endpoint it prints (`https://<workspace>--che-gpu.modal.run`).
5. Modal Settings → Proxy Auth Tokens: create one. Say "CHE, connect Modal" and paste `wk-ID:ws-SECRET@<endpoint>` into CHE's secure field. CHE says Connected only after its check.
6. Say "use Modal's free credit", "I set Modal's spend limit to zero" and "my Modal credit is N dollars" (your real figure).
7. Merging and deploying the Worker (`[worker-deploy]`) needs your separate go-ahead.

### Not done / open
- Not verified on real Modal: the image build (`run_function` install), `Dict.put(skip_if_exists=…)` and `FunctionCall.get(timeout=0)` behaviour, the endpoint URL shape, the T4 render time, and whether non-GPU charges (CPU for the endpoint, image storage) count toward the credit. CHE's estimate adds 120 s of start and idle time per call, and the `/health` check uses a little CPU time.
- Modal beyond the included credit (paid) is not dispatched. RunPod and Vast remain the paid tier.
- No Flutter change: the Cloud Computer and Creation screens show Modal through the existing pool list and job status lines ("Waiting for Resources" with the approval reason).
