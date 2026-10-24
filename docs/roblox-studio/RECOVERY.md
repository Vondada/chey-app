# Roblox "tonight" projects: recovery audit (2026-10-24)

Owner's request: "Recover and finish every 'Roblox game studio — tonight' project … never claim playable without a
verified build."

## Where the projects come from
Every "build a Roblox game …" (voice, chat or `POST /api/office/roblox`) ran `officeRobloxJob` (worker.js). Each run:
- added a new project titled `Roblox <catalog> studio — tonight`;
- queued two or three crew tasks (Atlas for Luau, Nova for the listing, Lyra for the creative brief).

The project's own text is a fixed template: owner gates, "tonight deliverables" and a capability note. It contains no
code. Asking twice therefore made two identical cards. The only real game code these projects can hold is in their
crew tasks' results.

## What is in the repository
| Path | What it is | Status |
|---|---|---|
| `docs/roblox-studio/README.md`, `TONIGHT.md`, `PLAYBOOK.md` | The service line, its owner gates, the voice phrases | Docs |
| `docs/roblox-studio/ugc/CLOTHING_BRIEF.md` | Clothing/UGC brief | Docs |
| `docs/roblox-studio/luau/WeaponToolBase.luau` (93 lines) | Tool swing and damage stub | Stub. It damages on the client, which other players never see. Never built. |
| `docs/roblox-studio/luau/CombatStub.luau` (25 lines) | Melee module stub | Stub: its hit query is a placeholder |
| `docs/roblox-studio/luau/GamePassStub.luau` (35 lines) | VIP pass check | Stub: the pass id is 0, so it is inactive |

No `.rbxlx`, Rojo project, screenshot, render or playtest record existed before this change. The stubs are kept unchanged.

## What this change adds
**`roblox/che-blade-arena`**: a real Rojo game grown from the stubs.
- A Tool with a Handle that the player clicks to swing.
- Server-authoritative damage with range and cooldown checks.
- Four respawning training dummies.
- A knockout leaderboard.
- `.github/workflows/che-roblox-build.yml` compiles every script with `luau-compile` and builds `che-blade-arena.rbxlx`
  with Rojo. The tools are pinned by version and SHA-256, and the place file is the `roblox-places` artifact.
- Status: builds and compiles in CI. Not playtested, so it is not called playable.

**Project manager (`server/cloudflare/project_library.js`, Create → Active Projects)**
- Every stored Roblox copy is behind one card per distinct request. All copy ids are listed and their histories merged.
  Nothing is removed.
- Each card shows its crew tasks, their status and the Luau scripts actually found in the results.
- A Roblox project's request asked again now adds its crew tasks to the same project, not a new card.
- **Place file** builds an `.rbxlx` from those scripts and saves it to Files → On My iPhone → CHE → Roblox. The
  response says `X-CHE-Verified: false`.
- **Continue** queues one Atlas task on the same project, asking for complete Luau in `-- name:` blocks with
  server-side validation, and never publishing or spending.

**Deploy audit**: the "Projects audit" notice on each Worker deploy. It reports how many Roblox projects, stored copies,
scripts and crew results the owner's CHE really holds, as counts only.

## How to open a game in Roblox Studio (Windows or Mac)
1. Repository game: download the `roblox-places` artifact from the latest green "CHE Roblox build" run.
   A crew project: in CHE, open Create → Active Projects, then the project's **Place file** (saved in the Files app;
   AirDrop it to the computer).
2. In Roblox Studio, go to File → Open from File, choose the `.rbxlx`, and press Play.
3. Publishing, game passes and Robux stay the owner's own steps. CHE never uploads.

## Not verifiable from here
- Which crew tasks on the live Worker contain Luau. The audit counts them on the next deploy.
- Any playtest. Roblox Studio is desktop-only and nothing here has run the game.
