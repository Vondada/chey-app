Work directly in my private GitHub repo:

Vondada/chey-app

GOAL:
Upgrade CHE’s autonomous coding system by integrating the strongest architecture and capabilities from the CURRENT active OpenCode project:

https://github.com/anomalyco/opencode

Do NOT build around the old archived opencode-ai/opencode repo.

I do NOT want CHE replaced by OpenCode and I do NOT want the CHE interface turned into an OpenCode UI.

CHE remains the product, personality, voice assistant, Office boss, mobile app, orchestration layer, memory system, and user-facing experience.

OpenCode should become an underlying coding/runtime capability that CHE can use when she needs to inspect, edit, test, review, and maintain her own repository.

IMPORTANT:
Inspect current `main` first. Do not rely on old copies of my project, old discussions, assumptions, or outdated file paths.

Also inspect the latest current OpenCode source/docs before implementing anything. Do not blindly copy code. Prefer using documented APIs/SDK/server interfaces or adapting architectural concepts where that produces a cleaner, safer, smaller integration.

==================================================
TARGET ARCHITECTURE
==================================================

I want this general architecture:

CHE iPhone Flutter app
        ↓
CHE Cloudflare Worker / control plane
        ↓
CHE autonomous-development orchestrator
        ↓
authenticated coding-runtime service
        ↓
OpenCode-compatible/runtime adapter
        ↓
isolated checkout/workspace for Vondada/chey-app
        ↓
search → inspect → edit → test → review → commit/PR
        ↓
results/progress streamed back to CHE

Do NOT attempt to run a full unrestricted filesystem/shell coding environment directly inside the Cloudflare Worker if the Worker runtime is not appropriate for it.

Keep the Worker lightweight.

The Worker should coordinate jobs, authentication, state, permissions, messages, routing, and status.

Actual repository editing/testing may run in the safest existing environment already available to CHE, GitHub Actions, an isolated runner/container, or another existing execution layer in the repository.

Reuse the existing CHE infrastructure whenever possible instead of introducing unnecessary services.

==================================================
FIRST: AUDIT CHE'S CURRENT AUTONOMOUS SYSTEM
==================================================

Before changing code, trace the entire current coding path.

Inspect at minimum anything relevant to:

- `server/cloudflare/self_development.js`
- `server/cloudflare/self_update.js`
- `server/cloudflare/worker.js`
- AI/model routing
- repository/source retrieval
- GitHub integration
- coding/reviewer agents
- Flagstaff mailbox
- background jobs
- queues
- retries
- job persistence
- deduplication
- commits/PR creation
- build triggers
- tests
- Flutter client status/progress UI
- voice notifications
- permissions/security
- token accounting

Find the REAL reasons CHE currently produces failures such as:

- “could not locate the UI source”
- “source code was not provided”
- “your edits changed nothing”
- “coding team could not produce a correct change”
- repeated failed implementation passes
- context loss between agents
- agents repeatedly doing the same work
- retry loops
- excessive token consumption
- stopping and asking the owner to solve ordinary engineering problems

Do not merely rewrite those error messages.

Fix the execution architecture producing them.

==================================================
1. ADD A REAL CODING RUNTIME ADAPTER
==================================================

Create a clean abstraction such as:

`CheCodingRuntime`

or another name consistent with the current codebase.

CHE’s orchestration layer should not be permanently tied to one coding backend.

It should expose capabilities conceptually like:

- createSession
- resumeSession
- inspectRepository
- searchRepository
- readFile
- findReferences
- editFile
- createFile
- deleteFile when permitted
- runCommand
- runTests
- runAnalyzer
- inspectDiff
- reviewDiff
- revertChanges
- summarizeSession
- forkSession
- abortSession
- getStatus
- getLogs
- commitChanges
- createPullRequest

Implement an OpenCode-backed adapter where practical.

If directly embedding OpenCode is unsuitable, integrate through its supported server/SDK/protocol architecture or reproduce the required concepts behind CHE’s adapter.

Do not make CHE depend on undocumented fragile internal APIs unless absolutely necessary.

==================================================
2. FIX SOURCE DISCOVERY PERMANENTLY
==================================================

CHE must stop giving up when the first exact source lookup fails.

Implement deterministic progressive discovery.

For a request involving an app screen/UI/code feature, CHE should automatically attempt:

Stage 1:
exact visible text search

Stage 2:
case-insensitive/fuzzy text search

Stage 3:
widget/class/function/identifier search

Stage 4:
routes/navigation references

Stage 5:
imports and exports

Stage 6:
callers/callees/references

Stage 7:
feature directories and likely neighboring files

Stage 8:
Flutter semantic clues such as:
Text
Semantics
Tooltip
AppBar
Navigation
Widget names
state classes
controllers/services

Stage 9:
git history when current source alone is insufficient

Stage 10:
broader repository inspection

Do NOT ask me where the source file is during normal coding jobs.

The agent should investigate it.

Only request owner input when the request is genuinely ambiguous after exhaustive deterministic discovery.

==================================================
3. TRUE MULTI-AGENT OFFICE EXECUTION
==================================================

CHE remains the boss.

CHE should be able to delegate coding tasks to specialized agents concurrently.

Use the current CHE Office roster/agent architecture where possible.

Support roles conceptually such as:

Discovery agent
Implementation agent
Test agent
Reviewer agent
Security reviewer
Regression reviewer

Do not create agents simply to make the UI look busy.

Each agent must perform real work.

Allow independent read-only discovery/review tasks to run in parallel.

Do NOT allow multiple agents to blindly modify the same files simultaneously.

CHE should reconcile results before committing.

Agents need shared job context so one agent does not restart from zero after another finishes.

==================================================
4. SESSION CONTINUITY
==================================================

A coding job needs durable session state.

Persist enough information to resume after:

- Worker restart
- network interruption
- provider failure
- GitHub timeout
- model fallback
- app closing
- temporary quota issue

A session should retain things such as:

job ID
owner request
repository
base SHA
branch
files inspected
files modified
commands run
test results
review results
errors
retry counts
agent activity
token/cost counters
status
final commit/PR

Do not repeatedly resend the entire repository or entire conversation to every model.

Use structured summaries and targeted file retrieval.

==================================================
5. MODEL/PROVIDER ABSTRACTION
==================================================

Study OpenCode’s provider abstraction and adapt the useful concepts.

CHE should be able to route different jobs to different configured models/providers without rewriting the coding engine.

Preserve CHE’s existing AI router where appropriate.

Do NOT break existing Gemini, Groq, OpenAI, OpenRouter, Cloudflare, or other configured providers.

Provider failure should not destroy the coding session.

A different permitted provider should be able to continue from the saved session state.

Secrets remain server-side.

Never place AI keys, GitHub secrets, Cloudflare credentials, or build secrets inside Flutter.

==================================================
6. HARD LOOP PROTECTION
==================================================

This is mandatory.

CHE previously consumed huge token volume because autonomous work could retry repeatedly.

Build stronger safeguards than a simple repeated-tool detector.

Every job should have:

- stable job fingerprint
- request deduplication
- mailbox commit/event deduplication
- operation fingerprint
- maximum implementation attempts
- maximum identical-error attempts
- maximum provider retries
- maximum tool retries
- maximum tokens per job
- maximum elapsed execution time
- maximum agent turns
- cancellation support
- dead-letter/failure state

The SAME mailbox commit must not launch the SAME autonomous agent cycle twice.

After more than 3 equivalent failures, stop repeating the same approach.

CHE should instead:

1. inspect the failure,
2. broaden diagnostics,
3. choose a different recovery strategy,
4. switch provider/tool if appropriate,
5. revert unsafe partial work when necessary,
6. eventually dead-letter the operation with a precise technical report.

Never allow infinite autonomous loops.

==================================================
7. DETECT “EDITS CHANGED NOTHING”
==================================================

Before calling an implementation pass successful, calculate the actual repository diff.

If there is no meaningful diff:

do NOT send the same prompt through the same implementation path again.

Determine WHY no change occurred.

Examples:

incorrect file
incorrect search string
already-fixed source
failed patch
branch mismatch
stale checkout
agent response without tool execution
permissions problem
merge conflict
generated file
wrong repository
wrong working directory

Then recover appropriately.

==================================================
8. REVIEW LOOP
==================================================

Separate implementation from review.

Implementation agents must not simply approve their own work.

After implementation:

inspect git diff

run relevant targeted tests

run repository-level tests where reasonable

perform independent code review

check:
bugs
regressions
security
privacy
accessibility
performance
compatibility
duplicate functionality
token usage
unnecessary dependencies

If review finds a concrete problem, send the exact finding back for correction.

Do not create an endless reviewer/implementer loop.

Use bounded retries.

==================================================
9. CHE-SPECIFIC VALIDATION
==================================================

Preserve CHE’s existing project requirements.

Where applicable run:

cd server/cloudflare && npm test

and:

flutter analyze --no-fatal-infos

Also run relevant targeted tests for modified components.

Do not claim checks passed unless they actually ran and passed.

Do not invent:

commit SHAs
test output
GitHub statuses
Cloudflare statuses
Codemagic results
review results
deployment results

==================================================
10. FLAGSTAFF MAILBOX
==================================================

CHE’s Flagstaff mailbox must become a real observable communication bus.

When another AI/agent sends CHE a message, CHE’s response/action should also be recorded so I can see both sides of the exchange.

Prevent duplicate mailbox events from launching duplicate autonomous jobs.

Use stable event IDs/fingerprints.

Persist:

incoming message
CHE acknowledgement
delegation
agent status
result
review status
final CHE response

Avoid dumping enormous hidden prompts/logs into the mailbox.

Use compact structured messages.

==================================================
11. TOKEN EFFICIENCY
==================================================

This integration must REDUCE unnecessary model usage.

High quality stays mandatory, but do not waste tokens.

Use:

targeted source retrieval
symbol/reference search
structured context
session summaries
diff-only review
cached repository maps
cached dependency maps
deterministic tools before LLM calls
parallel independent discovery
small specialized prompts
provider routing by task complexity

Never feed the entire repository to a model unless absolutely necessary.

Do not repeatedly resend unchanged information.

A deterministic search/tool operation should be preferred over asking another model something the tool can answer.

==================================================
12. PERMISSIONS AND SECURITY
==================================================

Study OpenCode’s permission model but do not mistake permission prompts for real sandbox isolation.

Autonomous coding execution must be isolated appropriately.

Implement/retain explicit policy levels such as:

ALLOW
ASK OWNER
DENY

Safe read-only operations should normally run autonomously.

Routine repo inspection should not interrupt me.

Potentially destructive or sensitive operations must obey CHE’s current owner permissions.

Protect:

production secrets
Cloudflare credentials
GitHub credentials
signing information
user data
external accounts

Never expose secrets to model prompts or logs.

Never execute arbitrary untrusted repository instructions with unrestricted host access.

==================================================
13. MOBILE / VOICE-FIRST EXPERIENCE
==================================================

CHE is blind-first and voice-first.

Do not make me operate a terminal to control this.

I should be able to say things such as:

“CHE, fix the voice bug.”

“CHE, inspect why the build failed.”

“CHE, have the coding team fix this.”

“CHE, check your own code.”

and CHE should handle the engineering workflow.

Important statuses should be readable/spoken naturally.

Do not read enormous logs aloud.

CHE should summarize:

what she found
what she changed
what tests ran
whether review passed
what still remains

All new UI controls require appropriate VoiceOver/Semantics labels.

==================================================
14. KEEP CHE’S IMMERSIVE OFFICE
==================================================

Do not replace CHE’s Office, Brain, War Room, Theater, or other visual rooms with an OpenCode terminal interface.

OpenCode is infrastructure underneath CHE.

The Office should visualize REAL coding activity.

For example:

agent inspecting repo
agent implementing
tests running
review underway
job blocked
job completed

These states must correspond to actual backend jobs.

No fake activity or placeholder jobs.

==================================================
15. FEATURE FLAG + ROLLBACK
==================================================

Do not perform a dangerous all-at-once replacement of the existing autonomous system.

Introduce the new runtime behind an internal feature/configuration boundary.

Allow CHE to fall back to the previous known-good path while migration is underway.

Remove obsolete paths only after equivalent functionality has been verified.

Avoid duplicate autonomous pipelines accidentally running simultaneously.

==================================================
16. TEST FAILURE RECOVERY
==================================================

If tests fail:

CHE should inspect the failure herself.

She should identify whether it is:

caused by the new patch
pre-existing
environmental
provider-related
dependency-related
CI-only
flaky

She should attempt a bounded repair when the failure belongs to her change.

She should NOT immediately ask me to debug it for her.

==================================================
17. IMPLEMENT REAL CODE
==================================================

No mock architecture.

No fake data.

No placeholder “OpenCode integration” class that does nothing.

No TODO-only implementation.

No fake agents.

No simulated command results.

If some desired feature truly cannot be implemented with the current infrastructure, implement every safe portion that can be completed and clearly identify the remaining concrete dependency.

==================================================
18. COMPATIBILITY
==================================================

Do not break:

CHE Flutter app
Cloudflare Worker
Flagstaff
CHE Office
voice
memory
existing AI router
GitHub integration
Codemagic
IPA workflow
SideStore compatibility
current account/authentication behavior

Keep dependencies minimal.

Do not balloon the mobile application with server-only coding dependencies.

==================================================
19. ACCEPTANCE TEST
==================================================

Before considering this integration complete, run an end-to-end autonomous test.

Give CHE a small real coding request.

CHE must:

receive the request
create a job
inspect the actual repository
find the relevant source herself
delegate appropriately
make a real modification
verify a meaningful diff exists
run targeted checks
run the required repository checks
obtain independent review
correct review findings if necessary
produce a final reviewed result
persist session state
report the result through CHE
record both sides in Flagstaff
avoid duplicate execution
stay within retry/token limits

Then deliberately test failure recovery:

wrong initial search term
provider failure
test failure
no-change patch
duplicate mailbox event
agent timeout

Verify CHE recovers without asking the owner to solve routine engineering problems.

==================================================
20. WORKFLOW
==================================================

Work in logical batches.

Parallelize safe independent investigation/review work.

Do not parallelize conflicting writes.

Keep commits focused and understandable.

Before modifying anything:
1. inspect current main,
2. map the current autonomous coding path,
3. inspect current OpenCode architecture,
4. identify what should be integrated versus merely adapted,
5. then implement.

Do