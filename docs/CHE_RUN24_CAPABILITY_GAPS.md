# Run 24's 31 unverified questions: root causes and plan

Source: certification run 24 (`41491194768`, live commit `24d06f7a`), the rows CHE answered without an execution receipt
(class `unverified`). The same 31 were still unverified in runs 25, 26 and 27 (`41657004307`, `41703244090`,
`41714576342`). Each root cause below comes from the row's reply and `source` in the run log and from the code it reached.
Status is updated as PRs merge; a question counts as fixed only when a live run shows a successful receipt.

Blocker kinds: **routing** (a tool exists but the message never reaches it), **missing capability** (no code can do it),
**account** (code exists, an account is not connected), **permission** (iOS or a provider does not allow it), **input**
(the question names a file the turn does not carry), **approval** (CHE may do it only after the owner's yes).

| ID | Question (short) | Run 24 answer came from | Root cause | Blocker | Plan / status |
|---|---|---|---|---|---|
| thb-35 | Pair trading on two ETFs, 2018-2023, losing trades | `che_trading` decline (trading_lab.js MULTI_MARKET) | Backtests run one market at a time | missing capability | Owner's unknown-capability challenge: CHE must build it through her self-development path (#912 routes the challenge there). Not written by hand. |
| csd-38 | Create a GitHub issue | model | No create-issue code (`gh()` in coding_runtime.js can) | missing capability, approval | Issue draft held for the owner's yes, then created with the issue URL as receipt |
| csd-43 | Benchmark two sorting algorithms | model | Workers cannot time code (frozen clock, no eval); no runner wired to chat | missing capability, approval | Run in CI (cloud_computer.js runCloudTask pattern); GitHub minutes need the owner's yes |
| ter-03 | Open the calendar app | connector gate (`app_open`) | The iPhone client opens apps itself from a fixed URI map that lacks `calshow:`; the Worker cannot open iPhone apps | permission (device) | Client URI map; verifiable only on the owner's iPhone |
| ter-06 | Read my latest email aloud | `che_google` | Gmail sign-in expired (`needs_reconnect`) | account | Owner reconnects Gmail on Connections |
| ter-07 | Turn off the living room light | connector gate (`smart_home`) | `CHE_SMART_HOME_URL` not set | account | Owner provides a smart-home bridge (HTTPS URL + token) |
| ter-11 | Email Sam I will be late | `che_google` | Gmail sign-in expired; sending also needs the owner's yes | account, approval | Owner reconnects Gmail |
| ter-12 | Book a table for two at 7 pm | model | No reservation provider; a booking is a commitment | missing capability, approval | Owner decision on a provider |
| ter-13 | Find the file budget_2025 and open it | model | Media library cannot search by name | missing capability | Name search over CHE's stored files, with a search receipt |
| ter-15 | Run the Worker unit tests | connector gate (unserved verb) | The `cloud-tests` command exists but chat does not reach it | routing, approval | Route to the Cloud Computer test run; it waits for the owner's yes (GitHub minutes) |
| ter-19 | Set the volume to 40 percent | connector gate | iOS does not let an app set the system volume | permission | Correctly blocked; CHE's own voice volume is a client setting |
| ter-20 | Photos from last weekend | model | Media library cannot filter by date; iPhone Photos is on the device | missing capability, permission | Date search over CHE's stored pictures, with a search receipt |
| ter-22 | Status of my last order | model | No order source | missing capability, account | Order emails via Gmail once reconnected; owner decision |
| ter-23 | Play my morning playlist | model | No music connector (`CHE_MUSIC_URL` unset) | account | Owner connects a music bridge or service |
| ter-30 | Coding agent, then Office agent, then a summary | model | Office jobs exist (office_jobs.js) but this wording does not reach them | routing | Route multi-agent hand-offs to an Office job |
| ter-32 | Price of coffee in three shops | model (invented prices) | No price lookup reached; the model made up numbers | routing, missing capability | Research with verified sources, or say no source was found |
| ter-34 | Meeting next Tuesday 2 pm, invite contacts group | `che_google` | Calendar sign-in expired; no attendee invites; no contacts scope | account, missing capability | Owner reconnects; attendee invites; a contacts scope needs the owner's consent |
| ter-36 | Image, email and timer tools at once | connector gate (timer) | No multi-tool turn; the timer gate took it | missing capability | Multi-tool turn that runs each tool and returns each receipt |
| ter-50 | Chain weather, news, calendar, email, timer | model (invented results) | Same; the model invented every result | missing capability, account | Multi-tool turn; calendar and email need Google |
| oac-16 | Status update to the team channel | connector gate | No team channel or Slack; no team address list | missing capability, account | Owner decision on a channel |
| oac-19 | Weekly review every Monday at 10 | model | Timers refuse recurring schedules (`every` in HORIZON) | missing capability | Recurring reminders on the Durable Object alarm, with a receipt |
| oac-29 | Contract to legal, wait, then notify the client | model | No legal stage in Office jobs; notifying the client is an external message | missing capability, approval | Office job with a Legal step; the client message held for the owner's yes |
| ivg-16 | Convert this 4K video to 720p | connector gate | No video attached; no transcode starter | input, missing capability | Transcode on the free GitHub Actions ffmpeg runner when a video is attached |
| ivg-20 | 3D chair exported as glTF | model | No procedural glTF export (GLB only from Blender workers) | missing capability | Generate a glTF in the Worker and store it, with a receipt |
| ivg-24 | Compress this image under 100 KB | connector gate | No image attached; no compression tool | input, missing capability | Compression when an image is attached |
| ivg-27 | GPU benchmark score | model | No GPU benchmark job; free GPUs need the owner to open Colab or add a Kaggle token | missing capability, account | GPU queue job kind; owner provides a free GPU |
| ivg-29 | 3D scene with three lights, render time | connector gate | Workers cannot time a render; no scene-render job | missing capability | Render on the free GitHub CPU worker, timed there |
| ivg-31 | Upscale this photo 4x on the GPU queue, job ID | connector gate | No photo attached; no upscale job kind | input, missing capability | GPU queue job kind once a photo is attached |
| ivg-35 | Animated GIF of a bouncing ball | model (invented imgur link) | No GIF encoder | missing capability | GIF encoder in the Worker, stored as media, with a receipt |
| eer-35 | Restart the failed worker, new PID | connector gate | The job queue holds failed jobs but chat could not restart one | routing | **#913**: restart the newest failed job as a new job; a Worker has no PID |
| eer-36 | Last 100 queue messages and their IDs | connector gate | The job queue was not readable from chat | routing | **#913**: read the queue with a receipt listing every id |

## What exists and is reused

- Execution receipts: `executeWithReceipt` and `recordReceipt` (truth_layer.js); certification reads `execution_receipt`
  and `execution_receipts` from the done frame (tools/certification/run_certification.mjs `grade`, `actionOutcome`).
- Persistent jobs: `data.jobs` (worker.js `enqueueJob`, `processJobs`): idempotency keys, retries with backoff, dead
  letters, recovery of jobs cut off by a restart, driven by the Durable Object alarm. Dependencies: objective_graph.js.
- Owner approval: Gmail send holds (google_services.js), action approvals (`/api/action/approval`), the Cloud Computer's
  approval for GitHub minutes (cloud_computer.js).
- Deterministic owner tools: `owner_tools.js` (#913) is where new ones are added, one call in worker.js.

## Grading note

The grader passes a receipt whose status is not a failure, so a `not_run` or awaiting-approval receipt passes it. This
report counts only `success` receipts as executed; held and probe-only answers are counted separately.
