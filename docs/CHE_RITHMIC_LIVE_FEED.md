# Rithmic live feed, chart candles and forward recorder (2026-10-23)

## What it does
- The Rithmic screen hands its connected, read-only market-data feed to one shared session, `lib/rithmic/rithmic_live.dart`. The session outlives the screen; pressing Disconnect ends it.
- `lib/rithmic/rithmic_candles.dart` builds 1- and 5-minute OHLCV candles from real trades only.
  - A minute with no trades has no candle.
  - Out-of-order trades land in their own minute.
  - The subscription's snapshot replay and non-trade updates are skipped.
- `lib/trading/che_market_feed.dart` is the API that trading engines consume:
  - forming candles, and each closed candle exactly once (after its period plus a 2 s grace);
  - last price, source label, connection status, last update and recorded gaps.
- Trading Room → MNQ PAPER draws Rithmic candles from the first one on.
  - Earlier Worker bars (Yahoo, DELAYED) stay, drawn dimmer and labelled delayed.
  - 5-minute history is never stretched into the 1-minute chart.
  - The header shows the source, the connection status, the last trade, the last update and the background note.
- The forward recorder, `lib/rithmic/rithmic_recorder.dart`:
  - keeps trades and best bid/offer in day files on the phone, 50 MB total, oldest days first to go;
  - queues each closed 1-minute candle (with buy/sell aggressor volume and delta) and sends it to the Worker;
  - the Worker stores the candles in `server/cloudflare/rithmic_dataset.js` (`/api/trading/rithmic/candles`): self-consistent candles only, the first version of a minute wins, 120 days kept.
- Credentials never leave the phone. Orders are untouched; futures entries stay blocked by the Worker.

## Field numbers
These come from the public LastTrade and BestBidOffer schemas at the same pinned commit the template-version fix used, rundef/async_rithmic@a985931ed1fb608d416ddf23ad92d789102bef47:

| Field | Number |
|---|---|
| trade_size | 100178 |
| aggressor (1 = buy, 2 = sell) | 112003 |
| is_snapshot | 110121 |
| presence_bits (bit 1 = trade) | 149138 |
| ssboe / usecs | 150100 / 150101 |
| source_ssboe / source_usecs (exchange time, preferred) | 150400 / 150401 |
| bid_size / ask_size | 100030 / 100031 |

The earlier fields 159008/159000/159002 (described as 64-bit sizes) are absent from both public copies. They are kept only as fallbacks. The owner's licensed Rithmic kit is not in this workspace.

## Background: verified vs inferred
- **Verified in code:**
  - The Rithmic socket is opened by the app on the iPhone (`RithmicClient`, `dart:io` WebSocket).
  - The Worker cannot hold it, because the password stays in the on-device vault.
  - The app declares only the `audio` and `fetch` background modes (`tool/bootstrap.sh`).
  - Before this change, nothing reconnected or marked the pause.
- **Inferred from iOS behaviour, not measured on the owner's iPhone:**
  - iOS suspends an app shortly after it leaves the screen unless a declared background mode is active (audio actually playing).
  - So the socket stops delivering, and it is usually closed by the time CHE returns.
- **What the app does now:**
  - Every background stretch and every dropped connection is a recorded gap.
  - The chart and the feed say "Live feed pauses when CHE is in the background."
  - A gap is never filled with Yahoo or anything labelled Rithmic.
  - After a drop, the owner reconnects from the Rithmic screen; there is no automatic reconnect yet.
- **Not verified here:** live ticks on the owner's iPhone, entitlement for MNQ on the owner's Rithmic system, and whether this gateway sends the aggressor and exchange-time fields. The owner can confirm all three only on the device.
