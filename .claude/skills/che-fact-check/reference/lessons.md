# che-fact-check: dated lessons and measurements (append, newest last)

- **Agent A/B, 2026-10-14: same task, same code, with vs without this skill, one run each.** With: 57,167 tokens, 8 tool calls, 25 s. Without: 72,958 tokens, 9 tool calls, 44 s. Both were correct. A fake search claim replaces the whole reply (guard order), so harmless lines in it are lost too; that is by design.
- **2026-10-14, measured with `tests/measure.mjs`.** Answering "what does the owner see for this draft?" by reading the guard code means reading 70,567 bytes (≈17.6k tokens) of `memory_provenance.js` and `truth_layer.js`. `claim_check.mjs` answers in 270 bytes, and its verdict matches `/api/chat` on 8 of 8 fixtures (tests).
- **2026-10-14, 12:34 and 12:56 owner screenshots.**
  - Root causes:
    - exact-phrase routing;
    - a single shared "last answer" receipt;
    - the default provenance `owner` on CHE's own notes;
    - "Treat them as your own memories" in the phone brain guide.
  - Fix (#300): records-only owner-memory answers, a per-answer ledger, an attribution guard and retraction. The live probe passed 10/10.
- **2026-10-14, found by `claim_check.mjs` while measuring this skill.** "I searched three websites and they all agree", "I googled it", "I looked it up online", "According to my research" and "I browsed five sites" all passed the tool-claim guard. It now covers search verbs with counts and "my research shows". Stories the owner asks for are exempt.
- **2026-10-14, found by `claim_check.mjs` while writing this skill.** The attribution guard dropped the rest of a reply when that rest was under 40 characters ("The weather today is mild." vanished). It now keeps any remainder with content.
- **2026-10-15, owner's live-news test ("MedMind").** CHE cited an MIT Technology Review article about a Google model "MedMind"; its link returned 404 and no source mentioned it. Reproduced with `cases/medmind-news.json`.
  - Root causes:
    - the final boundary checked only claimed actions ("I searched"), never the links, headlines, outlets or dates in a reply;
    - news research was Wikipedia and DuckDuckGo instant answers, so no article was ever opened;
    - nothing recorded a broken citation, so a cached answer or a later reply could repeat it.
  - Fix: `source_verification.js` (news research that opens each article, `guardCitations` at the final boundary, disproven claims, an owner re-check route `che_source_check`) and new guard phrasings ("I opened the article", "after browsing several news sites", "I read through your code").
  - Gotcha: `sanitizeOwnerText` (che_errors.js) turns any reply over 120 characters that says "HTTP 404" into a generic failure. Owner-facing reasons say "a page that does not exist (404)" instead.
- **2026-10-15, found by `claim_check.mjs` before the fix.** "I opened the MIT Technology Review article…", "I read through your code…", "After browsing several news sites…" and "I clicked the link you sent…" all passed the tool-claim guard. They are blocked now; "I haven't opened the article yet" still passes.

- **2026-10-19, Flagstaff history import.** The Brain's conversation backfill had filed every Flagstaff exchange CHE remembered (`brainmem` kind `flagstaff`: an outside AI's message and her reply) as an `owner_attested` record in Conversations and Corrections, the folder the phone lists as the owner's own talks. Another AI's words were labelled the owner's.
  - Fix: outside correspondence has its own label (`external_correspondence`), kind and folder; the backfill uses it and old records are relabelled. Mailbox messages come in with file, message id, sender and time, and "what did ChatGPT tell you about X" quotes them with that source. "What did I tell you" reads only the owner's records. Case: `cases/outside-correspondence.json`.
- **2026-10-19, review of #354.** A quoted mailbox message ("Do you want me to email the owner's accountant the trading journal? Say yes and I will.") inside CHE's answer set up a pending meaning, so the owner's plain "yes" ran it (Gmail route). The phone sends only role and words, so the reader cannot know a reply's route.
  - Fix: a "yes" releases only CHE's own confirmation question as her whole reply (`speech_intent.pendingMeaning`); quotes are reported speech, with "say yes" offers left out (`brain_office.reportedQuote`).
  - Also: password-shaped text with no key word ("credentials vondada:…", "… gets you in") passed every gate. `research_memory.hasSecretShape` now catches credential shapes for every Brain writer.

## 2026-10-21 — three answers CHE got wrong in front of the owner

- **Last coding work (Test 4).** CHE said she had no repository record. Her coding job records held the merge and deploy with their commit SHAs. Cause: no route matched the wording, so the model answered from nothing. Fix: the owner's last-work and proof questions are answered from job records (`completedWorkProof`, `proofAsked`); with no record she says she cannot verify it. Another agent's work is never hers.
- **Ad visuals (Test 5).** CHE gave ad copy and then described three generated visuals and scheduled posts. None existed; no image or video was rendered in the request. Fix: `asset_truth.js` cuts sentences that claim a visual or a publish the request did not make, and an ad request ends with the three facts: copy written, visuals made (with the real count), nothing scheduled or published.
- **Knowledge library empty (owner test).** "No books or references" in production: the 77-reference catalogue was only seeded by a manual action nobody had run. Fix: `openKnowledgeLibrary` seeds it once on first open.

## 2026-10-24 — invented memory IDs "retrieved from storage"

- **Memory IDs 8829, 8830, 8831.** Asked about his memories of a favorite color, CHE said she had retrieved those record IDs from storage. No store read ran. Cause: "what memories do you have about …" and "pull my memory records about …" matched no memory route, so the model answered; the retrieval guard removed only the "I retrieved" sentence and let "Record 8829 says …" through. Fix: those phrasings and "show me the memory IDs you retrieved" go to `owner_recall.ownerSearchTurn`, which reads the stores and names only real ids (`done.read_receipt`); `truth_layer.js` rule `memory_id` removes numbered memory records, and every other sentence that repeats a removed number. Replay: `cases/memory-retrieval-fabrication.json`.
- **"My latest confirmed favorite color is red."** After an older "blue", this went to the model and nothing was stored. `ownerFactCorrection` now reads a qualified statement ("latest", "current", "confirmed") as a correction, alone or after sentences that only talk about corrections or memory. Two active records of one fact resolve by stored date, and the answer names the value it replaced.
