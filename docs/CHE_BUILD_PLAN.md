# CHE build plan

Source brief: `docs/CHE_MASTER_PROMPT.txt` (the latest brief) and `docs/CHE_MASTER_SPEC.md` (the full spec).
Older notes: `docs/REBUILD_AUDIT.md`.

## Phase 1 — Current architecture audit

| Area | Where | State |
|---|---|---|
| App shell, chat, voice glue, hub tabs | `lib/main.dart` (~5.9k lines) | Works, but it's one big file. Split it by domain step by step. |
| Voice: Realtime/WebRTC, native fallback, Porcupine wake | `lib/che_realtime_voice.dart`, `che_native_voice.dart`, `che_wake_word.dart`, `che_voice_state.dart` | Works, with tests. One mic owner. Leave alone. |
| Immersive rooms (legacy) | `office_scene.dart`, `create_gallery_scene.dart`, `music_studio_scene.dart`, `devices_hub_scene.dart`, `insights_brain_scene.dart`, `che_immersive_hub_shell.dart` | Works. Visual style is older than the new kit. |
| New UI kit | `lib/che_ui/*` | Builds. The agents, Office floor and room backdrops are in use. The agent chat, brain, log and plugins parts are **not yet wired into `main.dart`**. |
| Backend | `server/cloudflare/worker.js` (one owner `CheState` Durable Object) | Works: pairing, chat (NDJSON), memory, owner context, projects, vault, jobs, plugins, Realtime token. |
| Agent Runtime | `server/cloudflare/agent_runtime.js` | **New.** See Phase 4. |
| CI / build | `.github/workflows/*`, `codemagic.yaml` | Flutter analyze/test and worker tests run in CI. IPA via GitHub Mac + Codemagic. Shorebird is not set up yet. |

## Phase 4 — Agent Runtime + Office (done in this pass)

Backend (`server/cloudflare/agent_runtime.js`, routed from `CheState`):

- `GET /api/agents` returns the roster with live status, CHE's own status, the working count and War Rooms.
- `POST /api/agents` creates an agent. It can be temporary and can take a first task.
- `GET /api/agents/:id` returns the profile, CHE-reviewed task history and meetings.
- `PATCH /api/agents/:id` takes `reassign`, `upgrade`, `downgrade`, `keep`, `retire` or `edit`.
- `POST /api/agents/:id/task` gives an agent a task. It is queued, the agent works it, and CHE reviews the result (APPROVED / NEEDS WORK).
- `POST /api/meetings` and `GET /api/meetings/:id` run the War Room. Agents draft in parallel, then each one cross-checks a teammate in character, then CHE synthesizes decisions, conflicts, recommendations and a final plan.
- `GET /api/agents/live` is a WebSocket that pushes a snapshot on every change (Durable Object hibernation API).
- Work runs from the Durable Object alarm, so it keeps going while the phone is locked. Work stuck in "running" is put back in the queue, so the status never claims work that isn't happening.
- The chat stream emits `{"type":"step"}` lines when CHE delegates.

App:

- `lib/agents/che_agent_runtime.dart` is the client plus a polling controller: fast while work runs, slow when idle.
- `lib/agents/che_office_floor_screen.dart` shows the Office floor, an agent desk sheet (message, reassign, upgrade, retire) and a hire-agent sheet.
- `lib/agents/che_war_room_screen.dart` is the War Room.
- Open it from Hub → Office → **Enter the Office floor + War Room**.

Deliberate trade-off: agents live in the owner's single `CheState` Durable Object instead of one Durable Object per agent. That keeps a single consistent store and needs no new Durable Object migration. The runtime module works on plain data, so moving to one Durable Object per agent later is a storage change, not a rewrite.

## Phases 1–6 progress

| Phase | Status |
|---|---|
| Home: live step lines, delegation chips, CHE mini person + Office status, copy/retry | Done |
| Room navigator instead of the 9-tab bar; clipped pages (fixes "Businessiness"/"GALGALLERY" overlap); no duplicate CHE title | Done |
| Brain: Soul, 7-category facts, reflections, `che-remember`, word-for-word log (Files app + cloud `/api/logs`) | Done |
| Plugins v2: manifest catalog, guarded tool runner, install cards, quick actions, mini apps, rollback, Safe mode | Done |
| Self-development: `che-update` card → PR → CI status → merge → Shorebird patch; rollback PR | Done. Shorebird needs one-time `shorebird init` + `SHOREBIRD_TOKEN` |
| Markets desk (ticker, index panels, candles, desk actions) | Done |
| Browser v2 (tabs, history, favorites, reader, summarize, ask, save to project) | Done |
| Creator / Sound Studio (ON AIR, render queue, create actions) | Done |
| Business War Room entry | Done |

| Home swapped to the kit agent-chat design (9-state orb, glow composer, Agent/Chat, Stop, conversation switcher, code file cards, Saved-to-brain chips) | Done |
| App-wide kit theme (logo colors) | Done |
| `main.dart` split into `lib/home_state/*` part files (6.4k → 1.1k lines) | Done |
| Art Studio: real images (Workers AI FLUX or your connector), versions, variation, refine, draft opt-in, upscale via connector, save to Vault | Done |

## Still to do

1. Per-agent Durable Objects if the single owner Durable Object gets hot.
2. Check on a deployed Worker that Stooq/CoinGecko/Open-Meteo answer Cloudflare requests. If Stooq blocks them, connect `CHE_MARKET_DATA_URL`.

## Phone test checklist

- [ ] Send a message that delegates. Step lines and agent chips appear under "Thinking… Xs", and the finished reply keeps a collapsible "Thought" line.
- [ ] Hub rooms swipe without labels overlapping. The room pill row stays on one line.
- [ ] Insights → Brain: edit the Soul, add a fact, see the latest thought after a few messages. Insights → Log: search and open a transcript. Files → On My iPhone → CHE → che_logs has .md files.
- [ ] Plugins → Skill plugins: install Weather from the catalog, ask "weather in Chicago", see "✓ Used Weather · forecast".
- [ ] Ask "CHE, add a settings toggle to your app". An Update ready card appears. Approve it and a PR opens with CI status.
- [ ] Markets: the ticker moves, index panels show delayed values (or say Unavailable), tapping one changes the chart.
- [ ] Apps → any site: tabs, favorites, reader mode, Summarize and Ask CHE all work.
- [ ] Music → Studio: ON AIR lights while CHE talks. Podcast creates a cloud job in the render queue.
- [ ] Home: the orb label changes Sleeping → Listening → Thinking → Speaking. Stop cancels a reply. Agent/Chat switches the hint. New Chat clears the screen, and the old chat is in the ▾ list.
- [ ] Create → Art Studio: New piece shows up on the gallery wall. Variation and Refine add v2 and v3. Upscale says it needs a connector.


- [ ] Pair the phone. Open Hub → Office → **Enter the Office floor + War Room**. CHE's desk is shown, and "0 working" when idle.
- [ ] Tap the person icon, hire "Research Partner" with a first task. Nova appears as *Waiting*, then *Researching*, then *Done*.
- [ ] Tap Nova. The history shows the result and "Approved by CHE" or "Needs work".
- [ ] Send Nova a task from the desk sheet. The status changes within about 2 s.
- [ ] Upgrade, then Use fast engine. The pill updates.
- [ ] Tap **War Room**, enter an objective and convene. The screen shows drafts, then cross-checks, then CHE's synthesis, with progress to 100%.
- [ ] Lock the phone mid-meeting and reopen. The meeting still finished on the server.
- [ ] Retire an agent. It leaves the floor, and anything it owned goes back to CHE.
- [ ] Tap CHE's desk. It returns to the conversation.
