# Twilio SMS for CHE (trial-ready)

CHE is the **only** sender (`send_sms` / `send_sms_bulk`). Office specialists may draft message text into a pending bulk job; CHE sends after the owner confirms bulk. Never commit secret values.

## Secret names (Worker only)

| Secret | Purpose |
|---|---|
| `TWILIO_ACCOUNT_SID` | Twilio Account SID |
| `TWILIO_AUTH_TOKEN` | Twilio Auth Token (also used to validate inbound signatures) |
| `TWILIO_FROM_NUMBER` | E.164 trial From number (e.g. `+1…`) |
| `TWILIO_MESSAGING_SERVICE_SID` | Optional Messaging Service SID (alternative to From) |

Set on the Worker (from `server/cloudflare`, Node 22+):

```bash
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put TWILIO_FROM_NUMBER
# optional:
# npx wrangler secret put TWILIO_MESSAGING_SERVICE_SID
npx wrangler secret list   # names only — never print values
```

## Owner connect steps (trial)

1. Sign up at [twilio.com](https://www.twilio.com) and open the Console.
2. Copy **Account SID** and **Auth Token** (Dashboard).
3. Get a trial phone number (Phone Numbers → Manage → Buy a number / trial number). Copy it in E.164 (`+1…`) as `TWILIO_FROM_NUMBER`.
4. **Verify each recipient** you will text on trial (Phone Numbers → Verified Caller IDs). Trial allows about **5 verified numbers**, about **100 SMS**, for about **30 days**.
5. Put the three secrets on the Worker with `wrangler secret put` (above).
6. In Twilio Console → Phone Numbers → your number → Messaging webhook:
   - **A message comes in**: `POST`  
     `https://chey-app.henryjavoni.workers.dev/api/twilio/sms/inbound`
7. In CHE: Plugins → **Twilio SMS (CHE)** → Test connection (`GET /api/twilio/status`). Connected when secrets are present (values are never returned).

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/twilio/status` | Device Bearer | Connection status (no secret values) |
| `POST` | `/api/twilio/sms/send` | Device Bearer | `send_sms(to, body)` — CHE single send |
| `POST` | `/api/twilio/sms/bulk` | Device Bearer | Draft or send bulk; without `owner_approved: true` → pending |
| `POST` | `/api/twilio/sms/bulk/confirm` | Device Bearer | Confirm pending job with `owner_approved: true` |
| `POST` | `/api/twilio/sms/draft` | Device Bearer | Create pending bulk draft only |
| `POST` | `/api/twilio/sms/inbound` | Twilio signature | Inbound SMS → CHE queue / activity |

Alias inbound path: `/webhooks/twilio/sms` (same handler). Prefer documenting the `/api/twilio/sms/inbound` URL.

## Tools (CHE sending authority)

- **`send_sms(to, body)`** — POST Twilio Messages API; E.164 validation; trial-aware errors; blocks opted-out numbers; logs send.
- **`send_sms_bulk(numbers[], body)`** — one-to-one loop (not group MMS), ~1 msg/sec, per-number `{to, ok, sid?, error?}`. **Does not send** until `owner_approved === true` (creates pending draft otherwise). Language mirrors Fiverr/opportunity scout: **Outbound stays Owner decision: pending**.

Helpers may draft body text into a pending bulk job; only CHE executes after owner yes.

## Owner gate (bulk)

1. CHE (or a helper draft) creates a pending job with recipient count + sample text.
2. Activity / decisions show: CHE needs your decision on bulk SMS…
3. Owner confirms via API/action with `owner_approved: true` (or `/api/twilio/sms/bulk/confirm`).
4. Then CHE sends one-to-one with rate limiting.

Single `send_sms` may run when the owner asked CHE with clear intent; still logged.

## Consent / US A2P notes

- **Trial limits:** ~5 verified To numbers, ~100 SMS, ~30 days. Unverified To → honest trial error.
- **Paid path:** US A2P requires **10DLC** (local) or **toll-free** verification — not enabled by this trial ship.
- **STOP / HELP:** Inbound `STOP` (and STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT) marks the number opted-out and blocks future CHE sends. `HELP`/`INFO` returns a short ack. `START`/`YES`/`UNSTOP` clears opt-out when allowed.
- **Owner responsibility:** Only message **consented** recipients. CHE will not invent consent.

## Deferred

- Shorebird / phone IPA for Flutter Plugins UX: use Codemagic when GH/Shorebird billing blocks local release.
- Paid 10DLC / toll-free registration and Messaging Service production routing.
