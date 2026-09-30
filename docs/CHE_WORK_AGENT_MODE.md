# CHE Work Agent Mode — full agent parity (honest)

**Branch / ship:** `desk/office-che-work-agent-parity`  
**Enable in-app:** Home composer **Agent | Chat** → leave on **Agent** (default). Chat mode is conversational-only capability tagging. Soul text is editable under Brain → soul; reset soul to pick up the new default paste after update.

## What changed

1. **Soul (`cheDefaultSoul`)** — Office Boss / Work Agent Mode section describes plan → tools → delegate → verify → report, La Agencia roster, ephemeral workers, real tools, and honesty gaps.
2. **Worker prompts** — `WORK_AGENT_MODE_POLICY` in chat system prompt, Realtime voice instructions, and `CHE_VOICE_FIRST_POLICY` (`ai_router.js`).
3. **Tool routing** — when `agent_mode=full` (Flutter already sends this for Agent):
   - `runOfficeAgents(..., fullAgentMode=true)` also staffs matching La Agencia desks (Nova/Atlas/Mira/Knox/Sage/Lyra/Iris), not only legacy role partners.
   - Actionable non-casual turns auto-queue Durable Object Office jobs via `officeGoal` / `splitGoal` (same path as “tell the Office to …”).
4. **State** — `integrations.work_agent_mode: true` on `/api/state`.

## How CHE spawns / delegates sub-agents

| Path | Mechanism |
|------|-----------|
| Work Agent Mode auto-queue | `shouldAutoDelegateOffice` → `officeGoal` → `queueAgentTask` on La Agencia agents |
| Voice/text Office phrases | `matchOfficePhrase` → goal / hire Iris / scout / ML / Roblox |
| Capability panel | `runOfficeAgents` parallel coworker slices → CHE synthesizes |
| Provider employees | `createProviderEmployee` / “make a Grok coding employee” via `ai_layer` |
| Paired intelligence | `startPairedJob` War Room (two+ connected families) |
| Self-update | engineering team proposal → owner approval card → PR |

Specialists **never** message the owner; CHE reviews and reports.

## Grok Bot–level map (real vs gap)

| Capability | CHE today | Notes |
|------------|-----------|--------|
| Plan / multi-step agent loop | Yes (prompts + Office jobs) | Cognition loop in soul |
| Sub-agents / specialists | Yes — La Agencia + ephemeral provider workers | Not Cursor cloud agents |
| Shell / box filesystem | **Gap** unless `CHE_COMPUTER_URL` | Optional cloud computer, owner-approved permissions |
| Browser | CHE in-app browser + research tools | Not a full remote desktop browser farm |
| Plugins / HTTP tools | `plugin_runtime` + skill manifests | Owner-installed |
| SMS | Twilio via CHE only | Bulk = owner confirm |
| Memory | Brain + Worker memories + optional pgvector | |
| GitHub / PR ship | Self-update + desk PRs via owner/gh | Worker needs tokens for unattended draft PRs |
| MCP / Cursor tools | **No** | Do not claim |
| Unrestricted desktop Grok Bot box | **No** | Honest gap |

## Shorebird / deploy

- Flutter soul string → phone needs rebuild or Shorebird patch; existing on-device `soul.txt` keeps old text until Brain → Reset soul (or reinstall).
- Worker-touched → `npx wrangler deploy` from `server/cloudflare` after merge.
