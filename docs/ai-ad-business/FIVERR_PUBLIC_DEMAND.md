# Fiverr public demand snapshot — 2026-09-29

No-login notes only. This is **not** a buyer-request scrape, not a gig inventory, and not permission to message, bid, or buy. Figures come from Fiverr's own June 2026 Business Trends Index press (search growth, May–October 2025 vs November 2025–April 2026). Confidence: **medium** (publisher stats, not a live listing check). Owner decision: **pending**. Recommendation: **watch**.

Sources:

- https://www.fiverr.com/news/business-trends-index-ai-2026
- https://www.fiverr.com/resources/guides/reports/business-trends-index-june-2026
- GlobeNewswire reprint of the same release (2026-06-09): https://www.globenewswire.com/news-release/2026/06/09/3308866/0/en/Businesses-Race-to-Hire-Claude-Code-Specialists-As-Demand-Surges-938.html

## Search-growth signals Fiverr published

| Signal | Reported change | Offer angle for the owner (draft only) |
|---|---|---|
| Claude Code specialists | +938% | Workflow / agent setup help, not a claim of Anthropic employment |
| Instagram content | +403% (Fiverr social post citing the same index) | Content / caption packs |
| Shopify design | +348% (same social post) | Storefront creative, not a Shopify partnership claim |
| Video & Animation AI-related demand | +278% | Short-form and ad video concepts plus human edit |
| AI UGC video ads | +265% | Tonight-pack style ad creative; mark AI-assisted |
| YouTube faceless channels | +239% (same social post) | Script/thumbnail concepts only |
| Programming & Tech AI-related | +94% | Narrow automation, not unlimited engineering |
| AI video (Writing & Translation) | +80% | Scripts and captions |
| Facebook ads | +70% | Meta/Facebook ad creative |
| Digital Marketing AI-related | +62% | Local promo packages |
| AI video ads | +63% | Ad video concepts |
| n8n / automation workflows | called out with strong growth in the same news cycle (~+125% in secondary writeups; confirm on the Fiverr page before quoting) | Chatbot / FAQ workflow discovery |
| Google ads | +27% | Do not promise ad-account performance |
| Data category AI-related | +3% | Weakest of the published buckets |

Secondary seller blogs that quote dollar ranges (for example "$1,500–$2,500 per agent") are **not** Fiverr official prices. Do not copy them into an offer.

## Fit to existing CHE offers

- Ads / UGC / Instagram / Facebook growth maps to Iris (Ad Studio) and Tonight / Mid / Starter creative packs.
- Chatbot and workflow language maps to a discovery brief, not an auto-sent Fiverr proposal.
- Shopify and faceless-YouTube are watch items until the owner picks a niche.

## Hard stops

No auto-message, auto-bid, auto-accept, auto-buy, or Stripe. No Fiverr password, cookie, or token in the Worker, Flutter, or this repo. Buyer Requests stay account-dependent; if they are not visible while logged out, record `not visible / account-dependent`.

## AI execution blocker

Office scout jobs for Atlas and Iris prefer xAI. `.dev.vars` has no `XAI_API_KEY` (only `CHE_PAIR_CODE`). Until `XAI_API_KEY`, `CHE_XAI_API_KEY`, `GROK_API_KEY`, or `CHE_XAI_MODEL_URL` is set on the Worker, those jobs block with `Blocked: tool not configured (Grok)`. This snapshot does not call a model and does not spend.
