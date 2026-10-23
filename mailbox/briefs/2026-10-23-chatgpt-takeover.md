# ChatGPT / Codex takeover brief — 2026-10-23 ~12:00 UTC (from Claude)

Claude's session limit is nearly used. This brief is the exact position. Trust git and GitHub over this file: if something here is stale, git wins, fix this file and keep going.

Repo `Vondada/chey-app`. Read `AGENTS.md` on main first (owner rules always win), then `mailbox/briefs/LIVE-HANDOFF.md` §0–§1.

## Owner rules for this run (latest owner message, 2026-10-23)
- **Do not merge or deploy without the owner's approval.** Prepare focused PRs, get CI green, then ask.
- Never enable live-money orders. Broker order sending stays disabled in code (`lib/trading/che_live_order.dart` has no send path).
- Never fabricate results, candles, fills, memories, sources, commits or deploy confirmations. Say what was not verified (the iPhone always is not, from CI).
- Nothing runs on a schedule. Passwords never leave the on-device vault.
- Ask first only for money actions and deletions.
- Treat ChatGPT prompts as starting points: research, challenge weak ideas, build on existing code, verify (AGENTS.md permanent rule).

## Verified state (11:45 UTC)
- **main `83c2d67`** (#478 Rithmic live candles + forward recorder). Worker deploy run 39898570152: live commit check VERIFIED `83c2d67`. **Shorebird run 39898570143 success**: the iPhone patch now carries #478, #479 (86-style overnight lines) and #481 (side by side). #479's own Shorebird (39897175967) was cancelled, superseded by 83c2d67's.
- Merged today: #473 app/backend version retrieval (f37bc3a), #476 render test seed, #477 AGENTS.md R&D rule, #481 side by side + Live Order Preview (sending disabled), #479 86-style model (approximation, NOT the P2P indicator), #478 Rithmic chart.
- Do NOT rebuild #478/#479/#481.
- Status tool: `node .claude/skills/che-release/scripts/release_status.mjs --pr N` or `--sha SHA`.
- Gating checks: `analyze` (includes the full Flutter suite), `Worker syntax and unit tests`, `Visual Studio renders`. "Workers Builds: chey-app" fails on every PR and is NON-gating (Cloudflare preview); the real deploy is the post-merge workflow.

## Open work, in owner priority order

### 1. CHE repeats deployment status when asked to analyze a commit
- Branch **`claude/che-github-receipts`**, head `b0ed700` = ONE WIP commit, UNVERIFIED (session ended mid-check). No PR yet.
- Root cause (verified by replay): `appStatusIntent` in `server/cloudflare/self_update.js` (~line 682) matches any question with "commit"/"sha" plus "my/installed/deployed…", so "What changed in commit f37bc3ac, and what can I test on my iPhone?" gets the canned deployment status. No route analyzes a commit.
- The WIP adds `server/cloudflare/deploy_receipt.js` (+ test): commit summary, deploy run + Worker live SHA, backend-vs-iPhone split, evidence links, "unavailable" when evidence is missing. It also touches `self_update.js`, `worker.js`, `lib/self_update/*`, `lib/home_state/streaming.dart`, `test/che_app_status_test.dart`.
- Next: merge main in; run `node --test server/cloudflare/deploy_receipt.test.mjs server/cloudflare/worker.test.mjs`; replay with `.claude/skills/che-debug/scripts/replay_chat.mjs`, using the owner's exact sentence above (offline fake model); run `bash .claude/skills/che-debug/scripts/run_checks.sh`; open PR `[worker-deploy]`.
- CAUTION: two Dart tests pin the predicate order on `lib/home_state/streaming.dart:25` (`test/che_installed_skill_routing_test.dart:44`, `test/che_installed_skill_intent_test.dart:76`). Do not run `dart format` on the whole file.

### 2. Memory retrieval and source attribution ("What is my favorite drink, and where did you learn that?" → expected Sprite)
- Branch **`claude/che-recall-fix`**, head `c08d5b6` = ONE WIP commit, UNVERIFIED. The memory suites passed before the full run was cut off. No PR yet.
- Root cause (verified by replay): `server/cloudflare/personal_recall.js` only parsed the literal "my favorite X is Y". 6 of 9 phrasings failed: "I love Sprite", "Sprite is my favorite drink", multi-fact sentences. Provenance follow-ups ("where did you learn that?") had no answer. Recall of a stored fact (Blue Lantern) still went to the model, which invented "Falcon Nine".
- The WIP adds `server/cloudflare/owner_recall.js` (+ 226-line test) and widens `personal_recall.js`, `memory_provenance.js`, `knowledge_cache.js`, `worker.js`.
- Next: merge main in; run the memory suites (`memory_truth.test.mjs`, `personal_recall.test.mjs`, `owner_recall.test.mjs`), then run_checks.sh; replay the 9 phrasings, the provenance follow-up, and "What did I tell ChatGPT…" (that one was misrouted to status). Then open the PR.
- There is NO ChatGPT-history importer. OpenAI has no API for it; the route is the owner's data export (`conversations.json`). Do not claim retrieval from ChatGPT.

### 3. Verify the trading features work together
Unmerged lanes (each pushed; none merged):

| Branch | Head | State |
|---|---|---|
| `claude/che-trade-signals` = **PR #480** Signal Mode | `793d1b9` | `mergeable_state=dirty` (conflicts with main after #478); no checks on head. Last fix swapped icons to ones the installed build ships (release icon guard). Next: merge main, resolve, push, CI. |
| `claude/che-paper-account` | `9c6d5df` | $100 default paper account, positions, balance, wired into side by side. Was mid-rebase onto main when cut off; the branch is pushed as is. Next: merge main, run tests, PR. |
| `claude/che-strategy-library` | `5b814ac` | Includes a WIP commit (page, docs, seeds dump). Library API: `server/cloudflare/strategy_library.js`, `library_seeds/`, `lib/trading/che_strategy_dsl.dart`, `/trade-library`. Was fixing icons to the release icon guard. |
| `claude/che-p2p-86-seed` | `d2656f4` | Stacked on strategy-library; PR after library. |
| `claude/che-market-context` | `2854ca0` | Macro/event library (Fed, CPI, NFP, opex…). Already merged main + library. Was running the full suites before opening its PR. |
| `claude/che-strategy-research` | `2d223f8` | Includes a WIP commit. Its agent saw 9 failures that also fail on the library base branch, so they are not caused by this lane. Check whether main fails them too. |
| `claude/che-matrix-clarity` | `f6dfcd8` | ONE WIP commit. Matrix explanation, see below. |

Integration: side by side (#481) shows CHE paper "not set" until the paper-account branch lands. Watchlisted setups come from the journal until Signal Mode lands.

Matrix numbers (already explained to the owner): the number in a cell is total backtest trades ("n/30" when under 30). The word comes from `matrixState` in `server/cloudflare/trading_research.js`. Bug: fewer than 15 out-of-sample trades gives a null expectancy, treated as −1, so the cell shows "Weak" when it should be "Not enough data".

86 model: 0 MNQ trades and 1 NQ trade (−1.02R) on 49 sessions. Do not loosen the rules to manufacture trades.

### 4. Centralize Connections; remove duplicate CONNECT cards
NOT started by Claude. Research first: `rg -n "CONNECT|Connect " lib/rooms lib/screens lib/*connections*`. One Connections page should own every provider (Google, Rithmic, ElevenLabs, GitHub…); other rooms link to it instead of rendering their own connect card. Keep voice routes and VoiceOver labels.

### 5. What reached the Worker vs the iPhone
`release_status.mjs --sha <sha>` gives the deploy and the Shorebird run per merge. As of 83c2d67: everything merged is on both. A Shorebird patch cannot add native code or new icon glyphs (hence the icon guard test). Native changes need an IPA (`[ios-build]`).

### Also open
- **PR #475 Film Studio** (owner: "fix ASAP"). Cause: `filmIntent` treated "build the search **feature**" as a film order, so test B1 failed and CI went red. Claude merged main and removed "feature" from `FILM_WORD` and the make regex (Film tests 25/25), then pushed. Check the PR's CI, then ask the owner before merging.
- Uninvestigated: "publish: failure, runtime: failure" checks on 0049056.
- Agents the owner stopped (brain reliability, lag, Film, Hybrid, trading-visual): do not resume their branches without an owner request. Exception: #475, which the owner asked to fix.

## Exact iPhone tests (patch from 83c2d67; close and reopen CHE twice first)
1. Trading → Chart → MNQ: header shows source Rithmic, live status and last update; 1m/5m candles build from live data; delayed Yahoo is never labelled live.
2. Say "Open side by side": MY ACCOUNT and CHE PAPER ACCOUNT panes; the comparison shows "unknown", never 0, for missing values.
3. Say "Open the live order preview": LIVE ACCOUNT label; Approve asks Face ID; nothing is sent ("not supported yet").
4. Chart shows dashed overnight high/low lines, labelled "CHE approximation, not the P2P indicator".
5. Say "Disable the 86 model" / "Enable the 86 model": spoken result matches the Strategies screen.
After PRs 1–2 merge (not yet): "What is my favorite drink, and where did you learn that?" → Sprite plus where it was stored; "What changed in commit f37bc3ac, and what can I test on my iPhone?" → the commit's changes, not a status recital.
