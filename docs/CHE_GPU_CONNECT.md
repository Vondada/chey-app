# Connect GPU (owner request, 2026-10-25)

The owner says **"Connect GPU"** (or "connect the GPU", "start my GPU", or types `/cloud-gpu connect`). CHE opens his
Colab notebook in her own browser, does the steps she is allowed to do, brings him to any step only he may do, and then
proves the connection from her own Worker. It costs $0 and needs no new API key.

**Code**
- `lib/create/che_gpu_connect.dart`: the state machine `CheGpuConnect` (one app-wide instance), the page probe, the
  real ports (`CheGpuSessionBrowser`, `CheGpuHttpWorker`) and the panel `CheGpuConnectPanel`.
- `lib/create/che_gpu_browser.dart`: the GPU Browser screen. It shows the panel above the notebook. Its voice routes
  are "Connect GPU", "continue", "stop connecting", "read the GPU connection" and "my CHE Office Google account is …".
- `lib/browser/che_browser.dart`: additive hooks only.
  - `cheBrowserSessionEval`, `cheBrowserSessionLoad`, `cheBrowserSessionUrl` and `cheBrowserSessionExists` act on the
    named session `creation-gpu`, on screen or retained off screen.
  - The opt-in `googleSignInInPage` flag is used only by the GPU Browser. Every other browser screen behaves as before.
- `lib/home_state/send.dart`: additive. It adds the voice route from any screen, plus `_configureGpuConnect` and
  `_showGpuBrowser`. The navigator logic is unchanged.
- `lib/home_state/streaming.dart`: the Worker's `open_screen: gpu_connect` reply opens the flow.
- Worker:
  - `cloud_computer.cloudIntent` maps "Connect GPU" to the existing `/cloud-gpu` catalog entry with input `connect`. No
    new command was added.
  - `worker.js cloudCommand` answers with `gpu_queue.speakGpuConnect`. It says "GPU connected" only with a fresh GPU
    heartbeat, and it opens the app's flow.
  - `avatar_identity.js` passes `priority` through for the test job.
- `notebooks/CHE_GPU_Face_Preview.ipynb`: the Drive cell continues without Drive if Google's Drive window cannot open.

## The flow

1. **Permission.** `CheGpuConnect.start(words)` refuses unless the words are the owner's own Connect GPU command, or
   the Connect GPU button. It records the grant `colab` in `CheAppPermissions`, plus a timestamped log line, before
   anything opens. This is the AGENTS.md rule, enforced in code.
2. **Open.** CHE brings the GPU Browser to the front and loads
   `…/CHE_GPU_Face_Preview.ipynb?authuser=<CHE Office account>`. The account is an on-device setting
   (`che_gpu_google_account` in shared preferences). It is an address only, never a password.
3. **Check 1: Google account.** A page probe reads the address from Colab's "Google Account: Name (email)" button.
   - **Right account:** passed.
   - **Wrong account:** CHE opens Google's account chooser for the CHE Office address and asks the owner to pick it.
     If the page still shows the wrong account after that, CHE stops before connecting.
   - **No preferred account set:** marked "not verified", with how to set one.
   - **Sign-in needed:** CHE pauses on Google's page and says: "Google needs you to sign in here with … CHE never types
     your password. Say continue when you are done." She resumes on "continue", or by herself when the page moves on.
4. **Run.** CHE tries Colab's Run all in this order: the `runall` menu command, `colab.global.notebook.runAll`, then
   the Ctrl+F9 shortcut. If none of these exists, she presses Connect instead.
   - **Owner-only dialogs.** CHE does not press anything in these. She brings the owner to each one and resumes after:
     - "Warning: This notebook was not authored by Google" (Run anyway);
     - Google Drive access;
     - "Change runtime type" when the runtime has no GPU.
   - **Run all did not start.** If nothing shows that it started, CHE asks the owner once to choose Runtime, then
     Run all.
   - **No GPU available.** If Colab says no GPU is available for his account (usage limits), the flow fails and says
     so.
   - **Runtime type.** The notebook's metadata already asks for a T4 GPU (`accelerator: GPU`, `gpuType: T4`), so CHE
     never needs to automate the runtime-type dialog.
5. **Check 2: Colab GPU runtime.** This passes on either of two pieces of evidence:
   - the notebook's own `nvidia-smi` line on the page;
   - the GPU name reported by the worker running inside that runtime.

   If neither arrives, it is "not verified".
6. **Check 3: CHE worker heartbeat.** CHE polls `GET /api/gpu` until a Colab worker with a real GPU name is `online`.
   - **When it counts:** the Worker computes `online` as a heartbeat under 90 s old (`gpu_queue.ONLINE_MS`), the
     same rule `compute_pool` uses. A CPU worker never counts (`cheGpuWorkerOnline`).
   - **Only then:** "GPU connected" is shown and spoken, and `CheGpuConnect.connected` becomes true.
   - **Timeout:** if no heartbeat arrives, the check fails with the likely reason (no pairing, or an error in the
     notebook's last cell) and the flow says "GPU not connected".
7. **Check 4: test job completed and opened.** CHE queues one real GPU-only job through the existing preview route:
   CHE's preset, stylized look, front view, 160 px, 16 samples, priority high.
   - She waits for `completed`, downloads the picture from `/api/media/<id>/image`, and decodes it as Flutter shows
     it.
   - It passes only when the picture decodes and appears in the panel.
   - It is reported separately: "Test job completed and opened", or the failure. A test failure does not take back
     check 3.
8. **Disconnection.** While connected, CHE reads `GET /api/gpu` every 20 s. She only reads; she never clicks Colab.
   - **When the heartbeat goes stale:** the banner says: "GPU disconnected. Your jobs are kept and will resume from
     their last checkpoint on the next worker. A running job pauses within 3 minutes; GPU-only jobs wait until a GPU
     connects again." It comes with a heavy haptic and no speech (passive status).
   - **Why that text is true** (pinned in `gpu_connect.test.mjs`):
     - the lease expires 3 minutes after the last heartbeat;
     - the job is paused with its checkpoints;
     - the next compatible worker resumes it from them.
9. **Across screens.** The notebook stays loaded:
   - **Leaving the screen:** the WebView lives in `che_browser.dart`'s retained session `creation-gpu`, so leaving the
     GPU Browser does not dispose it.
   - **The flow:** `CheGpuConnect.instance` is app-wide, so it keeps polling the Worker.
   - **Reopening the screen:** the same page comes back.

   CHE does nothing to defeat Colab's idle limits. A runtime can end at any time.

**Speech** (AGENTS.md)
- The acknowledgement ("Connecting your GPU…"), each step only the owner can do, "GPU connected", and the test result
  are spoken.
- Progress is quiet text in the panel.
- Every check is its own VoiceOver line, for example "CHE worker heartbeat: passed. Fresh heartbeat from Tesla T4 …".
- **Read aloud** reads all four checks.

## Research (2026-10-25)

| Question | Finding | Source |
|---|---|---|
| Can Google sign-in run inside an embedded webview? | Google blocks OAuth requests from embedded webviews: `disallowed_useragent`, enforced from September 30, 2021, following RFC 8252. Since June 2019 Google has also blocked sign-ins from embedded browser frameworks, because it cannot tell them from man-in-the-middle phishing. In practice a WKWebView sign-in can get "This browser or app may not be secure". | [Google Developers blog, June 2021](https://developers.googleblog.com/2021/06/upcoming-security-changes-to-googles-oauth-2.0-authorization-endpoint.html); [Google Security blog, April 2019](https://security.googleblog.com/2019/04/better-protection-against-man-in-middle.html) |
| What CHE does about it | Only the GPU session loads Google's page unchanged, with no user-agent spoofing and no cookie copying, so Google decides. The probe detects Google's refusal page; CHE then opens the notebook in Safari and says why. Every other browser screen keeps the existing hand-off to the system sheet. | `che_gpu_connect.dart` `_safari`; `che_browser.dart` `googleSignInInPage` |
| Do WKWebView cookies persist across app restarts? | Yes. A web view using the default `WKWebsiteDataStore` saves website data to disk. That store is separate from Safari's. | [Apple: WKWebsiteDataStore.default()](https://developer.apple.com/documentation/webkit/wkwebsitedatastore/default()) |
| Can a Safari / SFSafariViewController / ASWebAuthenticationSession sign-in carry over into CHE's WebView? | No. SFSafariViewController keeps its own store, and ASWebAuthenticationSession shares Safari's cookie jar. Neither writes into the app's WKWebView store, and Apple offers no supported way to copy cookies across. So the honest fallback is the notebook itself in Safari, not a sign-in sheet. This is also why the old GPU Browser could never become signed in: it sent every Google sign-in to the system sheet. | Apple docs above; developer reports summarized in [link.boo in-app browser cookies](https://link.boo/guides/in-app-browser-cookies-explained) (secondary) |
| Does `authuser=` pick the account? | Google services accept `authuser` (an index or an email) to choose among accounts signed in together. Colab URLs carry it (for example `faq.html?authuser=2`). Google does not document it for Colab, so CHE treats it as a hint and checks the account on the page. | Observed in Colab URLs; not formally documented (stated as unverified) |
| Colab's markup for Connect, Run all and the account | Not a public API. Colab's toolbar uses the `colab-connect-button` element; menu items carry `command` names. Neither is documented, so every field of CHE's probe is best effort. A missing field counts as unknown, never as success. The heartbeat is the proof. | Inspected names; unverified live |
| Free Colab and automation | Colab prioritizes users who are actively programming in a notebook. Resources are not guaranteed, idle timeouts and lifetimes vary and are not published, and free runtimes last at most about 12 hours. Some activities are disallowed on free runtimes. The full list could not be read from this container (research.google.com is blocked by its proxy); third-party copies mention remote desktops/SSH. CHE acts only when the owner asks and is present, never on a schedule, and never clicks to keep a runtime alive. **Open question for the owner:** read the FAQ's "restricted activities" list to confirm that CHE's queue worker (the notebook's last cell) is allowed on a free runtime. | [Colab FAQ](https://research.google.com/colaboratory/faq.html) (via search snippets) |
| Drive in an embedded webview | `drive.mount` opens a Google window, but `webview_flutter` on iOS does not open new windows. The notebook now continues without Drive after `timeout_ms` (two minutes). CHE's queue keeps jobs, checkpoints and uploaded pictures either way. | `google.colab.drive.mount(…, timeout_ms=120000)` |

## What is automated, and what needs the owner

| Step | CHE | Owner |
|---|---|---|
| Open the notebook with the CHE Office account | Yes | — |
| Google sign-in, 2-step verification, CAPTCHA, account choice | Opens the exact page, explains, waits, resumes | Signs in or chooses |
| "Not authored by Google" warning, Drive access, runtime type | Brings him to it | Confirms |
| Run all / Connect | Tries (best effort) | Once, only if CHE could not |
| Heartbeat, test job, opening the output | Yes | — |
| Safari fallback (Google refused sign-in inside CHE) | Opens Safari, then verifies from the Worker | Runs the notebook in Safari, says "continue" |

## Tests

- **Flutter:** `test/che_gpu_connect_test.dart` (12 tests), with a fake browser and a fake Worker. It covers:
  - the right account;
  - the wrong account, switched through Google's chooser;
  - a wrong account that stays wrong (CHE stops);
  - sign-in required (pause, then "continue");
  - Google's refusal leading to the Safari fallback;
  - the "not authored" warning handed to the owner;
  - a connected runtime without a heartbeat (never "connected");
  - a fresh heartbeat, then connected, then the test job opened;
  - disconnection (jobs-kept banner, no speech);
  - permission enforced;
  - the VoiceOver lines;
  - the GPU Browser's voice routes.
- **Worker:**
  - `server/cloudflare/gpu_connect.test.mjs` (3 tests): the 90 s freshness of `GET /api/gpu`; the test job is
    GPU-only and goes first; a disconnect keeps the checkpoints and the job resumes.
  - `command_center.test.mjs`: "Connect GPU" reaches `/cloud-gpu` (connect) with no model.

## Not verified (needs the owner's iPhone and Google account)

Nothing here ran against real Google or Colab. Still to confirm on the iPhone:
- whether Google allows sign-in inside CHE's WKWebView or shows its refusal page (and so the Safari fallback);
- whether `authuser=<email>` selects the CHE Office account in Colab;
- whether the probe's selectors still match Colab's current page:
  - the account button;
  - the `colab-connect-button`;
  - dialogs;
  - outputs, which may sit in cross-origin iframes CHE cannot read (check 2 then rests on the worker's GPU report);
- whether any of the three Run all strategies works on Colab's iPhone page;
- whether `drive.mount` raises after its timeout inside the WebView, so the notebook continues;
- a real heartbeat and test job end to end, and how long the first run takes (Blender is downloaded into the
  session).

Colab availability is never promised. Google can end a runtime at any time, and CHE's jobs then resume from their
checkpoints.
