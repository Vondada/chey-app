# Stripe for CHE (Worker secrets + Plugins)

CHE sells only after **owner approval** (Studio store proposals / pipeline invoice). Sage reads sales. No refunds, transfers, or payouts in CHE code. Never commit secret values.

## Secret names (Worker only)

| Secret | Purpose |
|---|---|
| `STRIPE_SECRET_KEY` | Secret or restricted key (`sk_` / `rk_`) — Products/Prices/Payment Links write; Charges/Balance/Checkout read |
| `STRIPE_PUBLISHABLE_KEY` | Publishable key (`pk_`) — safe for paired client / Stripe.js; still stored as a Worker secret |
| `STRIPE_WEBHOOK_SECRET` | Webhook signing secret (`whsec_`) from Stripe Dashboard |

Set on the Worker (from `server/cloudflare`, Node 22+):

```bash
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_PUBLISHABLE_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret list   # names only — never print values
```

## Owner connect steps

1. Open [Stripe Dashboard](https://dashboard.stripe.com) (use **Test mode** first if you are verifying).
2. Developers → API keys → copy **Publishable key** (`pk_…`) and **Secret key** (`sk_…` or restricted `rk_…`).
3. Put them on the Worker with `wrangler secret put` (above), or follow Plugins → **Stripe (CHE)** → **Paste keys**.
4. Developers → Webhooks → **Add endpoint**:
   - **Endpoint URL:** `https://chey-app.henryjavoni.workers.dev/api/stripe/webhook`
   - **Events:** `charge.succeeded`, `charge.refunded`
5. Open the endpoint → **Signing secret** → Reveal → copy `whsec_…` → `npx wrangler secret put STRIPE_WEBHOOK_SECRET`.
6. In CHE: Plugins → **Stripe (CHE)** → Test connection (`GET /api/stripe/status`). Connected when the secret key is present (values are never returned except publishable `pk_` for client use).

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/stripe/status` | Device Bearer | Connection status (`missing_secrets` names only; `pk_` when set) |
| `GET`/`POST` | `/api/stripe/proposals` | Device Bearer | List / propose products (pending until approve) |
| `POST` | `/api/stripe/proposals/:id/approve` | Device Bearer | Create product + payment link (`confirmed: true`) |
| `POST` | `/api/stripe/proposals/:id/reject` | Device Bearer | Reject proposal |
| `GET` | `/api/stripe/sales` | Device Bearer | Charges + balance from Stripe API |
| `POST` | `/api/stripe/webhook` | Stripe signature | Office daily totals (`charge.succeeded` / `charge.refunded`) |

## Rules

- Nothing is created in Stripe until you approve in the app.
- CHE cannot refund, transfer, payout, or create direct charges.
- Office “earned today” uses webhook totals when present; otherwise Stripe API reads.
- Prefer a **restricted** secret key (not full `sk_live_`) with the least scopes needed.

## Deferred

- Customer Portal / subscriptions UI.
- Live-mode cutover checklist beyond Test mode verification.
