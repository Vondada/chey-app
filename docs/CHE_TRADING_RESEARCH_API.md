# CHE Trading Research API (contract)

Owner only (paired owner device). Every number comes from recorded CHE runs. Nothing is estimated on the phone.
Fields may be added; none of the fields below are removed or renamed.

## GET /api/trading/research

```json
{
  "markets": ["MNQ", "NQ"],
  "live": {
    "symbol": "MNQ", "price": 21034.25, "as_of": "2026-10-22T14:31:00Z", "stale": false,
    "mode": "PAPER", "data_source": "Yahoo NQ=F (delayed)", "pnl_today": 0, "win_rate": null,
    "open_positions": 0,
    "regime": { "label": "Trending bullish · normal volatility", "features": { "trend": "up", "volatility": "normal", "atr_pct": 0.42 } }
  },
  "best_now": [
    { "strategy_id": "ema-pullback", "name": "EMA 20 pullback", "market": "MNQ", "timeframe": "5m", "session": "ny_morning",
      "regime": "trend_up", "evidence_score": 84, "expectancy_r": 0.31, "sample": 87, "confidence": "moderate" }
  ],
  "best_now_reason": "No strategy currently meets your threshold.",
  "strategies": [
    { "strategy_id": "ema-pullback", "name": "EMA 20 pullback", "defined": true, "best_timeframe": "5m",
      "qualified_buckets": 4, "expectancy_r": 0.31, "win_rate": 0.55, "status": "ACTIVE", "readiness": "OOS VERIFIED" }
  ],
  "dashboard": {
    "strategies_tested": 7, "buckets_qualified": 46, "backtest_trades": 2418, "forward_paper_trades": 312,
    "coverage": [ { "market": "NQ", "resolution": "1D", "first": "2000-...", "last": "2026-...", "years": 26.1, "provider": "Stooq nq.f", "proxy": false } ]
  },
  "jobs": [ { "id": "job-1", "name": "NQ historical research", "status": "running", "progress": 0.4, "completed": ["ema-pullback|5m"], "remaining": ["ema-pullback|1h"], "errors": [] } ],
  "profile": "NORMAL",
  "paper_learning": { "enabled": true, "since": "2026-10-22T13:30:00Z" }
}
```

- `best_now` may be empty. `best_now_reason` then says why, e.g. "No strategy currently meets your threshold." That is a valid result.
- `confidence` is one of `low`, `moderate` or `high`.
- `readiness` is one of LEARNING, 30+ SAMPLE, OOS VERIFIED, PAPER VERIFIED or READY FOR OWNER REVIEW.
  None of these authorize live trading.
- `status` is one of ACTIVE, MONITOR, DEPRIORITIZED or RETIRED. A strategy that cannot be tested has `defined:false` and status `UNDEFINED`.

## GET /api/trading/research/strategy?id=X&market=MNQ

```json
{
  "strategy": { "strategy_id": "...", "version": 1, "name": "...", "defined": true, "entry_rule": "...", "exit_rule": "...", "stop_rule": "...",
                "target_rule": "...", "session_filter": "...", "data_requirements": "...", "look_ahead_audit": "passed" },
  "overview": { "best_timeframe": "5m", "best_session": "ny_morning", "best_regime": "trend_up",
                "historical_expectancy_r": 0.31, "recent_expectancy_r": 0.24, "paper": { "trades": 87, "expectancy_r": 0.18 } },
  "timeframes": [ { "tf": "5m", "trades": 143, "min_required": 30, "win_rate": 0.55, "avg_r": 0.38, "pf": 1.46, "max_dd_r": 6.2,
                    "evidence": "QUALIFIED", "status": "ACTIVE", "available": true, "why": null } ],
  "sessions": [ { "session": "ny_morning", "trades": 53, "expectancy_r": 0.42 } ],
  "regimes": [ { "regime": "trend_up", "trades": 40, "expectancy_r": 0.35 } ],
  "hours": [ { "hour": 10, "trades": 31, "expectancy_r": 0.4 } ],
  "weekdays": [ { "weekday": "Tue", "trades": 30, "expectancy_r": 0.2 } ],
  "periods": [ { "window": "max", "available": true, "years_available": 7.4, "trades": 400, "expectancy_r": 0.2 } ],
  "decay": "STABLE",
  "receipts": [ { "id": "...", "timeframe": "5m", "provider": "...", "data_hash": "...", "range": ["...", "..."], "cost_model": "NORMAL", "engine_version": "...", "look_ahead": "passed" } ]
}
```

- There is one entry in `timeframes` for each of the 12 timeframes: 15s, 30s, 1m, 2m, 5m, 15m, 30m, 1h, 4h, 1D, 1W, 1M.
- When a timeframe has no legitimate data, `available` is false and `why` gives the reason.
- `evidence` takes one of these values:
  - **NOT READY:** fewer than 30 closed trades in that timeframe.
  - **QUALIFIED:** at least 30 trades and positive expectancy on the unseen (out-of-sample) part.
  - **MONITOR:** at least 30 trades but weak or negative expectancy.
  - **NO DATA**
- `periods` only lists windows the data actually covers. A window the data does not cover has `available:false` and the real `years_available`.

## GET /api/trading/research/matrix?market=MNQ

```json
{ "timeframes": ["15s","30s","1m","2m","5m","15m","30m","1h","4h","1D","1W","1M"],
  "rows": [ { "strategy_id": "...", "name": "...", "cells": { "5m": { "state": "Strong", "trades": 143, "expectancy_r": 0.38 } } } ] }
```

`state` is one of Strong, Good, Fair, Weak, Learning or No data.

## POST /api/trading/research/{action}

| action | body | effect |
|---|---|---|
| `paper_learning` | `{ "enabled": true }` | continuous deterministic paper/forward learning on or off (never live) |
| `profile` | `{ "profile": "LIGHT" \| "NORMAL" \| "DEEP" }` | resource profile |
| `run_job` | `{ "market": "NQ", "timeframes": ["5m"], "strategies": ["ema-pullback"] }` | queue a resumable research job |
| `cancel_job` | `{ "id": "job-1" }` | stop a queued or running job |

Each action responds with `{ ok, spoken, view }`, where `view` is the GET /api/trading/research body.
