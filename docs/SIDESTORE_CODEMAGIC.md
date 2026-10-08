# CHE iPhone updates — phone-first Codemagic + SideStore

CHE uses two update lanes so the owner normally never needs a Mac, PC, Xcode,
Terminal, Codemagic dashboard, or GitHub Actions dashboard.

## Owner flow

Say **“CHE, update yourself.”**

CHE checks:

- Shorebird for a compatible Dart-only patch.
- `/api/update/latest` for the newest verified full iPhone build.

If a native/full build is newer, CHE reads three choices aloud:

1. Install with SideStore.
2. Read what changed.
3. Not now.

CHE uses SideStore's documented remote-install URL scheme to hand the verified
IPA directly to SideStore. iOS/SideStore still owns the final install
confirmation; CHE never claims it silently installed an unsigned IPA.

## Cross-builder version ordering

GitHub Actions and Codemagic both generate the SideStore-visible marketing
version using `tool/mobile_version.py`: base major/minor plus an increasing
UTC timestamp-derived patch component. This prevents the earlier mismatch where
Codemagic installed `1.4.1000371` but GitHub advertised `1.4.10`, making
CHE say "up to date" even with a newer verified IPA available. The separate
CFBundleVersion build number remains tied to each provider's build run.

The Worker serves the highest verified numeric app version, not merely the last
release that finished uploading. A full IPA still needs owner confirmation in
SideStore; Shorebird-supported Dart patches can apply without reinstalling.

## Two update lanes

### Fast update — Shorebird

Use for Dart-only application changes that Shorebird accepts.

The automatic Codemagic workflow attempts `shorebird patch ios`. Shorebird
itself checks for native and asset differences. If a safe patch cannot be
created, CHE's build script falls back to the full IPA lane.

### Full update — new IPA

Use for native Swift, Info.plist, permissions, assets, Flutter engine/native
plugin changes, or whenever the fast lane cannot safely patch.

Codemagic:

1. Bootstraps the generated iOS project.
2. Runs Flutter analyze.
3. Creates a Shorebird release baseline when Shorebird is configured, otherwise
   a normal unsigned Flutter iOS build.
4. Packages `CHE-unsigned.ipa`.
5. Calculates SHA-256.
6. Creates a **draft** GitHub Release.
7. Uploads the IPA.
8. Requires GitHub's uploaded-asset digest to exactly match the local SHA-256.
9. Uploads `CHE-update.json`.
10. Publishes the Release only after verification.

A failed build or failed checksum never replaces the last-known-good public
release. Codemagic's post-publish hook records a `CHE iPhone update` commit
status even after a failed build, so CHE can say that the newest attempt failed
while preserving the previous verified IPA.

## Stable Worker URLs

The phone and SideStore use the CHE Worker as the stable front door:

- Latest metadata: `https://chey-app.henryjavoni.workers.dev/api/update/latest`
- Build history: `https://chey-app.henryjavoni.workers.dev/api/update/history`
- SideStore source: `https://chey-app.henryjavoni.workers.dev/api/update/source`
- Latest IPA: `https://chey-app.henryjavoni.workers.dev/api/update/download/latest`

The Worker routes are read-only. There is no public IPA upload endpoint.

The IPA response uses:

- `Content-Type: application/octet-stream`
- `Content-Disposition: attachment; filename="CHE-unsigned.ipa"`
- byte-range headers when the upstream supports them

## SideStore one-click links

CHE uses SideStore's documented URL schemes:

`sidestore://install?url=[encoded IPA URL]`

and:

`sidestore://source?url=[encoded source URL]`

Adding the CHE source once lets SideStore see the latest CHE version and older
versions from the release history without visiting Codemagic.

## One-time Codemagic setup

The existing personal Codemagic app must remain connected to
`Vondada/chey-app` and use the repository's `codemagic.yaml`.

Environment group `che_ship`:

- `SHOREBIRD_TOKEN` — Secret. Enables fast OTA updates and Shorebird full
  release baselines. Use a current Shorebird API key. Legacy `login:ci`
  credentials were only supported through September 2026, so do not rely on an
  older CI token.
- `GITHUB_TOKEN` — Secret. Fine-grained token scoped to
  `Vondada/chey-app`, with **Contents: Read and write** and
  **Commit statuses: Read and write**. It is used only by Codemagic to create
  verified GitHub Releases and report whether the newest mobile build passed
  or failed.
- `CHE_AGENT_URL` — optional. Defaults to the production CHE Worker.

Never put these values in Flutter source, release notes, or the IPA metadata.

If `GITHUB_TOKEN` is missing, Codemagic can still produce its build artifact,
but the phone update API intentionally does **not** advertise that artifact.
That prevents CHE from announcing a build the owner cannot reliably install.

## Version history and rollback

The Worker exposes up to the latest 12 successful CHE releases. CHE's Updates
screen lists previous builds. Selecting one requires owner confirmation before
CHE opens SideStore on that older verified IPA.

Publishing a new build never deletes the prior release.

## Voice-first behavior

Every important update action is represented by a labeled Semantics control and
spoken status:

- update available
- install/open SideStore
- read release notes
- fast-patch result
- rollback confirmation
- failure without replacement

CHE says what is about to happen before opening SideStore and does not claim the
install succeeded because iOS completes that action outside CHE.

## Initial SideStore setup

This design removes the computer from **normal CHE updates after SideStore is
already installed and paired**. It does not bypass SideStore/iOS requirements
for SideStore's own initial installation, pairing, signing, or periodic account
requirements.
