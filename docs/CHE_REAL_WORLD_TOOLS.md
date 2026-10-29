# CHE real-world tools: 10 pieces that fit together

Owner goal (2026-10-28): ten tools that work together like Lego pieces, so each feature can be tuned until CHE has a
real-world experience. Each tool below plugs into a layer that already exists in the repo. None is built yet.

Rule for every tool: one shared contract (inputs, outputs, status, receipt), registered in the existing layer, with a
test that proves its result and no fake success.

| # | Tool | Plugs into (existing) | What it does | First measurable check |
|---|---|---|---|---|
| 1 | **Capability map** | `capability_registry.js` | One list of what CHE can do right now, with each piece's live status. Every other tool asks it before acting. | Each capability reports available, blocked (with reason) or missing; no capability is claimed without a status. |
| 2 | **Tool router** | `command_catalog.js`, `plugin_runtime.js` | Picks the tool for a request from the capability map, never a second router. | Routes asserted in `command_center.test.mjs`. |
| 3 | **Evidence reader** | `reliability_registry.js`, trading and memory stores | Reads the real record (job, trade, device status, error) before CHE answers. | Answer cites the record it read; no record means "I don't have it". |
| 4 | **Permission gate** | `plugin_runtime.js`, owner rules in AGENTS.md | Enforces permission in code: app opened only after explicit yes; money and deletes always asked first. | Refusal tests with zero side effects. |
| 5 | **Action runner with receipts** | `agent_runtime.js`, `coding_runtime.js` | Runs an authorized action and writes a receipt (what ran, result, time). Reports the actual outcome aloud. | Failed action reports failure, never success. |
| 6 | **Recovery planner** | `reliability_registry.js` | After a failure, tries the next safe step (retry, alternate provider, smaller job) and stops after a limit. | Each recovery step logged; stops at the limit. |
| 7 | **Verifier** | `rag_eval.test.mjs`, `knowledge_eval.test.mjs` | Checks the result actually solved the task (file exists, service answers, route flips). | A verified flag only when the check passed. |
| 8 | **Conversation state** | chat history, `activity.js` | Holds the current topic so "it", "fix it" and corrections resolve to the right problem. | Multi-turn tests for follow-up and correction. |
| 9 | **Live job feed** | `activity.js`, `agent_runtime.js` | Real active jobs and their status for "what are you working on?". Never an invented list. | Empty feed gives an honest "nothing running". |
| 10 | **Problem-solving eval** | `common_sense_eval/`, `rag_eval.test.mjs` | Scores task completion on realistic requests: intent, evidence, action, recovery, short answer. | Completion rate measured, not reply count. |

## How they fit

Request → (2) router picks the tool → (1) capability map says if it can run → (4) permission gate → (3) evidence read
→ (5) action with receipt → (6) recovery if it failed → (7) verifier → (8) keeps the topic → (9) shows the live job →
(10) scores it. Each piece can be tuned alone and tested alone.

## Next step

Build 1, 4 and 7 first. They are the base for every other piece and each has a clear test. Build 10 next so every
later change is measured. Items 2, 5 and 6 come after the capability map exists.
