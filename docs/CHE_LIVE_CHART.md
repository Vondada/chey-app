# CHE live chart: source, states and fallback policy

Owner request, 2026-10-23 ("Live MCP Trading"): Home opens on the live chart, the live state is shown clearly, and
delayed data is never the default and never called live.

## The live source

CHE has **no MCP market-data source**. On 2026-10-23, a search of `lib/`, `server/cloudflare/` and `pubspec.yaml`
found MCP only in the resource finder (`resource_catalogs.js`, a list of public MCP servers). The live market data
is the **Rithmic feed on the iPhone** (`lib/trading/che_market_feed.dart`, #478). The chart labels it "Rithmic", never
"MCP". If a specific MCP market-data server is wanted, it has to be added as a new source.

## States (`lib/trading/che_live_status.dart`)

| State | Word | When |
|---|---|---|
| Live | LIVE | Rithmic trades are arriving now |
| Connecting | CONNECTING | connected, before the first trade of a session |
| Reconnecting | RECONNECTING | a new session over candles already on screen (they stay, marked NOT CURRENT) |
| Quiet | MARKET CLOSED / NO TRADES | connected, no trades for 90 s; MARKET CLOSED when CME futures are shut |
| Disconnected | DISCONNECTED | Rithmic not connected, login refused, or connection dropped, with the reason and the last update time |
| Delayed | DELAYED | only after the owner taps "Delayed"; detail starts "Not live" |

Each state is a word and a colour (mint live, ice connecting, amber reconnecting or delayed, silver quiet, red
disconnected). Only live, connecting and reconnecting pulse, and nothing moves with Reduce Motion. The chart never
speaks.

## Fallback policy

1. The default source is always live Rithmic. Only the timeframe is remembered (`che_live_chart_minutes`).
2. If live data is unavailable, the card says why (DISCONNECTED + reason, MARKET CLOSED + last update). It never
   switches source by itself.
3. Delayed data (the Worker's Yahoo MNQ=F chart) appears only after the owner taps **Delayed**. It is labelled DELAYED,
   in the header and in the status, and **Back to live** returns to the live chart. The choice is not remembered.
4. There is no automatic emergency fallback.

## Subscriptions (`lib/trading/che_live_feed_hub.dart`)

There is one channel per timeframe (one candle and one status subscription), shared by every screen that shows it. The
last screen to leave closes it. A Rithmic reconnect adds no subscriptions. Updates are coalesced to at most 4 per
second.
