# Blocker runbook

Each entry: how to recognise it, what is safe to retry (and how often), when to stop, and what to report. "Report" means the handoff §2 and the reply to the owner, with the real command output.

## Full disk / expired or replaced workspace
See SKILL.md §2 and §3. Preflight first: `node .claude/skills/che-recover/scripts/preflight.mjs`.

## Interrupted job (server side)
- Recognise: a job, mission or render stays `running` with no new checkpoint or heartbeat.
- The Worker's queues resume from durable checkpoints on the next alarm (Creation Engine `/api/gpu/*`, workflow engine; see `docs/CHE_WORKFLOW_ENGINE.md`). Read the job's state first; never start a duplicate job for the same request.
- Retry: resume, never restart from scratch. Stop after the job's own retry limit and report its last checkpoint and error.

## Dropped worker (Colab GPU, free GitHub CPU worker, Rithmic stream)
- Recognise: heartbeat older than its timeout; the app shows a CPU or stale state, not "connected".
- Retry: reconnect with backoff (the stream clients cap their own retries). A GPU worker that needs a sign-in, Colab secret or rerun of notebook cells is an owner action: name it, do not keep a session alive by automation.
- Never call a queued job or an online CPU a connected GPU.

## Failed package download (pub, npm, pip, Flutter SDK)
- Recognise: `pub get`/`npm ci` network, TLS or 403 errors.
- Retry at most 4 times with backoff 2, 4, 8, 16 s. In a cloud container, check the proxy: `curl -sS "$HTTPS_PROXY/__agentproxy/status"` and `/root/.ccr/README.md`. Never disable TLS verification.
- A corrupt cache: `flutter pub cache repair`, or `preflight.mjs --clean --pub-cache --yes` then `flutter pub get`.

## CI failure
- Reproduce locally with the same command the workflow runs (`.github/workflows/flutter-check.yml`: `dart analyze --fatal-infos`, `flutter test`, `node --test server/cloudflare/*.test.mjs`, skills tests). `che-debug` covers fixing it.
- Re-run a job only if it died before any test ran (checkout, install, runner loss), at most once. A second failure is real.
- Never skip, disable or quarantine a test; never push an empty commit to kick CI.

## Build timeout (IPA, Shorebird, renders)
- Recognise: the run hits its `timeout-minutes` or the runner is cancelled.
- Check the run's last step and logs before re-running. Re-run once if the cause was the runner; otherwise fix the slow step (cache, smaller job) first.
- An IPA is ready only when the artifact exists: name the run id, artifact name, size and sha256.

## Deploy error (Worker)
- Status: `node .claude/skills/che-release/scripts/release_status.mjs --sha <SHA>`. Production is live only when `/health` reports the merged SHA.
- Never deploy from a branch. A failed deploy is re-run from `main` once after the cause is fixed. Merges and deploys need the owner's authorization (`che-release`).

## Expired credentials or sign-in (GitHub connector, Cloudflare, Google, broker)
- These are owner actions. Say exactly which sign-in, where, and what it unblocks; continue other work.
- Never ask for a password in chat; owner passwords live only in the on-device vault.

## Lost context between AIs (Claude, Codex, ChatGPT, CHE)
- Source of truth order: git and GitHub, then `mailbox/briefs/LIVE-HANDOFF.md` §2, then mailbox lines.
- Every lane branch is pushed after each commit, so a lost container loses nothing. Local-only lanes are what the 2026-10-25 resume lost.
- Before stopping, update §2 with this template:

```
**<AI>, <UTC time> — <one-line state>.**
- main: <SHA>. Branch: <branch> at <SHA> (pushed). PR: #<n> <state>.
- Done (proof): <change> — <test command> <pass>/<total>; CI <run id> <result>.
- Unverified: <what, e.g. iPhone, production>.
- Deploy: <live SHA from /health or "not deployed">. IPA: <run, artifact, sha256 or "none">.
- Blockers: <blocker> — needs <owner action>.
- Next executable action: <exact command or step>.
```
