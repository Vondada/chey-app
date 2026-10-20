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
its new state and a link to the replacement, and links the new record to related records in any
room (see "Relationship discovery" below). This is incremental: a few FTS queries per event, never a
rescan.

Delivery is at least once and idempotent. The drain publishes each queued event and then removes only the
events it handled; an event the Brain could not take stays queued. A crash between the write and the removal
means the event is published again next time, and the Brain answers the repeat with 'present', so it is never
written twice. Queue writes run through one chain inside the isolate, so a queued event cannot be lost to a
concurrent removal.

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
after fifteen minutes (the stale entry is deleted from storage, not only ignored), or with nothing shared, CHE says she
cannot see the screen. Only the owner's device writes or reads this memory. A summary that fails the sensitive-text
gate (a password, a card number) is never kept. Two lists of phrases exist: a narrow list of visual references
("the button on the left", "you see this?") that gets the "cannot see" answer when no screen is shared, and a
broader list ("what does this do?", "compare this to your knowledge") that uses a fresh screen when there is one
and is never a refusal, so an ordinary code question is answered by the model. A vision result
names its engine in the reply ("Seen with gemini-media…") and in the done event (`vision`), and a
failed analysis says so. The screen's room is detected (`screenRoomFor`); for the Trading Room the
authoritative ledgers are read into the prompt so a number on the screen is never taken for a
record, and for other rooms the Brain's related records are. "Connect this to the Brain" saves the
observation as an `observed` record with its links.

### Relationship discovery (`brain_relations.js`)

Title words alone missed most real connections: a deploy receipt and a screenshot of the same pull
request share no title word. A new record is now related to others by what they actually share:

| Basis | Example | Status | Link type |
| --- | --- | --- | --- |
| Same pull request, commit, coding job, REA investigation, repository, file or npm package | "Update #374 deployed" and "Screen: checks for PR #374" | derived | `builds_upon` for a later stage in the same room, `relevant_to` with a screen observation, else `related_to` |
| Same market symbol, trade record set or website | an REA investigation of an MNQ tool and a Trading Room journal record | derived | `related_to`, across rooms only, and dropped when more than six records carry it |
| Three distinctive shared words in title and body (or two in both titles) | two notes about websocket reconnect backoff | candidate | `related_to` |

References are read from the title, body and `source.refs`; the provenance lines a room event adds
(status, evidence, source room) are ignored. A bare capitalised word is a symbol only if it is on
the symbol list or written `$TICKER`; "update 3" is not a pull request ("Update #3" is). Each link is
kept in `source.relations` with its basis, the shared values and its status; a derived link is also
written on the other record, so it is found from either side. Older room records are relinked a dozen
per alarm (`relinkRecords`) until none are left; `RELATIONS_VERSION` restarts that when the rules
change.

The owner asks "What is connected to pull request 374?", "What else is linked to job c2987a73?",
"What's related to this?" (with a screen shared) or "How is PR 371 related to job c2987a73?". These
are answered from the records only, before the GitHub status readers, with each link's room, status
and reason, and "no recorded link" when there is none. They parse only when the subject is an exact
identifier, "this" with a fresh screen, or the sentence says "in the Brain" or names a room: "What is
related to diabetes?" and "What is related to Three.js?" stay with the model.

Not used: embeddings. `vector_memory.js` can embed text when pgvector is connected, but that is a paid
network call per record; semantic links would be `inferred` and are left for later.

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
- Semantic relationships (embeddings through `vector_memory.js`, status `inferred`).
- The Brain Room UI: show `source.room`, status and `source.relations` (basis, status) on a record card.
