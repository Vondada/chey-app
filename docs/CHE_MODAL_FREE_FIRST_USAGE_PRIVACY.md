# CHE: Modal GPU + Free-First Compute + Usage & Privacy Control — Owner Setup

Status: design and human activation checklist ONLY. No Modal account/token has been created, no services connected, no costs authorized, no GPU jobs dispatched.

## Existing source of truth
- Reuse `server/cloudflare/cloud_computer.js` PROVIDERS, `creation_orchestrator.js` CREATION_PROVIDERS, existing Durable Object cloud_task queue, `/api/cloud-computer` routes and `lib/rooms/che_cloud_computer_room.dart`.
- Continue PR #524 without overlapping files or discarding work. Read `AGENTS.md`, `mailbox/briefs/LIVE-HANDOFF.md`, all relevant existing usage/security implementations.
- No alternate provider scheduler, vault, or job database.

## Stage 1 — Modal human setup (owner-only)
1. Visit https://modal.com and create/sign into the owner's workspace; accept service terms and complete any required verification themselves.
2. In Workspace > Usage and Billing, inspect Starter allowance, turn on spending budget/alerts, and configure the lowest provider-supported spend restriction. **Do not assume a budget is a hard block until confirmed.**
3. Create a scoped Modal token via its official token management flow. Owner enters it **only** into a secure secret-management interface. Never paste tokens into chat, GitHub issues, commits, Cloudflare logs, analytics, memory, or the app's ordinary text input.
4. Owner explicitly approves this new external provider dependency. No charged deployment or GPU job without separately verified billing/approval controls.
5. Verify official pricing and terms again at implementation time. Starter currently advertises $30/month of compute; Modal Shared Endpoints token charges are excluded. These are not unlimited free GPUs.

## Stage 2 — Provider implementation
- Add `modal_gpu` to the existing registry with clear capabilities, external provider consent, default disabled state, cost tier, health probe, account/credit data **only if API supports it**, and per-job measured usage.
- Execution is allowlisted only: e.g. `modal_blender_preview` with JSON-schema-validated arguments; no arbitrary user text as code or shell commands.
- Authenticate Worker ↔ Modal through secrets; use short-lived/signature-protected requests, per-user isolation, idempotency keys and audit receipts.
- Use the existing job queue/checkpoints; allow cancel, timeout and retry with bounded attempts. Store result artifacts in CHE's existing media store and verify by fetching and checking SHA-256 before marking COMPLETE.
- Scale to zero when idle, configure appropriate container idle timeout. Confirm network/storage/CPU charges besides GPU metering.
- Never claim a connected provider without a successful authenticated probe; disconnected/unverified is displayed honestly.

## Stage 3 — Free-first, no surprise spending
- Default spend policy: automatic provider dispatch only when billing is VERIFIED FREE and within the provider's authorized program terms, quotas and rate limits. Otherwise queue for owner approval or explain blockers.
- Preferred order: existing included Cloudflare CPU → proven free GitHub CPU for eligible repositories → already-authorized available free GPU resources → Modal Starter included compute, **only after owner account setup, approval and remaining credit visibility verified** → paid compute only after explicit per-job approval.
- Free Colab is interactive and requires user action; do not automate around restrictions, hoard runtimes, rotate accounts, or evade service quotas.
- A provider with no authoritative remaining-credit API must not be assumed free based on estimates; display estimate and require approval.
- `$0 paid authorization` default. Protect with enforcement in dispatch code, not just prompt words.
- Provider failover must not cause duplicate billing; cancel/check original job status before dispatching a replacement.

## Stage 4 — Usage Center, one evidence-backed view
Build a voice-first accessible Usage Center via existing room/navigation framework with:
- Providers connected/not connected/needs owner sign-in; purpose and scopes.
- For each connected and permissioned service: subscriptions, billing cycle, renewal amount/date where officially available, quota reset, free credits, current balance, tokens in/out, GPU seconds, CPU hours, storage and egress, jobs, estimated cost, actual invoiced cost, API provenance and last sync time.
- Distinguish OBSERVED, ESTIMATED, USER-ENTERED and UNAVAILABLE data. Never fabricate subscription discovery or token counts; per-provider APIs and account authorization vary.
- Alerts for approaching quota or spending thresholds and unknown charges. Require owner confirmation before purchase/cancellation/account changes.
- Per-job budgets and user quotas, dedicated owner-only admin view, least-privilege connector access; do not expose secrets.

## Stage 5 — Privacy / identity / personal-data footprint
Separate privacy features from GPU functionality. Never store an SSN in CHE's memory, logs, prompts, analytics, or general indexing.
- Offer opt-in privacy inventory of services/accounts the owner has connected or explicitly submitted, searchable breach notifications from reputable permitted providers, credit monitoring via an authorized provider, public data-broker/people-search discovery and links to official opt-out processes.
- **Do not promise 'everywhere my SSN exists'**: no universal searchable inventory of private organizational records exists. Prefer last four digits only if needed and a dedicated compliant provider for full-SSN checks, with owner-entered data directly at that provider.
- Provide per-item actions: MONITOR, REQUEST REMOVAL, IGNORE, MARK RESOLVED. Deletion requests go through each service's authorized procedure, with owner confirmation, receipts and follow-ups. Do not claim data was erased without confirmation.
- Location history/tracking requires separate opt-in, explicit permissions, device-supported background capabilities, retention controls, pause/delete/export, and no covert tracking. This is not equivalent to identifying all businesses holding location data.
- Keep identity and location data separated from GPU workers and AI model prompts.

## Acceptance tests
1. Without credentials: provider shows NOT CONNECTED; never runs/costs money.
2. With scoped credentials: authenticated probe confirms provider and capabilities, no fake credits.
3. With exhausted/unknown free credit: new GPU job waits for approval; does not spend.
4. Submit simple cube render; job receipt, verified saved GLB/preview, Cloud Computer status, persistence through iPhone app closure.
5. Failover never bills twice for the same idempotency key; worker error is visible.
6. Usage Center shows actual vs estimated vs unavailable, including token charge distinction.
7. Privacy Center never collects a full SSN in chat/worker; opt-outs require explicit consent.
8. VoiceOver and voice navigation are functional, with owner-initiated Read Aloud only.
9. Test, review, merge and deploy only with green CI and verified live evidence; new IPA only if native code needs it.

## Human-only blocker status
Modal account and authorization are not available to ChatGPT's current connected tools. CHE cannot start Modal GPU jobs until owner signs in, configures spend limits, and provides credentials through an approved vault/secret-management path.

## Official references
- https://modal.com/pricing
- https://modal.com/docs/cli/latest
- https://modal.com/docs/cli/latest/secret
- https://www.consumerfinance.gov/ask-cfpb/what-is-a-credit-freeze-or-security-freeze-on-my-credit-report-en-1341/
