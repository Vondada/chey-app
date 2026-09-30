# Tonight — start the Roblox line (queued work)

**Time zone:** America/Chicago  
**Status:** Code + playbook queued in repo. Live Worker seed needs pair + deploy (or voice after deploy).

## First deliverable

**Roblox weapon Tool base** (`roblox_weapon`)

- Luau stub: [`luau/WeaponToolBase.luau`](./luau/WeaponToolBase.luau)
- Office job: Knox (script) + Nova (listing/pass notes); owner confirm before upload
- Phone UI: **Office → Projects** filter **Roblox**

## How to queue on the live Worker (after this PR is deployed)

1. Pair the phone (or any client) with `CHE_PAIR_CODE`.
2. Say: **“Chay, build a Roblox weapon tool base for our UGC studio tonight.”**  
   or `POST /api/office/roblox` `{ "task": "weapon tool base for UGC studio tonight", "catalog": "weapon" }`
3. Confirm Project + goal appear on Projects board (`owner_confirm_required: true`).
4. Owner opens Roblox Studio → new Tool → paste Luau → playtest locally.
5. **Do not publish** until owner explicitly confirms experience + asset + any Robux.

## Backups if voice phrase misses

- `tell the Office to draft Roblox weapon tool and listing`
- Create project type **Roblox · Weapon** in Creator Studio dialog
- `hire Knox for Roblox Luau weapon tool`

## Owner still must provide

- Roblox account / group login (on owner device only)
- Experience/place to attach the Tool
- Confirm before Marketplace or experience publish and any spend
