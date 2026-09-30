# Codemagic Shorebird (free tier)

Use this while GitHub Actions is blocked by billing. Personal Codemagic accounts get **500 macOS M2 minutes/month**. Team accounts do **not** get free minutes.

## Codemagic dashboard (one-time)

1. Sign in at [codemagic.io](https://codemagic.io) with a **personal** account.
2. **Add application** → GitHub → install the [Codemagic GitHub App](https://github.com/apps/codemagic-ci-cd) on **Vondada** → select **chey-app**.
3. Open the app → **Environment variables** → create group **`che_ship`**:
   - `SHOREBIRD_TOKEN` — mark **Secret** (Shorebird Console API key)
   - `CHE_AGENT_URL` — optional Worker URL for `--dart-define`
4. Confirm the app uses **codemagic.yaml** from the repo root.
5. Enable the GitHub **webhook** (automatic builds) so pushes to `main` run workflows with `triggering`.
6. **Start new build** anytime → pick workflow **`chey-shorebird`** (analyze + Shorebird + IPA) or **`chey-mobile`** (IPA only).
7. For a new Shorebird **release** base IPA: Start build → override / set `CM_SHOREBIRD_MODE=release` (default is `patch`).

## What each step does

| Step | Meaning |
|------|---------|
| Flutter analyze | Static checks before shipping |
| Shorebird patch | OTA Dart update for phones already on a Shorebird release |
| Unsigned IPA | SideStore install; also needed after native/asset changes |

## Fix GitHub Actions billing (restore free 2,000 minutes)

Not a Pro upgrade. Free already includes 2,000 hosted Actions minutes/month for private repos.

1. Open [github.com/settings/billing](https://github.com/settings/billing) for the account that owns `Vondada/chey-app` (org: org **Billing & Licensing**).
2. **Payment information** — fix or replace any failed/expired card; clear past-due balance.
3. **Budgets and alerts** — find an Actions budget with **Stop usage when budget limit is reached**. Raise it, turn stop off, or delete a $0/exhausted budget.
4. If **Spending limits** for Actions exists, set a limit **above $0** (even $1) so included free minutes can run. Bump by $1 and save again if jobs still die at 0 steps.
5. Re-run workflow **CHE Shorebird** after the gate clears.
