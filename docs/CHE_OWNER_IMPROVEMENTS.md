# CHE Owner Improvements

The owner's request (2026-10-23): "I should be able to tell CHE what feels wrong, what I want changed, or what should work differently, and CHE should handle the improvement herself whenever technically possible."

## How it works

1. **Understand.** `server/cloudflare/owner_improvements.js` `improvementIntent` turns the owner's words into a request. It is deterministic and calls no model. It runs in `/api/chat` right after the commit-receipt route.
   - Examples: "this page is too cramped", "make the chart smaller", "use chrome green for successful actions", "remember that I prefer portrait charts", "stop showing repeated information", "fix this navigation problem", "why does this feature keep failing?", "undo that", "what improvements are open?" and "open owner improvements".
   - Ordinary sentences are left alone. Examples: "my room is too cramped", "why does my car keep failing inspection" and "I prefer coffee". The tests list them.
   - The phone sends `active_screen` (the `CheScreenReport.page` in front of the owner), so CHE knows which page "this page" is. A room named in the sentence wins.
2. **Prefer configuration.** `UI_CONFIG` is the allow-list. It names only preferences the app really consumes; a test checks each key and value against `lib/che_ui/che_ui_preferences.dart`.

   | Key | Values | Where it applies |
   |---|---|---|
   | `layout.density` | compact, comfortable, spacious | Trading Room spacing, Owner Improvements cards, Office desks (compact vs roomy) |
   | `chart.height` | compact, standard, tall | `CheTradingChart` height (×0.7, ×1, ×1.35) |
   | `chart.orientation` | follow_device, portrait | Portrait: a tall chart (55% of the screen) while the iPhone is upright. Nothing rotates the screen. |
   | `status.success_color` | mint, chrome_green, ice, silver (the #488 chrome status tones) | The finished-job banner icon and Verified cards. A word always goes with the color. |
   | `text.size` | small, default, large | All of CHE's text (the existing text scale) |

   Anything else gets an honest answer: "That isn't configurable yet. I logged it as imp-…. I can open a coding task for it".
3. **Change → verify → correct → remember.** For each change, CHE does the following:
   - writes the value and keeps the previous value for undo
   - reads it back, and reverts and says so on a mismatch
   - sends the full config in the reply's `ui_config`
   - The phone applies it at once with `CheUiPreferences.applyOwnerConfig`. No new build is needed.
   - The phone reports the values it now uses to `POST /api/owner/improvements/:id/applied`.
   - The task moves to **Verified** only when those values match. A mismatch reverts the stored value and marks the task failed.

   The config is the persistent owner-preference profile. The app reads it on startup and refresh (`GET /api/owner/ui-config`), and only a newer revision applies, so a later change made on the phone is not overwritten.
4. **Undo.** Undo works by voice ("undo that", "undo the last change") or with the card's Undo button (`POST /api/owner/improvements/:id/undo`). Each undo is also read back.
   - A bare "undo that" only applies within 15 minutes of the change.
   - It never applies while a Visual Studio project is open, because Visual Studio owns undo there.
5. **Delegate real engineering.** When a setting cannot fix the problem, CHE writes a task with acceptance criteria and the earlier attempts, and sends it through the existing coding pipeline (`selfDevelopmentReply`: OpenCode or the built-in team, then the che-update approval card, CI, merge and deploy). Cases:
   - The setting is already at its limit.
   - The screen does not read the setting.
   - It is code work by nature, such as repeated information or navigation.

   The task keeps the job id that the pipeline really returned. If no job starts, the task is **Failed or blocked**, with the pipeline's own words as the reason. When the screen is unknown, CHE asks which screen before spending a coding run.
6. **Learn from repeated corrections.** Earlier tasks for the same area and screen (and, for a setting, the same key) are read back to the owner: "You raised this once before: imp-…, where I changed …". The coding brief tells the engineer not to repeat them.
   - A setting that is already at its limit is never "applied" again.
   - "Why does this feature keep failing?" reads only recorded tasks. It never states a cause it has not verified.
   - Conversation history stays separate: the ledger holds requests, actions and evidence, not chat text presented as fact.
7. **Dashboard.** More → Owner Improvements (`lib/che_ui/che_owner_improvements.dart`), or "open owner improvements" by voice.
   - It shows compact chrome HUD cards grouped Requested / Investigating / Configuring / Coding / Testing / Awaiting approval / Verified / Failed or blocked.
   - Each card opens to show its id, history, evidence and acceptance criteria, with Undo or "Send to engineers" where supported.
   - It has VoiceOver labels, Read Aloud and a mic. Loading is silent.
8. **Safety.** Only allow-listed, reversible UI preferences change automatically.
   - Coding requests that touch money, live trading, security, credentials, deleting or publishing wait as **Awaiting approval** until the owner says "start coding task imp-…".
   - Any PR still waits for the owner's approval card and the required checks.
   - Nothing runs on a schedule. Passwords never leave the on-device vault, and nothing here reads or sends them.

Command Center: `/che-improve <what feels wrong>` (`command_catalog.js`, route `che_owner_improvement`).

## Audit before building (2026-10-23, main bb0f557)

| # | Mission section | Before this change | Evidence |
|---|---|---|---|
| 1 | Understand owner feedback | PARTIAL | `lib/che_ui/che_ui_voice_command.dart:21` parsed short phone-side UI commands ("dark mode", "make the text bigger", "compact desks"). Nothing turned a complaint ("too cramped", "the chart is too big") into a task, and nothing on the Worker did. |
| 2 | Prefer configuration over coding | PARTIAL | `lib/che_ui/che_ui_preferences.dart:22` kept palette, avatar, desk density, text scale and voice on the phone only. Chart size, chart shape, success color and app-wide density did not exist. CHE's server could not change or read them. |
| 3 | Repair workflow (inspect → change → verify → correct → remember) | MISSING for UI | The phone applied its own commands without a read-back or a ledger. There was no undo beyond Visual Studio's (`server/cloudflare/visual_studio.js:383`) and trading controls' restore (`server/cloudflare/trading_controls.js:350`). |
| 4 | Delegate real engineering work | DONE (reused) | `worker.selfDevelopmentReply` (worker.js) → OpenCode runtime or the built-in coding team (`self_development.js`), the che-update approval card, `merge_pr` and `verify_deploy` jobs. "Atlas" is an Office agent (`office_router.js`) and the Knowledge Atlas (`knowledge_atlas.js`); the code work itself runs on this coding engine, which is what Owner Improvements delegates to. |
| 5 | Learn from repeated corrections | PARTIAL | Coding lessons and failed strategies exist (`self_development.js` `recordLesson`, `recovery_policy.js` `strategyFingerprint`). Nothing tracked the owner's own repeated UI complaints. |
| 6 | Owner Improvements dashboard | MISSING | Jobs show in the Office and the job banner (`lib/che_job_activity_banner.dart`). There was no per-request view with history, evidence and undo. |
| 7 | Safety and authority | DONE (reused) | The money/delete holds and owner-only gates (AGENTS.md) and `currentTurnActionPolicy` (`code_scout.js:310`). This change adds the allow-list, and an approval hold on coding requests that touch high-impact areas. |
| 8 | Preserve CHE's identity | DONE (kept) | Chrome HUD (`lib/che_ui/che_hud.dart`), voice routes and VoiceOver labels. The new page uses CheGlass, CheChromeText and the HUD label style, and only icons in the installed build's font (release icon guard). |

## Limits (honest)

- Only the five keys above are configurable. Other pages read density only once they are coded to: the Brain Room does not yet, and CHE says so and opens a coding task.
- "Verified" for a setting means the iPhone reported applying the value. It does not mean the owner judged the page better. The owner can still say "undo that".
- A coding task is done only when its PR has merged and been deployed. The dashboard shows the coding job's state from the real job queue.
- The Shorebird patch carries all of the Flutter side (no native code, and only icons the installed build has).
