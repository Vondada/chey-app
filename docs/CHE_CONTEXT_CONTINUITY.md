# Context continuity and command workflow receipts

Conversation preparation keeps every supplied user/assistant turn in order, with its original role and text. The phone and web clients send their loaded conversation rather than a fixed last-N window. The Worker no longer drops turns at 80, creates an extractive owner summary, or replaces older messages with 180-character fragments. Chat, fallback, answer repair and saved background requests retain the same conversation. Provider-specific knowledge permission filtering still applies.

`fitToBudget` is a capacity check: when the complete provider payload exceeds its configured character limit, the provider is skipped. It does not clip system rules, source, messages or structured content. An HTTP 413 cannot trigger a truncated retry. The router keeps existing provider permissions, free/paid policy and spending limits. Chat does not retry the same model with a second shortened prompt. Generic conversation turns are not treated as duplicate evidence.

This preserves meaning at a cost: full conversations use more input tokens than the old lossy summaries, and small free engines can be skipped more often. This change does **not** claim lossless semantic token compression. Storage gzip remains the existing lossless compression mechanism; the original text must be restored before a language model reads it. Earlier details already discarded by older clients cannot be reconstructed by this patch. Cross-conversation retrieval still uses CHE's existing Brain/memory systems.

Objective results remain intact for dependency handoffs, later verification and replanning. The event/evidence index can still be bounded; the authoritative output is not cut to 600 or 4,000 characters. Provider limits decide whether its complete context fits.

## Voice and typed workflows

The existing command catalog now accepts an explicit sequence of named commands:

- `Create a workflow to che plan Willo Project then che plan Refine Willo Project` saves it and executes nothing.
- `Run a workflow to rea inspect npm:semver@7.7.2 then rea explain npm:semver@7.7.2` runs compatible REA steps on the existing objective graph.

Use `then` between 2–12 named commands. Slash spelling is optional. Unknown/ambiguous names or unavailable connectors stop the whole request before dispatch. This is a bounded compiler for named commands, not a claim that arbitrary goals can be planned automatically. Existing approval checkpoints and execution gates still apply. Repeating the same save does not duplicate it; reaching 30 workflows refuses a new save without discarding an old one. Long inputs are refused explicitly rather than silently losing their tails. Spoken command inputs keep their original case (including case-sensitive URL paths).

A repository-inspection or REA workflow must return the catalog's actual route receipt; a generic model answer cannot complete it. An npm REA dispatch carries its real job ID and queued state. A workflow waits for the validated result with a one-minute retry and a 20-minute bound, retaining the same job. A matching pending npm investigation is reused instead of dispatched again. Acceptance by GitHub is never counted as completed analysis.

Tests cover the real `/api/chat`, objective results, old details without pinning keywords, system-rule tails, provider replacement, structured inputs, complete dependency outputs, unknown steps, oversized input, a fake completion on a wrong route, and an asynchronous REA dispatch → pending → validated evidence → dependent step. Tests use offline providers/runner fixtures; they do not prove a production model execution or iPhone behavior.

## Execution and GitHub truth repair

`truth_layer.executeWithReceipt` runs the actual adapter and creates its invocation ID, request correlation, timestamp, source, outcome and verified response or sanitized error. A process-local capability distinguishes these receipt objects from client/model JSON. `recordReceipt` keeps authoritative responses in the existing lossless packed storage and puts references in the existing receipt index. Cloning or repeating a receipt in model output does not confer execution authority.

PR questions use `selfUpdateStatus`, including number/state/hash validation, and render its live result directly. Multiple requested PRs have separate receipts under one request ID. A failed check-run lookup is unknown CI, never passed CI. The live handoff reader uses the existing mailbox GitHub adapter, reads the actual branch head without creating a branch, pins file retrieval to that commit, and returns the exact Current position section with blob and commit provenance. Handoff prose is explicitly recorded context, not independent verification of its claims. Source text is not silently summarized into facts.

The general model reply boundary rejects unsupported repository identifiers, execution assertions and git/gh transcripts, including JSON-shaped fake receipts, before NDJSON deltas are emitted. Legitimate plugin HTTP results carry adapter-created receipts; when a sensitive model claim is rejected, the actual receipt can still be rendered without endorsing invented additions. See `CHE_TOOL_TRUTH_BASELINE.json` for the pre-change local pipeline observations.

Realtime voice now supplies input transcripts, which go through the same chat intake, authorization, context, output guards and TTS as typed turns. Provider-generated transcripts, audio and function calls cannot bypass that boundary. Finalized utterances queue without overwriting earlier turns, including while a typed request owns chat. The browser voice page uses the same input-only protocol and queues complete conversation history. Older phone clients use their existing HTTP/native voice fallback until updated. Actual iPhone microphone, playback, interruptions and installed Shorebird baseline still require device evidence.

Actual HTTP 413 rejects the complete payload for that provider for the current request; fallback receives the unchanged context. All-capacity failures terminate as `message_too_long` and are not queued as transient work. REA polling retains a failed/stalled job and its evidence instead of dispatching another run. `REA retry: npm:name@version` is an explicit owner-only new attempt linked to the original job; it never replaces or duplicates an active attempt. Workflow completion still requires validated evidence.

The existing deployment memory probe includes real two-PR GitHub receipt checks, pinned handoff retrieval, and a deterministic fabricated-transcript boundary check. These are additional to existing memory, command, atlas and voice deployment checks. Passing fixtures alone does not establish a production deployment or phone update.

## Trade records by name and the retrieval boundary (2026-10-20)

CHE keeps five separate trade record sets: the strategy simulation (`strategy_sim.js`, keys `strategy_sim_state` and `strategy_sim_trades:<chunk>`, 1-minute paper strategies), the forward paper journal (`trading_live.js`, `live_paper_*` plus `evr:paper:<portfolio>:<entry time>` records at 5-minute resolution), the daily evidence pass (`trading_evidence_runner.js`, `evidence_runs`, daily `evr:` records), the Trading Lab paper book (`trading_paper_book`) and the Alpaca PAPER account (read from Alpaca when asked, never a CHE ledger). Each set has its own count; the simulation's 172 trades and the journal's 81 are different strategies on different bars and are never summed.

`trading_ledgers.js` answers a question that names one of them ("the simulator's last trade", "the paper journal vs the simulation"), a record id, a storage key or the sample rule from those records, at the `che_trading_ledgers` route and through `GET /api/trading/ledgers`, with no model call. A set that cannot be read says so and gives no number. Orders, desk reads, the simulation's pause/resume/status forms and the existing forward-paper, evidence and Lab reads keep their routes. The sample rule is 30 out-of-sample trades for the simulation and 30 trades for the journal and the evidence pass; 100 is the size of one simulation storage chunk, not a rule.

`guardExecutionClaims` now also rejects model text that poses as a read of CHE's records: a retrieval it describes ("I retrieved the records from storage key …"), a storage key name, a record id shaped like `sim-2023-03-10-001`, a tool it "ran successfully" or a review result it reports, unless an adapter-created execution receipt backs the answer. A denial ("I have not reviewed the code") is kept. The sentence-level `guardRetrievalClaims` marks such sentences `[NOT VERIFIED]` in Flagstaff replies, where real key names quoted from source stay. The chat reply is guarded before it is split into stream deltas and sent to speech, so text, streaming and voice see the same boundary.

A spoken code review of CHE's own source ("review the code quality of the trading desk", "code review the router") opens the read-only repository inspection; "review this code" with pasted code is still conversation.
