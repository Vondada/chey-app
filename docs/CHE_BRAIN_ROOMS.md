# CHE's rooms and the Brain as coordinator (2026-10-20)

The owner's requirement: one assistant across every room, with the Brain Room as the central
knowledge coordinator. This page records what existed on main `efec379` before the change, what
owns what, how knowledge now flows, and what remains for later. It builds on
`CHE_UNIFIED_BRAIN.md` (the record schema, reconciliation, endpoints and the phone replica) and
changes none of it.

## 1. What existed (audit of main efec379)

| Room | Authoritative data (read live) | Where it lives | Published to the Brain before this change |
|---|---|---|---|
| Chat | conversation history, corrections | `data.memories`, `brainmem`, `conv:` records | yes: `rememberExchange` writes every exchange (`owner_attested`) |
| Memory | owner-confirmed memories, preferences | `data.memory_records`, `ownerMemoryRecord` | yes: projected on every Brain sync (`projectLegacyState`) |
| Trading Room | five trade record sets (`trading_ledgers.js`), paper orders, Trading Atlas | `strategy_sim_*`, `live_paper_*`, `evr:` records, `trading_paper_book`, Alpaca | no: trades never reached the Brain; the Atlas cards did (`projectAtlasToBrain`) |
| Coding Room | coding jobs, pull requests, CI, deploys, change history | `che_receipts`, `che_change_history`, `data.jobs` | no (task records of the Office crew only) |
| REA | investigations, feature maps, comparisons, proposals | `rea_jobs`, `rea_inv:*`, `mailbox/rea` on che-mailbox | no |
| Research | research notes, knowledge cache | `data.memory_notes`, `knowledge_cache.js` | yes: notes projected as `unverified_research_lead` |
| Office | worker tasks, work histories, Flagstaff mail | `data.team_tasks`, worker brains, `web_mailbox.js` | yes: `projectOfficeExperience`, `archiveTasks` |
| Knowledge Atlas | teaching cards, the owner's practice | `knowledge_atlas.js` | yes: `projectAtlasToBrain`, `recordLearning` |
| Music Room | the connected music service (`CHE_MUSIC_URL`), the 3D music studio scene | plugin results only | no (no music knowledge store exists; the scene is navigation) |
| Screen | what the owner shows (a phone page report `screen_context`, an attachment analysed by a vision engine) | per turn only | no; nothing survived the turn, so a follow-up had no screen |

How the Brain indexed and retrieved: `CheBrainStore` (SQLite in the Durable Object, FTS5 search,
sixteen regions, typed links, a revision per record, a change feed). Chat read the Brain only
through the phone: the replica sent `brain_context` lines with each turn; the Worker never searched
its own store for a chat answer. Real-time propagation: the phone polled `/api/brain/changes`; the
Worker projected legacy stores at most every ten minutes on a sync. Records were authoritative
(`owner_attested`, `verified_source`), derived lessons (`curated_lesson`, `owner_practice`),
unverified (`unverified_reference`, `unverified_research_lead`, `model_opinion`, `hypothesis`) or
`unknown`. Reliability mechanisms kept: the revision/conflict reconciliation, the sensitive-text
gate (`isSafeText`), the ten-minute projection budget, the receipts and change history as the only
proof of coding actions, the truth guards on every model reply.

## 2. What changed

**Statuses.** `VERIFICATION_STATES` gained `derived`, `observed`, `inferred`, `proposed`,
`superseded` and `contradicted` (a verified room fact is `verified_source`, a hypothesis
`hypothesis`, unknown `unknown`). Nothing promotes an inference or an idea to a verified memory:
the status is set by the producing room and only a newer record changes it.

**Room events (`room_events.js`, `brain_rooms.js`).** A room queues one event per verified fact or
meaningful change: room, kind, key (dedupe), title, body, status, evidence, refs (where the
authoritative record is), confidence, derivation, whether the owner must confirm it, whether to
surface it, what it supersedes or contradicts, sensitivity. The Brain drains the queue on the next
chat turn, Brain sync (`/api/brain/status`, `/api/brain/changes`) and alarm, writes one record under
the room's region with `source.kind = 'room_event'`, marks a superseded or contradicted record with
its new state and a link to the replacement, and links the new record to records in any room whose
titles share two or more words (`related_to`, candidate links kept in `source.candidate_links`).
This is incremental: one FTS query per event, never a rescan.

Producers wired now: every receipt (`truth_layer.recordReceipt`: coding jobs, pull requests, CI,
merges, deploys, paper orders, Flagstaff mail), the forward paper journal and the strategy
simulation (closed trades, from the alarm tick), REA (an npm inspection, an investigation and a
browser run completing), the owner's screen when he says "connect this to the Brain" (status
`observed`). Chat exchanges, memories, research notes, Office work and Atlas learning keep their
existing projections.

**Retrieval (`crossRoomIntent`, `answerCrossRoom`).** "What does the Trading Room know about MNQ?",
"Did we learn anything about X in another room?", "Does the Music Room have related information?",
"What does the Brain know about this?" are answered at the `che_brain_rooms` route from the Brain's
records of each room (title, status, date) plus that room's live reader (the ledgers for Trading,
the change history for Coding, the investigations for REA), numbered by source, with no model call.
Nothing recorded is said so. On every other owner turn the Worker's own Brain adds up to five
matching records (room, status, date, title) to the model's reference context next to the phone's
`brain_context`; past chat exchanges are left out of that so an old answer never feeds a new one.

**The owner's screen.** The latest observation (a vision summary, or the phone's page report) is
kept for fifteen minutes as `che_last_screen`, never the image. "What about the button on the
left?", "you see this?", "what does this do?" use it as the screen context, labelled temporary;
after fifteen minutes, or with nothing shared, CHE says she cannot see the screen. A vision result
names its engine in the reply ("Seen with gemini-media…") and in the done event (`vision`), and a
failed analysis says so. The screen's room is detected (`screenRoomFor`); for the Trading Room the
authoritative ledgers are read into the prompt so a number on the screen is never taken for a
record, and for other rooms the Brain's related records are. "Connect this to the Brain" saves the
observation as an `observed` record with its links.

## 3. The flow

Question or event → intent and room (`crossRoomIntent`, `ledgerIntent`, `screenRoomFor`, the
existing routes) → the Brain's records by region plus the room's live reader → provenance and
status on every item → one answer by source, or the model with labelled reference context → the
reply guards (`truth_layer.js`) → receipts and room events → the Brain → the phone replica.

## 4. Still to do (later PRs)

- Music knowledge: there is no music record store; a Music Room event producer waits for one.
- The phone: "look at my screen" during voice should capture CHE's own screen and send it as the
  attachment with the active room (Dart, Shorebird); sharing another app's screen needs the iOS
  ReplayKit broadcast extension, an app group and a new IPA (native, not patchable).
- Relationship discovery beyond shared title words (embeddings exist in `vector_memory.js` when
  pgvector is connected; not wired to room events).
- The Brain Room UI: show `source.room`, status and candidate links on a record card.
