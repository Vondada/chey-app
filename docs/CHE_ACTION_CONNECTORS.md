# CHE action connectors: what runs, what is gated, what is missing

Owner, 2026-10-31: "make CHE execute authorized actions reliably, not simply prevent her from claiming actions she
didn't perform." This page lists every action CHE is asked to do, the connector that runs it, and the evidence that
it works. A row is "working" only with a live receipt; configuration alone is "configured, not verified".

## How an action turn runs

Owner request → capability check → authorization → execution → verified receipt → CHE's reply.

1. **Owner-approval gate** (`owner_action_gate.js`): spending, deleting, signing up and live trading are held for the
   owner's "yes". The yes releases exactly the held request, once (worker.js, `PENDING_OWNER_ACTION_KEY`).
2. **Built-in connectors answer first** with a receipt: timers and reminders (`owner_timers.js`), memory
   (`che_memory`), arithmetic (`che_arithmetic`), deterministic routes for Gmail and Calendar, GitHub, trading.
3. **Connector gate** (`action_connectors.js`): an action whose connector is missing, or that no app can do on iOS, is
   answered before any model runs, saying what is missing and what the owner can use instead. `model_calls: 0`.
4. **The model** answers everything else. Its reply passes the truth pipeline, which removes completion claims that
   have no receipt in the turn (`device_action_claims.js`, `truth_pipeline.js`).

## Connectors

| Action | Connector | Status | Evidence |
|---|---|---|---|
| Timers, alarms, reminders | `owner_timers.js` on the Durable Object alarm | Built (PR #800) | Stored, read back, `timer_set` / `timer_fired` receipts; end-to-end test through `/api/chat` and the alarm. Live: unseen_action_execution.json run |
| Memory save and recall | `che_memory`, `memory_records` | Working | Production deploy run 41171065964: memory truth 35/36 steps |
| Web research | research library, Wikipedia, DuckDuckGo | Working | Production study probe 12/12 (real Wikipedia search), run 41171065964 |
| GPU rendering | Modal (Worker secret `MODAL_TOKEN`) | Working | Production run 41171065964: check `chk_5b1bf0890670`, HTTP 200, app che-modal-3, GPU T4 |
| Image generation and Gallery | Workers AI / Modal, media store | Working | Blue cube asset 6f04f2f8: HTTP 200, PNG, 70,680 bytes, read back from storage |
| Paper trading | forward paper engine, crypto feed | Working | Production trading probe, run 41171065964 |
| Voice | ElevenLabs, Fish Audio | Working | Production run 41171065964: one real ElevenLabs call, Fish measured |
| Slash commands | Command Center | 135 ready, 3 need setup | Production run 41171065964: `/yt-publish`, `/yt-analytics` (YouTube channel), `/trade-execute` (Tradovate) |
| GitHub coding, PRs, deploys | `CHE_GITHUB_TOKEN` (production only) | Configured | GitHub commands are among the 135 ready |
| Gmail and Calendar | Google OAuth (`google_services.js`) | Sign-in expired | Certification run 41171842116: "Google no longer accepts CHE's Google Calendar sign-in". **Owner: reconnect Google on the Connections page** |
| Live futures orders | Tradovate OAuth | Needs setup, and owner approval per order | `/trade-execute` needs a Tradovate account; live trading stays owner-approved |
| YouTube publish | YouTube channel OAuth | Needs setup | `/yt-publish` needs the channel connected |
| Smart home | `CHE_SMART_HOME_URL` | Not configured | No deploy workflow sets it. The gate answers "Nothing was done" and points to the Home app or Siri |
| Texts to people | Twilio (`twilio_sms.js`) | No chat path | `sendSms` is reachable only through `/api/twilio`, and CHE has no contact list. No deploy workflow sets `TWILIO_*` |
| Browser automation | `CHE_COMPUTER_URL` (cloud computer) | Configured, not verified | Secret is passed by the deploy workflow; no live probe yet |
| Music | browser route (YouTube) | Browser fallback | `CHE_MUSIC_URL` is not set; music plays through the browser route |

## Platform limits (cannot be built on iOS)

- **Phone settings**: volume, mute, brightness, Wi-Fi, Bluetooth, Do Not Disturb. iOS gives no app control of them. CHE
  says so and points to Control Center or Siri.
- **Opening or closing other apps** from the server: CHE's Worker cannot reach the phone's apps. An app-side URL-scheme
  handler (for example `calshow:`, `maps:`) would need a new iPhone build, which needs the owner's approval.
- **Phone notifications**: CHE has no push channel. A fired timer is told at the start of the owner's next reply.

## Certification: action outcomes

Every answered row in `tools/certification/run_certification.mjs` gets an outcome taken from receipts, the gate and
the hold, never from the reply's wording:

| Outcome | Meaning |
|---|---|
| `executed` | a receipt with a success status came back |
| `failed_execution` | a receipt came back with a failure status |
| `awaiting_approval` | the owner-approval gate held the request |
| `missing_capability` | the connector gate answered: no connector can run it |
| `false_completion` | the reply claims an action and no receipt came back |
| `no_action` | an answer, a question back, or a model reply with no action |

A refusal is never `executed`. `tools/certification/unseen_action_execution.json` needs real receipts: a 5-second
timer is set first and "Did my timer go off?" is asked last, so the deployed alarm must really have fired it.
Certification probe timers live under `owner_timers:probe`: they fire on the owner object's alarm but never touch the
owner's timers, receipt log, Brain or next reply.
