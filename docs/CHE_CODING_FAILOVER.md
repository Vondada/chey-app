# CHE coding: free first, paid last ($15/month ceiling)

This runs inside the existing `.github/workflows/che-opencode-runtime.yml`. It adds no
agent and no billing system. No credit is bought and no provider account is changed by
this repository.

## What CHE does on a coding job

1. Free models first: OpenRouter `:free` models, plus any other free provider the owner
   names in `CHE_CODING_FREE_PROVIDERS`.
2. Verified checkpoints: after a failed model that changed files, the change is kept only
   if it passes the path rules, stays under 300 KB and parses. The next model continues
   from it; anything else is reverted first.
3. Bounded resume: a session blocked by free capacity (quota, rate limit, timeout) resumes
   the same session after 15, 60 and 180 minutes, at most three times. Then CHE's own
   coding team takes over. Too-large and access failures are never resumed.
4. Paid last, only if all of this holds: the owner enabled it, the key is verified, and
   the BYOK rule below is satisfied. Paid models are never in the free list.

## Paid coding: what must be true

The capped key is `CHE_CODING_OPENROUTER_PAID_KEY`. Before every paid attempt the runner
reads OpenRouter's key status (`GET /api/v1/key`, no inference, no charge) and requires:

- a monthly limit of $15 or less, with `limit_reset` = `monthly`;
- at least $0.50 remaining;
- not a management or provisioning key;
- **BYOK ruled out**, which means one of:
  - `include_byok_in_limit` is `true` on the key, so BYOK spend counts against the cap; or
  - the owner has confirmed that this OpenRouter account has **no BYOK provider keys**
    (repository variable `CHE_CODING_OPENROUTER_NO_BYOK` = `true`), and the key's live
    `byok_usage_monthly` is zero. A non-zero value blocks paid use at once.

Why BYOK matters: BYOK routes send requests to a provider key the owner added to the
account. Those provider charges are billed by that provider, not by OpenRouter, so they
can fall outside the key's cap. With no BYOK provider keys on the account, no BYOK route
exists, and the setting is not needed.

If the key status cannot be read, or any requirement fails, paid use stays off.

## Owner steps (in order)

1. **Check the key status without spending.** Run the workflow `CHE coding paid-key cap
   check`. Its log prints the key's status fields and numbers (never the key). The
   limit, reset and balance should show as above.
2. **Rule BYOK in or out.** If the check blocks only on BYOK:
   - if the OpenRouter workspace this key belongs to has no BYOK provider keys, set the
     repository variable `CHE_CODING_OPENROUTER_NO_BYOK` to `true`; or
   - otherwise turn on "include BYOK in limit" for the key, if OpenRouter offers it.
3. **Enable paid use only when you approve spending.** Set the repository variable
   `CHE_CODING_PAID_FALLBACK` to `true`. Paid use stays off while it is unset or false.
4. Optional: set `CHE_CODING_FREE_PROVIDERS` only for providers whose accounts you have
   confirmed are free. The default is OpenRouter `:free` models only.

To stop paid coding at once, set `CHE_CODING_PAID_FALLBACK` to `false`, or disable the key
in OpenRouter.

## Safety of the runner

- The paid key is read once and removed from the shell's environment. Free-model agents
  never receive it, and only the gate and the paid attempt use it.
- The gate and the checkpoint verifier run from a trusted copy staged from the base commit
  before any attempt. Attempts cannot change them: `tools/che_coding_*`,
  `server/cloudflare/coding_failover.mjs` and `.opencode/` are refused as unsafe paths.
- Only an `implemented` session becomes a patch and a PR. A blocked session keeps only its
  verified checkpoint for a bounded resume; it is never delivered as a change.
- A resumed run is judged by GitHub's run state. A live run is waited for, never given up.
  A new owner mission is refused while a resumed run may still be live.
- `che-autopilot` uses only free OpenRouter models with the main key. Paid OpenRouter models
  are used only through the capped gate above.

## Limits that remain

- The cap protects only usage through the capped key. It does not cover credits spent
  elsewhere, taxes, or any BYOK provider bill that OpenRouter does not count.
- The BYOK confirmation is the owner's statement about the account. The runner verifies only
  the key's own status (zero BYOK spend this month). It cannot list the account's BYOK keys.
- Free-tier limits still apply, and provider availability changes.
- A live resume on GitHub Actions is verified only by the offline runner tests here until a
  real session runs.
- Syntax checks are not tests. Tests and review still run on the final change.

## Tests (offline, no network, no spend)

```bash
node --test tools/che_coding_paid_gate.test.mjs tools/che_coding_checkpoint.test.mjs \
  tools/che_coding_failover_loop.test.mjs tools/che_coding_workflow_policy.test.mjs
node --test server/cloudflare/coding_failover.test.mjs server/cloudflare/coding_resume.test.mjs \
  server/cloudflare/edit_anchor_recovery.test.mjs
```

GitHub pages:
- Actions secrets: https://github.com/Vondada/chey-app/settings/secrets/actions
- Actions variables: https://github.com/Vondada/chey-app/settings/variables/actions
- OpenRouter key management: https://openrouter.ai/settings/keys
