# Failure inventory: trust, memory, mission history and tool routing

Lane `lane/rel-trust` (from `claude/che-reliability` at `0ec23ac4`), owner's reliability cleanup, written 2026-10-25 by Claude.

Sources: the owner's live test on 2026-10-25 (six failures below, as reported by the orchestrating session), the
`che-debug` replay of his exact phrases through the real `/api/chat` route, and the Worker tests. "Offline" means a
local test with in-memory storage, a fake model that always answers wrongly, and no network. Nothing here was checked
on the owner's phone or in production from this container; the deploy's live probe (`server/cloudflare/memory_probe.js`)
runs the same steps against an isolated test CHE on the next `[worker-deploy]`.

Status words: **FIXED** (a test proves it and passes now), **PARTIAL** (part fixed or a known piece missing),
**BLOCKED** (needs something outside the code), **UNVERIFIED** (code exists, not proved where it matters).

File:line references marked *base* are in `origin/claude/che-reliability` at `0ec23ac4`; the others are on this lane.

Before / after: `node .claude/skills/che-debug/scripts/replay_chat.mjs .claude/skills/che-fact-check/cases/owner-trust-memory.json`
(and `owner-trust-history.json`). On *base* the same turns gave: food only for "food, drink and color"; the model's
"I've saved that for you" for "Save the phrase Silver Falcon 27"; the model's "can't retrieve a record ID or
timestamp"; "can't find any record of previous collaboration"; "I don't have access to mission history or job
records" (both missions and projects); "Nothing is running right now" for "What is Claude currently working on?";
"I don't have a record of your recent memories". The new test file `trust_memory_routing.test.mjs` fails 12/12 on
*base* (run with stand-ins for the new exports) and passes 12/12 here.

## The owner's six failures

| # | Failure | Root cause | Fix | Test | Status |
|---|---|---|---|---|---|
| 1 | Recalled "Strawberry Sprite" but not favorite food and color when asked together | *base* `server/cloudflare/personal_recall.js:122` `const [head] = asked.split(/,\|\band\b\|\bwhere\b/i)`: only the first subject of the question was ever looked up | `personal_recall.js:147` splits the subject list into `parts` (shared "favorite" carried to bare items, a trailing "and where did you learn that" dropped), `answerPersonalFact` answers each with its date; "my favorites" reads every stated favorite (`recallAllFavorites`, :307) | `trust_memory_routing.test.mjs` "favorite food, drink and color asked together…"; replay `owner-trust-memory.json` turn 4 | FIXED (offline) |
| 2 | "No record of previous collaboration" | No deterministic route for "Have we worked together before?": *base* `worker.js:12176` went straight to the memory search / model, which never reads missions, projects or jobs | `activity_status.js:116` `workHistoryIntent` + `:171` `workHistoryReceipt` read `data.objectives` (the objective graph), `data.projects`, `data.jobs` and `data.team_tasks`, name each store with its count; routed at `worker.js:12193` before the memory search | "…last three projects… worked together before? read the stored records"; replay `owner-trust-history.json` | FIXED (offline) |
| 3 | "Silver Falcon 27" acknowledged without a real write receipt | *base* `worker.js:12258` only `remember …` reached the memory write, so "Save the phrase X" went to the model, which said "I've saved that"; *base* `hallucination_auditor.js:19` `SUBJECT` did not match "I've", so the claim passed the final audit; *base* `worker.js:4432` even a real write said only "I'll remember that, sir." | `personal_recall.js:176` `explicitMemorySave` (save/store/keep/note/record + a memory word, a colon or a named item; never passwords, shopping lists or files) → `worker.js:12297` the one authorized write `rememberOwnerStatement`, which reads the record back and quotes its full id and stored time (`worker.js:4438`); a repeat names the original record; the auditor now catches "I've saved that" / "I'll remember it" | "Silver Falcon 27: the save quotes the read-back record id and time…", "a write that cannot be read back is never acknowledged…", "the final audit removes…" | FIXED (offline) |
| 4 | Claimed it stored the phrase but could not give a record ID or timestamp | *base* `owner_recall.js:63` `ownerMemorySearchIntent` had no form for "record ID / timestamp / source for X", so the question reached the model | `owner_recall.js:70` `META_FORMS`: the named term is searched in every store and each record is spoken with "stored YYYY-MM-DD HH:MM UTC", full record id and source; "that / those facts" read the last answer's ledger | "Silver Falcon 27…" (same test, after a Durable Object restart) | FIXED (offline) |
| 5 | "No access to mission history or job records" | Same as #2 for missions/projects; "What is Claude currently working on?" went to *base* `worker.js:12562` `activityStatusIntent` ("Nothing is running") because *base* `coding_history.js:174` `AGENT_WORK` lacked "working" | #2's route; `coding_history.js:212` `agentMailboxReport` + `:248` `agentReportTurn` read Claude's live `mailbox/claude.jsonl` and the live handoff's "Current position" on `che-mailbox` (existing `mailbox.readThread` / `readLiveHandoff`), quoting message id, time and branch commit as Claude's own report; falls back to the Brain's imported correspondence. A model denial of CHE's own records is removed at the final audit (`hallucination_auditor.js:56` `RECORDS_DENIAL`) | "…Claude currently working on? quotes Claude's newest mailbox message…", "…no mailbox credentials is tool_unavailable; a GitHub failure is storage_failed…", "the final audit removes…" | FIXED (offline); live GitHub read UNVERIFIED until the deploy probe runs |
| 6 | Retrieved facts with no source metadata | *base* `personal_recall.js:239` answered value + date only; *base* `owner_recall.js:186` search lines had a day, no source | `personal_recall.js:295` `recordMetadata` (record id, store, stored minute, source, owner-confirmed) on "where did you learn/get…"; several-subject answers end with "Source: …" and carry `recall_receipts` (one per subject) on the done line; searches asked for ids/times/sources list all three | "favorite food, drink and color…" (`Source:` and 3 receipts), "Where did you get my favorite drink from?" | FIXED (offline) |

## Requirements beyond the six

| Req | What | Where | Test | Status |
|---|---|---|---|---|
| A | Acknowledge only after read-back, quoting the real id and time | `worker.js:4438` (`rememberOwnerStatement`); write failure → "could not verify the memory write", outcome `storage_failed` | "Silver Falcon 27…", "a write that cannot be read back…" | FIXED (offline) |
| B | Recent memories, exact phrases, corrections (latest wins), "no matching record" vs "storage unavailable" | `owner_recall.js:79` `RECENT_FORMS`, `:236` `speakRecentMemories` (memory records + the owner's Brain statements, id/time/source); `owner_recall.js:30-35` an unreadable Brain is marked, so a miss says "couldn't read my Brain store" (`worker.js:14317`) | "a correction wins…", "no matching record and an unreadable store…", "What are my recent memories?…" | FIXED (offline). A wholly failed Durable Object store returns the existing 503 "Nothing was saved" (tested), not "no record" |
| C | "Last three projects", "last five missions", "what is Claude working on" from existing records | `activity_status.js` (objective graph, projects, jobs, Office tasks), `coding_history.js` (che-mailbox thread + live handoff, Brain import fallback). No new store or router | as #2, #5 | FIXED (offline) |
| D | Typed outcomes the model cannot override | `memory_provenance.js:877` `RECALL_OUTCOMES` (`retrieved`, `no_match`, `stored`, `storage_failed`, `permission_denied`, `tool_unavailable`) on the done line of the save, memory search, personal recall, work history and other-AI routes; these routes return their own text with `model_calls: 0`; guests get `permission_denied` (`worker.js:5781`); model text denying CHE's records is removed by the final audit | every test above asserts `meta.outcome`; "a guest asking for mission history…" | FIXED (offline) |
| E | ≥ 8 regression tests on isolated data, owner phrases replayed | `server/cloudflare/trust_memory_routing.test.mjs` (12 tests, in-memory storage per test, never the owner's CHE); replay cases `owner-trust-memory.json`, `owner-trust-history.json` (run by `.claude/skills/tests/skills.test.mjs`) | 12/12 fail on base, pass here | FIXED |
| Probe | Live deploy probe against the isolated test CHE | `memory_probe.js`: 12 new "Trust: …" steps (write receipt, id/time/source read-back, favorites together, recent memories, no_match, missions/projects/collaboration, Claude's work); `memory_truth.test.mjs` runs the probe offline | `memory_truth.test.mjs` "deploy check: the live memory probe…" | PARTIAL: passes offline; live run happens on the next deploy (not done from this lane) |

## Known limits (honest status)

- A plain statement such as "My favorite drink is Strawberry Sprite" (no "remember") is kept as the owner's Brain
  turn, not as a memory record, and is answered from there; its reply is still the model's ("Noted, sir"), with no
  write receipt. Only explicit saves get a receipt. PARTIAL by design: changing that would save every sentence.
- "Save Silver Falcon 28 somewhere safe" (no memory word, no named item) still goes to the model; the final audit
  removes an unbacked "saved" claim, but nothing is stored. PARTIAL.
- Work history reads CHE's own stores. Claude's and Codex's commits live on GitHub and in the mailbox, not in CHE's job
  list; "what is Claude working on" quotes Claude's own mailbox report and says it is not verified by CHE.
- The guest refusal covers paired family devices; an owner device in `private` access reaches the main route's
  `permission_denied` branch (`worker.js:12193`), which no test exercises. UNVERIFIED.
- `origin/claude/che-memory-typo-recall` (`c3e30b28`, "favfavorite drink") is not in `claude/che-reliability` and was
  not taken here (outside this lane's six failures).
- Not verified on the iPhone or in production.
