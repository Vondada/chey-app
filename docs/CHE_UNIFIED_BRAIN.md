# CHE Unified Brain

One logical Brain with two replicas: the Worker's (Durable Object SQLite) and the
phone's (a journal and snapshot under the app's Documents folder). The same record
ids, folder regions, verification labels, relationships and revision numbers on both
sides; incremental sync in both directions; nothing discarded silently.

This document records what existed before (phase 1 audit, 2026-10-17), what the first
Brain PR builds (phases 2–4), what is verified and how, and what is not yet done.

## 1. Audit of what existed (2026-10-17, main a3be02c)

Three disconnected stores held CHE's memory, with different meanings and no sync:

| Store | Where | What it kept | Limits found |
|---|---|---|---|
| Owner memories | Worker state blob `data.memories` / `data.memory_records` (`research_memory.js`) | Owner-attested facts with provenance | `MAX_MEMORIES = 100`; records sliced to 400; `learned_knowledge` sliced to 30 |
| Research notes | `data.memory_notes` | Agent research leads, `unverified_research_lead` | Soft cap 50 000 (DO blob safety) |
| Conversations | `brainmem:*` keys (`brain_memory.js`) | Owner's message clipped to 1 200 chars + **first sentences (600 chars) of CHE's answer** | The answer itself was not kept |
| Library | DO SQLite `lib_docs/lib_chunks/lib_fts` (`library.js`) | Whole texts, word for word, FTS5 | 3 M chars per doc (physical) |
| Phone "CheBrain" | Documents/che_brain (`lib/che_ui/che_brain.dart`) | Phone-only facts, journal, soul | Never synced; a separate mind |
| Phone chat logs | Documents/che_logs | Every conversation, phone only | Never synced |
| Phone agent state | RAM only (`_loadAgentState`) | Memories, notes, conversation memories, brain links from `/api/state` | Lost on restart; nothing offline |
| Knowledge cache | `che_knowledge_cache.json` | Verified-source answers only | 3 000 entries, 7 days |
| Offline library | Documents/che_library | Library docs synced down | Down only |

Offline intelligence: `lib/che_local_brain.dart` pins SmolLM2 1.7B Q4_K_M (sha256
empty) on a `che/local_brain` channel that has **no native implementation**; every
call falls through to `CheLocalAI` (Apple FoundationModels, iOS 26+, patched in at build
time by `tool/patch_local_runtime.py`). So the offline model is FoundationModels or
nothing. SmolLM2 is not installed, not downloaded, not run.

`/api/state` sent the whole memory set on every load (memories, records, all notes,
up to 2 000 conversation memories, the brain graph). The Brain room drew from that
payload only, so offline it was empty.

## 2. Architecture

### 2.1 One record

`server/cloudflare/brain_store.js` — `CheBrainStore` over DO SQLite:

- `brain_records` (id, kind, region, path, title, body, source, verification,
  significance, links, rev, hash, created_at, updated_at, origin, deleted, seq)
- `brain_places` — a record's region/folder plus any further views, so one record can
  appear in several folders without duplication
- `brain_ops` — op ids, for idempotent sync (a replayed op returns its stored outcome)
- `brain_conflicts` — both copies of every unresolved concurrent edit
- `brain_meta` — the seq counter, legacy projection hashes, the brainmem backfill cursor
- `brain_fts` — FTS5 over title and body (LIKE fallback when FTS5 is unavailable)

Stable ids: `mem:<memory_record id>`, `note:<memory_note id>`, `know:<fnv1a32 of
lesson>`, `conv:<brainmem id>`, `task:<team_task id>`, `review:<nightly at>`,
`lib:<library doc id>`; records created on the phone get `mem:`/`conv:`/`phone:` ids
from the phone and keep them everywhere.

Sixteen regions (`BRAIN_REGIONS`): Conversations and Corrections, Personal Memory,
Learned Knowledge, Coding and Development, Trading and Market Research, YouTube and
Media, Business and Finance, REA Investigations, Office Agents, Skills and Tools,
Experiments and Lessons, CHE Self-Knowledge, Problems and Opportunities, Projects and
Proposals, Daily Audits and Conclusions, Active and Historical Tasks.

Eighteen relationship types (`RELATIONSHIP_TYPES`): learned_from, related_to,
builds_upon, verified_by, contradicts, corrected_by, produced_by_agent,
implemented_in_code, result_of_experiment, superseded_by, relevant_to, solves, tests,
inspired_by, requires_verification, escalated_to, used_by_project, discovered_by_audit.

Verification labels (`VERIFICATION_STATES`, the che-fact-check vocabulary):
owner_attested, verified_source, unverified_reference, unverified_research_lead,
model_opinion, hypothesis, unknown. A model's text is never stored as a fact.

Significance (`assessSignificance`) is rule-based and explained: every score carries
its reasons (owner said it, a correction, verified source, relationships, superseded,
very short). An owner score (`significance.owner_score`) always wins. No model is
asked.

### 2.2 Reconciliation (`CheBrainStore.apply`)

| Case | Outcome |
|---|---|
| Same op id again | `duplicate` — the first outcome, nothing changes |
| New id | `created`, rev 1 |
| Same content, same links | `unchanged` |
| Same content, different links | `merged` — union of links, rev+1 |
| `base_rev` equals current rev | `updated`, rev+1 (links union) |
| `base_rev` differs (concurrent edit) | `conflict` — the stored copy stays, the incoming copy is kept in `brain_conflicts`, the client is told and keeps its own copy too |
| Delete | `deleted` — always wins (owner privacy), tombstone with content cleared, rev+1; CHE's own later writes (`put`, the legacy projection) never recreate it |
| Put after delete | `deleted` unless the client saw the tombstone (`base_rev` equal), then re-created |
| Secrets (`isSafeText`: the `/api/memory/add` words and the privacy policy's secret class over the whole title, body and source at once) | `rejected`, from either side; the phone refuses the same words before writing anything |

Integrity digest: `count` and `Σ fnv1a32("id:rev") mod 2^32` over all records,
tombstones included. The phone computes the same (`cheFnv1a32`), and a sync receipt
says whether they match.

### 2.3 Endpoints (owner's device only)

`GET /api/brain/status` (real counts, by kind, by verification, regions, conflicts,
digest, projection and backfill cursors) · `GET /api/brain/changes?since&limit`
(oldest first, tombstones included; each pull also projects the legacy stores and
backfills 100 brainmem records) · `POST /api/brain/push {ops, device}` ·
`GET /api/brain/search?q&region` · `GET /api/brain/folders[?region&path]` ·
`GET|POST|DELETE /api/brain/record` · `GET /api/brain/conflicts` ·
`POST /api/brain/conflicts/resolve {id, choice}`.

### 2.4 Hooks into existing stores (no second memory system)

- Every owner chat exchange is kept **word for word** as `conv:<id>` (same id as its
  brainmem record) in Conversations and Corrections/Chat/<day>, after the same
  sensitive-text gate (`rememberExchange`).
- `projectLegacyState` projects memory_records, memory_notes, learned_knowledge,
  team_tasks, nightly_reviews and library index cards into the Brain with stable ids,
  skipping by hash so the blob and the Brain never ping-pong.
- `backfillConversations` brings the older brainmem records in, resumably, marked
  `full_text: false` ("legacy record: the owner's words and the first sentences of
  CHE's answer"); a fuller live record is never replaced.
- A memory pushed from the phone (`mem:` kind memory) joins `data.memories` /
  `data.memory_records` with the same id (`addOwnerMemory(..., { id })`); an edit there
  changes its words here; a memory deleted on the phone leaves them (decided by the op,
  not by the tombstone's source). `data.memories` holds a 500-character single-line
  **display copy** of each memory; the Brain record is the truth, and the projection never
  writes the copy back over a phone-authored or fuller record (only its active and
  supersession flags carry over, through `amendSource`). `/api/memory/delete`, `/api/memory/clear` and
  `DELETE /api/library` write tombstones so every replica forgets too.
- `nightly()` runs the projection and a 500-record backfill batch; no model call.

### 2.5 The phone replica (`lib/memory/che_brain_replica.dart`)

Pure Dart (a Shorebird patch cannot add a native plugin): `snapshot.ndjson` +
append-only `journal.ndjson` (one flushed write per sync page; a local change writes its
record and its op in one line pair; writes and compaction take turns through a lock;
compaction waits until the journal is half the record count, so a large sync stays
linear) + `bodies/` for every body over 600 chars (the excerpt); an in-memory index with interned token ids (`Uint32List` per record)
for offline search. Durable local writes (`remember`, `forget`, `queueRemoteRequest`)
go to the journal before they return; the outbox is cleared op by op only when the
Worker has answered; a failed sync leaves outbox and cursor untouched; conflicts keep
both copies; a rejected record stays, marked `sync_note`; a replayed op is read by its first
outcome. `remember()` refuses a text that names a password, key or code before anything
touches the disk; `saveMemory` returns what really happened (`saved`, `saved_offline`,
`refused`, `failed`) and the reply says exactly that, never "saved" for a refusal; an
offline `deleteMemory` becomes a replica tombstone; a push answered with the Worker's copy
takes it with its body file (no orphans); a replayed journal queues each op once. `sync()` pushes, pulls in pages of 500 from the cursor, compares
digests, and returns a `CheBrainSyncReceipt` with real counts and a spoken form.

Wired in: `_loadAgentState` starts a sync after each state load and, when the cloud
cannot be reached, fills the memory and conversation lists from the replica; the
offline answer path adds replica recall labeled by region and verification;
`saveMemory` keeps the memory in the replica when the network fails; the Brain room
draws replica records (deduplicated by id) and shows one quiet caption with real
counts and the last receipt (never spoken on its own, per the owner's silence rule).

Protection at rest: the replica lives in the app's Documents container, which iOS
Data Protection encrypts with the device key (class
`NSFileProtectionCompleteUntilFirstUserAuthentication`). No app-level encryption layer
has been added; secrets are refused before storage on both sides; passwords stay in
the Keychain vault and never enter the Brain.

## 3. Verified and not verified

Verified (automated, offline, this PR):

- `server/cloudflare/brain_store.test.mjs` — 18 tests: regions/relationships/labels;
  fnv1a32 reference values; normalization; significance rules and owner override;
  created/unchanged/merged/updated/conflict/resolve; duplicate op; delete wins and
  re-create after tombstone; secrets rejected; changes paging with tombstones and the
  digest against an independent computation; search/folders/list through places;
  idempotent legacy projection with stable ids; live exchange word for word and
  resumable brainmem backfill that never replaces it; contentHash ignores links; a secret
  past the 500th character refused; a deleted record not resurrected by `put` or by the
  projection; a subset of links is unchanged; the display copy never overwrites a
  phone-authored or fuller memory (flags only); a clean text is never refused at a window
  cut and source fields are scanned; the display copy is idempotent even when the cut lands
  on a space.
- `server/cloudflare/brain_sync.test.mjs` — 11 tests through the real Worker: owner
  gate (401 without a device); phone memory → `/api/state` with the same id, duplicate
  op, `/changes`, no conflict from the projection; Memory-screen delete → tombstone,
  clear → all tombstones, deleted memory not searchable; chat exchange kept word for
  word with the brainmem id, searchable, counted in folders; concurrent edit kept as a
  conflict and resolved by the owner, digest equals one id:rev hash; a phone edit changes
  the memory's words in `/api/state`, a phone delete removes it and the next projection
  leaves it deleted, a replayed delete answers duplicate/first_outcome deleted; a 3 000-char
  phone memory stays whole through the projection while the memory list shows its display
  copy; a twin pushed under its own id is deleted by the Memory screen and "clear all"
  clears every memory record; a flags-only amendment keeps the author and does not turn the
  phone's next edit into a conflict; a case-only twin is deleted with its row and a different
  text behind the same first 500 characters becomes a twin, never an overwrite; two phone
  pushes of a text cut on a space leave one row whose delete reaches both.
- `test/che_brain_replica_test.dart` — 14 tests with an in-memory fake Worker that
  returns the same outcomes: durable write + restart replay; push/pull/ack/digest
  match; failed push drops nothing; delete both ways; conflict with both copies,
  rejected record kept, resolve re-queues; 1 203-record paged pull interrupted and
  resumed from its cursor, long body in a file; queued offline request says it did
  not run; a secret never written and a 1 550-char body kept whole across a restart; a
  replayed op read by its first outcome; a replayed journal queues each op once and only
  the last put per record; forgetting by words removes every twin, case and a cut on a space
  included; a recreate after an offline forget sends one put; scale on the VM: 10 000 records sync 1.9 s,
  search 10 ms, load 1.6 s; 100 000 records (`CHE_BRAIN_SCALE=100000`) sync 26.7 s,
  search 90 ms, load 14.9 s.
- `run_checks.sh` (2026-10-18, after review 5): Worker 1817/1824 (7 skipped), dart analyze
  clean, flutter test +448.
- Seventh independent review (2026-10-18): four blocking findings, fixed above. The Memory
  list hydrated from the replica used the raw 600-character excerpt, so a delete after an
  offline start was answered "already gone" while the memory stayed; the list now shows the
  display copy of the whole body (inactive records skipped) and the Worker compares display
  copies. A background reload could move the list under the owner's finger and the sheet sent
  the slot's new words: the row's words are captured when it is built. A clean text whose
  500-character cut ended on "pin|nacle" was refused as a secret on the add route, and the same
  text pushed from the phone landed in the Brain with no list row: the whole text is gated
  (`addOwnerMemory` before the clip), and a pushed memory the list's gate still refuses is
  tombstoned and reported `rejected`, never "created". "Clear all" sent no body and the 400 was
  ignored in silence: the phone sends one, the Worker reads an empty body as `{}`, and the
  outcome is spoken. Noted, not changed: an online re-save racing a pending offline delete;
  a memory saved offline before "clear all" returning with the push; the 500-char copy of a
  longer memory re-added as a prefix twin; `rememberExchange` titles gated on the cut;
  `MAX_MEMORIES=100`; record ids not gated; policy-level refusals ("bowling pin").
- Sixth independent review (2026-10-18): fixed above. `/api/memory/delete` deletes by the row's
  words when the index moved and answers 404 when the words are gone; a twin's tombstone reaches
  every twin on the row; `/api/memory/add` makes a twin only when the text really differs;
  `attachPlaces` reads ids in chunks of 90 (the Durable Object's bound-parameter limit);
  `reassess` keeps `updated_at` and the author; `rememberExchange` keeps the owner's turn when
  the reply trips the gate (`reply_withheld`); the phone speaks a failed delete.
- Fifth independent review (2026-10-18): two blocking findings, fixed above. A text whose
  500th collapsed character was a space escaped `sameDisplayCopy` (the copy was trimmed before
  the cut, so a copy of a copy differed): `displayCopy`, `clip` and the phone's `_displayCopy`
  now trim after the cut, so the Memory screen's delete reaches such twins. A second online
  save with the same first 500 characters but a different text overwrote the earlier text in
  the Brain: it now lives under its own id as a twin noted on the row (`brain_twins`), a text
  that merely continues the first still edits the row, and the row's delete tombstones every
  twin noted on it. Also fixed: a memory remembered again on the phone after an offline forget
  sends one put against the live revision (the recreate supersedes the pending delete).
- Fourth independent review (2026-10-18): one blocking finding, fixed above (twins of a
  memory that differed only in letter case, or that the Memory screen listed under a 500-char
  copy, survived the row's delete; deletion now matches the way the list dedupes).
- Third independent review (2026-10-18): one blocking finding, fixed above (a memory the
  phone pushed as a twin of an existing display copy had no list row, so the Memory screen's
  delete and "clear all" left it live; now deletion reaches every memory record showing the
  deleted words and "clear all" clears every memory record), plus the latent re-run of the
  display-copy overwrite (`amendSource` keeps the author; the push handler stores the
  collapsed copy), false conflicts after a flags-only amendment (`source.content_rev`),
  replay dedupe by record, the gate over links/path/kind, the online save keeping the whole
  text in the Brain, the save timeout and the spoken offline delete.
- Second independent review (2026-10-18): one blocking finding, fixed above (the legacy
  projection overwrote phone-authored memories with the 500-character display copy), plus
  the false "saved" reply after a refusal, window-cut false refusals, orphaned body files,
  unscanned source fields, duplicate ops on replay and the offline delete.
- First independent review (2026-10-18): three blocking findings, all fixed above
  (deleted memories resurrected by the projection; the secret gate reading only 500
  characters; bodies of 601–2 000 characters truncated on the phone), plus the duplicate
  replay, the two-write local save, the compaction lock and cadence, `mem:` edits
  reaching the memory list, subset links, the per-build serialization of records.

Not verified: behavior on a physical iPhone (the Dart tests are VM tests and are
labeled so); the production Worker (not deployed from this branch); FTS5 availability
in the deployed Durable Object (the store falls back to LIKE and `status.full_text_search`
reports which); the size of a 100 000-record replica on a real device.

## 4. What remains (later PRs, in order)

1. Relevance/significance auditor as a scheduled pass with owner corrections;
   next-morning daily review with labeled fact / inference / hypothesis /
   recommendation / interpretation / unknown, produced only from real activity.
2. Problem-and-solution index and project proposals (Project Room) as Brain records
   with `solves`, `tests`, `escalated_to`, `used_by_project` links; shared room event
   types (problem discovered/updated, hypothesis created, evidence added, experiment
   requested/completed, solution proposed/tested, risk identified, decision made,
   approval requested, project created/blocked, lesson learned, contradiction
   detected, daily audit completed) as records in the Brain, consumed by Project Room,
   War Room, Trading Room and REA; REA results as `result_of_experiment`.
3. Offline skills manifest (`lib/plugins` registry) with "needs connectivity" marks;
   local model readiness test (FoundationModels availability on this device; SmolLM2
   stays unimplemented until a native runtime exists, and is not claimed).
4. Orb universe folders: dark teal, expand/collapse by region and folder,
   virtualized and paginated from `list()`/`folders()`; relationship colors by type.
5. Brain Status dashboard page from `/api/brain/status` and `replica.status()`.
6. Agent learning sync (Office agent `memory_refs` as `produced_by_agent` links).
7. Tests A–T on the acceptance list, with the iPhone ones run on a device and
   reported as such; final factual report.

Rules kept throughout: no second router, memory store or orchestration framework;
no model call to "keep the Brain active"; no claim that saving memories changes any
model's weights; queued work is never reported as done; a delete or privacy change
wins over any sync.
