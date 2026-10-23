# CHE Universal Workflow Engine

`server/cloudflare/workflow_engine.js` is the one library over everything CHE already runs. It is not a second
router, planner or agent. The existing executors stay the executors.

## Inventory: what existed, and what each became

| Existing system | Where | In the engine |
|---|---|---|
| Deterministic chat handlers (~106 `done.source` routes) | `worker.js` chat branches | 17 built-in workflows (`SYSTEM_WORKFLOWS`). Each one owns its handlers' routes, its blocks, its approval gate, its verification and its context scope. An unmapped route is still recorded as `route:<source>`. |
| Command Center (103 commands) | `command_catalog.js` | One `cmd:<id>` workflow per command |
| Saved command workflows | `data.command_workflows`, objective graph | `owner:<id>` workflows, migrated in place (not copied). Each save keeps the version it replaces, and earlier versions can be restored. |
| Multi-step / slash workflows | `workflowFromWords`, `startCommandWorkflow`, `objective_graph.js` | These still run them: approvals, recovery, retry and pause/resume. "resume my X workflow" calls `setObjectivePaused` / `retryNode`. |
| REA | `rea_runner.js`, `che_rea` route | `rea_investigation` plus the `cmd:rea-*` commands |
| Coding, trading, media, music, legal, expert, mail, Office | their modules | One built-in workflow each (see `SYSTEM_WORKFLOWS`) |
| Receipts / reliability | `executeWithReceipt`, reliability ledger | Read as the run's verification (`done.receipt`, `evidence`, `verified`) |
| Workflow tiers and context budget | `workflow_governor.js` | Unchanged. Each engine workflow names the only context it may read (`context`). |

## How a request goes through it

1. **Routing.** The chat route answers as before. After the reply, the DO `fetch` hook (`withWorkflowReceipt`) adds
   `done.workflow` (`id`, `name`, `kind`, `version`, `deterministic`). The phone shows it as quiet text and never
   speaks it.
2. **Recording.** In `waitUntil`, `recordRun` records the run against that workflow: outcome, held-for-owner, model
   calls, time and verification. It keeps at most six content words of the request. It never keeps the message, the
   reply, numbers, addresses, keys or passwords.
3. **Learning (candidate → test → promote).** A request answered by the language model, with no workflow, counts as a
   miss. Misses are grouped by signature. After three misses of one kind, a candidate is proposed, but only when one
   real command clearly covers it, the command needs no approval, and nothing already in the library does the same
   (dedupe). The candidate is parameterized: `{request}` is replaced by the owner's words. `testCandidate` validates
   it with `describeWorkflow` against live connectors. The owner promotes it ("promote candidate 1" or the page). From
   then on, matching requests run the command directly, with no model planning (`matchLearned` in the chat route).
4. **Measurement.** `efficiency()` uses only recorded runs:
   - the percent of requests served by workflows
   - average model calls on the workflow path vs the model path
   - model calls avoided
   - time on each path
   - learned runs

## Owner controls (voice, typing, or More → Workflows)

| Say | What it does |
|---|---|
| "list my workflows" | Reads the library |
| "open the workflows page" | Opens More → Workflows |
| "which workflow would you use for …" | Ranks workflows and gives the reasons |
| "workflow stats" | Reads the measured savings |
| "disable / enable the X workflow" | Turns a workflow off or on. The safety gate cannot be turned off. |
| "prefer the X workflow for …" | Ranks X first for that kind of request |
| "workflow candidates" | Lists learned candidates |
| "promote candidate N" / "dismiss candidate N" | Accepts or drops a candidate |
| "that workflow was wrong" / "that workflow worked" | Gives feedback on the last run |
| "workflow history" | Reads the audit log |
| "export my workflows" | Exports with no secrets; the page copies to the clipboard |
| "workflow status" | Says what is running or paused |
| "resume my X workflow" | Continues a paused or failed workflow |

API: `GET /api/workflows`, `GET /api/workflows/export`, and
`POST /api/workflows/{rank,disable,enable,prefer,feedback,test,promote,dismiss,restore,import}`. All are owner only.

## Safety

- Approval gates stay where they are: the money/delete gate, app permission, and command `confirm`.
- A held request is recorded as held, never as done.
- A command that needs approval is never learned.
- Import refuses key-, token- and password-shaped content, refuses unknown commands, and does not create duplicates.
- Storage lives in its own key, `che:workflow_engine`: 150 runs, 40 misses, 50 audit entries and 5 versions per
  workflow, well under the DO value limit.

## What it does not do yet

- **Model-call counts are a lower bound on the model path.** The model path's done event does not report its own
  count, so it is recorded as at least 1.
- **Built-in workflows are not re-planned.** Their handlers decide; the engine labels, measures and ranks them.
- **Learned workflows wrap one command.** Multi-step learned workflows run through `startCommandWorkflow`, but
  candidates are only proposed for a single clear command.
