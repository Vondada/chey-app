# CHE Reliability Registry (owner, 2026-10-27)

Every time the owner, or an AI on his behalf, tested CHE: reliability, autonomy, intelligence, coding, memory,
honesty and real actions. Each test question keeps the exact question, CHE's actual reply, the grade, why, the
evidence link, related fixes and retests.

**Where:** More → Reliability Registry, the Brain Room side list, or say "open the test registry".
By voice: "What take are we on?", "How many times have I tested you?", `/che-reliability`.

## Counting rules
- **Sessions**, **questions (attempts)**, **retests**, **proposed tests**, **verified results** and **unknown
  results** are separate totals and are never added together. Retests are inside the question count; verified plus
  unknown equals the question count.
- A message copied in several places is one attempt (deduplicated by message id, then question and time). The same
  question asked on another occasion is a separate attempt linked as a retest.
- A proposed test, or a session opened with no question asked, is never a session or an attempt.
- "Unknown" means no reply or grade is recorded. An honest "I can't" is graded fail, not pass.
- While history is incomplete every count is said to be a lower bound ("at least").

## History (seed)
`server/cloudflare/reliability_registry_seed.json`, built by `tools/reliability/build_seed.py` from the che-mailbox
records (texts copied by message id, never retyped) and GitHub. Coverage, the sources that could not be read, and
the referenced tests whose records are missing are listed in the file. CHE's own Worker conversation history was
not readable when the seed was built; she adds it herself with "import my test history" (sessions that began with
a test opener in her stored conversations, imported ungraded).

## Live sessions
"Let's test CHE's reliability" (also "Test Chase", "Test J", "test her memory", "run the test again") opens a
session. Each following owner question and the reply he actually got is recorded from the owner-chat conversation
write (`brain_memory.recordConversationMemory`). "That passed / failed / partial" grades the last question; a reply
that is only the failed-answer fallback or "Working on it" is graded fail automatically; anything else waits for a
grade. "End the test" closes it; two idle hours close it too. Each live question also becomes one Brain record in
the Reliability Registry room (`room_events.js`).

## Code
- `server/cloudflare/reliability_registry.js`: intents, dedupe, retest links, totals, live sessions, import, chat and
  `GET /api/brain/reliability`, `POST /api/brain/reliability/grade`, `POST /api/brain/reliability/import` (owner only).
- `lib/brain/che_brain_reliability_screen.dart`: the page (VoiceOver labels on every row; loading is silent; Read
  Aloud and "Which test are we on?" speak).
- Tests: `server/cloudflare/reliability_registry.test.mjs`, `test/che_brain_reliability_screen_test.dart`.
