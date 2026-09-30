> **Auto-deploy:** Cloudflare Workers Builds is connected to this repo (root
> `server/cloudflare`, branch `main`, `npx wrangler deploy`). Every push to
> `main` redeploys the Worker. Do not put `[skip ci]` in a commit that must
> deploy: Workers Builds honors it and skips.

# Cloudflare Worker deploy checklist

Last verified **2026-09-29** (America/Chicago). Do not put secret values in Flutter, git, or this file.

## Current readiness: YES (prod live)

| Check | Result |
|---|---|
| Account ID | `c49b395e8f1138b5fae36ab88222542c` (Henryjavoni@gmail.com's Account) |
| Worker name | `chey-app` |
| Prod URL | https://chey-app.henryjavoni.workers.dev |
| `/health` | `{"ok":true,"agent":"CHE cloud"}` HTTP 200 |
| Deploy | `npx wrangler deploy` from `server/cloudflare` after PR #47 merge to `main` |
| Node | Use Node **22+** (`/home/box/.local/node/bin` on this box). Wrangler refuses Node 20. |

Token: set `CLOUDFLARE_API_TOKEN` in the environment (never commit). Optional: `CLOUDFLARE_ACCOUNT_ID` as above.

## Commands

```bash
cd server/cloudflare
npm ci
npm test
export CLOUDFLARE_API_TOKEN='<token>'
export CLOUDFLARE_ACCOUNT_ID='c49b395e8f1138b5fae36ab88222542c'
npx wrangler whoami
npx wrangler deploy
curl -sS https://chey-app.henryjavoni.workers.dev/health
npx wrangler secret list   # names only
```

`wrangler.jsonc`: name `chey-app`, main `worker.js`, compatibility `2026-09-01`, cron `7 7 * * *`, AI binding `AI`, Durable Object `CHE_STATE` / `CheState` (SQLite).

## Secrets (names only — production)

Present on Worker (do not print values):

- `CHE_PAIR_CODE`
- `GROQ_API_KEY`
- `GEMINI_API_KEY`
- `CEREBRAS_API_KEY`

Optional / not set yet (owner):

```bash
# npx wrangler secret put XAI_API_KEY
# npx wrangler secret put CHE_GITHUB_TOKEN
# printf '%s' 'Vondada/chey-app' | npx wrangler secret put CHE_GITHUB_REPO
```

Stripe (CHE) — names only; see `docs/STRIPE_CHE.md` (owner confirmed connect):

```bash
# npx wrangler secret put STRIPE_SECRET_KEY
# npx wrangler secret put STRIPE_PUBLISHABLE_KEY
# npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

Webhook: `https://chey-app.henryjavoni.workers.dev/api/stripe/webhook` (`charge.succeeded`, `charge.refunded`).

Twilio SMS (CHE) — names only; see `docs/TWILIO_CHE.md`:

```bash
# npx wrangler secret put TWILIO_ACCOUNT_SID
# npx wrangler secret put TWILIO_AUTH_TOKEN
# npx wrangler secret put TWILIO_FROM_NUMBER
# optional: npx wrangler secret put TWILIO_MESSAGING_SERVICE_SID
```

Inbound webhook: `https://chey-app.henryjavoni.workers.dev/api/twilio/sms/inbound`


Local `.dev.vars` is gitignored. Pair body field is `code` (`POST /api/pair`).
