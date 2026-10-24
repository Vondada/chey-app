# CHE Blade Arena (Roblox)

The first real game from the "Roblox game studio — tonight" line. It grew from the tonight stubs in
`docs/roblox-studio/luau/` (`WeaponToolBase`, `CombatStub`). The stubs are kept unchanged. This version fixes the
stub's main flaw: the stub applied damage on the client, so other players never saw it. Here only the server applies
damage, after its own range and cooldown checks.

**What is in it.**
- A baseplate and a spawn.
- `CHE Blade` in StarterPack (a Tool with a Handle). Click to swing. The client finds what is in front of the player
  and asks the server through `ReplicatedStorage.SwingRequest`.
- The server (`ArenaServer`) spawns four training dummies in a ring, validates each swing, applies damage, counts
  knockouts on the leaderboard and respawns dummies after 5 seconds.
- `BladeConfig` (ReplicatedStorage) holds the numbers both sides use.

**Build it.** `.github/workflows/che-roblox-build.yml` runs:
- the structural check, `tools/roblox_check.mjs`;
- `luau-compile` on every script;
- `rojo build`, which turns this folder into `che-blade-arena.rbxlx`, uploaded as the `roblox-places` artifact.

Locally: `rojo build roblox/che-blade-arena -o che-blade-arena.rbxlx`.

**Open it in Roblox Studio** (Windows or Mac; Roblox Studio does not run on iPhone):
1. Download the `roblox-places` artifact from the latest green run of that workflow.
2. In Roblox Studio, go to File > Open from File and choose `che-blade-arena.rbxlx`.
3. Press Play to playtest.

Publishing, game passes and any Robux spending stay your own steps in Studio. CHE never uploads to Roblox.

**Status.**
- Verified: the place builds and every script compiles in CI.
- Not verified: no one has playtested it in Roblox Studio yet, so it is not called playable.
