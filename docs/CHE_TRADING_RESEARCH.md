# CHE trading research: multi-timeframe evidence

`server/cloudflare/trading_research.js` is one layer over CHE's existing trading engine. It is not a second engine.
- API contract: `docs/CHE_TRADING_RESEARCH_API.md`.
- Tests: `trading_research.test.mjs`. The fixture is seeded and labelled TEST FIXTURE; it is never market data.

## What existed, and what each part became

| Existing | Role now |
|---|---|
| `trading_evidence.js` | **The executor**, unchanged. It covers: <ul><li>next-bar-open fills, spread, slippage, commission and fees</li><li>stop checked before target inside a bar</li><li>`summarize` and `evaluateWalkForward`</li><li>the written strategy rules (`INTRADAY_CANDIDATES`, `CANDIDATES`)</li></ul> One rule was added with explicit rules: `inside-bar-5m`. |
| `historical_intelligence.js` | Supplies the leakage audit (`leakageAudit`) and the dataset hashing (`sha256Hex`, `canonicalBars`). Its daily MNQ/NQ/NDX study remains as is. |
| `backtest_matrix.js` | Its `resample` and `calendarBars` are reused for upward aggregation. Its `/api/trading/matrix` study remains. |
| `trading_live.js` | Forward paper (PAPER mode), with real-time gates and controls. "Paper learning" switches it on or off (`setLivePaper`). |
| `trading_delayed_training.js`, `strategy_sim.js` | Their journals are kept as they are. They are not merged into BACKTEST evidence. |
| `trading_controls.js` | Risk gates on every paper fill; unchanged. |
| `market_feed.js` | Yahoo chart parsing (`parseYahooChart`). The newest 5-minute feed bars come from `live_paper_feed`. |
| Workflow Engine (#462) | Research replies (`che_trading_research`) are recorded under the built-in **Trading desk** workflow. |

## Data: what is real and reachable

| Resolution | Source | Real depth |
|---|---|---|
| 15s, 30s | **none** | No reachable source (see below). Never synthesized. Owner-supplied licensed exports can be imported with full provenance (`importDataset`). |
| 1m | Yahoo `MNQ=F` / `NQ=F` (public, delayed) | about 7 days |
| 2m, 5m, 15m, 30m | Yahoo | about 60 days |
| 1h | Yahoo `60m` | about 730 days |
| 4h | built from 1h, anchored to the CME day (18:00 New York) | about 2 years |
| 1D | Yahoo `period1=0` (and Stooq `nq.f` via the existing study) | NQ: as far back as the public series goes. MNQ: from its launch, 2019-05-06, only. |
| 1W, 1M | built from 1D | same as 1D |

- **Rithmic:** CHE's Rithmic connection is the iPhone's ticker plant (live last trade and best bid/offer). It has no history plant, so it gives **no historical bars**.
- **Tradovate:** streaming quotes only; historical chart requests are not implemented.
- **Twenty-year coverage:** only daily, weekly and monthly can reach 20+ years (NQ futures; `^NDX` only as a labelled proxy). No intraday resolution has 20 years from any free source.
- **Proxy data:** `^NDX` is accepted only when explicitly asked for, and is labelled `PROXY:` in every manifest. It is never reported as MNQ or NQ.
- **Provenance:** every dataset manifest records:
  - provider and symbol
  - contract and continuous method
  - resolution
  - first and last actual timestamps, and the bar count
  - time zone
  - missing bars, counted inside open CME hours using the computed CME holiday calendar
  - roll method and adjustment
  - confidence and SHA-256
  - the series it was derived from, if any

## Timeframes, rolls and sessions
- **Timeframes:** one canonical list: 15s, 30s, 1m, 2m, 5m, 15m, 30m, 1h, 4h, 1D, 1W, 1M.
  - `aggregateBars` builds upward only. A downward request throws, and so does a bucket that is not a whole number of base bars.
  - A bucket counts only when every open slot of it was received and it has ended.
- **Rolls:** quarterly expiries (third Friday) roll 8 days earlier. Unadjusted front-month series keep the jump. The research excludes, and counts, every trade open across a roll and every trade signalled inside the 50-bar warm-up after one. `backAdjust` builds additive back-adjusted series from individual contracts when those exist.
- **Sessions:** New York time from the time-zone database, so DST is handled. The sessions are:
  - Globex overnight
  - London / pre-NY
  - NY pre-open
  - NY open
  - NY morning
  - NY lunch
  - NY afternoon
  - NY close
  - after hours
  - the CME break

  Hour and weekday are tracked too.

## Evidence
- **Buckets:** strategy × market × timeframe × mode (BACKTEST / FORWARD_SIM / PAPER, never mixed), with session, regime, volatility, hour and weekday breakdowns. A bucket counts only from **30 closed trades**; the 30 is per bucket, never a total across timeframes.
- **Walk-forward:** the first 40% is training. The rest is cut into 4 anchored folds, and only those folds are out-of-sample. Rolling windows are reported separately.
- **Metrics:** expectancy, median R, profit factor, win rate, max drawdown, Sharpe-/Sortino-like ratios, worst losing streak, tail loss, 95% CI and Monte Carlo ranges (seeded resampling).
- **Robustness:** a stress-cost rerun, plus target sensitivity (1.5/2/3R) in the DEEP profile.
- **Costs:** OPTIMISTIC, NORMAL (the default, the evidence engine's COSTS) and STRESS.
- **Regimes:** deterministic and causal. The labels are trend_up, trend_down, breakout, range and mixed, from EMA 20/50, the slope of the 50 and the efficiency ratio. Volatility comes from ATR(14)/close percentiles.
- **States:**
  - Per timeframe: NOT READY (fewer than 30), QUALIFIED (out-of-sample expectancy above 0 on at least 15 OOS trades, look-ahead passed), MONITOR, NO DATA, N/A (rules not defined for that timeframe).
  - Matrix cells: Strong, Good, Fair, Weak, Learning, No data.
  - Readiness: LEARNING → 30+ SAMPLE → OOS VERIFIED → PAPER VERIFIED → READY FOR OWNER REVIEW. **None of these authorizes live trading.**
  - Strategy status: ACTIVE, MONITOR, DEPRIORITIZED (losing out-of-sample everywhere, still re-tested) and RETIRED (only by the owner).
  - Decay: IMPROVING, STABLE, WEAKENING or INSUFFICIENT DATA.

## Selection
- **Score:** a composite evidence score from 0 to 100, built from:
  - out-of-sample expectancy
  - profit factor
  - drawdown penalty
  - sample size
  - fold stability
  - recent results and decay
  - CI
  - stress costs
  - session fit and regime fit
  - paper results

  **Win rate is not in the score.**
- **NO TRADE:** returned when data is stale, when nothing qualifies, or when the score is under the owner's threshold (default 50).
- **Champion and challengers:** kept per market | timeframe | session | regime, with a history of changes.
- **Trade candidate loop:** freshness (two bars plus 90 seconds) → session → regime → qualified strategies → signal on the newest closed bar → risk check. Delayed feeds are stale by design.
- **Multi-timeframe context:** `closedHigherBar` never reads an unfinished candle.
- **Portfolio limits:** `portfolioSim` enforces concurrent positions, open risk and daily loss.

## Jobs and compute
- **Jobs:** under-tested units first, with a checkpoint after every unit and resume after interruption.
- **Evidence cache:** keyed by dataset hash + strategy version + cost model + engine version, so unchanged units never rerun.
- **Profiles:** LIGHT runs no batches. NORMAL has an 8-second budget per alarm. DEEP has 20 seconds plus sensitivity runs.
- **Scheduling:** the alarm wakes only while a job is queued; there is no polling. A daily refresh is queued in NORMAL and DEEP.
- **Measured:** one 15-second unit over 55,200 fixture bars took 4.2 s (including the leakage audit on the newest 6,000 bars). That fits inside one alarm step, so no external compute is needed for any data CHE can actually obtain.

## Not done
- No intraday history beyond the free provider limits. 20-year 15s/1m studies need a licensed data export.
- Tradovate and Rithmic history are not implemented.
- FORWARD_SIM buckets use the existing delayed-training journal; no new forward simulator was added.
