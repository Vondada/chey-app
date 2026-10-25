# CHE Trading Strategy V3: Strategy Matrix, research and smart paper selection

Owner request "TRADING ROOM V3", items 5, 6 and 7 (2026-10-25). **Paper and research only.** Live trading is
disabled, no broker execution exists in any of this, and nothing here can place an order or spend money. Past
results do not promise future profit.

## What was built

| Piece | Where | What it does |
| --- | --- | --- |
| Four new written strategies | `server/cloudflare/trading_evidence.js` `V3_CANDIDATES` | Trend breakout and retest, momentum continuation, range rejection, volatility contraction then expansion. Same entry contract and the same costed engine (`stepPortfolio`) as `INTRADAY_CANDIDATES`. |
| Strategy Matrix research | `server/cloudflare/strategy_matrix.js` | Every strategy × market × timeframe: rolling walk-forward, out-of-sample result after costs, hours, regimes, look-ahead audit, confidence, one sentence built from the numbers. |
| Research runner | `tools/che_strategy_matrix.mjs`, `.github/workflows/che-crypto-backtest.yml` (job `matrix`), `.github/workflows/che-strategy-backtest.yml` (job `strategy-matrix`) | Fetches real public bars on a GitHub runner (this Worker's sandbox cannot reach exchanges or Yahoo), runs the research, uploads JSON, and on a manual run with `commit_results=true` commits the results module with its run id. |
| Committed results | `server/cloudflare/strategy_matrix_crypto.js`, `server/cloudflare/strategy_matrix_futures.js` | Written only by the runner; `export default null` means no real run yet. |
| Smart paper selection | `server/cloudflare/paper_selection.js` | Ranking, written demotion rules, paper priority, session rules, exposure caps, duplicate prevention, decision log. Gates Orion's crypto paper pass (`crypto_markets.cryptoTick`) and the futures forward-paper pass (`trading_live.js`). |
| Route | `GET /api/trading/strategy-matrix` (owner only; optional `?market=BTC`) | The matrix view: groups with run id, coverage and freshness; cost models; strategies with exact rules; ranked rows; paper limits; recent selection decisions. `live` is always `"disabled"`. |
| Voice | `strategy_matrix.strategyMatrixIntent` (chat route `che_strategy_matrix`, checked before the crypto desk), Command Center `/trade-strategy-matrix` | "What's the best strategy for BTC?", "Which strategy works best on MNQ?", "Best strategy for crypto", "Explain the EMA 20 pullback", "Read the strategy matrix". No model call. "Which strategy works best on which timeframe" stays with the timeframe matrix. |
| Phone widget | `lib/rooms/che_strategy_matrix.dart` `CheStrategyMatrix` | Expandable rows with VoiceOver labels carrying the numbers, large text, Read aloud only when chosen (silent on open), market filter, voice-route buttons. Icons only from `test/fixtures/release_icons.txt`. The room integrator places it. |

Why the new strategies are not in `trading_lab.js`: `trading_lab.STRATEGIES` is the long-only, cost-free daily set
(R multiples only). The costed, both-sides intraday set that the crypto and futures research and paper loops run is
`trading_evidence`; the V3 strategies extend that one, never a second engine. They sit in their own registry
(`V3_CANDIDATES`) so the futures live-paper grid, its 120 KB research record and the owner's per-strategy controls
keep exactly the strategies they had (adding four there pushed the live research record past its size bound in
tests). Orion's crypto paper desk keeps its current twelve portfolios per series for the same storage reason (one
128 KB Durable Object value per coin and timeframe); the V3 strategies are research-only on the paper desks until the
portfolio storage is split.

## The strategies (exact rules are in each row and in the route's `strategies`)

| Owner name | Engine id | Notes |
| --- | --- | --- |
| EMA 20 pullback | `ema-pullback-5m` (existing) | 20 EMA over a rising 50 EMA; touch and close back on the trend side. |
| VWAP reversion | `vwap-revert-5m` (existing) | Session VWAP from 18:00 New York with 2σ bands, target VWAP. Run only when at least 90% of bars carry real volume; otherwise "not applicable". |
| Liquidity sweep and reclaim | `sweep-reclaim-5m` (existing) | Trades through the last confirmed swing and closes back beyond it and the prior bar. |
| Opening range breakout | `orb-15m` (existing) | Futures: 09:30–09:45 New York range (RTH open), entries 09:45–11:30. Crypto: the same New York cash-open window every calendar day including weekends (the busiest US hour; documented choice). 5- and 15-minute bars only; on hourly bars it is "not applicable". |
| Trend breakout and retest | `breakout-retest-5m` (new) | Close beyond the prior 20-bar high/low, then within 10 bars a retest within 0.25 ATR that closes back beyond the level. |
| Momentum continuation | `momentum-cont-5m` (new) | With the EMA trend, a displacement bar (body ≥ 1.5 ATR, close in its outer quarter) followed by a close beyond it. |
| Range rejection | `range-reject-5m` (new) | Only when the 20-bar efficiency ratio ≤ 0.25; rejection of the outer 10% of the 20-bar range; target the midpoint. |
| Volatility contraction / expansion | `vol-squeeze-5m` (new) | Bollinger(20, 2σ) width in its narrowest 10% of 100 bars, then a close outside the band with true range ≥ 1.2 ATR; stop at the band middle. |

All strategies: signal on a closed bar, market entry at the next bar's open after costs, stop checked before target
inside a bar, flat by 16:55 New York (the engine's daily cutoff, applied to crypto too so every market is measured
the same way), one position per portfolio.

## Cost model (stated per market, stored with every result)

- **MNQ**: 1 tick spread (0.25 pt = $0.50, half per side), 1 tick slippage on market orders and stops, $1.50
  commission + $0.50 exchange/NFA fees per side; about $5.50 per round turn. (CHE's NORMAL profile.)
- **NQ**: same ticks (0.25 pt = $5), $1.50 commission + $1.40 exchange/NFA fees per side; about $20.80 per round turn.
- **BTC**: Coinbase Exchange lowest published tier, 0.60% taker on entries, stops and time exits, 0.40% maker on
  targets, $1 spread and $2 slippage per side (per coin). Size 0.01 BTC.
- **ETH**: 0.60% taker / 0.40% maker, $0.10 spread and $0.10 slippage per side. Size 0.25 ETH.

Planning numbers, not a broker statement. Each row also shows the expectancy **before** costs ("Gross R") so the
cost drag is visible.

## Method

- **Walk-forward, out-of-sample**: the bars are cut into 8 equal slices; each window trains on 3 consecutive slices
  and tests on the next 1, then moves forward one slice (5 test windows). The only parameter, the target (1.5R, 2R or
  3R), is chosen on each window's training trades only (highest expectancy with at least 10 trades, else 2R). A
  training trade must close before the test window starts (purged), so train and test never overlap. The
  out-of-sample result is every test window's trades under the target chosen before that window.
- **No look-ahead**: indicators read bar i and earlier bars only; the look-ahead audit (`leakageAudit`) reruns each
  strategy with later bars removed and rewritten and requires identical earlier trades; the rewrite-the-future test
  in `trading_lab.test.mjs` now covers every intraday strategy including the V3 ones.
- **Sessions**: crypto bars are 24/7 including weekends; futures bars exist only in CME Globex hours (Sunday 18:00 to
  Friday 17:00 New York, daily 17:00–18:00 break). Futures trades across a contract roll (or inside the 50-bar warm-up
  after it) are excluded (`trading_research.rollGuard`).
- **Hours**: best and worst New York entry hour over the full period at 2R, hours with at least 8 trades.
- **Regimes**: volatility regime (low / normal / high ATR against its own last 200 values, `classifyRegimes`) at each
  out-of-sample signal; stability = share of regimes with at least 8 trades that are positive.
- **Confidence**: insufficient sample (< 30 out-of-sample trades); high (≥ 100 trades, 95% lower bound of expectancy
  > 0, ≥ 60% of windows profitable, audit passed, positive in ≥ 2/3 of regimes); moderate (positive expectancy, ≥ 50% of
  windows profitable); otherwise low.

## Smart selection for paper (item 7)

**Ranking** (`paper_selection.rankStrategies`), out-of-sample and after costs only:
net expectancy in R (40 points), profit factor (10), risk-adjusted return as the t-statistic of the mean R (10),
drawdown (−10), win rate measured against the break-even win rate its reward:risk needs (10), sample size (10),
stability across volatility regimes (10), recent out-of-sample result (±5). Win rate alone earns nothing. Rows with
positive expectancy always rank above rows without it. Tiers: **ranked** → **insufficient sample** (never ranked or
promoted) → **demoted** → **not applicable**. Paper priority 1 is the best supported.

**Demotion rules** (a row takes no new paper entry when one holds):
1. the look-ahead audit failed;
2. ≥ 30 out-of-sample trades and the 95% upper bound of expectancy (R, after costs) is below zero;
3. ≥ 30 out-of-sample trades and an out-of-sample drawdown deeper than max(15R, 0.1R × trades). The first real run
   showed a fixed 15R limit demoting a 321-trade NQ 5-minute row with positive expectancy for the length of its record,
   so the limit was scaled with the sample on 2026-10-25 (recorded here, not hidden);
4. ≥ 20 forward-paper trades and their 95% upper bound of expectancy below zero (applied in the matrix view; at run
   time the strategy governor's existing forward-paper pause covers losing paper units).
A small sample never demotes and never promotes.

**Paper gate** (`selectionGate`), on every new paper signal, in order, each decision logged with its reason
(`paper_selection_log`, newest 300, shown in the route's `selection_log`):
- session: crypto continues around the clock including weekends, and only on LIVE (fresh, verified) Coinbase bars
  (the crypto desk's existing feed rule); futures pause outside CME hours (`trading_clock.js` plus the CME holiday
  calendar);
- demoted rows are refused;
- duplicates: the same strategy never enters twice on the same market and bar;
- exposure caps: at most 2 open paper positions per market and 4 in total (crypto desk);
- then the existing owner controls and strategy governor.
Best-supported portfolios are stepped first, so they get the capacity when the caps bind. The futures forward-paper
grid keeps its isolated variants (trend filter on/off, 1.5R/2R/3R) and its own account limits in `trading_controls.js`,
so for it the gate applies the session pause and demotion only (no cap, no de-duplication across its variants).
Tests assert that the selection code imports no order, broker or network module and runs with `fetch` disabled.

## Data coverage (real runs, 2026-10-25)

Crypto, GitHub run [40191015468](https://github.com/Vondada/chey-app/actions/runs/40191015468), commit 67367925,
Coinbase Exchange public candles (no account), 24/7:

| Series | From | To | Bars | Missing |
| --- | --- | --- | ---: | ---: |
| BTC-USD 5m | 2026-07-27 11:55 UTC | 2026-10-25 11:50 UTC | 25,920 | 0 |
| BTC-USD 15m | 2025-10-24 23:45 UTC | 2026-10-25 11:30 UTC | 35,040 | 48 |
| BTC-USD 1h | 2023-10-26 01:00 UTC | 2026-10-25 10:00 UTC | 26,280 | 10 |
| ETH-USD 5m | 2026-07-27 11:55 UTC | 2026-10-25 11:50 UTC | 25,920 | 0 |
| ETH-USD 15m | 2025-10-24 23:45 UTC | 2026-10-25 11:30 UTC | 35,040 | 48 |
| ETH-USD 1h | 2023-10-26 01:00 UTC | 2026-10-25 10:00 UTC | 26,280 | 10 |

Futures, GitHub run [40191017025](https://github.com/Vondada/chey-app/actions/runs/40191017025), commit 67367925,
Yahoo Finance MNQ=F / NQ=F (public, **delayed**, continuous front month, unadjusted; Yahoo serves about 59 days of 5-
and 15-minute bars and about 729 days of hourly bars), CME hours only:

| Series | From | To | Bars | Missing (open CME slots) | Rolls in range |
| --- | --- | --- | ---: | ---: | --- |
| MNQ 5m | 2026-08-17 | 2026-10-23 | 13,320 | 361 | 2026-09-10 |
| MNQ 15m | 2026-08-17 | 2026-10-23 | 4,461 | 100 | 2026-09-10 |
| MNQ 1h | 2024-06-04 | 2026-10-23 | 13,649 | 539 | 10 quarterly rolls |
| NQ 5m | 2026-08-17 | 2026-10-23 | 13,320 | 361 | 2026-09-10 |
| NQ 15m | 2026-08-17 | 2026-10-23 | 4,461 | 100 | 2026-09-10 |
| NQ 1h | 2024-06-04 | 2026-10-23 | 13,609 | 575 | 10 quarterly rolls |

There is no free intraday futures history older than these windows in CHE: Rithmic in CHE is live-only (no history
plant), Tradovate history requests are not implemented, and Yahoo limits the depth. 5- and 15-minute futures results
therefore cover about two months only.

## Results (generated from the committed results; tiers by the rules above)

### Crypto — run 40191015468

**Verdict: no strategy is profitable on BTC or ETH after Coinbase retail costs.** Every tested crypto row with 30+
out-of-sample trades is demoted by rule 2 (the whole 95% range of expectancy is below zero). The reason is
structural: the engine's crypto risk band keeps stops between 0.1% and 1% of price, while a market round trip costs
about 1.2% in taker fees alone, so costs exceed the risk on almost every trade. Before costs ("Gross R") the rows sit
near zero; the largest pre-cost results are small (for example ETH 5m opening range breakout 0.274R on 59 trades, BTC
15m VWAP reversion 0.147R on 552), not evidence of a tradable edge. Win rates "after costs" are near zero because a
target hit still loses money after fees.

| Market | TF | Strategy | Tier (paper priority) | Tested | OOS trades | Win % after costs | Avg win | Avg loss | Net P&L | Exp. R (95% range) | Gross R | PF | Max DD | Best / worst NY hour | Folds + | Confidence |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---|---|---|
| BTC | 1h | Momentum continuation | insufficient sample (16) | 19 | 16 | 25.0 | $5.31 | $14.31 | $-151 | -1.254 (-1.924 to -0.583) | 0.301 | 0.12 | 21.5R | — / — | 0/5 | insufficient sample |
| ETH | 1h | Momentum continuation | insufficient sample (24) | 2 | 2 | 0.0 | $0.00 | $10.01 | $-20 | -1.751 (-2.259 to -1.244) | -0.450 | 0 | 3.5R | — / — | 0/5 | insufficient sample |
| BTC | 15m | Range rejection | demoted | 1660 | 1043 | 0.6 | $3.43 | $8.02 | $-8297 | -5.036 (-5.215 to -4.858) | 0.050 | 0 | 5252.8R | 10 AM / 7 AM | 0/5 | low |
| ETH | 15m | Range rejection | demoted | 1521 | 990 | 0.8 | $1.94 | $6.11 | $-5984 | -4.114 (-4.274 to -3.955) | -0.033 | 0 | 4073.1R | 12 PM / 3 AM | 0/5 | low |
| ETH | 15m | EMA 20 pullback | demoted | 1414 | 986 | 3.6 | $1.13 | $6.34 | $-5984 | -4.163 (-4.335 to -3.992) | 0.033 | 0.01 | 4105.0R | 10 AM / 8 PM | 0/5 | low |
| BTC | 15m | EMA 20 pullback | demoted | 1344 | 858 | 2.7 | $1.91 | $8.50 | $-7054 | -4.846 (-5.051 to -4.641) | 0.017 | 0.01 | 4158.1R | 9 AM / 5 AM | 0/5 | low |
| BTC | 1h | Range rejection | demoted | 1091 | 701 | 4.3 | $2.65 | $11.07 | $-7347 | -2.716 (-2.861 to -2.571) | -0.037 | 0.01 | 1904.4R | 10 AM / 12 AM | 0/5 | low |
| BTC | 1h | EMA 20 pullback | demoted | 1109 | 694 | 9.8 | $3.41 | $11.80 | $-7153 | -3.042 (-3.227 to -2.858) | 0.022 | 0.03 | 2111.2R | 10 AM / 1 AM | 0/5 | low |
| ETH | 5m | Range rejection | demoted | 1001 | 650 | 0.0 | $0.00 | $6.93 | $-4501 | -6.041 (-6.262 to -5.820) | 0.035 | 0 | 3926.6R | 10 AM / 3 PM | 0/5 | low |
| ETH | 5m | EMA 20 pullback | demoted | 822 | 591 | 0.5 | $1.07 | $7.36 | $-4326 | -5.998 (-6.252 to -5.743) | -0.038 | 0 | 3544.7R | 10 AM / 7 PM | 0/5 | low |
| BTC | 5m | Range rejection | demoted | 877 | 581 | 0.0 | $0.00 | $9.00 | $-5228 | -6.869 (-7.103 to -6.635) | -0.043 | 0 | 3990.9R | 10 AM / 5 AM | 0/5 | low |
| BTC | 15m | Liquidity sweep and reclaim | demoted | 912 | 580 | 2.9 | $1.84 | $8.61 | $-4817 | -4.862 (-5.111 to -4.613) | -0.037 | 0.01 | 2819.9R | 10 AM / 11 PM | 0/5 | low |
| ETH | 15m | VWAP reversion | demoted | 895 | 565 | 4.6 | $1.74 | $6.44 | $-3425 | -3.840 (-4.058 to -3.621) | 0.060 | 0.01 | 2169.3R | 10 AM / 9 PM | 0/5 | low |
| ETH | 15m | Liquidity sweep and reclaim | demoted | 865 | 565 | 3.2 | $1.06 | $6.43 | $-3498 | -3.867 (-4.079 to -3.656) | -0.012 | 0.01 | 2184.9R | 1 PM / 5 AM | 0/5 | low |
| ETH | 1h | EMA 20 pullback | demoted | 938 | 564 | 13.8 | $4.50 | $10.08 | $-4550 | -2.508 (-2.678 to -2.337) | -0.047 | 0.07 | 1415.8R | 11 AM / 12 AM | 0/5 | low |
| BTC | 15m | VWAP reversion | demoted | 922 | 552 | 3.1 | $1.07 | $8.14 | $-4339 | -4.709 (-4.964 to -4.454) | 0.147 | 0 | 2599.3R | 1 PM / 12 AM | 0/5 | low |
| ETH | 1h | Range rejection | demoted | 803 | 453 | 10.2 | $2.72 | $9.15 | $-3600 | -2.080 (-2.233 to -1.926) | -0.020 | 0.03 | 942.3R | 11 AM / 1 AM | 0/5 | low |
| BTC | 5m | EMA 20 pullback | demoted | 633 | 445 | 0.2 | $0.75 | $9.27 | $-4114 | -6.681 (-6.972 to -6.391) | -0.038 | 0 | 2973.2R | 9 AM / 7 PM | 0/5 | low |
| BTC | 15m | Trend breakout and retest | demoted | 661 | 427 | 0.7 | $2.69 | $8.20 | $-3469 | -5.386 (-5.680 to -5.093) | -0.020 | 0 | 2300.0R | 10 AM / 12 AM | 0/5 | low |
| ETH | 15m | Trend breakout and retest | demoted | 673 | 406 | 3.5 | $1.86 | $6.56 | $-2545 | -4.888 (-5.194 to -4.582) | -0.025 | 0.01 | 1984.7R | 10 AM / 4 AM | 0/5 | low |
| BTC | 1h | Trend breakout and retest | demoted | 577 | 397 | 5.3 | $1.37 | $10.95 | $-4090 | -3.557 (-3.804 to -3.310) | -0.076 | 0.01 | 1412.3R | 11 AM / 1 AM | 0/5 | low |
| BTC | 1h | VWAP reversion | demoted | 603 | 394 | 3.8 | $2.60 | $10.22 | $-3836 | -3.278 (-3.508 to -3.048) | 0.092 | 0.01 | 1291.5R | 2 PM / 8 AM | 0/5 | low |
| BTC | 1h | Liquidity sweep and reclaim | demoted | 567 | 394 | 7.4 | $2.28 | $11.50 | $-4133 | -2.828 (-3.034 to -2.622) | 0.003 | 0.02 | 1114.7R | 7 PM / 4 PM | 0/5 | low |
| ETH | 5m | Liquidity sweep and reclaim | demoted | 560 | 387 | 0.5 | $0.89 | $7.11 | $-2736 | -5.831 (-6.141 to -5.522) | 0.067 | 0 | 2256.7R | 10 AM / 8 PM | 0/5 | low |
| BTC | 5m | Liquidity sweep and reclaim | demoted | 486 | 332 | 0.0 | $0.00 | $9.40 | $-3120 | -6.579 (-6.907 to -6.252) | -0.022 | 0 | 2184.3R | 9 AM / 9 PM | 0/5 | low |
| ETH | 1h | Trend breakout and retest | demoted | 487 | 287 | 15.3 | $4.00 | $9.88 | $-2224 | -2.779 (-3.049 to -2.510) | -0.007 | 0.07 | 797.7R | 11 AM / 5 AM | 0/5 | low |
| ETH | 5m | VWAP reversion | demoted | 424 | 275 | 2.5 | $2.36 | $7.50 | $-1995 | -5.305 (-5.683 to -4.927) | 0.027 | 0.01 | 1458.8R | 10 AM / 6 AM | 0/5 | low |
| ETH | 1h | VWAP reversion | demoted | 444 | 263 | 8.8 | $3.97 | $8.82 | $-2025 | -2.223 (-2.448 to -1.997) | 0.110 | 0.04 | 584.5R | 10 AM / 7 AM | 0/5 | low |
| ETH | 1h | Liquidity sweep and reclaim | demoted | 444 | 263 | 16.7 | $5.39 | $9.74 | $-1895 | -2.144 (-2.385 to -1.903) | 0.132 | 0.11 | 563.9R | 7 PM / 7 AM | 0/5 | low |
| ETH | 15m | Volatility contraction and expansion | demoted | 370 | 251 | 4.8 | $1.28 | $6.19 | $-1465 | -3.029 (-3.301 to -2.756) | 0.124 | 0.01 | 760.2R | 4 AM / 5 AM | 0/5 | low |
| BTC | 15m | Volatility contraction and expansion | demoted | 390 | 250 | 3.2 | $2.26 | $9.06 | $-2174 | -3.934 (-4.238 to -3.631) | -0.089 | 0.01 | 983.6R | 4 AM / 2 AM | 0/5 | low |
| BTC | 5m | VWAP reversion | demoted | 364 | 242 | 1.2 | $2.11 | $9.48 | $-2259 | -6.308 (-6.738 to -5.879) | -0.037 | 0 | 1526.6R | 10 AM / 2 AM | 0/5 | low |
| ETH | 5m | Trend breakout and retest | demoted | 353 | 237 | 0.4 | $2.09 | $7.13 | $-1682 | -6.720 (-7.106 to -6.335) | 0.072 | 0 | 1592.7R | 10 AM / 8 PM | 0/5 | low |
| BTC | 15m | Opening range breakout | demoted | 340 | 224 | 5.4 | $2.65 | $8.72 | $-1816 | -3.716 (-4.105 to -3.328) | 0.053 | 0.02 | 832.5R | 11 AM / 10 AM | 0/5 | low |
| ETH | 15m | Opening range breakout | demoted | 301 | 205 | 12.2 | $2.90 | $6.86 | $-1162 | -3.341 (-3.750 to -2.931) | 0.163 | 0.06 | 684.8R | 11 AM / 10 AM | 0/5 | low |
| BTC | 5m | Trend breakout and retest | demoted | 263 | 172 | 0.0 | $0.00 | $9.09 | $-1563 | -7.245 (-7.702 to -6.788) | 0.054 | 0 | 1246.1R | 10 AM / 6 PM | 0/5 | low |
| BTC | 1h | Volatility contraction and expansion | demoted | 232 | 156 | 8.3 | $2.81 | $11.68 | $-1633 | -2.353 (-2.605 to -2.101) | -0.032 | 0.02 | 367.7R | 7 PM / 9 PM | 0/5 | low |
| ETH | 5m | Volatility contraction and expansion | demoted | 227 | 138 | 2.2 | $1.08 | $7.51 | $-1011 | -5.429 (-5.922 to -4.936) | 0.004 | 0 | 749.2R | 4 AM / 8 AM | 0/5 | low |
| BTC | 5m | Volatility contraction and expansion | demoted | 215 | 137 | 0.0 | $0.00 | $9.24 | $-1266 | -6.292 (-6.778 to -5.806) | -0.049 | 0 | 862.0R | 4 AM / 12 AM | 0/5 | low |
| ETH | 1h | Volatility contraction and expansion | demoted | 151 | 86 | 19.8 | $1.74 | $10.37 | $-686 | -1.797 (-2.086 to -1.508) | 0.039 | 0.04 | 155.4R | 1 PM / 12 PM | 0/5 | low |
| BTC | 15m | Momentum continuation | demoted | 125 | 83 | 16.9 | $3.25 | $10.57 | $-684 | -2.497 (-2.991 to -2.003) | 0.008 | 0.06 | 208.9R | 10 PM / 2 AM | 0/5 | low |
| BTC | 5m | Momentum continuation | demoted | 151 | 82 | 2.4 | $3.94 | $10.07 | $-797 | -3.961 (-4.505 to -3.416) | -0.089 | 0.01 | 324.8R | 10 AM / 2 AM | 0/5 | low |
| ETH | 5m | Momentum continuation | demoted | 134 | 78 | 11.5 | $3.63 | $9.07 | $-594 | -3.584 (-4.160 to -3.007) | -0.014 | 0.05 | 279.5R | 4 PM / 7 PM | 0/5 | low |
| ETH | 5m | Opening range breakout | demoted | 95 | 59 | 15.3 | $2.98 | $8.08 | $-377 | -3.330 (-4.127 to -2.534) | 0.274 | 0.07 | 197.0R | 9 AM / 11 AM | 0/5 | low |
| BTC | 5m | Opening range breakout | demoted | 90 | 56 | 10.7 | $1.73 | $10.62 | $-521 | -3.620 (-4.339 to -2.901) | 0.033 | 0.02 | 202.7R | 10 AM / 9 AM | 0/5 | low |
| ETH | 15m | Momentum continuation | demoted | 56 | 41 | 31.7 | $2.72 | $8.33 | $-198 | -1.702 (-2.309 to -1.095) | 0.242 | 0.15 | 75.4R | — / — | 1/5 | low |
| BTC | 1h | Opening range breakout | not applicable | — | — | — | — | — | — | — | — | — | — | — | — | Opening range breakout is defined on 5m and 15m bars only: a 1h bar is longer than the 15-minute opening range |
| ETH | 1h | Opening range breakout | not applicable | — | — | — | — | — | — | — | — | — | — | — | — | Opening range breakout is defined on 5m and 15m bars only: a 1h bar is longer than the 15-minute opening range |

### Futures — run 40191017025

**Verdict: the best-supported futures strategy is trend breakout and retest on hourly bars** (MNQ: 180 out-of-sample
trades, 0.170R per trade after costs, profit factor 1.39, 5 of 5 walk-forward windows profitable; NQ: 181 trades,
0.146R, profit factor 1.33, 3 of 5). Confidence is **moderate, not high**: the 95% range of expectancy still includes
zero for both, and MNQ and NQ track the same index, so they are not independent confirmation. Breakout and retest is
also positive on 15-minute bars (0.100R MNQ, 0.092R NQ, about 90 trades each). NQ 5-minute EMA 20 pullback (321
trades, 0.123R) and NQ 5-minute volatility contraction/expansion (65 trades, 0.164R) are positive but rest on about two
months of 5-minute data. VWAP reversion and range rejection are negative on most series; opening range breakout and
momentum continuation have too few trades to judge.

| Market | TF | Strategy | Tier (paper priority) | Tested | OOS trades | Win % after costs | Avg win | Avg loss | Net P&L | Exp. R (95% range) | Gross R | PF | Max DD | Best / worst NY hour | Folds + | Confidence |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---|---|---|
| MNQ | 1h | Trend breakout and retest | ranked (1) | 269 | 180 | 51.1 | $93.45 | $70.49 | $2394 | 0.170 (-0.016 to 0.355) | 0.270 | 1.39 | 7.2R | 3 AM / 8 PM | 5/5 | moderate |
| NQ | 1h | Trend breakout and retest | ranked (2) | 278 | 181 | 44.8 | $1054.66 | $642.00 | $21228 | 0.146 (-0.050 to 0.343) | 0.183 | 1.33 | 11.7R | 7 AM / 3 PM | 3/5 | moderate |
| NQ | 5m | Volatility contraction and expansion | ranked (3) | 123 | 65 | 30.8 | $2231.54 | $655.62 | $15128 | 0.164 (-0.277 to 0.606) | 0.201 | 1.51 | 10.9R | 6 PM / 7 AM | 3/5 | moderate |
| NQ | 5m | EMA 20 pullback | ranked (4) | 522 | 321 | 37.7 | $1100.81 | $520.40 | $29118 | 0.123 (-0.049 to 0.294) | 0.172 | 1.28 | 16.3R | 7 PM / 5 AM | 4/5 | moderate |
| MNQ | 15m | Trend breakout and retest | ranked (5) | 142 | 85 | 37.6 | $148.73 | $61.38 | $1507 | 0.100 (-0.248 to 0.448) | 0.217 | 1.46 | 11.0R | 11 PM / 7 PM | 4/5 | moderate |
| NQ | 15m | Trend breakout and retest | ranked (6) | 151 | 91 | 38.5 | $1214.06 | $546.96 | $11862 | 0.092 (-0.223 to 0.407) | 0.139 | 1.39 | 10.6R | 12 AM / 11 AM | 3/5 | moderate |
| NQ | 1h | Liquidity sweep and reclaim | ranked (7) | 150 | 93 | 41.9 | $1216.51 | $796.82 | $4416 | 0.057 (-0.208 to 0.323) | 0.084 | 1.1 | 12.9R | 7 AM / 8 AM | 4/5 | moderate |
| MNQ | 1h | Liquidity sweep and reclaim | ranked (8) | 132 | 81 | 44.4 | $113.22 | $83.64 | $312 | 0.037 (-0.241 to 0.314) | 0.110 | 1.08 | 12.2R | 5 AM / 1 AM | 2/5 | low |
| MNQ | 15m | Liquidity sweep and reclaim | ranked (9) | 103 | 64 | 34.4 | $149.33 | $77.98 | $10 | -0.031 (-0.396 to 0.334) | 0.052 | 1 | 12.4R | 8 PM / 3 AM | 3/5 | low |
| NQ | 15m | Liquidity sweep and reclaim | ranked (10) | 102 | 71 | 38.0 | $1098.09 | $736.71 | $-2767 | -0.030 (-0.323 to 0.262) | 0.000 | 0.91 | 9.5R | 8 PM / — | 3/5 | low |
| NQ | 15m | EMA 20 pullback | ranked (11) | 152 | 84 | 39.3 | $1038.06 | $679.28 | $-387 | -0.001 (-0.284 to 0.281) | 0.032 | 0.99 | 13.1R | 4 AM / 7 AM | 3/5 | low |
| MNQ | 15m | EMA 20 pullback | ranked (12) | 153 | 88 | 42.0 | $97.24 | $74.06 | $-179 | -0.012 (-0.278 to 0.254) | 0.078 | 0.95 | 11.6R | 4 AM / 7 AM | 3/5 | low |
| NQ | 15m | Volatility contraction and expansion | insufficient sample (13) | 32 | 20 | 40.0 | $1662.61 | $989.05 | $1432 | 0.224 (-0.494 to 0.941) | 0.246 | 1.12 | 5.1R | — / — | 2/5 | insufficient sample |
| MNQ | 15m | Volatility contraction and expansion | insufficient sample (14) | 29 | 18 | 44.4 | $148.75 | $98.99 | $200 | 0.162 (-0.493 to 0.816) | 0.222 | 1.2 | 3.2R | — / — | 3/5 | insufficient sample |
| MNQ | 5m | Momentum continuation | insufficient sample (15) | 28 | 17 | 29.4 | $164.20 | $92.67 | $-291 | -0.060 (-0.883 to 0.762) | 0.008 | 0.74 | 8.5R | — / — | 1/5 | insufficient sample |
| NQ | 5m | Momentum continuation | insufficient sample (17) | 29 | 16 | 31.3 | $1743.20 | $911.71 | $-1313 | 0.049 (-0.822 to 0.920) | 0.073 | 0.87 | 7.1R | — / — | 1/5 | insufficient sample |
| MNQ | 1h | Volatility contraction and expansion | insufficient sample (18) | 24 | 11 | 45.5 | $166.18 | $96.27 | $253 | 0.286 (-0.580 to 1.153) | 0.338 | 1.44 | 3.2R | — / — | 2/5 | insufficient sample |
| NQ | 1h | Volatility contraction and expansion | insufficient sample (19) | 23 | 9 | 44.4 | $1623.23 | $960.85 | $1689 | 0.243 (-0.636 to 1.121) | 0.260 | 1.35 | 2.0R | — / — | 2/5 | insufficient sample |
| MNQ | 5m | Opening range breakout | insufficient sample (20) | 10 | 5 | 40.0 | $155.75 | $97.83 | $18 | 0.122 (-1.297 to 1.542) | 0.186 | 1.06 | 3.2R | — / — | 2/5 | insufficient sample |
| MNQ | 15m | Opening range breakout | insufficient sample (21) | 7 | 5 | 40.0 | $193.00 | $98.33 | $91 | 0.136 (-1.299 to 1.571) | 0.192 | 1.31 | 3.2R | — / — | 2/5 | insufficient sample |
| NQ | 5m | Opening range breakout | insufficient sample (22) | 11 | 5 | 40.0 | $1581.70 | $1048.30 | $19 | 0.168 (-1.258 to 1.594) | 0.189 | 1.01 | 3.1R | — / — | 2/5 | insufficient sample |
| NQ | 15m | Opening range breakout | insufficient sample (23) | 6 | 4 | 50.0 | $1954.20 | $975.80 | $1957 | 0.466 (-1.218 to 2.150) | 0.485 | 2 | 2.0R | — / — | 2/5 | insufficient sample |
| MNQ | 15m | Momentum continuation | insufficient sample (25) | 4 | 1 | 0.0 | $0.00 | $118.00 | $-118 | -1.049 (-1.049 to -1.049) | -1.000 | 0 | 1.0R | — / — | 0/5 | insufficient sample |
| NQ | 15m | Momentum continuation | insufficient sample (26) | 3 | 1 | 0.0 | $0.00 | $1125.80 | $-1126 | -1.019 (-1.019 to -1.019) | -1.000 | 0 | 1.0R | — / — | 0/5 | insufficient sample |
| MNQ | 1h | Momentum continuation | insufficient sample (27) | 1 | 0 | — | $0.00 | $0.00 | $0 | 0.000 (0.000 to 0.000) | — | — | 0.0R | — / — | 0/5 | insufficient sample |
| NQ | 1h | Momentum continuation | insufficient sample (28) | 1 | 0 | — | $0.00 | $0.00 | $0 | 0.000 (0.000 to 0.000) | — | — | 0.0R | — / — | 0/5 | insufficient sample |
| MNQ | 5m | Range rejection | demoted | 766 | 462 | 46.8 | $36.81 | $46.62 | $-3516 | -0.187 (-0.289 to -0.086) | -0.043 | 0.69 | 91.3R | 11 AM / 12 AM | 0/5 | low |
| NQ | 5m | Range rejection | demoted | 768 | 458 | 48.9 | $402.21 | $455.82 | $-16568 | -0.075 (-0.180 to 0.030) | -0.024 | 0.84 | 48.9R | 11 AM / 12 AM | 1/5 | low |
| MNQ | 5m | EMA 20 pullback | demoted | 538 | 312 | 34.3 | $121.37 | $55.00 | $1712 | -0.032 (-0.209 to 0.145) | 0.103 | 1.15 | 34.8R | 1 PM / 5 AM | 3/5 | low |
| NQ | 5m | Liquidity sweep and reclaim | demoted | 398 | 244 | 33.2 | $973.37 | $532.82 | $-8008 | -0.136 (-0.303 to 0.032) | -0.089 | 0.91 | 35.8R | 4 AM / 1 AM | 3/5 | low |
| MNQ | 5m | Liquidity sweep and reclaim | demoted | 375 | 233 | 30.0 | $113.51 | $58.67 | $-1619 | -0.184 (-0.378 to 0.009) | -0.062 | 0.83 | 50.2R | 4 AM / 6 AM | 2/5 | low |
| MNQ | 5m | Trend breakout and retest | demoted | 390 | 223 | 26.0 | $110.29 | $47.16 | $-1385 | -0.132 (-0.366 to 0.102) | 0.048 | 0.82 | 49.0R | 12 AM / 3 PM | 2/5 | low |
| NQ | 5m | Trend breakout and retest | demoted | 373 | 221 | 27.1 | $1119.95 | $435.24 | $-2877 | 0.041 (-0.201 to 0.282) | 0.107 | 0.96 | 31.5R | 5 AM / 3 PM | 2/5 | low |
| MNQ | 5m | VWAP reversion | demoted | 321 | 199 | 24.6 | $139.73 | $51.99 | $-952 | -0.194 (-0.465 to 0.077) | -0.051 | 0.88 | 45.9R | 1 AM / 12 AM | 3/5 | low |
| NQ | 5m | VWAP reversion | demoted | 298 | 186 | 23.7 | $1298.04 | $479.32 | $-10950 | -0.089 (-0.445 to 0.267) | -0.035 | 0.84 | 44.8R | 3 AM / 12 AM | 2/5 | low |
| MNQ | 1h | EMA 20 pullback | demoted | 295 | 176 | 26.7 | $181.81 | $85.20 | $-2446 | -0.179 (-0.420 to 0.061) | -0.099 | 0.78 | 42.5R | 5 AM / 12 AM | 1/5 | low |
| NQ | 1h | EMA 20 pullback | demoted | 299 | 176 | 27.8 | $1733.18 | $800.84 | $-16781 | -0.148 (-0.375 to 0.080) | -0.119 | 0.84 | 33.2R | 9 PM / 12 AM | 2/5 | low |
| MNQ | 1h | Range rejection | demoted | 224 | 146 | 31.5 | $131.82 | $83.56 | $-2292 | -0.195 (-0.427 to 0.037) | -0.122 | 0.73 | 39.4R | 1 AM / 9 PM | 1/5 | low |
| NQ | 1h | Range rejection | demoted | 222 | 141 | 32.6 | $1417.33 | $792.06 | $-10049 | -0.071 (-0.327 to 0.184) | -0.044 | 0.87 | 25.1R | 1 AM / 9 PM | 3/5 | low |
| MNQ | 1h | VWAP reversion | demoted | 164 | 101 | 29.7 | $90.22 | $71.18 | $-2347 | -0.412 (-0.637 to -0.188) | -0.323 | 0.54 | 44.7R | 12 PM / 3 PM | 0/5 | low |
| MNQ | 15m | Range rejection | demoted | 170 | 95 | 46.3 | $92.84 | $73.10 | $357 | 0.158 (-0.353 to 0.669) | 0.247 | 1.1 | 23.1R | 6 AM / 10 PM | 2/5 | low |
| NQ | 15m | Range rejection | demoted | 168 | 94 | 44.7 | $970.29 | $688.11 | $4970 | 0.174 (-0.329 to 0.678) | 0.207 | 1.14 | 22.3R | 6 AM / 6 PM | 2/5 | low |
| NQ | 1h | VWAP reversion | demoted | 139 | 84 | 29.8 | $797.23 | $688.77 | $-20706 | -0.378 (-0.612 to -0.144) | -0.346 | 0.49 | 34.8R | 12 PM / 3 PM | 0/5 | low |
| MNQ | 15m | VWAP reversion | demoted | 129 | 76 | 25.0 | $156.60 | $70.45 | $-1040 | -0.126 (-0.642 to 0.391) | -0.023 | 0.74 | 16.9R | 2 AM / 11 PM | 1/5 | low |
| NQ | 15m | VWAP reversion | demoted | 120 | 71 | 22.5 | $1276.98 | $723.71 | $-19372 | -0.367 (-0.703 to -0.031) | -0.332 | 0.51 | 29.3R | 9 PM / 12 AM | 1/5 | low |
| MNQ | 5m | Volatility contraction and expansion | demoted | 118 | 67 | 28.4 | $169.72 | $71.10 | $-188 | -0.118 (-0.495 to 0.260) | -0.026 | 0.94 | 16.1R | 6 PM / 7 AM | 2/5 | low |
| MNQ | 1h | Opening range breakout | not applicable | — | — | — | — | — | — | — | — | — | — | — | — | Opening range breakout is defined on 5m and 15m bars only: a 1h bar is longer than the 15-minute opening range |
| NQ | 1h | Opening range breakout | not applicable | — | — | — | — | — | — | — | — | — | — | — | — | Opening range breakout is defined on 5m and 15m bars only: a 1h bar is longer than the 15-minute opening range |

Net P&L and expectancy in R can disagree in sign on a row (for example NQ 5m breakout and retest): R weights every
trade by its own risk, dollars do not.

## How to refresh

Run either workflow manually on a branch with `commit_results=true` (crypto also takes `matrix_days`, default
`5m=90,15m=365,1h=1095`). The runner commits `strategy_matrix_crypto.js` / `strategy_matrix_futures.js` with the run id;
the route, the voice answers and the paper plan read the new numbers on the next deploy. Pull requests that touch the
research files run the same job informationally (shorter crypto history) without committing.

## Limitations

- Delayed public data; no tick data, no order-book data; fills are modelled (next open, ticks of slippage).
- 5- and 15-minute futures history is about two months (Yahoo's limit); hourly futures about 2.4 years.
- The crypto risk band (0.1–1% stops) with retail taker fees makes every crypto setup lose by construction. A wider
  crypto stop band or maker-only entries would be a new strategy version and must be researched before any paper use;
  nothing is changed silently.
- The V3 strategies are research-only on the paper desks until the paper-portfolio storage is split (see above).
- One parameter (target R) is optimised per window; the rules themselves were written once, before the first run, and
  were not tuned to these results. The drawdown demotion limit was rescaled after the first run, as recorded above.
- Live trading is disabled and stays disabled until the owner separately approves it and it is verified.
