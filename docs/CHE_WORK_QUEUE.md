# CHE work queue (owner's standing workflow, 2026-10-26)

**Rule:** every request the owner gives is one line in this file, with an id, the time, and its status. Nothing runs
between sessions by itself. A session that starts here works the first open item it can finish, then saves the result
here before it stops. Automatic wake-ups would need the owner to change the AGENTS.md rule on scheduled runs and would
spend usage, so they are not used.

## How a session works the queue
1. `node .claude/skills/che-recover/scripts/preflight.mjs` (nothing unpushed).
2. Read `mailbox/briefs/LIVE-HANDOFF.md` on `che-mailbox` and the open items below.
3. Work the first `open` item. Commit and push every change to its branch. Do not merge or deploy without the owner's yes.
4. Update the item's status and evidence in this file, and push the update.

Statuses: `open`, `in progress`, `waiting on owner`, `built, not verified`, `verified`, `done`.

## Open items
| id | owner request | status | branch / PR | next step | evidence |
|---|---|---|---|---|---|
| Q-01 | Release gate green for PR #672 | done | `release-gate` (PR #672 merged, `4b724dfa`) | None. Since #682 (`3c7c52d7`) the iOS `screens` job is manual and informational; `live (staging)` gates PRs. | Gate run 40417405846 on `b6435ad3`: worker, coding, flutter pass; screens fails (Office pager, trading wait, screenshots, now fixed) |
| Q-02 | Decide the Office swipe | waiting on owner | PR #672 | Owner says: add real swipeable Office sections, or gate a different scroll. | Phone Office tab has no pager (`CheOfficeFloorScreen`) |
| Q-03 | Chat: fact-check status on each CHE reply | open | `fact-check-chat` | Show "Waiting for Claude" / "Checked by Claude" under the reply, using the mailbox thread. | Mailbox side built in `83233b39`, not compiled |
| Q-04 | Mailbox: verdicts and status | built, not verified | `fact-check-chat` (83233b39) | Dart compile in CI, phone check. | Node mailbox tests 13/13; Flutter not run |
| Q-05 | Mailbox: who typed each message | built, not verified | `mailbox-origin` (646d7c7c) | Dart compile, phone check. Older messages keep the old label. | Node tests 13/13 |
| Q-06 | Money colors everywhere | built, not verified | `claude/money-colors` (WIP commits) | Review the combined diff, compile, decide the yellow calendar tint (gray per owner rule). | WIP commits; Flutter not run |
| Q-07 | Rendering benchmark native pass counted 1 frame | built, not verified | `claude/render-bench-fix` (PR #700) | CI, then the owner reruns the benchmark on the iPhone. | Root cause in `docs/CHE_RENDER_BENCH_RESULTS.md`; regression test passes with the fix and fails (1 frame) without it (2026-10-27, Linux VM) |
| Q-08 | "Make me a beat" gets a text refusal | built, not verified | `fix-beat-request` (8723faf5) | CI, Shorebird patch, phone test. | Parser tests added |
| Q-09 | Common-sense and conversation eval | built offline; live run blocked | `fact-check-eval` (54ce677b) | Owner sets the daily cap above $0 to allow live runs. | Grader tests 5/5; live run refuses at $0 |
| Q-10 | Trading room: order ticket visible to the owner | waiting on owner | `kShowAlpacaPaper = false` on main | Owner decides whether Alpaca PAPER shows in the room (he said no on 2026-10-23). | Test overrides the flag for its run only |
| Q-11 | Trading room: unfinished items | open | main | Unrealized P&L and win rate, setup levels, per-day breakdown, broker connection (needs credentials). | — |
| Q-12 | Conversation reliability suite | open | main | Expand Q-09 into multi-turn, follow-up and correction cases, and grade them. | — |
| Q-13 | Chat: more improvements the owner asked for | open | main | Verdict read-aloud, claim-by-claim split, source-freshness marks, "Ask again" for False verdicts. | — |
| Q-14 | Cloudflare Workers Builds failures | ignored | — | Owner said to ignore this check. | — |
| Q-35 | GPU and 3D world: 25 upgrades | open | `docs/gpu-world-upgrades` | Start with items 1, 4, 5 and 25 in `docs/CHE_GPU_WORLD_UPGRADES.md` (free, local, measurable). Paid GPU (15-19) waits for the owner's spend decision and a cap above $0. | Doc only; nothing built |
| Q-36 | 10 real-world tools that work together | open | `docs/real-world-tools` | Build tools 1, 4 and 7 first (capability map, permission gate, verifier), then 10 (eval). See `docs/CHE_REAL_WORLD_TOOLS.md`. | Doc only; nothing built |
| Q-15 | Car Bluetooth: one audio-session owner | open | `docs/voice-problem-solving-queue` | Stop `speech_to_text` (7.5.0) changing category, mode or activation during CHE turns (`SpeechToTextPlugin.swift:457-528`). Route listening through the native recognizer that already keeps `voiceChat`. Owner test in a car. | Code finding only; not device-tested |
| Q-16 | Faster first words: stream the reply | open | — | Let the Worker send the first sentence before the full reply is verified, keeping the safety checks (`worker.js` ~14353-14394 buffers everything). Needs a safety review first. | Code map 2026-10-28 |
| Q-17 | Faster first audio: stream TTS | open | — | Pipeline clips and start playback on the first chunk, not the full file (`preferred_elevenlabs_voice.js:211-242`, `bootstrap.sh:1480`). Target median first audio under 700 ms, measured on the phone. | No timings in repo yet |
| Q-18 | Shorter end-of-turn wait | open | — | Replace the fixed 3.6 s `pauseFor` (`microphone.dart:586`) with adaptive endpointing based on sentence completeness. | Code map 2026-10-28 |
| Q-19 | Barge-in on the Flutter recognizer | open | — | Only the native path has barge-in (`bootstrap.sh:1141-1160`). Add echo-guarded barge-in to the Flutter path, cancel queued audio and stale generation. | Code map 2026-10-28 |
| Q-20 | Voice Diagnostics: real route and latency rows | open | — | Show output and mic, Bluetooth route type, category and mode, last route change, interruptions, last audio error, and real latency medians (`CheLatency` is not shown anywhere). | `che_voice_ui.dart:228-251` |
| Q-21 | Never claim Bluetooth without reading the route | open | — | CHE states a Bluetooth route only from `AVAudioSession.currentRoute` (`routeSummary`), never from memory or a guess. Test the wording. | Native `routeSummary` exists |
| Q-22 | Recover after an incoming call | open | — | After an interruption ends, restore the session, output route and recognition without a manual tap (`bootstrap.sh:954-975`). Test the sequence. | Code only; needs a car and a phone call to verify |
| Q-23 | "What are you working on?" uses real jobs | open | — | Route to the actual active jobs and their status, never an invented list. No literal route exists today. | Grep found no route |
| Q-24 | "Why can't you hear me?" checks the mic | open | — | Read microphone and voice diagnostics, then answer with the real blocker. | Grep found no route |
| Q-25 | GPU status and "fix it" follow-up | open | — | "Why isn't my GPU working?" reads GPU connection status and error records. "Fix it" resolves to the last problem and continues the authorized troubleshooting. | Grep found no route |
| Q-26 | Follow-ups, corrections and earlier references | open | — | Carry the last topic across turns so "it", "that one" and corrections resolve correctly. Regression tests for each. | — |
| Q-27 | Problem-solving loop | open | — | For a request she can act on: understand, check what she can use, investigate, act within permission, verify, then report briefly. Recovery step on failure. | — |
| Q-28 | Honest action reports | open | — | Every action is reported aloud with its actual success or failure. Never a success message for an action that did not run. | AGENTS.md owner rule |
| Q-29 | Problem-solving eval suite | open | — | Realistic owner requests. Score task completion, real evidence, authorized action, recovery, short answers. Not just "did it reply". | — |
| Q-30 | Voice timing in the deploy probe | open | — | Per-stage timestamps from the Worker (first byte, first clip, full clip), so latency is measured without a phone. | `worker.js:7125-7145` logs per clip only |
| Q-31 | Private Mode voice test | open | — | Test that no cloud voice or cloud recognizer runs in Private Mode, including the Bluetooth path. | `privacy_mode.js:29-42`, `microphone.dart:581` |
| Q-32 | Driving-safe voice replies | open | — | Short, spoken-first replies when the route is a car, with no screen steps. | Owner request 13 |
| Q-33 | Car test script and route log | open | — | A script the owner runs in the car that records each route transition, interruption and failure to a file for review. Needs the owner's car. | Owner request 16 |
| Q-34 | Native audio changes need an IPA | open | — | Audio-session and route changes are native (Swift). Decide with the owner whether they ship by Shorebird patch or a new IPA. | Owner decision |

## Owner decisions needed
- Office swipe (Q-02).
- Whether Alpaca PAPER shows in the trading room (Q-10).
- Daily spend cap for live eval runs (Q-09). It is $0 now.
- Whether automatic background runs are allowed (this would change the AGENTS.md rule and use more usage).

## Log
- 2026-10-28: Q-36 added (10 real-world tools, `docs/CHE_REAL_WORLD_TOOLS.md`). Nothing built yet.
- 2026-10-28: Q-35 added (25 GPU and 3D world upgrades, `docs/CHE_GPU_WORLD_UPGRADES.md`). Nothing built yet.
- 2026-10-28: Q-15 to Q-34 added from the owner's voice, problem-solving and car Bluetooth requests. None built yet. Q-15 is the first to start.
- 2026-10-27: Q-01 done (#672 merged); Q-07 is PR #700.
- 2026-10-26: queue created from the day's requests. Earlier work is recorded in the branches above and in `docs/CHE_MISSION_LEDGER.md`.
