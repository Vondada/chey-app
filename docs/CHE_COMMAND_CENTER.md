# CHE Command Center

**Where:** CHE → **Chat** → **Commands** (top bar, next to Conversations). Or say "open commands". The Back button returns to the same chat.

The page has three tabs:
- **Library:** all 84 commands (the owner's 71, ten REA commands, the Brain review, the trading connections view and the Knowledge Atlas). Search by name ("/trade-chart") or by goal ("find website clients"). Eight category filters, favorites, recently used. Each command has a details page with:
  - what it can actually do and its live status (Ready, Needs setup, Not supported yet, Unavailable right now);
  - its requirements, with setup steps for anything missing;
  - whether it needs your approval, and its input;
  - voice examples, the evidence it must return, and its cost;
  - the existing CHE handler it runs on.
- **Workflows:** saved workflows (Run, Edit, Delete with a confirmation), ready-made templates, and **Build a workflow**.
- **Activity:** every workflow run with each step's real state: waiting, running, needs your approval, failed, blocked or completed. It has Approve, Retry, Pause, Resume and Cancel controls, and lists your recent commands with their real outcome and the handler that produced it.

Opening the page, changing tabs, searching and loading never make CHE speak. **Read this** buttons and your own actions do. An action reports its real result with a visible banner, a haptic and CHE's voice.

## By voice

Everything on the page also works by voice. The page has its own **Speak to CHE** mic button, or use hands-free. While the page is open, Chat's voice pipeline offers it your words first; this is the same hook CHE's browser uses (`lib/commands/che_command_voice.dart`, deterministic, no model call). Anything else goes to Chat as usual.

| Say | Does |
|---|---|
| "What's on screen?" / "read my options" | Reads the page as a numbered list |
| "Search for website clients" / "which command prices a website" | Searches and reads the top 5, numbered |
| "Number two" | Opens that one's details and reads them |
| "Open trade chart" | Opens a command's details and reads them |
| "Run trade chart NQ" / "run it" | Back to Chat, where CHE runs it and says the real result |
| "Favorite it" / "remove trade chart from favorites" | Adds it to or removes it from your favorites |
| "Show workflows" / "show activity" / "back to chat" | Switches tab, or goes back |
| "Build a workflow called website clients with lead scout for barbers in Phoenix, lead audit and pricing" | Saves it, then reads back the steps and anything still missing |
| "Add lead proposal to my website clients workflow" / "remove step 3 from website clients workflow" | Edits the saved workflow |
| "Run my website clients workflow" | Starts it on the mission queue |
| "Approve" / "approve step 2" / "retry it" / "pause" / "resume" | Controls the current run |
| "Cancel the run" / "delete website clients workflow" | Asks first; only a plain "yes" next goes ahead |

A command that needs setup, or is missing its input, says what is missing and runs nothing. An approval command asks for a spoken yes in Chat.

## REA investigations

**Where:** Commands → **Activity** → **Open investigations**, the **Open REA investigations** button on any REA command's details, or say "open investigations". The list shows each investigation's target, kind, state and current stage. One investigation shows, in order: target, all 13 stages with their state, sources, the screenshots the browser run actually captured (or "No screenshots were captured"), the feature map with CHE's has/partial/missing status and its evidence, architecture findings (Observed, Inferred, Unknown), the comparison counts, proposals, plan, build, verification and limitations. Data is read only from `GET /api/rea/investigations[/<id>]` and `GET /api/rea/files/<id>/<file>` with the paired-device headers (`lib/commands/che_rea_models.dart`, `che_command_client.dart`).

Buttons send chat commands through the same chat turn as **Run** (`_runCommandInChat` in `lib/main.dart`, wrapped by `_sendCommandInChat` so the page can show CHE's reply large): **Map features** `/rea-features <id>`, **Compare with CHE** `/rea-compare <id>`, **Plan selected** `/rea-rebuild <id> f1 f3` (features chosen with the checkboxes), **Build** `/rea-build <id>` and **Verify** `/rea-verify <id>`. Build first asks "Build these N features into CHE as a draft pull request? Nothing merges or deploys without your separate yes." and sends nothing on Cancel. Opening or refreshing never speaks; **Read this** reads a short summary.

By voice on those pages (`lib/commands/che_rea_voice.dart`): "read this", "number two", "read the features", "feature 2", "select features 1 and 3", "plan selected" / "plan features 1 and 3", "map features", "compare with CHE", "build it" (then a plain "yes" or "no"), "verify", "refresh", "go back".

## How it works (no second assistant)

| Piece | Where | Reuses |
|---|---|---|
| Catalog of 84 commands (71 + 10 REA + Brain review + trading connections + Knowledge Atlas) | `server/cloudflare/command_catalog.js` | One entry per command. It names the existing handler and chat route it uses, its mode (EXPLORE, PLAN or BUILD), approval, input, connectors, evidence and cost. |
| Live status | `connectorStatus()` | Real Worker secrets, the YouTube OAuth state, the NinjaTrader token and `runtimeCapabilityRegistry`. |
| Running a command | `/name input` in chat | The request goes through the ordinary `/api/chat` route, so every money, delete and app gate, every truth guard and every receipt applies. A command name cannot bypass a permission. |
| Approval | `confirm` in the catalog | Only `/trade-execute` (real money) and `/yt-publish` (your YouTube channel). Owner rule of September 28: everything else you ask for explicitly just runs, and money and delete gates still ask separately. Held with the same "plain yes on the next turn" hold the money gate uses, or confirmed on the page. In a workflow, an approval step can be approved only once the steps before it are done, so you decide with their results. |
| Workflows | `command` nodes in `objective_graph.js` | CHE's existing mission graph and job queue: dependencies, parallel lanes, recovery ladder, checkpoints. Each step runs as your own command through `/api/chat`. Earlier steps' results are passed to the next step as data. A recovery attempt carries the ladder's new approach as context; the routed request stays the catalog's. |
| Suggestions | `suggestCommands()` | Deterministic word rules, never a model call. At most two cards, appended after the reply as a `command_suggestions` event (older apps ignore it). Tapping a card opens details; nothing runs from a suggestion. |
| Phone | `lib/commands/` | Favorites, recents, dismissed suggestions and the last catalog are kept on the phone. Saved workflows are kept on CHE, so "run my website clients workflow" works by voice. |

Four commands had no chat route, so each got a thin wrapper over an existing function:
- `/voice-test`: one real ElevenLabs call (`voiceProbe`);
- `/yt-analytics`: `youtubeStatus` plus the uploads CHE made;
- `/lead-crm`: `pipelineSummary`;
- `/yt-publish`: one Office video pass (`runOfficeVideoPass`).

## Readiness

The deploy check (`che-worker-deploy.yml` → "Check CHE's Command Center through the live Worker") prints a **Command Center** notice: how many commands are ready on the owner's CHE right now, and what each of the others needs. It reports connector states only, never a secret value.

What each command needs:

| Needs | Commands |
|---|---|
| Nothing beyond CHE | che, che-plan, learn, che-research, che-verify, che-memory, che-brain-review, che-recover, che-status, yt-ideas, yt-research, yt-script, yt-seo, yt-batch, yt-grow, trade-open, trade-chart, trade-setup, trade-liquidity, trade-backtest, trade-journal, trade-alert, trade-risk (account limits need NinjaTrader), trade-connections (reads each connection's own state; it never connects, removes keys or goes live), site-build, site-redesign, site-audit, site-publish, app-build, ai-build, all money commands, all client commands, all marketing commands, office-status, office-delegate, warroom, automate, skill-learn, connect, create-3d |
| GitHub secrets | che-explore, che-build, app-fix, code-review, che-release, iphone-update |
| Video renderer | yt-video, yt-voice (also a voice key) |
| Image engine | yt-thumbnail |
| ElevenLabs or Fish key | voice-test |
| YouTube sign-in | yt-analytics, yt-publish |
| NinjaTrader / Tradovate sign-in | trade-execute |

Honest limits:
- `/trade-liquidity` marks swings but does not compute VWAP or order blocks.
- `/yt-analytics` has no view or subscriber analytics yet.
- `/invoices`, `/lead-outreach` and `/lead-followup` draft only; nothing is charged or sent from them.
- `/automate` designs saved workflows; unattended schedules stay off by the owner's rule.

## Knowledge Atlas (`/learn`, issue #346)

Forty concept cards, 10 coding and 30 trading, in `server/cloudflare/knowledge_atlas.js` and `atlas_trading.js`: each has a beginner, intermediate and expert explanation, an analogy, the exact formula where one exists, a worked example and a short quiz. The phone bundles the same cards (`assets/atlas/knowledge_atlas.json`, written by `node tool/dump_knowledge_atlas.mjs`), shown in More → Knowledge Atlas, from the Brain's header, or by saying "open the knowledge atlas".

- Say "teach me recursion", "explain expectancy like I'm a beginner", "give me the expert version", "what's the formula for VWAP?", "quiz me on risk management", "quiz answers", "what's next after this?", "list the trading cards" or a number from that list. `/learn <topic or request>` is the same route.
- Answers are deterministic (`done.source = che_knowledge_atlas`, zero model calls). A coding or trading topic with no card is said plainly and nothing is invented; other subjects keep their usual route.
- Trading cards that cite statistics read CHE's paper journal and stored backtest only, labelled measured; with none it says "no recorded data yet". Card content is labelled curated. A lesson never reaches the trading desk: "teach me to trade live" changes nothing.
- Trading cards (`atlas_trading.js`) also state their limitations; the ICT/SMC ones say their evidence is mixed or limited and claim no edge. Their formulas are the calculators in `atlas_math.js` (contract risk and size from one CME spec table, R:R, shares, options at expiry, VWAP with σ bands anchored at 9:30 New York, opening range, session levels, Wilson interval, expectancy with a t-interval, drawdown, sample size, seeded Monte Carlo, risk of ruin), and every worked example is labelled an educational example.
- Calculations from chat show their steps: "what is my risk on 2 MNQ contracts with a 12 point stop?", "how many MNQ contracts can I trade risking $200 with a 10 point stop?", "calculate VWAP from the latest bars" (stored bars only), "what's the confidence interval on my win rate?", "what is my expectancy?", "evaluate my strategy", "is this a good trade: long MNQ at 18000, stop 17990, target 18030?". Each number from a record names its source: educational example, historical backtest, delayed forward-paper data, broker SIM or live orders, and the last two say "no records" when there are none. Verdicts are good, bad or unsupported by written criteria. Nothing here places or prepares an order; order requests keep the desk and the money gate.
- Tests: `knowledge_atlas.test.mjs` checks every card's fields and links, recomputes every formula (most against `trading_evidence.js`), runs every code example and asks the lessons through `/api/chat`; `atlas_math.test.mjs` checks each calculator against hand-worked values and brute force; `atlas_trading.test.mjs` asks the calculations through `/api/chat` with their counter-cases; `test/che_knowledge_atlas_test.dart` covers the page.

## Example workflows (templates)

- **Find and win website clients:** /lead-scout → /lead-audit → /pricing → /lead-proposal
- **Make a faceless YouTube video:** /yt-ideas → /yt-script → /yt-video → /yt-thumbnail
- **Plan, build and review an app:** /che-plan → /app-build → /code-review
- **NQ open briefing with risk check:** /trade-open → /trade-chart → /trade-risk
- **Build and publish a website:** /site-build → /site-audit → /site-publish

## Measured (2026-10-14, `server/cloudflare/command_center.test.mjs` and a local measurement script)

- **Prompts.** The catalog (63,728 B as served to the phone) never enters a model prompt; a test asserts it. A command adds only its own request, 13–307 B (median 87 B). Measured model input, the same request plain vs as a command:
  - `/budget`: +148 characters;
  - `/che-plan`: +238 characters;
  - `/marketing-plan`: +1,172 characters.
- **Model calls.** `/trade-chart`, `/che-memory`, `/che-brain-review`, `/che-status`, `/lead-crm` and unknown or unavailable commands use 0 model calls. `/che-brain-review` reads the stored next-morning review (`brain_audit.js`); a question about what the owner himself said about the review stays an owner-memory question.
- **Speed.** Suggestion matching takes 6.4 µs per message; search takes 1.1 ms per query.
- **Routes.** With GitHub, voice, Stripe and Twilio secrets set in the test, 68 of 71 commands reached the handler their catalog entry names. The other 3 (yt-analytics, yt-publish, trade-execute) need an OAuth sign-in and answered "needs setup" with nothing run.

## Tests

- **Worker** (`command_center.test.mjs`, through the real `/api/chat`, job queue and objective graph, offline):
  - identities and availability, every command's route, slash vs plain English;
  - suggestions: relevance, dismissal and the four example combinations;
  - search, saved workflows across restarts, composition and passing results between steps;
  - approval holds, money holds inside a workflow, failed integrations, recovery, retry, pause, resume and cancel;
  - persistence, no fabricated completion, the voice and YouTube checks, prompt size, the deploy probe.
- **Flutter** (`test/che_command_center_test.dart`, on the Worker's real catalog fixture):
  - library, search, categories, details, setup-required and approval runs;
  - favorites across restarts, offline cache, builder (order, run together, save, check, run) and activity controls;
  - delete confirmation, no automatic speech, VoiceOver labels at 2× text, the suggestion card, the spoken route;
  - a dropped connection reported with the controls still usable;
  - every page action by voice (search, numbered choice, open, run, favorite, tabs, build, edit, run, approve, pause, and delete and cancel that ask first);
  - the real app's Chat → Commands → Chat, with the voice hook registered only while the page is open.
- **End to end** (`test/che_command_center_e2e_test.dart` + `tool/command_center_e2e_server.mjs`): the real page over real HTTP against the real Worker code. A command handed to Chat reaches the trading handler, and a workflow built on the page completes on the job queue and shows in Activity. CI starts the server in the `flutter test` step.

Adding a command means one catalog entry. The route test then checks that it reaches the handler it names. Regenerate the phone fixture with `node tool/dump_command_catalog.mjs`.
