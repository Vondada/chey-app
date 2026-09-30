# Opportunity Scout — Forever shortlist playbook

This is a **research and handoff playbook**, not an auto-outreach, auto-purchase, or auto-spend workflow. Atlas (Research), Iris (Ad Studio), and CHE may prepare **owner-review shortlists** from public channels. The owner must confirm any message, bid, order, inventory buy, ad spend, or other commitment before it happens.

Fiverr-specific detail lives in [`FIVERR_SCOUT.md`](./FIVERR_SCOUT.md). This doc covers the **umbrella** forever scout: Fiverr + Pinterest + dropship/middleman + other public marketplaces where the owner can sell services or digital offers.

## Hard rules (every channel)

- **Maximize legal money-making** for the owner. **No artificial product boundaries** — any lawful, reality-possible offer, channel, or service angle is in scope.
- **Hard stops only:** illegal activity, or things impossible in reality. Do **not** implement or propose illegal schemes.
- **Shortlist only** until the owner confirms the exact recipient, channel, and text (or purchase / Stripe charge).
- **Owner confirm required** before spend, outreach, bids, purchases, inventory buys, ad spend, or Stripe charges.
- **Never** auto-message, auto-bid, auto-accept, auto-publish, auto-follow, auto-buy inventory, or auto-charge.
- **Never** store marketplace passwords, session cookies, tokens, or recovery codes in the Worker, Flutter, prompts, logs, memory, or this repo.
- Prefer **browser-first** scouting with the owner signed in. Do not scrape behind logins, bypass rate limits, or invent unofficial APIs.
- Distilled findings go into Durable Object **memory notes** (channel, offer, why, URL) via the research→memory learning loop — owner-visible, no silent PII dumps.

## Channels

| Channel | What to look for | Owner benefit angle |
|---|---|---|
| **Fiverr** | Buyer requests / briefs (if visible), competitor gigs, AI ads / chatbot / content / design demand | Sell Tonight Pack, Mid, Starter, chatbot, content |
| **Pinterest** | Trending pins/boards for digital downloads, printables, templates, product mockups, ad creative ideas | Sell digital products, creative packs, lead magnets |
| **Dropship / middleman** | Public supplier catalogs, POD, white-label, niche gadgets — **leads and angles only** | Middleman service, custom fulfillment offer, curated catalog pitch |
| **Other marketplaces** | Upwork/Etsy/Gumroad-style public listings for AI design, ads, content (read-only shortlist) | Match honest agency / digital offers |

## What to capture per opportunity

One short record per useful lead:

1. **Channel** — fiverr | pinterest | dropship_middleman | marketplace | multi  
2. **Offer** — the service or product angle the owner could sell  
3. **Why** — why this fits the owner (demand signal, fit to existing packs, low risk)  
4. **URL** — public page the owner can open and verify  
5. Observed pricing/terms (label as observed, not a quote)  
6. Risks / missing facts / confidence (`high` / `medium` / `low`)  
7. Recommendation: `watch` | `ask owner` | `owner-approved message` | `discard`  
8. **Owner decision: pending**

## Suggested scout note

```text
Opportunity scout — YYYY-MM-DD HH:MM America/Chicago
Channel:
Query:
Offer / service angle:
Why it fits the owner:
URL:
Observed pricing / terms (if public):
Risks / missing facts:
Confidence: high | medium | low
Recommendation: watch | ask owner | owner-approved message | discard
Owner decision: pending
Hard rules: maximize legal money-making; no artificial product walls; never auto-message/bid/buy/spend/Stripe without owner confirm; never illegal or impossible schemes.
```

## Pinterest notes

- Use public search and boards in a browser. Capture pin/board URLs and themes, not private accounts.
- Good angles: printable planners, wall art, social templates, AI mockup inspo, seasonal promo boards.
- Do not claim Pinterest ads were placed or that a pin was published unless a connected tool confirms it after owner approval.

## Dropship / middleman notes

- Scout **public** supplier pages and categories for middleman *service* opportunities (sourcing + listing + customer handling), not silent bulk buys.
- Record supplier URL, product niche, estimated landed cost if publicly shown, fulfillment constraints, and brand/IP risks.
- **No inventory purchase** and **no supplier order** without owner confirm of item, quantity, and budget.
- Cannabis, weapons, and other disallowed SKUs stay out of CHE catalogs (see agency offer docs).

## Learning loop

When Atlas/Iris complete an `opportunity_scout` / `fiverr_scout` / research-style job, CHE distills findings into Durable Object memory notes (`title` + short bullets + source URLs, with channel/offer/why/URL for opportunities). Notes appear via existing memory/state endpoints. Secrets and credentials are rejected.

## Owner gate

Before anything beyond reversible research, show the owner:

1. the lead URL,  
2. the proposed offer and price range,  
3. the exact recipient and channel (or supplier + quantity for a buy),  
4. the complete draft message / listing / order summary,  
5. delivery, inventory, and risk assumptions.

Proceed only after confirm. No confirmation means no outbound action, no spend, and no Stripe charge.

## Public demand refresh (2026-09-29)

Logged-out Fiverr search-growth notes (Fiverr Business Trends Index, June 2026) are in [`FIVERR_PUBLIC_DEMAND.md`](./FIVERR_PUBLIC_DEMAND.md). They are watch-only. No messages or spend were seeded.

**Blocker:** Atlas and Iris prefer xAI. Without `XAI_API_KEY` (or `CHE_XAI_API_KEY` / `GROK_API_KEY` / `CHE_XAI_MODEL_URL`) on the Worker, opportunity and Fiverr scout jobs stay `Blocked: tool not configured (Grok)`.
