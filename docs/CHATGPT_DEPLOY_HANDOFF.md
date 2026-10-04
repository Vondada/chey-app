# CHE deployment handoff for ChatGPT

Use this handoff to continue from the checked-in implementation without
rebuilding completed features or weakening the owner's safety and accessibility
requirements.

## Current position

- Repository: `Vondada/chey-app`.
- Source snapshot reviewed: commit `d7fc484` (`[worker-deploy] Trading learning:
  all 63 skills in one pass, re-tested daily (#179)`).
- The checkout used to prepare this handoff is on branch `work`, has no Git
  remote, and is not authenticated to GitHub. Reconnect it to the authoritative
  repository and compare it with `origin/main` before changing or deploying
  anything.
- Production Worker URL: `https://chey-app.henryjavoni.workers.dev`.
- The current environment blocks outbound requests to that URL with an HTTP 403
  proxy response, so production health and release metadata were **not**
  independently verified during this handoff.
- The Flutter SDK is not installed in this environment. Worker checks can run
  here; Flutter analysis and iOS packaging must run in Codemagic or another
  configured macOS/Flutter environment.
- The required `che-mailbox` branch and mailbox files are absent from this
  checkout because there is no remote. Fetch and read them before continuing.

## Owner request and authorization

The owner asked to integrate the latest repository work, finish CHE, and deploy
it. Treat that as authorization to run the established code deployment
workflows. It does **not** waive these standing rules:

1. Ask before any payment, purchase, order, subscription, transfer, deletion,
   or removal.
2. Confirm consequential AI-provider permission changes aloud.
3. Never expose or copy secret values. Passwords remain only in the on-device
   Keychain vault and must never reach the Worker, an AI provider, chat history,
   memory, or logs.
4. Do not bypass app-specific permission enforcement, review protections, CI,
   signing restrictions, or the existing voice navigator.

## Required continuation sequence

### 1. Restore repository and mailbox context

```bash
git remote -v
git remote add origin git@github.com:Vondada/chey-app.git  # only if absent
git fetch origin --prune
git fetch origin che-mailbox:refs/remotes/origin/che-mailbox
git show origin/che-mailbox:mailbox/briefs/LIVE-HANDOFF.md
git show origin/che-mailbox:mailbox/chatgpt.jsonl
git log --oneline --decorate --graph -20 origin/main
```

Also inspect the newest messages in the other `mailbox/*.jsonl` files that are
addressed to ChatGPT and the latest CHE round-table conclusions. Follow
`mailbox/README.md` when replying. Keep mailbox-only updates on the
`che-mailbox` branch; never merge mailbox content into the application branch.

### 2. Reconcile this snapshot with live `main`

Start from the newest `origin/main`, not blindly from branch `work`. Verify that
commits through `d7fc484` (including the autonomous coding and trading changes)
are already present. If live `main` is ahead, preserve its changes. If work is
missing, integrate it through a reviewable branch and pull request rather than
force-pushing or replacing `main`.

### 3. Validate the Worker

Use Node 22 or newer:

```bash
cd server/cloudflare
npm ci
npm run check
npm test
npx wrangler deploy --dry-run
```

Do not proceed on a failing check. Do not print secrets. Confirm only secret
**names** with `npx wrangler secret list`; deployment configuration and the
expected names are documented in `docs/CLOUDFLARE_DEPLOY.md`.

### 4. Validate Flutter and accessibility

In a Flutter-capable environment:

```bash
flutter pub get
dart format --output=none --set-exit-if-changed lib test
flutter analyze --no-fatal-infos --no-fatal-warnings
flutter test
```

For every touched owner-facing flow, verify typing and voice routes, VoiceOver
labels, large visible spoken text, a visible status banner, haptic feedback,
numbered spoken options, and an audible success/failure report based on the
actual result. Preserve `lib/browser/che_browser.dart` and the navigation logic
in `lib/home_state/send.dart`.

### 5. Deploy the Worker

Cloudflare Workers Builds is configured to deploy `server/cloudflare` from
`main`. Prefer merging the reviewed PR and observing that deployment. If the
automatic build is unavailable and the authenticated environment has the
existing Cloudflare credentials, deploy manually:

```bash
cd server/cloudflare
npx wrangler whoami
npx wrangler deploy
curl -fsS https://chey-app.henryjavoni.workers.dev/health
```

Then run focused production smoke checks without logging the pairing code or
bearer token. Verify `/health`, pairing, one ordinary chat, coding/repository
grounding, and read-only trading research. Never place a live trade or spend
money as a smoke test.

### 6. Deliver the iPhone app

The repository's normal phone workflow is `chey-shorebird` on pushes to `main`.
It chooses an eligible Shorebird patch or a full unsigned SideStore IPA. The
one-time Codemagic variable group is `che_ship`; secret values belong only in
Codemagic and must not be copied into source or chat.

For a full native/asset release, run the `chey-mobile` Codemagic workflow. For a
Dart-only update, allow the automatic `chey-shorebird` workflow to choose the
safe route. Confirm the build artifact and Worker-published update metadata:

```bash
curl -fsS https://chey-app.henryjavoni.workers.dev/api/update/latest
curl -fsS https://chey-app.henryjavoni.workers.dev/api/update/history
```

Install the resulting IPA through SideStore when a full build is required, then
perform real-device checks for pairing, microphone, spoken/visible responses,
VoiceOver navigation, haptics, background-job status, coding requests, and
trading-research disclaimers. Shorebird cannot replace a full IPA for native or
bundled-asset changes.

### 7. Close out accurately

- Report exact commit, PR, CI/Codemagic build, Worker deployment version, live
  smoke-test results, and IPA or Shorebird delivery result.
- Clearly distinguish verified results from environment limitations.
- Update `mailbox/briefs/LIVE-HANDOFF.md` with the new current position, append
  ChatGPT's mailbox reply, and push those changes to `che-mailbox` only.
- Do not call CHE “fully autonomous” unless each claimed action is backed by a
  real connector and verified execution. Document remaining owner-only setup or
  platform restrictions instead of simulating success.

## Source-of-truth deployment files

- `AGENTS.md` — owner permissions, accessibility, password boundary, navigator
  ownership, and mailbox procedure.
- `codemagic.yaml` — current iPhone validation, full-release, and automatic
  Shorebird workflows.
- `docs/CLOUDFLARE_DEPLOY.md` — Worker configuration, secret names, and deploy
  checks.
- `docs/SIDESTORE_CODEMAGIC.md` — phone-first release and install procedure.
- `docs/CHE_BUILD_PLAN.md` — implemented capability map and remaining external
  setup.
- `docs/CHE_MASTER_SPEC.md` — product and controlled self-development contract.

