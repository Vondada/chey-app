# CHE strategy governor

Owner, 2026-10-23: "Stop repeating losing trading strategies." The governor (`server/cloudflare/strategy_governor.js`) reads CHE's own journals and decides which strategies may keep trading **forward paper**. Every strategy keeps running in **simulation** (backtest, research, delayed training), so a paused idea can still prove itself again. Live broker trading is never enabled by this module; nothing here can place an order.

## How a decision is made

- **Evidence unit:** strategy × market × timeframe (each strategy version separately). The tracking breakdowns also split by session and market condition.
- **Independent trades only.** Forward paper runs each strategy in several portfolios: with and without the trend filter, and with two target sizes. One setup can therefore close as up to four trades. For statistics the governor counts one trade per setup (strategy + signal bar + side), preferring the `any` filter and the 2R target. Raw counts are still shown.
- **Pause (restricted from forward paper):** at least `min_trades` independent closed trades (default 30, `MIN_CLOSED_TRADES`), *and* the one-sided upper confidence bound of expectancy in R is below 0. The default confidence is 95% (z = 1.645). Win rate alone never decides.
- **Early pause (2026-11-05 loss audit):** before `min_trades`, a unit is also paused after `streak_pause` losses in a row (default 8), or once it has `early_trades` independent trades (default 15) and the same upper bound is already below 0. The audit found units that stayed "gathering" through 13 and 38 losses in a row.
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

Settings, stored under `gov_settings` and changeable by the owner: `min_trades` 30, `z_pause` 1.645, `z_watch` 1.0, `streak_p` 0.01, `streak_pause` 8 (bounded 4–50), `early_trades` 15 (bounded 10–500), `enabled` true.

## Trade-quality rules (forward paper)

The forward paper desks (`trading_live.js` for MNQ, `crypto_markets.js` for BTC and ETH) give every new portfolio
`params.quality` = `QUALITY_RULES` from `trading_evidence.js`. A setup is journalled as skipped ("not taken: …") when:

- a stop-out's round-trip costs would be more than 0.25 R of its risk (the strategy simulation's cost gate);
- a target hit would net less than 1 R after costs (VWAP reversion targets can sit under 1 R); or
- the same portfolio was stopped out less than 30 minutes earlier.

The rules are part of the strategy version, so results under them never mix with the journal from before
2026-10-28. At Coinbase's 0.60% taker fee no crypto stop inside the desk's 0.1%–1% band passes, so the crypto desk
records skips for costs instead of trades that lose on fees. `tools/che_quality_replay.mjs` (in
`che-strategy-backtest.yml`) replays every desk on real bars with and without the rules.

## Learned exclusions and the halt (2026-11-06)

The owner lifted the forward-paper halt of 2026-10-28 (`FORWARD_ENTRIES_HALTED = false`). At the same time CHE keeps
out of futures forward paper the setups that lost after costs in both the first 70% and the last 30% of the replay on
real MNQ bars (run 42130528712): `sweep-mss-5m`, `fvg-retest-5m`, `pdhl-sweep-5m`, `sweep-reclaim-5m`,
`vwap-revert-5m`, `rsi-revert-5m` (`LEARNED_EXCLUSIONS` in `strategy_governor.js`, each with its evidence). A refused
setup is journalled as skipped with that reason. They keep running in research and simulation; a strategy returns
only through a reviewed change backed by new out-of-sample evidence. The remaining setups (20-EMA pullback, inside
bar, opening range, silver bullet, order block) still have no proven edge after costs; the trade-quality rules and the
governor's early pauses apply to them.

One trade per signal (2026-11-06): forward paper trades only each setup's primary copy (no filter, default target,
`isPrimaryVariant` in `trading_live.js`). The trend-filter and alternative-target copies keep their portfolios and
journal a skipped setup ("one trade per signal: this copy ... stays in research"), so one stop-out is no longer
journalled and counted two or three times.

Each new forward-paper signal is filed to the owner's inbox (`signalNote` in `trading_live.js`, at most 3 per pass):
side, contract, price, stop, target and setup, marked paper and not advice. No real order is placed.

## Simulation allocation

Half of the research budget is spread evenly over every defined strategy, so none stops being simulated. The other half is split in proportion to the lower bound of each strategy's out-of-sample evidence. Better-supported ideas are researched more often. This is a research budget, not a forecast: past results do not promise future profit.

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
                 "expectancy_r_upper": -0.04, "profit_factor": 0.71, "max_drawdown_r": 9.4, "fees_usd": 164, "slippage_usd": 41, "spread_usd": 20.5, "costs_usd": 225.5, "max_consecutive_losses": 7,
                 "net_pnl": -812.5 },
      "loss_causes": { "cost_drag_r": 0.31, "losers_after_1r_in_favour": 6, "losers_immediately_against": 11, "same_bar_stop_and_target": 1,
                       "time_exits": 4, "gross_expectancy_r": 0.1 },
      "by_session": { "NY AM": { "trades": 20, "expectancy_r": -0.1 } },
      "by_regime": { "above-50d|high-vol": { "trades": 9, "expectancy_r": -0.6 } },
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

## Brain

Every governor decision is queued as a Trading-room Brain event (`room_events.queueRoomEvent`, kind `governor`). The event carries the reason, the evidence numbers and `refs.decision` / `refs.route`, so the Brain can open the log entry. Each forward-paper pass with new decisions queues one bounded `trade_decision` event, listing up to 12 lines of entered and skipped setups with their reasons; `refs.route` points to the full list. Both are status `verified`, because they restate CHE's own records.

## Hourly volatility test (owner, 2026-11-06)

The volatility-stop replay (`tools/che_volatility_replay.mjs`, run 42242981300) tried 127 setup, timeframe and stop
combinations on real MNQ bars; 5 were positive after costs in both the first 70% and the last 30% of the bars. The owner
put the two strongest on paper: inside bar and previous-day high/low sweep on 1-hour bars, with the stop at least 2 ATR(14)
away (`params.stop_atr`, `trading_evidence.widenStop`). `hourlyTick` in `trading_live.js` runs them after each
forward-paper pass, only when a new 1-hour bar can have closed. Their trades are journalled with resolution `1h`, apart
from the 5-minute desk's record, and are judged only on trades from their start. The 5-minute learned exclusions do not
apply to them (they were learned on 5-minute bars); the owner's controls, the account limits and the governor's pauses
do. Paper only: no broker order.
