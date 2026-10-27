# CHE performance: what was slow, the budgets, and how they are kept

Owner, 2026-10-22: "she's lagging a lot". This page records what was measured, what was fixed, and the guards that keep
a new feature from bringing the lag back.

## Measuring

```
node tools/che_perf_bench.mjs                      # the real Worker, fake model, no network
CHE_BENCH_MEMORIES=10000 node tools/che_perf_bench.mjs --runs 9
node tools/che_perf_bench.mjs --worker /path/to/other/checkout/server/cloudflare   # compare commits
```

For each benchmark turn (greeting, memory question, trading status, `/status`, a model answer) and each GET the app
polls, it prints the median and p95 handler time over warm runs, and the storage operations it made: reads, full reads
of the owner state `che` ("che"), writes, SQL statements and bytes written. Cold import of `worker.js` is printed once.

## What was slow (measured 2026-10-23, local, fake model)

Handler time grew with the size of the owner's brain, because every request deserialized the whole `che` object
several times, and every write to it re-classified every memory for the Brain Ledger.

| 3000 memories, median ms | before (main 27dd760) | after |
|---|---|---|
| greeting | 98 | 46 |
| memory question | 54 | 28 |
| trading status | 44 | 22 |
| `/status` | 30 | 20 |
| model answer | 103 | 37 |
| Brain Ledger view | 93 | 46 |
| full reads of `che` per chat turn | 5 | 2 |

At 10 000 memories: the memory question went from 142 to 72 ms, and a model answer from 244 to 172 ms.

Causes, with evidence (CPU profile of the benchmark plus a stack trace of each `che` read):

1. **Repeated full reads of `che` per turn.** `handleRequest` read it, then the workflow receipt (#462), the workflow-run
   record (#462) and the history filter for Office task lines each called `loadData()` again: 5 reads, every one a full
   structured clone of the owner state (`structuredClone` was the top function in the profile). These callers only read,
   so they now share one per-request copy (`peekData()`), which is dropped on any write to `che`.
2. **Brain Ledger diff on every `che` write (#469).** `diffOwnerMemories` ran `categorize()` and its regexes on every
   memory record on every save, and rewrote its full snapshot to SQL even when nothing changed. It now classifies only
   new or newly inactive records and saves the snapshot only when it changed.
3. **Date grounding on every reply.** `groundedReply` formatted every stored record's dates with `Intl` (`ownerDay`
   in the profile) even when the reply held no date. It now returns at once for a reply with no date.
4. **Brain Ledger cards** read `SELECT *` and parsed every event's `detail` JSON; they now read the nine columns they count.

Commits between 2026-10-22 and 27dd760 (Workflow Engine #462, Security #464, Capability Engine #465, Brain Ledger #469,
Security Core #470) each added a few storage reads per turn (49 → 60 gets on a greeting); those reads are small keys.
Cold import of `worker.js` (about 1.03 MB) measured 330–670 ms locally across these commits, noisy and without a clear step.

The app side was checked too: the 15-second state poll already skips decoding and rebuilding an unchanged body,
hidden tabs stop their animations (#440), and today's new screens hold no timers while idle. The Security Cyber World
was the one new animated screen; it is now covered by `test/che_performance_test.dart`.

## Guards

**CI** (`server/cloudflare/perf_budget.test.mjs`, run by the Worker test step of `flutter-check.yml` and the deploy
workflow) runs the benchmark on a 3000-memory brain and fails when a chat turn or polled GET exceeds the budgets in
`tools/che_perf_budget.json`:

| budget | value |
|---|---|
| full reads of `che` per chat turn | 2 |
| writes of `che` per chat turn | 0 |
| storage reads / writes / SQL statements per chat turn | 60 / 14 / 80 |
| median handler time per chat turn (CI runner) | 250 ms |
| full reads of `che` per polled GET | 1 |
| `worker.js` size | 1 100 000 bytes |
| cold import | 4000 ms |

`test/che_performance_test.dart` fails when an idle or hidden new screen keeps scheduling frames.

**Live** (`server/cloudflare/perf_watch.js`): the Worker keeps the last 60 timings per route (route name and milliseconds
only, no message text), flushed to storage at most once a minute. When at least 10 samples' p95 is over budget (1500 ms
for replies CHE answers herself, 800 ms for a GET), `/api/state` carries `performance: {status: 'slow', note}` and the app
shows the note as one quiet, muted line under the status banner. CHE never speaks it by herself. "Are you lagging?",
"why are you slow?", "performance report" or `/che-performance` (typed or spoken) answer with the measured typical and
slowest-5-percent times and the slowest stage. Replies that use a model are shown but not judged: their time is the provider's.
`GET /api/performance` returns the full report for the owner's device.

## Changing a budget

Raise a number only on purpose, in the same PR as the feature that needs it, with the measured reason in that PR. The
runtime budget is in both `tools/che_perf_budget.json` and `perf_watch.js`; a test keeps them equal. Prefer fixing the
cause: read `che` once per request (`peekData()` for read-only callers), keep work off every write, and move new
features into their own modules instead of growing `worker.js`.
