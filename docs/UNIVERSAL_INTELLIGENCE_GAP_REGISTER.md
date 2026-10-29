# Universal Intelligence: integration gap register

Status as of 2026-10-28 (Claude). Each row is backed by evidence from GitHub, the code on `origin/main`, or a CI log. A row marked "not verified" has no receipt yet. This register reports the state of the integration, not the plan.

## Existing systems the controller must reuse

| System | Where | State |
|---|---|---|
| Capability registry (promotion gate, serving, use records) | `server/cloudflare/capability_registry.js` on main | Exists. Reused by PR #742. |
| Capability router and engine | `capability_router.js`, `capability_engine.js` on main | Exists. Not yet linked to any math route. |
| Exact arithmetic + chat route | PR #737 `server/cloudflare/arithmetic.js`, wired in `worker.js` as `che_arithmetic` before the privacy gate | Unmerged. Its chat tests run the real `/api/chat`, with 24 exact problems and 0 model calls. |
| Numeric truth check | `numeric_truth.js` on main, uses `checkEquations` from #737 | Depends on #737. |

## The ten items

| # | Item | Status | Evidence | Next dependency |
|---|---|---|---|---|
| 1 | Wikipedia 503 on staging | **Blocked by an external outage, not fixed.** PR #738 adds a bounded retry (`wikiFetch`, 2 retries, Retry-After capped at 10 s). The retry is in place and its tests pass. The live check still gets 503 on every pass. | #738 `live (staging)` run 40627686798: six passes, all 503. #737 run 40623541767 and #736 run 40621739146: same study failure. The sandbox cannot reach Wikipedia (curl 000), so the outage cannot be confirmed from here. | Owner decision: keep the gate red until Wikipedia answers, or mark the study check as "upstream unavailable" so it is reported, not counted as a code failure. Do not hide it. |
| 2 | Check dependencies, conflicts, required CI for #736–#742 | Done (see the PR table below). | GitHub check runs read at 04:00 UTC. | Resolve the study gate (row 1). |
| 3 | Merge eligible green PRs | **Nothing merged in this step.** #740 is green on every check except `live (staging)`, which was still in progress. #736, #737 and #738 fail `live (staging)`. #742 has `live (staging)` in progress. | See the PR table. | Owner decision (row 1). |
| 4 | Connect the controller to chat routing | **Not done, and deliberately not done as a second engine.** PR #737 already routes plain arithmetic through `plainArithmetic` in `/api/chat`. PR #742 has its own parser. | `git show origin/main` does not contain math routing. #737 `worker.js` diff adds the `che_arithmetic` route. | Reconcile #742 onto `arithmetic.js`. Keep #742's receipt, classify and `needs_model` framing, and drop its duplicate parser. |
| 5 | Spoken or typed math reaches the controller with a receipt | **Typed route exists on #737** (answer, `source: che_arithmetic`, `model_calls: 0`). **No receipt yet**, and the path is not run on the deployed Worker. Spoken input is not verified. | #737 `chat_relevance.test.mjs` covers "what is 12 times 17" through the real route, not through the phone. | Add the receipt to the chat reply. Deploy to staging after #737 merges. Test spoken input on the iPhone (not verified: no device in this sandbox). |
| 6 | Fallback for unsupported problems | **Exists.** `needs_model` (controller) and "route does not match, falls through to the model" (chat). No invented answers. | `problem_controller.test.mjs` "goals without a verified deterministic path" (9/9 passing locally). | Confirm on the deployed route once #737 merges. |
| 7 | On-device model for offline reasoning | **Not started.** PR #741 is an audit of what runs on the iPhone today. It is not a model integration. The Offline Brain is not complete. | `docs/` audit on #741 only. | Research a model that runs on the iPhone (size, licence, speed) and prove it with the network blocked. |
| 8 | Connect to Continuity Loop, skill memory, Efficiency Monitor | **Not started.** PR #740 (continuity loop) is green and not merged. No code connects the controller to it. | `feat/che-continuity-loop` head c8acf7f, checks green. | Wire the receipt into the continuity record after #740 merges. |
| 9 | End-to-end tests: Flutter UI and deployed Worker | **Not done.** Tests run on the Worker and in CI. No device test. | CI `worker` and `flutter` checks pass on #740 and #742. | Needs a deploy and the owner's iPhone. |
| 10 | Update this register | Done. This file. | This commit. | Refresh after each merge. |

## PR table (checked 2026-10-28, 04:00 UTC)

| PR | Head | Checks | Mergeable | Blocker |
|---|---|---|---|---|
| #736 Chat reliability | `30c68a17` | worker ✓, flutter ✓, analyze ✓, coding ✓; **live (staging) ✗** (social Test 5 and the study 503) | not verified | Gate: the study 503 and a social Test 5 wording flake |
| #737 Arithmetic and chat relevance | `da353443` | worker ✓, flutter ✓, analyze ✓; **live (staging) ✗** (study 503 only) | not verified | Gate: study 503 (row 1) |
| #738 Wikipedia retry | `ad616d21` | worker ✓, flutter ✓, analyze ✓, coding ✓; **live (staging) ✗** (study 503 on all six passes) | not verified | Gate: study 503 (row 1) |
| #739 Video review workflow | `7b82db5d` | worker ✓, flutter ✓, analyze ✓; live (staging) in progress at the time of checking | not verified | Gate: pending |
| #740 Continuity loop | `c8acf7fe` | worker ✓, flutter ✓, analyze ✓, coding ✓, Visual Studio renders ✓; live (staging) in progress | not verified | Owner merge decision |
| #741 Offline Brain audit | `0cc69af2` | pending at time of checking | not verified | Not reviewed |
| #742 Universal controller (this branch) | `c7c8dada` | worker ✓, flutter ✓, analyze ✓; live (staging) in progress | not verified | Reconcile with #737 (row 4) |

Dependency order: #737 (arithmetic) → #742 (controller on top of `arithmetic.js`) → #740 (continuity hooks). #738 and #739 are independent of the math route.

## Not verified

- Nothing has been run on the iPhone, including spoken input and the car Bluetooth route.
- No deployed Worker receipt exists for the controller. Staging is red for the study check, so a staging deploy is not claimed.
- Wikipedia's current status is unknown from this sandbox. The 503 is only seen in CI.
