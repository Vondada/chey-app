# CHE organisation audit and batch plan (owner master mission, 2026-10-23)

Audited on `main` 50d96ea, plus Lane K's Security Room branch (PR #492, which adds the `department` field and Knox as Office Security Chief).
Ratings:
- **DONE**: works and is wired in.
- **PARTIAL**: exists, but the mission asks for more.
- **MISSING**: no code.
- **BROKEN**: exists and is wrong.

Paths are relative to `server/cloudflare/` unless they start with `lib/` or `docs/`. Nothing here claims behaviour on the iPhone or in production; those claims come only from `release_status.mjs` and the owner's device.

## 1. Platform audit (Phase 1)

| System | Rating | Evidence |
|---|---|---|
| Office roster (La Agencia) | DONE (now reorganised) | `office_company.js` `LA_AGENCIA_ROLES`, `ensureLaAgenciaRoster`. There was one roster with 7 agents. Orion and Vale existed only as personas and pool names (`agent_runtime.js` `AGENT_NAMES`/`PERSONAS`, `browse_chat.js:56` `POOL_NAMES`). |
| Agent runtime | DONE | `agent_runtime.js`: `queueAgentTask` (task record), `runOneTask` (permission flags, then tool blockers, then the model), `reviewDelegatedResult` (CHE's APPROVED/NEEDS WORK review), `handoffAgentTask` (moves a task between agents and records the handoff), `recoverStaleWork`, `recordAgentWork` (per-agent work log). |
| Office goals / jobs | PARTIAL, now extended | `worker.js` `officeGoal` splits a goal into tasks and stores `data.office_goals` `{id, goal, job_ids}`. It had no accountable owner, acceptance criteria, dependencies, verification or receiving-agent acceptance. Coordinated jobs now extend this same record (`office_jobs.js`). |
| Capability registry | DONE | `capability_registry.js`: only VERIFIED/AVAILABLE entries may be claimed (#106). |
| Universal Workflow Engine | DONE | `workflow_engine.js`: one library over existing handlers (#105). |
| Objective graph (missions) | DONE | `objective_graph.js`: a durable DAG of CHE background jobs (kinds `chat`/`self_development`/`command`), with `targets` that never run together. It does not run Office agent tasks, so Office coordination extends `office_goals` instead. |
| Brain | DONE | `brain_store.js`, `brain_office.js` (one brain per Office worker; handoffs become collaboration records), `brain_ledger.js`, `brain_rooms.js`. |
| Security Core | DONE | `security_core/agent.js:9` has 8 specialists. Chain: Owner → CHE → security. Lane K adds Knox as the visible chief (`security_chief.js`, PR #492). |
| Trading research engine | DONE (futures) | `trading_research.js`, `trading_evidence.js` (walk-forward/OOS, costs), `strategy_governor.js` (statistical pauses, #484). Rithmic live candles are on-device only (`lib/trading/che_market_feed.dart`). `market_feed.js` has no live source on the Worker: it labels Yahoo data as DELAYED. |
| Crypto data | PARTIAL | `markets.js:12,104` shows BTC/ETH quotes from CoinGecko on the Markets desk. There is no 24/7 crypto bar feed, crypto paper engine or weekend schedule. |
| Stocks | PARTIAL | `broker_alpaca.js`: Alpaca paper only, with no live host in code. There is no filings, earnings or fundamentals research (no SEC EDGAR module). |
| Forex / options | MISSING | No modules. |
| Live execution | Disabled by design | `lib/trading/che_live_order.dart` has no send path. Tradovate (`broker_tradovate.js`) is OAuth only. |
| REA | DONE | `rea_runner.js`, `rea_targets.js`, `rea_features.js`: GitHub Actions investigations. |
| Coding engine | DONE | `self_development.js` (CHE's engineering team), `coding_runtime.js` (OpenCode on GitHub Actions, `CHE_GITHUB_TOKEN`), `codex_packets.js` (Office Codex desk, `CODEX_OWNER_TOKEN`), `coding_cancel.js`, `coding_history.js`. |
| Creation (Visual Studio, Film Studio, video line) | DONE | `visual_studio.js`, `film_studio.js` (#475), `video_line.js`, `youtube_upload.js` (publishing is owner-approved). |
| Command Center | DONE | `command_catalog.js` has 113 commands after this batch. |
| Tenancy / branch products | PARTIAL | `che_platform.js:18` `ensurePlatform`: tenants, device enrollment and privacy policy (`CORE-PRIVACY-1`). No per-product branding, plans or billing. |
| Revenue tools | PARTIAL | `stripe_store.js` (owner-approved products and links), `stripe_webhooks.js` (read-only totals), `opportunity_scout.js` and `fiverr_scout.js` (shortlists only; no outbound). There is no business-opportunity pipeline with costs and launch gates. |
| Business HQ dashboard | MISSING | Only the Office board (`office_board.js`) and the Trading Room exist. |

### Scheduled work that exists today

- **Cron.** `wrangler.jsonc:13` has `"crons": ["7 7 * * *"]`: one run a day. `worker.js` `scheduled()` runs `nightly()` and `modelWatch()`.
- **Durable Object alarms.** `worker.js` `alarm()` runs forward paper trading (`tradingTick`, paper only), Brain event drains, job processing, and Office work when autonomy is on.
- **Conflict.** AGENTS.md says "nothing runs on a schedule" for **AI sessions** (Claude, Codex and the rest). Phase 6 asks for a scheduler that runs while the app is closed. Lane N owns that, and must not add unbudgeted paid-model work. This lane adds no cron.

### Working tools and integrations (from code, not verified live here)

| Area | What exists |
|---|---|
| AI providers | Router with paid AI off by default (`ai_router.js`). |
| Voice | ElevenLabs with Fish as backup. |
| Payments | Stripe, read-only plus owner-approved. |
| Code | GitHub (coding runtime, REA, code index). |
| Trading | Alpaca paper; Tradovate OAuth. |
| Market data | Yahoo delayed; CoinGecko delayed. |
| Mail | Gmail and Google via Connections. |
| Messaging | Twilio SMS (CHE only, owner-confirmed bulk). |

Which of these are configured on the live Worker is shown per tool in `GET /api/office/org` as configured / not configured / not checked.

## 2. Office roster reconciliation (Phase 2)

The owner proposed nine heads. All nine names already existed: seven on the roster, and Orion and Vale as personas in the Office's own name pool. **No new agent was invented.** Each head is the existing agent with the same ID, history, persona and appearance. `role_history` records the job each one held before.

| Head | Department (`department.id`) | Title | Before → after | Why it fits |
|---|---|---|---|---|
| Nova | operations | Chief Operations Officer | Product / listings → Operations / coordination (still owns listings) | Coordination is the new core; product work stays. |
| Atlas | engineering | Chief Technology Officer | Research / scout → Engineering / Codex jobs | Owner's assignment. Atlas's persona ("thinks in base rates, risk and drawdown") suits engineering trade-offs. |
| Mira | research | Research and Education Director | Customer / support copy → Research / education (keeps support copy and translation) | Takes Atlas's research and scouting. Persona ("bold visual thinker") is a weaker match; kept as is. |
| Knox | security | Office Security Chief | Engineering / Codex jobs → Security / protection | Persona: "hunts for failure modes, security holes". Lane K's title is kept; the owner also called it Chief Security Officer. |
| Sage | intelligence | Intelligence and Strategy Director | Finance / Stripe reports → Intelligence / strategy (keeps read-only Stripe) | Persona: "checks every claim against the goal". |
| Lyra | creative | Creative Production Director | Content / social → Creative production (adds ad creatives from Iris) | Direct fit. |
| Orion | markets | Markets and Trading Research Director | Pool name for trades (`ensureJobAgent` already gave trades to Orion) → roster head | Paper only. |
| Iris | experience | Experience and Accessibility Director | Ad Studio → Experience / accessibility | Owner's assignment. Ad creatives moved to Lyra. Persona ("ad-minded creative") is kept. |
| Vale | qa | Quality Assurance Director | Pool name → roster head | Persona ("lists, owners, deadlines, dependencies") suits verification. |

**Separation of duties.** Knox held Engineering / Codex jobs before. Engineering moved to Atlas, so Knox's security review is independent of the work it reviews. Codex packets, the Roblox studio job, the `GOAL_ROUTES` engineering words, the provider preference (`openai`, `gpt-5.3-codex`) and the Codex tool blocker all moved with it. Past Knox tasks keep their history under Knox.

**Hierarchy.** Owner → CHE → department heads → specialists. The data lives in the existing roster (`LA_AGENCIA_ROLES[*].department`, read by `departmentHead()`). Specialists are:
- for Knox, the Security Core's 8 specialists;
- for the others, the provider specialties CHE already hires (`office_workforce.js`) and live non-head Office agents.

`GET /api/office/org` returns, for each head:
- identity, appearance and personality, from `agentView`;
- responsibilities, and tools (real modules), each marked configured, not configured or not checked;
- permission flags (merge, spend and payout are always false);
- the work queue and receipts (the per-agent work log);
- recent activity (recorded handoffs);
- performance, from stored tasks only, or null with no records;
- handoff and escalation rules.

**Identity everywhere.** The Office desk sheet shows `DEPARTMENT` for any head with a department field (`lib/agents/che_office_floor_screen.dart`, from Lane K). Chat answers "Who runs the Office departments?" from the same data. The Security Room's Knox card is Lane K's.

## 3. Persistent Office jobs and handoffs (Phase 3)

This extends `office_goals`; there is no new store. `office_jobs.js` is deterministic bookkeeping. Every stage is an ordinary Office task, so these all apply unchanged:
- permission flags;
- tool blockers;
- Codex packets;
- CHE's review;
- stale-work recovery;
- Brain collaboration records.

**Fields on each job:**
- ID (`oj-xxxxxxxx`), coordinator (Nova), accountable agent and supporting agents;
- acceptance criteria, priority (0–9), dependencies on other jobs, and targets (resources);
- stages, each with its agent, status, task ID and acceptance record;
- handoffs, each with every acceptance check;
- tools and permissions required, and the approvals that stay with the owner;
- cost (`measured: null`, because Office tasks do not record provider cost yet);
- evidence (stage task IDs), verification status, rollback notes and corrections;
- history, and the workflow stage (Understand → Inspect → Plan → Delegate → Act → Verify → Correct → Remember).

**Stage order.** Research, experience, engineering, security, creative, markets, intelligence, operations, then QA. Engineering always brings a Knox security review. Every job ends with Vale.

**Receiving agent acceptance.** A handoff is accepted only if all of these hold:
- the receiver is on the roster;
- it heads that department;
- earlier stages are finished;
- jobs this one depends on are finished;
- it is not verifying its own work;
- its tools and permissions are available (the Office tool blockers and action guards).

A refused handoff blocks the job and is escalated to CHE. It is offered again once the checks pass, and nothing is skipped.

**Collisions.** A job whose targets overlap an open job waits for that job. The earlier job's accountable owner stays accountable, and the collision is recorded.

**Verification.** Vale's answer must start with `VERDICT: PASS` or `VERDICT: FAIL`.
- PASS marks the job verified, with that basis.
- FAIL sends it back to the accountable stage once, with Vale's findings (the Correct step).
- A second FAIL, or no verdict, means failed or unverified. It is never reported as done.
- Vale's verdict is a review of the recorded stage results. It is not a test run unless a stage links one.

**Where it runs.** On the Durable Object alarm, before and after Office work, only while autonomy is on. No new cron, and no model calls of its own.

**Routes and commands:**

| Route | What it returns |
|---|---|
| `GET /api/office/org` | The whole organisation |
| `GET /api/office/org/:name` | One head's record |
| `GET /api/office/jobs` | Coordinated jobs |
| `GET /api/office/jobs/:id` | One job |
| `POST /api/office/jobs` | Plans a new job from `{request, acceptance_criteria?, priority?, depends_on?, targets?, accountable?}` |

Commands: `/office-org`, `/office-coordinate`, `/office-jobs`. By voice: "Who runs the Office departments?", "Have Nova coordinate …", "What is the status of the Office jobs?".

**Test E** (`office_api.test.mjs`) runs a feature request through the job API and the real runtime and CHE review. It checks:
- Iris → Atlas (Codex desk) → Knox → Vale;
- four accepted, recorded handoffs;
- four completed stage tasks;
- the job verified by Vale;
- CHE reporting it by voice.

The model in that test is a fake; production quality depends on the real engines.

## 4. Master mission map and batch plan (Phase 15 order)

| # | Owner priority | Existing module | Status after this batch | Next batch |
|---|---|---|---|---|
| 1 | Office and runtime audit | This document | DONE | Keep this file current. |
| 2 | Persistent autonomous job orchestration | `office_jobs.js` over `office_goals` and `agent_runtime.js` | DONE (Office side); Test E passes on the Worker | An Office jobs card in the Flutter Office screen; measured cost per stage. |
| 3 | Verified market data and scheduling | `market_feed.js`, `markets.js`, `trading_research.js`, DO alarm, one daily cron | PARTIAL | **Lane N**: a 24/7 crypto bar feed (exchange public APIs, labelled LIVE/DELAYED), market-hours calendar, and a budgeted scheduler (deterministic, no paid model per tick). |
| 4 | Crypto and multi-market paper trading | `trading_evidence.js` (MNQ/NQ only), `strategy_governor.js` | MISSING for crypto, forex and options | **Lane N**: crypto paper portfolios on the same evidence engine; weekend schedule (Test A). |
| 5 | Emerging-company research | None (no filings or fundamentals) | MISSING | SEC EDGAR filings (free, rate-limited), earnings calendar, sourced reports with scenarios (Test B). |
| 6 | Business opportunity workflows | `opportunity_scout.js`, `fiverr_scout.js`, Office jobs | PARTIAL | An opportunity record (problem, demand, costs, risks, MVP plan) run as a coordinated Office job; launch is owner-gated (Test D). |
| 7 | Shared branch-app infrastructure | `che_platform.js` tenancy | PARTIAL | Per-product branding, onboarding and limits on the tenant model; private data stays per tenant. |
| 8 | One sellable pilot (Lyra Studio first) | `visual_studio.js`, `film_studio.js`, `stripe_store.js` | PARTIAL | Customer-facing Lyra Studio flow, with payment links behind owner approval. |
| 9 | Business Headquarters | `office_board.js`, Trading Room | MISSING | One dashboard from real records only. |
| 10 | Expansion on evidence | `capability_registry.js`, `brain_audit.js` | ONGOING | — |

### Acceptance tests

| Test | Covered by | Status |
|---|---|---|
| A — crypto weekend operation | Lane N | MISSING |
| B — emerging stock discovery | Batch 5 | MISSING |
| C — cross-market comparison | `trading_research.js` (futures only) | PARTIAL |
| D — business creation | Batch 6 | MISSING |
| E — Office coordination | This batch | Done on the Worker (iPhone not verified) |
| F — self-improvement | Lane L, `claude/che-owner-improvements` (owner preferences, config, undo) | In progress there |
| G — safety | Agents cannot merge, spend or pay out (`office_company.js` `agentActionGuard`, `agent_permissions.test.mjs`); live order sending has no code path; Stripe stays owner-approved | DONE for the paths that exist; each new phase must keep these tests |

Phases 8–13 (live-trading readiness, branch apps, opportunity engine, HQ, learning, commercialisation) build on items 3–9. Live execution stays disabled until the owner explicitly authorises it and defines its scope.
