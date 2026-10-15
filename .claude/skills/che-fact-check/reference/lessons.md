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

