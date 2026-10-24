# CHE World dual-mode game — phase 1 handoff

Owner wants **both** GTA-like third-person free roaming and Sims-like overhead office management in one coherent CHE World, not two apps. Keep all real AI tasks and statuses separate from game animations; never simulate work as if executed. Preserve existing characters, avoid generic mannequin scenes, iPhone accessibility, and performance.

## Implemented
- Branch `feature/che-world-dual-mode-prototype` commit `2a188632a73d146bdd07a51c758878051a4c1ae2` changes `assets/characters/app/index.html`.
- Adds **Free Roam** and **Manage Office** buttons, third-person follow vs overhead office camera, hides movement joystick in management mode, exposes `window.CHE.setWorldMode` and `window.CHE.worldMode`.
- Existing `CheCharactersRoom` WebView loads the same asset; no new engine or duplicated office. Existing 3D agent GLBs and runtime states preserved.
- NOT YET TESTED, MERGED, DEPLOYED, OR VERIFIED ON IPHONE. No Colab GPU required for runtime camera switching.

## Next steps for Claude/Codex
1. Read AGENTS.md and LIVE-HANDOFF, inspect branch, run HTML JS syntax and Flutter tests. Fix issues before PR.
2. Improve overhead management camera: tap agent to see real status and task actions, pan/zoom, accessible mode announcements, return to free roam at the selected agent. Do not create fake jobs.
3. Replace mannequin placeholders only with genuine assets as ready; use useful non-character interfaces until then.
4. Connect office room doors to existing real Create/Film/Music/Code screens without duplicating flows. Keep Film Studio in Create.
5. Build actual iPhone interaction tests, benchmark frame rate and accessibility. Merge only green; prepare iPhone patch and verify installation separately.
6. Keep GPU asset creation separate: Colab T4 generates Blender assets, iPhone GPU renders real-time scene.
