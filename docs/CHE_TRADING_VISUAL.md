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
