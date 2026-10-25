# CHE World population: records, generated models, active characters

Owner request (2026-10-25): populate CHE World with characters, using reproducible descriptions, shared rigs and
assets, cached variations and detail loaded as needed. "Millions per day" is an **unverified target**. This page says
what was built, what was measured and what still needs the iPhone. Raw numbers: `docs/CHE_WORLD_POPULATION_bench.json`.
Rerun: `node tools/world_bench.mjs [--quick] [--no-crowd] [--json out.json]`.

## Three different numbers

| | What it is | Where it lives | Cost |
|---|---|---|---|
| (a) **Character records** | A seed (plus the owner's optional edits) that expands into a full description: style, body type and BODY_* shape, face sliders, skin, eyes, hair, outfit, a Create Person character voice, a name and a plain-English description | Worker, `server/cloudflare/world_population.js`. A population is stored as a range `{seed_start, count}` | About 5 microseconds of CPU to expand; 0 bytes each in a range |
| (b) **Generated models** | A real rigged GLB built by Blender on the free CPU worker through the existing `person_model` job | GPU queue + media store, one per **bucket** | About 1.4 min of CPU and 1.96 MB each |
| (c) **Active characters** | Residents whose skeletons are animated on screen this second | The crowd viewer on the phone, `assets/characters/app/world_crowd.html` | Bounded by the device GPU |

The Worker never states (c): its `active` field is always `null`, and CHE says active is known only while the viewer is
open. The panel shows the three numbers separately.

## How it works

- **Records**: `expandRecord(seed)` uses a mulberry32 PRNG behind a lowbias32 hash, with no clock and no `Math.random`.
  The same seed and `SCHEMA_VERSION` always give the same record (a golden test pins seed 1). Every record passes
  `avatar_identity.validate()` and Create Person's `shapeErrors()`. It also carries a description, for example
  "a man in his 60s, chestnut hair in a bun, medium skin, light brown eyes, a cream jacket, game style". Create Person's
  `describePerson()` reads that description back to the same style, sex, hair style and hair, skin, eye and outfit
  colours with no unused words (tested on 400 records). The colours come from Create Person's own named tables and the
  voices from `CHARACTER_VOICES`, CHE's on-device Kokoro list. Voice 0 stays CHE's own.
- **Owner edits** are stored sparsely in `world:overrides:<world>` (at most 1,000 per world), re-validated and
  merged on read.
- **Buckets**: style (3) x body type (4) x hair style (8) x top (3) = **288** shared base models. A bucket's base
  preset has an average face, mid colours and BODY_WEIGHT for its build, plus OUTFIT_TOP. Every record in a bucket
  reuses that GLB with its own skin, hair and outfit colours and its own height. Only buckets are generated. One
  resident can still get its own model: `POST /api/world/record/<seed>/create` makes a Live Studio creation from its
  description, and it is built only when asked.
- **Routes** (owner device only): `GET /api/world/population?world=&offset=&limit=` (up to 200 records per page, plus
  counts and a spoken line), `POST /api/world/population {world, seed_start, count}`, `GET|POST /api/world/record/<seed>`,
  `POST /api/world/record/<seed>/create`, `GET /api/world/buckets`, and `POST /api/world/buckets/<key>/generate`. That
  last route queues the existing `person_model` job through `CreationStudio.queue` and `renderSettings`, at normal
  priority, so the owner's own creations go first. The same bucket is never queued twice.
- **Voice/typed**: the Command Center has one entry, `/world-population`. You can also say "How many characters live
  in CHE World?" or "world population". Both answer with no model call and open the panel. The panel also takes
  "read", "refresh", "open the crowd" and "close the crowd", and the Character Generator takes "open world population".
- **Crowd viewer**: the page asks the app for a bucket's GLB (`need_bucket`) only when a resident using that bucket comes
  within mid range. Each GLB is parsed once and cached. Residents are skinned clones that share geometry. The levels of
  detail:
  - Near: within 14 m, at most 24 residents, animated every frame, face meshes on.
  - Mid: within 34 m, at most 80 residents, animated every 4th frame, face meshes hidden.
  - Far: everyone else, drawn as **one** InstancedMesh low-poly figure (one draw call), coloured by outfit.

  A bucket with no generated model stays low-poly; nothing is invented. The page never speaks. Once a second it posts
  a quiet status to the app: records in view, models loaded, active animated, near/mid/far counts, fps, draw calls,
  triangles and JS heap.

## Measured (2026-10-25, cloud dev container, NOT the iPhone)

Machine: Intel Xeon @ 2.80 GHz, 4 cores, Node 22. Other agents were running at the same time: the 1-minute load average
was 11 to 19 on 4 cores, so every figure below is pessimistic.

### (a) Records

| Measure | Value |
|---|---|
| Records expanded per second, one Node thread (schema 2, median of 3 x 300,000) | **202,307** |
| Same, schema 1 (before the description field) | 209,874 |
| Projected per day, one thread | 17.5 billion |
| Projected per day, 4 cores | 69.9 billion |
| Stored bytes per record inside a range | 0 |
| Stored bytes for a whole population (any count, even 1,000,000,000) | 77 |
| Stored bytes per owner-edited record | about 46 |
| Expanded record as JSON (sent to the app on request) | about 1,317 bytes |

Millions of records per day are achievable: one CPU thread expands about 200,000 per second. That is records only. A
record is a description, not a model, and not something on screen.

### (b) Generated models

| Measure | Value |
|---|---|
| person_model GLB (run 40153146586) | 1,959,512 bytes |
| Crew GLB average (8 bundled, 2.30 to 3.00 MB) | 2,572,807 bytes |
| All 288 bucket models | about 564 MB |
| One GLB per record for a 100,000 world (what buckets avoid) | about 196 GB |
| Build time per model (measured, build only) | 1.4 min |
| Upper bound, 1 worker | 1,028 per day |
| Upper bound at the default 3 cloud workers | 3,084 per day |
| Upper bound at the setting maximum of 10 | 10,280 per day |
| Ceiling at GitHub's free 20 concurrent jobs (needs the cap raised) | 20,560 per day |
| All 288 buckets at 3 workers / 10 workers | about 2.2 h / 0.7 h |

These are upper bounds. They assume back-to-back jobs, no runner start-up (about 1 min per dispatch), no failures,
the queue's 500-waiting limit, and the repository staying on free unlimited public-repo minutes. **Millions of
generated models per day are not achievable** on the free CPU worker: about 1,000 per worker per day is the measured
ceiling. That is why records share 288 bucket models.

### (c) World viewer in headless Chromium (SwiftShader software WebGL)

SwiftShader rasterises on the CPU with no GPU. An iPhone GPU is orders of magnitude faster at this, so read these rows
for how cost grows (triangles, draw calls, heap), not for iPhone fps. Viewport 390 x 844 at 1x. The 8 crew GLBs stood
in for bucket models, since no bucket model has been generated yet; each bucket key was still parsed separately, as
on the phone. With the default camera at 26 m, every animated resident fell in the mid tier.

| Residents | LOD | fps | Animated per second | Mid / far | In view | GLBs loaded | Draw calls | Triangles | JS heap | Load time |
|---|---|---|---|---|---|---|---|---|---|---|
| 10 | on | 1.5 | 4.4 | 9 / 1 | 9 | 10 | 155 | 545,416 | 44 MB | 30 s |
| 10 | off | 1.1 | 10 | all full | 9 | 10 | 259 | 618,952 | 44 MB | 29 s |
| 50 | on | 1.0 | 6.3 | 13 / 37 | 24 | 25 | 210 | 761,838 | 98 MB | 104 s |
| 50 | off | 0.6 | 50 | all full | 25 | 46 | 658 | 1,728,266 | 106 MB | 395 s |
| 200 | on | 2.5 | 11.8 | 16 / 184 | 50 | 27 | 248 | 970,814 | 105 MB | 91 s |
| 200 | off | 0.7 | 200 | all full | 52 | 140 | 1,279 | 3,458,262 | 221 MB | 851 s |
| 1000 | on | 2.1 | 13.8 | 19 / 981 | 135 | 31 | 279 | 1,178,430 | 149 MB | 69 s |
| 1000 | off | 0.1 | 1000 | all full | 130 | 275 | 3,553 | 8,849,932 | 319 MB | 4,668 s |

What this shows:

- With LOD on, cost stays almost flat from 10 to 1,000 residents: about 1.2 M triangles, 280 draw calls and 31 GLBs at
  1,000. Only nearby buckets are fetched.
- With LOD off, cost grows with every resident: 8.8 M triangles, 3,553 draw calls and 275 GLBs (about 700 MB of
  downloads) at 1,000, and loading took 78 minutes.
- Each crew character is about 60,000 triangles across about 28 meshes. That full detail dominates even in the mid
  tier. The next gain is a decimated LOD1 mesh exported with each bucket GLB (lane A's Blender export), which would
  cut mid-tier triangles about tenfold.

## Not verified (needs the iPhone or a live run)

- Real fps, thermal behaviour and memory on the owner's iPhone, at 10, 50, 200 and 1,000 residents. The WebView, the
  bridge and the panel's `need_bucket` → `/api/world/buckets` → GLB download path have only run in tests and headless
  Chromium.
- No bucket model has been generated yet. `POST /api/world/buckets/<key>/generate` is tested against the queue in unit
  tests, not on the live CPU worker. Its per-instance recolouring depends on the generated GLB naming its materials
  skin, hair and cloth (the crew GLBs do); a person_model GLB with other names keeps its own colours.
- The models-per-day figures are arithmetic from one measured 1.4-minute run, not a day-long run.
- Only long_wavy hair has strands (HAIR_BUILT). Buckets with other hair styles build close-cropped, and the generate
  reply says so.
