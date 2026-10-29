# CHE reliability inventory (persistent)

Purpose: a resumable record of the full-system reliability audit. Each row has evidence or it is marked unverified.
Status words: VERIFIED WORKING, FIXED BUT NOT DEPLOYED, NOT TESTED, BLOCKED, STILL BROKEN. Nothing here is "bug-free".

## Confirmed and fixed on this branch (fix/route-picture-requests)

| # | Defect | Root cause | Fix | Regression test | Status |
|---|---|---|---|---|---|
| R1 | An authorized picture of a blue glowing cube got GPU health-check or job-status replies | `modal_connect.js` read "verify", "check", "test", "done" inside a picture request as a Modal ask | A picture-creation request returns null from the Modal route unless it names an earlier job or the connection | `cube_request_routing.test.mjs` | FIXED BUT NOT DEPLOYED |
| R2 | "Do not create another blue cube picture." would make a picture | `cognitive_capabilities.js` read the verb "create" with no check for negation | A negated creation adds no image-generation capability | `cube_request_routing.test.mjs` | FIXED BUT NOT DEPLOYED |

## Earlier fixes already on main (not re-audited here)

- #762 `modal_connect.js`: status asks start nothing; one GPU check per 2 minutes; questions and negations never start a run; the GPU step decides "GPU test" vs "connection only".
- #761 Modal 256 px, `che-modal-3`, 2 s warm window. Deployed at the Modal app; the Worker deploy is run `40791424365` (#761) and `40795438700` (#762, queued at the time of writing; not yet verified).

## Known open items (not yet verified)

| Item | State | Why |
|---|---|---|
| "Did the blue glowing cube picture finish?" has no picture-status route | STILL BROKEN (no route) | No capability and no Modal word; falls to ordinary chat |
| "Check the previous picture of the blue cube" (no Modal word) | NOT TESTED | Routes nowhere specific |
| Picture job status in chat after a restart | NOT TESTED end to end | Needs the iPhone app and a real Modal picture |
| `CHE_MODAL_TXT2IMG` and its cap in production | NOT VERIFIED | Set in the Worker dashboard, not readable here |
| Real GPU picture (one call) | BLOCKED | Needs owner approval of cost and cap |
| Voice latency, Bluetooth, background audio, Office rooms, Music Studio, Trading, Browser automation | NOT TESTED | Not audited in this pass |
| iPhone IPA with the current app | NOT VERIFIED on device | Build only; install not tested |

## Audit scope so far

- Subsystems audited in depth: command routing for Modal and picture requests.
- Subsystems NOT yet audited: the rest listed in the mission (voice, providers, memory, Office rooms, Music Studio, Trading, browser, iPhone, security).
