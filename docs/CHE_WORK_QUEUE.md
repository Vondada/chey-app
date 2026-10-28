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

## Owner decisions needed
- Office swipe (Q-02).
- Whether Alpaca PAPER shows in the trading room (Q-10).
- Daily spend cap for live eval runs (Q-09). It is $0 now.
- Whether automatic background runs are allowed (this would change the AGENTS.md rule and use more usage).

## Log
- 2026-10-28: Q-35 added (25 GPU and 3D world upgrades, `docs/CHE_GPU_WORLD_UPGRADES.md`). Nothing built yet.
- 2026-10-27: Q-01 done (#672 merged); Q-07 is PR #700.
- 2026-10-26: queue created from the day's requests. Earlier work is recorded in the branches above and in `docs/CHE_MISSION_LEDGER.md`.
