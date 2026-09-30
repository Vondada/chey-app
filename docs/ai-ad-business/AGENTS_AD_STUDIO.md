# Ad Studio agent — Iris (La Agencia / Office status UI)

This is a **real Office coworker job**, mirrored on the Office status board (desks, tasks, blockers). It is **not** a game character.

## Catalog entry (code)

Canonical roster: `server/cloudflare/office_company.js` → `LA_AGENCIA_ROLES`.

| Field | Value |
|---|---|
| Name | **Iris** |
| Role | Ad Studio / paid-social creatives |
| Specialty | Ad creatives, visual briefs, captions, same-night social packages |
| Provider preference | `xai` (falls back when other text providers are connected) |
| Capabilities | `text` |
| Workspace | `office/iris` |
| Reports to | CHE |
| Money / merge / owner messaging | Off (owner pays clients outside the agent) |

Goal routing: phrases with `ad`, `ads`, `creative`, `flyer`, `banner`, `tonight pack`, `caption pack`, etc. route to Iris via `splitGoal()`.

Lyra remains **Content / social** (organic posts). Iris owns **ad-pack / creative-package** work so Tonight Pack briefs have a clear desk.

## How the owner hires / tasks (existing APIs)

Staffing happens when the Office opens (`ensureLaAgenciaRoster`). Iris appears on:

- `GET /api/office/today` — board agent row (`core: true`)
- `GET /api/agents` — full team mirror
- Flutter Office floor — Hire dialog still works for **extra** specialists via `POST /api/agents`


### Voice / chat intents (Worker `office_phrases.js`)

Say to CHE (wake optional):

| Phrase | Effect |
|---|---|
| `hire Iris` / `hire Iris for Ad Studio` | Staffs La Agencia roster; confirms Iris on Ad Studio desk |
| `hire Iris to draft tonight pack for [Business]` | Hires + queues Tonight Pack goal to Iris |
| `draft tonight pack for [Business]` | Queues Iris creative brief (no "tell the Office" needed) |
| `scout Fiverr for AI ad buyers` | Queues Atlas scout + Iris fit map; **shortlist only** — owner confirm before any outbound |
| `what is Iris doing?` | Live desk status from `/api/office/today` |
| `Tell the Office to …` | Existing goal splitter (`splitGoal`) |

Fiverr scout tasks set `owner_confirm_required: true` and `outbound_allowed: false`. CHE will not message, bid, or buy on Fiverr until the owner confirms the exact recipient, channel, and text.

### Task via voice / chat goal (preferred)

Say something like:

> Tell the Office: draft a Tonight Pack brief for [Business] — 4 square ads, 2 stories, 2 captions, offer is [offer].

CHE splits goals with `splitGoal` and queues `team_tasks` (source `owner_goal`). Iris should pick up ad/creative clauses.

### Task via hire dialog (custom specialist)

Office floor → **Hire** → fill:

- Role: `Ad Studio Partner`
- Name: leave blank or use a free name (Iris is reserved once rostered)
- Specialty: `same-night ad creatives, captions, visual briefs`
- First task: paste the client brief from ORDER_CHECKLIST
- Temporary: on if this is a one-off helper

That calls `POST /api/agents` → `createAgent()` in `agent_runtime.js`.

### Direct agent task

`POST /api/agents/:id/tasks` (or Office message routing to `iris`) with the brief text. Status updates stream on `/api/agents/live`.

## Job description (what Iris must produce)

When tasked with a Tonight Pack (or Mid/Starter), Iris’s output should be a **complete handoff brief**, not vague ideas:

1. Creative plan (6 slots for $500: 4 feed + 2 story) with headline, subhead, CTA per slot
2. Caption variant A and B (under ~150 / ~300 characters guidance)
3. Image prompts sized for Art Studio / external editor (1080×1080 and 1080×1920)
4. Asset checklist gaps called out as blockers (missing logo → status blocked honestly)
5. No invented Stripe keys, no cannabis SKUs, no “guaranteed ROI” claims in client-facing copy unless the client supplied compliant wording

Iris does **not** charge the client’s card and does **not** post to the client’s IG unless the owner separately grants app permissions and asks.

## Art Studio handoff

Pictures: Worker `POST /api/media/generate` (Art Studio / `media.js`) when Workers AI or `CHE_IMAGE_GEN_URL` is set. If unset, Iris still delivers prompts + captions; the owner exports finals in Canva/Photoshop so the paid pack still ships tonight.

## Honest limits

- Without AI provider keys, Iris’s desk shows an honest tool blocker (same pattern as Knox/Atlas).
- Without image gen URL, stills come from the owner’s editor — the **business pack still sells**.
- Office Stripe “earned today” stays $0 until real Stripe secrets are on the Worker; client Cash App/Venmo is tracked in your checklist, not invented in CHE.
