# Visual trading evidence

Owner request, 2026-10-23: "I want to SEE the trades, the timeframes, the strategies and the daily P&L."

`server/cloudflare/trading_visual.js` is a read-only projection over the records CHE already keeps. It adds no engine, ledger or strategy, and it never writes or alters a trade.

## Record sets (execution types)

Each set keeps its own label, and the sets are never merged.

| Execution type | Source | Data type |
|---|---|---|
| `historical_backtest` | 5-minute research replays (`live_research_trade_chunk:*`) and `evr:backtest:*` | historical |
| `forward_paper` | forward paper journal, `evr:paper:*` at 5m on DELAYED MNQ | live-paper |
| `daily_paper` | daily evidence pass, `evr:paper:*` daily | paper |
| `simulation` | 1-minute strategy simulation, R only (no dollar amounts recorded) | paper |
| `broker_paper` | Alpaca PAPER fills, read live by the chart, not stored | broker |
| `live` | disabled: always zero | live |

## API

`GET /api/trading/visual?view=…` is owner only. Optional filters: `instrument`, `timeframe`, `strategy`, `from`, `to`, `execution_type`, `side`, `result`.

| view | Returns |
|---|---|
| `summary` | totals, leader headline, today's P&L |
| `evidence` | one row per strategy × timeframe × execution type × CME trading day. Each row has the full metrics, `complete`/`partial`, data quality, and the 30-trade daily target with the reason it was or was not reached (recorded skips). The target is never a quota. |
| `pnl` | today's forward paper P&L: realized, unrealized (marked at the last stored DELAYED bar, before exit costs), commissions, slippage, high/low, intraday curve, and the previous day. `balance` is null: the paper engine keeps none. |
| `replay` | `cursor=ISO`, `timeframe`, `instrument`. Contains only bars closed by the cursor. The frame is split into `knew`, `decided`, `executed` and `happened`. Nothing after the cursor is returned. |
| `compare` | years, YTD, last 30 days, latest session, today, weekdays and sessions, each with metrics and data-quality labels |
| `leader` | the rules, the verified leader or "No verified leader yet", and each candidate's missing evidence |
| `ranking` | ranked by the lower bound of the 95% expectancy range in R, never by win rate. Fewer than 30 trades is provisional. |
| `journal` | trades and recorded skipped signals, newest first, filtered, capped at 200 |
| `audit` | real counts by execution type: exact duplicates, entries shared across variants, look-ahead, fill mismatches, missing labels, P&L mismatches. `altered` is always 0. |

`GET /api/trading/chart?account=futures_history&symbol=NQ|MNQ&tf=…&at=ISO` returns candles from the stored research datasets.
- It carries `provenance`: data type, source, delay, coverage, gaps and checksum.
- The stored trades on that market and timeframe come back as markers.
- 15s and 30s report the honest reason they are unavailable.
- The forward futures chart now carries `provenance` too.

## Voice

These go through `/api/chat` with no model call, and through the Command Center as `trade-pnl`, `trade-leader` and `trade-audit`:
- "Show today's P&L"
- "Who is the current leader?"
- "Audit the trades"
- "Show daily evidence"
- "Expand the P&L card"
- "Make the chart full screen"
- "Compact trading dashboard"

Card commands return `open_view: trading_visual` with `visual: {card, size}` for the app.

## Trade evidence and replay (owner mission, 2026-10-23, Priority 5)

`server/cloudflare/trade_evidence.js` and `lib/trading/che_trade_replay.dart`.

- **Trade ID.** `trading_visual.tradeIdOf(naturalKey(trade))` is `T` plus 13 base-36 characters, an FNV-1a 64-bit hash of the record set, strategy variant (portfolio), market, timeframe, side and entry time. It comes from the trade itself, so it is the same after every restart and on every device; no ID table is stored.
- **One trade per ID.** A second stored record with the same natural key is never shown as another trade. `view=audit` reports it under `ids` as `duplicate` (identical) or `conflict` (same entry, different outcome). The first stored record is kept, and nothing is deleted.
- **Labels.** `BACKTEST` (historical_backtest), `SIMULATION` (simulation), `FORWARD PAPER` (forward_paper, daily_paper) and `BROKER-CONFIRMED` (broker_paper; live stays disabled).
- **API.**
  - `GET /api/trading/visual?view=trade&id=<ID|last>` returns the record, its stored bars and links. It is owner only and read only.
  - `view=trades` lists the IDs, newest first.
  - Bars come from the first stored source that contains the entry bar: the research dataset, then the forward DELAYED feed (5m), then the iPhone-recorded Rithmic minutes (1m). Sources are never mixed and nothing is filled in.
  - With none of them, the record still opens and says "No recorded market data for this trade."
- **Deep link (stable).** `/trade-replay?id=<ID>` opens `CheTradeReplayPage` (route name `trade_replay/<ID>`). The chat's `open_view: trade_replay` with `trade_id` opens it.
  - Chart markers pass their summary (`CheTradeReplayPage.route(..., summary: marker)`), so the record shows at once while the bars load.
  - `links.brain.ref` is `trade:<ID>` for the Brain.
- **Replay rule.**
  - A bar shows once it has closed (open time plus timeframe at or before the clock). The signal shows when its bar closes, the fill at the next bar open, and the exit once its bar closes.
  - At 1× the clock moves one bar per second, and `+10s` skips ten seconds of playback.
  - Controls: Play, Pause, Restart, +10s, 1×/2×/4×/8×, a scrub timeline and full screen.
  - The order status line says each fill is simulated; there is no broker order.
- **Voice.** "Replay my last trade" (CHE's newest closed forward paper trade, else its newest simulation trade, never a backtest) and "Replay trade T…". In the Command Center it is `/trade-replay`. Neither uses a model call.
