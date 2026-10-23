# CHE strategy governor

Owner, 2026-10-23: "Stop repeating losing trading strategies." The governor (`server/cloudflare/strategy_governor.js`) reads CHE's own journals and decides which strategies may keep trading **forward paper**. Every strategy keeps running in **simulation** (backtest, research, delayed training), so a paused idea can still prove itself again. Live broker trading is never enabled by this module; nothing here can place an order.

## How a decision is made

- **Evidence unit:** strategy × market × timeframe (each strategy version separately). The tracking breakdowns also split by session and market condition.
- **Independent trades only.** Forward paper runs each strategy in several portfolios: with and without the trend filter, and with two target sizes. One setup can therefore close as up to four trades. For statistics the governor counts one trade per setup (strategy + signal bar + side), preferring the `any` filter and the 2R target. Raw counts are still shown.
- **Pause (restricted from forward paper):** at least `min_trades` independent closed trades (default 30, `MIN_CLOSED_TRADES`), *and* the one-sided upper confidence bound of expectancy in R is below 0. The default confidence is 95% (z = 1.645). Win rate alone never decides.
- **Watch:** the same test fails only at a looser bound (z = 1.0), or the run of consecutive losses is longer than a strategy with its own measured win rate would produce 1 time in 100 (`streak_p`). Watch is shown and recorded, but it does not restrict trading.
- **Resume (revalidation):** a paused strategy returns to forward paper only when CHE's research shows, for that strategy, market and timeframe:
  - at least 30 out-of-sample trades with expectancy > 0;
  - at least 60% of the 4 walk-forward folds profitable;
  - the look-ahead audit passed.

  These are the existing `readinessOf` "OOS VERIFIED" rules. Forward paper results never resume a strategy by themselves, because it is paused there.
- **Look-ahead:** a decision at time T uses only trades whose exit is at or before T.
- **Overfitting:** a parameter change is a new `strategy_version` with its own evidence. It starts at "gathering" and must earn forward paper through the same revalidation.
- **Fabricated or bad fills** are excluded from the statistics and listed:
  - an entry fill further from the bar open than the spread and slippage allow;
  - a target exit better than the target;
  - a record the journal validator refuses.
- **Duplicates:** the journal is already append-only, one key per trade (`recordKey`). The governor also refuses to count two records with the same portfolio and entry time.

Settings, stored under `gov_settings` and changeable by the owner: `min_trades` 30, `z_pause` 1.645, `z_watch` 1.0, `streak_p` 0.01, `enabled` true.

## Simulation allocation

Every defined strategy keeps at least 10% of the research share. The remainder is split in proportion to the lower bound of each strategy's out-of-sample evidence. Better-supported ideas are researched more often. This is a research budget, not a forecast: past results do not promise future profit.

## API (owner-authenticated, like every `/api/trading/*` route)

`GET /api/trading/governor` returns:

```json
{
  "as_of": "2026-10-23T14:00:00.000Z",
  "settings": { "enabled": true, "min_trades": 30, "z_pause": 1.645, "z_watch": 1.0, "streak_p": 0.01 },
  "strategies": [
    {
      "strategy": "ema-pullback-5m", "name": "trend pullback to the 20 EMA", "market": "MNQ", "timeframe": "5m",
      "status": "paused | watch | active | gathering",
      "forward_paper_allowed": false,
      "reason": "Expectancy −0.21R per trade on 41 independent trades; even the optimistic 95% bound (−0.04R) is below zero.",
      "stats": { "trades": 41, "raw_trades": 118, "wins": 13, "losses": 28, "win_rate": 31.71, "avg_r": -0.21, "expectancy_r": -0.21,
                 "expectancy_r_upper": -0.04, "profit_factor": 0.71, "max_drawdown_r": 9.4, "fees_usd": 225.5, "max_consecutive_losses": 7,
                 "net_pnl": -812.5 },
      "loss_causes": { "cost_drag_r": 0.31, "losers_after_1r_in_favour": 6, "losers_immediately_against": 11, "same_bar_stop_and_target": 1,
                       "time_exits": 4, "gross_expectancy_r": 0.1 },
      "by_session": { "NY AM": { "trades": 20, "expectancy_r": -0.1 } },
      "by_condition": { "uptrend|high-vol": { "trades": 9, "expectancy_r": -0.6 } },
      "revalidation": { "required": "30+ out-of-sample trades with expectancy > 0, ≥60% profitable walk-forward folds, look-ahead audit passed", "met": false, "research": { "oos_trades": 190, "oos_expectancy_r": -0.2, "folds_positive": 1, "folds_total": 4, "look_ahead": "passed" } }
    }
  ],
  "recurring_losses": [ { "strategy": "vwap-revert-5m", "session": "NY AM", "condition": "downtrend|high-vol", "side": "long", "trades": 14, "expectancy_r": -0.7, "pattern": "long against a downtrend" } ],
  "repeated_mistakes": [ { "kind": "reversed after 1R in favour", "count": 23, "share_of_losses": 0.21 } ],
  "allocation": [ { "strategy": "sweep-mss-5m", "share": 0.14, "basis": "lower bound of out-of-sample expectancy" } ],
  "excluded": [ { "key": "evr:paper:…", "problems": ["entry fill further from the bar open than costs allow"] } ],
  "comparison": [ { "strategy": "ema-pullback-5m", "name": "…", "research": { "trades": 541, "expectancy_r": -0.139, "oos_trades": 315, "oos_expectancy_r": -0.051 }, "forward": { "trades": 41, "expectancy_r": -0.21 } } ],
  "live_trading": "disabled: the governor never enables broker orders"
}
```

`GET /api/trading/governor/decisions?limit=100` returns the append-only decision log, newest first:

```json
{ "decisions": [ { "id": "gd:2026-10-23T14:00:00.000Z:ema-pullback-5m|MNQ|5m", "at": "…", "strategy": "ema-pullback-5m", "market": "MNQ", "timeframe": "5m",
  "action": "pause | resume | watch | clear-watch | modify | reject", "by": "governor | owner", "reason": "…", "evidence": { "stats": { }, "revalidation": { } } } ] }
```

`GET /api/trading/governor/trades?strategy=ema-pullback-5m&limit=50` returns why each candidate was taken or skipped, newest first, merged from each portfolio's `signals` (taken) and `skips` (skipped, with the exact gate):

```json
{ "items": [ { "time": "…", "strategy": "…", "portfolio": "…", "side": "long", "decision": "taken | skipped", "why": "…" } ] }
```

`POST /api/trading/governor` with `{ "action": "settings", "settings": { "z_pause": 1.96 } }` changes the settings, and `{ "action": "resume" | "pause", "strategy": "…", "market": "MNQ", "timeframe": "5m", "reason": "…" }` records an owner override. An owner resume is logged as `by: "owner"`. The governor re-pauses at the next run if the evidence still says so, and logs that too.

The governor runs inside the forward paper tick (`trading_live.liveTick`), before entries are allowed. A paused strategy's setups are journalled as skipped with the reason `the strategy governor paused it from forward paper: …`.
