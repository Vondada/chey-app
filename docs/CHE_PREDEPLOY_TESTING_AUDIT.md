# CHE pre-deployment testing: audit (2026-10-26)

Scope: what already gates a change before it reaches the owner's iPhone or production. Read from `main` at
`af3879a4`. Nothing here was run against production.

## What already exists
- **PR checks** (`flutter-check.yml`): Flutter analyze and tests, including `test/che_command_center_e2e_test.dart`,
  which starts `tool/command_center_e2e_server.mjs`: the real Worker code on a local port, offline, in memory, with a
  fake model. This is a real end-to-end run of the Worker, but not against a deployed environment.
- **Worker unit tests** (`server/cloudflare`, `node --test`): run inside `che-worker-deploy.yml` before the deploy
  step ("Worker tests"). Baseline on `88677a97`: 4,156 pass, 0 fail.
- **Production Worker deploy** (`che-worker-deploy.yml`, on pushes tagged `[worker-deploy]` or by hand): runs the Worker
  tests, then **deploys to production**, then runs its live checks against production (voice, paper trading, memory
  truth, Creation Engine, character acceptance, Command Center, Knowledge Atlas, optional video and REA, Fish voice).
  Some of those checks write data (creations, character files, trade records) and they all run after the deploy.
- **Shorebird patches** (`che-shorebird.yml`): runs on every push to `main` that touches `lib/**`, `pubspec.*` or
  `assets/**`, and patches the iPhone with no test gate of its own. It is not wired to the Worker deploy or to
  `flutter-check`.
- **IPA builds** (`che-iphone-ipa.yml`, `che-ipa-release.yml`): an IPA is built only for commits tagged `[ios-build]`,
  or by hand. The release publishes a GitHub release.
- **Codemagic** (`codemagic.yaml`): a draft IPA validation workflow; it validates the Worker but is not the release path.
- **iOS simulator / integration tests**: none. There is no `integration_test/` directory.

## Gaps against the owner's requirements
1. **No staging environment.** The only other environment is Worker Previews, configured in `wrangler.jsonc`, which do
   not inherit production bindings. There is no staging Worker with its own storage and test credentials.
2. **Live checks run after production deploy**, not before. A failing live check does not stop the deploy.
3. **Shorebird patches have no pre-patch gate.** A merge to `main` that touches `lib/` reaches the phone without the
   Worker live checks or any simulator test.
4. **No iOS simulator tests** and no physical-device evidence path beyond the owner's own phone.
5. **No Live Test Dashboard, no test-evidence store, and no notification rules** for automated retests.
6. **Some live checks write data** to the owner's real store, which is not acceptable for a test environment.

## What must be decided before implementation (owner)
- Create a **staging Worker** (a second Cloudflare Worker with its own Durable Object storage and test secrets). This is
  an external account change and needs your approval.
- Whether a Shorebird patch should wait for the staging checks (recommended), and whether the live checks may keep
  writing to production or must move to staging.
- Whether the iOS simulator tests should run on a macOS runner in CI (free for public repos, metered for private ones).

## First increment proposed (no account change needed)
- Move the existing live-check steps that only read data to run first against a PR preview Worker URL, and block the
  production deploy on their failure. This reuses the current steps and secrets.
