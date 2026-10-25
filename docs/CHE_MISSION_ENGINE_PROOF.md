# CHE persistent mission proof

The owner asked for proof of one complete persistent mission. It has to start from CHE on the iPhone, run on the server, survive the app closing, save checkpoints, recover from an interruption, finish a real task, produce a verified artifact and show the result when CHE reopens.

No second orchestrator was built. The mission runs on the systems that already existed:

- the Command Center workflow (`command_catalog.js`, `workflowFromWords`)
- the objective graph (`objective_graph.js`)
- the job queue and the stale-job sweep in `CheState.processJobs`
- the Durable Object alarm (`CheState.alarm`)

This change adds only the missing piece, a verified result, plus the way to read it back.

## Property table

| # | Property | Before this change | Added now | Still unverified |
|---|---|---|---|---|
| 1 | Starts from a CHE chat or voice command | **True.** `che_command_workflow` chat route (`worker.js`, "Run a workflow to … then …" via `workflowFromWords`, and "run my X workflow") calls `startCommandWorkflow`. Tests: `command_center.test.mjs` "a voice/typed sentence compiles named commands…", "saved workflows persist… started by voice". | Proof test drives it with one typed or spoken sentence. | Speech recognition on a real iPhone (the test sends the transcribed text). |
| 2 | Executes on the server through DO alarms and the job queue | **True.** Each graph node is enqueued as a `command` job (`advanceObjectives` → `enqueueJob`), and `alarm()` → `processJobs()` runs it. `command` is an owner-approved job kind, so it runs even while Office autonomy is paused. Test: "workflow steps run through /api/chat on the job queue…". | Proof test runs every step from `state.alarm()`, not from a chat request. | The production Cloudflare alarm scheduler. Locally `setAlarm` is recorded, not fired by Cloudflare. |
| 3 | Survives the app closing | **True by design.** All state is in DO storage (`che` key: `objectives`, `jobs`), and no phone connection is needed after the start reply. | Proof test: after the start reply no client request is open, and the work continues only from alarms. | Not checked with a real phone closing the app. |
| 4 | Saves checkpoints | **True.** `processJobs` writes `status: running` and `attempts+1` to storage before any model call ("Durable checkpoint BEFORE any AI is spent"). The graph keeps each completed node's `output` and `verification`, and `recordNodeOutcome` never changes a completed node. Per-job `checkpoint` objects exist for coding and REA jobs. | Proof test reads the checkpoint from storage while step 2 is in flight. | — |
| 5 | Recovers after an interruption without redoing finished steps | **True, but no test covered the whole sequence.** The stale-job sweep in `processJobs` requeues a job left `running` past `jobStaleMs` (5 minutes), with backoff and a dead-letter ceiling (`MAX_JOB_ATTEMPTS`). Completed nodes are final. Related tests: `command_center.test.mjs` "11. command runs and workflow runs survive a restart"; `worker_autonomy.test.mjs` covers the sweep. | **New end-to-end test.** Step 2's model call is cut off (the instance never returns). A new `CheState` starts over the same storage. The alarm sweeps the job, a later alarm resumes step 2, and step 1 keeps its single job with `attempts: 1`. | Real isolate eviction or CPU-limit kill in production. The test simulates it with a never-settling call and a fresh instance, and moves `Date.now` forward. |
| 6 | Completes a real task | **True.** Steps run as the owner's own commands through `/api/chat` with every gate. | The proof task reads a confirmed owner memory already in storage (`/che-memory`, deterministic, zero model calls). It then writes a one-page summary report from that result (`/che-plan`), which receives step 1's output as data. | With a real model, the report's wording comes from the live model. The test uses a fixed fake reply. |
| 7 | Produces a verified artifact (content hash recorded) | **Missing.** Step outputs were kept on the graph, but nothing produced one result file, hashed it or recorded a receipt. | **`mission_artifact.js`.** When a `command_workflow` objective completes, `advanceMissions` → `sealFinishedMissions`: (1) builds a deterministic Markdown report from the recorded step outputs; (2) stores it in CHE's blob store (`che_blob_store.js`, DO storage); (3) reads it back and checks its SHA-256; (4) records a `mission_artifact` receipt (`truth_layer.recordReceipt`, keyed by mission id, so it is written once); (5) sets `objective.artifact = { key, sha256, bytes, verified, receipt }`. Re-sealing after a crash reuses the same bytes and the same hash. | Not run against production storage. |
| 8 | Shows the result when CHE reopens | **Partly true.** Commands → Activity refreshes `/api/commands` on open and showed the step outputs, with no result or receipt. | `/api/commands` `missions[].artifact` adds `{sha256, bytes, verified, receipt, spoken}`. **`GET /api/commands/missions/artifact?id=`** (owner only) returns the report text and the receipt, and re-hashes the bytes on every read, so `verified` is true only while the stored bytes still match. The spoken "mission status" adds the result line, and when nothing is running it names the last finished run. Flutter: `CheMissionArtifact` model, plus a quiet result row on `CheMissionCard` with a VoiceOver label. It is shown and never spoken automatically (AGENTS.md); Read This and "mission status" speak it on request. | Not seen on a real iPhone. The Flutter widget test uses a fake server. |

## How to run the proof

```sh
cd server/cloudflare
node --test mission_engine_proof.test.mjs     # the proof (2 tests)
node --test *.test.mjs                        # full Worker suite, as CI runs it
```

Flutter (the result row and its VoiceOver label):

```sh
export PATH=/opt/flutter/bin:$PATH
flutter test test/che_command_center_test.dart
```

The proof test is offline. It uses no network, a fake model and in-memory DO storage that outlives each `CheState` instance. It needs no paid service and makes no trade or delete.

## What the proof test checks, in order

1. Pairs an owner device. Saves a confirmed memory through chat ("Remember that my business is Joe's Barbershop…").
2. `POST /api/chat`: "Run a workflow to che memory my business then che plan a one page summary report of my business". It checks the route is `che_command_workflow`, the objective is owner-authorized, step 1 is queued as a job in storage and an alarm is set.
3. `alarm()` runs step 1 (`che_memory_provenance`, the stored memory) and queues step 2.
4. A second `alarm()` starts step 2. Its model call never returns, which simulates eviction. Storage shows the job `running` with `attempts: 1`, saved before the call.
5. Restart: a new `CheState` over the same storage, with time moved forward 6 minutes. `alarm()` sweeps the job back to `queued` with a backoff and sets the DO alarm. At +20 minutes, `alarm()` resumes step 2, which receives step 1's result.
6. The mission is `complete`. Step 1 has one job with one attempt. Step 2 has two attempts, the cut-off one and the resumed one. The model was called once per attempt.
7. Artifact: the SHA-256 computed independently with `node:crypto` equals the recorded hash. The receipt exists with the same hash and step list.
8. Reopen (another new instance). `/api/commands` shows the mission complete with the verified artifact. `/api/commands/missions/artifact` returns text that hashes to the receipt. The endpoint refuses a request without the owner's token. The spoken "Mission status" includes the result.

A second test changes one stored byte and checks that the read reports `verified: false`. It also checks that sealing twice is a no-op and that an unfinished mission is never sealed.

## Still not verified

- Not run on a real iPhone, on the production Worker or under real Cloudflare alarm and eviction behaviour. Everything above is local, offline and simulated.
- The result's content quality with a live model.
- The artifact lives in DO storage (CHE's blob store), not in R2. It is capped by `STORE_LIMIT_BYTES` like other blobs.
- `GET /api/commands/missions/artifact` is not yet called by the Flutter app. The card shows the hash and verified state from `/api/commands`, and the full report text is only reachable through the endpoint.
