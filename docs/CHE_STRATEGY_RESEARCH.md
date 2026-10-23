# CHE strategy research and comparison (lane T8, 2026-10-23)

The owner's request: stop limiting CHE to the same familiar strategies. Research publicly documented NQ/MNQ
strategies, test the eligible ones on the same historical periods with realistic costs, compare in-sample with
out-of-sample results, and say which work under which conditions only where the evidence supports it.

This builds on the existing systems and adds no second one:

| Piece | Where |
|---|---|
| Registry, lifecycle stages, counts, approval gate | `strategy_library.js` (lane T5) |
| Researched entries and their citations | `library_seeds/research.js` (this lane) |
| Executed rules | `trading_evidence.js` `RESEARCH_INTRADAY_CANDIDATES`, `RESEARCH_DAILY_CANDIDATES` |
| Backtests, walk-forward, out-of-sample, Monte Carlo, look-ahead audit | `trading_research.js` `evaluateUnit` and the research jobs |
| Contract specs, costs, hours and holidays in one place | `trading_market_spec.js` |
| Same-dataset comparison, condition and event breakdowns, order-flow readiness, data sources | `strategy_research.js` |
| Phone page | `lib/rooms/che_strategy_compare.dart` (Trading → Research → Compare) |

## What was researched (sources accessed 2026-10-23)

Implemented (written rules the engine executes). Every parameter a source does not publish is listed as CHE's
choice in the library entry:

- **First 5-minute candle breakout**: Zarattini & Aziz, SSRN 4416622. The stop and 10R target wording comes from an
  independent replication, which reports the paper's gross result reproduced and its net result near zero after
  spread and slippage.
- **Initial balance breakout**: the balance is the Market Profile first hour; the trade rule is CHE's.
- **TTM-style volatility squeeze**: an approximation. Its direction comes from the 20-bar average, not Carter's
  histogram.
- **Supertrend (10, 3) flip**: the TA-Lib definition.
- **RSI(2) pullback (Connors)**: daily. The exit is approximated as a target at the 5-day average; the stop is CHE's.
- **20-day breakout (Turtle System 1 entry)**: daily. Only the entry and the 2N stop are the Turtle rules.

Rules documented, not implemented, with the reason each is not running:

- The value-area 80% rule needs a value-area calculation.
- SMT divergence needs ES bars, which are not acquired.
- Asia range → London sweep → New York reversal needs its windows chosen.
- The Larry Williams volatility breakout: the multiplier is not found in a primary source.
- Regular-session gap fill: no source gives the entry timing or the stop.
- Delta divergence and absorption need the aggressor side of every trade (being recorded from Rithmic; see
  below).
- Stacked imbalances need volume at every price. CHE does not have it.
- VIX/VXN regime is a market-context model, not a trigger; no VIX or VXN series is acquired.

Discovered only, no testable definition: Judas swing, breaker block, mitigation block, inverse FVG (no definition
found). ICT 2022 and AMD / Power of Three are T5's seeds; the P2P 86 model is T6's.

## How strategies are compared

- **One dataset.** Only results on the same dataset (sha256) are compared; anything else is listed as excluded.
- **Costs.** Costs and fills are exactly the engine's: `GET /api/trading/research/spec` shows them, and a test
  proves the spec equals what `settleTrade` charges.
  - MNQ at NORMAL costs is $5.50 a round trip (2.75 points) on a stop or time exit.
  - A target is a limit order and pays no slippage.
- **In-sample vs out-of-sample.** Anchored walk-forward folds from `evaluateUnit`; in-sample plus out-of-sample
  always equals all trades.
- **Verdicts (after costs).**
  - Under 30 trades: "insufficient evidence (n trades; 30 needed)".
  - Otherwise, from the 95% interval of R per trade: positive, negative, or "not distinguishable from zero".
- **Overfit warnings.**
  - No out-of-sample trades.
  - Under 15 out-of-sample trades.
  - Positive in-sample but not out-of-sample.
  - Out-of-sample result under half of in-sample.
- **Multiple comparisons.** Every comparison says that the best of many in-sample results is partly luck.
- **Conditions.** Session, market structure and volatility regime. A "best" strategy is named only when it has 30
  trades in that condition and an interval above zero.
- **Event days.** These come from a `tagsByDay` calendar supplied by the market-context lane. Until one is
  connected, the comparison says so.

## Data

- **History.** Research history is Yahoo Finance: delayed, with 5-minute bars about 59 days deep.
- **No free minute history found.** No free, licence-compatible full-history NQ/MNQ minute data was found
  (`DATA_SOURCE_FINDINGS`):
  - Databento gives $125 of free credits, but needs an account and its terms accepted.
  - FirstRate Data and Barchart are paid.
  - MarketParquet's free tier is 30 days, and its terms were not read.
  - Nothing is signed up for or bought without the owner.
- **Order flow.**
  - Order-flow strategies become backtestable after 20 recorded Rithmic sessions.
  - `GET /api/trading/research/order-flow` counts recorded sessions from MNQ 1-minute bars whose provider is
    Rithmic and that carry a numeric `delta`.
  - The recorder (lane T1) must store bars that way, or this count stays at 0.

## Counts

Counts from the code alone (no stored evidence), with this lane merged on T5's library:

| | Count |
|---|---|
| Named strategies | 54 |
| Market-context models | 2 |
| Implemented | 38 |
| Rules documented | 10 |
| Discovered | 6 |

Backtested, forward-tested and paper-active counts come only from production evidence:
`GET /api/trading/library/audit` and the library view. The six research strategies are backtested by the daily
research job after deploy. They never paper trade on their own: they are not in the live paper grid, the owner's
controls or the selector.

## Not done

- Chart signal overlays per strategy in the comparison: stored research trades keep times and R, not prices.
- Real-data comparison numbers: Yahoo was unreachable from the build machine, so there are none here; they appear
  after the production research job runs.
- Forward paper for research strategies: it needs the owner's approval path; not wired.
