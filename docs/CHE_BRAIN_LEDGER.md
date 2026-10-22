# CHE Brain Population Ledger

What entered CHE's brain, when, in which category, from where, what it became, and whether it is usable yet.
Code: `server/cloudflare/brain_ledger.js` (Worker), `lib/brain/che_brain_ledger_screen.dart` (More → Brain Ledger).

## Model
- **Category first.** Every event has one category (Music, Trading, Coding, Legal, Health, Security, Business, Create,
  Video, Images, Workflows, Projects, Owner Preferences, Agents, General Knowledge) and one subcategory. Time is
  metadata on every event: an exact ISO timestamp, shown in the owner's zone ("Today · 4:31 PM", full date on open).
- **States.** DISCOVERED → INDEXED → UNDERSTOOD → PROCEDURE → IMPLEMENTED → TESTED → VERIFIED → AVAILABLE, plus
  PENDING, REJECTED, CORRECTED, FAILED, REMOVED, DEGRADED, RETIRED. Only VERIFIED/AVAILABLE capabilities (from the
  capability registry) are called capabilities; information, indexed knowledge and procedures are labelled as such.
- **Append-only**, one SQLite row per event in the Durable Object (no value near the 128 KB limit), capped at 60,000.

## No silent population
Every persistent knowledge write leaves a ledger event (`WRITE_PATHS`, asserted in `brain_ledger.test.mjs`):
`CheBrainStore.write`, Knowledge Library catalog/index/index-failed, `KnowledgeItems.put` (capability-engine layers),
and `storage.put` of owner memories (`che`), the capability registry, the workflow engine, closed trades (`evr:*`,
grouped as one batch), evidence runs and the backtest matrix. The first sight of a key-value store is a baseline,
never a flood of invented "new" events. A ledger failure never blocks the write.

## Batches, dedupe, corrections
- A batch (backtest matrix, a set of closed trades) shows as one grouped entry with a receipt; every member stays
  reachable (`?batch=`).
- The same knowledge arriving again is EVIDENCE_STRENGTHENED on the same item, never a second item.
- A correction keeps the original and corrected statements side by side.

## Privacy
Titles, summaries and references pass Security Intelligence's scanner (`looksSecret`); anything credential-shaped
becomes a safe label ("Security item"). Removing an item or rejecting a pending item keeps metadata only and scrubs
the item's earlier ledger text.

## Owner surfaces
- Chat (voice or typing, no model call): "what entered your brain today", "what entered your trading brain",
  "what did you learn about music", "what knowledge is still pending", "what failed to index",
  "when/where did you learn that", "do you know how to …". "What did you learn about <topic>" for a non-category
  topic stays with the Capability Engine.
- `GET /api/brain/ledger` (cards, totals, recent), `?category=`, `?event=` (history, capability, workflows that use
  it), `?batch=`, `?q=`; `POST /api/brain/ledger/decide {record_id, decision: commit|reject}`. Owner device only.
- More → Brain Ledger: category cards, category view with subcategory filters, batches, event detail, Commit/Reject
  for pending items. Loading is quiet; Read Aloud and owner actions speak (with haptics and a VoiceOver announcement).
