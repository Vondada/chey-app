---
name: che-release
description: Verify and ship CHE. Covers PR checks, merging, the Cloudflare Worker deploy, the live production commit, the deploy's live probes, Shorebird patches and iPhone IPA releases. Use when asked whether a change is merged, deployed, live, released or installable; before merging or deploying; and after a merge to prove production is running it. Status comes from a read-only script. Every consequential action (merge, deploy, patch, IPA build, public release, YouTube publish) needs the owner's explicit authorization in the current conversation.
---

# CHE release

## Status: one read-only command
```
node .claude/skills/che-release/scripts/release_status.mjs [--pr N | --sha SHA] [--installed VERSION+BUILD] [--json]
```
It reports:
- the PR state and merge SHA;
- the checks on the head (`Workers Builds: chey-app` is non-gating);
- the main head;
- the Worker deploy run for the target commit, with what it verified live (the live commit, the memory probe, the voice probe);
- the Shorebird and IPA runs;
- the newest published IPA, with its sha256;
- whether `/health` is reachable from here;
- with `--installed` (the version+build the owner's CHE Updates screen shows): whether that phone is behind, on or ahead of the newest published IPA. In chat, CHE answers the same from the phone's own report (`self_update.js` `appStatusReport`).

**UNKNOWN means not verified.** Never report it as success. The iPhone is never verifiable from here.

## Authorization gate

| Action | How | Requires |
|---|---|---|
| Merge a PR | Squash with `expectedHeadSha` = the head that passed | The owner said "merge" or "merge when green" for this PR or mission; checks GREEN; every review thread answered or fixed |
| Worker deploy | `[worker-deploy]` in the squash title when `server/cloudflare/` changed | Covered by the merge authorization. Never deploy from a branch. |
| Shorebird patch | Automatic on merge when `lib/**` changed. Dispatch `che-shorebird.yml` by hand (`release_version` for an older installed build). | Owner authorization for a manual dispatch |
| IPA build | `[ios-build]` in the title, or dispatch `che-iphone-ipa.yml` | Only when native/iOS changes need it, with owner authorization |
| Public IPA release | `che-ipa-release.yml` | Owner authorization |
| YouTube publish, payments, deleting | — | The owner's direct yes, every time (AGENTS.md) |

## Merge and verify
1. Run `release_status.mjs --pr N` and confirm checks are `GREEN` on the exact head.
2. Read the review threads. Codex P1/P2 and red-circle findings are bug reports: fix them or answer them.
3. Squash merge with `expectedHeadSha`. Add `[worker-deploy]` when the Worker changed.
4. Merge `origin/main` back into the work branch. Force-push is denied here.
5. Run `release_status.mjs --sha <merge sha>` until the deploy completes. Report the `live commit check: VERIFIED …` line and the memory-probe result. If the deploy failed, say so and fix it.
6. Update `mailbox/briefs/LIVE-HANDOFF.md` §2 on `che-mailbox`, and append one line to `mailbox/claude.jsonl`.

## Never
- Never call something live from a green PR, or from a deploy that is still running.
- Never claim iPhone behavior without the owner's device evidence.
- Never re-run CI with an empty commit. Never skip or disable a test.
- Never print secrets. The script needs none, and an optional `GITHUB_TOKEN` is never printed.

## Lessons (append dated entries)
- **Agent A/B, 2026-10-14: same task, same code, with vs without this skill, one run each.** "Is #300 merged and live, and did the probes pass?" With: 55,888 tokens, 8 tool calls, 34 s. Without: 108,534 tokens, 21 tool calls, 124 s. Both were correct.
- **2026-10-14, measured with `tests/measure.mjs`.** Five raw GitHub API responses (436,533 bytes) vs `release_status.mjs` (839 bytes) for "is #300 merged and live?".
- **2026-10-14: workers.dev is blocked from the cloud dev sandbox.** Rely on the deploy's "Verify live deployed commit" step, which fails unless `/health` reports the merge commit. The script reads that step.
- **2026-10-14: reading a full deploy job log for the probe output cost about 25k tokens.** The deploy now also writes `::notice` annotations (titled "Live CHE commit", "Memory truth" and "CHE voice"), which the script reads in one small request.
- **2026-10-14: answering "is #300 merged and live?" from raw GitHub API JSON means 446,575 bytes across 7 endpoints.** The script prints the same answer in 843 bytes.
- **2026-10-14: Node's fetch ignores HTTPS_PROXY unless `NODE_USE_ENV_PROXY=1` is set.** The script re-runs itself with it.
