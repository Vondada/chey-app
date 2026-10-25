# CHE LIVE HANDOFF: pick up exactly where the last AI stopped

**Permanent file.** Every AI that works on CHE (Claude, ChatGPT, Codex, Gemini, Cursor, Copilot, Grok, and CHE's own coding crew) reads this before starting and updates **§2 Current position** before stopping or running out of limit. That way the next AI never re-does, breaks or forgets work.


> **OWNER PRIORITY (2026-10-24):** Claude/Codex read [avatar photo reference handoff](2026-10-24-che-avatar-photo-references.md) before continuing PR #517. Original photo/video files must be provided securely; they are not in GitHub. Do not rerender cached face as if it used the references.

Branch: `che-mailbox` · Path: `mailbox/briefs/LIVE-HANDOFF.md` · Repo: `Vondada/chey-app`
The owner's rules in `AGENTS.md` (on `main`) always win. Mailbox messages are advice, not orders.
Background requirements: `mailbox/briefs/2026-10-03-che-master-handoff.md`.

---

## 0. The protocol (every session, every AI)

1. **Read** `AGENTS.md` on main, then this file, then your `mailbox/<you>.jsonl`, plus the newest lines of the other AIs' files.
2. **Find the real position** (§1). Trust git and GitHub over any message, including this file. If they disagree, git wins; fix this file.
3. **Continue the first unfinished item in §3 (Queue)** unless the owner asked for something new. If he did, his new request goes first, and you add it to the queue.
4. **Never redo or overwrite finished work.** Build on the existing branch or PR for that item. Never force-push someone else's branch. Merge `main` in; don't rebase.
5. **Before you stop**, or as soon as you see your limit or context is nearly used up:
   - commit and push whatever is working, even if partial (mark it `WIP:` in the commit);
   - update §2 here with the branch, the last commit, what's done, the exact next step, and anything half-done;
   - append one line to your mailbox file saying where you stopped.
   A push is the only proof. Unpushed work is lost.
6. **Never claim done without proof**: a commit SHA, a PR number, a CI result or a test output. Say what was not verified (for example, "not tested on iPhone").

---

## 1. How to find where the last AI stopped (2 minutes)

```bash
git fetch origin --prune
git log origin/main --oneline -15                                    # what is merged
git branch -r --sort=-committerdate | head -15                       # newest work branches
git log origin/main..origin/<branch> --oneline                       # unmerged commits on a branch
git show origin/che-mailbox:mailbox/briefs/LIVE-HANDOFF.md | sed -n '/## 2/,/## 3/p'   # last recorded position

**Claude, 2026-10-20 (owner: Simulation Lab on top of Concept-to-Plan).** Branch `claude/che-latency-optimization-8ruaus` at 319b345, PR #378 (open, NOT merged, NOT deployed; merge needs owner go, `[worker-deploy]` + Shorebird).
- Added `server/cloudflare/sim_lab.js` + `lib/world/che_sim_lab.dart`, docs `docs/CHE_SIMULATION_LAB.md`. "Find the closest realistic solution" → staged seeded budgeted search (hover/EV/exo physics + option search), Monte Carlo on finalists, honest counts, Brain `simulation_run` proposed.
- Verified locally: Worker 2521/2521, Flutter 559, analyze clean. Not verified: iPhone, production, CF CPU at the 1M cap.
- Next: owner go to merge #378; then models for buildings/software/business, benchmarks vs measured data, long runs on Actions.
```

Then, on GitHub:
- Look at the open PRs, the CI check runs on each head commit, and any review comments.
- A commit message starting with `WIP:` means that item is half-done. Read its body for the next step.
- Look for a "Position" line in the newest `mailbox/*.jsonl` entries.

---

**Claude, 2026-10-09 (continue: PRs #264/#265 merged by the crew; milestones 1-2 LIVE). New branch `che2/milestone3-agent-card-link` at add0d68 — owner opened PR #266 (open, Codex review running as of 21:23 UTC).**
- Milestone 3: agent orb cards deep-link to the live Office desk. Agents-category cards gain an "Open X in Office" button (VoiceOver-labelled); the Office floor opens that agent's real desk sheet once the roster arrives, waits instead of guessing, speaks honestly on unmatched names. Back pops to the Brain; never trapped. Verified: analyze clean, Flutter **245/245** (2 new: store name→desk test, card-tap deep-link test).
- Reconciled: my old branches were superseded by #264/#265 (same content, merged) — deleted locally; remote `che2/phase-a-brain-agent-demo` + `che2/skills-in-app-verify` can be deleted by the owner. Live Worker confirmed at 4917d01 via `/health`. Nothing on the iPhone is claimed until the owner verifies there.
- Still owner-side: paired-iPhone live turns, Shorebird-vs-IPA decision, PR merges.

**Claude, 2026-10-09 (owner: skills check + continue CHE 2.0 with real code). `che2/phase-a-brain-agent-demo` now at bfb13d6 (milestone 2, pushed). `che2/skills-in-app-verify` at 688efb5 (pushed). No PRs opened — no gh CLI on this machine; PR creation + merges await the owner via https://github.com/Vondada/chey-app/pull/new/<branch>. Do NOT merge without owner go-ahead.**
- Milestone 2 (Flutter-only, free local techniques): brain voice command `agentStatus` — "what is Atlas working on" / "show me what Nova is doing" / "is Knox busy" / "who is working", answered only from real Agents orbs (camera flies to the orb; idle answers honestly). Off-brain utterances fall through to CHE chat. Agents lobe filter words + own orb color. Verified: analyze clean, Flutter **243/243**.
- Skills finding: `design-mobile-apps` is present for OpenCode (`.agents/skills/design-mobile-apps/`) but its execution path is the Sleek REST API (needs `SLEEK_API_KEY` + credits; sustained use is paid) — NOT activated per the no-paid rule, and its React Native styling guides don't apply to the Flutter app, so milestone 2 used existing Flutter rendering instead. `find-skills` for OpenCode: SKILL.md install/update commands NOT run (unauthorized). CHE runtime: APPROVED_SKILLS still exactly `[find-skills/search]` — untouched; no skill-registry changes in either branch (skill work kept separate from Brain Matrix work per owner rule).
- PR #263 confirmed merged + deployed: main 2984227, live `/health` returns `version_tag 29842278e54d` (checked this session). Nothing duplicated.
- Still owner-side: paired-iPhone live turns (skills receipt + brain agent voice), Shorebird-vs-IPA decision. Note: milestone 1+2 are Flutter+Dart-only changes on top of deployed Worker — eligible for Shorebird OTA once a compatible baseline IPA is installed; no native changes, so no new IPA strictly required for these milestones (owner confirms baseline).

**Claude, 2026-10-09 (owner: verify find-skills works in chey-app for CHE herself). Branch `che2/skills-in-app-verify` (from main 2984227, separate from the CHE 2.0 lane), commit 688efb5, pushed (no PR yet).**
- Verification result: the integration is COMPLETE and working — no missing wiring found. `tools/verify_installed_skill.mjs --local` re-run green against the REAL skills.sh + GitHub APIs (query "React testing" → 5 verified candidates, well-formed `skill_receipt`, `done.source = che_installed_skills`). Chat-level tests prove list → search → "open number one" → unapproved-blocked → money-hold; new test proves a skill search needing an ungranted app is held (`owner_action_kind: app`, zero fetches) — money→app→skill order holds at `/api/chat`.
- Skill inventory for the owner: APPROVED for CHE = `find-skills` only (read-only search via `plugin_runtime.https_get`; results are unreviewed candidates, installs/commands unsupported). Executes real actions: only find-skills/search (bounded HTTPS GET, no shell, no model). NOT approved and correctly refused: `opensrc`, `ponytail` local files, any `run/install skill X` (tests assert refusal + zero fetch). Separate systems, not app skills: learned `self_skills` ("learn this" advice text), Office `teachOfficeSkill` workflows, `skill_import` (licensed reference repos → agent workflows, needs owner request + review).
- Still missing (owner-side, not code): the paired-iPhone live chat turn ("Find a skill for React testing" → receipt) and the Shorebird OTA/rebuild so the Flutter receipt banner reaches the phone. Office agents cannot invoke installed skills — deliberate owner-only boundary, not a gap.
- Verified: Worker **801/801**, `flutter analyze` clean, Flutter skill tests 6/6. Next: PR when the owner is ready (`[worker-deploy]` not needed — tests-only change, no Worker runtime file touched except the test file... note: test file is under `server/cloudflare`, harmless).

**Claude, 2026-10-09 (owner: CHE 2.0 BUILD approved, Phase A + early Brain Matrix/agent demo first). Branch `che2/phase-a-brain-agent-demo`, commit 12f2b8b, pushed (no PR yet).**
- Milestone 1 done: Brain Matrix shows LIVE agent work + per-agent work log with provenance. `buildAgentTaskNodes` (research_memory.js) maps queued/running/reviewing team_tasks to "Office Agents" graph nodes, linked by the existing token-overlap pass; `/api/brain/graph` and `/api/state` both include them. Flutter renders them in a new Agents lobe (kind `agent_task` → `Agents`, card source = agent name, body = real status). `recordAgentWork` (agent_runtime.js) writes one provenance entry per terminal task outcome (complete/failed, verified flag, memory-note link, error) to durable `data.agent_work_log` (cap 120) + `agent.last_work`; exposed in `agentDetail.work_log`. Reuses existing systems; no new framework, no fake activity, no Flutter change to navigation/permissions.
- Reconciled: main is 2984227 (#262 + #263 both merged). `claude/che-latency-optimization-8ruaus` is fully SUPERSEDED (batch-wake, peer money/delete, 3D crew all live via #258 43130bb; the branch is stale and missing #259–#263) — do NOT merge it; owner may delete. Answered CHE's 00:39 merge question in claude.jsonl (ea6310f): no PR needed for that branch.
- Verified: Worker **803/803** (`node --test`, 3 new), `flutter analyze --fatal-infos` clean, `flutter test` **240/240** (1 new). NOT verified: production deploy (no PR/merge yet — needs owner go-ahead with `[worker-deploy]` since `server/cloudflare` changed), paired iPhone voice/graph turns, live agent-task demo on device.
- Next: open focused PR for milestone 1 when the owner is ready (or continue: milestone 2 = scripted multi-agent demo via officeGoal + War Room board wiring + orb-tap deep link to the real task; then Phase B typed memory/provenance).
- Environment notes: portable Node v24.20.0 at `%LOCALAPPDATA%\nodejs-portable\`; `flutter test` needed `build/unit_test_assets` cleared once (OneDrive lock).


**ChatGPT 2026-10-20 owner-directed end-to-end continuation:** Current main `295a9cde` (PRs #393 and #392 merged). Claude PR #394 false-completion fix is open: CI green on inspected commit `6984aa1`, but unresolved Codex review threads remain for `office_workforce.js` (`review_pending` must keep temporary agents busy) and `office_board.js` (desk statuses for `review_pending`, `needs_review`, `rejected`); original passive-claims thread is outdated but should be rechecked. DO NOT MERGE #394 before current-head review and checks pass. ChatGPT created PR #395 from main `chatgpt/chart-malformed-response-20261020` commit `2865b6e` to guard malformed scalar API collection fields (`points`, `timeframes`, `bars`, `markers`, `drawings`, `open_orders`) in `lib/rooms/che_trading_chart.dart`, resolving the owner's observed `int` cast crash. PR #395 CI Flutter / UI Analyze in progress (`39540411941`, `39540411947`); not merged, not installed, no live iPhone test. Actual live FundYourEdge/Tradesea Rithmic market-data and broker paper-order integration NOT CONNECTED; existing futures `/api/trading/chart` uses stored delayed research bars and blocks futures orders. Next: add chart malformed-payload regression, obtain valid Rithmic API access/terms and separate simulated account permission; test read-only stream, then simulated orders only; no credentials shared in chat and no paid purchases. Owner requested end-to-end finish, but third-party API authorization is a real external blocker.

## 2. Current position


<!-- codex-music-truth-20261025:start -->
**Codex, 2026-10-25T16:15:54.866Z — owner: “Help she is lying” (11:04 phone recording).**
- PR #534 OPEN, head `e992ed53c458f600ac5733ef412238edcab9a966`, branch `codex/music-audio-truth-20261025`, based on main `262924b`. Implements the owner's music false-completion/pretend-playback repair in the existing hallucination auditor; guest replies use that auditor too. A file is distinct from playback, and unrelated receipts do not prove this request. Bracketed descriptions remain text. No music engine/provider was connected or run.
- Exact /api/chat replay: before 0/2 expectations, after 2/2. Focused auditor/pipeline/owner/guest checks 48/48. Full local Worker check before the final question-suffix refinement: 4128/4137 pass, 7 pre-existing skips, 2 pre-existing TODO; skills 20/20. Final-head CI is running (40210774124, UI 40210774142); no unresolved review threads at this checkpoint. Worker source 1,099,978 bytes within the existing budget. New live boundary checks in memory_probe.js; evidence in docs/failure_inventory/music_audio_truth.md.
- NEXT: final-head checks green, merge #534 with [worker-deploy], verify exact live SHA and both new Music probe steps. No phone rebuild needed. Actual owner-device retest is still required; don't claim all possible hallucinations are solved. Preserve Claude's separate UI, GitHub App and other work below.
<!-- codex-music-truth-20261025:end -->

**Claude, 2026-10-25 (session takeover: Codex mission recovery) — position now.**
- **Coding-job fix** `lane/coding-job-status` `3acd6b32` → **PR #529 OPEN, not merged** (named-job status routing; full server suite 4120 pass / 0 fail). Not deployed.
- **Modal connect** `lane/modal-connect-e2e` `8f9337f3` → **PR #530 OPEN, not merged**. `tools/modal/connect_modal.sh` + `tools/test_connect_modal.py` (10 e2e cases with stubbed modal/curl/wrangler; 10/10). NOT verified: a real Modal deploy or Worker write (needs owner go-ahead and the secrets). Browser token creation not built.
- **Coding eval (Jay)** `lane/coding-eval` `0a89c3c8`: 9 cases in 3 levels + `tools/coding_eval/run.mjs`; reference solutions 9/9. **Runs dispatched 2x (runs 40205834919 ff; 40205934541 ff, ids ocr-*)**: every run ended `blocked`/`opencode_failed` in ~2 s with `openrouter/qwen/qwen3.8-27b:free` (server error from the provider) and 0 changed files. **Jay has NOT been scored.** Blocker is the free model, not her code. Next: a working free coding model in CHE_CODING_FREE_PROVIDERS, then re-dispatch the 9 (job ids ocr-<sha1(jayeval-<case>)[:8]); the runtime makes one PR per run into main, so merge nothing without the owner's yes.
- **Creation image e8712698-5afc-420b-8cb6-be272f5815df**: ID not in repo/docs; stored record unverifiable from the sandbox. It is a media-item ID for a Blender PNG preview (server/cloudflare/media.js:319, gpu_queue.js:397-429). An editable GLB exists only if that job has `model` set (gpu_queue.js:123, 818). Verdict "editable 3D character": IN PROGRESS. Next code change: resolver media id → {project, version, job_id, model url, verified}.
- **GPU/cloud audit (read-only)**: NO GPU job has executed at any provider. Only the CPU GitHub worker is proven (runs 40153146586, 40143945084). Colab T4 needs the owner to open the notebook. Modal, Kaggle, RunPod, Vast and HF: credentials not verified; no execution receipt. Paid spend requires an owner cap (compute_budget.js:142-145). Stale status: the handoff says lane/modal-gpu is not merged, but 8824494a is an ancestor of main; the modal header comment names CHE_MODAL_ENDPOINT_TOKEN, the code uses MODAL_TOKEN.
- **Parked WIP branches (pushed, NOT reviewed or tested)**: `wip/lane/rel-infra-app-a1d2a2bb`, `wip/lane/char-realism-a2d758b2`, `wip/lane/security-hardening-a51d5dd1`, `wip/lane/trading-room-v3-a5282aad`, `wip/lane/che-earn-ab887118`, `wip/lane/rel-markets-studio-af093ca8`, `wip/worktree-agent-addf5d60bb35da585-addf5d60` (empty). The 21,596-line char-photo worktree (`lane/char-photo`) was NOT pushed.
- **Not started in this session**: brain/memory fixes, Trading Room, Studio, offline capabilities, the GPU/Modal approval workflow for other services, IPA. Next owner-visible step: approve #529 and #530 (merge deploys the Worker), then decide the free coding model.

**Claude, 2026-10-25 ~13:30 UTC — `lane/modal-gpu` DONE and pushed (head `8824494a`, from `origin/claude/che-character-realism`). Not merged, not deployed, no PR.**
- Owner spec PR #526 (`docs/CHE_MODAL_FREE_FIRST_USAGE_PRIVACY.md`) Stages 2-3 + acceptance 1-5 built into the EXISTING pool: `tools/modal/che_modal_app.py` (proxy-auth endpoint, allowlisted /health + /blender_preview, idempotent per key), `.github/workflows/che-modal-deploy.yml` (manual; skips without MODAL_TOKEN_ID/SECRET), `server/cloudflare/modal_gpu.js` (verified connect via authenticated /health; owner credit policy USER-ENTERED; monthly ESTIMATE stop line; `computeUsageLedger(storage,{month})` for the Usage Center lane), compute_pool wiring (Colab -> Kaggle -> Modal credit -> paid; GPU-only; cancel-by-key before failover), gpu_queue re-checks a Modal GLB's SHA-256 from the media store before COMPLETE.
- No Command Center entries added (voice rides the existing /cloud-gpu budget path); no Dart change; worker.js untouched.
- Verified: Worker 4070 pass / 0 fail (baseline 4061); `modal_gpu.test.mjs` 9; `tools/test_che_modal_app.py` 13. NOT verified: anything on real Modal (no account/token exists).
- Next (owner-only): Modal account, $0 spend limit, GitHub secrets, run "CHE Modal deploy", Proxy Auth Token -> "CHE, connect Modal"; then merge/deploy go-ahead. The Status section in the spec doc lists open items.

**Claude, 2026-10-25 ~11:00 UTC — `lane/rel-trust` DONE and pushed (head `f79f84c8`, from `claude/che-reliability` `0ec23ac`). Not merged, not deployed, no PR.**
- Owner's six trust failures fixed offline: favorites asked together (food/drink/color, with sources); save → read-back receipt quoting full record id + stored time; "record ID and timestamp for X" read back with source; "what are my recent memories"; missions/projects/"worked together before" from data.objectives/projects/jobs/team_tasks; "what is Claude currently working on" from live che-mailbox thread + handoff (Brain import fallback). Typed outcomes on done lines (retrieved/no_match/stored/storage_failed/permission_denied/tool_unavailable); guests refused.
- Salvaged the earlier lost attempt's uncommitted work (commit `ee330646`). Tests: `trust_memory_routing.test.mjs` 12 (all fail on base), replay cases `owner-trust-memory.json`/`owner-trust-history.json`, 12 new live-probe steps in `memory_probe.js`. Worker 3984 pass / 0 fail / 7 skipped; skills 19/19. Inventory: `docs/failure_inventory/trust_memory_routing.md`.
- Next: integrate into `claude/che-reliability` with the other rel lanes → PR → `[worker-deploy]` → check the deploy's memory probe "Trust:" steps live. Not verified on iPhone or production.


<!-- codex-rithmic-repair-20261025:start -->
**Codex, 2026-10-25T10:30:22.006Z — owner: “Just fix the problem” (Rithmic phone failures).**
- PR #525 MERGED as `9ae2a1bb29574bc38f1a5222ec6a6b73be5f0715`; reviewed head `4e74f9b101fc99d05feda3210194562e7d9968c4`. Required full Flutter/UI analysis, Worker and render checks passed; no unresolved review threads. Post-merge checks passed too.
- Reproduced a real local WebSocket defect before editing: heartbeat sent raw `98b64b12`, missing R | Protocol's four-byte length. Corrected transport sends `0000000498b64b12` and decodes incoming envelopes. Production discovery now uses `rprotocol.rithmic.com`, UAT only for an explicit Rithmic Test selection. Advanced system selection is resolved with its own gateway; stale errors/diagnostics are cleared. Tests cover actual socket framing, malformed lengths and production/UAT/system routing. Evidence: `docs/CHE_RITHMIC_CONNECTION_REPAIR.md`.
- Automatic Shorebird patch run **40184513397**, job **121142346023**, SUCCESS: logs confirm **Published Patch 1** for **1.4.1025668296+4015276551001**. Native IPA run **40184513385** skipped as expected for this Dart-only change. Publication is verified; installation and actual Rithmic account login on the phone remain UNVERIFIED.
- TLS validation, configured app name/version and the on-device login are preserved. No order path changed. Actual account login/authorization is UNVERIFIED; a remaining code 13 is not proof of a bad password. Direct Rithmic-host checks in this container failed DNS. Local Flutter complete-suite tooling was blocked by an environment metadata-access restriction; safer dependency-free Dart checks and GitHub's full suite provided verification.
- All code is saved on GitHub. Local git-only mirror/merge metadata differs from the API-created commit, but its complete tree matches main; there are no unpushed file changes. Preserve Claude's separate reliability/character work below.
<!-- codex-rithmic-repair-20261025:end -->

**Claude, 2026-10-25 ~06:00 UTC — two active lines of work; main still `afb8de1` (live).**
- Reliability mission (owner's "MASTER FAILURE CLEANUP"): branch `claude/che-reliability` (from main) at `0ec23ac` (media "open saved image <id>" fix). Lanes `lane/rel-trust` (trust/memory/routing/coding), `lane/rel-markets-studio` (trading/crypto/studio/media), `lane/rel-infra-app` (voice/native, a11y, CI/deploy/IPA/Shorebird, recovery skill, ONE regression checklist). Inventory goes to `docs/failure_inventory/*.md`; ships as its own PR before the character PR.
- Character/feature work: `claude/che-character-realism` (merged lanes B, C pool, D world, F GPU Connect; Worker 4016/0). Still running: lane/char-photo (A), lane/char-demo (E), lane/char-realism (G), lane/master-profile (H), lane/service-onboarding (I). Requirements + status: `docs/CHE_CHARACTER_REALISM_CHECKLIST.md` on that branch.
- Next: merge reliability lanes → PR → green → merge [worker-deploy] → verify → then merge main into the character branch.

**Claude, 2026-10-25 — character creation work in progress on `claude/che-character-realism`.** Read `docs/CHE_CHARACTER_REALISM_CHECKLIST.md` on that branch first (requirements, infrastructure facts, gap table). Lanes: `lane/char-photo` (Python/Blender: photo fit, body, hair, per-style samples) and `lane/char-photo-app` (Worker + app: reference upload, describe-a-person, body/voice/regenerate). Main is `afb8de1` (PR #524, live).


**Claude, 2026-10-25 ~02:10 UTC — PR #524 MERGED as `afb8de1`; Worker LIVE and verified.**
- Deploy run 40152765240: "VERIFIED afb8de155d3a is live" (Worker version 22362764-d908-4966-900a-3a6f7938b6af); memory truth 22/22 (0 model calls), Command Center 5/5 (130 commands ready), Knowledge Atlas 11/11, ElevenLabs voice 52287 bytes in 625 ms.
- Live trading (paper, read-only): futures paper ON, DELAYED MNQ=F MNQZ6 (weekend), 219 closed, 53 won/166 lost, net -6917.09; Orion crypto PAUSED, read real Coinbase BTC/ETH 5m/15m/1h LIVE bars (BTC 5m close 80781.14 at 01:55Z).
- Pre-merge evidence on head 32f2edb: all gating checks GREEN; local full Flutter 1365 pass / 0 fail / 2 skipped; Worker 3967/0; 13 Python suites OK.
- **IPA build 40152765510 SUCCESS** (macos-15, Shorebird release build, native Swift compiled): artifact 12584105082 `CHE-unsigned-ipa-self-updating`, 45,707,060 bytes, zip sha256 dcd40d6679a65b9db1ff09fef039296ffa465ff729efdf61594bfcd22f77b6d6, expires 2026-11-01. Not downloadable from the sandbox (blob host blocked); download from https://github.com/Vondada/chey-app/actions/runs/40152765510. Not signed, not installed, public release workflow not run.
- **Shorebird 40152765316 SUCCESS:** Published Patch 1 for release 1.4.1025652491+4013508846901 (the 0c43197 IPA), Dart-only; the owner's last known install is 1.4.1025342820, so this patch does not reach it.
- **creation_check 40153146586 SUCCESS (live):** job gpu_2f4b20b29e09 in 1.4 min on "free GitHub cloud CPU runner gha-40153346538-1" (worker name fixed), GLB 1,959,512 bytes sha matches receipt, 53 bones, 5 clips; viewport 7 meshes, 23,946 vertices (suit subdivision live), walk played.
- Not verified: iPhone install/behavior (native changes need the new IPA), phone WebSocket crypto stream vs real exchanges, Colab GPU, live Poly Haven fetch, Brain Room fps on device.
- Open: studio-tutorials lane never rebuilt; ~15 lane-requested commands not yet in command_catalog.js; "Research queue failed: k.startsWith" log line in the e2e server (pre-existing).


**Claude, 2026-10-25 ~02:30 UTC — new container (30 GB free; the earlier full disk is gone). PR #524 open; main `0c43197`.**
- **Lost:** the lanes brain-visual, studio-engine, studio-tutorials, creation-gaps and reliability existed only in the old container's `.claude/worktrees` and were never pushed. They are gone; redo only if still wanted. **Recovered:** trading-gaps + music-gaps (pushed earlier) on `claude/che-latency-optimization-8ruaus`.
- PR #524 (that branch, head after 594f269 + che-recover commit): Worker 3930/0 fail/7 skip, `dart analyze --fatal-infos` clean, skills 19/19, full `flutter test` running. NOT merged, NOT deployed, no IPA yet.
- New `che-recover` skill: `node .claude/skills/che-recover/scripts/preflight.mjs` (disk + unpushed-work check; safe `--clean --yes`). AGENTS.md: push every lane branch after each commit.
- Running in worktrees (land on #524 once tested): BTC/ETH real-time streaming over the exchanges' public WebSockets (tick→candle aggregator, LIVE/STALE/DELAYED labels, reconnect); mission-engine proof (persistent checkpointed workflow on the existing engine, end-to-end test).
- **Rebuilding the lost lanes (owner asked 2026-10-25):** no code from them exists anywhere on GitHub (searched every branch and commit message). Rebuilt from the one-line specs, each pushed to its own remote branch: `lane/studio-engine`, `lane/creation-gaps`, `lane/brain-visual`, `lane/reliability` (QA + docs/CHE_READINESS.md gap audit), plus `lane/crypto-stream`, `lane/mission-engine`. studio-tutorials runs after studio-engine lands. If this session dies, check those branches first.
- **Done on #524 (head 8664423):** Codex review fixes 89431ae (broker realized P&L spoken + CME basis carried into the pages; threads resolved); mission-engine lane merged (eecbec2): verified mission artifact with sha256 + reopen endpoint, offline proof test (docs/CHE_MISSION_ENGINE_PROOF.md; not verified on iPhone/production/real eviction); objectives defence-in-depth guard. Local: Worker full suite green, Flutter 1305 pass / 1 fail (golden `hud_office_floor.png` 0.9% diff locally; PR CI decides).
- **Merged into #524 since:** crypto-stream (c6ca12d), studio-engine (b8ca484), reliability (6cfac2d, docs/CHE_READINESS.md + e2e tests), brain-visual (dbed23e); CI fixes (Office golden cf48aa2, monitoring outputVolume d630386, e2e scroll d1df5b2); 3 reliability bugs + install-question gap fixed (todos now real tests); pitch correction ~10x faster (461a5d0); hands-free live transcript 8f (3218337, needs IPA); docs/CHE_ARCHITECTURE_AUDIT.md. Worker suite 3960/0. Remaining lanes: creation-gaps (running), studio-tutorials (not started). Commands wanted by lanes not yet in command_catalog.js.
- Next: finish the lanes → push to #524 → CI green → owner says merge → deploy verify (release_status.mjs) → IPA via [ios-build].


**Claude, 2026-10-25 — RESUME mission: parallel lanes running; main `0c43197` (#523, merged by Codex), no open PRs.**
- **Verified live (deploy run 40143945084, creation_check):** Generate → free GitHub CPU worker → Blender 5.0.1 → GLB in 1.7 min (job gpu_aa40ade12d98, GLB 1,149,516 bytes, sha matches the receipt, 53 bones, rig verified, clips idle/walk/run/wave/talk) → viewport loaded 7 meshes and played walk. Memory truth 22/22, voice, Command Center 5/5, Atlas 11/11. Defect: the notice names the worker "?" (creation-gaps lane fixing).
- Trading audit now 1,109 closed / 9 open, −8,144.41 R = gross −216.55 R − costs 7,927.86 R (325 cost>risk; the 9 new ones closed from positions opened before the cost gate — to confirm).
- **Lanes (local branches in .claude/worktrees, merged by Claude into `claude/che-latency-optimization-8ruaus`):**
  - lane/brain-visual — Brain Room immersive redesign (owner reference image; 3D navigation, 11 regions, Live Activity, connected screens). Owns lib/brain/**, insights_brain_scene.dart.
  - lane/music-gaps — M4A export, MP3/M4A import, monitoring, pitch test (native → IPA). Owns lib/music existing files.
  - lane/studio-engine — new lib/music files: beat producer, Engineer Mode/Bring Me Back, BandLab preset import, vocal analysis.
  - lane/studio-tutorials — real MP4 tutorial pipeline from the actual studio UI + Studio Tutorials screen.
  - lane/creation-gaps — free-form objects, suit quality, CC0 textures, Roblox/benchmark CI, Code Studio Stop, worker name.
  - lane/trading-gaps — crypto paper replay, Office daily rollups, Alpaca paper fills/broker P&L, "audit September 22", Diagnose Rithmic.
  - lane/reliability — full suites + CI baseline, replay checks on owner phrases, a11y sweep (outside other lanes' files).
- **Next:** after music-gaps commits, an integration lane wires the studio engine into the new tabs (Record/Tracks/Beats/Effects/Mixer/Master) + Engineer Mode UI; rerun tutorials; one PR with [worker-deploy] if Worker changed and [ios-build] for native audio. Public IPA release still needs the owner's yes.

**Claude, 2026-10-24T23:45:28.726Z — resumed after the session limit; #523 is merged (Codex finished it). First real production audit numbers below.**
- Branch `claude/che-latency-optimization-8ruaus` synced to main `0c43197` (065af55, no diff).
- **Trading audit (live deploy 40135088611, read-only):** the simulation has 1,100 closed and 18 open (0 on retired feeds). Its total is −8,061.76 R, made of gross −227.82 R from price moves and −7,833.94 R in costs; 316 trades had costs larger than their risk. There are 0 record problems. Journal: paper:futures 219 records, 0 problems. Research: 92 units, 13,215 backtest trades, 0 fixture units, 0 failed look-ahead, 0 without a data hash. **2026-09-22: UTC 0, New York 0, CME day 0**, so the owner's ≈ −$1,018 is in none of the sim, journal or research ledgers. Next: check the broker (Alpaca paper) and any other P&L store.
- **Projects audit:** 14 stored projects shown as 9 cards (1 duplicate group, every copy kept). Roblox: 4 projects, 0 with Luau, 0 crew results, 0 playtested. The only real Roblox game is `roblox/che-blade-arena` (built by CI, not playtested).
- Dispatched `che-worker-deploy.yml` with `creation_check: true` on main: the first real Generate → free worker (with the User-Agent fix) → GLB → viewport run. Result pending.
- **Gap lanes resumed** (local, unpushed, follow-up PR after review): `lane/brain-visual` (glowing brain renderer, CONNECTION_CREATED ledger events), `lane/music-gaps` (M4A export, MP3/M4A import, live monitoring, real-voice pitch test; native, needs an IPA), `lane/creation-gaps` (free-form objects, a less blocky suit, CC0 textures at job time, Code Studio Stop for running jobs, Strategy Lab deep link), `lane/trading-gaps` (crypto paper replay, Office calendar rollups, Alpaca paper fills, "audit September 22", Diagnose Rithmic, CI crypto backtest).
- Public IPA release is still `disabled_manually`; publishing needs the owner's yes.

**Codex final release checkpoint, 2026-10-24 22:02:40 UTC — #523 merged and backend LIVE.**
- Main/merge: `0c43197c66529ee0902ee373fc0889467490ee71`. Final pre-merge head `2f15482bf97583333eccb10bf2c30fb312c4d12d` passed all seven gating checks; post-merge Flutter and Worker checks passed too. Only open PR at takeover was #523; it is now merged.
- Worker deploy `40135088611` SUCCESS. Fresh `/health` HTTP 200 confirms `0c43197c6652`, version `80020cfb-fcc6-4c86-9e33-bee80fc646d4`. Live memory 22/22, Command Center 5/5, Knowledge Atlas 11/11 and voice passed. No live orders were placed.
- Full iPhone build `40135088469`, job `120994805984`, SUCCESS. Version `1.4.1025652491`, build `4013508846901`, bundle `com.cheyapp.chey`. Artifact `12575779913` (`CHE-unsigned-ipa-self-updating`, expires 2026-10-31), source main at the merge SHA. Downloaded artifact ZIP matched GitHub digest `f5399215dbe13716437986df99af266544d1ebc0459d776313f1616de2843576`. Extracted unsigned IPA: 45,891,975 bytes, SHA-256 `4e042b1a11e4e7bae7d393ae10f92b508f004e4dd5589ccb6bbc5165e27ab8a0`. The IPA's studio.html, characters-vendor.js and che.glb exactly match merged source. IPA/checksum/metadata and real default-character viewport screenshot were delivered in this chat's outputs. Signing/installation on the actual iPhone is NOT verified.
- Shorebird `40135088615`, job `120994806749`, SUCCESS: log confirms **Published Patch 12** for `1.4.1025573394+4004060559301`. Asset changes are excluded (explicit CLI warning); use the full IPA for the updated viewer. Patch publication never proves installation, and targets only that exact release.
- Public IPA release workflow remains `disabled_manually`; no new public release or update-feed publication is claimed. Browser signed out; connector cannot enable/dispatch workflows. Owner chose Continue available work. The completed IPA artifact was retrieved through the connected integration and made available directly, without changing the publication pipeline.
- STILL UNVERIFIED: current Colab T4 connection; a completed live creation and automatic preview on the iPhone; Google sign-in/retained WebView behavior on-device. Optional authenticated creation_check could not be dispatched. Do not call a ready queue or online CPU a connected GPU. No Colab keep-alive/bypass, purchases or paused cinematic renders.
- NEXT owner/device checks: sign/install the delivered full IPA through the existing sideload process; Create Person should load bundled CHE without waiting for the server; test front/side/rotate/zoom and character choice; say open GPU browser; check real GPU heartbeat; submit a creation, leave and return, verify the actual delivered model. With authenticated workflow access, enable the existing public-release workflow only under the owner's publishing authorization and run creation_check. Older historical handoff tasks remain historical/paused unless separately continued.


**Codex, 2026-10-24 21:39:41 UTC — owner-directed CHE takeover. PR #523 MERGED as `0c43197c66529ee0902ee373fc0889467490ee71`; final reviewed/tested head `2f15482bf97583333eccb10bf2c30fb312c4d12d`.**
- Recovered Claude's existing implementations (#517–#522 already on main) and continued his open branch/PR #523; no second browser, queue or creation system. All seven gating checks passed, including Linux Worker and full Flutter suites, iOS simulator compile, UI analysis, Roblox, benchmark and Visual Studio renders. The three existing review findings are resolved. Cloudflare branch Git integration is non-gating under existing policy.
- Added retained GPU Browser using CheBrowserScreen: Open, Refresh, Reconnect and real GPU heartbeat status, with voice/typed `open GPU browser`. Google sign-in hands off to the system browser; no cookie copying, UA spoofing or Colab keep-alive. CPU heartbeats no longer falsely report a connected Colab GPU.
- Default bundled CHE loads before any project API request; renderer page-ready and model-parsed acknowledgments gate loaded state. Selected project character replaces startup CHE; object projects clear it. Polling survives covering routes and refreshes after app resume. Existing queue handles submission/checkpoints/recovery/results without keeping Safari open for supported cloud CPU jobs.
- Verified locally: 29 focused Flutter tests; analysis clean; 39 creation queue/studio/orchestrator/probe tests; 6 bundled asset checks. Actual Chromium rendered CHE's existing GLB (30 meshes, 34,572 vertices, 68,926 triangles), played idle, and verified front 0°, side 90°, rotate to 45°, zoom 1.4× and clear. Screenshot is a real asset/viewport test, not a generated GPU result or iPhone evidence.
- Reproduced the live edge bug: /health with Python-urllib UA returns 403/error 1010; CHE-creation-worker UA returns 200. Claude's existing fix is included in #523. GPU connection and a completed live creation remain UNVERIFIED.
- RELEASES RUNNING: Worker deploy `40135088611`, Shorebird `40135088615`, full IPA build `40135088469`. Verify each exact SHA and /health before claiming live or installable. New bundled HTML/assets require a full IPA; a Dart-only patch is insufficient evidence.
- BLOCKER: existing `.github/workflows/che-ipa-release.yml` is `disabled_manually` (GitHub API verified); connected browser signed out; GitHub connector exposes neither workflow dispatch nor enable. Owner explicitly chose **Continue available work** rather than signing in. Automatic Worker and IPA-build workflows are active. Do not claim public IPA publication or installation, or a manually dispatched creation_check.
- NEXT: finish monitoring the three runs, fix any real failures, inspect automatic creation worker runs for real completion, update this checkpoint with final evidence. No paid services purchased, no live trades, no owner-paused cinematic render resumed. Local full Windows suites have platform/golden/path failures; Linux CI is the supported gating evidence.


**Claude, 2026-10-24 ~19:30 UTC. Live 3D Studio: PR #520 (head d594de2), CI running; merge when green with [worker-deploy].**
- Creation Room = six choices (Create Person / Object / Room / Animation, My Creations, Active Projects) + Creation Engine state with Connect. GPU jobs, Pair Colab moved to Settings -> Creation Engine.
- Create Person -> /api/creations project (versions, undo/redo/save, deterministic edits in creation_studio.js) -> Generate queues a `person_model` GPU job -> mpfb_dress.py EXPORT_GLB (head-and-neck bust, vertex colours) streams to /api/gpu/worker/model, then previews -> Live Studio three.js viewport (assets/characters/app/studio.html) shows the real GLB + timestamped stages.
- Verified locally: Worker 3808/3808, Flutter +1178, analyze clean, Python 28/28, real Blender 5.0.1 CPU GLB (1,463,972 bytes, 30,904 verts) loaded in the real viewport in Chromium. NOT verified: any Colab GPU run, iPhone.
- Not built (says so in the app): Create Object, Create Room, new animations, generated-model rigging, "put this in my Office". GLB hair cards read as a solid shape.

**Claude, 2026-10-24 ~16:30 UTC.** Two more PRs merged:
- **#518 perf hot paths, merged as 829ead1 `[worker-deploy]`.** Deploy run 40105938763 "VERIFIED 829ead1ca55d is live"; memory truth 18/18, voice 50198 bytes in 519 ms, Command Center 5/5, Atlas 11/11. Shorebird run 40105938756 success. Contents: stale-while-revalidate market snapshot/candles (dedupe, 4 s/6 s upstream timeouts, 2.5 s cold wait, last good value in DO storage under `markets_cache_v1:`, labelled `fetched_at`/`stale`/`age_s`), mailbox badge answers from the last GitHub read and refreshes in the background, perf_watch now splits `provider:owner_chat` / `provider:internal` from CHE's own time. Simulated trace (`node server/cloudflare/perf_hotpaths_sim.mjs`, seed 7): snapshot n=80 p95 7300->0 ms, candles n=40 p95 7000->600, badge n=480 p95 2940->0. PRODUCTION p50/p95 after deploy NOT yet read: get them from `/performance` once each route has 10+ requests.
- **#519 Creative Studio (Create room redesign, Vale), merged as 6832942 (app only).** Film, Music, Code, Art & Character (GPU Jobs, Pair Colab, Character Generator), Projects; mannequins removed; voice routes for every action. Shorebird for 6832942: being verified (release_status.mjs --sha 6832942).
- NOT verified: iPhone install of either patch (owner restarts CHE twice), any GPU render (no worker heartbeat yet; owner must Pair Colab -> CHE_GPU_TOKEN -> rerun cells 3 and 7).
- Next: production perf numbers; GPU receipts once paired; agent hairstyles (only long_wavy built).

**Claude, 2026-10-24 14:40 UTC.** PR #517 MERGED as d698c20 (`[worker-deploy]`), after green gating checks on 86420bf and fixes for all 6 Codex findings (threads answered and resolved). Deploy + Shorebird for d698c20 being verified (see release_status.mjs --sha d698c20). Contents: Colab T4 GPU queue (`/api/gpu/*`), Create -> GPU Jobs -> Pair Colab (worker token, shown once -> Colab secret CHE_GPU_TOKEN, then rerun notebook cells 3 and 7), identity presets for CHE + 9 agents in 3 looks (tools/avatar_face/identities.json, identity.py, server/cloudflare/avatar_identity.js; parity-tested), eye/skin/hair fixes, Character Generator (Generate/Preview/Save/Apply, full voice routes). NOT verified: any GPU render (no worker heartbeat seen yet), iPhone install. Owner's reference photos of real private people (some likely a minor, school setting) were DECLINED as face references; nothing stored. Next: Creative Studio redesign + mannequin audit on branch claude/che-creative-studio (worktree scratchpad/studiowt), merge main into it, PR, screenshots.

**PROGRESS DASHBOARD (Claude, 2026-10-24 ~11:35Z). Verified statuses only; UNKNOWN means not checked.**

| Workstream | Status | Last verified result | Next action |
|---|---|---|---|
| CHE face (owner calls her Jay; same character) | In progress, FACE FIRST | `2c68b55` (v7) on `claude/che-latency-optimization-8ruaus`: feathered wider brows (BROW_W), warmer iris (IRIS). 480px CPU sheet sent (actual render). Sheets now compare CHE versions only, no real-person photos. | Brows too heavy with curled tails; skin waxy; lips too even. Owner approval needed before body work. |
| GPU (Colab T4) | T4 detected by the owner (OPTIX ['Tesla T4'], exit 0); NO picture or receipt seen by Claude yet | PR #517 (draft) `76913a7`: the "all 3 SKIPPED" run reused an earlier same-day finished job (jobs were named by date+commit). Fixed: content-named jobs (`face-<hash>`), reuse only when the PNG matches the receipt hash and the receipt names a GPU, worker cell renders `queue/*.json` from `che-gpu-assets` once each and stops after 45 idle min. Queue: `v7-brows-iris` (2f64f91). Tests 11+6+5. | Owner: create private repo `Vondada/che-gpu-results` (integration got 403 creating it) + `RESULTS_TOKEN` for that repo only; Run all. Then read results/<job>/receipt.json and send 3 views. |
| Brain (memory, context) | Live | #515 merged as `2d176d0` `[worker-deploy]`; deploy run 40089970301 "VERIFIED 2d176d06ea8c is live"; memory truth 18/18 (0 model calls), voice ElevenLabs 51034 bytes in 452 ms, Command Center 5/5, Atlas 11/11. Shorebird patch run 40089970282 was still in progress at 11:35Z. | Owner-device check: "No, strawberry Sprite" right after a recall; relaunch keeps the last turns. |
| Coding | Live | main `632df0d` (#514), deploy run 40077496109 "VERIFIED 632df0de5fa8 is live"; probes: memory 18/18, Command Center 5/5, Atlas 11/11. | PR #516 (Codex follow-ups for #513/#514) `67d541b`: analyze red + two Codex P2 findings (bucket opening bar, dispatch correlation); an agent is fixing them. |
| Voice | TTS live; wake word UNKNOWN on device | ElevenLabs probe at `632df0d`: 50198 bytes in 291 ms. | §8f (no live transcript, long wait) still open; wake word needs the owner's device. |
| Trading (paper only) | Code live; latest paper P&L UNKNOWN | #513 `28eb9cf` (tickers, Coinbase/Kraken candles, indicators; places no orders). No live trading anywhere. | Read `/api/trading/status` in production (not reachable from the sandbox). |
| Creation | Paused by the owner | Cinematic v2 paused at about 217/288 frames (owner: no full video renders). #512 verified-MP4 receipts merged. | Resume only when the owner says so. |

Decisions logged 2026-10-24: the face moved to the MPFB2 (CC0) base; CHE keeps an original face. Claude declined to model her on photos of a real private person who appears to be a minor (school setting); features are taken from the owner's written descriptions only. A later TikTok screenshot of another real woman is used for generic styling and light only (arched brows, voluminous dark hair, golden-hour light), not her face.

**Claude, 2026-10-24 avatar/cinematic session (hyper-speed mode: the owner authorized deciding without asking; decisions are logged here).**
- Branch `claude/che-latency-optimization-8ruaus`: `d14e684` cinematic sample (tools/cinematic_sample, 12 s MP4 verified in scratch, Rhubarb lip sync, Piper voice — NOT CHE's selected voice), `b5b522d` tools/avatar_portraits (strand-hair portrait renderer). Pushed, not merged, no PR (owner: Blender/avatar work stays on the branch).
- Avatar status: actual Blender 5.0.1 Cycles CPU renders, semi-realistic, NOT photoreal. v1: 12 portraits + 2 body shots (idle_relaxed pose, ~13k strands; hair read grey, temple clump). v2: thinner darker strands, hairline cards 141/142 dropped (found with a card-id false-colour render), rim light halved. Renders live in the session scratchpad gallery only (not committed; PNGs are not repo assets). Remaining defects: painted eyebrows, feet, no skin micro-detail.
- Crew portraits DONE (scratch gallery `2026-10-24-crew-portraits`): the 8 existing stylised GLBs under the portrait rig. Cinematic v2 full render (288 frames, 360x640) running in the session; scene in `tools/cinematic_sample/scene_v2.py`. When it finishes: `mux.sh` with the existing Piper `line.wav`, verify with ffprobe, send.
- Branch commits this session, in order: `b5b522d` avatar_portraits, `cae2ff9` strand_hair module + crew renderer + scene_v2, `8744fab` cinematic v2 framing/parenting fixes, `4c6195d` mux overrides, plus README/.gitignore. All pushed.
- Decisions: cinematic v2 uses the `gesture_chat` clip (stationary) because `idle_relaxed`, `talk` and `talk_story` are walking captures that drift ~2.5 m; strand hair is bone-parented to `head`. Crew portraits re-render the existing stylised GLBs under the portrait light rig; they are NOT photoreal and cannot be without new models (Orion and Vale still have no model).
- PRs open, waiting on the owner's merge go-ahead: #513 (trading), #514 (cloud computer). HQ/Living World not PR'd: depends on the truth follow-ups (`auditText`), 15 test failures when applied to main.
- Gmail (#34): code routes correctly in replay; owner-device check still open.

**Claude, 2026-10-24 master recovery (checkpoint, verified on git).**
- main: `ce63de4` (fetched; no new commits). Open PRs on GitHub: none.
- Work branch `claude/che-latency-optimization-8ruaus` head is `248b177` (pushed, not merged, no PR). The HQ commits `0d57f41`, `00d8d30`, `6fe39de` are its ancestors. Earlier text in this section said head `6fe39de`; git wins.
- Verified this session: Worker `node --test` 3768/3768 pass, exit 0, at `248b177`. Flutter not re-run this session.
- Gmail routing (#34): PARTIAL. "CHE, check my unread emails and tell me the newest one." replays through the real `/api/chat` as `che_google` with 0 model calls. Connected Gmail is not in the replay, so the reply there is "Gmail is not connected". The owner's earlier model answer is not reproduced; the guest guard (`worker.js` ~5919) covers non-owner devices. Open: test on the owner's connected device.
- Office 3D renders, actual (not mockup): `scratchpad/gallery/2026-10-24-office3d-rooms/` (Office and War Room, wide and phone). Logged in `gallery/index.md`.
- HQ (#117 to #120): Worker and Flutter pieces on the branch. Not done: room zones and first/third-person 3D, tap-to-room bridge, room voice commands and room microphone. No PR.
- Brain 2.0 (`claude/che-brain-2`, `ce63de4`): worker stopped, uncommitted files in its worktree. Not running.
- Blender cinematic: no committed or verified MP4 on any branch. Scratch renders only. BLOCKED on a verified final render.
- Avatars: 8 crew GLB baseline renders. Orion and Vale have no model. Photoreal avatars not started.
- Blockers: no GPU; no iPhone verification; Actions dispatch unverified; `server/cloudflare` changes need the owner's go-ahead and `[worker-deploy]` before merge.
- Next action: owner decides on merging the HQ branch. Then Gmail on the owner's connected device, then room renders for the other office3d pages.

**Earlier checkpoint (2026-10-24, HQ mission):**

- Branch `claude/che-latency-optimization-8ruaus`, head `6fe39de`. Pushed; not merged to main; no PR; Worker not deployed.
  - `0d57f41` Worker: `GET /api/office/hq`, `GET /api/office/hq/:room`, `POST /api/office/hq/talk`. Rooms come from the roster's department heads. Status comes from Office records only. A talk is filed to the head's inbox. An assign goes through `queueAgentTask` after `assertAgentMayRun`. `headquarters.test.mjs` 11/11; full Worker suite 3718/0.
  - `00d8d30` Flutter: the Office tab opens on Headquarters (HQ | Crew | Projects). `CheHeadquartersScreen` gives the 2D room list, a room page (facts, conversation, Send, Assign) and "Open 3D crew". 3D page: CHE, Free, Overview and Agent Follow modes, zoom, reset. Crew names follow the agent.
  - `6fe39de` test expectation for the new Office screen report.
- Verified: `flutter analyze` (whole project) clean, Flutter 3.47.8. Full `flutter test`: 1113 passed, 0 failed, 1 skipped. Headless Chromium on the real crew GLBs: follow, zoom, overview, reset, no page errors. `assets.test.mjs` and `validate_assets.mjs` pass.
- Not done: room zones, headers and first/third-person camera in 3D. The 3D tap-to-room bridge into Flutter (the page sends `focus`; the app does not handle it yet). Room voice commands ("show me Knox", "follow Nova", "take me to the Security Room") in `lib/home/screen_command.dart`. Microphone in the room page. Gmail/Google routing (#34) is untouched.
- Not verified: iPhone build; production Worker (HQ routes go live only after a merge to main with `[worker-deploy]`).
- IPA: run 40040605593 produced private artifact `CHE-unsigned-ipa-self-updating` (id 12540020863, build 1.4.1025573394 build 4004060559301, expires 2026-10-30). Not downloaded or checksum-verified from here; not installed on the owner's phone. No public release; `che-ipa-release.yml` stays disabled_manually until the owner approves.
- Installed build/patch on the owner's phone: UNVERIFIED from here (needs the CHE Updates screen on the device).
- Restrictions unchanged: no spending, no deletion, no live orders, no schedules.

## 3. Queue: the owner's open requests, in order

Do them top to bottom. Mark each one `DONE (PR #, SHA)` or `WIP (branch, next step)` here.

**Owner directives relayed 2026-10-18 (newest first; do not mislabel as implemented):**
- **#347 CHE cross-platform Creator Studio + original hybrid animation / urban drama** — owner supplied two iPhone videos to ChatGPT; first TOP video is a simple illustrated science explainer with cartoon figures/diagram cutaways (NOT the Claude UI underneath), second a Westview Productions Instagram AI-generated urban serialized drama. Build a copyright-safe ORIGINAL fusion with genuine 30–45s playable 9:16 pilot, voice/captions/recurring cast, platform-specific export and real per-platform OAuth/owner-approved posting only where authorized; audience-growth experiments use real statistics and no bot/spam. Existing YouTube pipeline must be reused, not duplicated; starter issue: https://github.com/Vondada/chey-app/issues/347. Source footage is not stored in public repo; secure media import to CHE requires owner authorization. **Status: ISSUE + FLAGSTAFF DIRECTIVE, NOT BUILT.**
- **#346 full progressive Coding + Trading Knowledge Atlas** — beginner-to-expert interconnected concepts, analogies, mathematical formulas, tested examples/quizzes, and retrieved facts using existing Library/Brain/code index/trading statistics; phase 1 10 coding + 10 trading cards; do not duplicate engines: https://github.com/Vondada/chey-app/issues/346. **Status: ISSUE + FLAGSTAFF DIRECTIVE, NOT BUILT.**
- **#345 full-sentence understanding → short intent/workflow compression** — preserve original full utterance, negations/conditions/actor/time/quantities and approval; eliminate silent truncation of late constraints, use existing speech_intent/workflow_governor/ai_router/owner_action_gate and regression tests; actual token measurements: https://github.com/Vondada/chey-app/issues/345. **Status: ISSUE + FLAGSTAFF DIRECTIVE, NOT BUILT.**


1. **Trading Room learning engine.** DONE first cut (PR #178, 1ca27c0). Next: intraday futures data once the owner has a feed, and showing the learning in the Trading Room UI.
   - Agents permanently backtest and paper-trade ES, NQ, MES and MNQ, many trades a day, and learn from the results.
   - Show accuracy, P&L and trade counts.
   - Build on `server/cloudflare/trading_lab.js`: `backtest`, `backtestAll`, `paperTick`, `stats` and `readBook` already exist.
   - Deterministic code, no AI tokens, real market data only, no real money ever. Paper trading only.
   - The sandbox can't reach market sites, so test with recorded candles.
2. **Autonomy exam (5 levels)** run against CHE: code herself, self-correct, learn from mistakes. A real run needs the deployed Worker and engines. Report honestly, level by level.
3. **CHE 2.0** (keep the black/teal identity and voice-first design):
   - App-wide navigation: never trapped; swipe back or down, Back/Close, state preserved.
   - Rooms instantly understandable, with spatial transitions.
   - Office employee cards showing real work only: Working, Queued, Blocked, Finished or Available.
   - A searchable Vault of history.
   - A real War Room group chat ("CHE, open a War Room with Atlas, Mira and Nova"), with CHE coordinating. Build on #169.
   - Agents Nova, Atlas, Mira, Knox, Sage, Lyra and Iris as distinct mini-people whose animation reflects their real state.
   - Voice commands: "Go back", "Close this", "Take me home", "Open the Office", "Open the War Room", "Show Atlas", "What is Atlas working on?"
   - Verify at iPhone 17 Pro Max size (440×956 pt).
4. **Starred repos integration**: names received 2026-10-11 (six repos). Code DONE on `claude/che-latency-optimization-8ruaus` `f527a35`, not merged or deployed. See §2.
5. **NinjaTrader login**: waiting on the error text.

---

## 4. The coding process (do it exactly like this)

**Setup**
- The Flutter SDK must be on PATH. Run `tool/bootstrap.sh` if the repo has it.
- `flutter analyze` rewrites `analysis_options.yaml`. **Always** run `git checkout analysis_options.yaml` before committing.
- Worker: `cd server/cloudflare && npm test` (node:test, all `*.test.mjs`).

**Branch**
- New work: `git checkout -B <ai>/<topic> origin/main`.
- Continuing work: check out the existing branch and merge `origin/main` in.

**Read before writing**
- Find the real code first with `grep -rn`. Never assume a file or function exists.
- Match the surrounding style and comment density.
- Make small, surgical edits. Python or sed is fine for exact replacements; assert the old text exists exactly once.

**Never break these**
- `lib/browser/che_browser.dart`.
- The navigation logic in `lib/home_state/send.dart` (add, don't rewrite).
- `_openSpeechTurn` in `lib/home_state/voice.dart`, and `lib/che_speech_pipeline.dart`.
- `_mic` (`lib/che_mic_supervisor.dart`).
- Passwords only in `lib/security/che_password_vault.dart`.

**Every new or changed screen**
- VoiceOver `Semantics` labels on every button.
- Spoken result of every action (`speakText` / `_say`).
- Large-text caption.
- A voice route to every action.
- Never "tap here".

**Verify before every push**
```bash
dart analyze --fatal-infos lib test        # CI uses --fatal-infos
flutter test                               # all must pass
(cd server/cloudflare && npm test)         # when the Worker changed
git checkout analysis_options.yaml
```
- Add a test for every new behavior, including the owner's exact words for voice commands.
- For visual work, render the painter to a PNG in a throwaway test and look at it, then delete the test.

**Commit and PR**
- Clear commit message: what changed for the owner and why.
- One PR per topic; the PR body lists what changed, how it was verified, and what was not verified.
- Do not merge until the owner says "merge".

**Merge and deliver** (only after the owner approves)
- Put `[worker-deploy]` in the merge title if `server/cloudflare/` changed. That deploys the Worker.
- Then dispatch `che-shorebird.yml` (`mode=patch`) on main for Dart OTA.
- Native (Swift/iOS) changes need a full app build; say so.

**CI red on your PR**
- Root-cause it and fix it.
- Never skip or disable a test.
- Never use an empty commit to re-run CI.

**Owner style**
- Voice-first replies: short, plain, honest.
- Fewest tokens without losing speed or quality.

---

## 5. Map of the code (where things live)

- **App shell:** `lib/main.dart`. `_CHEHomeState` is split into `lib/home_state/*.dart` extensions (voice, microphone, send, security, hub_rooms, memory).
- **Brain:**
  - `lib/brain/che_brain_space_model.dart`: layout, brain shape, camera.
  - `lib/brain/che_brain_space.dart`: controller with neural pulses, painter, gestures, callout.
  - `lib/home/che_memory_brain.dart`: dots from real memories, including `conversation_memories`.
- **Worker:**
  - `server/cloudflare/worker.js`: the Durable Object `CheState`. `fetch` wraps `handleRequest`, and every owner `/api/chat` turn becomes a memory through `brain_memory.js`.
  - Router: `ai_router.js`. Self-coding: `self_development.js`. Trading: `trading_lab.js` and `markets.js`.
- **Voice:**
  - `lib/home_state/voice.dart` (`_openSpeechTurn`, `_initNativeIosVoice`) and `lib/home_state/security.dart` (`_restartWakeListener`, `_handsFreeOn`).
  - Native iOS: `ios/Runner/AppDelegate.swift`. Kokoro on-device TTS: `lib/che_kokoro_voice.dart`.
- **UI prefs and voice commands:** `lib/che_ui/che_ui_preferences.dart` and `che_ui_voice_command.dart`.
- **CHE's self-knowledge** (read by every study and coding agent): `server/cloudflare/che_self_knowledge.js`.

**2026-10-08 Claude (owner: "only grade and send her autonomy test when everything is implemented inside her"):** Autonomy test (Round 7, mailbox id 256e5bc8-5bd8-44f9-992c-15444fbd4e9c) is HELD: not graded and not re-sent. Done: feb4e92 on `claude/che-latency-optimization-8ruaus` (no PR, not merged, not deployed): Flagstaff replies keep every sentence and mark unverified ones `[NOT VERIFIED]`; reply cap 2000 tokens; stored text cap 12000 chars; Worker tests 729/729 locally. Not done: owner-facing cut-offs remain: `guardOwnerReply` (truth_layer.js:259, removes sentences; used at worker.js ~3698 and ~8149) and owner chat `maxTokens` 360 for non-strong models (worker.js ~8040) and `max_tokens` 800 default (ai_router.js:576). Decision needed from the owner: flag unsupported claims instead of removing them (risk: false claims reach the owner), and whether raising owner chat caps is acceptable on token cost. Next: get that decision, implement it, merge feb4e92 on owner go-ahead, verify live, then grade and send the autonomy test.

**2026-10-08 Claude (owner decisions: facts only; raise owner caps to 2000):** Commits 32ace36 and 9150757 on `claude/che-latency-optimization-8ruaus` (no PR, not merged, not deployed): owner chat caps raised to 2000 tokens on all paths (worker.js ~8040, 8054, 8104; ai_router.js default); casual-chat fast path threshold raised from 500 to 2000 so short chat still uses the fast model. Worker tests 729/729 locally. Unsupported-claim removal stays as built (guardOwnerReply). NOT built: (a) letting CHE keep her own reasoning that is labeled as her view instead of removing it; (b) learned owner shorthand / self-made tokens for input prompts (compression for model context only; owner-visible replies stay plain). Autonomy test (Round 7) still HELD: merge of the branch and live verification are still needed, and (a)/(b) are open. Next: owner go-ahead to merge, implement (a) and (b) or confirm scope, verify live, then grade and send the autonomy test.

**2026-10-08 Claude (owner: merge; skip the Cloudflare "Workers Builds" failure indefinitely; live feedback):** PR #251 squash-merged to main as 225c9dc (head 9150757, the Cloudflare check failed and was skipped by owner decision). Live feedback started: commit 04ab119 on local `claude/che-latency-optimization-8ruaus` (job_activity.js + GET `/api/job/activity?id=`; the runner logs "Starting…", "Step n done", "Problem…", "Finished…" per background job). Tests 731/731 locally. NOT pushed: the remote branch still holds the merged commit 9150757, and a force-with-lease push was denied by the permission classifier. Next: owner decides how to push (or a fresh branch name); then the app must show and speak the activity (not built); the coding runtime's own steps (coding_runtime.js) are not yet logged. Autonomy test still HELD.

---

## 6. MASTER MISSION INVENTORY (Claude, 2026-10-21) — every requirement, status, source, next action

Sources: owner's master mission message (2026-10-21, "CHE MASTER MISSION"); this file §3 queue (owner directives of 2026-10-18); `REQUIREMENT-MATRIX.md` (reconciled 2026-10-08); AGENTS.md; open PRs #415, #412, #410; merged #411, #413, #414. Statuses: DONE-V = done and verified by a test or live run; IMPL-NV = implemented, not verified; PARTIAL; BROKEN; NOT-STARTED; BLOCKED (external or owner); SUPERSEDED. "Verified" never means only a merged PR: each row names the proof.

**Priority order (owner, 2026-10-21):** 1 broken owner-facing behaviour / inaccurate answers → 2 Trading Room + PR #411 verification → 3 coding autonomy and evidence → 4 memory and knowledge → 5 voice, navigation, accessibility → 6 business, creation, media, Office → 7 the rest.

### A. Trading Room (priority 2, highest immediate)
| ID | Requirement | Status | Evidence / source files | Next action |
|---|---|---|---|---|
| T1 | Simple, polished, phone-first Trading Room; four sections (Chart, CHE Trades, Strategies, Account) | PARTIAL | backlog #99 WIP; `lib/rooms/che_trading_chart.dart`; `trading_chart.js` | redesign screen per T2–T9 in one Flutter change |
| T2 | MNQ/NQ chart first, source and freshness visible | PARTIAL | chart API `/api/trading/chart` (`trading_chart.js`) returns source/status; Flutter shows it | show source + "delayed N min" banner above chart; widget test |
| T3 | Compact performance dashboard (win rate, P&L, expectancy, drawdown, trade count) | PARTIAL | `trading_status.js` facts (#414 merged); no drawdown/expectancy in UI | add metrics from `summarize()` in `trading_evidence.js`; unit test |
| T4 | Small expandable strategy cards (learning, win rate, P&L, comparisons) | NOT-STARTED (UI) | backend `trading_lab.js` stats exist | expandable card widget reusing summary data |
| T5 | Technical diagnostics collapsed into one "Details" section | NOT-STARTED | — | wrap existing diagnostics in one ExpansionTile |
| T6 | Trade-marker filter so chart stays readable | NOT-STARTED | chart markers already by source (`trading_chart.js`) | filter chips for source/side |
| T7 | Recorded paper entries, exits and trade details shown | PARTIAL | journal in `trading_evidence.js` / `trading_live.js` (`appendTrades`) | list rows from `/api/trading/...` journal; show only records |
| T8 | Distinct paper journals kept separate (live forward vs delayed research) | IMPL-NV | `trading_live.js` LIVE_PORTFOLIOS vs `trading_delayed_training.js` DELAYED_PORTFOLIOS; #411 merged 81a9828 | test already in `trading_live.test.mjs`; prod check needed |
| T9 | Verify PR #411 delayed paper behaviour in production | BLOCKED | #411 merged; Worker not reachable from sandbox | after deploy: `/api/trading/status` shows delayed vs live counts |
| T10 | Fix unsafe old-bar eligibility; bounded documented freshness rule | IMPL-NV | batch branch `claude/che-capability-media-age` f10a9b6: `staleBarProblems` 45-min limit, test "delayed data older than the maximum age…" | merge batch PR after #415 |
| T11 | Safe paper research; no live-execution performance claims | DONE-V (code) | `trading_evidence.js` paper-only; #411 | keep |
| T12 | Rithmic read-only until access + entitlements verified | BLOCKED | PR #410 open (`5ecf1b9`); needs owner login, system name, gateway | owner provides credentials; do not store in Worker |
| T13 | No live broker orders | DONE-V | `broker_*` modules not on paper path; `trading_controls.js` gate | keep |
| T14 | Trading Room learning engine (ES/NQ/MES/MNQ) | PARTIAL | PR #178; `trading_lab.js` | intraday feed needed (owner) |

### B. Memory, knowledge, CHE intelligence (priority 4)
| ID | Requirement | Status | Evidence / source | Next action |
|---|---|---|---|---|
| K1 | 77-reference catalogue loads on the owner's library | DONE-V (tests); prod NV | #413 merged 360ae46; `knowledge_catalog_seed.test.mjs`; chat test K1 | prod check after deploy |
| K2 | Catalogued books separated from genuinely indexed texts | DONE-V (test K1) | `knowledge_library.js` status line | keep |
| K3 | Retrieval useful for reasoning, research, coding, business, Office | PARTIAL | `knowledge_atlas.js`, `library.js`; not measured end to end | write 5 retrieval cases per area, run via replay |
| K4 | Accurate owner memories and prior conversations | PARTIAL | `personal_recall.js`, `memory_provenance.js`; tests in `chat_grounding.test.mjs` | rerun the favourite-food and memory-date cases on the phone |
| K5 | Never invent dates, memories, sources, actions, capabilities | PARTIAL | `asset_truth.js` (#415), `capability_gap.js` (batch) | verify no regressions via run_checks |
| K6 | Recover and correct misunderstood instructions | NOT-STARTED | — | define the correction route (owner says "no, I meant…") |
| K7 | Continuity CHE ↔ Claude ↔ Office agents | PARTIAL | mailbox + this file; Office `agent_runtime.js` | keep mailbox protocol |
| K8 | Previously failing exact questions verified | PARTIAL | knowledge K1, trading "why no trades" (#414), coding K4a/K4b, ad K5 | replay each on the Worker when reachable |
| K9 | Shared pgvector memory | BLOCKED | owner sets `CHE_PGVECTOR_REST_URL`/token and runs `pgvector_setup.sql` | owner |
| K10 | Office agents on one shared memory (phase 1) | NOT-STARTED | matrix 2026-10-08 | design needed |
| K11 | Soul settings as structured fields | NOT-STARTED | matrix | — |

### C. Autonomous coding (priority 3)
| ID | Requirement | Status | Evidence / source | Next action |
|---|---|---|---|---|
| C1 | EXPLORE / PLAN / BUILD classified correctly | IMPL-NV | `code_scout.js`, `coding_architecture_analysis.test.mjs`; backlog #58 | regression cases for the three modes |
| C2 | Existing tools and fallback providers | PARTIAL | `coding_failover.mjs`, `coding_runtime.js` (backlog #61 WIP) | verify failover test |
| C3 | Delegate to Office agents; report back to CHE | PARTIAL | `agent_runtime.js`; #405 routing | — |
| C4 | Real jobs, progress, error inspection, recoverable failure recovery | PARTIAL | `coding_resume.test.mjs`, `coding_cancel.test.mjs` | — |
| C5 | Commit IDs, PR links, CI results, deploy receipts shown | PARTIAL | `coding_history.js` `completedWorkProof` (#415) reads job record only | live GitHub check NOT BUILT (needs GitHub read in Worker) |
| C6 | Never claim coding work without evidence | PARTIAL | #415 K4a/K4b; `coding_receipts.test.mjs` | — |
| C7 | Truthful coding-job history | PARTIAL | job records; cancel of unauthorised job c2987a73 (backlog #80) | verify cancel done |
| C8 | Autonomy exam Round 8 (10 questions) | IN PROGRESS | matrix: reply fragmented | grade full answers |

### D. Creation, business, marketing, media (priority 6)
| ID | Requirement | Status | Evidence / source | Next action |
|---|---|---|---|---|
| M1 | Real images, ads, thumbnails, websites, videos | PARTIAL | `media.js` generateImage (Workers AI FLUX), `github_video_renderer.js` (Actions) | wire image generation to chat; return real file link |
| M2 | Real verifiable media files/links | PARTIAL | `media_library.js` (videos); media store added in batch `f10a9b6` (`saveOwnerFile`) | merge batch PR; test via /api/chat (in test) |
| M3 | Draft vs sent/posted/published/paid distinction | PARTIAL | `asset_truth.js` #415; `owner_action_gate.js` | — |
| M4 | Approvals kept for spend, send, publish, destructive | DONE-V | `owner_action_gate.js` (matrix row VERIFIED once #256 merged); `capability_gap.js` never queues money/delete | keep |
| M5 | Business Room simplified; client pipeline | NOT-STARTED | — | scope with owner |
| M6 | Real business workflows where connected | BLOCKED | Gmail/Stripe need owner connection | owner |
| M7 | Three business demonstrations | BLOCKED | need iPhone, two customer accounts, real Gmail + Stripe, owner yes per send | owner |

### E. Voice, iPhone, screen awareness (priority 5)
| ID | Requirement | Status | Evidence / source | Next action |
|---|---|---|---|---|
| V1 | Natural, interruptible voice; reliable microphone | PARTIAL | backlog #71 voice continuity DONE; barge-in in #… (realtime) | verify on device |
| V2 | Reliable wake word and stop commands | PARTIAL | `edge_voice.js`, voice tests | device check |
| V3 | ElevenLabs/Fish voice selection | DONE-V (tests, #15) | `preferred_elevenlabs_voice.js`, `fish_audio_voice.js` | device check |
| V4 | Correct voice routing and screen navigation | PARTIAL | `send.dart` navigator (preserve) | device check |
| V5 | Accessibility / VoiceOver on every button | NOT-STARTED (audit) | AGENTS.md rule | audit Flutter labels |
| V6 | Working screen awareness; authorised screen sharing | PARTIAL | backlog #89 phone-side capture (Shorebird); #86 Stage B ReplayKit NOT built (needs native IPA) | device check; ReplayKit = BLOCKED on new IPA |
| V7 | No unnecessary automatic speech / repeated responses | PARTIAL | AGENTS.md quiet rule | device check |
| V8 | Verified app-update experience | BLOCKED | #37 iPhone release metadata; Codemagic/Shorebird | owner install |
| V9 | Face ID / biometric gate | NOT-STARTED | `local_auth` not in pubspec | — |
| V10 | Device continuity handoff | NOT-STARTED | 0 files | — |

### F. Office agents and workflows (priority 6–7)
| ID | Requirement | Status | Evidence / source | Next action |
|---|---|---|---|---|
| O1 | CHE is the primary assistant; agents report to CHE | PARTIAL | `agent_runtime.js`, #405 routing | — |
| O2 | Task histories, real statuses, Brain links | DONE-V | #68 + #69 merged (per backlog) | keep |
| O3 | No fake completions / contradictory status / duplicates | PARTIAL | #82, #415 `replyRepeatsAgentTask` | — |
| O4 | Office internal communication kept out of normal chat | PARTIAL | `agent_task_guard.js` | verify |
| O5 | Office status UI and War Room visual check | NOT-VERIFIED | matrix | device check |
| O6 | 3D characters in app; immersive engine | NOT-STARTED / PARTIAL | `assets/characters/` 2.3–3 MB each; `flutter_scene` in pubspec | owner decision on size |

### G. Other owner items
| ID | Requirement | Status | Next action |
|---|---|---|---|
| G1 | CHE 2.0 navigation, War Room, Vault, agent cards (queue §3 item 3) | NOT-STARTED | scope later |
| G2 | Starred repos (six named 2026-10-11) | PARTIAL | code on `claude/che-latency-optimization-8ruaus` f527a35, unmerged; owner to confirm |
| G3 | NinjaTrader login | BLOCKED | owner sends error text |
| G4 | Gmail guest route (refuse Google from guest/private phones) | IMPL-NV | PR #412 open at `4caf185` |
| G5 | Issues #345 (full-sentence understanding), #346 (Knowledge Atlas), #347 (Creator Studio) | NOT-STARTED | per queue §3 |
| G6 | Flagstaff thread replies (kind-aware) | IMPL-NV | branch `claude/che-flagstaff-thread` 59f0d14, stacked on #412 |
| G7 | Parental guidance, car/parked location, device continuity | NOT-STARTED / UNKNOWN | matrix |
| G8 | Change history UI | PARTIAL | `truth_layer.js` changeHistoryIntent |
| G9 | Stale branch `chatgpt/postmerge-reliability-132` delete | BLOCKED | owner runs delete |

### H. Open PRs and branches at this checkpoint
- #415 `claude/che-coding-history-ads` @ `0815b37` — OPEN; merge when its 3 required checks pass.
- `claude/che-capability-media-age` @ `f10a9b6` — PUSHED, no PR; plan: open after #415 merges, title contains `[worker-deploy]`.
- #412 `claude/che-gmail-guest-route` @ `4caf185` — OPEN.
- #410 `claude/che-rithmic-screen` @ `5ecf1b9` — OPEN (blocked on owner Rithmic input).
- `claude/che-flagstaff-thread` @ `59f0d14` — stacked on #412, unmerged.

### I. Next implementation steps (in order; resume here)
1. Merge #415 when its checks are green; open and merge the batch PR (`[worker-deploy]`). Verify deploy run and `/health` (blocked from sandbox: report).
2. **Trading Room (T1–T7):** one Flutter change on `claude/che-trading-redesign` from main: compact source/freshness banner above the chart; metrics row from `trading_status`; expandable strategy cards; "Details" ExpansionTile; marker filter chips; journal rows from recorded trades only. Tests: widget test per card; a test that a delayed source shows "delayed". Verify with `flutter analyze` and `flutter test`.
3. Coding receipts live check (C5), then K3/K6 retrieval and correction cases.
4. Voice/accessibility audit (V5) and business items only after owner input (M5–M7).
5. Update this §6 status after each merge; never mark DONE-V without the test or run named in the row.

**Not verified anywhere in this checkpoint:** production Worker version, health probes (sandbox network blocked), any installed iPhone behaviour, Rithmic live data, image/video generation output.

---

## 7. OWNER PROGRAM: Premium hybrid UI, UI Studio, Dynamic Action Engine, character customization (received 2026-10-21)

Status: PROGRAM, not built. The request spans several multi-week projects (visual redesign, iOS-first layout, server-driven configuration, voice-driven editor, character generation, workflow engine). Built as vertical slices, each with tests and its own PR. Nothing below is DONE unless its row says DONE-V.

| Slice | What | Status | Evidence / next action |
|---|---|---|---|
| S1 | Palette data (CHE dark, silver and black, light) with WCAG AA tests; palette-to-ThemeData builder (`cheThemeFor`) | DONE-V (tests) on `claude/che-ui-theme-tokens` `9cfa816`; PR #417 OPEN (not merged; Dart only, needs Shorebird/IPA to see on phone; full suite 622 passed) | `lib/che_ui/che_palettes.dart`, `test/che_palettes_test.dart` (8/8). Next: wire into `CheTheme` without breaking const TextStyles (616 colour literals in 63 files; `CheColors` is static const) |
| S2 | Theme switch, instant, persisted, synced across devices | NOT-STARTED | depends on S1 wiring and a preferences store |
| S3 | Five-tab bar: Home, Chat, Office, CHE World, More (Apps moved into More) | NOT-STARTED | current nav in `lib/main.dart` / `che_immersive_hub_shell.dart`; keep every existing page reachable |
| S4 | Home as command dashboard with verified cards only | NOT-STARTED | data sources exist (jobs, PRs, Office, trading status, calendar, memory); cards must read real records |
| S5 | Chat redesign (iMessage-style bubbles, honest status, search, attachments) | NOT-STARTED | large; reuse `che_conversation_state.dart` |
| S6 | UI Studio: layout presets, move up/down, hide/resize, undo, restore default | NOT-STARTED | needs S7 storage |
| S7 | Server-driven, versioned configuration (schema, migration, rollback) stored per owner, cached offline | NOT-STARTED | new Worker route + validation; reuse existing owner-setting storage |
| S8 | Voice commands that change UI config ("switch to silver and black") | NOT-STARTED | route through the existing command catalog (`command_catalog.js`), no second router |
| S9 | Character appearance presets, reversible, moderated; unsupported requests refused honestly | NOT-STARTED | depends on asset validation; generation needs an image model: BLOCKED until owner says which |
| S10 | Dynamic Action Engine: owner-assembled workflows over existing tools, approval-gated | NOT-STARTED | reuse `workflow_governor`, `owner_action_gate.js`, existing job queue; no unrestricted script executor |

**Immediate next step (S1 wiring):** change `CheTheme.dark()` to take a `CheColorPalette` and keep the current look as the default; migrate `CheColors` getters to read the active palette only where a const context does not need them, then run `flutter analyze` and the full `flutter test`. Acceptance: default look unchanged (golden or token-equality test), silver and light palettes render with contrast checks.

**Resolved:** the `analysis_options.yaml` exclusion was reverted on the owner's instruction (2026-10-21); the checkout is clean.

---

## 8d. VOICE REPAIR CHECKPOINT (Claude, 2026-10-22 ~00:45Z) — owner's iPhone recording, one consistent voice, gapless speech

- **Status: investigation only. No code changed. Branch `claude/che-voice-continuity` was created from main `a05af09` with no commits.**
- **The owner's screen recording is NOT in this sandbox.** It was not attached to the session, and a filesystem search found no video. Next session needs the file in the repo (e.g. `mailbox/attachments/`) or a timed description (clip times, which voice, where gaps and changes were heard). Without it, the cause of the voice change cannot be tied to a timestamp.
- **What already exists (do not duplicate):** turn lock (`voiceTurnFor` in `server/cloudflare/phone_voice.js`; phone `lib/che_voice_turn.dart`); sentence-safe chunking (`cheSentenceEnd`, 640-char streamed chunks); `cheSpeakableText`; voice choice stamping (`voice_pref_v1`, `reconcileVoiceChoice`); per-clip diagnostics and "Last spoken reply" in the Voice diagnostics sheet. Source: `docs/CHE_CONNECTIONS_AND_VOICE_AUDIT.md` 2026-10-18 section.
- **Confirmed remaining gap:** the native player still prepares each clip after the previous one ends. `lib/che_native_voice.dart` calls `playClip` per clip; `tool/bootstrap.sh` generates the Swift `AppDelegate` (AVAudioPlayer, AVAudioEngine). A gapless queue needs Swift changes in `tool/bootstrap.sh` and a new IPA. That cannot be built or run in this Linux sandbox (`xcodebuild` absent). Build and install happen only through `che-iphone-ipa.yml`, then an owner device test.
- **Not verified here:** whether the owner's recording came from a build that already has the 2026-10-18 turn lock (check the release id/patch number against main).
- **Next actions, in order:**
  1. Get the recording into the repo or a timed description from the owner.
  2. Confirm the installed release and Shorebird patch on the phone (`CHE Shorebird` run for `a05af09` succeeded at 00:27Z).
  3. Design the Swift queue in `tool/bootstrap.sh` (AVAudioPlayer prepared on the next clip; keep one AVAudioSession; prepareToPlay before the prior clip ends; FIFO ids; stop/barge-in cancels queue) and the Dart side in `lib/che_native_voice.dart` (`playClipQueue`), with a mocked queue test.
  4. Ship via PR, merge with `[worker-deploy]` only if Worker files change, build IPA, owner device test against the recording.
- **Limits to report:** no device or audio evaluation from the sandbox; mocked tests do not prove audible quality; provider timbre drift across independently generated chunks is not checked (needs provider settings review and a real sample).

## 8e. VOICE REPAIR — MEASURED CAUSE (Claude, 2026-10-22 ~01:05Z) — supersedes 8d's "recording missing" for the measurements

Owner's measured recording (68.5 s, Strategy Control Center read aloud): pitch 198–203 Hz to 0:34, then 222–239 Hz with wider swings; energy above 8 kHz drops 10–50× after 0:34 (band-limited); switch lands on a clip boundary; digital-silence gaps at 0:23.6 (0.62 s), 0:33.9 (0.40 s), 0:53.7 (0.39 s); first audio at 5.2 s; clips 1–3 s after 0:34.

Code facts (main a05af09):
- ElevenLabs clips: `mp3_44100_128` (`server/cloudflare/preferred_elevenlabs_voice.js:207`), full band.
- Fish clips: MP3 at 64 kbps for everyday speech, 128 kbps only for story/narration (`server/cloudflare/fish_audio_voice.js:454`). A 64 kbps Fish clip is band-limited and is a different voice ID and model: consistent with the 0:34 switch.
- Turn lock (server `voiceTurnFor`/`premiumVoiceSpeech`; phone `lib/che_voice_turn.dart`): the lock is set only when the first clip reports its engine (`cheVoiceProviderOf`). Later clips send `lock` and get 204 instead of a different voice. So a provider switch mid-reply happens only if the phone never sent the lock.
- Fish fallback from expressive to everyday model exists (`fishAudioSpeech`), but is disabled when `locked`.
- Native player: `playClip` per clip; digital-silence gaps match re-prepare per clip (confirmed in audit).

Most likely cause (NOT yet proven): the phone build that recorded did not carry the Dart turn lock, so each clip picked ElevenLabs or Fish on its own. Check against the installed release (Shorebird patch for a05af09 succeeded 00:27Z; the recording's build must be read from the phone).

Decisive evidence to request from the owner: the Voice diagnostics sheet "Last spoken reply" line for that reply (provider tags per clip, switches, lock). If it shows an unlocked clip change, the fix is in the phone lock path; if it shows the lock held and Fish still spoke, the fix is in the Worker.

Work not started (needs the evidence above or native code): gapless native queue (Swift in `tool/bootstrap.sh`, IPA build); list/number/arrow segmentation in `lib/che_spoken_text.dart` `cheSentenceEnd` and `lib/che_stream_batcher.dart` (can be a Shorebird Dart patch); first-audio latency (first chunk size 240 chars exists; ElevenLabs 8 s timeout).

## 8f. HANDS-FREE INPUT: NO LIVE TRANSCRIPT, LONG WAIT (Claude, 2026-10-22 ~01:20Z) — owner report, not yet fixed

Owner: when talking hands-free, CHE's reply starts late, and his words are not transcribed live. He needs both.

Causes found (main a05af09):
1. **No partial text reaches the app on iPhone.** `tool/bootstrap.sh` `handleRecognition` requests partial results (`shouldReportPartialResults = true`) but only emits `wake_signal`, `barge_in` and, after the end-of-turn pause, `utterance`. `lib/home_state/voice.dart` (`type == 'utterance'`) is the only transcript consumer. So the composer stays empty until the turn is sent.
2. **Partials are dropped while CHE speaks.** `if assistantSpeaking && !bargeInDetected { return }` runs before any emit, so what he says during her speech is not shown until barge-in.
3. **Long end-of-turn wait (native path).** `endOfTurnPause` is 1.6 s (finished sentence with 4+ words), 1.8 s (≤2 words), 2.4 s (default), 3.6 s (trailing word). The Flutter-only "quick end of turn" (`cheQuickEndOfTurn`, `lib/home_state/microphone.dart`) is not used on the iPhone native path.
4. **Reply start time** adds: Worker model latency + TTS first clip (measured 5.2 s to first audio in the owner's recording). Not measured per stage yet.

Fix plan (needs a NEW IPA; Shorebird cannot change Swift):
- Native: emit `{type:"partial", text, final:false}` from `handleRecognition` before the speaking guard, throttled to changes only; keep barge-in logic unchanged.
- Flutter `lib/home_state/voice.dart`: on `partial`, show words in the composer/live caption as quiet text (no send, no speech).
- Tune `endOfTurnPause` only with telemetry (measure end-of-speech → utterance → first audio). Do not cut the owner off mid-thought.
- Bundle with the gapless-queue native work so one IPA covers both. Tests: Dart widget test for partial display; native behavior verified only on device.

Owner acceptance: speak a sentence hands-free; words appear while speaking; reply first audio measured against the stated target (<1.5 s, to be agreed).

## 8g. DEVICE EVIDENCE: CHE Updates screen (owner screenshot, 2026-10-22 07:45 local)

- Installed: CHE 1.4.1025342820, build 3956317271501, **patch 9**. Screen says "CHE is up to date."
- Not yet confirmed: whether patch 9 is the Shorebird patch for `a05af09` (run 39697919339, succeeded 00:27Z), or whether it carries the 2026-10-18 turn lock. Shorebird patches apply on app relaunch, so a relaunch may still be pending.
- Voice diagnostics (owner screenshots, 07:47 local): CHE voice (ElevenLabs) = **Out of credits**; Fish Audio (backup) = Working; last reply "Fish Audio (backup, the chosen voice failed first), 1 of 1 clips, one voice, iPhone setup about 254 ms a clip"; loudness -14.8 dBFS speech; "Why not spoken: Mary is out of credits"; hands-free Off; microphone closed. Likely cause of the recording's mid-reply switch: ElevenLabs credits ran out partway through, and the phone build did not hold the lock. Not proven. Owner decisions pending: top up ElevenLabs (spends money, owner action) or make Fish the primary voice (owner's choice).
- Next check (owner): fully close and reopen CHE, then open CHE Updates; report the patch number. If it is still 9 after a relaunch, the a05af09 patch is not on the phone, and the voice-lock question in §8e stays open.

## 8h. OWNER: "MAKE FISH MAIN" (2026-10-22)

- Owner authorized Fish as the main voice. Setting it is an owner-authenticated write to `/api/voice/choice` (device token), which the sandbox does not hold, so it was NOT applied from here. Owner taps it in the app: Voice Settings (`lib/che_cloud_voice_picker.dart`) → "CHE Fish voice (configured)" → Save.
- Verify on the phone: Voice diagnostics → "Playback engine" = Fish Audio on the next reply; the reply's "Last spoken reply" shows Fish as chosen, not as backup.
- Trade-off the owner accepted: Fish clips are 64 kbps for everyday speech (band-limited), so timbre differs from the earlier ElevenLabs voice.
- No code change, no PR for this.

## 8i. ELEVENLABS-ONLY DIRECTIVE (mailbox 6ba8419, Claude, 2026-10-22 ~01:20Z) — PARTLY DONE

- **Done (PR #426, branch `claude/che-elevenlabs-only` at `88cad38`):** Worker `premiumVoiceSpeech` (`server/cloudflare/phone_voice.js`) is strict ElevenLabs-only for conversation and Read This. Fish is only used for the authorized narration purposes (`story`, `narration`, `expressive`). A Fish lock on conversation is silent with no Fish call. Tests: `phone_voice.test.mjs` 20/20; `worker_autonomy.test.mjs` 154/154; `run_checks.sh` worker tests 3000/3000. Merge and `[worker-deploy]` deploy pending the scheduled check (trigger `trig_01QfaAtEQHBGfbLhNyuZXXbu`, ~01:27Z).
- **Not done:** native gapless queue and chunk sequencing (Swift in `tool/bootstrap.sh`; needs new IPA; not buildable in the Linux sandbox); mid-reply prequeue; per-chunk mic reinit; hands-free live partials (§8f); live ElevenLabs account and voice validation (no key in the sandbox; the owner's Worker secrets must be checked by the owner or with an authorized deploy check); owner-device audio sample; iOS IPA.
- **Conflict to confirm with owner:** earlier request "Make fish main" (§8h) is SUPERSEDED for conversation by this directive. The saved Fish choice is ignored for conversation, not rewritten. Owner to confirm.
- **Not done from directive:** no credits purchased; no plan change; no key pasted or stored in the repo.

## 8c. SOUL CHECKPOINT 3 (Claude, 2026-10-22 00:05Z) — read first, supersedes 8b's "open" items

- **Merged:** PR #423 → main `d29faab` (phone Soul controls). PR #424 (Worker provenance: `served_by`, `soul.soul_applied` true only for a model reply with the Soul in its system prompt; handler replies `soul_applied:false`, route `handler`; cache bypass marked) → main `8f4bc48`, tagged `[worker-deploy]`. Required checks were green on head `82e4af0` (analyze, Worker syntax and unit tests; `Workers Builds` ignored per owner rule). 2996/2996 Worker tests; `soul_chat.test.mjs` 11/11.
- **Deploy:** `Deploy CHE Worker` run 39697091667 queued/in progress for `8f4bc48` at 00:01Z. Verify its conclusion with `gh api repos/Vondada/chey-app/actions/runs/39697091667`. Live `/health` NOT verified from the sandbox.
- **Update 00:10Z:** `Deploy CHE Worker` run 39697091667 for `8f4bc48` = `success`. PR #425 MERGED to main as `a05af09` (checks green on `3265386`). Shorebird run for `a05af09` = run 39697919339, **completed `success` at 00:27Z** ("Shorebird patch" step succeeded; IPA steps skipped). Patch is published to Shorebird; the phone only receives it when its release matches. Device install NOT verified. "Check CHE Flutter client" run 39697919459 = `success`. IPA workflows skipped (no IPA requested). Phone NOT verified; no device install confirmed.
- **Was open PR #425** `claude/che-soul-response-details` at `3265386` (Flutter "Response details" button → Personality sheet: Soul version/fingerprint, applied or why not, model/handler, fallback). `flutter analyze lib test` clean; `flutter test` on `test/che_response_details_test.dart` + `test/che_soul_controls_test.dart` 12/12. Checks were running at 00:02Z. Merge only when `analyze` and `Worker syntax and unit tests` are green; expectedHeadSha `3265386…` (full SHA via API). Merging a lib/** change triggers `CHE Shorebird` on main.
- **Not done yet (Soul §8b items 3–5 and the iPhone/acceptance parts):**
  3. Soul consistency across Voice, Memory, Trading, Coding, Media, Office, and error/fallback replies. Deterministic handlers still say nothing about the Soul beyond `soul_applied:false`; persona prompts elsewhere in `worker.js` still hard-code personality.
  4. Publish iPhone build/patch after #425 merges (CHE Shorebird runs automatically on lib/** → main; IPA only if the owner asks). Installation on the owner's iPhone is NOT confirmed by any build.
  5. End-to-end personality tests through `/api/chat` (sliders changed → next reply differs; model fallback with real engines is NOT tested; the sandbox has fake `AI.run` only).
- **Owner acceptance A–F** (personality, emotional awareness, trading numbers, memory, media list, Soul configuration): not yet run end to end.
- **Git note:** remote `claude/che-soul-routing` holds two old commits (`65d3fe8`, `502f150`) already contained in main via #422; it was NOT overwritten. Work branches: `claude/che-soul-provenance` (merged as #424), `claude/che-soul-response-details` (#425).

## 8b. SOUL CHECKPOINT 2 (Claude, 2026-10-21 23:30Z)

- **Merged and deployed:** PR #422 (Worker Soul: soul.js, /api/soul, /api/soul/restore, chat prompt Soul block, model-reply provenance, media retrieval) → main `46f1dfb`. Deploy CHE Worker run 39690831421 `success`. Live `/health` NOT checked (sandbox proxy 403).
- **Open:** PR #423 `claude/che-soul-phone-controls` at `7c7494f` (Flutter: Soul screen edits the Worker Soul; `che_soul.dart`, `che_soul_controls.dart`, `che_brain.dart`, `main.dart`). Local: `flutter analyze lib test` clean; `flutter test` 645 passed, 1 skipped. Not built, not on iPhone. On merge to main, `che-shorebird.yml` patches lib/** automatically; a phone only gets it when its release matches.
- **Still open in Soul (in order):**
  1. Deterministic routes carry no `soul` field (only model replies do). Add a default in `ndjsonReply` (`soul_applied:false`) or leave absent, then test.
  2. Flutter "Response Details → Personality" showing soul.version, hash, soul_applied, route from the done frame.
  3. Other persona prompts in `worker.js` still hard-code personality (about lines 5346, 6328, 8814). Route owner-facing ones through `soulPromptBlock`.
  4. Verify on live `/health` version = 46f1dfb (needs a route the sandbox can reach).
- **Next action:** check PR #423 checks; merge with `[worker-deploy]`-free title (Flutter only) once green; then item 1 above.

## 8a. ACTIVE CHECKPOINT (Claude, 2026-10-21 23:00Z) — read first

- **Soul branch:** `claude/che-soul-routing` at `502f150`, **PR #422 open** (not merged, not deployed). Worker CI queued at 22:53Z; the Cloudflare "Workers Builds" failure is ignored per owner rule. Owner merge rule: merge only when Worker/Flutter/analyze checks are green; merge title must carry `[worker-deploy]`.
- **What is in #422:** `server/cloudflare/soul.js` (one versioned Soul: six traits 0-10, notes, hash, history, restore as a new version, provenance); `soul.test.mjs` 8/8; `soul_chat.test.mjs` 8/8 through `/api/chat`; `worker.js`: `/api/soul` GET/POST and `/api/soul/restore` (owner device only, placed before the `/api/brain/` block), chat prompt carries `soulPromptBlock`, phone "CHE SOUL" text stripped from brain context, model `done` frame carries `soul` provenance.
- **Also in #422:** media retrieval (`65d3fe8` + later edits): exact owner store request lists all records, verifies bytes, "show me the last picture" returns `media_url` image. Tests: `media_retrieval.test.mjs`, `media_store`, `media_save`, `media_library`, `readonly_acceptance`.
- **Tested:** `run_checks.sh` Worker tests 2993/2993 on the branch (before commit `502f150`'s push, same tree).
- **NOT done (next edit, in order):**
  1. Flutter Soul controls: `lib/che_ui/che_brain.dart` `_SoulScreen` (line ~858) still edits the local text file. Replace with a Worker-backed panel: six sliders (VoiceOver labels, "7 of 10"), notes field, Save → `POST /api/soul`, history list with Restore → `POST /api/soul/restore`, visible error banner. Needs the device token: thread `headers: () => _authHeaders` and `baseUrl: () => cheAgentBaseUrl` from `lib/home_state` into the Brain screen (`_SoulScreen` is built at che_brain.dart:771 from a widget that only has `brain`). Run `flutter analyze` and `flutter test` with `/opt/flutter-sdk/flutter/bin`.
  2. Response Details → Personality: show `soul.version`, `soul.hash`, `soul_applied`, `route` from the done frame (not yet in Flutter).
  3. Deterministic routes do not yet carry a `soul` field (only model replies do). Decide: add `soul_applied:false` default in `ndjsonReply`, or leave absent.
  4. Remaining Soul prompt paths: other personas in `worker.js` (about lines 5346, 6328, 8814, 11891 region) still hard-code personality; route them through `soulPromptBlock` only where the reply is owner-facing.
- **Media follow-up:** `readonly_acceptance` video phrase fixed (video override limited to picture words).
- **Shorebird:** run 39684505690 for PR #421 concluded `success` at 22:26Z on main `a88fe01e`. Phone install NOT verified.
- **Exact next action for the next agent:** `gh`-free: `mcp__github__pull_request_read` on #422 (`get_check_runs`); if green and merged by owner, verify `/health` version; then do item 1 above on a new branch from main (not from #422 unless #422 is merged).
- Secrets: none in this checkpoint.

## 8. OWNER PRIORITY OVERRIDE — SOUL FIRST AND AI-TO-AI RESUME (2026-10-21)

**Owner instruction:** Finish CHE's consistent Soul/personality routing FIRST. Then continue *all* remaining owner-authorized CHE work across bounded, independently verified implementation slices. Never stop merely to write a plan. If Claude reaches a limit or any AI stops, make its partial implementation durable so ChatGPT/Codex/another available agent can resume from the exact verified point, without rereading or rewriting everything.

**Current source of truth (checked 2026-10-21):** main \`a88fe01e2f5c13d19b4d6982c09408a50d5138e9\` (PR #421, Flutter palette wiring and saved theme switch, merged). PR #420 merged \`a3a8101c39bbe0f34b7addf441231e6416708482\` (owner image MIME fix, false "forget" delete hold, fact-grounded performance intent, tests). Deployment run 39680293427 had successful Worker Deploy and Verify live deployed commit, but that does NOT prove a new iPhone build or Soul integration. PR #417 merged (theme tokens); #418 merged (questions are not memory facts); #419 merged (trading phrasing). At this checkpoint, Github query returned no open PRs. **§6 old "open PR" data and §7 S1/S2 statuses are stale; this paragraph supersedes those older snapshots.** Always recheck GitHub before acting. UI Home/navigation/Creation Room/UI Studio are still incomplete, regardless of stage-1 palette work.

### FIRST IN QUEUE: Soul/personality end-to-end, not another planning document

Goal: CHE feels like one mature, warm, confident, natural, observant woman who is lightly playful in relaxed contexts and precise in serious ones; occasional "sir," no repetitive gimmicks. Written name CHE, "Chay" spoken wake only. Personality **never changes factual evidence, permission gates, role auth, or trading/reporting numbers.**

1. Trace REAL request path: Flutter Brain→Soul (\`lib/che_ui/che_brain.dart\`), payload (\`lib/home_state/streaming.dart\`), Worker (\`server/cloudflare/worker.js\`), AI/model fallback (\`ai_router.js\`), direct/deterministic routes (trading, memory, coding, media, Office), and voice. Existing phone sends \`body.soul\` but Worker doesn't consistently apply it in all owner-facing paths. DO NOT invent a duplicate Soul or a parallel router.
2. Make a canonical, versioned owner-editable Soul contract; implement a safe deterministic presentation adapter for tool facts and conversational generation for ordinary talk. Ensure a provider switch preserves identity. Owner can change warmth/playfulness/formality/directness/verbosity/proactivity from Soul, persisted and available on next appropriate reply. Keep ability to restore previous version; do not sync secrets or private prompts to unauthorised devices.
3. Add verifiable response provenance: response route, actual source/model/handler, Soul version/hash, \`soul_loaded\`, \`soul_applied\`, and fallback/bypass reason in diagnostics; NEVER mark Soul applied just because it was supplied in payload. Offer "Response Details → Personality" or equivalent accessible owner UI. Never expose secrets or chain-of-thought.
4. Run paired \`/api/chat\` + Flutter/voice route tests using exact owner's phrases:
   - "CHE, forget all the technical stuff for a minute. Talk to me normally. What's your personality like? Show me, don't just describe it." Must NOT enter deletion confirmation.
   - "CHE, I'm frustrated because we've spent so much time building you, and you still don't feel like the assistant I imagined. What would you say to me?" Warm, relevant, not canned.
   - "CHE, tell me how my paper trading is going. Talk to me naturally, like my assistant, not a technical report. Don't leave out the real numbers." Verified paper ledger only. NO fabricated +12.5% returns, 3.5 trades/day, January wins or drawdowns.
   - owner changes Soul voice/style settings and immediately asks same prompt; verify effective configuration changed in response metadata, not just generic model fluctuation.
   - missing memory/media/tool/provider returns a truthful, warm refusal with correct evidence and no fake action.
5. Implement, commit, open focused PR(s), review/test, merge only green, verify Cloudflare live \`/health\` matches SHA, and deliver Flutter/Shorebird/IPA if needed; owner iPhone behavior remains UNVERIFIED until tested there. Personality correctness is a **release gate** for this priority.

### THEN CONTINUE: full project completion, in dependency order

A. Chat-to-media read/list/detail: owner iPhone saved PNG, then got "I hold 1 saved file" vs "I now hold 3 items"; uploaded-file count and all-media count use different filters (must be named). EXACT request "CHE, list every saved media item by its actual ID, filename, type, and creation date. Tell me which are uploads and which were generated. Verify that my latest PNG is still stored." currently MISSES \`mediaHoldIntent\` in \`server/cloudflare/media_library.js\` and falls through to a model claiming no library access. Implement authenticated factual listing/IDs/source/type/creation, bytes verification, inline Chat image rendering, Creation Room shared gallery, reopening persistence. Reuse \`media.js\`, not a second store; no fake assets or unauthorized spend.

B. Premium silver/black UI beyond merged stage-1 palette: Home dashboard, Home/Chat/Office/CHE World/More bottom navigation (Apps in More), accessible no-code UI Studio and persistent settings, Creation Room makeover. Confirm latest Shorebird patch or IPA before asking owner to retest visual changes. Preserve older screens and all VoiceOver navigation.

C. Trading: reconcile distinct entries vs variant outcomes and reporting windows; preserve delayed hypothetical research vs authenticated real-time paper and broker account separation; remove fabricated performance paths; learn from after-cost evidence, journal all outcomes; NEVER enable live orders without explicit owner-authorized connection and action. Test data provenance and live feed gating.

D. Coding autonomy: real job/PR/CI/deploy receipts and failure recovery/fallback; no fake complete. Office agents and command routing; Knowledge Library beyond its 77 **metadata-only** entries only when legal text is actually provided; memory recall/provenance; videos and businesses; owner authorized abilities and accessibility. Respect external account/service blockers instead of claiming completion.

### MANDATORY HANDOFF ON EVERY INTERRUPTION OR TOKEN LIMIT

Before the session ends, push each working commit and write a **fresh "ACTIVE CHECKPOINT" at the very top of this §8** (or an immediately linked small companion file) on \`che-mailbox\`. It MUST include:
- exact main SHA; active branch/commit/PR links, head/base, outstanding checks, blockers and failures;
- what files/functions changed and what was actually tested (including test command/output);
- what is verified merged, what is verified deployed on Worker (\`/health\` version), what iPhone build/patch is merely published vs actually installed and tested;
- precise **next edit, file, and command** an incoming agent should run; remaining acceptance tests in priority order;
- no user passwords/secrets, no invented claims, and no duplicate code/routers.
- update outdated §6/§7 checkboxes/statuses after each merge, not only new prose.

**Resumption command for any agent:** "Continue CHE from \`AGENTS.md\` and the newest \`che-mailbox:mailbox/briefs/LIVE-HANDOFF.md\` §8 checkpoint. Inspect real \`main\`, live PRs/Actions and personal mailbox. Resume the highest-priority unfinished verified edit; Soul is first. Do not restart, re-implement merged changes, claim deployments without evidence, or silently skip blocked work. Commit/push/checkpoint before your session runs out."

**Execution reality:** Context/usage and CI interruptions cannot be abolished, and parallel agents must avoid editing the same files or racing deploys. Independent nonconflicting slices may be worked on in parallel but Soul release remains the first priority. Do NOT launch unattended paid agents or claim continuous work once the interactive session stops.
