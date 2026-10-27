# CHE live BTC and ETH chart streaming

Market data only. Nothing in this path can place, change or cancel an order, and live trading stays off.

## What it does
On the Trading Room **Markets** chart, `coinbase:BTC-USD`, `coinbase:ETH-USD` and the Kraken BTC/ETH USD pairs stream
real trades straight from the exchange's public WebSocket to the iPhone. Trades are built into candles on the phone
and laid over the Worker's polled REST candles (`/api/trading/chart`), so the chart is never empty and the newest
candle moves tick by tick. Other coins and futures stay on the polled chart.

| File | Role |
|---|---|
| `lib/trading/che_crypto_candles.dart` | Pure trade → OHLCV aggregator (1m, 5m, 15m, 1h, 1d by exchange time, duplicate trade ids ignored, out-of-order trades placed correctly, gaps stay gaps) and the REST/stream merge. |
| `lib/trading/che_crypto_stream.dart` | WebSocket client (dart:io), wire parsing, heartbeat watchdog, backoff with jitter, resubscribe, Coinbase → Kraken failover, status model, shared per-product hub. |
| `lib/rooms/che_trading_chart.dart` | Opens the stream for BTC/ETH only, merges candles, shows the status line. |

## Why the phone connects directly
The exchanges' market-data channels need no account or key, so the phone connects itself: no Worker CPU, no
Durable Object, no secrets. The existing server-side `ManagedMarketStream` (server/cloudflare/market_feed.js) stays
for server use; this is not a second copy of it.

## Status line (visible, VoiceOver labelled, never spoken by itself)
- **LIVE**: a trade or heartbeat arrived within 10 s. Shows the venue and the last trade's age.
- **STALE**: connected but silent beyond 10 s, with the silence age. At 30 s the socket is closed and reopened.
- **DELAYED**: not streaming; the chart shows the Worker's REST candles, named by provider, plus the retry countdown.
- **DISCONNECTED**: not streaming and no REST candles, with the reason.

"Read chart" includes the line only when the owner asks. Ticks never speak and never force a screen-reader
announcement (owner rule, October 11, 2026).

## Honesty rules
- Only real trades make streamed candles; tests use format fixtures in `test/fixtures/crypto_stream`, labelled as
  made-up values.
- Venues are never mixed in one candle. After a failover the new venue's candles are drawn over the REST history.
- Finished REST candles are kept as the exchange published them. Only the newest REST candle (usually forming when it
  was fetched) is joined with the streamed one: REST open, wider high/low, streamed close, larger volume (a lower
  bound, never a sum).

## Protocol sources (checked 2026-10-25)
- Coinbase Advanced Trade WebSocket channels: https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-channels
- Coinbase WebSocket overview: https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-overview
- Coinbase AsyncAPI spec: https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/advanced-trade-asyncapi.json
- Coinbase's client `coinbase-advanced-py` 1.8.4 (PyPI): endpoint, channel names and subscribe message shape.
- Kraken WebSocket v2 trade channel: https://docs.kraken.com/api/docs/websocket-v2/trade
- Kraken WebSocket v2 overview: https://docs.kraken.com/websockets-v2

## Tests
```
flutter test test/che_crypto_candles_test.dart test/che_crypto_stream_test.dart test/che_trading_chart_crypto_test.dart
CHE_LIVE_SMOKE=1 flutter test test/che_crypto_stream_live_smoke_test.dart   # real network, about 40 s
```
Widget tests never open a real socket: under `flutter test` the chart's default hub is off and tests pass a fake one.
