# CHE iPhone install — Codemagic + SideStore

Unsigned IPA builds for SideStore. No Apple Developer Program purchase is required for this path.

## What produces the IPA

| Path | Trigger | Artifact |
|---|---|---|
| Codemagic workflow `chey-mobile` | Push/merge to `main` (when connected), or manual run | `CHE-unsigned.ipa` |
| GitHub Actions Mac builders (if enabled) | CI on the repo | Same unsigned IPA shape |

Config file: `codemagic.yaml` at the repo root.

Build steps (summary):

1. `bash ./tool/bootstrap.sh` — generates the iOS Runner / permission strings.
2. `python3 ./tool/patch_local_runtime.py` — local AI + voice tuning bridge.
3. `flutter build ios --release --no-codesign` (optional `CHE_AGENT_URL` dart-define).
4. Zip `Runner.app` into `build/ios/ipa/CHE-unsigned.ipa`.

## One-time Codemagic setup

1. Connect the GitHub repository `Vondada/chey-app` in Codemagic.
2. Select the **chey-mobile** workflow (name: "CHE iPhone SideStore").
3. Confirm Flutter `stable`, latest Xcode, and that artifacts include `CHE-unsigned.ipa`.
4. Optional: set `CHE_AGENT_URL` in Codemagic environment variables to your deployed Worker HTTPS URL so the IPA ships with a default Agent address. Secrets never go in Flutter source — only this build-time define.
5. Prefer manual runs until GitHub Actions iOS builds are settled (see the comment in `codemagic.yaml`).

## SideStore install (phone)

1. Install [SideStore](https://sidestore.io/) on the iPhone (pairing / Anisette helper as their guide requires; a computer may be needed once for the initial pair).
2. Download `CHE-unsigned.ipa` from the Codemagic build artifacts (or AirDrop / Files).
3. In SideStore → My Apps → + → pick `CHE-unsigned.ipa`.
4. Trust / enable the SideStore signing profile when iOS asks.
5. Open CHE. Use the cloud button to paste the Worker `*.workers.dev` HTTPS URL if it was not baked in via `CHE_AGENT_URL`.
6. Pair with the 6–12 digit `CHE_PAIR_CODE` you set as a Worker secret.

## Seven-day refresh

SideStore apps expire about every seven days. Refresh from SideStore on the phone (Wi‑Fi + VPN/pairing as SideStore requires). This refresh is **unrelated** to `CHE_PAIR_CODE`.

If refresh fails, re-pair SideStore from a computer, then reinstall or refresh the IPA.

## What needs a new IPA vs what does not

| Change | Needs new IPA? |
|---|---|
| Cloudflare Worker / Durable Object / plugin catalog | No — cloud updates live after deploy |
| Dart/UI Shorebird-eligible patches (when Shorebird is configured) | Usually no — patch download on next launch |
| New Flutter UI, permissions, Info.plist, native plugins, `che/native_voice` Swift | Yes — rebuild + SideStore install |
| Native voice MethodChannel Swift Runner work | Yes — keep Flutter speech fallback until Swift lands |

## Native voice note

The Flutter channel is `che/native_voice`. Until the owner’s Swift Runner implementation is complete, the mic button uses the Flutter `speech_to_text` fallback. Do not remove that fallback when shipping an IPA.

## Verify after install

- Pair succeeds; Hub → Office → Enter the Office floor shows CHE’s desk and “0 working” when idle.
- Plugins list shows either `CHE_PLUGIN_CATALOG` connectors or the builtin skill rows (Weather, Crypto, Wikipedia).
- Say “CHE, what’s stalled?” or open the Office board and check the STALLED section.
