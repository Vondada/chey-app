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
