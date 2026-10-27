# CHE Manifestation Engine

Owner mission, 2026-10-27. You describe a goal: an invention, a build, a business or income, a job or a personal goal. CHE turns it into:

- a structured spec;
- several candidate solutions, each with a feasibility class;
- runs of real domain models with ranges;
- a comparison under equal conditions;
- a Realization Plan;
- a tracked project.

A step counts as done only with evidence. After you report what really happened, CHE compares it with the simulation, names the assumptions that were wrong and updates the estimate.

It extends the existing Simulation Lab (`sim_lab.js`) and Concept-to-Plan (`project_plan.js`). It is not a second planner, router or agent.

## Where it lives

| Piece | File | Reuses |
|---|---|---|
| Units and dimensional checks | `server/cloudflare/manifest_units.js` | none |
| Seeded sampling, summaries, solvers | `server/cloudflare/manifest_stats.js` | `sim_lab.js` `rngFrom`, `seedOf` (the same seeded generator) |
| Physical model: multirotor hover | `server/cloudflare/manifest_drone.js` | the same momentum theory as `sim_lab.js` `hover_flight`; a test checks that both models agree |
| Business model: unit economics and cash flow | `server/cloudflare/manifest_business.js` | the "unit-economics model" that `sim_lab.js` lists under `MISSING.business` |
| Employment model: job-search funnel | `server/cloudflare/manifest_jobsearch.js` | none |
| Engine: spec, candidates, runs, comparison, plan, status machine, evidence, outcomes, storage | `server/cloudflare/manifest_engine.js` | `project_plan.js` `classifyProject` and `safetyCheck` (a refused goal creates nothing); `sim_lab.js` evidence levels |
| HTTP routes, chat route, Simulation Room scene | `server/cloudflare/manifest_api.js` | `office_company.js` `LA_AGENCIA_ROLES`, to name the suggested department's agent |
| Command Center entry | `command_catalog.js` → `/manifest`, route `che_manifest` | the one catalog |
| Worker wiring | `worker.js`: one call before `/api/sims`, one chat call before the Simulation Lab's chat route | worker.js got smaller: `pcm16ToWav` moved unchanged to `audio_wav.js` |

No model call happens anywhere in the engine. A language model may draft wording later, but every number comes from a model in this list.

## Audit (2026-10-27): what existed and what was reused

- **Simulation Lab** (`sim_lab.js`, `docs/CHE_SIMULATION_LAB.md`). Models: `hover_flight` (person-carrying, momentum theory), `ev_range`, `exo_runtime` and `config_search`. It has a staged screening/refinement/Monte Carlo search, the evidence ladder (prediction, simulated, measured, proven), seeded runs, a memory per model and a Brain record. Reused: the seeded generator, the evidence levels and the momentum-theory equation (cross-checked). It is not replaced. The lab still answers "find the closest realistic solution"; the engine answers "manifest …".
- **Concept-to-Plan** (`project_plan.js`). Reused: the project classifier and the safety layer.
- **Invention Studio** (`invention_studio.js`). This is a parts and sourcing breakdown with no physics. It was not touched.
- **Objective graph and workflows** (`objective_graph.js`, `workflow_engine.js`). Nodes are `chat`, `self_development` or `command` jobs. A Realization Plan's steps are mostly physical work by the owner, so they are not graph nodes. Putting them in the graph would queue jobs that cannot do the work. Plan steps record `who` (owner or che) and a suggested Office department, with `task_id: null`. Nothing is queued and no agent dialogue is written.
- **Office**: `agent_runtime.js` (`queueAgentTask`, `WORLD_ROOMS = office, studio, gallery, music, lounge, theater`; there is no simulation room) and the roster in `office_company.js`: Atlas engineering, Mira research, Sage intelligence and strategy, Knox security, Lyra creative, Nova operations, Iris experience, Orion markets, Vale QA. The scene names the department's agent as a suggestion only.
- **Evidence and provenance** (`truth_layer.js` `recordReceipt`, `memory_provenance.js`, `research_memory.js`, `knowledge_cache.js`, `mission_artifact.js` for SHA-256 artifacts). The engine keeps its own evidence records on the project, with the same rule as `mission_artifact.js`: an artifact counts only when its SHA-256 matches. Writing a receipt or Brain record for each accepted piece of evidence is listed under Future.
- **The world**:
  - `world_scene.js` `simScene` draws a Simulation Lab run.
  - `lib/world/che_sim_lab.dart` is a separate screen.
  - The `CheSceneMode` enum in `lib/widgets/che_native_scene_world.dart` has office, brain, warRoom, theater, artStudio, musicStudio, workshop, projects, markets, pipeline, store and creator, with no simulation room.
  - The walkable crew room is `assets/characters/app/index.html`. Branch `big-j-slice` (PR #678) adds named workstations, `workstationTap` and `CHE.getPose`/`setPose` to it.
- **Open work checked for conflicts**: PRs #662, #666, #672, #674, #675, #676 and #677, and branches `big-j-slice`, `unified-world-plan` and `feature/che-world-dual-mode-prototype`.
  - None of them touches the sim files or the catalog.
  - `big-j-slice` moves `selectReadyJobs` into `job_select.js`, and #677 edits the Tradovate callback. This branch touches neither.

### Where the Simulation Room should live

The Simulation Room should be a room of the walkable crew world (`assets/characters/app/index.html`), next to the Office, using the workstation mechanism from `big-j-slice`. It should not be a new Flutter screen.

`GET /api/manifest/projects/:id/scene` already returns `room: { id: 'simulation', host: 'crew_world' }` and a possibility field. Each candidate is an object with:
- `field.x`: the median result, scaled across the candidates;
- `field.y`: the probability of meeting every goal;
- `field.spread`: (p90 − p10) / p50;
- its class, limiting constraint and spoken text.

The scene also carries `stations` with the suggested department and its agent (`task_id: null` until a real task exists).

The next stage adds `'simulation'` to `WORLD_ROOMS` and `agentLocation`, plus a room in the crew world that draws these objects. The existing `lib/world/che_sim_lab.dart` can then open from a workstation tap.

## Statuses

`IDEA → RESEARCH → FEASIBILITY → SIMULATION → PLAN → EXECUTION → VERIFICATION → COMPLETE`, plus `BLOCKED` and `FAILED`.

- A project moves one status at a time and never skips. `transition()` is pure and refuses anything else.
- `BLOCKED` and `FAILED` need a reason. A blocked project returns only to the status it was blocked from. `FAILED` and `COMPLETE` are final.

| To | Gate |
|---|---|
| RESEARCH | The spec has a model and at least one measurable success criterion, and was not refused. A goal with no model is BLOCKED and the reason names the missing model. |
| FEASIBILITY | Candidates exist, each with its sources. |
| SIMULATION | Every candidate has a feasibility class (from a 200-sample screening run). |
| PLAN | Every compatible candidate has a full run, and the comparison exists. If every candidate is incompatible, the project is BLOCKED and lists the alternatives. |
| EXECUTION | A plan exists and the owner's authorization is recorded (`authorization.statement`). |
| VERIFICATION | At least one plan step was verified by accepted evidence. |
| COMPLETE | Every milestone step is verified. |

## Feasibility classes

| Class | Meaning |
|---|---|
| `feasible_now` | Meets every goal in at least 50% of Monte Carlo runs and breaks no practical limit (budget, small-UAS mass, workload). |
| `feasible_expensive` | Works, but costs more than the budget, needs certification, takes more hours than you have, or succeeds in only 10–50% of runs. |
| `unproven` | Theoretically plausible but unproven. It needs technology beyond today's range (the drone model solves for the energy density that would be needed) or numbers better than the ones given. |
| `unknown` | Insufficient evidence. There is no model, or too few of your own figures (business: fewer than 3 of price, costs and volumes). |
| `incompatible` | Breaks an established constraint. The constraint is named, for example conservation of energy, a figure of merit above 1, more energy than gasoline holds, or a price below the variable cost. |

Every class comes with `limiting_constraint`, `reasons`, `alternatives` (the nearest achievable, with numbers from the same model where it applies, or marked "not modelled here"), `confidence` and `basis` (which run, how many samples and which seed).

## Models

Each model has documented equations, units, assumptions, boundary conditions and references, plus tests:
- known answers;
- conservation;
- dimensional consistency (each equation recomputed with units through `manifest_units.js`; a mismatch throws);
- sensitivity.

### Multirotor hover (`multirotor_hover` v1)

```
m      = m_frame + m_battery + m_payload                 [kg]
T      = m·g                                             [N]
A      = n·π·D²/4                                        [m²]
P_id   = T^(3/2) / sqrt(2·ρ·A)       momentum theory      [W]
P_hov  = P_id / (FM·η) + P_av                            [W]
E_use  = m_battery·e·u·(1 − reserve)                     [Wh]
t      = E_use / P_hov                                   [min]
v_i    = sqrt(T / (2ρA)),  P_id = T·v_i                  [m/s]
P_max  = (2T)^(3/2) / sqrt(2ρA) / (FM·η) + P_av          (2:1 thrust-to-weight) [W]
span   = 2·1.1·D / (2·sin(π/n)) + D                      [m]
```

- **Uncertain inputs** (triangular low/nominal/high), each labelled as an assumption:
  - pack specific energy 150/200/250 Wh/kg;
  - figure of merit 0.5/0.6/0.7;
  - motor and ESC efficiency 0.75/0.85/0.9;
  - air density 1.10/1.225/1.25 kg/m³;
  - usable fraction 0.85/0.9/0.95;
  - avionics 5/10/20 W.
- **Boundary conditions**: hover out of ground effect, still air, no forward flight. A multirotor needs less power in cruise, so hover endurance is a conservative bound.
- **Tests**:
  - Known answer: 1 kg on four 10-inch rotors needs 43.58 W ideal (worked by hand in the test).
  - Four times the disk area halves the ideal power. Power scales as m^1.5.
  - With no avionics load, endurance peaks at a battery mass of 2·(frame + payload). This closed-form result is derived in the file.
  - Energy balance: E = P·t.
  - Agrees with `sim_lab.js` `hover_flight` to within the g constant (9.81 vs 9.80665).
- **Benchmark**: DJI Phantom 4 Pro: 1,388 g, 89.2 Wh, about 30 min rated (DJI's page, via a web search on 2026-10-27).
  - The model's nominal value is 30.4 min, and the rated 30 min falls inside its p10–p90 band.
  - The propeller diameter (0.239 m, 9.4-inch class) is CHE's assumption and was not confirmed from DJI's page.
- **Limiting constraint**: endurance is proportional to specific energy at a fixed design, so the energy density needed for the target solves exactly (at the endurance-optimal battery).
  - Below about 300 Wh/kg (today's packs, a CHE planning figure): buildable.
  - Up to about 12,800 Wh/kg (gasoline, ~46 MJ/kg): plausible but unproven.
  - Above that: incompatible.
- **"Flying car for 2 people, 1 hour"**:
  - Payload 200 kg. Width 2.55 m (EU road limit; US 8.5 ft). Empty mass 400 kg is a labelled CHE assumption.
  - Needs about 1,900 Wh/kg. Today's packs give about 9 minutes.
  - Class: `unproven`, limited by battery energy density.
  - Alternatives: today's best battery fraction (minutes given); twice the rotor diameter without the width limit (four times the disk area, so roughly twice the endurance; not road-legal); hybrid-electric; roadable aircraft or gyroplane; tethered hover. The last three are not modelled.
- **"Hover forever"** is `incompatible`: conservation of energy. The alternative offered is tethered ground power.
- **Cost**: a hobby-parts planning range under 25 kg only. Heavier aircraft have no cost model and say so.
- **References**:
  - Leishman, *Principles of Helicopter Aerodynamics*, ch. 2;
  - https://en.wikipedia.org/wiki/Momentum_theory;
  - https://en.wikipedia.org/wiki/Disk_loading;
  - https://en.wikipedia.org/wiki/Energy_density;
  - https://www.faa.gov/uas/recreational_flyers.

### Unit economics and cash flow (`unit_economics_cashflow` v1)

```
c = p − v                     [USD/item]     CM = c/p
Q_be = (F_fixed + F_mkt) / c  [item/month]
q_k = min(q_1·(1+g)^(k−1), Q_cap)
π_k = q_k·c − F               [USD/month]
C_k = −S + Σ π_j              [USD]          funding = −min(0, min C_k)
```

- **Uncertain inputs**: price, variable cost, fixed costs, start-up spend, first-month sales and growth. Each keeps its default's relative spread around your figure.
- **Results**: always given as ranges (p5…p95), never as one guaranteed number.
- **Tests**:
  - Known answers: $50/$20/$3,000 breaks even at 100 sales a month. Flat sales pay back in ceil(S/π) months.
  - Conservation: C_H + S = Σπ, and revenue − variable − fixed = Σπ.
  - Elasticity of break-even to price = −p/(p − v).
- **Classes**: a price at or below the variable cost is `incompatible`. With fewer than 3 of your own figures, the class is `unknown` and the missing inputs are listed.
- **References**:
  - https://en.wikipedia.org/wiki/Contribution_margin;
  - https://en.wikipedia.org/wiki/Break-even_(economics).

### Job-search funnel (`job_search_funnel` v1)

```
p = r_reply · r_interview · r_offer
E[offers] = a · S · p
P(t) = 1 − Π_{w=1}^{min(S,t)} (1 − p·F(t − w))^a,   F = CDF of a uniform integer delay [L_min, L_max]
t50, t90 = first week with P ≥ 0.5, 0.9
```

- **Rates**: the default rates are planning assumptions, not measured statistics, and every candidate says so (`confidence: low`). Say your own ("a 12% reply rate") or report them as outcomes, and CHE recalibrates.
- **Tests**:
  - With no delay, P(t) = 1 − (1 − p)^(a·t).
  - The exact formula matches a 20,000-trial Monte Carlo of individual applications.
  - The elasticity of expected offers to each rate is exactly 1.
  - The funnel stages never grow.
- **References**:
  - https://en.wikipedia.org/wiki/Conversion_funnel;
  - https://en.wikipedia.org/wiki/Geometric_distribution.

## Runs are repeatable

A run record holds:
- the model id and version;
- the equations;
- the exact inputs;
- each uncertain input's range;
- the seed and sample count;
- an input hash;
- the nominal outputs and checks;
- the dimensional check;
- the success probability;
- a summary of every output: n, mean, sd, se and p5/p10/p50/p90/p95.

`POST /api/manifest/runs/:id/replay` re-executes it and answers `identical: true` only when every output matches bit for bit. A run made by another model version is refused as not exactly replayable.

## Learning from reality

`POST …/outcome`, or a measurement accepted as evidence whose metric the model knows, starts a comparison.

- **For an output** (for example measured endurance or hover power):
  - CHE reports the error against the p50 and whether the result fell inside p10–p90.
  - For each uncertain input alone, it solves for the value that would have reproduced the result, and lists the inputs whose required value lies outside their assumed range (`wrong`).
  - It calibrates the smallest single change and re-runs with the same seed. The new run is marked `calibrated: true` and becomes the candidate's latest run.
  - When no single input can explain the result (for example, a power below what momentum theory allows), it says so and changes nothing.
- **For a measured input** (for example your real reply rate or first-month sales), the measurement replaces the assumption directly.

Outcomes are labelled `provenance: owner_report`. A simulation is never evidence.

## Evidence rules

- **Kinds**:
  - `artifact`: a reference plus a SHA-256; if `content` is sent, its hash is checked.
  - `test_run`: a reference, at least one test passed, none failed.
  - `measurement`: a metric, a number and a unit.
  - `owner_report`: what you actually saw, in a sentence.
- **Refused**:
  - `simulation`, `model_output`, `prediction`, `estimate`, `speculation` and `opinion`;
  - a repeat of an already accepted claim;
  - the wrong kind for the step;
  - CHE supplying evidence for your physical step (CHE may supply artifacts or test runs for her own steps);
  - a consequential step (money, application, account, contract, deployment, device) without your authorization for that step.
- **When evidence is accepted**: the step becomes `verified`, and the project moves forward through its gates (EXECUTION → VERIFICATION → COMPLETE) only when they are met.

## API (owner only; non-owners get 401 or 403)

All bodies are JSON. In JSON, `null` stands for an unlimited or never-reached value: no width limit, no budget, never breaks even. In storage these are kept as Infinity.

| Method and path | Body | Returns |
|---|---|---|
| `GET /api/manifest/models` | | `{ models: [{ id, version, domain, title, method, equations, assumptions, references, inputs, outputs, primary, outcome_metrics }] }` |
| `POST /api/manifest/spec` | `{ request, variables? }` | `{ spec }` (nothing saved) |
| `GET /api/manifest/projects` | | `{ projects: [{ id, title, domain, status, updated_at }] }` (newest 30) |
| `POST /api/manifest/projects` | `{ request, variables?, auto? = true, samples? = 2000 }` | 201 `{ project, spoken }`; 422 `{ refused: true, spec, detail }` |
| `GET /api/manifest/projects/:id` | | `{ project, spoken }` |
| `GET /api/manifest/projects/:id/candidates` | | `{ candidates, comparison }` |
| `GET /api/manifest/projects/:id/scene` | | `{ scene }`: the Simulation Room possibility field |
| `POST …/advance` | | Runs IDEA…SIMULATION through to PLAN, or BLOCKED with the reason |
| `POST …/simulate` | `{ candidate_id?, variables, samples?, seed?, adopt? }` | `{ run }`, a what-if; with `adopt: true` (only at SIMULATION or PLAN), the change becomes the design and every candidate is re-run under equal conditions: `{ run, comparison, project }` |
| `POST …/sweep` | `{ candidate_id?, variable, values \| from,to,steps, outputs?, samples?, seed? }` | `{ sweep: { variable, unit, seed, rows: [{ value, success_probability, <output>: { nominal, p10, p50, p90 } }] } }` |
| `POST …/sensitivity` | `{ candidate_id?, output? }` | `{ sensitivity: { output, base, rows: [{ input, low, high, output_at_low, output_at_high, swing, elasticity }] } }` (ranked) |
| `POST …/compare` | | `{ comparison: { conditions: { seed, samples, equal }, rows, best } }` |
| `POST …/plan` | `{ candidate_id? }` | `{ plan }` (status must be PLAN) |
| `POST …/status` | `{ to, reason?, authorization?: { statement } }` | `{ ok, project }` or 409 `{ ok: false, detail }` |
| `POST …/authorize` | `{ step_id, statement }` | `{ ok, authorizations }` |
| `POST …/evidence` | `{ step_id, kind, ref?, sha256?, content?, tests?: { passed, failed }, metric?, value?, unit?, note? }` | 200 `{ accepted: true, evidence, step, outcome?, status }` / 422 `{ accepted: false, reason }` |
| `POST …/outcome` | `{ metric, value, unit, candidate_id?, note? }` | `{ outcome }` |
| `GET /api/manifest/runs/:id` | | `{ run }` |
| `POST /api/manifest/runs/:id/replay` | | `{ identical, reason }` |

Example: `POST /api/manifest/projects { "request": "a drone that carries 1 kg for 25 minutes with a budget of $2,000" }`. These values are real output of the code on 2026-10-27, trimmed to a few fields. The ids and the seed differ per project, because the seed comes from the project id.

```json
{ "project": {
  "id": "mp-…", "status": "PLAN", "domain": "physical",
  "spec": { "goal": "a drone that carries 1 kg for 25 minutes with a budget of $2,000", "model": { "id": "multirotor_hover", "version": 1 },
            "variables": { "payload": 1, "target_endurance": 25 }, "owner_variables": { "payload": "owner_text", "target_endurance": "owner_text" },
            "budget": { "usd_max": 2000, "source": "owner_text" }, "success_criteria": [{ "metric": "endurance", "op": ">=", "value": 25, "unit": "min" }] },
  "candidates": [{ "id": "quad-15in", "name": "Quadcopter, 15-inch (0.38 m) propellers",
                   "variables": { "rotors": 4, "rotor_diameter": 0.381, "frame_mass": 1.55, "battery_mass": 1.6859, "payload": 1, "max_span": null, "budget": 2000 },
                   "feasibility": { "class": "feasible_now", "label": "feasible now",
                                    "limiting_constraint": { "id": "battery_specific_energy", "required_wh_per_kg": 137.9, "today_wh_per_kg": 300, "max_endurance_min_today": 54.39, "optimal_battery_kg": 5.226 },
                                    "alternatives": [{ "id": "best_today", "class": "feasible_now", "numbers": { "endurance_min": 36.26, "battery_kg": 5.226 } }],
                                    "basis": "simulation mr-… (2000 Monte Carlo samples, seed 121213251)" } }],
  "comparison": { "conditions": { "seed": 121213251, "samples": 2000, "equal": true }, "best": "quad-15in",
                  "rows": [{ "candidate_id": "quad-15in", "class": "feasible_now", "success_probability": 0.7625, "primary": { "id": "endurance", "unit": "min", "p10": 23.257, "p50": 27.5423, "p90": 32.6529 } },
                           { "candidate_id": "quad-10in", "class": "feasible_expensive", "success_probability": 0.382, "primary": { "id": "endurance", "unit": "min", "p10": 20.2356, "p50": 23.9599, "p90": 28.3979 } }] },
  "plan": { "candidate_id": "quad-15in", "steps": [{ "id": "s4", "title": "Bench-test one motor and propeller on a thrust stand", "who": "owner",
            "instructions": ["Clamp the motor to a stand on a kitchen scale, propeller pushing up, behind a guard.", "Raise throttle until thrust reads 1059 grams; read the volts and amps.", "Report: grams of thrust, volts and amps."],
            "verification": "measurement", "milestone": true, "consequential": null, "status": "todo", "expected": "About 124 W per rotor at hover thrust." }],
            "office": { "department": "engineering", "task_id": null } }
} }
```

The scene (`GET …/scene`) for the same project, trimmed:

```json
{ "scene": { "scene": "manifest", "room": { "id": "simulation", "host": "crew_world" }, "status": "PLAN",
  "ladder": [{ "status": "IDEA", "reached": true }],
  "objects": [{ "id": "candidate:quad-15in", "kind": "candidate", "class": "feasible_now", "best": true, "success_probability": 0.7625,
                "primary": { "id": "endurance", "unit": "min", "p10": 23.257, "p50": 27.5423, "p90": 32.6529 }, "cost_usd": [518, 1622],
                "field": { "x": 1, "y": 0.7625, "spread": 0.3411 }, "provenance": "simulated",
                "spoken": "Quadcopter, 15-inch (0.38 m) propellers: feasible now. endurance median 27.5 min, between 23.3 and 32.7. Met its goals in 76% of runs." }],
  "stations": [{ "id": "engineering", "agent": "Atlas", "assignment": "suggested", "task_id": null }] } }
```

## Chat and voice

- "Manifest a drone that carries 1 kg for 25 minutes", "CHE, manifest a flying car for 2 people", `/manifest <goal>` (Command Center) → creates the project and reads back the summary: the classes, the best candidate under equal conditions with its p10/median/p90, and the plan's first step.
- "Manifestation status", "open the manifestation projects" → the newest five, numbered.
- The chat reply is CHE's answer to the owner's own request, so it speaks normally. Opening or loading a project never speaks (AGENTS.md).
- Questions about the word ("what does manifestation mean") keep their ordinary route.

## Implemented, prototype, future

| | State |
|---|---|
| Spec builder, three domain models, feasibility classes, seeded Monte Carlo, dimensional checks, sweeps, sensitivity, equal-condition comparison, Realization Plan, status machine, evidence rules, outcome calibration, replay, API, chat, `/manifest` | **Implemented and tested** (offline; `manifest_*.test.mjs`, `command_center.test.mjs`) |
| Text parsing of goals | **Prototype.** It reads the common phrasings (payload, minutes, people, prices, costs, budget, timeline, rates); anything else uses labelled defaults that can be set through `variables`. |
| Candidate generation | **Prototype.** Three or four fixed strategies per domain, sized by the model (the drone battery is solved for the target), not a design-space search. The Simulation Lab's search could be pointed at these models next. |
| Cost figures | **Planning ranges**, not quotes. No supplier lookup. |
| Simulation Room in the crew world, Flutter screen | **Future.** The scene API is ready; nothing is drawn yet. |
| Office tasks for plan steps | **Future.** Only a suggested department today; queue real tasks through `queueAgentTask` once a step is something an agent can actually do. |
| Receipts and Brain records for accepted evidence and outcomes | **Future.** Use `truth_layer.recordReceipt` and a Brain `manifest_project` record. |
| More domains (structures, circuits, thermal, software load, personal habits) | **Future.** A new model file with the same contract and its tests. |
| Live verification on the owner's iPhone or the production Worker | **Not done.** Nothing here was deployed. |
