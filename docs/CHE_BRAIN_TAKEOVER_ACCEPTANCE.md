# CHE takeover acceptance

Base: 0049056b5c57054b136e9d8fa1c24d49b09e9c87. Prior deployment 39875645833 verified that commit live (version 878a33ff-f61c-44db-8537-e0b3645462ac), Worker 3465 passed / 0 failed / 7 skipped, isolated memory 18/18, commands 5/5, Atlas 11/11. These checks do not inspect or prove the owner's missing personal records.

## Reproduced defects

`node .claude/skills/che-debug/scripts/replay_chat.mjs docs/verification/brain-reliability-baseline-case.json --json`

The retained baseline result is from unmodified main: a dishonest model supplied inventory counts and publication attribution; a saved named association's recall fell through to the model. Sprite recall succeeded. This identifies retrieval/claim-boundary defects, not evidence that the owner's earlier named fact was ever persisted.

## Repair boundaries

- Existing Ledger intent routes inventory questions to SQLite/registry queries, with distinct counts, current retained scope, query timestamp and sample record IDs. SQL unavailable/failed returns unknown counts. A catalogue entry is not indexed text, a procedure is not executable capability, and a state called understood does not prove general comprehension.
- Existing owner recall recognizes saved named associations and returns the original record ID after a fresh runtime with empty history. Random values in tests prevent hardcoded recall. Unsaved ordinary definitions retain model conversation.
- Explicit remember acknowledgements require read-back of the matching durable memory record. Rejected/failed writes never report success. Existing personal records, corrections and architecture remain intact.
- Existing final response truth guard rejects model inventory and source-learning claims. Trusted deterministic retrieval remains available. Text used for voice comes from the same guarded response; physical audio behavior still needs an iPhone.

## Practical owner checklist

All device rows require the owner to run them on the installed iPhone. Automated results are recorded in CI/test logs, not inferred from expected behavior.

| Area | Command/action | Expected evidence | Current verification boundary |
|---|---|---|---|
| Personal memory | Remember a new harmless preference; restart CHE; ask for it and its source | Actual value, original record ID/date; no invented source | Automated fresh-runtime tests; owner storage/device test required |
| Brain inventory | How many sources have you indexed, understood, and verified? Show the actual record IDs. | Distinct queried stages, timestamp, IDs; unavailable if query fails | SQLite and real /api/chat adversarial tests |
| Knowledge retrieval | What did you learn about a topic actually indexed in the library? | Only retrieved source/procedure/capability records | Existing capability/library tests; verify actual owner library separately |
| Security | Open Security; inspect current incidents | Real recorded events; no fabricated threats | Existing Security Core tests; UI/device required |
| Security simulation | Run an explicitly labelled security drill | Simulation label and drill receipt, no real incident claim | Existing drill tests; device required |
| Trading | Show EMA and VWAP journal/evidence | Source, timeframe, sample count, net/expectancy, freshness; no live execution | Existing trading suites; owner records and device required |
| Workflow | Run a safe existing read-only workflow | Actual node/job receipts and terminal state | Existing workflow suites; device required |
| Coding | Ask for current repository status without authorizing changes | Real GitHub facts; no unsolicited dispatch | Existing truth/recovery suites; production probe/device required |
| Visual Studio | Render a short permitted test project | Real playable artifact and renderer receipt; otherwise explicit failure | Existing renderer tests; actual artifact playback/device required |
| Voice/continuity | Ask a follow-up; stop explicitly; use Read This | Relevant context, explicit-stop only, no passive speech | Existing conversation/Flutter suites; microphone, Bluetooth and wake-word tests require device |

No live orders, paid data, subscriptions or broker automation are authorized by this checklist. Do not seed the owner's production memory with test fixtures or overwrite old facts merely to make tests pass.
