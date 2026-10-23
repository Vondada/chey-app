# Orion's crypto desk: BTC and ETH, 24/7 research and paper trading

Owner master mission, 2026-10-23, Phases 5–7 and Test A: *"Have Orion research BTC and ETH, compare strategies, and continue paper trading during the weekend."*

**Paper only.** No exchange account, API key, transfer, leverage or order path exists.

## 1. Audit before building (main at 50d96ea)

Line numbers are as of 50d96ea.

| Area | What exists | State |
|---|---|---|
| Evidence engine | `server/cloudflare/trading_evidence.js`: fills at the next open (`fillEntry` :49), stops before targets (`exitOn` :73), costs (`settleTrade` :93), 12 intraday strategies (`INTRADAY_CANDIDATES` :452), isolated portfolios (`newPortfolio` :648, `stepPortfolio` :687), validated append-only journal (`appendTrades` :1011). Contracts are MNQ/NQ only (:7), with a fixed 6–60 index-point risk band (:328). | DONE for futures. MISSING for crypto: no crypto contract, percentage fees or price-relative risk band. |
| Forward paper | `trading_live.js` `liveTick` :174 runs on the Durable Object alarm (`worker.js` `tradingTick` :4380). It is MNQ-only (`ROOT = 'MNQ'` :32), and the CME session gates it (`nextLiveTickAt` :124). | DONE for MNQ. |
| Research, walk-forward and OOS | `trading_research.js`: timeframe engine, evidence buckets, `researchStep` :872, champion/challenger :669–729. `evaluateWalkForward` is in `trading_evidence.js` :947. | DONE for NQ/MNQ, reused here. |
| Continuous paper learning | `trading_live.js` `strategyLearning` :555, plus delayed training. | DONE for MNQ. |
| Strategy governor (#484) | `strategy_governor.js` judges units of `strategy|contract|timeframe` (:349). It read `readTrades(isForward)` (:338) and looked up costs in `CONTRACTS` only (:48). | DONE. It is market-aware by key, but its cost lookup knew no crypto contract. |
| Signal Mode (#480) | Setup engine, progress board and trade alerts, on MNQ data. | DONE, futures only. |
| Paper account (#482) | `claude/che-paper-account`, open PR: a Rithmic-priced $100 account. | OPEN, futures only, not touched here. |
| Trade replay (#490) | `trade_evidence.js`: trade IDs and replay from stored bars. | DONE, futures journal. |
| Market feeds | Rithmic live, on the iPhone only (`lib/trading/che_market_feed.dart`). Tradovate/Yahoo for CME (`market_feed.js` `loadIntraday` :111). Alpaca stocks, delayed or IEX. `markets.js`: CoinGecko crypto quotes (:104) and Stooq. | DONE for futures and stocks. Crypto had quotes only. |
| Existing crypto | `strategy_sim.js` :47–55 simulates BTCUSDT/ETHUSDT on **Binance** 1-minute candles (`trading_lab.js` :96). It uses its own 10 long-only `trading_lab` rules, 0.1% fees and its own ledger, outside the forward journal and the governor. Binance.com refuses US-region requests (HTTP 451), so this feed may not answer the Worker; whether it does in production was not verified here. | PARTIAL: a separate simulation, not forward paper. |
| Gold weekend substitution | No code substitutes gold for crypto. `trading_lab.js` :43 only maps the word "gold" to `xauusd` for daily Stooq research. | None found. |
| Cron / `scheduled()` | `worker.js` :15811 runs `nightly()` and `modelWatch()` once a day (`wrangler.jsonc` `crons: ["7 7 * * *"]`). Market work runs on the Durable Object **alarm**, not the cron: `wakeTimes` :4408 and `alarm()` → `tradingTick`. The paper work makes no paid model call. | DONE. Crypto joins the alarm; no new cron trigger is added. |

## 2. What this change adds

This is the same engine, journal and governor with a crypto feed. There is no second engine.

- **Contracts** (`trading_evidence.js`):
  - `CRYPTO_CONTRACTS` holds BTC and ETH: tick $0.01, one dollar per point, quantity in coins.
  - A crypto setup's stop must be **0.1% to 1%** of the entry price. The futures 6–60 point band is unchanged.
  - Crypto costs may carry `takerPct` and `makerPct`, charged on traded value: taker on the entry, stop and time exits, maker on a resting target.
  - Futures costs and strategy versions are byte-identical; a test pins this.
- **One journal, kept apart:**
  - Crypto trades are written by the same `appendTrades` with `market: 'crypto'`.
  - `readTrades` returns futures records by default, so every existing MNQ view is unchanged. `{ market: 'crypto' }` returns crypto only, and `{ market: 'all' }` returns both.
  - The governor reads all markets and judges each `strategy|BTC|5m` unit on its own.
- **Feed** (`crypto_markets.js`):
  - Source: Coinbase Exchange public candles (`/products/{BTC-USD,ETH-USD}/candles`, granularity 300/900/3600). No key is needed.
  - Kraken public OHLC cross-checks the newest closed 5-minute close, BTC and ETH in alternate passes.
  - Labels:
    - **LIVE**: the newest published bucket is present.
    - **DELAYED**: newer buckets are missing, but the last bar closed under 30 minutes ago.
    - **DISCONNECTED**: an error, or nothing usable.
    - **HISTORICAL**: research bars.
  - Only LIVE bars may open a paper position.
  - Nothing is ever substituted. On failure the status is stored with its reason.
- **Schedule:**
  - The Durable Object alarm wakes 20 seconds after every 5-minute close, weekends included, whether the app is open or closed.
  - The 15-minute and hourly series are fetched when their bucket closes.
  - The owner can pause and resume it by voice ("pause Orion crypto research"), from Command Center `/trade-crypto`, or with `POST /api/trading/crypto {action}`.
  - Pausing voids an open position without inventing a close price. Resuming starts from the newest bar.
- **Budget:**
  - At most 6 exchange requests per pass and 3,000 per UTC day, counted in `crypto_budget`.
  - Expected use is about 816 Coinbase requests a day (BTC and ETH × 288, 96 and 24 buckets) plus 288 Kraken checks, so about 1,100.
  - No model call; the cost is $0.
- **Paper trading:**
  - All 12 existing intraday strategies run on BTC and ETH at 5m, 15m and 1h: 72 isolated portfolios, sized 0.01 BTC and 0.25 ETH.
  - Every closed trade is journalled with entry, exit, timestamps, prices, the cost breakdown, strategy, signal reason, post-trade review and result.
  - Trades are tagged `environment: 'paper'` and `market: 'crypto'`, with the feed label and its source.
  - The owner's Emergency Stop, stop-new-entries, pause-all and per-strategy disable or pause apply here too. The futures dollar and contract limits do not.
- **Research**, one series per pass, each refreshed every 6 hours from stored bars only:
  - Volatility: the ATR% regime against its median, and realised annualised volatility.
  - Liquidity screen: at least $50M traded on Coinbase in 24 hours.
  - Session breakdowns: UTC blocks (Asia, Europe, US, late US), New York sessions, and weekend against weekday.
  - A backtest of every strategy over the stored window, with a 70/30 in-sample/out-of-sample split and walk-forward folds.
  - Results under 30 trades are flagged "not enough data".
- **Chat and voice** (`che_crypto` route, no model):
  - The owner's Test A sentence turns the desk on if it was paused.
  - The reply gives the real schedule state, the last pass, each feed's status and freshness, the actual simulated trade count (zero is said as zero), performance with sample size, and the best out-of-sample result once one has 30 trades.
  - Guests are refused.

## 3. Costs assumed (stored on every portfolio and trade)

| | BTC | ETH | Source |
|---|---|---|---|
| Taker fee | 0.60% per side | 0.60% | Coinbase Exchange's lowest published tier, 0.60% taker and 0.40% maker below $10K monthly volume ([Coinbase Advanced fees](https://www.coinbase.com/advanced-trade)). Coinbase's retail app and some Advanced tiers charge more; a [Bankrate review](https://www.bankrate.com/investing/coinbase-review) lists 1.2% taker below $1K. |
| Maker fee (target exit) | 0.40% | 0.40% | same |
| Spread (full) | $1.00 | $0.10 | Planning assumption for a small order on the deepest USD books. |
| Slippage per market fill | $2.00 | $0.10 | Planning assumption. |

At these fees a round trip costs about 1% of the traded value. Most 5-minute setups risk 0.1–1%, so costs dominate short timeframes; the backtest and journal show this rather than hide it.

## 4. Exchange and counterparty notes

- **Paper only.** No funds sit at any exchange, so there is no custody exposure today.
- **Before any live use** (owner approval required, and not built):
  - venue licensing in the owner's state (Coinbase is a US-registered MSB with state money-transmitter licences)
  - custody and insolvency treatment of customer assets
  - API outage behaviour
  - withdrawal limits
  - the fee tier actually charged on the owner's account
- **Binance.com** does not serve US persons. CHE's older strategy simulation reads it; this desk deliberately does not.
- **Funding rates: MISSING.** BTC-USD and ETH-USD here are spot, which has no funding. No free perpetual-futures funding source was verified from CHE; the endpoints were unreachable from the build container. Nothing about funding is shown as data.

## 5. Verification

- **Tests:** `server/cloudflare/crypto_markets.test.mjs` covers:
  - parsing (Coinbase newest-first rows, the forming bucket dropped; Kraken)
  - LIVE, DELAYED and DISCONNECTED labels
  - percentage-fee maths, and futures costs and versions unchanged
  - a Saturday pass: forward-only start, budget counted, no re-fetch of the same bucket
  - an exchange outage giving DISCONNECTED with nothing traded
  - budget exhaustion stopping the fetch
  - 700 generated passes producing crypto journal records that no futures reader sees
  - research output
  - pause and resume
  - intent positives and negatives
  - Test A through `/api/chat`
- **Generated test bars only.** The build container cannot reach `api.exchange.coinbase.com` or `api.kraken.com` (proxy 403), so tests use bars generated in the test file, never stored as market data.
- **Production check:** the deploy's trading check (`/api/trading/probe`) runs one real crypto pass from the live Worker and prints each series' status, last bar and the Kraken cross-check.
- **Not verified yet:**
  - the real exchange responses from Cloudflare's network, until that deploy check runs
  - any closed crypto paper trade from real data
  - the iPhone view
