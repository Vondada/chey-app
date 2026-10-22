# CHE Historical Trading Intelligence

Owner request, 2026-10-22: test CHE's strategies on decades of Nasdaq-100 history, learn from it automatically, and answer questions from stored tests. Research and paper only.

## What it does

| Part | Where | Notes |
|---|---|---|
| Ingestion and verification | `server/cloudflare/historical_intelligence.js` (`fetchDaily`, `verifyDataset`, `ingestDataset`) | Free public daily bars only. Each dataset records its provider, symbol, contract, range, adjustment, resolution, time zone, gaps, large opening jumps and a SHA-256 of the exact bars. It is re-verified after storage. |
| Datasets | `DATASETS` | **MNQ**: `MNQ=F`, requested from 2019-05-06. **NQ**: `NQ=F`, requested from 1999-06-21; the provider's series starts later, and the uncovered span is reported, never filled. **NDX**: `^NDX`, from 1985-10-01. NDX is a labelled **proxy**: an index cannot be traded, so it uses the NQ point value and costs. MNQ and NQ are the same futures and are never added together. |
| Backtester | `trading_evidence.js` `stepPortfolio`, unchanged | Event-driven. A signal on a closed bar fills at the next open, with spread, slippage, commission and fees. A stop is checked before a target inside one bar. |
| Zero look-ahead | `leakageAudit` | Every rule is rerun with the bars after the 70% point removed, and again with them scaled up and down. Earlier trades must be identical. A rule that peeks at the next bar fails (tested). |
| Strategies | `configs()` | Five daily ICT/smart-money rules (`CANDIDATES`), times two trend filters, times three targets (1.5, 2 and 3 R): 30 per dataset. The intraday rules (VWAP, opening range, EMA pullback, RSI, ICT 5-minute) come from the existing 5-minute research (`trading_live.js`, about 60 days of free data); its latest result is shown as it is. |
| Regimes | `regimes` | Causal. Trend is close vs the 200-day average. Volatility is the ATR/price percentile over the trailing year. Shown per regime, plus a by-year breakdown. |
| Learning loop | `studyDataset`, `studyStep`, `studyAlarm` | Anchored walk-forward (40% train, 5 out-of-sample windows). Ranked on out-of-sample results only: the low end of the 95% range of expectancy in R, with at least 30 OOS trades and a passing audit. Daily evidence can rank, never promote. Steps are resumable. Once the owner starts a study, the hourly alarm finishes it and refreshes it daily. No model and no money. |
| 2026 and recent comparison | `compareWithPaper`, `dedupeTrades` | This year's paper journal, deduplicated by environment, strategy, filter, side and entry time. Compared with each strategy's historical OOS result; never added to it. |
| Paper signals | `journalSignals` | The top-ranked MNQ rules' pending signals are journalled once each (`hist_signals`). No order is ever placed. |
| Answers | `intelligenceIntent`, `speakIntelligence` | Chat, voice or `/trade-history`. Owner only. Answered from stored tests only. Before any study, CHE says none has run. |
| Report | `GET /api/trading/intelligence/report` | Dataset manifests and checksums, method, costs, every configuration's numbers, and the top configurations' trades. |
| Dashboard | `lib/rooms/che_trading_intelligence.dart`, Trading Room → STRATEGIES | VoiceOver labels on every card and button; 44-point buttons; Read aloud and Report ask CHE. It never speaks by itself. |

## What it does not do

- It buys nothing, subscribes to nothing, and invents no bars or trades. A provider that refuses is shown with its reason.
- It never calls a strategy "winning". "Edge shown" means only that the 95% range of out-of-sample expectancy stays above zero. With 30 configurations tried per dataset, some look good by luck.
- It cannot promote anything to live trading. Real-money and funded-account execution stay disabled.
- **Dirty Trez is not tested.** CHE has no written rules for it. Once the owner gives the entry, stop, target and timeframe rules, up to 33 variants per timeframe can be added to `CANDIDATES` and tested the same way.

## Known limits

- Free minute or 5-minute history goes back only about 60 days. Decades of intraday history would need a paid vendor, which needs the owner's decision.
- Futures series are unadjusted continuous front months. Roll jumps stay in the data and are counted.
- The live provider (Yahoo Finance) cannot be reached from the development container. The first real ingestion runs on the deployed Worker.
