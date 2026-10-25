# Failure inventory: markets, Recording Studio, media artifacts (reliability lane R2)

Branch `lane/rel-markets-studio`, from `origin/claude/che-reliability` (main `afb8de1` + `0ec23ac`). Date 2026-10-25.
Sources: `mailbox/briefs/LIVE-HANDOFF.md` and `mailbox/*.jsonl` on `che-mailbox`, `docs/CHE_READINESS.md`, PR #524's description, git log and the current code and tests.
Nothing here was checked on the iPhone or in production. Live trading stays disabled; no order path was touched.

**Classification.**
- **FIXED:** current code plus a test proves it.
- **REGRESSION:** it worked once and broke again. Each one below is now fixed on this branch.
- **PARTIAL:** some of it works.
- **BLOCKED:** an outside dependency stops it.
- **UNVERIFIED:** no evidence either way.

**Network (recorded 2026-10-25).** This container's proxy refused every exchange host with `403` to `CONNECT`:
- REST: `api.exchange.coinbase.com`, `api.coinbase.com`, `api.kraken.com`, `api.binance.com`, `www.bitstamp.net`, `query1.finance.yahoo.com`.
- WebSocket: `ws-feed.exchange.coinbase.com`, `advanced-trade-ws.coinbase.com`, `ws.kraken.com`. `stream.binance.com:9443` reset the connection.
- Docs: `docs.kraken.com` and `docs.cdp.coinbase.com` could not be resolved.

So no real exchange capture was possible. The crypto end-to-end test uses message shapes copied from the official docs examples, and it says so in the test.

## Table

| id | area | failure | evidence / source | classification | repro | root cause | fix commit | regression test |
|---|---|---|---|---|---|---|---|---|
| M1 | Media / Film Studio | A finished Film Studio film cannot be reopened: `GET /api/media/<id>/video` answers "Media data missing", and the library calls it missing | Code reading after #508 (`0a86b70`, "CHE's own store, R2 optional"). `wrangler.jsonc` binds no R2 bucket, so production writes films to CHE's own store | REGRESSION (since #508), now FIXED | `film_studio.test.mjs` "a film finished without R2 reopens…": failed before the fix (`expected 'che_store', actual 'r2'`) | `saveFilmVideo` always recorded `blob: 'r2'`. `readBlob` reads `r2` only when a bucket is bound, otherwise it looks in `media:<id>`, which is empty | `7ed0f35` | Same test. It also covers `media_library.test.mjs` "an older film record that says r2…", so legacy records reopen without rewriting stored history |
| M2 | Media library / inventory | A video in CHE's own store (`blob: 'che_store'`) is reported "missing: the record names no file" | `media_library.js` `checkFile` and `media.js` `verifyMediaFile` had no `che_store` branch | REGRESSION (since #508), now FIXED | `media_library.test.mjs` "a video in CHE's own store…": failed before the fix (`playable expected 1, actual 0`) | The two checkers predate the store interface | `7ed0f35` | Same test |
| M3 | Media library | "Playable" was claimed when a storage key existed (R2 `head` size > 0, or any `media:<id>` value), even if the bytes were not a video | `checkFile` | PARTIAL, now FIXED | "playable needs MP4 bytes": failed before the fix (`playable expected 0, actual 1`) | A second, weaker checker existed beside `verifyMediaFile` | `7ed0f35`: the library now uses `verifyMediaFile` (reads the file back, checks the MP4 signature) | Same test |
| M4 | Media | A saved picture opened by its ID shows the right image (the owner's "open and display saved image <id>") | Lead's `0ec23ac` (`media_retrieval.test.mjs`) | FIXED | n/a | n/a | `0ec23ac` (lead) | `media_retrieval.test.mjs`. **New:** `e2e_media_artifacts.test.mjs` PNG case (saved, restarted, reopened, decoded pixel by pixel with CRCs) |
| M5 | Creation artifacts | A stored GLB must reopen intact | `creation_studio.test.mjs` (byte identity, minimal GLB); live `creation_check` 40153146586 (handoff) | FIXED | n/a | n/a | n/a | **New:** `e2e_media_artifacts.test.mjs`. The real `assets/characters/crew/che.glb` goes through the worker upload and the owner route; SHA-256 equals the receipt; parsed as glTF 2.0 (meshes, skin); vertex data lies inside the accessor bounds |
| M6 | Creation | Worker name shown as "?" | Handoff, READINESS §1 | FIXED | n/a | n/a | `541f6b4` (#524) | `creation_gaps.test.mjs:143` |
| M7 | Media / video | Gemini video refuses to run without R2; GitHub-rendered videos are GitHub artifacts that expire after 30 days | `media.js` `geminiVideo`, `media_library.js` | BLOCKED (owner choice: R2 is not bound; paid video is off) | n/a | By design: never claims a file it cannot keep | n/a | `media_library.test.mjs` "an unverifiable GitHub artifact…" |
| T1 | Crypto stream | **False LIVE:** the chart said LIVE on heartbeats alone. A silent trade channel (failed `market_trades` subscription, or a snapshot whose newest trade is minutes old) showed LIVE over old candles | `che_crypto_stream.dart` `describe` | PARTIAL, now FIXED | `che_crypto_stream_test.dart`: 3 cases failed before the fix (showed `live`) | LIVE checked any message, not trades | `62a2662`: LIVE needs a message within 10 s **and** a trade within 60 s; otherwise "STALE · Coinbase connected, no trade yet / no trade for 5m", quietly | `che_crypto_stream_test.dart` (heartbeat-only, old-trade, Kraken failover cases) |
| T2 | Crypto stream | Phone WebSocket against the real Coinbase/Kraken | PR #524 "Not verified"; READINESS | BLOCKED here (proxy 403, above) | `CHE_LIVE_SMOKE=1 flutter test test/che_crypto_stream_live_smoke_test.dart` from a network that reaches the exchanges | n/a | n/a | Live smoke test exists, skipped offline |
| T3 | Crypto candles | Tick-to-candle aggregation: out-of-order trades, duplicates on resubscribe, gaps, UTC periods, REST merge | `che_crypto_candles.dart` | FIXED | n/a | n/a | n/a | `che_crypto_candles_test.dart`, `che_crypto_stream_test.dart`, `che_trading_chart_crypto_test.dart`. **New:** `che_crypto_docs_e2e_test.dart` (doc-shaped Coinbase messages: string prices, nanosecond envelopes, subscriptions ack, heartbeats → stream → 1m/5m candles → REST merge → LIVE, then STALE; Kraken v2 status/ack/snapshot/update, numeric IDs, microseconds, re-sent snapshot) |
| T4 | Replay | Paper trade replay must not look ahead | `trading_visual.js` `replayFrame`, `che_trade_replay.dart` `cheReplayFrame` | FIXED | n/a | n/a | n/a | `e2e_trading_journal.test.mjs` (exit hidden until its bar closes; no bar after the cursor), `che_trade_replay_test.dart`, `backtestSeries` look-ahead audit (`leakageAudit`). Note: the replay's price scale uses every stored bar so it does not jump; a review aid, not a decision input |
| T5 | Strategy stats | 9 more "costs over risk" trades appeared after the cost gate (316 → 325) | Handoff 2026-10-25: "to confirm" | FIXED (explained) | Arithmetic from the two live audits: closed 1,100 → 1,109 (+9) while open fell 18 → 9 (−9). The 9 were positions opened before the gate | n/a | Gate in `strategy_sim.js` `fillOrder` (`MAX_COST_R` 0.25) | `strategy_sim.test.mjs:808` (cost gate refuses and counts) |
| T6 | Status routing | "Is the MNQ data live?" answered as a deployment check | READINESS bug 3 | FIXED (#524; routing belongs to lane R1) | n/a | n/a | #524 | `e2e_owner_status_phrases.test.mjs` (0 todo left in the baseline run) |
| T7 | Chart | Scalar collection fields crashed the chart ("int is not a subtype of List") | Handoff, ChatGPT PR #395; "Next: add chart malformed-payload regression" | FIXED (guards on main), regression test was missing | n/a | n/a | Guards already in `che_trading_chart.dart` | **New:** `che_trading_chart_malformed_test.dart` (3 accounts). Fails with the `bars` guard removed |
| T8 | Futures / MNQ freshness | MNQ is delayed research data; DELAYED older than 45 min is refused; the chart never says live for delayed bars | READINESS §2 | FIXED (labels); live data BLOCKED | n/a | n/a | n/a | `trading_live.test.mjs`, `trading_chart.test.mjs`, `trading_honesty.test.mjs`, `che_trading_chart_rithmic_test.dart`. Live CME needs Rithmic/Tradovate access (external) |
| T9 | Rithmic | Diagnose Rithmic; recording on the phone | #524; READINESS | PARTIAL: diagnostics FIXED, connection BLOCKED (API access/terms) | n/a | n/a | `72429e0` | `che_rithmic_screen_test.dart`, `rithmic_*_test.dart`, `rithmic_dataset.test.mjs` |
| T10 | Paper journal / broker | Alpaca paper fills and realized P&L; the owner's ≈ −$1,018 on 2026-09-22 is in none of CHE's ledgers | Handoff audit | UNVERIFIED (needs the live Alpaca paper account) | n/a | n/a | `72429e0` | `broker_alpaca.test.mjs`, `che_calendars.test.mjs`, `trading_audit.test.mjs` |
| T11 | Crypto stream | After a Coinbase→Kraken failover, the newest REST bar (Coinbase) is joined with Kraken's streamed close, so one bar mixes venues | `che_trading_chart.dart` `_merged` + `mergeCryptoHistory` | PARTIAL (open, low impact: one bar, during a failover only) | n/a | The merge does not check the stream venue against the REST provider | not fixed | none yet |
| S1 | Recording Studio | M4A export, MP3/M4A import, live monitoring | #524 (`tool/bootstrap.sh` native Swift) | BLOCKED (needs the new full IPA and a device). The Dart side falls back honestly (a WAV with the reason) | n/a | n/a | n/a | `che_recording_studio_test.dart`, `che_studio_engine_test.dart` |
| S2 | Recording Studio | Pitch correction on a sung voice; about 10x faster | `461a5d0` | FIXED (offline) | n/a | n/a | n/a | `che_pitch_voice_test.dart` |
| S3 | Recording Studio | Beat producer, Engineer Mode / Bring Me Back, preset recreation, vocal analysis | `892fc93` | FIXED offline; UNVERIFIED on device | n/a | n/a | n/a | `che_studio_engine_test.dart` |
| S4 | Recording Studio | Studio Tutorials lane never rebuilt | Handoff §2 | Missing work, not a defect | n/a | n/a | n/a | n/a |

## Counts
- **Inspected:** 23 items.
- **Reproduced with a failing test:** 4 (M1, M2, M3, T1).
- **Fixed:** 4, in 2 commits.
- **Regression tests added:** 13 new (7 Worker: 1 film_studio, 3 media_library, 3 e2e_media_artifacts; 6 Flutter: 1 crypto stream, 2 crypto docs e2e, 3 chart malformed) plus 2 crypto stream tests tightened.
- **Confirmed stable by current tests:** 11 (M4, M5, M6, T3, T4, T5, T6, T7, T8, S2, S3).
- **Blocked:** T2, T8 live data, T9 connection, S1, M7.
- **Unverified:** T10.
- **Open:** T11.

## Remaining, in priority order
1. **T2:** run the live smoke test (`CHE_LIVE_SMOKE=1`) from a network that reaches Coinbase and Kraken, or on the iPhone build.
2. **S1:** the new full IPA on the iPhone, then M4A export/import and monitoring on the device.
3. **T10:** read the Alpaca paper account for 2026-09-22 (read-only).
4. **T11:** do not join the newest REST bar with a different venue's stream after a failover.
5. **M7:** the owner's choice on R2. Until then, GitHub-rendered videos expire after 30 days, and the library already says "not checked" rather than playable.
