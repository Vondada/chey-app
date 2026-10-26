# CHE full application audit checklist

Persistent record for the full-app audit and repair mission (owner, 2026-10-26). Every interrupted session resumes
from this file. Status words are literal: **verified** (with evidence), **partial**, **broken**, **not built**,
**unknown** (not yet checked). Nothing is marked verified without a test, log, screenshot or commit that proves it.

## Batch 1: inventory and baseline (branch `audit/full-app-batch1`)
- [x] Worker test suite baseline (`node --test ./*.test.mjs` in server/cloudflare, main 88677a97): **verified**: 4165 tests, 4156 pass, 0 fail, 7 skipped, 2 todo (run 2026-10-26)
- [ ] Flutter screens and routes inventory: **unknown**
- [x] Worker routes inventory: **verified by static read** (agent report, 2026-10-26): routes in worker.js and server/cloudflare route modules; not run live
- [x] GPU stack state: **verified by static read**: Modal full code path; Colab only while owner keeps notebook open; Kaggle, Hugging Face, RunPod code paths behind credentials/budget, none live-verified; GitHub CPU, Blender, video and film workflows exist
- [x] Brain Room and agent inventory: **verified by static read**: owner reference image not in repo; Orion and Vale have no asset; other 8 agents have GLBs and seats
- [ ] Open PRs and their CI: **unknown**

## Batch 2: navigation and critical crashes
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
