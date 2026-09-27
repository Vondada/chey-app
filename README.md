# CHE: phone-first build draft

This project contains the supplied live Flutter app and a new cloud Agent
prototype. It has **not** been deployed, compiled on macOS, or installed on an
iPhone. The uploaded Windows `che_agent.py` is a separate local gateway; it
cannot keep running when the Windows computer is off. This cloud Agent keeps
its own D1 memory and does not yet import the encrypted Windows memory file.

## What works in source

- Flutter can accept an HTTPS Agent address from the cloud button. Changing the
  server clears the old paired-device token. The browser-only voice bridge is
  conditionally imported for web builds. iOS permission text is inserted by
  `tool/bootstrap.sh` when the Runner is generated.
- `server/cloudflare/worker.js` implements `/api/pair`, `/api/chat`, `/api/state`,
  memory add/delete/clear, and device unpair using Workers AI and D1. The
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

1. Put this project in the `Vondada/chey-app` GitHub repository's `main` branch.
   It currently exists as a downloadable draft, not a commit in that private
   repository. A GitHub connection with write access is required to do this.
2. Make a free Cloudflare account. Create a D1 database named `che-agent`;
   replace `REPLACE_WITH_YOUR_D1_DATABASE_ID` in
   `server/cloudflare/wrangler.jsonc` with its database ID. Execute
   `server/cloudflare/schema.sql` on that remote database and deploy the Worker
   with its AI and DB bindings. Set `CHE_PAIR_CODE` as a **secret** containing
   6–12 digits. Enter the deployed HTTPS `workers.dev` URL in the CHE app.
3. For voice code proposals, add server secrets `CHE_GITHUB_TOKEN` (a token
   restricted to this repository with Actions workflow dispatch permission),
   `CHE_GITHUB_REPO=Vondada/chey-app`, and `CHE_CHANGE_MODEL` (a model supported
   by your Ollama cloud free account). Add `OLLAMA_API_KEY` as a GitHub Actions
   secret. The GitHub repository must allow Actions to create pull requests.
   The model API key and GitHub token must never be put in Flutter source.
4. Connect the GitHub repository to Codemagic and select the `chey-mobile`
   workflow. It is configured to build on pushes to `main` and packages an
   unsigned iOS app as `CHE-unsigned.ipa`. The build and SideStore installation
   need real device verification.

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
