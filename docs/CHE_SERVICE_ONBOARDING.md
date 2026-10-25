# CHE service onboarding

Owner request (2026-10-25): "CHE, connect Hugging Face." CHE checks for a working connection, uses the owner's own signed-in account, creates a token with the fewest permissions the capability needs, stores it where CHE's code reads it, tests it, and says "Connected" only after real checks pass. Hugging Face works end to end. The other providers use the same state machine in guided mode.

## What runs where

| Part | File |
|---|---|
| State machine, provider registry, HF adapter, routes, chat replies | `server/cloudflare/service_onboarding.js` |
| GitHub Actions repository secrets (libsodium sealed box) | `server/cloudflare/github_secrets.js` + `vendor_tweetnacl.js` (tweetnacl-js 1.0.3, public domain) |
| Stored key beats a dead Worker secret (only after onboarding verified it) | `server/cloudflare/resilience.js` (`CHE_STORED_KEY_WINS`) |
| Routes and chat wiring | `server/cloudflare/worker.js` (`/api/onboarding/*`, `onboardingChat`, the `connect_service` local command) |
| Command Center | one entry, `connect-service` (route `che_onboarding`), in `command_catalog.js` |
| iPhone driver and screen | `lib/connect/che_service_onboarding.dart`, opened from `lib/home_state/streaming.dart` |
| Page driver injected into CHE's WebView | `assets/browser/che_hf_token_page.js` |
| Fake huggingface.co, page reconstruction, Playwright test, demo | `tools/fake_huggingface.mjs`, `tools/fixtures/hf_token_page.html`, `tools/che_hf_token_page_test.mjs`, `tools/che_onboarding_demo.mjs` |

## The state machine

Each record is keyed by `provider:capability`, which is also the idempotency key. Records are stored in the Durable Object as `onboarding:<provider>:<capability>`.

```
check_existing → account (owner) → token_requested → token_created → secret_configured → verified
any step → paused (owner_auth | captcha | missing_info | spending) → resumes at pause.resume_state
any step → failed (reason)
```

- **Preserve working connections.** `start` first verifies the token CHE already uses: the merged env the consumers read, Worker secret or stored key. If it passes, the state becomes `verified` with `preserved: true`, and CHE creates nothing.
- **No duplicate tokens.**
  - The device announces a new token before it sends it, with `event {kind: token_created, fingerprint, last4, name}`.
  - From then on, a retry gets `action: post_held_token`, and the device posts that same token, which it holds in memory only (`CheHeldTokens`).
  - A different token, sent either as an event or as a secret, is refused with 409.
  - A new token is requested only after `start {lost_fingerprint, revoked}`. That records the lost token and whether it was revoked, and the next token's name gets a suffix (`#2`).
  - If the device cannot deliver the token, it revokes it first with Hugging Face's documented `POST /api/credentials/revoke`.
- **Replace only if valid.** `/secret` runs every check on the new token before it touches the store. If the new token fails, nothing is stored and the old token keeps working.
- **Fingerprints only.**
  - The token appears once, in the body of `/secret`, which travels over TLS. It is tested, written to the runtime key store and dropped.
  - Records, status replies, letters, history and speech hold `sha256:<12 hex>` and the last 4 characters. Every outward reply also passes through `redactSecrets`.
  - Events that contain anything secret-shaped are refused with 400.
- **Owner only, frozen by lockdown.** Every route needs the owner's paired device (other callers get 403). Lockdown returns 423 for every write.
- **Three separate outcomes.** Every reply carries `outcomes {token_created, secret_configured: [destinations], connection_verified}` and `lines`:
  - `Token created: …`
  - `Secret configured: … Not configured: … (why)`
  - `Connection verified: …`

  `speech` starts with "Connected:" only when the state is `verified` and every check passed. The device replaces "Connected" with "Not verified yet" if the Worker ever sent it without verifying.

Routes (all owner-only):

| Route | Purpose |
|---|---|
| `POST /api/onboarding/<provider>/start {capability, account?, lost_fingerprint?, revoked?}` | Starts or resumes |
| `POST /api/onboarding/<provider>/event {capability, kind: paused\|account_seen\|token_created, …}` | Device reports; never a secret |
| `POST /api/onboarding/<provider>/secret {capability, token}` | The token, once |
| `POST /api/onboarding/<provider>/verify {capability}` | Re-runs the checks |
| `GET /api/onboarding/<provider>?capability=` | Status |

Voice and typing, with no model call:

- "CHE, connect Hugging Face"
- "connect Hugging Face for film studio" or "… for GitHub Actions"
- "is Hugging Face connected?"
- "check my Hugging Face connection"
- "yes, use `<username>` on Hugging Face" (approves the signed-in account)
- `/connect-service <name>`

Gmail, Drive, Calendar, YouTube and NinjaTrader keep their own sign-in routes; onboarding never matches them.

## Where the token must go (research on this repo)

| Consumer | Reads | Effect of a token stored through CHE |
|---|---|---|
| Chat engine (`ai_router.js`, router.huggingface.co) | `keyEnv.HF_TOKEN` (`withStoredKeys`: the Worker secret wins over the stored key) | Used only when no Worker secret exists, until `CHE_STORED_KEY_WINS` is set |
| Kokoro voice fallback (`worker.js` voice) | `voiceEnv()`, which is built on `keyEnv` | Same as above |
| Film Studio ZeroGPU (`film_pipeline.js`, `film_studio.js`) | `keys.HF_TOKEN \|\| env.HF_TOKEN` | The stored key wins |
| `compute_pool.js`, `cloud_computer.js`, `fine_tuning.js` | Raw `env` | Report only. HF ZeroGPU cannot run Blender (`docs/CHE_COMPUTE_POOL.md`). Training uses `CHE_HF_TRAINING_URL`/`TOKEN`, outside this flow |
| GitHub Actions: deploy key sync (`che-worker-deploy.yml`) and OpenCode runtime (`K_HF`) | Repository secret `HF_TOKEN` | A deploy copies it into the Worker secret `HF_TOKEN` |

Findings and decisions:

1. **A GitHub secret alone does not connect the Worker,** and neither does a stored key while a Worker secret of the same name exists, because the Worker secret wins. Onboarding therefore writes to the Durable Object key store that `refreshKeyEnv` merges. When a Worker secret `HF_TOKEN` exists and failed verification, onboarding also adds `HF_TOKEN` to `CHE_STORED_KEY_WINS`, so the verified token takes effect at once and stays in effect after a deploy re-syncs an old GitHub secret.
   - Destination verification compares the fingerprint of `keyEnv.HF_TOKEN` after the store with the new token's fingerprint. The connection counts as verified only when they match.
   - Removing the key in Keys clears the flag.
2. **Setting the Cloudflare Worker secret itself** needs `PUT /accounts/{account_id}/workers/scripts/{script_name}/secrets` with a Cloudflare API token that has "Workers Scripts Write" ([Cloudflare API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/update)). That token exists only as the GitHub secret `CLOUDFLARE_API_TOKEN`, used by the deploy workflow. The Worker has no Cloudflare credential, and triggering a deploy is a release action that needs the owner's go. CHE therefore does not write the Worker secret. The runtime store above is what connects the Worker.
3. **GitHub repository secret** (only for capability `actions`). The flow is documented by GitHub ([REST: Actions secrets](https://docs.github.com/en/rest/actions/secrets)):
   1. `GET /repos/{o}/{r}/actions/secrets/public-key`
   2. A libsodium sealed box made on the Worker
   3. `PUT /repos/{o}/{r}/actions/secrets/HF_TOKEN`

   This needs a token with the repository permission "Secrets: Read and write". The repo cannot see what permissions `CHE_GITHUB_TOKEN` has. The existing code uses it for contents, pull requests and workflow dispatch, and the deploy check already logs `x-accepted-github-permissions`. If GitHub refuses, the line reads `Not configured: GitHub Actions secret HF_TOKEN (GitHub refused (HTTP 403). CHE_GITHUB_TOKEN needs the repository permission "Secrets: Read and write" … only you can grant that)`, and the Worker connection still verifies on its own.
   - The sealed box was checked against real libsodium 1.0.20 (libsodium-wrappers 0.7.15), with 84 checks in total:
     - BLAKE2b at 11 message lengths × 4 digest sizes against `crypto_generichash`.
     - 20 sealed boxes made by CHE and opened by libsodium, and 20 made by libsodium and opened by CHE.
   - The repository test keeps the RFC 7693 `blake2b("abc")` vector and a libsodium-made sealed box.
   - Hugging Face also offers [Trusted Publishers](https://huggingface.co/docs/hub/security-tokens#for-cicd-pipelines), which exchanges a GitHub OIDC identity for a short-lived Hub token, so Actions would need no stored token at all. This is the better long-term route for the OpenCode runtime; it is not built yet.

## Hugging Face: research (primary sources)

These docs were read from their source repositories, because huggingface.co itself is blocked from this build container (see "Real endpoint check" below):

- [User access tokens](https://github.com/huggingface/hub-docs/blob/main/docs/hub/security-tokens.md), the source of huggingface.co/docs/hub/security-tokens
- [OAuth](https://github.com/huggingface/hub-docs/blob/main/docs/hub/oauth.md)
- `huggingface_hub` (`hf_api.py` whoami, `_login.py`)
- `huggingface.js` (`api-who-am-i.ts`)

What they establish:

- **Token types.** The roles are `fine-grained`, `read` and `write`. HF recommends "using only fine-grained tokens for production usage" and "one access token per app or usage". Tokens are created at Settings → Access Tokens → **New token** (`/settings/tokens`). CHE opens `/settings/tokens/new?tokenType=fineGrained`.
- **Minimum permissions per capability.** The labels are the fine-grained form's. The ids are what whoami-v2 reports.

  | Capability | What CHE uses it for | Permission |
  |---|---|---|
  | `inference` (the default) | Chat engine via router.huggingface.co, Kokoro voice fallback | "Make calls to Inference Providers" (`inference.serverless.write`) |
  | `download` | Gated model and dataset downloads | "Read access to contents of all public gated repos you can access" (public, non-gated models need no permission) |
  | `film_space` | Film Studio creates and calls its ZeroGPU Space | "Write access to contents/settings of all repos under your personal namespace" plus Inference Providers |
  | `actions` | The Worker plus the GitHub secret `HF_TOKEN` | Inference Providers |

- **Shown once.** HF's form shows the value in a "save your token" dialog, and CHE reads it once from the page. The "not visible again" wording in the fixture is reconstructed, not copied: verify it on the device. HF lets the owner refresh or delete tokens with **Manage**.
- **Revocation by value.** `POST https://huggingface.co/api/credentials/revoke {"credentials":[token]}` invalidates a token immediately. It "always responds with 202" and needs no rights over the account. The device uses it for a token it cannot deliver.
- **whoami-v2.** `GET https://huggingface.co/api/whoami-v2` with `Authorization: Bearer`:
  - 200 returns `{type, name, auth: {type: 'access_token', accessToken: {displayName, role, fineGrained?}}}`.
  - 401 is "Invalid user token".
  - 429 is a rate limit that is "intentionally strict for security reasons". CHE calls it once per verification and never treats 429 as verified.
- **Free capability checks** (no inference is run, nothing is spent):
  - whoami-v2 for identity, role and scopes, plus an account match.
  - `GET /api/models/hexgrad/Kokoro-82M` with the token: the Hub accepts it on a content route.
  - `GET https://router.huggingface.co/v1/models` with the token: the router accepts it.
  - `GET /api/spaces?author=<user>` for `film_space`.
  - CHE does **not** make an inference call, because that uses the account's monthly credits and may bill a postpaid account. The spoken result says "no inference was run". Inference itself is proven the first time the chat engine or the voice uses it.
- **API token creation.** HF documents no user-token creation API, so CHE drives the owner's own settings page in its WebView. HF OAuth exists, including a device-code flow, scopes such as `inference-api` and `read-repos`, and automated app registration via CIMD. The docs, however, describe exchanged tokens as short-lived (8 hours by default) with "no refresh tokens", which is unsuitable for a background Worker. OAuth stays an option for a future interactive flow.
- **Account creation is owner-only.** HF's terms define an account holder as a natural person or a legal entity, and sign-up includes human checks. CHE never automates sign-up or CAPTCHA. With no account, it pauses with `owner_auth/sign_up` and gives the owner huggingface.co/join.

### Real endpoint check

`curl -i https://huggingface.co/api/whoami-v2` from this container returned `CONNECT tunnel failed, response 403`: the build container's egress proxy refuses huggingface.co (and api.cloudflare.com). The real 401 shape could therefore **not** be observed here. The fake returns `401 {"error":"Invalid credentials in Authorization header"}`, and CHE treats any 401 as invalid without depending on the body. The first real call happens on the owner's iPhone.

## Other providers (`KEY_PROVIDERS`)

All of these use the same records, `/secret`, replace-only-if-valid and verification, in **guided** mode. CHE opens the provider's page in its onboarding screen, the owner signs in and creates the key, and he pastes it into the secure field. The field posts straight to `/api/onboarding/<id>/secret`; the key never goes into chat. Verification is the existing `testKey` call (an authenticated model list), so nothing is spent.

| Provider | Setup method (source) | Minimum scope | Destination | Free verification | Automatable |
|---|---|---|---|---|---|
| Hugging Face | Settings token form (fine-grained); revoke by value via API | Per capability (see above) | DO key store (+ `CHE_STORED_KEY_WINS`); GitHub secret for `actions` | whoami-v2, model metadata, router model list | **Yes (device)**, except sign-in, 2FA, CAPTCHA and sign-up, which are the owner's |
| Groq | Console only (console.groq.com/keys) | Keys are not scoped | DO key store | `GET /openai/v1/models` | Partial (guided) |
| Gemini (AI Studio) | AI Studio, or the Cloud API Keys API (`apikeys.keys.create`) with OAuth on a Cloud project. Since 2026-05-28 AI Studio makes "auth keys", and unrestricted standard keys are rejected ([Gemini API keys](https://ai.google.dev/gemini-api/docs/api-key)) | Key limited to the Generative Language API | DO key store | `GET /v1beta/openai/models` | Partial: an API exists, but it needs Google Cloud OAuth and IAM that CHE does not hold |
| Cerebras | Console only (cloud.cerebras.ai) | Not scoped | DO key store | `GET /v1/models` | Partial (guided) |
| Mistral | Console only (console.mistral.ai/api-keys) | Workspace key | DO key store | `GET /v1/models` | Partial (guided) |
| OpenRouter | Console, or the Management API `/api/v1/keys` with a management key ([OpenRouter](https://openrouter.ai/docs/features/provisioning-api-keys)) | Per-key credit limit; set 0 or free-only | DO key store | `GET /api/v1/key` | Partial: automatic once the owner creates a management key (not stored today) |
| GitHub Models | Fine-grained PAT in settings; GitHub documents no PAT-creation API | `models:read` ([changelog](https://github.blog/changelog/2025-05-15-modelsread-now-required-for-github-models-access/)) | DO key store | `GET models.github.ai/catalog/models` | Partial (guided) |
| SambaNova | Console only (cloud.sambanova.ai/apis) | Not scoped | DO key store | `GET /v1/models` | Partial (guided) |
| Kaggle | Settings → API → create token (`username:token`) | Account-wide | DO key store | `GetAcceleratorQuotaStatistics` (read only; reports GPU hours left; a token without a username fails, because the pool needs it) | Partial (guided); GPU-with-internet needs a phone-verified account (owner) |
| RunPod (prepaid GPU) | Console → Settings → API Keys | Account key | DO key store (`RUNPOD_API_KEY`) | GraphQL `myself { clientBalance }` (balance, read only) | Partial (guided). No machine starts without a GPU budget (`docs/CHE_GPU_BUDGET.md`) |
| Vast.ai (prepaid GPU) | Console → Keys | Account key | DO key store (`VAST_API_KEY`) | `GET /api/v0/users/current/` (credit, read only) | Partial (guided). Same budget rule |
| Modal | Settings → Proxy Auth Tokens (`wk-…:ws-…`) plus the endpoint the deploy workflow printed (`wk-ID:ws-SECRET@https://<workspace>--che-gpu.modal.run`). The `ak-…:as-…` API token is refused here: it is the deploy key and belongs in GitHub secrets | Workspace proxy token, valid only for web endpoints | DO key store (`MODAL_TOKEN`) | Authenticated `GET /health` on CHE's deployed app must return `che-gpu` at the expected version; 401 = token rejected, 404 = run the deploy workflow first | Guided; wired into the pool (`modal_gpu.js`) |
| OpenAI | Dashboard, or the Admin API (project service account creates a key; needs an admin key) | Project-scoped, restricted key | DO key store | `GET /v1/models` | Partial: an admin key would be needed. It is a paid account, so creating one follows the spending rule |
| xAI | Console, or the Management API `POST management-api.x.ai/auth/teams/{team}/api-keys` with ACLs ([xAI](https://docs.x.ai/docs/key-information/using-management-api)) | ACLs `api-key:endpoint:…`, `api-key:model:…`; key shown once | DO key store | `GET /v1/models` | Partial: automatic once the owner gives a management key (not stored today) |
| YouTube | Google sign-in (Connect YouTube), not a key | n/a | OAuth store | Existing YouTube status | Not onboarding: kept on its own route |

For guided keys, the first line reads `Token saved: yes, ending …`, because the owner made the key; it never reads "created". The GPU providers also speak their once-only steps as a numbered list. The screen has **Paste copied key**, which posts the clipboard straight to `/secret` and then clears it, plus **Read aloud**.

CHE does not claim that every service can be automated. Only Hugging Face has a device adapter. OpenRouter and xAI have real key-management APIs, so they are the next candidates: once the owner stores a management key, a server-side adapter could mint a scoped key and verify it.

## Demonstrated command-to-connection run (offline)

`NODE_PATH=<playwright> CHE_CHROMIUM=<chrome> node tools/che_onboarding_demo.mjs`

The demo sets up:
- the real Worker in-process, with its real routes;
- huggingface.co as a local fake, served over HTTP to real headless Chromium;
- the iPhone driver's steps, replayed with the same injected `che_hf_token_page.js`, because a Flutter WebView cannot run in this container.

Transcript (2026-10-25, redacted by the demo; the token appears only as its fingerprint):

```
Owner: CHE, connect Hugging Face.
CHE: Setting up Hugging Face for CHE's Hugging Face chat engine (router.huggingface.co) and the Kokoro voice fallback. I'm opening your Hugging Face token page in my browser to create "CHE inference 2026-10-25" with only "Make calls to Inference Providers". I'll stop if Hugging Face needs you to sign in or solve a check.  [route che_onboarding, opens service_onboarding]
Device: opened https://huggingface.co/settings/tokens/new?tokenType=fineGrained in CHE's browser; page=token_form, signed in as vondada
Worker: Hugging Face setup is paused: I'm signed in to Hugging Face as vondada. Say "yes, use vondada on Hugging Face" to approve it.
Owner: yes, use vondada on hugging face
CHE: Setting up Hugging Face … (same plan, approved account vondada)  [route che_onboarding, opens service_onboarding]
Device: account vondada matches the approved account (HTTP 200)
Device: filled "CHE inference 2026-10-25", fine-grained, ticked [Make calls to Inference Providers], unticked [Read access to contents of all repos under your personal namespace]
Device: read the new token once from the page: [token sha256:4424cdbb80eb]
Worker: token_created recorded: state=token_created
Device: POST /api/onboarding/huggingface/secret (the only request that carries the token)
Worker: HTTP 200 state=verified
Worker: Token created: yes, "CHE inference 2026-10-25", ending Ekm2.
Worker: Secret configured: CHE Worker runtime key store (read by the chat engine, voice and Film Studio).
Worker: Connection verified: Hugging Face account vondada; token fine-grained, with "Make calls to Inference Providers"; the Hub accepted the token for model metadata (hexgrad/Kokoro-82M); the Inference Providers router accepted the token (model list; no inference was run, nothing was spent).
CHE (spoken): Connected: Hugging Face account vondada, token fine-grained. I can download public models and use Hugging Face Inference Providers for my chat engine and backup voice.
Owner: Is Hugging Face connected?
CHE: Connected: … (the same three lines)  [route che_onboarding]
Keys screen: Hugging Face: healthy, ending Ekm2
Fake huggingface.co: tokens created: 1; permissions: ["Make calls to Inference Providers"]; Worker calls: GET huggingface.co/api/whoami-v2, GET huggingface.co/api/models/hexgrad/Kokoro-82M, GET router.huggingface.co/v1/models
Check: token in transcript or in any storage key other than the runtime key store: no
```

## Tests

| Suite | Count | What it proves |
|---|---|---|
| `server/cloudflare/service_onboarding.test.mjs` | 18 | Wording; fingerprints; permission parsing; the full command through `/api/chat` → event → secret → verified; preserving a working connection; no duplicate tokens; lost token then `#2`; replace-only-if-valid; a dead Worker secret overridden; a refused router or 429 never "Connected"; pause and resume; account approval and mismatch; owner-only, lockdown and secret-free events; guided Groq; BLAKE2b and sealed-box vectors; GitHub secret written as ciphertext GitHub can open; GitHub 403 reported as needing permission; `/connect-service` |
| `server/cloudflare/command_center.test.mjs` | 65 (updated) | 133 commands; `connect-service` reaches `che_onboarding` with no model |
| `tools/che_hf_token_page_test.mjs` (Playwright, headless Chromium) | 3 | Driver against the page reconstruction: user detected, only the needed permission ticked (default extra unticked), token created and read once; a changed form reports what is missing; sign-in and CAPTCHA detected with nothing filled |
| `test/che_service_onboarding_test.dart` | 11 | Token only in the single `/secret` body; "Connected" only after the Worker verified; sign-in pause then resume; CAPTCHA; account approval; held-token retry with no page and no second token; lost-token report; revoke when the server is unreachable; no permission means nothing opened or sent; a changed form creates nothing |

## Not verified

- The live run with the owner's real Hugging Face account. This is iPhone-only: huggingface.co is blocked from this container, so the real token page DOM, the real "save your token" dialog, the real whoami-v2 401 body and the fine-grained permission ids could not be observed here. The driver selects by visible label text and reports missing labels instead of guessing. `tools/fixtures/hf_token_page.html` is a reconstruction, not a copy.
- Whether `CHE_GITHUB_TOKEN` has "Secrets: Read and write". If it does not, CHE reports that and the owner must grant it.
- The Cloudflare Worker secret itself is not written: the Worker holds no Cloudflare credential, and a deploy needs the owner's go.
- No Inference Providers call was made, by design (credits).
