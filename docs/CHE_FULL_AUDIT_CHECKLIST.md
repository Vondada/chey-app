# CHE full application audit checklist

Persistent record for the full-app audit and repair mission (owner, 2026-10-26). Every interrupted session resumes
from this file. Status words are literal: **verified** (with evidence), **partial**, **broken**, **not built**,
**unknown** (not yet checked). Nothing is marked verified without a test, log, screenshot or commit that proves it.

## Batch 1: inventory and baseline (branch `audit/full-app-batch1`)
- [x] Worker test suite baseline (`node --test ./*.test.mjs` in server/cloudflare, main 88677a97): **verified**: 4165 tests, 4156 pass, 0 fail, 7 skipped, 2 todo (run 2026-10-26)
- [x] Flutter screens and routes inventory: **verified by static read** (100 rows, 2026-10-26). Honest 'not connected' states are common. Fake or placeholder items found: Office workflow bar fixed 0.55/0.22/0.82 (FIXED in batch 2); Business hub 'Ready' labels (FIXED in batch 2, now 'Opens chat'); Projects board fractions only colour the 'done' state, no bar drawn (not a visible fake, left as is); ML studio sends sample prompts (open); Capability Showroom defaults to 'Planned' (open); che_preview.dart and che_agent_chat.dart are not routed (open); about 20 screens have no test reference (open).
- [x] Worker routes inventory: **verified by static read** (agent report, 2026-10-26): routes in worker.js and server/cloudflare route modules; not run live
- [x] GPU stack state: **verified by static read**: Modal full code path; Colab only while owner keeps notebook open; Kaggle, Hugging Face, RunPod code paths behind credentials/budget, none live-verified; GitHub CPU, Blender, video and film workflows exist
- [x] Brain Room and agent inventory: **verified by static read**: owner reference image not in repo; Orion and Vale have no asset; other 8 agents have GLBs and seats
- [ ] Open PRs and their CI: **unknown**

## Batch 2: navigation and critical crashes
- [x] Office workflow progress: fixed-fraction bar replaced with indeterminate bar and the real state name. Tests: che_office_board, che_office_tiles, che_office_polling, che_rooms, che_hud_world_golden all pass (22/22, 2026-10-26). Branch audit/full-app-batch1.
- [x] Business hub status labels: 'Ready' replaced with 'Opens chat' (both rows start a chat). Covered by the same test run.
## Batch 3: Brain Room and agents
## Batch 4: GPU and rendering (acceptance: a real, playable MP4 of CHE's 3D character in Creation Room)
- [ ] Calibration 60 s render on free runner: run 40263142326 succeeded; MP4 not downloadable from sandbox (**unverified** playability)
- [ ] Modal video route: **not built**
- [ ] Modal spend stop at $5: **not built** (owner decision pending)
## Batch 5: performance and voice
## Batch 6: Trading Room
- [ ] Phase 1 Heikin-Ashi, MACD, ATR math: **verified** by tests on feat/trading-chart-phase1 (6/6); **not wired** into the chart
- [ ] Phases 2-4 (orders): **not started**, owner approval required
## Batch 7: remaining pages and integrations
- [ ] Google sign-out command (fix/gpu-google-signout): **verified** by tests (7/7 browser); not merged, no PR
- [ ] Safari button for Colab (feat/gpu-open-in-safari): **verified** by tests (7/7 browser); not merged, no PR
- [ ] Google sign-in in CHE's embedded browser: **broken** (Google refuses); Safari route built, not verified on iPhone
## Batch 8: full regression and iPhone validation
- [ ] iPhone install of latest IPA: **unknown**; IPA build for 0cc2803c was skipped
- [ ] Shorebird patch for 0cc2803c: success (run 40254061441)

## Coding intelligence
- [ ] Coding tests (6, mailbox 2026-10-26): 0 of 6 answered; all six replies are the failed-answer fallback. **broken**. Root cause in worker.js replyToFlagstaffMessageOnce (status 'failed'); reason is in live storage only.

## Owner decisions (2026-10-26)
- Brain Room: the owner's reference image is saved at docs/ui-refs/brain-room-owner-reference-2026-10-26.png. Make the 3D brain the dominant element, keep the sidebar, Real-Time Learning, cards. Status: **not started**; next batch.
- Modal: validate existing credentials without reading values. Verified evidence: last successful deploy run 40238828084 (connect and GPU test steps passed). The sandbox proxy cannot list GitHub secret names (403), so current presence is **unverified**. No billable GPU run without separate approval. A $0 spend limit does not by itself permit GPU execution.
- Google: use the existing CHE Office account. Check the existing session first. Status: **unknown** from the sandbox; the owner must confirm on the device.
- Trading: paper only, Phases 2-4 research, backtesting and paper. MNQ first, then NQ, MES, ES. No live orders.
- Orion and Vale: keep both. Create real GLB models in the existing character style. Status: **not started**; they have no model files.
- iPhone: Shorebird for Dart-only changes where supported; IPA only when native code changes. Do not claim an install unless the device reports it.
- Coordination: PR #640 (ChatGPT, fix/che-character-render-python-deps) changes .github/workflows/che-real-3d-preview.yml. Do not edit that file here.

## Batch 3 status (2026-10-26)
- Brain Room render (phone size, current code, docs/ui-refs reference): the brain is a small faint constellation in the middle of the screen, with empty space above and below. Not the large glowing brain of the reference. Tried moving the overview camera closer (17 to 12): the rendered image did not change, so camera distance does not set the brain size here. Reverted. Next: find what sets the brain's on-screen size in CheBrainSpace / CheBrainPainter (lib/brain/che_brain_space.dart).
- iPhone release path (read-only inventory): che-iphone-ipa.yml builds only when the commit message has [ios-build]; che-shorebird.yml patches on lib/ changes; che-ipa-release.yml publishes. Asset changes need a full IPA (docs/CHE_READINESS.md:149), but che-shorebird.yml also fires on assets/**. Newest published IPA tag: che-ios-v1.4.1025342820-b3956317271501 (2026-10-21). Newest Shorebird patch recorded in docs: 12 (run 40135088615); a later run 40254061441 succeeded for 0cc2803c. Which release the owner's phone runs is not verified here: check the CHE Updates screen.
- Trading backtest inventory (read-only): strategy_sim.js (minute paper sim, next-bar fills, OOS split, no roll handling); backtest_matrix.js (NQ historical, signal-bar close fills); trading_evidence.js (walk-forward, promotion rules, daily results cannot promote); trading_research.js (roll handling, cached datasets, regimes measured not used to gate). Two MNQ cost models disagree. No stored historical dataset in the repo; bars are fetched at run time. Strategy coverage: EMA 20 pullback, VWAP band reversion, liquidity sweep, opening range, RSI, inside bar, fair value gap all have code rules; market structure is partial; support/resistance has no entry rule; regime filters are trend-only.
