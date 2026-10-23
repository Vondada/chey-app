# CHE strategy audit (2026-10-23)

This is an audit of every place in the code that defines a trading strategy. The counts come from the code, using `strategy_library.libraryView` over empty storage. Counts that depend on the live ledgers (backtested, forward tested, paper active) are computed by the same function on the production Worker, and the Strategy Library page shows them. They are **not** verified from this checkout, because the production Durable Object storage cannot be read here.

## Where strategies are defined

| Source (file) | What it holds | Count | Engine that runs it |
|---|---|---|---|
| `server/cloudflare/trading_evidence.js` `INTRADAY_CANDIDATES` | Written intraday rules: 6 ICT, ORB, VWAP 2σ, EMA pullback, inside bar, RSI 30/70 | 11 | `trading_evidence.stepPortfolio` (research backtests + forward paper in `trading_live.js`) |
| `server/cloudflare/trading_evidence.js` `CANDIDATES` | Daily rules: PDH break, sweep-reclaim, FVG retest, displacement continuation, order-block retest | 5 | `trading_evidence.stepPortfolio` (daily backtests) |
| `server/cloudflare/strategy_sim.js` `SIM_STRATEGIES` | Minute-bar simulator configs (7 signals × trend filter × target) | 10 | `strategy_sim.js` (paper simulator) |
| `server/cloudflare/trading_lab.js` `STRATEGIES` | Daily lab strategies (swing breakout, pullback reversal, trend cross) | 3 | `trading_lab.backtestAll` (on request) |
| `server/cloudflare/trading_research.js` `UNDEFINED_STRATEGIES` | Names with no written rules: Dirty Trez, ICT OTE | 2 | none |
| `server/cloudflare/library_seeds/core.js` (new) | che.strategy/1 rules: EMA 9/21, MACD signal cross, Bollinger reversion | 3 | `lib/trading/che_strategy_dsl.dart` in the phone's setup engine |
| `server/cloudflare/library_seeds/core.js` (new) | Documented, not implemented: ICT 2022 model, Bollinger squeeze; AMD / Power of Three (market context) | 3 | none |
| `lib/trading/che_setup_engine.dart` (lane T2) | Ports of `ema-pullback-5m`, `vwap-revert-5m` and `sweep-reclaim-5m`: the same ids, not new strategies | (0 new) | phone setup engine |
| Knowledge Library / docs | Concept cards and docs that describe strategies. None of them define rules beyond the code above | 0 executable | none |

## The numbers the owner asked for

| Question | Count | Evidence |
|---|---|---|
| Named strategies | **36** (plus 1 market-context model) | All entries above with `kind: strategy` |
| Strategies with executable rules | **32** | 16 trading_evidence + 10 strategy_sim + 3 trading_lab + 3 DSL |
| Strategies with working backtests (an engine that backtests them) | **29** | 16 research-engine + 10 simulator + 3 lab. The 3 DSL strategies have no backtest yet; the harness is lane T8 |
| Strategies with verified historical results | **Not verifiable from this checkout** | `libraryView` counts `trading_research` stored units with trades > 0 at request time; the iPhone page shows the live number |
| Eligible for forward paper testing | **11 now**, 14 after the owner approves the 3 DSL seeds | The forward paper engine (`trading_live.js`) runs `INTRADAY_CANDIDATES`. DSL strategies are eligible only once approved |
| Currently active (paper) | **Not verifiable from this checkout** | PAPER ACTIVE needs paper learning switched on (`live_paper_state.enabled`) and the strategy not disabled in the Strategy Control Center |
| Disabled or unsupported | **7** in the code baseline | 2 discovered (Dirty Trez, ICT OTE), 2 documented-only strategies (ICT 2022, Bollinger squeeze), 3 DSL seeds waiting for approval |

By category (strategies only): trend 2, momentum 4, breakout 9, reversal 6, ICT/SMC 11, volatility 1, volume 1, other 2. Scalping and price action are 0, with no written rules yet.

## Earlier figures

Earlier this session the ledgers were reported as 10,789 backtest trades, 219 paper trades and 24 unique forward trades. This audit did not re-read those ledgers, so it does not restate them as current.

## "86" and "AMD": candidate identifications

The owner identified **"86" as the P2P 86 Model** (TradingView script "P2P 86 Model Probability Map", https://www.tradingview.com/script/20ARUMK8-P2P-86-Model-Probability-Map/). Lane T6 owns researching and implementing it through this library's DSL. Until T6 registers it, it has no entry and no rules in CHE.

- A repo and mailbox search found no earlier "86" strategy in CHE's code, docs or mailbox.
- A web search for an "86 model" for NQ found no public written definition. Nothing is inferred from the name.

**AMD**:
- **Most likely meaning:** ICT's **Power of Three**: Accumulation, Manipulation, Distribution.
  - Accumulation is a quiet range.
  - Manipulation is a false break that sweeps the range's stops and closes back inside.
  - Distribution is the real move, in the opposite direction.
- **Timing differs by source.** TradingView community scripts place the phases at about 19:00–01:00 / 01:00–07:00 / 07:00–13:00 EST, or at the Asia / London / New York sessions. Others apply it to daily or weekly candles. Sources:
  - https://vn.tradingview.com/script/5thZ7SVC-Power-Of-3-ICT-01-TradingFinder-AMD-ICT-SMC-Accumulations
  - https://vn.tradingview.com/scripts/three/
- **In CHE:** `amd-power-of-three`, a market-context model at RULES DOCUMENTED, with no executable rules.
- **Status:** the identification is **UNCONFIRMED**. "AMD" is also the AMD stock ticker, which CHE's stock desk handles. The owner should say which one he means.

## What the lifecycle means

DISCOVERED → RULES DOCUMENTED → IMPLEMENTED → BACKTESTED → FORWARD TESTED → PAPER ACTIVE

| Stage | Requires |
|---|---|
| DISCOVERED | A name or idea only |
| RULES DOCUMENTED | Written rules or documented assumptions, with a source |
| IMPLEMENTED | An engine runs the rules |
| BACKTESTED | Recorded backtest trades |
| FORWARD TESTED | At least 30 forward paper trades |
| PAPER ACTIVE | Approved, enabled, and running now |

A stage is computed from evidence (`lifecycleOf`). A request can lower it but never raise it.
