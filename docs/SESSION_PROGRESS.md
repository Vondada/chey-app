# CHE session progress — 2026-09-29 (America/Chicago)

Local tree: `/workspace/agent-app` (owner zip of Vondada/chey-app).  
Worker local: `http://127.0.0.1:8787`, pair code `123456` in `.dev.vars`.  
Worker tests: `cd server/cloudflare && npm test` → **127/127 pass**.

---

## Owner vision — capability map (5 goals)

| # | Goal | Exists in this tree | Missing / next concrete step (owner-blocked marked ★) |
|---|---|---|---|
| 1 | **Add to her own code when asked** | `che-update` card → `POST /api/self-update` opens draft PR; Actions `che-propose.yml` + `tools/che_propose_change.py`; Shorebird path documented | ★ `CHE_GITHUB_TOKEN` + `CHE_GITHUB_REPO` on Worker; ★ Ollama/Actions secrets; ★ merge + Shorebird token. Guards strengthened this session (secrets / native smuggle / max 6 files). |
| 2 | **CHE + team always creating code / getting more helpful** | Office floor + War Room + agent runtime; stalled board + voice; La Agencia jobs; activity feed | ★ Deployed Worker + AI keys so agents actually draft; coding jobs already queue through agent runtime when models answer. Keep stalled/earnings honest ($0 without Stripe). |
| 3 | **Create/design full apps and websites** | Projects vault, browser “Save to project”, self-update for Flutter `lib/` only; `site/index.html` stub; pipeline “build” stage | Full app/website scaffolding as first-class product still thin. Next code step: Office goal → project files under allowlisted `projects/` via propose-change (already allowed in Actions for text assets) + Art Studio mockups. No silent IPA for native. |
| 4 | **Generate videos and pictures** | **Pictures:** Art Studio + `media.js` (Workers AI FLUX and/or `CHE_IMAGE_GEN_URL`); variation/refine; upscale needs `CHE_UPSCALE_URL`. **Video:** not implemented | Next concrete step: Worker job kind `video` + HTTPS `CHE_VIDEO_GEN_URL` connector (same pattern as upscale — refuse honestly if unset). Documented on Creator Studio header. ★ Connector URL / keys from owner. |
| 5 | **Pull from any known public source** | Skill plugins builtins (Weather, Crypto, Wikipedia); connector catalog via `CHE_PLUGIN_CATALOG`; browser summarize / teach / research mode; markets Stooq/CoinGecko | ★ Confirm public APIs answer from Cloudflare egress; optional `CHE_MARKET_DATA_URL`. Day-one Plugins list now falls back to builtin skills when catalog env unset. Writes still need owner confirm. |

---

## Landed this session (cumulative)

### Earlier in session
- Office **stalled** on Worker board + Flutter UI + wake phrase “what’s stalled?”
- `/api/plugins` builtin skill rows when `CHE_PLUGIN_CATALOG` unset
- `docs/SIDESTORE_CODEMAGIC.md` + README / BUILD_PLAN links

### This continuation


### Learning loop — research → Durable Object memory (this continuation)
- Module: `server/cloudflare/research_memory.js` — distill scout/research job results into owner-visible memory notes (`title` + short bullets + source URLs; opportunity notes add channel / offer / why / URL).
- Write-back on Office task complete (Atlas/Iris/`fiverr_scout`/`opportunity_scout`/research-style) in `agent_runtime.js`; also chat `publicResearch` summaries.
- Reuses `/api/memory/add` path via `addOwnerMemory`; notes listed on `GET /api/state` as `memory_notes` + `memories`. Secrets rejected; no silent PII dumps; no new secret storage.
- Forever **Opportunity Scout** umbrella: `opportunity_scout.js` + phrase `scout Pinterest/dropship/opportunities…` → shortlist-only jobs. Fiverr path unchanged (`fiverr_scout` / hire Iris).
- Playbook: [`docs/ai-ad-business/OPPORTUNITY_SCOUT.md`](./ai-ad-business/OPPORTUNITY_SCOUT.md) (covers Fiverr + Pinterest + dropship/middleman). Owner rule: maximize **legal** money-making; no artificial product walls; hard stops only illegal or impossible; confirm before spend/outreach/bids/purchases/Stripe.
- Tests: `research_memory.test.mjs`, `opportunity_scout.test.mjs`, office_api opportunity + memory write-back.

### Ad Studio Iris — hire / task / Fiverr scout (this continuation)
- Worker: `iris` on `OFFICE_AGENTS`; phrases `hire Iris`, `scout Fiverr for…`, `draft tonight pack for…`
- `officeHireIris` + `officeFiverrScout` queue real board jobs; Fiverr scout is shortlist-only (`owner_confirm_required`, no auto-message/bid)
- Module: `server/cloudflare/fiverr_scout.js`
- Flutter: `cheOfficeRoster` + Office phrase mirror include Iris; floor goal hint lists Iris
- Test: `cd server/cloudflare && npm test`


### AI ad business pack (same-night)
- Docs: [`docs/ai-ad-business/`](./ai-ad-business/) — `OFFER.md`, `DM_SCRIPT.md`, `ORDER_CHECKLIST.md`, `AGENTS_AD_STUDIO.md`
- Fiverr scout pack: [`FIVERR_SCOUT.md`](./ai-ad-business/FIVERR_SCOUT.md) + [`FIVERR_COLLAB.md`](./ai-ad-business/FIVERR_COLLAB.md) — manual browser scout, owner-confirm gate, no auto-purchase or stored credentials.
- La Agencia: **Iris** added as Ad Studio in `office_company.js` (`LA_AGENCIA_ROLES` + goal routes). Status-board coworker, not a game NPC.
- Honest limits: needs warm contacts for ~$500 tonight; no invented Stripe keys; Cash App/Venmo placeholders only; no cannabis SKUs; no guaranteed revenue.
- **Stripe money gate:** `assertStripeCallAllowed` blocks refunds/transfers/payouts/direct charges; approve + pipeline invoice require `confirmed: true`; Flutter confirm dialogs on Store Approve and Pipeline “create payment link”
- **Self-patch guards:** Worker `validateUpdateFiles` max 6 files, secret + native XML scans; Actions `che_propose_change.py` blocks ios/entitlements/workflows/pubspec, secret scan, max +800 lines; Flutter `CheUpdateProposal.problems` mirrors checks
- **Native voice:** `CheNativeVoice` swallows `MissingPluginException` → Flutter speech fallback without crash; status reports `native_bridge: missing`
- **Docs:** this file; Creator Studio comment for video next step

---

## How to test (no owner secrets)

```bash
cd /workspace/agent-app/server/cloudflare && npm test
# Optional live Worker (already on :8787):
# pair with 123456 → GET /api/office/today (stalled) → GET /api/plugins (builtins)
# Stripe approve without body.confirmed → 400
# Learning loop: say "scout Pinterest for printable planners" → GET /api/state → memory_notes / memories
```

Flutter SDK not on this box — Dart changes not analyzed here; keep speech fallback and confirm dialogs as shipped.

---

## Still blocked on owner (nothing more material without these)

1. GitHub connect / auth (no PRs from this agent)
2. Cloudflare deploy + production `CHE_PAIR_CODE`
3. AI keys (Workers AI quota, optional Groq/Gemini/xAI/Ollama)
4. `CHE_GITHUB_TOKEN` / `CHE_GITHUB_REPO` / Actions `OLLAMA_API_KEY` for self-patch
5. Codemagic → macOS IPA → SideStore (`docs/SIDESTORE_CODEMAGIC.md`)
6. Swift `che/native_voice` Runner (Flutter speech remains fallback)
7. Stripe live/test keys + webhook secret for real earnings
8. Optional: `CHE_IMAGE_GEN_URL`, `CHE_UPSCALE_URL`, future `CHE_VIDEO_GEN_URL`
9. Do **not** import Windows encrypted memory; do **not** bake cannabis SKUs / trade keys

When those land, highest-value next coding slices: video connector job, richer `projects/` website scaffolds via guarded propose-change, and live Office coding tasks against a deployed Worker with models.
