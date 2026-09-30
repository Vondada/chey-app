# Roblox / Luau UGC business — CHE Office playbook

Legal monetizable service line for the owner: **games / experiences**, **weapons/tools**, **clothing / avatars / UGC**, **game passes**, maps, and similar. Knox (Luau/code) + Nova (listings/monetization) + Lyra (creative/UGC briefs) draft work. Iris/Atlas may scout demand. **CHE speaks to the owner; agents report only to CHE.**

This is a **draft + owner-gate** workflow. The Worker does **not** drive Roblox Studio desktop automation. Deliverables are specs, Luau stubs, asset briefs, listing copy, and publish checklists.

## Hard rules

- **Owner confirm required** before: Marketplace publish/upload, experience publish, Robux spend, paid ads, outreach/DMs, commissions acceptance, or any account login/share of credentials.
- **Never** store Roblox passwords, cookies, `.ROBLOSECURITY`, Open Cloud secrets, or recovery codes in the Worker, Flutter, prompts, logs, memory, or this repo.
- **Maximize legal money-making.** No artificial product walls — any lawful Roblox/UGC angle is in scope. **Hard stops:** illegal content, IP theft, ToS-breaking exploits, account takeover, or impossible claims (“already published”).
- Shortlist / draft only until the owner confirms the exact action (what uploads, which place, which Robux amount).
- Distill learnings into Durable Object **memory notes** (title + bullets + public URLs). No silent PII dumps.

## Catalog (project types)

| Catalog | Project `type` | Tonight-first angle |
|---|---|---|
| Game / experience | `roblox_game` | Simple place script + lobby loop |
| Weapon / tool | `roblox_weapon` | **Preferred tonight:** Tool base + damage loop Luau stub |
| Clothing / UGC / avatar | `roblox_clothing` / `roblox_ugc` / `roblox_avatar` | Shirt/pants template brief + listing copy |
| Game pass | `roblox_pass` | Pass product plan + client prompt stub |

## Voice / API phrases (continue tonight)

Say to CHE (wake optional: “Chay,” / “CHE,”):

- `build a Roblox weapon tool base`
- `create a Roblox clothing shirt template`
- `make a Roblox game lobby script`
- `hire Knox for Roblox Luau weapon tool`
- `tell the Office to draft Roblox UGC clothing pack`
- HTTP (paired): `POST /api/office/roblox` with `{ "task": "…", "catalog": "weapon" }`
- HTTP (paired): `POST /api/office/goals` with a Roblox goal string
- Chat/voice: phrases routed via `office_phrases.js` → `robloxJob` → `officeRobloxJob`

Also useful: `hire Iris` (ads), `scout Fiverr for Roblox UGC` / opportunity scout (shortlist only).

## Tonight plan (concrete first deliverable)

**Primary:** Roblox **weapon Tool base** — Luau stub the phone Projects board can show.

1. Queue Office Roblox job (`weapon`) → Knox Luau draft + Nova listing/pass notes (+ Lyra if clothing later).
2. Creator Studio project type `roblox_weapon` appears on **Office → Projects** with `owner_confirm_required`.
3. Paste/adapt [`luau/WeaponToolBase.luau`](./luau/WeaponToolBase.luau) into a Tool under `StarterPack` in Studio (owner machine).
4. Optional next: clothing shirt template brief (`roblox_clothing`) or simple place lobby script (`roblox_game`).
5. **Stop before publish.** Owner logs into Roblox, creates/selects experience, uploads assets, spends Robux only after explicit confirm.

## Agent playbook (who does what)

| Agent | Role on Roblox line |
|---|---|
| **Knox** | Luau modules, Tool/RemoteEvent shape, place script stubs, Codex packets |
| **Nova** | Listing title/description, pass pricing draft, publish checklist |
| **Lyra** | Mood boards, UGC clothing/avatar briefs, thumbnail copy |
| **Atlas** | Public demand/competitor shortlist (no auto-message) |
| **Iris** | Ad/creative packs for launches (owner confirm before spend) |
| **Sage** | Stripe/finance only if selling off-platform services around Roblox |

## Legal / ToS notes (owner responsibility)

- Follow [Roblox Community Standards](https://en.help.roblox.com/hc/en-us/articles/203313410) and [Creator Terms](https://en.help.roblox.com/hc/en-us/articles/115004647846).
- No copied IP, no age-inappropriate content, no gambling that violates Roblox rules, no unauthorized brand assets.
- UGC clothing must meet Roblox UGC template and moderation rules; weapon visuals must stay within experience context (not Marketplace-restricted categories without approval).
- Open Cloud / API keys stay in owner secrets managers — never in CHE memory.

## Owner gate checklist (before publish/spend)

1. Roblox account / group / experience selected by owner.  
2. Exact place or asset ID (or “new place”) confirmed.  
3. What is uploading (script, model, clothing PNG, pass).  
4. Robux or ad budget (if any) confirmed as a number.  
5. Listing text owner-approved.  
6. CHE/Office must **not** claim publish succeeded unless owner confirms after Studio/Creator Dashboard action.

## Memory note template

```text
Roblox studio — YYYY-MM-DD HH:MM America/Chicago
Catalog: weapon | clothing | game | pass
Project / goal id:
Deliverable: (e.g. WeaponToolBase Luau stub)
Public refs:
Risks / ToS notes:
Owner decision: pending | confirmed upload | discard
Hard rules: no publish/spend/outreach without owner confirm; never store Roblox credentials.
```

## Related

- Opportunity scout umbrella: [`../ai-ad-business/OPPORTUNITY_SCOUT.md`](../ai-ad-business/OPPORTUNITY_SCOUT.md)
- Worker module: `server/cloudflare/roblox_studio.js`
