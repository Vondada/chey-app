# CHE session progress — FINAL 2026-09-29 (America/Chicago)

Work tree: `/workspace/chey-app-git` (Vondada/chey-app, `gh` as Vondada).  
Prod Worker: **https://chey-app.henryjavoni.workers.dev** — `/health` → `{"ok":true,"agent":"CHE cloud"}`.
Deployed version: `717d399e-b77b-4650-ae63-9796fe1468eb` (Office auto providers).  
Worker tests: `cd server/cloudflare && npm test` → **128/128 pass**.

---

## Office providers (2026-09-29 evening)

**xAI key may be present but uncredited.** Iris, Atlas, Mira, and Lyra now use `provider_preference: 'auto'` so Office work is not blocked on Grok. `routingForAgent` omits `che_provider` for `auto`, and `ai_router` falls through to Groq / Gemini / Cerebras (and other healthy free/keyed providers). Nova/Knox stay on `openai`; Sage stays `auto` + Stripe tool gate. Owner can still pin an agent to `xai` later if credits land.

---

## Shipped (this finalize)

| Item | Status |
|---|---|
| **Iris Ad Studio** | On Office roster; hire / Fiverr scout / tonight-pack phrases; shortlist-only, owner confirm before outreach |
| **Forever opportunity scout** | `opportunity_scout.js` + playbook; Pinterest / dropship / middleman shortlists; Fiverr path unchanged |
| **Research → Durable Object memory** | `research_memory.js`; write-back on scout/research complete + public research chat; visible on `GET /api/state` |
| **AI ad business pack** | `docs/ai-ad-business/` (offer, DM script, order checklist, Fiverr scout/collab, opportunity scout) |
| **Office auto providers** | Iris/Atlas/Mira/Lyra → `auto` (not blocked on uncredited xAI) |
| **Deploy** | `wrangler deploy` from `server/cloudflare` → `chey-app` @ workers.dev (account `c49b395e…542c`) |

Prod secret **names** only (via `wrangler secret list`): `CHE_PAIR_CODE`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `CEREBRAS_API_KEY`. No values recorded here.

---

## Owner vision — capability map (5 goals)

| # | Goal | In tree | Remaining |
|---|---|---|---|
| 1 | Add to her own code when asked | `che-update` → draft PR; Actions + Shorebird docs; secret/native guards | Optional `CHE_GITHUB_TOKEN` / `CHE_GITHUB_REPO`; Shorebird merge path |
| 2 | CHE + team always creating / helpful | Office + War Room + Iris + scout/memory loop; live Worker | xAI optional only; Iris/Atlas prefer auto / free providers |
| 3 | Create/design full apps and websites | Projects vault, self-update for Flutter `lib/`, site stub | Richer `projects/` scaffolds still thin; no silent IPA for native |
| 4 | Generate videos and pictures | Art Studio + Workers AI / image URL; video not implemented | Optional `CHE_VIDEO_GEN_URL` / upscale URL |
| 5 | Pull from any known public source | Builtin skills, research mode, opportunity scout | Writes / spend / outreach still need owner confirm |

---

## Still owner-only (nothing agent should invent or auto-do)

1. **Optional xAI credits** — key may exist; without credits Iris/Atlas/Mira/Lyra stay on `auto` fallbacks. Re-pin to `xai` only after billing works.
2. **Fiverr seller** — owner uses scout shortlists / briefs manually; do **not** auto-message or bid.
3. **SideStore IPA** — Codemagic → macOS IPA only if native changes (`docs/SIDESTORE_CODEMAGIC.md`); Flutter speech fallback stays.
4. **Outreach / spend confirm** — Stripe keys unset until owner confirms; no auto purchase / DM / bid / transfer.
5. **Cursor GitHub App grant** — optional; `gh` CLI already works as Vondada for PRs/merges.
6. Optional later: `CHE_GITHUB_TOKEN` for self-update draft PRs from Worker; image/upscale/video connector URLs; Stripe live after explicit confirm.

Do **not** invent secrets, auto-message Fiverr, bake cannabis SKUs, or import Windows encrypted memory.

---

## How to re-check

```bash
cd /workspace/chey-app-git/server/cloudflare && npm test
curl -sS https://chey-app.henryjavoni.workers.dev/health
# Pair with prod CHE_PAIR_CODE → Office / scout phrases → GET /api/state memory_notes
```

Flutter SDK not on this box — Dart not re-analyzed here.

## 2026-09-29 (America/Chicago) — Roblox UGC line queued

- Worker: `roblox_studio.js`, voice `robloxJob`, `POST /api/office/roblox`, `officeRobloxJob` creates **goal + project** (owner confirm before publish/spend).
- Phone: Office → **Projects** board shows Roblox types; create dialog includes Roblox catalog.
- Playbook: `docs/roblox-studio/PLAYBOOK.md`, tonight first deliverable Luau `WeaponToolBase.luau`.
- Live Worker seed needs correct `CHE_PAIR_CODE` after deploy (local agent-app pair code did not match production).
