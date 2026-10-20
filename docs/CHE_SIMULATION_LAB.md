# CHE Simulation Lab

Owner request, 2026-10-20. Describe an idea and say "find the closest realistic solution". CHE searches the design space, simulates the strongest designs, compares them and explains what she found. It extends Concept-to-Plan (`docs/CHE_PROJECT_PLANNING.md`); every plan's types, costs, safety rules and Brain records still apply.

## Where it lives
- `server/cloudflare/sim_lab.js`: the models, the staged search, intent parsing, storage and the Brain record.
- `server/cloudflare/world_scene.js`: `simScene(run)`, the read-only projection the phone draws.
- `server/cloudflare/worker.js`:
  - the chat route `che_sim_lab` (before the planner, with no model call);
  - `GET /api/sims`, `GET /api/sims/:id`;
  - `GET /api/world/scene?scene=sim&id=`.
  - All of these are owner only.
- `lib/world/che_sim_lab.dart`: the Simulation Lab screen and its voice answers. It opens from the chat reply and opening is silent.

## What a run does
1. **Safety first.** The plan's safety check runs, and a refused idea (weapons, harm) gets no evaluation at all. When an idea is redirected, the weapon is left out and the rest is simulated.
2. **Models.** The physics model that fits the idea runs, plus the option search, which applies to every type.

   | Model | Applies to | Method |
   |---|---|---|
   | `hover_flight` v1 | person-carrying flight: suits, jetpacks, flying cars (not drones) | actuator-disk momentum theory, P = T^1.5 / sqrt(2ρA), over figure of merit and drive efficiency; mass solved to a fixed point |
   | `ev_range` v1 | road vehicles | road-load equation at 110 km/h: drag + rolling resistance, over drivetrain efficiency, plus accessories |
   | `exo_runtime` v1 | powered exoskeletons | energy balance: battery energy / (joints × power + electronics) |
   | `config_search` v1 | every plan | cheapest, balanced or premium for each item and which optional items to include, scored on first-year cost, quality and risk; a "under $X" ceiling is a constraint |

3. **Screening.** Closed-form equations are evaluated over many candidate designs. These are **mathematical predictions** and are counted as evaluations, never as simulations. When every combination fits the budget, the search is exhaustive.
4. **Refinement.** Evolutionary rounds mutate the best 40 designs with a shrinking step. The run stops when the best score stops improving (`converged`), the budget is spent (`budget`), the round limit is reached (`max_rounds`), or every combination has been tried (`exhaustive`). The run records which.
5. **Detailed stage.** For the 5 strongest designs per model, 1,000 Monte Carlo runs each sample the uncertain constants (figure of merit, air density, efficiencies, pack energy, each item's cost within its range). They give p10/p50/p90 and the probability that a design meets every constraint. These are **simulated results**.
6. **Ranking.** Each design is scored on six dimensions: feasibility 0.30, closeness to today's technology 0.20, performance 0.20, cost 0.15, reliability (constraint margin) 0.10 and simplicity 0.05. A design that needs anything beyond today's range loses a further 0.30 × its share of such parameters, so the closest *realistic* design ranks first.
7. **Elimination.** Each failed constraint is tallied with its reason. A design can fail more than one. When nothing passes, the closest miss is reported with what it still fails.
8. **Memory.** Each physics model keeps the best designs, the failure tallies and what worked (`sim_memory:<model>@<version>`). The next run starts from those designs and says how many it reused.
9. **Brain.** The run is stored as `simulation_run`, verification `proposed`. It carries the model ids and versions, seed, budget, stop reason, counts by evidence level, assumptions, open problems and method references.

## Honesty rules (tested)
- **Evidence levels:**
  - mathematical prediction (screening);
  - simulated result (Monte Carlo);
  - experimental measurement;
  - proven real-world result.
  - The lab produces only the first two. Readiness never passes "simulated" until something is built and measured.
- **Counts are real.** Every count is the number of evaluations actually executed. The reply and the screen say "screened N designs with equations (mathematical predictions, not simulations) and ran M Monte Carlo simulations".
- **Budgets.** The default is 60,000 screening evaluations per run and the cap is 1,000,000. "Run a billion simulations" is capped, and the reply says so. Workers do not advance the clock during pure computation, so the budget is counted in evaluations, not time. Locally, 60,000 evaluations take about 0.2–0.5 s.
- **Reproducible.** Runs are seeded from the request, so the same request and model version give the same result.
- **Dangerous concepts.** Analysis stays non-operational: no propellant chemistry, no weapons. Flight and powered joints carry a hazard note. Every hazardous run says "A simulated result is never proof that a real-world test is safe", and the roadmap starts unmanned, tethered and subscale.
- **Not benchmarked yet.** No model has been benchmarked against measured data, and every run lists that as unresolved. The tests check each model against its textbook equation, and the EV model against the 150–250 Wh/km band for a mid-size car at highway speed.

## Voice
- **In chat:**
  - "find the closest realistic solution" uses the latest plan, or the previous message;
  - "find the closest realistic solution for a flying suit";
  - "simulate this design";
  - "run 250,000 simulations for the sneaker idea";
  - "optimize the design";
  - "open the simulation lab".
  - The trading phrases ("pause the strategy simulation", "simulation results", "simulate a trade") keep their routes.
- **In the lab:**
  - "what's the best design";
  - "read design 2";
  - "why were designs eliminated";
  - "how many simulations ran";
  - "read the assumptions";
  - "what's still unresolved";
  - "what's next";
  - "read the findings".

## Missing capabilities
When no physics model fits (buildings, software, apparel, business…), only the option search runs. The run names the missing model, for example "a load, latency and hosting-cost model". Adding one means a new model object in `sim_lab.js` with tests; CHE's coding jobs can write it. Those jobs use a paid AI model, so CHE proposes and waits for the owner's go; nothing is installed or started automatically. New npm solvers would go through the same coding job, its review and CI, then the `[worker-deploy]` merge.

## Tests
- `server/cloudflare/sim_lab.test.mjs` (14):
  - ranking and uncertainty;
  - reproducibility and resource limits;
  - exhaustive vs. sampled search;
  - provenance and physics;
  - model choice and memory;
  - safety and intent;
  - two chat end-to-end tests;
  - fixture equality.
- `test/che_sim_lab_test.dart` (3): the model, voice answers, and the widget (silent open, sections, inspect, Read aloud).
- Regenerate the fixture after changing the models or the scene:

  ```bash
  node --input-type=module -e "import { buildPlan } from './server/cloudflare/project_plan.js'; import { runLab } from './server/cloudflare/sim_lab.js'; import { simScene } from './server/cloudflare/world_scene.js'; import { writeFileSync } from 'node:fs'; const plan = buildPlan('Design an Iron Man suit that can fly', { id: 'plan-fixture', now: '2026-10-20T00:00:00Z' }); writeFileSync('test/fixtures/sim_scene.json', JSON.stringify(simScene(runLab(plan, { id: 'sim-fixture', seed: 2026, budget: 4000, now: '2026-10-20T00:00:00Z' })), null, 1) + '\n');"
  ```

## Not yet
- Models for structures, circuits and thermal behaviour, software load, unit economics, and orbital or rocket performance (high-level only).
- Benchmarks against published measured data for each model.
- 3D or exploded renders of candidates. Today each design is drawn as parameter gauges against today's range, plus a cost-vs-result chart with p10–p90 bars.
- Runs longer than one request, for example a queued multi-hour search on a GitHub Actions runner (free minutes), with progress in the lab.
- Owner-set constraints by voice ("hover time at least 10 minutes").
