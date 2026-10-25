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

## Infrastructure facts (inspected, not assumed)
- Cloudflare Worker: queue, storage, routing only. No GPU, no Blender.
- Free GitHub Actions CPU worker (ubuntu, 4 cores, Blender 5.0.1, MPFB2): verified live. Run 40153146586 built a
  full-body rigged GLB in 1.4 min (23,946 vertices, 5 clips).
- GPU: none on the Worker, none on GitHub-hosted runners, none in this dev container (`nvidia-smi` absent). The owner's
  Colab T4 joins only while its notebook is open. Free Colab cannot be started unattended (`docs/CHE_CLOUD_COMPUTER.md`).
  Kaggle and Hugging Face need accounts and tokens, which the owner ruled out. So the CPU worker is the default.
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
- 2026-10-25: checklist + contract `b3b664b`; e2e storage fix `4ad45c9`; lanes A and B started and later extended to G3–G8.
