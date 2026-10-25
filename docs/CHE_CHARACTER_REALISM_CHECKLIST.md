# Character creation: requirements, progress and handoff (read this first after any restart)

Branch: `claude/che-character-realism` (from main `afb8de1`). Lanes push to `lane/char-photo` (Python/Blender) and
`lane/char-photo-app` (Worker + app). A box is ticked only with evidence: commit, test command + count, or run id.

## Owner requirements (recovered 2026-10-25 from this conversation, LIVE-HANDOFF and code; not invented)
1. One Create button makes customizable characters in three styles: hyperrealistic, game-like, stylized.
2. Inputs: text description, optional reference images, appearance, clothing, body, hair, style, voice (where supported).
3. Real assets for CHE's animation workflow (rigged GLB with clips), preview, saved results, regeneration, reopen.
4. Open-source tools and appropriately licensed models; available compute only. No new API keys, paid services,
   accounts or ongoing manual setup. Preserve existing integrations and CHE's internal APIs.
5. Detect whether a usable GPU exists; otherwise a working CPU fallback with its limits shown honestly.
6. Jobs continue on the server when the app closes; progress saved; retries; finished files viewable in CHE.
7. Measure render time; never promise minutes or photorealism without a produced, inspected sample.
8. Voice-first owner (AGENTS.md): VoiceOver labels, voice/typed route for every action, passive screens silent.
9. Reference photos only of the owner or fictional/generated images; never other real private people or minors
   (owner's earlier photos of private people were declined on 2026-10-24 and are not stored).
10. Flow to test end to end: Create → generate → customize → preview → animate → save → reopen. Real samples per style.
11. Merge when required checks pass; report merge SHA, samples, deploy status, limits; iPhone kept separate.

12. Owner acceptance tests (2026-10-25), all through the real flow, never screenshots/placeholders/queued jobs:
    A1 three distinct styles generated and shown; A2 a synthetic reference changes facial features beyond colours;
    A3 hair, clothing, height, build each verified on the saved model (before/after); A4 play animation → save → close
    viewer → reopen same character; A5 app closed mid-job, server finishes, result retrieved on reopen; A6 works without
    this dev session, no new keys or notebook; A7 host, CPU/GPU, time, failures, files recorded; VoiceOver + spoken status.
    Driver: `tools/creation_accept.mjs`, run by che-worker-deploy.yml input `character_accept`; samples pushed to the
    `che-character-samples` branch (Actions artifacts are unreachable from this container).
13. Quota-aware compute pool (2026-10-25): reuse only existing authorized connections and saved credentials; verify
    Blender support per provider (film support is not proof); handoff, checkpoint recovery, quota cooldowns, bounded
    retries, CPU fallback where compatible; preserve waiting jobs with a reason; $0. Prove handoff with real files.
    Document providers that would need new keys/setup. Lane C `lane/char-pool`.
14. CHE World population: reproducible seeded descriptions, shared rigs/assets, cached variations, detail on demand;
    distinguish records vs generated models vs simultaneously active characters; benchmark generation, storage and
    world performance; "millions per day" is an unverified target. Lane D `lane/char-world`.

15. Create Room demonstration (2026-10-25): playable video (not a still) + walkthrough of the finished experience:
    describe/reference → Create → three styles → rig, expressions, lip-sync → walk, turn, sit, gesture, speak → change
    hair/clothing/body/voice (say what preserves rig) → in CHE's Office → save, reopen, use. Every segment labelled
    REAL / PROTOTYPE / NOT AT $0. Lane E `lane/char-demo`; doc `docs/CHE_CREATE_ROOM_DEMO.md`.

16. GPU Connect (2026-10-25): "Connect GPU" → CHE operates Colab Connect in its existing browser with the CHE Office
    Google account preferred, session kept across screens; sign-in/confirmation steps handed to the owner then resumed.
    Verify separately: right account, Colab GPU runtime, fresh worker heartbeat, a real test job completes and opens.
    "GPU connected" only after the heartbeat. No promise of permanent Colab; jobs/checkpoints survive disconnects.
    Lane F `lane/gpu-connect`; doc `docs/CHE_GPU_CONNECT.md`.
17. Realism + cinematic (2026-10-25): one Create workflow → optimized interactive rigged model AND cinematic videos of the
    same character. Blender/Cycles, MPFB2, existing skeleton (+Rigify/retarget only if needed), licensed mocap clips,
    blending, foot contact, natural transitions; facial shape keys, blink, eyes, expressions, speech-driven mouth
    (evaluate Rhubarb, MediaPipe); licensed skin/eye/hair/cloth/lighting assets (Poly Haven etc.); local ComfyUI/Wan2.2
    only with a GPU, paid nodes disabled. First a real 15–20 s sample (walk in, turn, sit, gesture, speak, close-up,
    skeleton overlay) + rigged model; honest comparison with the owner's two reference videos. AI video is never proof
    of rig motion. Lane G `lane/char-realism`; doc `docs/CHE_REALISM_STACK.md`.
    References received and inspected 2026-10-25: notes in `docs/CHE_REALISM_REFERENCES.md` (AI-generated drama
    footage; the target for the cinematic path).

18. Master profile form filling (2026-10-25): "CHE, use my master profile" fills whole forms from approved Personal and
    CHE Office profiles plus the on-device vault; passwords never leave the device; multi-page, dropdowns, dates,
    remembered answers; never invent; CAPTCHA/verification handed to the owner with the form preserved; fill and submit
    are separate; verify DOM values and report what is unfinished. Lane H `lane/master-profile`; doc
    `docs/CHE_MASTER_PROFILE.md`.

19. Service/AI-provider connect (2026-10-25): "connect <service>" → generated strong password into the on-device vault,
    provider API key created where automation is supported, moved straight into its execution store (Worker key store
    for AI providers) without entering model context/chat/logs/screenshots, validated with a free minimal test,
    redacted status only; minimum scopes; reuse existing; keep the old key until the new one verifies; CAPTCHA/owner
    auth handed over and resumed; $0. Lane H (extended).

## Infrastructure facts (inspected, not assumed)
- Cloudflare Worker: queue, storage, routing only. No GPU, no Blender.
- Free GitHub Actions CPU worker (ubuntu, 4 cores, Blender 5.0.1, MPFB2): verified live. Run 40153146586 built a
  full-body rigged GLB in 1.4 min (23,946 vertices, 5 clips).
- GPU: none on the Worker, none on GitHub-hosted runners, none in this dev container (`nvidia-smi` absent). The owner's
  Colab T4 joins only while its notebook is open. Free Colab cannot be started unattended (`docs/CHE_CLOUD_COMPUTER.md`).
  Kaggle and Hugging Face need accounts and tokens, which the owner ruled out. So the CPU worker is the default.
- Deploy run 40152765240 env: HF_TOKEN, CHE_COMPUTER_URL/TOKEN, CHE_VMWARE_TRAINING_*, CHE_HF_TRAINING_* are empty
  repository secrets. A Kaggle token could only exist in the owner's in-app Keys; checked live by the pool probe.
- The browser and WebView do no generation; the phone only views GLBs (three.js `studio.html`).

## Already working before this branch (code verified)
- [x] Server queue survives app close; checkpoints, resume and retries (`gpu_queue.js`, `che_creation_job.py`).
- [x] Honest GPU detection, no silent CPU fallback on the GPU path (exit 3).
- [x] Three styles in the identity (`avatar_identity.js` STYLES photoreal | hybrid | stylized; `identity.py`).
- [x] Versions with undo/redo/save; Generate queues `person_model`; the Live Studio viewport plays clips.
- [x] Rigged full body: 53 bones, idle/walk/run/wave/talk, verified on re-import.
- [x] `final` render profile: subsurface skin, procedural pores, OIDN.

## Gaps and status
| # | Gap | Lane | Status |
|---|---|---|---|
| G1 | Reference photo → face shape + skin/hair/eye colours | A + B | B done `e6d71b4`/`ede954f` (upload, consent, REFERENCE, worker-only fetch, receipt surfaced, app UI); A pending |
| G2 | Device + CPU-limits + measured time shown to the owner | A + B | B done `e6d71b4` (device_line from receipt.device_summary, CPU never GPU); needs A to send device_summary |
| G3 | Only long_wavy hair has geometry (other 7 styles render bald) | A | in progress |
| G4 | Body: only age (no gender, height, weight, muscle, proportions) | A + B | B done `789e155` (BODY_* settings, omitted at default); A must read them |
| G5 | Free-text "describe a person" → one Create | B | done `789e155`, `ede954f` |
| G6 | Voice per character from the existing voice catalog | B | done (on-device Kokoro list) `789e155`, `ede954f`; iPhone playback unverified |
| G7 | Regenerate/variation; reopen from My Creations | B | done `789e155` (VARIATION seed + face variant, last_model), Flutter reopen test `6712d12` |
| G8 | Real samples per style, inspected; measured CPU times | A | in progress |
| G10 | Acceptance driver + publish job | me | pushed `6651850`; lane B accept routes merged |
| G11 | Compute pool (providers, cooldowns, handoff) | C | merged (lane C `5de754f`); compute_pool 10/10, Worker 4001/0; live handoff with real files NOT yet proven; Kaggle token presence unknown |
| G12 | World population + benchmarks | D | in progress |
| G13 | Create Room demo video + walkthrough | E | in progress |
| G14 | "Open and display saved image <id>" listed all 26 media items | me | fixed `dfd3f48`: Worker 19/19 media tests, full Worker 3990/0; Flutter che_chat_image 2/2; iPhone display unverified |
| G15 | GPU Connect flow with 4 separate verifications | F | in progress |
| G16 | Realism stack + 15–20 s CHE sample | G | in progress |
| G17 | Master profile form filling | H | in progress |
| G18 | Service/AI-provider connect adapters | H | in progress |
| G9 | e2e server "k.startsWith" (research queue never ran in e2e) | me | done `4ad45c9`; e2e 2/2 |

## Integration and release
- [ ] Merge lanes in dependency order (A then B); sync HAIR_BUILT in JS and Python (parity test).
- [ ] Full Worker suite, full Flutter suite, Python suites, analyze: all green locally.
- [ ] PR; required checks green on the exact head; review threads answered; merge.
- [ ] Deploy verified live; creation_check run with this code; sample receipts.
- [ ] Full IPA if native code changed (not expected).
- [ ] iPhone: NOT VERIFIED until the owner tries it.

## Log
- 2026-10-25 lane B: Worker suite 3985 pass / 0 fail / 7 skipped; Flutter character + studio tests 62 pass; acceptance probe routes `7dfc2d0`.
- 2026-10-25: acceptance tests + compute pool + world population added (req 12–14); lanes C and D started.
- 2026-10-25: checklist + contract `b3b664b`; e2e storage fix `4ad45c9`; lanes A and B started and later extended to G3–G8.
