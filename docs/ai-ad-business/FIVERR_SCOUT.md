# Fiverr scout pack — Iris + Research

This is a **research and handoff playbook**, not an auto-bidding or purchasing workflow. Iris (Ad Studio) and the research agent may prepare opportunities for the owner to review. The owner must confirm any Fiverr message, offer, proposal, bid, order, purchase, or other commitment before it happens.

## What the scout is looking for

Find buyers who may need a small, clearly scoped AI-assisted service that the agency can deliver responsibly:

- AI ad creatives, social ad graphics, Meta/Facebook/Instagram ad packs
- AI chatbot setup, FAQ bots, customer-support automation, prompt/workflow help
- AI content, captions, product descriptions, blog or social-content packages
- AI logo concepts, brand kits, flyers, banners, thumbnails, and visual refreshes
- AI image generation, product mockups, short-form video concepts, or ad copy
- Local-business marketing, lead-generation creative, and same-night promo packages

Do not claim guaranteed leads, sales, revenue, platform approval, or a human credential that does not exist. Mark AI-assisted work and human review requirements in the handoff.

## Search query bank

Use Fiverr's own search and filters in a browser. Try one query at a time, then narrow by category, budget, delivery time, language, reviews, and relevant portfolio:

### Ads and creative

- `AI ads`
- `AI ad creative`
- `Facebook ads design`
- `Instagram ads`
- `Meta ad creative`
- `social media ad design`
- `ad copy AI`
- `product ad video`
- `local business flyer`
- `restaurant promotion design`

### Chatbots and automation

- `AI chatbot`
- `chatbot for small business`
- `customer support chatbot`
- `ChatGPT chatbot integration`
- `FAQ bot`
- `AI automation`
- `lead capture chatbot`
- `website chatbot setup`

### Content

- `AI content writing`
- `social media content`
- `Instagram captions`
- `product descriptions AI`
- `blog content AI`
- `email copywriting AI`
- `content repurposing`
- `short form video scripts`

### Branding and image work

- `AI logo design`
- `logo and brand kit`
- `AI image generation`
- `product mockup`
- `YouTube thumbnail AI`
- `AI flyer design`
- `brand social media kit`

Also test a buyer's wording rather than only service wording, for example `need chatbot for salon`, `restaurant ads`, `real estate social content`, or `ecommerce product images`. Search result labels and category names change; record the actual page label instead of guessing.

## Browser-first, ToS-aware operating rule

Prefer a manual scout in Fiverr's browser with the owner logged in. Fiverr buyer-request/brief features and visibility can change; buyer requests are often restricted to, or most useful from, a seller account. If the feature is not visible, record `not visible / account-dependent` rather than inventing results.

Do **not** scrape Fiverr, bypass a login, defeat rate limits, automate browsing, or copy large datasets. Follow Fiverr's current Terms, robots/rate limits, and account rules. Do not use an unofficial API or a made-up endpoint. A scout may capture a small set of links and notes that the owner can verify in the browser.

Never ask an agent to store, transmit, or repeat a Fiverr password, session cookie, token, or recovery code. Never put Fiverr credentials in Flutter, Worker environment variables, prompts, logs, memory, tickets, or this repository. The owner controls the signed-in browser session.

## What to capture per opportunity

Create one short record per useful result. Keep only information needed for a decision:

- **Date/time:** local date and time of the scout
- **Search/query and URL:** exact query plus the public Fiverr page or owner-verified page URL
- **Gig category:** displayed category/subcategory and service type
- **Buyer request/brief:** if a Buyer Requests/Briefs view is visible, summarize the request, scope, budget, deadline, and stated need; do not copy private data unnecessarily
- **Competitor gig:** title, seller display name or profile link, rating/review count, portfolio signal, delivery time, inclusions, and differentiator
- **Pricing:** displayed package prices, add-ons, currency, and delivery/revision terms; label as observed, not a quote
- **Fit:** which agency offer maps to it (for example, Tonight Pack, chatbot discovery, or content starter)
- **Risks:** copyright/likeness, regulated claims, personal data, unclear scope, platform restrictions, or work that needs a specialist
- **Evidence and confidence:** link, screenshot/note location if permitted, and `high / medium / low` confidence
- **Next step:** `watch`, `ask owner`, `owner-approved message`, or `discard`

Do not contact a buyer or seller, submit a bid, send an offer, place an order, accept a brief, or purchase a gig as part of scouting. An agent can draft copy, but the owner must review and explicitly confirm the exact recipient, action, and text in the approved channel before any outbound action.

## Suggested scout note

```text
Fiverr scout — YYYY-MM-DD HH:MM America/Chicago
Query:
Category:
Buyer request/brief (if visible):
Competitor gig(s):
Observed pricing/delivery:
Potential agency fit:
Risks / missing facts:
URL(s):
Confidence: high | medium | low
Recommendation: watch | ask owner | owner-approved message | discard
Owner decision: pending
```

## Owner gate

Before any Fiverr activity beyond reversible research, show the owner:

1. the buyer/request or gig URL,
2. the proposed service and price range,
3. the exact recipient and channel,
4. the complete draft message or offer,
5. delivery assumptions, revisions, and risks.

Proceed only after the owner confirms that specific message, bid, order, or purchase. No confirmation means no outbound action. Never auto-purchase, auto-accept, or spend the owner's money.

## Public demand refresh (2026-09-29)

See [`FIVERR_PUBLIC_DEMAND.md`](./FIVERR_PUBLIC_DEMAND.md) for no-login Fiverr-published search growth (June 2026 index). Do not treat it as live buyer requests.

**Blocker:** Iris/Atlas Fiverr jobs need an xAI Worker secret (`XAI_API_KEY` or equivalent). It is not in `.dev.vars` today, so the model step does not run.
