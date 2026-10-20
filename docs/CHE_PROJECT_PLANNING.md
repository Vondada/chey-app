# CHE Concept-to-Plan

The owner's request (2026-10-20): turn any idea into a structured, visual, costed plan. The idea can be a product, clothing, a vehicle, a rocket, an app, a game, a business or a creative project. This is one universal layer. It is not a second router or planner.

## How it works

- **Worker:** `server/cloudflare/project_plan.js`. It's deterministic and makes no model call.
  1. **Classifier** (`classifyProject`). It sorts the idea into one of 12 types, and each type has its planning structure:

     | Type | Planning structure |
     |---|---|
     | aerospace | bill of materials |
     | wearable robotics | bill of materials |
     | footwear | bill of materials |
     | apparel | bill of materials |
     | vehicle | bill of materials |
     | building | bill of materials |
     | electronics/robotics | bill of materials |
     | physical product | bill of materials |
     | game | asset list |
     | software (app, website) | feature list |
     | business/service | resource plan |
     | general project | work breakdown |

  2. **Requirement extractor.** It reads the "with …" phrases. An asked-for optional item becomes required. An ask that no real item covers is reported as not covered.
  3. **Decomposition.** Each item has these fields:
     - system
     - purpose
     - required or optional
     - size or scope (1–5)
     - complexity (1–5)
     - needs
     - stage
     - priority
     - unit (once, per unit, monthly)
     - effort hours
     - the cheapest, balanced and premium options, each with a low–high USD range
     - provenance `estimate` and a confidence level
  4. **Dependency mapper** (`dependencyStages`). It turns the needs into stages. A cycle cannot hang it.
  5. **Estimate engine.** It totals the required items per tier, keeping one-time, per-unit and monthly costs apart. It also gives effort hours and weeks.
     - The method is stated: "CHE category template, US dollars, 2026-10 market ranges for one build; not supplier quotes".
  6. **Safety layer** (`safetyCheck`). It returns one of four levels:
     - **refuse:** weapons, armed drones or vehicles, malware, and harm.
     - **redirect:** the project is planned with the weapon left out (an Iron Man suit with missiles).
     - **high_level:** aerospace, road vehicles and medical devices. These get categories, simulation and testing only, and never propellant formulas.
     - **ok:** everything else.
     Game weapons count as fiction.
  7. **Speculative and fiction list.** For example, flight like Iron Man and arc-reactor power. These items are kept apart from real parts.
  8. **Research.** `researchSource` reads one public background page (a Wikipedia summary) for the type. If that read fails, the plan says no source was read.
  9. **Persistence.** `savePlan` stores the plan under `project_plan:<id>` and keeps 30 plans. It also writes a Brain record (`kind: project_plan`, region Projects and Proposals, verification `proposed`) with the method and the source URLs.
- **Chat.** In `worker.js` before the relationship reader:
  - `projectPlanIntent` needs a planning verb plus a planning cue (parts, cost, prototype, break down, "turn this idea into", and similar), or "design" plus a known project type.
  - Ordinary plans go to the model as before. These include "plan my week", "make a plan to launch my channel", AI assistants, funnels and workflows.
  - When the request says "this idea", CHE takes the subject from the owner's previous turn.
  - For six hours, follow-ups are answered from the latest plan. Examples: "sort parts from smallest to biggest", "what must happen first", "what's possible today", "the total cost", "the sources".
  - The route reports `source: che_project_plan` and `plan_id`.
- **Scene:** `world_scene.js` `planScene`, served by `GET /api/world/scene?scene=plan&id=`.
  - It includes group lanes, item cards, dependency edges, speculative, safety and source objects, the tiers, the stages and the questions.
  - Every object names its record and has a provenance label.
- **API:** `GET /api/plans` and `GET /api/plans/<id>` (owner only).
- **Phone:** `lib/world/che_plan_room.dart`. It opens when the reply carries a `plan_id`.
  - **Map:** group lanes down and stages across. Box height shows the size class, and lines show what each item needs. Tap an item to see its details.
  - **Tiers:** a switch with the totals and the weeks for each.
  - **List:** a numbered list sorted in six ways.
  - **Other sections:** stages, not real today, safety, feasibility, next steps, open questions, assumptions and sources.
  - **Voice:** every item can be read aloud. While the room is open, these work: "sort by cheapest", "show the luxury version", "what comes first", "what's the total".
  - **Quiet opening:** opening the room is silent.

## Tests

- `server/cloudflare/project_plan.test.mjs` covers:
  - classification
  - the intent gate
  - decomposition fields and stages
  - the estimate tiers and units
  - sorting
  - safety
  - the scene
  - follow-ups and "this idea"
  - research fail-closed
  - chat end to end (Brain record, scene, API, refusal never saved)
  - persistence cap
  - a fixture-equality check
- `test/che_plan_room_test.dart` covers the model, sorting, voice and the widget.
- **Regenerating the fixture:** if the planner changes, regenerate `test/fixtures/plan_scene.json` by running `buildPlan` and `planScene` with the arguments in the fixture test.

## Simulation Lab
"Find the closest realistic solution" runs the Simulation Lab on the latest plan: a budgeted, seeded, staged search with Monte Carlo on the finalists. See `docs/CHE_SIMULATION_LAB.md`.

## Not yet

- Model-written, topic-specific items on top of the templates. For example, the parts unique to one particular invention. These would be labeled model output.
- Live supplier prices. Ranges are template estimates today.
- Rendered 3D or exploded views. The map is a 2D lane-and-stage diagram.
- Wireframes for software plans.
- Saving owner edits to a plan.
- A `/che-project-plan` entry in the Command Center catalog. The chat route works by voice and typing now.
