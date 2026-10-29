# CHE voice reliability audit

Date: 2026-10-29. Base: origin/main at 60ba3a08. Branch: feat/voice-reliability-audit (worktree wt/voice-reliability).

Scope: lib/che_reply_outcome.dart, the voice path in lib/home_state/streaming.dart, and server/cloudflare/phone_voice.js.
Read with them, because a spoken reply cannot be traced without them: lib/home_state/send.dart, lib/home_state/voice.dart,
lib/che_speech_pipeline.dart, lib/che_voice_turn.dart, lib/che_edge_voice.dart, and server/cloudflare/worker.js (voice routes only).

Question: where can a spoken reply end with neither audio nor text on screen, and is each such place covered by a test?

## Result

- No defect was confirmed by a failing test, so no code was changed and no regression test was added.
- Every reply-ending path below either keeps its text on screen or says why it stayed silent, with two exceptions
  recorded as findings (F1, F2). Both are in the speech layer, not in the three files named in scope.
- Tests run offline: `phone_voice.test.mjs` 22/22 pass; `worker.test.mjs` plus `worker_autonomy.test.mjs` 208/208 pass.
- Dart tests were not run (see "Not verified").
- No ElevenLabs, Fish, or other provider call was made. No deploy. No network call.

## A. Chat reply text (streaming.dart, che_reply_outcome.dart, send.dart)

Receipt legend: file:line. "Covered" means a test asserts the behavior, not that the whole path is exercised end to end.

| # | Path | Receipts | Ends with | Test |
|---|------|----------|-----------|------|
| A1 | Stream cut off after some deltas: partial text kept, cut-off note added and spoken | streaming.dart:412-420, 716; che_reply_outcome.dart:29-31, 48-56; send.dart:1622-1629 | Partial text + note (audio and text) | Covered: test/che_reply_outcome_test.dart:37-44, 61-73 |
| A2 | Stream cut off with only steps, or only an unknown frame type | che_reply_outcome.dart:29-31, 36-45; send.dart:1622 | Cut-off message (audio and text) | Covered: test :46-53, :80-83 |
| A3 | Stream with no frames at all | streaming.dart:412-414 (loop yields nothing); che_reply_outcome.dart:31, 40-41 | "never arrived" message | Covered: test :22-28 |
| A4 | Done frame with no reply text | che_reply_outcome.dart:50; send.dart:1622 | "finished but sent no reply text" | Covered: test :55-59 |
| A5 | Owner-approval hold with an empty question | streaming.dart:426-433 (no text written); tally says done (che_reply_outcome.dart:26, 30); send.dart:1622 then shows the done message | Done message, not the hold itself | Tally only: test :75-78. The empty-question case is not tested. Minor: the message says "finished", which is inaccurate for a hold. |
| A6 | Owner taps Stop mid-stream | main.dart:665-675 sets `_stopRequested` and cancels the request; streaming.dart:415 breaks the loop; send.dart:1617-1622 uses `stopped` to show "Stopped." (empty reply) or the partial text with no cut-off note | Partial text or "Stopped." (audio and text) | Not covered (widget/integration logic) |
| A7 | Worker error frame (quota, daily limit, engines failed, unavailable) | streaming.dart:436-452: local offline answer if one exists (444-449), else throws; send.dart:1697-1715 shows the error and speaks it | Error text + audio | Not covered |
| A8 | Stream dropped or non-JSON line during the read | streaming.dart:412-420 (jsonDecode or socket error throws); send.dart:1716-1735 shows the error and speaks it | Error text + audio | Not covered. Open question: send.dart:1613-1615 disposes `uiBatcher` without a flush on this path, so the last deltas may be missing from the text shown when `_replyKeepingPartial` runs. Not verified (batcher internals not read). |
| A9 | Not paired, offline answer returns null | streaming.dart:111-118 throws "This device is not paired." | Message + audio | Not covered |
| A10 | Reply text sanitized | send.dart:681-694 returns trimmed input unless it is empty; it never empties a non-empty reply | n/a | Not needed |

## B. Speech layer (voice.dart, che_speech_pipeline.dart, che_voice_turn.dart, che_edge_voice.dart)

These are the paths where a spoken reply can end silent. Chat text is usually kept, but only when the caller records it
(`record: true` is the default in voice.dart:268).

| # | Path | Receipts | Ends with | Test |
|---|------|----------|-----------|------|
| B1 | Voice replies turned off, not a read-on-demand: no speech turn opens | voice.dart:317-328 returns null; voice.dart:279-280 returns silently | Text only if recorded | Not covered |
| B2 | Realtime connected and phase is speaking, thinking, user speaking or connecting | voice.dart:306-315 returns null; voice.dart:279-280 | Text only if recorded | Not covered |
| B3 | `speakText` with `record: false` and `show: false` while B1 or B2 applies | voice.dart:268-296. Callers include hub_rooms.dart:137, 770, 846; memory.dart:243; security.dart:136, 553; main.dart:480 | **Neither audio nor text.** See F1. | Not covered |
| B4 | Duplicate sentence skipped | voice.dart:275-278 | Earlier copy of the same text was spoken | Not checked |
| B5 | Locked clip cannot be obtained, or the voice stops partway | che_voice_turn.dart:117-146; reason via cheSilentVoiceReason (che_edge_voice.dart:139-146); banner in voice.dart:471-500 | Silent banner with reason and the rest of the words; text on screen | Covered: test/che_voice_turn_test.dart:97-108, 125-131, 132-139 |
| B6 | Lost answer (no connection): one more request; timeout is not retried | che_voice_turn.dart:104-113 | Retry, then as B5 | Covered: test :110-124, :148-154. Known trade-off: a dropped answer may have been paid for server-side; the comment says so. |
| B7 | Clip has no audio: the pipeline's fallback runs for that chunk only | che_speech_pipeline.dart:143-152 (synthesis error becomes null), 185-194 (play failure or null audio calls fallback) | Other chunks still speak | Covered: test/che_speech_pipeline_test.dart:131 |
| B8 | Premium-only clip with no audio: silent banner with reason | voice.dart:382-395 sets the reason; fallback at voice.dart:416-420 calls `_staySilent` (voice.dart:471-500) | Banner (12 s) with first 600 characters of unheard text | Not covered (widget code). See F2. |
| B9 | Private Mode, on-device voice not loaded | voice.dart:360-365, 373-381; fallback at 411-415 | Silent banner with reason | Covered at server level: phone_voice.test.mjs:337; the on-device branch itself not tested |
| B10 | Device-voice fallback (web or desktop only) throws | che_speech_pipeline.dart:190-194 ignores the fallback's returned bool; voice.dart:508-521 returns false on error | Silence with no banner | Not covered. Off-iPhone only; the comment in voice.dart:508-521 says keeping the typed text is intended. See F3. |
| B11 | Empty text reaches the phone client | che_edge_voice.dart:232-233 returns an empty result with no failure; voice.dart:417 falls back to the generic reason "neither ElevenLabs nor Fish sent audio" | Silent banner with a generic reason | Not covered. Low impact: send.dart:1622 and voice.dart:290 already replace unspeakable text. |
| B12 | 200 with an empty body, or a non-audio content type | che_edge_voice.dart:280-285 | No clip; reason from status words | Not covered in Dart (che_elevenlabs_voice_test.dart mentions CheEdgeVoice; not read in full) |
| B13 | 204 from the Worker (premium_only, a lock, or Private Mode) | che_edge_voice.dart:277-281; worker.js:7182-7185 | Silent banner with reason | Node: worker_autonomy.test.mjs:2901 (premium_only 204); phone_voice.test.mjs:232-244 (locked 204) |
| B14 | Phone timeout | che_edge_voice.dart:253-270, 299-300 (timeout, no retry) | Silent banner with timeout reason | Covered: che_voice_turn test :148-154 (timed-out part not asked again) |
| B15 | Phone cannot reach the Worker, not paired, or 401 | che_edge_voice.dart:243-246, 274-276, 301-302 | Silent banner with reason | Not covered |
| B16 | Private voice refuses server voice before any call | che_edge_voice.dart:234-235 | Silent banner with the refusal | Covered: test/che_private_voice_test.dart (setting and refusal) |

## C. Server (phone_voice.js and the voice routes in worker.js)

| # | Path | Receipts | Ends with | Test |
|---|------|----------|-----------|------|
| C1 | ElevenLabs fails, locked clip: one retry only if the failure is retryable; otherwise silent with the reason | phone_voice.js:117-126 | 204 with lock header (worker.js:7182-7185) | Node: phone_voice.test.mjs:62-125 (22 tests, all pass) |
| C2 | Locked clip wants Fish on conversation: no Fish call | phone_voice.js:103-104 | 204 with lock header | Node: phone_voice.test.mjs:282-309 |
| C3 | Unlocked clip: primary, then backup only for story, narration or expressive purposes | phone_voice.js:105-106, 127-131 | Audio or null | Node: phone_voice.test.mjs:62-69, 282-288 |
| C4 | Premium null, premium_only or lock set | worker.js:7178-7185 | 204 with statuses | Node: worker_autonomy.test.mjs:2901 |
| C5 | Premium null, neither premium_only nor lock (non-phone or older client) | worker.js:7186 falls through to handleEdgeVoice (edge_route.js:17 returns 204 on failure) | Audio from a non-ElevenLabs voice, or 204 | Not checked against the owner rule. See F4. |
| C6 | /api/voice/synthesize, all voices fail | worker.js:1022-1190 (free chain), ends with 503 "No server voice worked" | JSON 503, no audio | Node: worker.test.mjs:413 (503 with no voices) |
| C7 | Voice log write fails | phone_voice.js:168-175 swallows the error by design | Speech unaffected | Node: no direct test seen |
| C8 | Turn map at capacity or expired | phone_voice.js:65-76 (bounded and TTL) | A new turn takes the current choice | Node: phone_voice.test.mjs:139-152 |

## Findings for the owner

- F1 (speech layer, real gap): when voice replies are off (B1) or realtime is speaking (B2), a `speakText` call with
  `record: false` and no `show` (B3) produces neither audio nor on-screen text. Callers listed in B3. Fix would be a product
  choice: show these as a banner, or record them. Not changed.
- F2 (speech layer): the silent banner (voice.dart:482-490) shows only the first 600 characters of the unheard text, for 12
  seconds. Read-on-demand text is not in the chat, so the rest of a long read is never shown. Not changed.
- F3 (off iPhone only): the device-voice fallback's failure is ignored (che_speech_pipeline.dart:190-194). The chunk goes
  silent with no banner. Low impact. Not changed.
- F4 (owner rule, needs an owner decision): phone_voice.js:93-95 says CHE's assistant speech is ElevenLabs only. The Worker
  still falls through to free voices (OpenAI, Gemini, Hugging Face, Aura, edge) for requests that carry neither `premium_only`
  nor a lock (worker.js:7186; voice chain 1022-1190). The owner's phone always sends `premium_only` (che_edge_voice.dart:264,
  voice.dart:349), so the phone does not reach this path. Non-owner clients and other callers can. Not changed.

## Not verified

- Dart tests were not run. The branch has no Flutter build run; the disk has about 4.8 GB free, and the task limits Flutter
  runs. Dart coverage statements above come from reading the test files, not from running them.
- Device behavior, real audio playback, and the Flutter widget paths (A6-A9, B3, B8, B10, F2) are not exercised.
- The batcher's `dispose` semantics (A8) were not read.
- The live Worker, ElevenLabs, Fish, and the deployed commit were not checked. None were called.
- The CHE session-start routine in CLAUDE.md (preflight, handoff reads, GitHub refresh) was not run for this delegated audit;
  the audit uses origin/main at 60ba3a08 as its base.
