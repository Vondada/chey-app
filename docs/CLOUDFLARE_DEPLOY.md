# Cloudflare Worker deploy checklist

Verified locally on 2026-09-29 (America/Chicago). Do not put secret values in Flutter, git, or this file.

## Current readiness: NO

`CLOUDFLARE_API_TOKEN` is set in the environment (value not recorded here). Checks:

| Check | Result |
|---|---|
| `GET /user/tokens/verify` | success, status `active` |
| `GET /accounts` | success, `total_count` 0 |
| `GET /zones` | success, 0 zones |
| `GET /user` | 403, error 9109 (unauthorized) |
| `GET /memberships` | 403, error 10000 (authentication error) |
| `npx wrangler whoami` (Node 22.20.0, wrangler 4.144.0) | failed: cannot retrieve account IDs; token permissions or auth are insufficient |
| `account_id` in `wrangler.jsonc` or the repo | not present |

The token is active but cannot see an account, so `wrangler deploy` cannot run. Do not invent an account id. Create a new API token (or edit this one) with at least:

- Account → Workers Scripts → Edit
- Account → Account Settings → Read (so Wrangler can list the account)
- Account → Workers Durable Objects / Workers KV / AI as needed for the bindings in `wrangler.jsonc` (`AI`, `CHE_STATE` Durable Object with SQLite)

Then set `CLOUDFLARE_ACCOUNT_ID` from the dashboard URL (`https://dash.cloudflare.com/<ACCOUNT_ID>`) or from a successful `wrangler whoami`.

## Commands (after a usable token)

Host Node must be **22 or newer**. This box's default `node` is 20.19.2; Wrangler refuses to start on it. Tests (`npm test`) run on Node 20.

```bash
cd server/cloudflare
npm install
npm test
npm run check

export CLOUDFLARE_API_TOKEN='<token with Workers edit + account read>'
export CLOUDFLARE_ACCOUNT_ID='<account id from the dashboard>'
npx wrangler whoami
npx wrangler deploy
```

`wrangler.jsonc` name is `chey-app`, main `worker.js`, compatibility date `2026-09-01`, cron `7 7 * * *`, AI binding `AI`, Durable Object `CHE_STATE` / class `CheState` (SQLite). No separate D1 database id.

Optional explicit account (only after you know the real id):

```jsonc
"account_id": "<CLOUDFLARE_ACCOUNT_ID>"
```

## Secrets to set (names only)

Local dev reads `server/cloudflare/.dev.vars` (gitignored). Production uses `wrangler secret put`. Never commit values.

Required for pairing (6–12 digits). Pair body field is `code` (`POST /api/pair`):

```bash
npx wrangler secret put CHE_PAIR_CODE
```

AI / Office. Atlas, Mira, Lyra, and Iris prefer xAI. Without one of `XAI_API_KEY`, `CHE_XAI_API_KEY`, `GROK_API_KEY`, or `CHE_XAI_MODEL_URL`, their jobs stay blocked: `Blocked: tool not configured (Grok)`. Nova/Knox need Codex/OpenAI (`CODEX_OWNER_TOKEN` or `CHE_OPENAI_API_KEY` or `OPENAI_API_KEY`). Sage needs Stripe, which must not be set until the owner confirms charges.

```bash
npx wrangler secret put XAI_API_KEY
# optional fallbacks, one secret per command:
# npx wrangler secret put CHE_OPENAI_API_KEY
# npx wrangler secret put GROQ_API_KEY
# npx wrangler secret put GEMINI_API_KEY
```

Self-update opens a **draft PR only** (no auto-merge). Needs a repo-scoped token:

```bash
npx wrangler secret put CHE_GITHUB_TOKEN
printf '%s' 'Vondada/chey-app' | npx wrangler secret put CHE_GITHUB_REPO
```

Do **not** set `STRIPE_SECRET_KEY` or `STRIPE_WEBHOOK_SECRET` until the owner confirms Stripe.

## Local smoke (already used on this machine)

```bash
cd server/cloudflare
npm run dev
# http://127.0.0.1:8787
# GET /health                         -> 200 {"ok":true,"agent":"CHE cloud"}
# POST /api/pair  {"code":"<CHE_PAIR_CODE>","device_name":"local"}
# GET /api/state  Authorization: Bearer <device_token>
```

`.dev.vars` key names present at last check: `CHE_PAIR_CODE` only.

## Live (2026-09-29)
- Account ID: `c49b395e8f1138b5fae36ab88222542c`
- Worker URL: https://chey-app.henryjavoni.workers.dev
- Version: a403d2e3-3735-4eea-82ec-c46bf337e917
