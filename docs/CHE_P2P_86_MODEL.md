# P2P 86 Model and CHE's 86-style overnight range model

Owner request, 2026-10-23: add the P2P 86 Model to the Strategy Library, with charts, backtests, paper trading and replay. Two things are kept apart here:

- **The original**: the "P2P 86 Model Probability Map" TradingView indicator by GloWizzy. It is closed source.
- **CHE's model**: *CHE 86-style overnight range model (independent approximation — not the P2P indicator)*, strategy id `p2p86-style-5m`. It is written by CHE from the published idea only.

## 1. What is published about the original

Source: https://www.tradingview.com/script/20ARUMK8-P2P-86-Model-Probability-Map/

- **How it was read:** through web-search indexing of that page on 2026-10-23. The page itself could not be opened from CHE's build environment, because the network policy refuses tradingview.com, so nothing below was read directly from it.
- **Author:** GloWizzy, who also publishes "P2P Time Cycles" (https://www.tradingview.com/script/vbK3QEZ0-P2P-Time-Cycles/).

| Topic | Published | Status |
|---|---|---|
| Concept | A time-based liquidity framework for the overnight range during the New York session. Its premise is that New York has a strong historical tendency to break the overnight high or the overnight low. | Published (paraphrased by the search index) |
| Liquidity reading | The overnight high is buy-side liquidity; the overnight low is sell-side liquidity. The model indicates which side is more likely to be targeted first. | Published (paraphrased) |
| Markets | Restricted to Nasdaq-related symbols (NQ, MNQ, NDX, QQQ). Supports seconds charts. | Published (update notes) |
| Second side | An "Enable Second-Side Stat Mode" setting switches between initial and post-sweep probability displays. | Published (setting name) |
| Script access | Protected / closed source | Published |
| Overnight session window (start and end times) | — | **UNKNOWN** |
| New York session window used | — | **UNKNOWN** |
| How the probabilities are calculated (sample, period, conditioning) | — | **UNKNOWN** |
| What "86" refers to | — | **UNKNOWN**. No result states an 86% figure; do not read it as one. |
| Entry, stop, target or invalidation rules | — | **UNKNOWN**. None are published; the indicator describes probabilities, not trades. |

No code was copied, because none is visible. No unpublished calculation or probability is reproduced or imitated.

## 2. CHE's independent approximation: the exact rules

These are CHE's own choices, written down so they can be tested. They are in `server/cloudflare/trading_evidence.js` (`p2p86Plan`, candidate `p2p86-style-5m`).

1. **Overnight range.** The high and low of the CME session from 18:00 to 9:30 New York time. The time zone database handles daylight saving time. The levels are known only from the first bar that starts at 9:30.
   - The original's window is unknown; this window is CHE's choice.
   - Only bars that close exactly at 9:30 are allowed (15-second to 15-minute bars). A 1-hour bar would mix overnight and New York prices.
2. **Bias at 9:30.** The New York open above the range midpoint gives a long bias, aimed at the overnight high (buy-side). Below the midpoint gives a short bias, aimed at the overnight low (sell-side). Exactly at the midpoint, there is no trade that day.
3. **Invalidation.** No trade if the opposite overnight extreme is traded before entry. No trade if the target extreme is already taken before entry.
4. **Entry window.** 9:35 to 11:00 New York only.
5. **Trigger.** The first bar that closes:
   - beyond the New York open, and
   - beyond the prior bar's high (long) or low (short).
   It is a market order at the next bar open: the engine's common fill rule, after costs.
6. **Stop.** 1 tick beyond the New York session extreme so far.
7. **Target.** The overnight extreme itself. The trade is skipped if the target is less than 1R away.
8. **Common rules.** Risk must be 6 to 60 index points, otherwise skipped. The position is flat by 16:55 New York. One position at a time.
9. **Expiry.** No entry by 11:00 means no trade that day. Only one setup per day.

**Stages** shown live: waiting, watching, forming, triggered, triggered earlier, invalidated, target taken, expired, no bias.

## 3. Probabilities CHE shows

CHE never shows the indicator's probabilities. `overnightStats` measures CHE's own frequencies on the bars it has, and always reports them with the sample size. Over full New York sessions (9:30–16:00), it counts:

- days on which New York took either overnight extreme;
- how often the 86-style bias side was taken first;
- bars that took both extremes, so the order inside the bar is unknown;
- how often the second side was taken after the first.

Under 30 sessions is labelled "not evidence".

## 4. Where it runs

The model is one entry in CHE's existing strategy set, so the existing systems carry it without a parallel engine:

- **Backtest.** It runs in the research engine (`trading_research.js`): walk-forward, out-of-sample, look-ahead audit, stress costs.
- **Real-bar comparison.** `tools/che_strategy_backtest.mjs`, run by `.github/workflows/che-strategy-backtest.yml`, compares every strategy on the same real bars. Hosted runners can reach the data source; CHE's build sandbox cannot.
- **Forward paper engine.** It runs in the forward paper engine (`trading_live.js`). Paper only, on DELAYED data, journalled, with markers on the Trading Room chart and the existing trade replay.
- **Controls.** Enable, disable and pause work through the existing controls ("disable the 86 model", "pause p2p"). It is listed in the ICT group and the strategy registry, labelled as an approximation.
- **Chart.** Futures chart API `levels` sends the overnight high and low, the bias, the stage and, only when triggered, the entry, stop and target. The chart draws them dashed and labelled "86-style approx."; Read Aloud and VoiceOver say "CHE approximation, not the P2P indicator".
- **Live trading.** Real-money trading stays disabled.

## 5. Not verified

- The original's actual rules, session times and probabilities.
- Whether CHE's approximation behaves like the indicator. It cannot be compared, because the indicator is closed.
- Results on Rithmic live data. Backtests use Yahoo Finance (public, delayed, 5-minute, about 59 days deep).
