// Research seeds (lane T8, owner 2026-10-23: "stop limiting CHE to the same 10 familiar strategies"). Publicly
// documented NQ/MNQ strategies, researched on 2026-10-23 with their sources. Two parts:
//   RESEARCH_SOURCES  citations and CHE's own parameter choices for the research strategies the engine runs
//                     (trading_evidence.RESEARCH_*_CANDIDATES); the built-in entries pick them up.
//   ENTRIES           ideas whose rules CHE does not execute: rules documented, or discovered only. Nothing is
//                     invented: a concept without a definition says so, and order-flow ideas name the data they need.
// Kinds of source: research_paper, website (education sites, vendor pages, blogs), tradingview (open-source scripts,
// linked and described, never copied).

const ACCESSED = '2026-10-23';
const web = (title, url) => ({ type: 'website', title, url, accessed: ACCESSED });
const tv = (title, url) => ({ type: 'tradingview', title, url, accessed: ACCESSED });

/** Citations and CHE-chosen parameters for the research strategies that trading_evidence.js executes. */
export const RESEARCH_SOURCES = Object.freeze({
  'orb5-first-candle-5m': {
    category: 'breakout',
    sources: [{ type: 'research_paper', title: 'Zarattini & Aziz, "Can Day Trading Really Be Profitable?" (SSRN 4416622)', url: 'https://papers.ssrn.com/abstract=4416622', accessed: ACCESSED },
      web('CXO Advisory: day trading with an opening range breakout strategy', 'https://www.cxoadvisory.com/technical-trading/day-trading-with-an-opening-range-breakout-strategy'),
      web('Independent replication on five indices (MQL5 blog)', 'https://www.mql5.com/en/blogs/post/776235')],
    assumptions: ['A doji (no trade) is a body under 1 tick: the paper says only "about the same" open and close.', 'Risk under 6 or over 60 index points is skipped (CHE\'s common bounds).', 'Flat at 15:55 New York; the paper exits at the close.', 'Traded on MNQ/NQ futures; the paper tested QQQ and TQQQ.'],
    limitations: ['The stop and 10R target wording comes from a replication; the paper\'s PDF was not read.', 'The replication reports the paper\'s gross result reproduced and a net result near zero once spread and slippage are charged, which the paper did not do.'],
  },
  'ib-breakout-5m': {
    category: 'breakout',
    sources: [web('LuxAlgo: Initial Balance', 'https://www.luxalgo.com/library/concept/initial-balance/'),
      web('Drinka & Ptasienski, "Understanding Market Profile Part 6", Technical Analysis of Stocks & Commodities V.7:4', 'https://store.traders.com/traderscom/-v07-c04-underst-pdf.html')],
    assumptions: ['The sources define the balance (the first regular-session hour) and range extension, not a trade: entry window 10:30–12:00, stop at the middle of the balance and the 2R target are CHE\'s choices.'],
    limitations: ['"A narrow balance extends, a wide one holds" is described as a tendency, not a tested rule.'],
  },
  'squeeze-5m': {
    category: 'volatility',
    sources: [web('LuxAlgo: TTM Squeeze', 'https://www.luxalgo.com/library/concept/ttm-squeeze/'), tv('TTM Squeeze Pro (open-source script)', 'https://www.tradingview.com/script/0drMdHsO-TTM-Squeeze-Pro')],
    assumptions: ['Direction from the close against the 20-bar average, not John Carter\'s momentum histogram.', 'At least 6 squeeze bars in a row; Keltner basis is the 20-bar simple average with a 20-bar average true range.', 'Stop 1 tick beyond the 6-bar extreme; 2R target.'],
    limitations: ['An approximation of the TTM Squeeze, not Carter\'s indicator; no code was copied.', 'Not the same as the bollinger-squeeze seed (Bollinger\'s own bandwidth squeeze), which is not implemented.'],
  },
  'supertrend-5m': {
    category: 'trend',
    sources: [web('TA-Lib: SUPERTREND function definition', 'https://ta-lib.org/functions/supertrend.html')],
    assumptions: ['Entry on the flip close, stop 1 tick beyond the new line, 2R target; traders often exit on the opposite flip, which is not implemented.'],
    limitations: ['Its sources present it as a trend indicator more than a complete strategy.'],
  },
  'rsi2-connors': {
    category: 'reversal',
    sources: [web('LuxAlgo: RSI 2', 'https://www.luxalgo.com/library/concept/rsi-2/'), web('Backtrex: does the Connors RSI(2) strategy work on the Nasdaq 100?', 'https://backtrex.com/en/backtests/connors-rsi-2-nasdaq-100')],
    assumptions: ['Connors exits on a close above the 5-day average; the engine exits on a stop or target, so the target is the 5-day average on the signal day.', 'Connors publishes no stop: 2 × ATR(14) is CHE\'s.'],
    limitations: ['A published ten-year Nasdaq 100 test shows a high win rate, small average wins and returns far below buy-and-hold.'],
  },
  'donchian-20': {
    category: 'trend',
    sources: [web('MQL5: Automating the Original Turtle Trading Rules', 'https://www.mql5.com/en/articles/23448'), tv('Turtle Trading (open-source script)', 'https://www.tradingview.com/script/jbyeMkat/')],
    assumptions: ['Entry on a daily close above the 20-day high (the Turtles entered on the touch).', '2R target instead of the 10-day-low exit; no skip-after-a-winner rule, no shorts, no pyramiding.'],
    limitations: ['Secondary sources only; Curtis Faith\'s book was not read. Only the entry and the 2N stop are the Turtle rules.'],
  },
});

// ICT 2022 and AMD / Power of Three are T5's seeds (core.js); not repeated here.
const idea = (e) => ({ kind: 'strategy', lane: 'T8', ...e });

export const ENTRIES = [
  idea({ id: 'value-area-80-rule', name: 'Market Profile 80% rule', category: 'volume',
    sources: [web('LuxAlgo: 80% Rule', 'https://www.luxalgo.com/library/concept/80-percent-rule/'), web('MetroTrade: the 80% rule in futures trading', 'https://www.metrotrade.com/what-is-the-80-rule-in-futures-trading/'), web('NexusFi: 80 percent rule', 'https://nexusfi.com/a/concepts/80-percent-rule')],
    rules: ['Open outside the prior regular session\'s value area.', 'Re-enter it and hold for two consecutive 30-minute periods.', 'Target the opposite side of the value area; invalid if price leaves again on the entry side.'],
    timeframes: [30], data_requirements: ['The prior session\'s value area: a TPO profile built from 30-minute bars, or volume at price.'], event_dependencies: [],
    limitations: ['Its sources repeat the 80% figure without testing it; the origin is disputed (Dalton\'s Profile Reports vs Steidlmayer).', 'Not implemented yet: CHE has no value-area calculation.'] }),
  idea({ id: 'judas-swing', name: 'Judas swing', category: 'ict_smc', lifecycle_requested: 'discovered',
    sources: [tv('Judas Swing Detector (open-source script)', 'https://in.tradingview.com/script/fgkVI3nD-Judas-Swing-Detector-AGPro-Series/'), web('LuxAlgo: ICT Killzones', 'https://www.luxalgo.com/library/indicator/5zSOg8zv-ict-killzones/')],
    assumptions: ['A false move at the London or New York open that traps traders before the session\'s real direction, often read against the New York midnight open.'],
    timeframes: [1, 5], data_requirements: ['Intraday bars.'], event_dependencies: ['Session opens.'],
    limitations: ['The sources disagree on the killzone hours and none is ICT\'s own material.', 'No testable rule: which move counts as the swing, and when it is confirmed, is not defined.'] }),
  idea({ id: 'breaker-block', name: 'Breaker block', category: 'ict_smc', lifecycle_requested: 'discovered',
    sources: [web('FXNX: ICT mitigation vs breaker block', 'https://fxnx.com/en/blog/ict-mitigation-vs-breaker-block-trader-s-guide')],
    assumptions: ['An order block that fails: price trades through it, structure breaks the other way and the failed block flips role.'],
    timeframes: [5, 15], data_requirements: ['Intraday bars.'], event_dependencies: [], limitations: ['Its own indicator authors call it discretionary; no testable rule yet.'] }),
  idea({ id: 'mitigation-block', name: 'Mitigation block', category: 'ict_smc', lifecycle_requested: 'discovered',
    sources: [web('FXNX: ICT mitigation vs breaker block', 'https://fxnx.com/en/blog/ict-mitigation-vs-breaker-block-trader-s-guide')],
    assumptions: ['The last opposing candle before a market structure shift that followed a failure to make a new extreme.'],
    timeframes: [5, 15], data_requirements: ['Intraday bars.'], event_dependencies: [], limitations: ['Two sources describe it differently; no testable rule yet.'] }),
  idea({ id: 'inverse-fvg', name: 'Inverse fair value gap (IFVG)', category: 'ict_smc', lifecycle_requested: 'discovered',
    sources: [{ type: 'name', title: 'Named in the owner\'s request of 2026-10-23' }],
    timeframes: [], data_requirements: [], event_dependencies: [],
    limitations: ['The sources searched on 2026-10-23 contain no definition. CHE does not guess one.'] }),
  idea({ id: 'smt-divergence-nq-es', name: 'SMT divergence (NQ vs ES)', category: 'ict_smc',
    sources: [web('El Trader Financiado: SMT divergence', 'https://www.eltraderfinanciado.com/en/blog/smt-divergence')],
    rules: ['Non-confirmation between correlated indexes: NQ makes a new high while ES does not (or the reverse at lows).', 'Used as confirmation inside sweep → structure shift → entry.'],
    timeframes: [1, 5], data_requirements: ['Time-aligned ES (or YM) bars beside NQ. Not acquired: CHE\'s research datasets are MNQ and NQ only.'], event_dependencies: [],
    limitations: ['Its own source says no public statistic exists for it.'] }),
  idea({ id: 'asia-london-sweep-ny-reversal', name: 'Asia range, London sweep, New York reversal', category: 'ict_smc',
    sources: [web('Tradezella: NQ liquidity sweep reversal scalping strategy', 'https://www.tradezella.com/strategies/nq-liquidity-sweep-reversal-scalping-strategy'), tv('Session Sweep Reversal Predictor (open-source script)', 'https://id.tradingview.com/script/O148939n-Session-Sweep-Reversal-Predictor-PhenLabs/')],
    rules: ['Asia builds a range.', 'London sweeps one side of it.', 'New York trades toward the other side, confirmed by displacement after the sweep.'],
    timeframes: [5], data_requirements: ['Overnight (Globex) intraday bars.'], event_dependencies: ['Session opens.'],
    limitations: ['The cited indicator states it makes no performance claim.', 'Not implemented yet: the Asia window and the displacement threshold must be chosen. CHE\'s previous-day high/low sweep is the nearest tested rule. The P2P 86 overnight model is researched in its own lane.'] }),
  idea({ id: 'delta-divergence', name: 'Delta divergence', category: 'volume',
    sources: [web('LuxAlgo: Footprint concepts', 'https://www.luxalgo.com/library/concept/footprint-concepts/'), web('Finowings: order flow analysis, footprint and delta', 'https://www.finowings.com/Trading/order-flow-analysis-footprint-delta')],
    rules: ['Price makes a new high (low) while cumulative delta (aggressive buy minus sell volume) does not.'],
    timeframes: [1, 5], data_requirements: ['The aggressor side of every trade. Being recorded from the owner\'s Rithmic feed; backtestable after 20 recorded sessions (count at /api/trading/research/order-flow).'], event_dependencies: [],
    limitations: ['Thresholds vary by source; no tested statistic.'] }),
  idea({ id: 'absorption', name: 'Absorption', category: 'volume',
    sources: [web('LuxAlgo: Footprint concepts', 'https://www.luxalgo.com/library/concept/footprint-concepts/')],
    rules: ['Heavy aggressive volume that fails to move price because passive orders absorb it; often seen before a reversal.'],
    timeframes: [1], data_requirements: ['Aggressor volume per bar. Being recorded from the owner\'s Rithmic feed; backtestable after 20 recorded sessions (count at /api/trading/research/order-flow).'], event_dependencies: [],
    limitations: ['Definitions and thresholds vary by source.'] }),
  idea({ id: 'stacked-imbalance', name: 'Stacked imbalances', category: 'volume',
    sources: [web('NexusFi: advanced footprint chart patterns', 'https://nexusfi.com/a/strategies/advanced-footprint-chart-patterns')],
    rules: ['Runs of consecutive price levels where one side dominates by a set ratio, treated as support or resistance on a retest.'],
    timeframes: [1], data_requirements: ['Bid and ask volume at every price level inside each bar (a footprint). CHE does not have it: the Rithmic recorder keeps per-minute delta, not volume at each price.'], event_dependencies: [],
    limitations: ['The 48% win rate one source quotes is unverified.'] }),
  idea({ id: 'volatility-breakout-williams', name: 'Volatility breakout (Larry Williams)', category: 'volatility',
    sources: [web('LuxAlgo: Volatility Breakout', 'https://www.luxalgo.com/library/concept/volatility-breakout/'), tv('Volatility breakout (open-source script)', 'https://kr.tradingview.com/script/P8cxeiJy')],
    rules: ['A buy stop above the open and a sell stop below it, each a multiple of the prior session\'s range; the first fill sets the direction.'],
    timeframes: [5], data_requirements: ['Intraday bars: a stop entry cannot be filled honestly on daily bars.'], event_dependencies: [],
    limitations: ['Williams\' own multiplier was not found in a primary source (secondary sources say 0.25–0.5); which open (18:00 Globex or 9:30) must also be chosen.'] }),
  idea({ id: 'rth-gap-fill', name: 'Regular-session gap fill', category: 'reversal',
    sources: [web('Edgeful: gap fill report', 'https://www.edgeful.com/blog/posts/gap-fill-report'), tv('Gap Fill Engine ES/NQ (open-source script)', 'https://www.tradingview.com/script/7BvtpuGK-Gap-Fill-Engine-ES-NQ/')],
    rules: ['Gap = the 9:30 open minus the prior 16:00 close; the fill target is the prior close (or half the gap).'],
    timeframes: [5], data_requirements: ['Intraday bars with the 16:00 close and the 9:30 open.'], event_dependencies: ['Overnight news and data releases.'],
    limitations: ['Published fill rates are vendor figures without audited data.', 'Not implemented yet: no source gives the entry timing or the stop.'] }),
  { id: 'vix-vxn-regime', kind: 'market_context', lane: 'T8', name: 'VIX / VXN volatility regime', category: 'volatility',
    sources: [web('QuantRocket: VIX research notebook', 'https://www.quantrocket.com/codeload/first-last/first_last/Part4-VIX-Research.ipynb'), web('Substack: a VIX regime filter on ES/NQ/RTY (self-reported results)', 'https://algotr.substack.com/p/stop-leaving-money-on-the-table-a')],
    rules: ['Classify every signal by the volatility index level or its percentile band and compare results per band: a filter, not a trigger.'],
    timeframes: [1440], data_requirements: ['Daily VIX or VXN (the Nasdaq-100 measure). Not acquired yet; CHE\'s own ATR volatility regime is measured on every backtest meanwhile.'], event_dependencies: ['Macro events move the index.'],
    limitations: ['The thresholds found are for VIX (S&P 500) and do not transfer to VXN without their own test.'] },
];
