# Failure inventory: markets, Recording Studio, media and creation

Lane `lane/rel-markets-studio`, owner's reliability cleanup, written 2026-10-25 by Claude.

Sources: `mailbox/briefs/LIVE-HANDOFF.md` and `mailbox/*.jsonl` on `che-mailbox` (fetched 2026-10-25),
`git log origin/main`, `docs/CHE_READINESS.md`, and the Worker and Flutter tests. Every status below cites a test or
a commit. "Offline" means the evidence is a local test with fixtures and no network, no R2, no GPU and no iPhone.
Nothing here was checked on the owner's phone or in production from this container (exchange, documentation and
blob hosts answer 403 through the proxy).

Status words:

- **FIXED**: a test or a live check proves the fix, and that test passes now.
- **REGRESSION**: it worked before and is broken now. (None is open in this lane; see "Found this session".)
- **PARTIAL**: part of the problem is fixed, or the code exists but a known piece is missing.
- **BLOCKED**: it needs something outside the code: an external account, a licence, a new IPA, or the owner's go.
- **UNVERIFIED**: the code may be right, but nothing has proved it where it matters (phone, production, live feed).

Live trading stays disabled everywhere (`liveOrdersStatus()`; `trading_honesty.test.mjs`,
`trading_environments.test.mjs`). Nothing in this lane touched an order path.

## Found and fixed this session (failing test first)

| # | Defect | Root cause | Fix | Test |
|---|---|---|---|---|
| F1 | Paper trading (`paperTick`) learned and opened trades from a bar that had not closed | `server/cloudflare/trading_lab.js` `paperTick` passed `data.candles` straight to `learnStep` and `entry(candles, candles.length - 1, …)`. Binance's newest kline and today's daily row are still forming, so an unsettled price changed the learned skill stats and could open a trade a closed bar would not signal | `38e96ef5`: `closedCandles()` keeps bars with open + interval ≤ now; the forming bar waits for the next tick | `trading_lab.test.mjs` "paper trading never decides on the bar that is still forming" (failed before: the learned results differed between a spiking and a collapsing forming bar) |
| F2 | NQ forward-paper evidence consumed today's partial daily row and never read its final prices | `server/cloudflare/trading_evidence_runner.js` `evidenceTick` stepped every row, `stepPortfolio` set `last_bar_time` to the partial row, and the next tick skipped that date. A stop or target reached later that day could be missed | `0a5994b6`: the runner trims unclosed rows with `closedCandles()` | `trading_evidence_runner.test.mjs` "today's unfinished daily bar is not consumed…" (failed before: `last_bar` was the forming day) |
| F3 | The chart's price readout said "The chart itself is still live" when the quote failed | `lib/rooms/che_live_chart.dart` `readPrice`, both failure branches. Nothing had checked the chart. Reported 2026-10-19 (`mailbox/chatgpt.jsonl` line 217; CHE agreed it was real) and never fixed | `0dbcc895`: the readout says whether the chart is still updating is not confirmed | `test/che_live_chart_test.dart` "a failed price read never claims the chart is still live" (failed before) |
| F4 | No test proved that replay and backtest ignore the future | Gap only: the old test built the context from the truncated slice, so it could not catch a whole-history indicator leak | `38e96ef5` | `trading_lab.test.mjs` "replay without look-ahead: rewriting every bar after a point never changes a trade decided before it": every indicator, entry and closed trade for the 3 strategies and all 63 skills. Passes; the backtest had no look-ahead |

Other engines already used closed bars only: `crypto_markets.js` (Kraken cross-check drops the forming bar),
`market_feed.js:73/86`, `trading_live.js:325`, `historical_intelligence.js:105-113`. F1 and F2 were the two exceptions.

## Trading and market data

| # | Failure | Status | Evidence |
|---|---|---|---|
| T1 | BTC/ETH chart said LIVE on heartbeats over old candles (a silent trade channel looked live) | FIXED (offline) | `62a2662e`; `test/che_crypto_stream_test.dart` "heartbeats over an old last trade are STALE, never LIVE…" |
| T2 | Coinbase/Kraken messages into candles, REST merge and the status line had no end-to-end test | FIXED (offline) | `fad5438f`; `test/che_crypto_docs_e2e_test.dart` (examples transcribed from the official docs and labelled, never shown as market data) |
| T3 | The phone's WebSocket stream against the real exchanges | UNVERIFIED | Exchange hosts refused by this container's proxy. Live smoke test: `CHE_LIVE_SMOKE=1` (not run). Handoff 2026-10-25: "phone WebSocket crypto stream vs real exchanges" not verified |
| T4 | Backtest look-ahead | FIXED (proved absent) | F4 above; existing `trading_lab.test.mjs` "backtest has no look-ahead…", `trading_research.test.mjs` look-ahead audit per strategy |
| T5 | Trade replay showing bars or exits before they happened | FIXED | `ce65da6b`; `trading_visual.test.mjs` "replay: nothing after the cursor is ever visible…"; `test/che_trade_replay_test.dart`; `e2e_trading_journal.test.mjs` |
| T6 | Paper trading decided on a forming bar | FIXED | F1, F2 |
| T7 | Opening the replay of an ETH-USD simulation trade from its chart marker did not find the trade | FIXED | `trade_replay_ids.test.mjs` "regression: opening the replay of an ETH-USD simulation trade from its chart marker finds the trade" |
| T8 | Chart crash on a malformed payload (scalar where a list was expected) | FIXED | Guard in `af210bcd` (#516); regression test `d67d87c8` `test/che_trading_chart_malformed_test.dart` (fails with the guard removed) |
| T9 | Trade markers drew a stray column over the text and cluttered the chart | FIXED | `b00645ea`, `116209a9` (no dedicated test found) |
| T10 | Chart price readout claimed "still live" after a failed quote | FIXED | F3 |
| T11 | "Is the MNQ data live?" answered as a Worker deployment check (`CHE_READINESS.md` bug 3) | FIXED | `e2e_owner_status_phrases.test.mjs` "… is answered about market data freshness, not the Worker deployment" now runs as a passing test; full suite 2026-10-25 has 0 todo |
| T12 | Stale delayed futures bars used as current | FIXED | `60b80bc6`; `trading_live.test.mjs` "delayed data older than the maximum age" (45 min, `trading_delayed_training.js:14`) |
| T13 | Futures data honesty: MNQ/NQ are delayed research bars, no live futures feed | BLOCKED | Rithmic/Tradovate API access is external (`CHE_READINESS.md` §2). Rithmic work is Codex's PR #525 and is not touched here |
| T14 | #350 test 2: "analyze MNQ…" answered with a FundYourEdge order refusal | FIXED | `f2992a73` (#351); MNQ gets a feed and journal read with "I placed no order" |
| T15 | A 20-year backtest question reopened a saved Invention Studio project | FIXED | `0049056b` (#472); `mailbox/claude.jsonl` line 266 |
| T16 | "Why no new trades?" had no answer from records | FIXED | `26dbc6bd` (#414) |
| T17 | Simulation P&L dominated by costs (316 trades with costs larger than their risk, −7,833.94 R of −8,061.76 R) | PARTIAL | Cost gate `strategy_sim.js:133/175` stops new ones; `trading_audit.test.mjs`. 9 trades closed after the gate from positions opened before it ("to confirm", handoff 2026-10-25), not rechecked in production |
| T18 | The owner's ≈ −$1,018 on 2026-09-22 is in none of the sim, journal or research ledgers | UNVERIFIED | `che_calendars.test.mjs` "September 22, 2026: the day's P&L is the sum of its stored rows…" proves only the arithmetic. The broker side (Alpaca paper, other stores) was never checked |
| T19 | Alpaca paper fills and broker P&L | UNVERIFIED | `che_calendars.test.mjs` "broker: Alpaca PAPER fills are kept once each…"; merged in #524; no production read |
| T20 | TradeSea in CHE's WebView showed a black chart and "Connecting…" (owner recording, 2026-10-18) | UNVERIFIED | `mailbox/chatgpt.jsonl` lines 185-199. No fix commit found; a third-party page in a WebView cannot be reproduced here |
| T21 | "Repair your trading-learning engine's missing progress records" (CHE's crew stopped, 2026-10-19) | UNVERIFIED | `mailbox/claude.jsonl` line 198. Learning progress and discoveries are stored (`trading_lab.test.mjs` "paper ticks keep learning, journal discoveries…"), but no commit names this request and the production book was not read |

## Recording Studio (music) and video editing

| # | Failure | Status | Evidence |
|---|---|---|---|
| S1 | Native recording on the iPhone has never been verified | UNVERIFIED | `CHE_READINESS.md` §3 and bug 8. Recorder is native Swift in `tool/bootstrap.sh` |
| S2 | A microphone that failed after "Recording on…" was not reported aloud | FIXED | `test/che_recording_studio_test.dart` "by voice, a microphone that fails after "Recording on…" was said is still reported aloud (review of #523)" |
| S3 | CHE's voice stopped the music or landed in the take | FIXED | same file, "by voice, CHE speaks before the sound starts…" |
| S4 | An installed build without the recorder pretended to record | FIXED | same file, "an installed build without the recorder says so instead of pretending" |
| S5 | M4A export, MP3/M4A import and live monitoring | BLOCKED | Code and tests merged in #524 (`afb8de15`): "M4A export uses the iPhone encoder…", "MP3 and M4A imports go through the iPhone decoder…", "live monitoring: refused on the iPhone speaker…". They need the new full IPA (run 40152765510, built, not signed or installed) |
| S6 | WAV export of the whole song | FIXED (offline) | "export writes a real WAV of the whole song to Exports" |
| S7 | Editing: punch-in, undo, Bring Me Back | FIXED (offline) | `test/che_studio_engine_test.dart` "punch in replaces only the punch range…", "engineer mode reads numbered options… undo reverses each change", "bring me back with no good mix says so…" |
| S8 | Studio engine lanes (beat producer, Engineer Mode, presets, vocal analysis) were lost with a container | FIXED (code), device UNVERIFIED | Rebuilt and merged in #524; wired into `lib/music/che_recording_studio.dart` (`_engineerCard`, Beat Maker tab) |
| S9 | Studio Tutorials lane was lost and never rebuilt | PARTIAL | Handoff 2026-10-25 "Open: studio-tutorials lane never rebuilt". No code exists |
| S10 | Pitch correction too slow | FIXED (offline) | `461a5d0c` (in #524); `test/che_pitch_voice_test.dart` |
| S11 | Video editor renders failed on some ffmpeg versions | FIXED | `1ed4231a` (#471); `test/che_visual_studio_test.dart` "video editor: … a failed render with Retry" |

## Media and creation (save and reopen)

| # | Failure | Status | Evidence |
|---|---|---|---|
| M1 | Films saved after #508 answered "Media data missing" on open (record said `r2`, no bucket bound) | FIXED (offline) | `7ed0f35a`; `film_studio.test.mjs` "a film finished without R2 reopens…"; `media_library.test.mjs` "a video in CHE's own store (no R2) is read back and reported playable…" |
| M2 | The library called a record playable when its key merely existed | FIXED | `7ed0f35a`; `media_library.test.mjs` ""playable" needs MP4 bytes…" |
| M3 | Saved PNG, CHE's GLB and an MP4 must reopen after a restart | FIXED (offline) | `f4dfde45`; `e2e_media_artifacts.test.mjs` (3 tests: pixels, SHA-256 of the GLB, MP4 boxes). Production R2/phone UNVERIFIED |
| M4 | "Open saved image <id>" listed the media store instead of opening the image | FIXED (branch only) | `0ec23ac4`; `media_retrieval.test.mjs`, `test/che_chat_image_test.dart`. Not merged to main |
| M5 | Pictures saved from the iPhone failed (MIME) | FIXED | `a3a8101c` (#420); `media_save.test.mjs` "a saved picture is still listed and retrievable after a restart…" |
| M6 | "The finished video is now in your Projects" followed by "I generated 0 visuals" (2026-10-22) | FIXED | `1cd76407` (#509), `55134630` (#512); `hallucination_auditor.test.mjs`, `truth_acceptance.test.mjs` |
| M7 | #350 test 4: video status answered with the list of AI providers | FIXED | `f2992a73` (#351) |
| M8 | No storage bound, so no real MP4 could be kept (2026-10-09) | FIXED | `0a86b707` (#508) own store; free renderer #260 |
| M9 | Video render dispatch could fail with 403 (token scope) | UNVERIFIED | `mailbox/chatgpt.jsonl` lines 142-144; not rechecked |
| M10 | Reference-video analysis and render failed (2026-10-22) | UNVERIFIED | `mailbox/claude.jsonl` line 254. No fix commit found; `creator_studio.js` uses references as style direction only |
| M11 | Blender cinematic: no verified final MP4 | BLOCKED | Owner paused full renders (handoff, Creation row) |
| M12 | Creation Engine receipt named the worker "?" | FIXED | #524; live `creation_check` run 40153146586 names the worker |
| M13 | Colab GPU path never verified | UNVERIFIED | `CHE_READINESS.md` bug 6; only the free CPU worker is proved |
| M14 | Generate → worker → GLB → viewport | FIXED (live) | `creation_check` runs 40143945084 and 40153146586: GLB SHA matched the receipt, viewport played walk |

## Counts

| Status | Trading | Studio | Media | Total |
|---|---|---|---|---|
| FIXED | 14 (T1, T2, T4-T12, T14-T16) | 8 (S2-S4, S6-S8, S10, S11) | 10 (M1-M8, M12, M14; M4 on this branch only) | 32 |
| REGRESSION | 0 | 0 | 0 | 0 |
| PARTIAL | 1 (T17) | 1 (S9) | 0 | 2 |
| BLOCKED | 1 (T13) | 1 (S5) | 1 (M11) | 3 |
| UNVERIFIED | 5 (T3, T18-T21) | 1 (S1) | 3 (M9, M10, M13) | 9 |

Total rows: 21 trading + 11 studio + 14 media = 46. The F rows are counted inside T4, T6 and T10.

## What the owner can test now (after this lane merges and deploys)

- "CHE, how is paper trading going?" and "what have you learned about trading?": the numbers no longer move with the
  bar that is still trading.
- On the Trading chart, "read the price" with the network off: CHE says she could not get a price and does not claim
  the chart is live.

## Next steps

1. T18: read the Alpaca paper account and any other P&L store for 2026-09-22 (needs the owner's session).
2. T17: list the 9 post-gate closes in production and confirm each opened before the gate.
3. S5, S1: install the IPA from run 40152765510 and record one take, export M4A, import an MP3.
4. T3: run `CHE_LIVE_SMOKE=1` on a machine that can reach Coinbase and Kraken.
5. S9: rebuild Studio Tutorials only if the owner still wants it.
