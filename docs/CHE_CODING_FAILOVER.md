# CHE coding: free first, paid last ($15/month ceiling)

This updates the EXISTING `.github/workflows/che-opencode-runtime.yml`. It does not
introduce a new agent or billing system. No credit purchases or provider-account
changes are made by this repository change.

## Owner configuration (GitHub on an iPhone works)

1. Keep GitHub Actions variable `CHE_CODING_PAID_FALLBACK` **unset or false**.
   This is the safe default; nothing here authorizes spending.
2. Configure one `OPENROUTER_API_KEY` Actions secret for **free `:free` models**
   (or reuse the existing free-access key). The automatic runner never uses that
   secret for non-free OpenRouter models.
3. Optionally add independent provider secrets `GEMINI_API_KEY`, `GROQ_API_KEY`,
   `CEREBRAS_API_KEY`, `MISTRAL_API_KEY` (existing names), **only if that
   account is confirmed to be on a no-billing/free tier**. Add their provider
   names to the Actions variable `CHE_CODING_FREE_PROVIDERS`, e.g.
   `openrouter,google,groq,cerebras,mistral`. Default: `openrouter` only
   because a configured API key alone does not prove its account is free.
   Direct OpenAI and Anthropic accounts are intentionally not automatic paid
   fallbacks: a separate vendor bill would escape the OpenRouter ceiling.
4. **Only after explicit owner approval for spending:** create a separate
   OpenRouter inference key with **limit = 15 USD, limit_reset = monthly,
   include_byok_in_limit = true**. Use a dedicated OpenRouter account/workspace
   without separately-billed BYOK provider keys. Disable automatic credit
   top-ups in the account and avoid charging other services on it. Configure
   the spending limit BEFORE installing the key in GitHub.
5. Store that capped key as GitHub Actions secret
   `CHE_CODING_OPENROUTER_PAID_KEY`. Only when ready, set Actions variable
   `CHE_CODING_PAID_FALLBACK=true`. This is the separate approval-to-enable
   step, not part of this PR. Existing variable `CHE_ALLOW_PAID_MODELS`
   no longer turns paid usage on.
6. The runner reads `GET https://openrouter.ai/api/v1/key` before **each**
   paid attempt and refuses the request unless the server reports a
   $15-or-less MONTHLY key limit, BYOK counted against the cap, and >= $0.50
   remaining. A failed check, unavailable API, uncapped/oversized key, or
   disabled flag never sends a paid request.
7. To stop paid coding immediately, change `CHE_CODING_PAID_FALLBACK=false`
   and revoke/disable that dedicated key in OpenRouter. Changes to the
   repository or Flutter app alone don't enable credit spending.

GitHub pages:
- Actions secrets: https://github.com/Vondada/chey-app/settings/secrets/actions
- Actions variables: https://github.com/Vondada/chey-app/settings/variables/actions
- OpenRouter key management: https://openrouter.ai/settings/keys

## Model order and safe behavior

On `model=auto`, the runner discovers available verified-free models,
attempts them FIRST across providers, then (only if configured and approved)
tries an allowlisted, lower-cost model with the separate capped OpenRouter key:
`openrouter/qwen/qwen3-coder`, then `openrouter/deepseek/deepseek-chat`.
Paid OpenRouter models are never mixed into the free candidate list. Fatal
429/quota/context errors switch promptly. It reserves part of the 14-minute
session for the final paid fallback rather than burning all time on free retries.

**Limits remain real:** OpenRouter's key-level monthly cap protects only usage
through that key, not unrelated accounts, credits bought manually, taxes or
provider BYOK bills. Provider/model availability and rates can change.
Free-tier request and token limits still apply. A coding attempt with partial
edits stops for review rather than blindly stacking incompatible patches.
The next large-job improvement is persistent, independently validated
checkpoints across separate GitHub Actions sessions; this PR implements
**per-session** fallback, not infinite execution or cross-session resume.
Never claim a coding task completed until real source diffs, tests, review,
merge and production version are verified.

## Free-only acceptance

Run:
```bash
node --test tools/che_coding_paid_gate.test.mjs tools/che_coding_workflow_policy.test.mjs
```
These tests use dummy keys/models. They spend nothing and make no network calls.
The normal Flutter/Worker GitHub CI must also pass before this PR can merge.
