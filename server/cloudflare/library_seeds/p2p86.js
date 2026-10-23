// Lane T6: the P2P 86 Model (owner, 2026-10-23). Two things, kept apart:
// - the ORIGINAL "P2P 86 Model Probability Map" TradingView indicator by GloWizzy: closed source, referenced by
//   link and described from what its page publishes; no code and no unpublished calculation is stored here;
// - CHE's own approximation, the built-in strategy p2p86-style-5m in trading_evidence.js (it reaches the library
//   through builtinEntries), with rules written and tested by CHE. docs/CHE_P2P_86_MODEL.md.

export const ENTRIES = [
  {
    id: 'p2p-86-model-original', kind: 'market_context', name: 'P2P 86 Model Probability Map (original TradingView indicator, closed source)', category: 'ict_smc', lane: 'T6',
    sources: [
      { type: 'tradingview', title: 'P2P 86 Model Probability Map, by GloWizzy (protected script)', url: 'https://www.tradingview.com/script/20ARUMK8-P2P-86-Model-Probability-Map/' },
      { type: 'repo_code', title: 'docs/CHE_P2P_86_MODEL.md: what is published and what is unknown' },
    ],
    rules: [],
    assumptions: [
      'Published idea: New York tends to break the overnight high (buy-side liquidity) or the overnight low (sell-side liquidity); the indicator shows which side it rates more likely to be taken first, and a second-side mode after the first sweep.',
      'Published scope: Nasdaq-related symbols only (NQ, MNQ, NDX, QQQ).',
    ],
    timeframes: [], data_requirements: ['intraday bars covering the overnight session and the New York session'], event_dependencies: [],
    limitations: [
      'Closed source: its session times, probability calculations and what "86" refers to are not published, so CHE does not reproduce them.',
      'Not executable in CHE. CHE\'s independent approximation is the strategy p2p86-style-5m ("CHE 86-style overnight range model (independent approximation — not the P2P indicator)"), whose probabilities are CHE\'s own measured frequencies.',
    ],
  },
];
