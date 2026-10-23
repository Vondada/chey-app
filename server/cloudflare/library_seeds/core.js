// Core library seeds (lane T5): well-established indicator strategies written as che.strategy/1 rules, and
// named concepts that have no executable rules in CHE yet. A rule is written here only where its public
// definition is standard; each cites where the definition comes from. None is approved: paper testing
// waits for the owner's yes, and nothing here has backtest results until the harness records them.

const TICK = 0.25;

export const ENTRIES = [
  {
    id: 'ema-9-21-cross', kind: 'strategy', name: 'EMA 9 / 21 crossover', category: 'trend', lane: 'T5',
    sources: [{ type: 'website', title: 'Investopedia: Exponential Moving Average (EMA)', url: 'https://www.investopedia.com/terms/e/ema.asp' }],
    rules: ['Long when the 9-bar EMA crosses above the 21-bar EMA and price is above the 50-bar EMA; short on the mirror.', 'Stop one tick beyond the lowest low (long) or highest high (short) of the last 5 bars.', 'Target 2R.'],
    assumptions: ['The 50-bar EMA trend filter is CHE\'s choice, to avoid trading every cross in a range.'],
    timeframes: [1, 5], data_requirements: ['1- or 5-minute bars with real timestamps'], event_dependencies: [],
    limitations: ['Crossovers lag; whipsaws in ranges.'],
    definition: {
      schema: 'che.strategy/1', id: 'ema-9-21-cross', name: 'EMA 9 / 21 crossover', category: 'trend', timeframes: [1, 5],
      series: { ema9: { fn: 'ema', period: 9 }, ema21: { fn: 'ema', period: 21 }, ema50: { fn: 'ema', period: 50 }, lo5: { fn: 'lowest', of: 'low', period: 5 }, hi5: { fn: 'highest', of: 'high', period: 5 } },
      long: {
        conditions: [
          { id: 'trend', label: 'Price above the 50 EMA', group: 'trend', when: { gt: ['close', 'ema50'] } },
          { id: 'cross', label: '9 EMA crosses above the 21 EMA', group: 'trigger', when: { cross_above: ['ema9', 'ema21'] } },
        ],
        stop: { sub: ['lo5', TICK] }, target: { r: 2 }, near: 'ema21',
      },
      short: {
        conditions: [
          { id: 'trend', label: 'Price below the 50 EMA', group: 'trend', when: { lt: ['close', 'ema50'] } },
          { id: 'cross', label: '9 EMA crosses below the 21 EMA', group: 'trigger', when: { cross_below: ['ema9', 'ema21'] } },
        ],
        stop: { add: ['hi5', TICK] }, target: { r: 2 }, near: 'ema21',
      },
      risk: { min_points: 6, max_points: 60, max_trades_per_day: 5 },
    },
  },
  {
    id: 'macd-signal-cross', kind: 'strategy', name: 'MACD signal-line cross', category: 'momentum', lane: 'T5',
    sources: [{ type: 'website', title: 'Investopedia: MACD (Gerald Appel; 12, 26, 9)', url: 'https://www.investopedia.com/terms/m/macd.asp' }],
    rules: ['Long when the MACD line (12, 26) crosses above its 9-bar signal line below zero; short on the mirror above zero.', 'Stop one tick beyond the last confirmed swing.', 'Target 2R.'],
    assumptions: ['The zero-line side filter is CHE\'s choice (crosses from the far side of zero).'],
    timeframes: [5], data_requirements: ['5-minute bars'], event_dependencies: [], limitations: ['Momentum signals lag fast reversals.'],
    definition: {
      schema: 'che.strategy/1', id: 'macd-signal-cross', name: 'MACD signal-line cross', category: 'momentum', timeframes: [5],
      series: { macd: { fn: 'macd', fast: 12, slow: 26, signal: 9, part: 'line' }, sig: { fn: 'macd', fast: 12, slow: 26, signal: 9, part: 'signal' } },
      long: {
        conditions: [
          { id: 'below0', label: 'MACD below zero', group: 'indicator', when: { lt: ['macd', 0] } },
          { id: 'cross', label: 'MACD crosses above its signal line', group: 'trigger', when: { cross_above: ['macd', 'sig'] } },
        ],
        stop: { sub: [{ level: 'swing_low' }, TICK] }, target: { r: 2 },
      },
      short: {
        conditions: [
          { id: 'above0', label: 'MACD above zero', group: 'indicator', when: { gt: ['macd', 0] } },
          { id: 'cross', label: 'MACD crosses below its signal line', group: 'trigger', when: { cross_below: ['macd', 'sig'] } },
        ],
        stop: { add: [{ level: 'swing_high' }, TICK] }, target: { r: 2 },
      },
      risk: { min_points: 6, max_points: 60, max_trades_per_day: 5 },
    },
  },
  {
    id: 'bollinger-reversion', kind: 'strategy', name: 'Bollinger Band reversion to the middle band', category: 'reversal', lane: 'T5',
    sources: [{ type: 'website', title: 'Bollinger Bands (John Bollinger; 20 periods, 2 standard deviations)', url: 'https://www.bollingerbands.com/bollinger-bands' }],
    rules: ['Long when price closes back inside the lower band (20, 2) after closing below it; short on the mirror at the upper band.', 'Stop one tick beyond the extreme of the last 3 bars.', 'Target: the middle band (20-bar average).'],
    assumptions: ['"Close back inside" is CHE\'s confirmation; Bollinger himself says a band touch alone is not a signal.'],
    timeframes: [5], data_requirements: ['5-minute bars'], event_dependencies: [], limitations: ['Fails in strong trends (bands "walk").'],
    definition: {
      schema: 'che.strategy/1', id: 'bollinger-reversion', name: 'Bollinger Band reversion to the middle band', category: 'reversal', timeframes: [5],
      series: { up: { fn: 'bb', period: 20, k: 2, part: 'upper' }, mid: { fn: 'bb', period: 20, k: 2, part: 'mid' }, dn: { fn: 'bb', period: 20, k: 2, part: 'lower' }, lo3: { fn: 'lowest', of: 'low', period: 3 }, hi3: { fn: 'highest', of: 'high', period: 3 } },
      long: {
        conditions: [
          { id: 'outside', label: 'Previous bar closed below the lower band', group: 'indicator', when: { lt: [{ bar: 'close', ago: 1 }, { series: 'dn', ago: 1 }] } },
          { id: 'back', label: 'This bar closes back inside the lower band', group: 'trigger', when: { gt: ['close', 'dn'] } },
        ],
        stop: { sub: ['lo3', TICK] }, target: 'mid', near: 'dn',
      },
      short: {
        conditions: [
          { id: 'outside', label: 'Previous bar closed above the upper band', group: 'indicator', when: { gt: [{ bar: 'close', ago: 1 }, { series: 'up', ago: 1 }] } },
          { id: 'back', label: 'This bar closes back inside the upper band', group: 'trigger', when: { lt: ['close', 'up'] } },
        ],
        stop: { add: ['hi3', TICK] }, target: 'mid', near: 'up',
      },
      risk: { min_points: 6, max_points: 60, max_trades_per_day: 5 },
    },
  },
  {
    id: 'ict-2022-model', kind: 'strategy', name: 'ICT 2022 mentorship model', category: 'ict_smc', lane: 'T5',
    sources: [{ type: 'name', title: 'Inner Circle Trader (Michael J. Huddleston), 2022 YouTube mentorship', url: 'https://www.youtube.com/@InnerCircleTrader' }],
    rules: [],
    assumptions: ['Commonly summarised as: a liquidity sweep in a killzone, then a market structure shift with displacement, then entry on the fair value gap the displacement left. The exact parameters (which liquidity, which timeframe, stop and target) are not fixed in one public document, so CHE has not written executable rules.'],
    timeframes: [], data_requirements: ['1- to 5-minute bars, session times'], event_dependencies: [],
    limitations: ['Not implemented: the source is a video series, not a written rule set. CHE\'s sweep-mss-5m and fvg-retest-5m implement its components.'],
  },
  {
    id: 'amd-power-of-three', kind: 'market_context', name: 'AMD / Power of Three (accumulation, manipulation, distribution)', category: 'ict_smc', lane: 'T5',
    sources: [{ type: 'name', title: 'Inner Circle Trader: "Power of Three" (AMD) daily-candle model', url: 'https://www.youtube.com/@InnerCircleTrader' }],
    rules: [],
    assumptions: ['Describes a trading day in three phases: a quiet range (accumulation, often Asia), a false move against the day\'s direction (manipulation, often London or the New York open), then the real move (distribution). It describes context; it does not define an entry by itself.'],
    timeframes: [], data_requirements: ['intraday bars across the Asia, London and New York sessions'], event_dependencies: [],
    limitations: ['No executable rules in CHE. Lane T7 (market context) may model its phases as regime tags.'],
  },
  {
    id: 'bollinger-squeeze', kind: 'strategy', name: 'Bollinger squeeze breakout', category: 'volatility', lane: 'T5',
    sources: [{ type: 'website', title: 'Bollinger Bands: the Squeeze', url: 'https://www.bollingerbands.com/bollinger-bands' }],
    rules: [],
    assumptions: ['A breakout after band width falls to a multi-month low. CHE has no band-width series or agreed lookback yet.'],
    timeframes: [], data_requirements: ['bars covering several months for the width lookback'], event_dependencies: [],
    limitations: ['Not implemented.'],
  },
];
