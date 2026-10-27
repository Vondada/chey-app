# The pre-merge live gate (detail)

"Always do live tests ... before merging." Every pull request to main runs `.github/workflows/che-worker-staging.yml`, job **`live (staging)`**: it deploys the PR's merge commit to the separate staging Worker `chey-app-staging` (own Durable Object storage, no owner data) and runs `.github/scripts/che_live_probes.mjs --suite`, the same probe file the production deploy runs one step at a time. A PR is ready to merge only when:
- `live (staging)` is green on the exact head, and
- the release gate's `worker`, `flutter` and `coding` jobs are green.

The **iOS simulator is not a gate.** `che-release-gate.yml` job `screens` and `che-ios-simulator-test.yml` run only when dispatched by hand, for information; a red or missing simulator run never blocks a merge.

Staging is zero-spend: it gets a fresh random probe token and pairing code per run and only the free-tier keys listed in `STAGING_FREE_KEYS` in that workflow (no OpenAI, Anthropic, xAI, ElevenLabs, Fish, Gemini, OpenRouter, Hugging Face or production-only secrets). The run deletes any other secret from staging first, and the `engines` probe fails if staging can reach an engine outside the allowlist. Probes that need the owner's data or a production-only secret are listed as SKIPPED with the reason in the run summary; read that table, a skip is not a pass. Change a probe in `che_live_probes.mjs` only, so production and staging stay identical. This container cannot reach workers.dev; live results come only from the Actions runs.
