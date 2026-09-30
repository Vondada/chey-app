# CHE: phone-first build draft

This project contains the supplied live Flutter app and a new cloud Agent
prototype. It has **not** been deployed, compiled on macOS, or installed on an
iPhone. The uploaded Windows `che_agent.py` is a separate local gateway; it
cannot keep running when the Windows computer is off. This cloud Agent keeps
its own Durable Object memory and does not yet import the encrypted Windows memory file.

## What works in source

- **CHE Plugins:** the Plugins button lists server-approved read-only services.
  A paired owner can switch each one on or off. Add future services by setting
  `CHE_PLUGIN_CATALOG` on the Cloudflare Worker to a JSON array like:

  ```json
  [{"id":"weather","name":"Weather","description":"Current weather and forecasts","endpoint":"https://your-service.example/query","token_secret":"CHE_PLUGIN_WEATHER_TOKEN","triggers":["weather","forecast"]}]
  ```

  Set `CHE_PLUGIN_WEATHER_TOKEN` as a Worker secret if the service requires it.
  The remote endpoint accepts POST JSON `{ "query": "...", "tool": "weather",
  "mode": "read_only" }` and returns JSON with the requested information. New
  catalog entries appear in the app without another IPA build. They start off.
  The server sends only the current query, limits results and wait time, and
  never sends CHE's memory, pairing token or owner-shared screen. The catalog
  belongs on the server; do not put API secrets or endpoints in the Flutter app.
  Trades, payments, messages, device control and any other writes require a
  separate permissioned integration with owner confirmation. New iOS permissions,
  native phone capabilities or app interface changes still require a new build.

- Flutter can accept an HTTPS Agent address from the cloud button. Changing the
  server clears the old paired-device token. The browser-only voice bridge is
  conditionally imported for web builds. iOS permission text is inserted by
  `tool/bootstrap.sh` when the Runner is generated.
- `server/cloudflare/worker.js` implements `/api/pair`, `/api/chat`, `/api/state`,
  memory add/delete/clear, and device unpair using Workers AI and a SQLite-backed
  Durable Object created on deployment. The
  pairing code is configured once as a server secret; it is unrelated to
  SideStore's seven-day app refresh. Cloud model use has a daily free limit.
- Say or type **“CHE, add to your app a weekly reminder”** to request a change.
  An authenticated Agent dispatches a GitHub Action. The Action asks a model
  for a narrow Flutter patch, checks the patch and `flutter analyze`, and opens
  a draft pull request. Review and merge the PR on the phone. A merge to `main`
  starts the Codemagic build; install/update its IPA through SideStore.
  Proposals can fail when the model returns an invalid patch or free usage runs
  out. Code is not silently merged on a voice command.

## One-time cloud setup (can be done on the phone)

1. Review and merge draft pull request #2 in `Vondada/chey-app` after its
   Flutter check succeeds. This source already lives on its PR branch.
2. In Cloudflare's free plan connect that GitHub repository as a Worker.
   Set its root directory to `server/cloudflare`, then deploy. The AI binding
   and persistent storage class are declared in `wrangler.jsonc`; there is no
   separate database ID to create. Set `CHE_PAIR_CODE` as a **secret** containing
   6–12 digits. Enter the deployed HTTPS `workers.dev` URL in CHE's cloud button.
3. For voice code proposals, add server secrets `CHE_GITHUB_TOKEN` (a token
   restricted to this repository with Actions workflow dispatch permission),
   `CHE_GITHUB_REPO=Vondada/chey-app`, and `CHE_CHANGE_MODEL` (a model supported
   by your Ollama cloud free account). Add `OLLAMA_API_KEY` as a GitHub Actions
   secret. The GitHub repository must allow Actions to create pull requests.
   The model API key and GitHub token must never be put in Flutter source.
4. Connect the GitHub repository to Codemagic and select the `chey-mobile`
   workflow. It is configured to build on pushes to `main` and packages an
   unsigned iOS app as `CHE-unsigned.ipa`. The build and SideStore installation
   need real device verification. Step-by-step install notes:
   `docs/SIDESTORE_CODEMAGIC.md`.

Native Flutter changes require installing the updated IPA, not rebooting the
phone. Updates to the cloud Agent take effect without an app rebuild. SideStore
can usually refresh on the phone, but its original pairing setup can sometimes
need repair from a computer. The Flutter `che/native_voice` channel still needs
the user's Swift Runner implementation; until then, the microphone button uses
the Flutter speech package. iOS does not grant unrestricted always-on voice or
locked-screen listening merely because this source requests it.

No Apple Developer Program purchase is required for this draft. Free Cloudflare,
Ollama cloud, and Codemagic usage have quotas and may pause when exhausted. The
current cloud prototype does not include the Windows Agent's automatic memory
learning, web research, local tools, or encrypted memory import yet.

<!-- Worker deploy nudge: Cloudflare Workers Builds watch path "*" only sees top-level files. -->
