# CHE Cloud Computer

**Where:** More → **Cloud Computer**, or say "open your cloud computer". Code: `server/cloudflare/cloud_computer.js` (manager), `GET/POST /api/cloud-computer…` in `worker.js`, the `cloud-*` commands in `command_catalog.js`, and `lib/rooms/che_cloud_computer_room.dart` (the room).

The Cloud Computer is one manager over the compute CHE already had. It adds no second job queue, router or agent system.

## What CHE already had (before this change)

| Piece | Where | What it runs |
|---|---|---|
| Durable Object job queue | `worker.js` `enqueueJob`, `processJobs`, `/api/job/*` | Background jobs with retries, dead-letter and activity notes |
| Coding runtime | `coding_runtime.js` `gh()`, `che-opencode-runtime.yml`, `self_development` jobs | Coding jobs that open draft pull requests |
| Isolated browser | `rea_runner.js`, `che-rea-web.yml` | Playwright Chromium on a GitHub runner; no sign-in, no forms |
| Video, edit and film renders | `github_video_renderer.js`, `che-video-render.yml`, `che-edit-render.yml`, `che-film-render.yml` | ffmpeg, piper-tts, espeak-ng and Pillow on ubuntu-latest |
| App builds | `app_builds.js`, `che-iphone-ipa.yml`, `che-shorebird.yml` | macOS runner builds and patches |
| GPU film farm | `film_farm.js` | Kaggle or Hugging Face GPU workers, when a token is saved |
| Persistent agent computer | `agent_runtime.js` `runComputerWorkspace` (`CHE_COMPUTER_URL`) | Owner-approved Office agent tasks on the owner's own endpoint |
| Execution tiers | `capability_registry.js` `EXECUTION` | INTERNAL, LOCAL, OWNER_COMPUTE, EXTERNAL_FREE, EXTERNAL_PAID |
| Agent roster | `office_company.js` `LA_AGENCIA_ROLES` | Nova, Atlas, Mira, Knox, Sage, Lyra, Orion, Iris, Vale |

## What was reused

- **Jobs:** a Cloud Computer job is a `cloud_task` job in the existing Durable Object queue. It has the same attempts, activity notes and retry ledger as every other job. `processJobs` runs it through `runCloudTask`.
- **Starters:** coding goes to `queueSelfDevelopment`, browser and research go to `handleReaRequest`, video renders go to `startGithubVideo`, and app builds go to `dispatchAppBuild`. Each keeps its own gates. The one new dispatch, repository tests, goes through the same `gh()` helper the coding runtime uses.
- **Ledger:** the room reads the jobs that already exist: queue jobs, the last OpenCode session, REA jobs, video renders (dispatch stamps and the media index), Film Studio films, the app-build record, and Office tasks that used `CHE_COMPUTER_URL`. A record without a result shows as `unverified`.
- **Chat:** spoken requests reach their `cloud-*` catalog command through `cloudIntent`, the same way `studioChatIntent` reaches the Creator Studio commands. The slash command and the spoken words run one handler.

## What was added

- **Providers** (`PROVIDERS`). Each provider declares its id, capabilities, cost tier, billing state, whether it needs approval, and an availability check (`checkProvider`):
  - `worker_internal`: the Worker itself (api, document, file, research);
  - `github_ubuntu`: tests, coding, ffmpeg, file and video render;
  - `browser_isolated`: browser;
  - `github_macos`: iOS builds;
  - `owner_computer`: `CHE_COMPUTER_URL`. It declares no capabilities, because CHE is never told what that endpoint runs;
  - `film_farm`: GPU, as an outside free service.

  No provider is EXTERNAL_PAID. One would be refused outright.
- **Selection** (`selectProvider`). It picks the cheapest provider that has every capability the template needs, by execution tier. If no provider has a capability, the answer names it, says what CHE already has toward it (`MISSING`) and gives the smallest addition that would add it.
- **Allowlisted templates** (`TEMPLATES`): `repo_tests`, `coding`, `browser`, `research`, `video_render`, `file_processing`, `media_transcode`, `blender_render`, `gpu_animation`, `ios_build` and `ios_patch`. Parameters are typed: `repo_tests` always runs `flutter-check.yml` on `main`. Chat text never becomes a shell command.
- **Approval records.** A new dispatch on a provider whose billing is unverified, or on an outside service, is stored as `awaiting_approval` with `approval.reason`. It runs only after "approve cloud job …" (or the room's Approve button) sets `approval.approved_at`. `runCloudTask` refuses an unapproved job in code, and `processJobs` only picks up `queued` jobs. An owner's retry counts as approval for that one new run (`approved_via: owner_retry`), and the reply says so.
- **Controls:** approve, cancel (only before dispatch), stop (cancels the GitHub run through `POST /actions/runs/{id}/cancel` and marks the job cancelled only when GitHub accepts it), and retry (a new job). GitHub errors are explained in plain language (`explainGithubError`): 401 means the token, 403 means the permission or Actions being disabled, 404 means the repository or workflow, and so on.
- **Agents request work** with `requestCloudWork(data, { agent, kind, params }, { env, enqueue })`. Only CHE and the roster agents can call it.
- **File inspection** (`runFileJob`) runs on the Worker. It records the size, SHA-256, detected type and, for an MP4, its length and codecs (`mp4Facts`), as a finished queue job. The bytes are never stored.
- **Routes** (owner device only): `GET /api/cloud-computer` returns environments, software, jobs, selection, templates, approvals, missing capabilities, costs and resources. `POST /api/cloud-computer/start {kind, params, agent}` starts a job, and `POST /api/cloud-computer/{approve|cancel|stop|retry} {id}` controls one. Every answer carries `spoken`.
- **Room:** environments, software, status, jobs (agent, provider, tools, times, logs, outputs, evidence, errors), approvals, missing capabilities and costs. It has Approve, Cancel, Stop and Retry buttons with VoiceOver labels, plus a Read Aloud button. Loading is quiet. Each action shows a banner, plays a haptic and speaks its real result.

## By voice

| Say | Command | Does |
|---|---|---|
| "Open your cloud computer" | `/cloud-open` | Opens the room and says the summary |
| "Create a Blender animation (of …)" | `/cloud-blender` | Says that 3D models build on the free cloud Blender worker, but no workflow renders an animation to MP4 yet, and names the smallest addition. Nothing starts |
| "Render my YouTube video" | `/cloud-render` | Gives the latest render's real state and where renders run. A new render is "make a faceless video about …" |
| "Run your coding tests" | `/cloud-tests` | Prepares a `flutter-check.yml` run and asks for approval |
| "Check your open pull requests" | `/cloud-prs` | Reads the open PRs from GitHub as a numbered list |
| "Install a compatible free tool …" / "Install X on your cloud computer" | `/cloud-install` | Lists what each environment has. Installs nothing: a new tool is a workflow pull request |
| "Show me what your agents are working on" | `/cloud-agents` | Reads the waiting, queued and running cloud jobs, grouped by agent |
| "Approve / cancel / stop / retry (the) cloud job [id]" | `/cloud-control` | Controls a job and reads back the result. With no id, it acts on the newest job that fits |

Questions ("what is a cloud computer?") and other sentences do not match. "Cancel coding job …" stays the coding-job cancel.

## Blockers (honest status)

- **Blender: 3D models only.** The Creation Engine's free cloud CPU worker runs Blender for Create → Generate (see Creation workers below). No workflow yet renders a Blender animation to MP4 (`blender_render` stays blocked and says so).
- **GPU:** none on the Worker or the GitHub-hosted runners. Your Colab T4 joins while its notebook runs. The film farm (Kaggle or Hugging Face) needs a token and has never been verified from this Worker.
- **GitHub Actions billing is not verified.** CHE has not read the repository's visibility or the account's billing. GitHub-hosted minutes are free for public repositories, but a private repository spends the account's included minutes and can be billed past them. That is why every new GitHub dispatch from the Cloud Computer waits for approval.
- **Network egress.** The REA browser can open only public pages that the runner's network allows. Blocked hosts fail and are reported as failed, not as success.
- **No arbitrary file transcode.** ffmpeg exists on the runner, but no workflow accepts an arbitrary file. `media_transcode` says so and queues nothing.
- **`CHE_COMPUTER_URL`** is listed as a provider, but its software is not reported to CHE, so it is never selected for a template.
- **Not verified live:** this change was tested offline only, with a fake GitHub (`cloud_computer.test.mjs`) and a widget test. No workflow was dispatched, and nothing has been tested on the iPhone or in production.

## Creation workers (2026-10-24)

The Creation Engine's workers are part of this one Cloud Computer, not a second system. Both entries are declared once in
`creation_orchestrator.js` (`CREATION_PROVIDERS`), and the `PROVIDERS` list here includes them:

| Worker | Starts by itself? | Cost | Notes |
|---|---|---|---|
| GitHub cloud CPU Blender worker (`che-creation-worker.yml`) | Yes. Create → Generate queues the job, and CHE dispatches the workflow when no worker can take it. | $0 while the repository is public. CHE re-reads the visibility (cached for an hour) before every start and refuses if the repository is private. | CPU only, so slower. Authenticates with GitHub OIDC; there is no secret. |
| Your Colab T4 (`notebooks/CHE_GPU_Face_Preview.ipynb`) | No. | $0, your own free session. | Paired once with Pair Colab. The token stays in Colab Secrets and CHE keeps the pairing. |

**Why CHE cannot start the Colab GPU unattended.**
- Free Colab runtimes run only from an open notebook. The Colab FAQ says free resources favour interactive notebook use and may end sessions driven in other ways.
- Google's official Colab CLI (June 2026, `googlecolab/google-colab-cli`) can start runtimes. But it needs your Google credential on the machine that runs it, documents no free-tier terms, and can spend paid Colab compute units. CHE does not use it under the $0 rule.

**When the GPU stops:**
- A GPU-only job shows **Waiting for GPU** and resumes from its saved stages when a GPU checks in.
- A Create Person job moves to the free cloud CPU.

**What the app does:**
- In ordinary use the app never opens Colab. "Connect", "create a person" and "continue creating" stay inside CHE.
- The only Colab link is the explicit setup button in Settings → Connections → Cloud Computer.

**Live proof.** The deploy workflow's `creation_check` input runs Generate on the live Worker. It waits for the real worker, checks the GLB against its receipt, and opens it in the Live Studio viewport (`creation_probe.js`, `tools/creation_open_in_studio.mjs`).
