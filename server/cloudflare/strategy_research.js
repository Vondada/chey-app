// CHE strategy discovery and comparison (owner, 2026-10-23: "stop limiting CHE to the same 10 familiar strategies").
// A layer over the existing research engine, never a second one:
//   rules, fills, costs           trading_evidence.js (INTRADAY_CANDIDATES, CANDIDATES, RESEARCH_*_CANDIDATES)
//   backtests, walk-forward, OOS  trading_research.js (evaluateUnit, research jobs, stored evidence units)
//   assumptions shown with every result   trading_market_spec.js
// What is new: a catalog of publicly documented NQ/MNQ strategies with their sources, the lifecycle stage of every
// strategy computed from stored evidence (never typed in), a same-dataset comparison with in-sample and
// out-of-sample columns, condition breakdowns that say "insufficient evidence" instead of guessing, and the data
// sources CHE could use. Nothing here places an order or enables paper trading.
import { INTRADAY_CANDIDATES, etParts } from './trading_evidence.js';
import { MIN_CLOSED_TRADES, UNDEFINED_STRATEGIES, definitionOf, evaluateUnit, forwardEvidence, loadDataset, missingBars, readUnits, strategyDefinitions } from './trading_research.js';
import { readControls } from './trading_controls.js';
import { marketSpec } from './trading_market_spec.js';

export const STAGES = Object.freeze(['DISCOVERED', 'RULES DOCUMENTED', 'IMPLEMENTED', 'BACKTESTED', 'FORWARD TESTED', 'PAPER ACTIVE']);
const ACCESSED = '2026-10-23';
const src = (title, url, kind = 'secondary') => ({ title, url, accessed: ACCESSED, kind });

/**
 * Publicly documented strategies researched on 2026-10-23. `engine_id` is set only when CHE executes written rules for
 * it; `che_choices` lists every parameter CHE picked because the source does not publish one. Kinds: 'paper' (research
 * paper), 'reference' (library documentation), 'secondary' (education site, vendor page, blog, script description).
 * The existing engine strategies (Silver Bullet, FVG, order block, sweeps, ORB 15, VWAP, EMA, inside bar, RSI 30/70,
 * daily set) are not repeated here; their rules are in trading_evidence.js and every count below includes them.
 */
export const RESEARCH_CATALOG = Object.freeze([
  { id: 'orb5-first-candle', name: 'First 5-minute candle breakout', category: 'Breakout', engine_id: 'orb5-first-candle-5m', documented: 'RULES DOCUMENTED',
    sources: [src('Zarattini & Aziz, "Can Day Trading Really Be Profitable?" (SSRN 4416622)', 'https://papers.ssrn.com/abstract=4416622', 'paper'),
      src('CXO Advisory summary of the paper', 'https://www.cxoadvisory.com/technical-trading/day-trading-with-an-opening-range-breakout-strategy'),
      src('Independent replication on five indices (MQL5 blog)', 'https://www.mql5.com/en/blogs/post/776235')],
    rules: 'Direction of the first 5-minute regular-session bar; entry at the open of the second bar; stop at the other side of the first bar; target 10 × risk or the session close; no trade on a doji.',
    che_choices: ['A doji is a body under 1 tick.', 'CHE\'s common risk bounds apply: risk under 6 or over 60 index points is skipped.', 'Flat at 15:55 New York (the paper exits at the close).', 'Traded on MNQ/NQ futures; the paper tested QQQ/TQQQ.'],
    timeframes: ['5m'], data_requirements: '5-minute bars from 9:30 New York', event_dependencies: 'none stated',
    limitations: 'The stop and target wording comes from a replication, not the paper text (the PDF was not read). The replication reports the gross result reproduced and the net result near zero after spread and slippage, which the paper did not charge.' },
  { id: 'ib-breakout', name: 'Initial balance breakout', category: 'Market profile', engine_id: 'ib-breakout-5m', documented: 'RULES DOCUMENTED',
    sources: [src('LuxAlgo: Initial Balance', 'https://www.luxalgo.com/library/concept/initial-balance/'),
      src('Drinka & Ptasienski, "Understanding Market Profile Part 6", Technical Analysis of Stocks & Commodities V.7:4', 'https://store.traders.com/traderscom/-v07-c04-underst-pdf.html')],
    rules: 'Initial balance = the first hour of the regular session (9:30–10:30 New York). Trade beyond it is range extension.',
    che_choices: ['No source publishes a trade rule: CHE enters on the first close beyond the balance between 10:30 and 12:00.', 'Stop at the middle of the balance, 2R target, flat at 15:55.'],
    timeframes: ['1m', '2m', '5m', '15m', '30m'], data_requirements: 'intraday bars covering 9:30–10:30 without gaps', event_dependencies: 'none stated',
    limitations: 'The "narrow balance extends, wide balance holds" tendencies are described as tendencies, not tested rules.' },
  { id: 'squeeze', name: 'Volatility squeeze release (TTM-style)', category: 'Volatility', engine_id: 'squeeze-5m', documented: 'RULES DOCUMENTED',
    sources: [src('LuxAlgo: TTM Squeeze', 'https://www.luxalgo.com/library/concept/ttm-squeeze/'), src('TradingView: TTM Squeeze Pro (open source)', 'https://www.tradingview.com/script/0drMdHsO-TTM-Squeeze-Pro')],
    rules: 'Squeeze while Bollinger Bands (20, 2σ) are inside Keltner Channels (20, 1.5 ATR); it fires on the first bar they are back outside; momentum gives the direction.',
    che_choices: ['Direction from the close against the 20-bar average, not Carter\'s momentum histogram.', 'At least 6 squeeze bars in a row.', 'Keltner basis is the 20-bar simple average with a 20-bar average true range.', 'Stop 1 tick beyond the 6-bar extreme; 2R target.'],
    timeframes: ['1m', '2m', '5m', '15m', '30m', '1h'], data_requirements: 'OHLC bars', event_dependencies: 'none stated',
    limitations: 'An approximation of the TTM Squeeze, not John Carter\'s indicator; no code was copied.' },
  { id: 'supertrend', name: 'Supertrend flip', category: 'Trend', engine_id: 'supertrend-5m', documented: 'RULES DOCUMENTED',
    sources: [src('TA-Lib: SUPERTREND function definition', 'https://ta-lib.org/functions/supertrend.html', 'reference')],
    rules: 'Median price ± multiplier × ATR; the bands ratchet toward price; the trend flips on a close through the active band. Defaults 10 and 3 (attributed to Olivier Seban).',
    che_choices: ['Entry on the flip close; stop 1 tick beyond the new line; 2R target (traders often exit on the opposite flip, not implemented).'],
    timeframes: ['1m', '2m', '5m', '15m', '30m', '1h'], data_requirements: 'OHLC bars', event_dependencies: 'none stated', limitations: 'A trend filter more than a complete strategy in its sources.' },
  { id: 'rsi2', name: 'RSI(2) pullback (Connors)', category: 'Reversal', engine_id: 'rsi2-connors', documented: 'RULES DOCUMENTED',
    sources: [src('LuxAlgo: RSI 2', 'https://www.luxalgo.com/library/concept/rsi-2/'), src('Backtrex: Connors RSI(2) on the Nasdaq 100', 'https://backtrex.com/en/backtests/connors-rsi-2-nasdaq-100')],
    rules: 'Long when the close is above the 200-day simple average and RSI(2) is below 10 (or 5); exit on a close above the 5-day average.',
    che_choices: ['The exit is approximated as a target at the 5-day average on the signal day (the engine exits on stop or target).', 'Stop 2 × ATR(14) below the signal close: Connors publishes no stop.'],
    timeframes: ['1D'], data_requirements: 'at least 200 daily bars', event_dependencies: 'none stated',
    limitations: 'Published tests on the Nasdaq 100 show a high win rate with small average wins and returns far below buy-and-hold over ten years.' },
  { id: 'donchian-20', name: '20-day breakout (Turtle System 1 entry)', category: 'Trend', engine_id: 'donchian-20', documented: 'RULES DOCUMENTED',
    sources: [src('MQL5: Automating the Original Turtle Trading Rules', 'https://www.mql5.com/en/articles/23448'), src('TradingView: Turtle Trading script (open source)', 'https://www.tradingview.com/script/jbyeMkat/')],
    rules: 'System 1: enter on a break of the prior 20-day high; initial stop 2N; exit on a 10-day low; skip a signal after a winning System 1 trade; pyramid every 0.5N up to four units.',
    che_choices: ['Entry on a daily close above the 20-day high (the Turtles entered on the touch).', '2R target instead of the 10-day-low exit; no skip rule, no shorts, no pyramiding.'],
    timeframes: ['1D'], data_requirements: 'daily bars', event_dependencies: 'none stated', limitations: 'Sources are secondary; Faith\'s book was not read. Only the entry and stop are the Turtle rules.' },
  { id: 'value-area-80', name: 'Market Profile 80% rule', category: 'Market profile', engine_id: null, documented: 'RULES DOCUMENTED',
    sources: [src('LuxAlgo: 80% Rule', 'https://www.luxalgo.com/library/concept/80-percent-rule/'), src('MetroTrade: the 80% rule in futures trading', 'https://www.metrotrade.com/what-is-the-80-rule-in-futures-trading/'), src('NexusFi: 80 percent rule', 'https://nexusfi.com/a/concepts/80-percent-rule')],
    rules: 'Open outside the prior day\'s value area, re-enter it and hold two consecutive 30-minute periods; target the other side of the value area; invalid if price leaves on the entry side.',
    che_choices: [], timeframes: ['30m'], data_requirements: 'the prior regular session\'s value area: a TPO profile from 30-minute bars, or volume at price', event_dependencies: 'none stated',
    limitations: 'The 80% figure is repeated by its sources, not tested; the origin is disputed (Dalton Profile Reports vs Steidlmayer).',
    not_running: 'Not implemented yet: CHE needs a value-area calculation (a TPO profile can be built from 30-minute bars). No result exists.' },
  { id: 'ict-2022', name: 'ICT 2022 mentorship model', category: 'ICT / SMC', engine_id: null, documented: 'RULES DOCUMENTED',
    sources: [src('LuxAlgo: Model 2022', 'https://www.luxalgo.com/library/concept/model-2022/')],
    rules: 'Liquidity raid of an old high or low, displacement that closes through the opposing swing (market structure shift), entry on the retracement into the fair value gap the displacement left; stop beyond the raid; target the opposite liquidity.',
    che_choices: [], timeframes: ['1m', '5m'], data_requirements: 'intraday bars plus a higher timeframe for the draw on liquidity', event_dependencies: 'killzone timing (London / New York morning)',
    limitations: 'Community shorthand rather than a formal specification; timeframes and the strictness of the shift vary; secondhand summaries only.',
    not_running: 'Not implemented as a whole: the higher-timeframe "draw on liquidity" and premium/discount filter are discretionary in the sources. CHE\'s existing sweep-then-structure-shift strategy covers the first two steps but not the gap entry.' },
  { id: 'judas-swing', name: 'Judas swing', category: 'ICT / SMC', engine_id: null, documented: 'DISCOVERED',
    sources: [src('TradingView: Judas Swing Detector (open source)', 'https://in.tradingview.com/script/fgkVI3nD-Judas-Swing-Detector-AGPro-Series/'), src('LuxAlgo: ICT Killzones', 'https://www.luxalgo.com/library/indicator/5zSOg8zv-ict-killzones/')],
    rules: null, assumptions: 'A false move at the London or New York open that traps traders before the session\'s real direction; often tied to the New York midnight open.',
    che_choices: [], timeframes: ['1m', '5m'], data_requirements: 'intraday bars', event_dependencies: 'session opens', limitations: 'Sources disagree on the killzone hours; none is ICT\'s own material.',
    not_running: 'No testable rule: which move counts as the swing and when it is confirmed is not defined in the sources.' },
  { id: 'power-of-three', name: 'Power of Three / AMD', category: 'ICT / SMC', engine_id: null, documented: 'DISCOVERED',
    sources: [src('LuxAlgo: Power of 3 ICT 01 (TradingFinder)', 'https://www.luxalgo.com/library/indicator/5thZ7SVC-power-of-3-ict-01-amd-ict-smc-accumulations/')],
    rules: null, assumptions: 'Accumulation, manipulation (a liquidity sweep), distribution; session windows differ by indicator author.',
    che_choices: [], timeframes: ['1D', '1h', '5m'], data_requirements: 'intraday bars', event_dependencies: 'session windows',
    limitations: 'The windows are each indicator author\'s choice. The owner\'s "AMD" identification is handled in the strategy library investigation.',
    not_running: 'No testable rule until the session windows and the sweep confirmation are chosen and written down.' },
  { id: 'breaker-block', name: 'Breaker block', category: 'ICT / SMC', engine_id: null, documented: 'DISCOVERED',
    sources: [src('FXNX: ICT mitigation vs breaker block', 'https://fxnx.com/en/blog/ict-mitigation-vs-breaker-block-trader-s-guide')],
    rules: null, assumptions: 'An order block that fails, price trades through it, structure breaks the other way and the failed block flips role.',
    che_choices: [], timeframes: ['5m', '15m'], data_requirements: 'intraday bars', event_dependencies: 'none stated', limitations: 'Described as discretionary by its own indicator authors.',
    not_running: 'No testable rule yet (what counts as failure and the flip is not defined).' },
  { id: 'mitigation-block', name: 'Mitigation block', category: 'ICT / SMC', engine_id: null, documented: 'DISCOVERED',
    sources: [src('FXNX: ICT mitigation vs breaker block', 'https://fxnx.com/en/blog/ict-mitigation-vs-breaker-block-trader-s-guide')],
    rules: null, assumptions: 'The last opposing candle before a market structure shift that followed a failure to make a new extreme.',
    che_choices: [], timeframes: ['5m', '15m'], data_requirements: 'intraday bars', event_dependencies: 'none stated', limitations: 'Two sources describe it differently.',
    not_running: 'No testable rule yet.' },
  { id: 'ifvg', name: 'Inverse fair value gap (IFVG)', category: 'ICT / SMC', engine_id: null, documented: 'DISCOVERED',
    sources: [], rules: null, assumptions: 'Named by the owner\'s request. The sources searched on 2026-10-23 contained no definition.',
    che_choices: [], timeframes: [], data_requirements: 'unknown', event_dependencies: 'unknown', limitations: 'No definition found.',
    not_running: 'No definition found; CHE does not guess one.' },
  { id: 'smt-divergence', name: 'SMT divergence (NQ vs ES)', category: 'ICT / SMC', engine_id: null, documented: 'RULES DOCUMENTED',
    sources: [src('El Trader Financiado: SMT divergence', 'https://www.eltraderfinanciado.com/en/blog/smt-divergence')],
    rules: 'Non-confirmation between correlated instruments: NQ makes a new high while ES does not (or the reverse at lows); used as confirmation inside sweep → structure shift → entry.',
    che_choices: [], timeframes: ['1m', '5m'], data_requirements: 'time-aligned ES (or YM) bars beside NQ', event_dependencies: 'none stated',
    limitations: 'Its own source says no public statistic exists for it.',
    not_running: 'Requires data CHE does not have yet: CHE\'s research datasets are MNQ and NQ only; ES bars are not acquired.' },
  { id: 'london-sweep-ny-reversal', name: 'Asia range, London sweep, New York reversal', category: 'Overnight liquidity', engine_id: null, documented: 'RULES DOCUMENTED',
    sources: [src('Tradezella: NQ liquidity sweep reversal scalping strategy', 'https://www.tradezella.com/strategies/nq-liquidity-sweep-reversal-scalping-strategy'), src('TradingView: Session Sweep Reversal Predictor (open source)', 'https://id.tradingview.com/script/O148939n-Session-Sweep-Reversal-Predictor-PhenLabs/')],
    rules: 'Asia builds a range, London sweeps one side, New York trades toward the other side, confirmed by displacement after the sweep.',
    che_choices: [], timeframes: ['5m'], data_requirements: 'overnight intraday bars (Globex)', event_dependencies: 'session opens',
    limitations: 'The cited indicator states it makes no performance claim. Overnight range models such as the P2P 86 model are researched in their own lane.',
    not_running: 'Not implemented yet: the Asia window and the displacement threshold must be chosen; CHE\'s previous-day high/low sweep is the nearest tested rule.' },
  { id: 'delta-divergence', name: 'Delta divergence', category: 'Order flow', engine_id: null, documented: 'RULES DOCUMENTED', order_flow: true,
    sources: [src('LuxAlgo: Footprint concepts', 'https://www.luxalgo.com/library/concept/footprint-concepts/'), src('Finowings: order flow analysis, footprint and delta', 'https://www.finowings.com/Trading/order-flow-analysis-footprint-delta')],
    rules: 'Price makes a new high (low) while cumulative delta (aggressive buy minus sell volume) does not; read as weakening initiative.',
    che_choices: [], timeframes: ['1m', '5m'], data_requirements: 'per-trade aggressor side (buy/sell volume) for every bar', event_dependencies: 'none stated',
    limitations: 'Thresholds vary by source; no tested statistic.' },
  { id: 'absorption', name: 'Absorption', category: 'Order flow', engine_id: null, documented: 'RULES DOCUMENTED', order_flow: true,
    sources: [src('LuxAlgo: Footprint concepts', 'https://www.luxalgo.com/library/concept/footprint-concepts/')],
    rules: 'Heavy aggressive volume that fails to move price because passive orders absorb it; often before a reversal.',
    che_choices: [], timeframes: ['1m'], data_requirements: 'per-trade aggressor side and volume per bar', event_dependencies: 'none stated', limitations: 'Definitions and thresholds vary by source.' },
  { id: 'stacked-imbalance', name: 'Stacked imbalances', category: 'Order flow', engine_id: null, documented: 'RULES DOCUMENTED',
    sources: [src('NexusFi: advanced footprint chart patterns', 'https://nexusfi.com/a/strategies/advanced-footprint-chart-patterns')],
    rules: 'Runs of consecutive price levels where one side dominates by a set ratio, treated as support or resistance on a retest.',
    che_choices: [], timeframes: ['1m'], data_requirements: 'bid and ask volume at every price level inside each bar (a footprint)', event_dependencies: 'none stated',
    limitations: 'The 48% win rate quoted by one source is unverified.',
    not_running: 'Requires data CHE does not have: the Rithmic recorder keeps per-minute aggressor delta, not volume at each price level.' },
  { id: 'volatility-breakout', name: 'Volatility breakout (Larry Williams)', category: 'Volatility', engine_id: null, documented: 'RULES DOCUMENTED',
    sources: [src('LuxAlgo: Volatility Breakout', 'https://www.luxalgo.com/library/concept/volatility-breakout/'), src('TradingView: volatility breakout script (open source)', 'https://kr.tradingview.com/script/P8cxeiJy')],
    rules: 'Buy stop above the open and sell stop below it, each a multiple of the prior session\'s range; the first fill sets the direction.',
    che_choices: [], timeframes: ['5m', '1D'], data_requirements: 'intraday bars (a stop entry cannot be filled honestly on daily bars)', event_dependencies: 'none stated',
    limitations: 'Williams\' own multiplier was not found in a primary source (secondary sources say 0.25–0.5).',
    not_running: 'Not implemented: the multiplier and which open (Globex 18:00 or 9:30) must be chosen first.' },
  { id: 'gap-fill', name: 'Regular-session gap fill', category: 'Reversal', engine_id: null, documented: 'RULES DOCUMENTED',
    sources: [src('Edgeful: gap fill report', 'https://www.edgeful.com/blog/posts/gap-fill-report'), src('TradingView: Gap Fill Engine ES/NQ (open source)', 'https://www.tradingview.com/script/7BvtpuGK-Gap-Fill-Engine-ES-NQ/')],
    rules: 'Gap = regular-session open minus the prior regular-session close; the fill target is the prior close (or half of the gap).',
    che_choices: [], timeframes: ['5m'], data_requirements: 'intraday bars with the 16:00 close and the 9:30 open', event_dependencies: 'overnight news and data releases move gaps',
    limitations: 'The published fill rates are vendor figures without audited data.',
    not_running: 'Not implemented yet: entry timing and the stop must be chosen; no source gives them.' },
  { id: 'vix-regime', name: 'VIX / VXN volatility regime', category: 'Market context', engine_id: null, documented: 'RULES DOCUMENTED', context_model: true,
    sources: [src('QuantRocket: VIX research notebook', 'https://www.quantrocket.com/codeload/first-last/first_last/Part4-VIX-Research.ipynb'), src('Substack: VIX regime filter on ES/NQ/RTY (self-reported)', 'https://algotr.substack.com/p/stop-leaving-money-on-the-table-a')],
    rules: 'Classify each signal by the volatility index level or its percentile band and compare results per band; a filter, not a trigger.',
    che_choices: [], timeframes: ['1D'], data_requirements: 'daily VIX or VXN (VXN is the Nasdaq-100 measure)', event_dependencies: 'macro events move the index',
    limitations: 'Thresholds found are for VIX (S&P 500) and do not transfer to VXN without their own test.',
    not_running: 'Requires data CHE does not have yet: no VIX or VXN series is acquired. CHE\'s own ATR volatility regime is measured on every backtest meanwhile.' },
]);

const ORDER_FLOW_MIN_SESSIONS = 20; // CHE's floor before a first order-flow backtest (one trading month); not sufficiency

/** Recorded order-flow sessions: MNQ 1-minute bars from Rithmic that carry an aggressor `delta`. */
export async function orderFlowReadiness(storage) {
  const ds = await loadDataset(storage, 'MNQ', '1m').catch(() => null);
  const bars = ds?.bars || [];
  const rithmic = /rithmic/i.test(String(ds?.manifest?.provider || ''));
  const days = new Set();
  if (rithmic) for (const b of bars) if (Number.isFinite(b.delta)) days.add(etParts(b.t).day);
  const sorted = [...days].sort();
  return {
    sessions: sorted.length, first_session: sorted[0] || null, last_session: sorted.at(-1) || null, required: ORDER_FLOW_MIN_SESSIONS,
    ready: sorted.length >= ORDER_FLOW_MIN_SESSIONS,
    status: sorted.length ? `Rithmic order-flow data recorded since ${sorted[0]}: ${sorted.length} of ${ORDER_FLOW_MIN_SESSIONS} sessions needed before a first backtest.`
      : 'No recorded Rithmic order-flow session is stored yet. Recording starts when the phone streams real Rithmic trades; a backtest needs at least 20 sessions.',
  };
}

/** Where CHE could get NQ/MNQ history, as researched on 2026-10-23. Nothing paid or signed up for without the owner. */
export const DATA_SOURCE_FINDINGS = Object.freeze([
  { source: 'Yahoo Finance chart API (in use)', cost: 'free', depth: '1-minute 7 days, 2–30-minute 59 days, hourly 729 days, daily decades', terms: 'public, delayed; CHE labels it DELAYED and never live', status: 'in use' },
  { source: 'Rithmic ticker plant (owner\'s login, on the iPhone)', cost: 'included with the owner\'s account', depth: 'forward only: no history plant in CHE', terms: 'owner\'s Rithmic and prop-firm agreements', status: 'forward recording (real trades and per-minute delta)' },
  { source: 'Databento historical (CME Globex)', cost: '$125 of free credits for a new account, then usage-priced', depth: 'years of CME history', terms: 'separate personal/commercial terms; CME external redistribution needs vendor registration', url: 'https://databento.com/pricing', status: 'not used: needs the owner to open an account and accept its terms' },
  { source: 'FirstRate Data NQ', cost: 'free sample; full set about $300–$400', depth: '2008 onward, 1-minute', terms: 'licence terms not read', url: 'https://firstratedata.com/i/futures/NQ', status: 'not used: paid' },
  { source: 'MarketParquet', cost: 'free tier: last 30 days intraday, 5 downloads a day', depth: '30 days free', terms: 'licence terms not read', url: 'https://marketparquet.com/data/futures', status: 'not used: terms unread' },
  { source: 'Barchart', cost: 'paid membership', depth: '1-minute 10 years', terms: 'membership terms', url: 'https://www.barchart.com/futures/quotes/NQ*0/price-history/download', status: 'not used: paid' },
]);

// ─── Lifecycle stage of every strategy, from stored evidence ───────────────────

function stageOf({ engineId, documented, units, forward, paperActive }) {
  if (!engineId) return documented;
  if (paperActive.has(engineId)) return 'PAPER ACTIVE';
  if (forward.some((f) => f.strategy_id === engineId && f.mode === 'PAPER' && f.trades > 0)) return 'FORWARD TESTED';
  if (units.some((u) => u.ok && u.strategy_id === engineId && u.all?.trades > 0)) return 'BACKTESTED';
  return 'IMPLEMENTED';
}

/** Every strategy and market-context model CHE knows, each with its stage, and the counts per stage. */
export async function strategyLibrary(storage) {
  const [units, forward, controls, live, flow] = await Promise.all([readUnits(storage), forwardEvidence(storage), readControls(storage), storage.get('live_paper_state'), orderFlowReadiness(storage)]);
  // Paper active: the live paper loop is switched on and the owner has not paused or disabled the strategy.
  const paperActive = new Set(live?.enabled ? Object.keys(INTRADAY_CANDIDATES).filter((id) => !controls.strategies[id]?.disabled && !controls.strategies[id]?.paused && !controls.paused_all) : []);
  const catalogByEngine = new Map(RESEARCH_CATALOG.filter((e) => e.engine_id).map((e) => [e.engine_id, e]));
  const entries = [];
  for (const d of strategyDefinitions()) {
    const cat = catalogByEngine.get(d.strategy_id);
    const stage = stageOf({ engineId: d.strategy_id, documented: 'RULES DOCUMENTED', units, forward, paperActive });
    const mine = units.filter((u) => u.ok && u.strategy_id === d.strategy_id);
    entries.push({
      id: d.strategy_id, name: d.name, category: cat?.category || d.family || 'Other', stage, engine_id: d.strategy_id, research: Boolean(d.research),
      sources: cat?.sources || [{ title: 'CHE written rules (trading_evidence.js)', url: null, accessed: null, kind: 'che' }],
      rules: d.entry_rule, che_choices: cat?.che_choices || [], timeframes: d.timeframes, data_requirements: d.data_requirements, event_dependencies: cat?.event_dependencies || 'none stated',
      limitations: cat?.limitations || null,
      results: mine.map((u) => ({ market: u.market, timeframe: u.timeframe, trades: u.all.trades, oos_trades: u.oos.trades, expectancy_r: u.all.expectancy_r, oos_expectancy_r: u.oos.expectancy_r, dataset: { first: u.dataset.first, last: u.dataset.last, provider: u.dataset.provider } })),
      not_running: stage === 'PAPER ACTIVE' ? null : d.research ? d.paper : live?.enabled ? 'paused or disabled in the owner\'s controls' : 'the live paper loop is switched off',
    });
  }
  for (const u of UNDEFINED_STRATEGIES) entries.push({ id: u.strategy_id, name: u.name, category: 'Other', stage: 'DISCOVERED', engine_id: null, sources: [], rules: null, not_running: u.why });
  for (const e of RESEARCH_CATALOG.filter((x) => !x.engine_id)) {
    const flowNote = e.order_flow ? `Requires per-trade aggressor data. ${flow.status}` : null;
    entries.push({ id: e.id, name: e.name, category: e.category, stage: e.documented, engine_id: null, context_model: Boolean(e.context_model), sources: e.sources, rules: e.rules, assumptions: e.assumptions || null,
      che_choices: e.che_choices, timeframes: e.timeframes, data_requirements: e.data_requirements, event_dependencies: e.event_dependencies, limitations: e.limitations, results: [],
      not_running: flowNote || e.not_running, ...(e.order_flow ? { order_flow: flow } : {}) });
  }
  const counts = Object.fromEntries(STAGES.map((s) => [s, entries.filter((e) => e.stage === s).length]));
  // Cumulative: a backtested strategy is also implemented and documented.
  const reached = (s) => entries.filter((e) => STAGES.indexOf(e.stage) >= STAGES.indexOf(s)).length;
  return {
    as_of: new Date().toISOString(), entries, counts,
    totals: { available: entries.length, documented: reached('RULES DOCUMENTED'), implemented: reached('IMPLEMENTED'), backtested: reached('BACKTESTED'), forward_tested: reached('FORWARD TESTED'), paper_active: reached('PAPER ACTIVE'),
      strategies: entries.filter((e) => !e.context_model).length, market_context_models: entries.filter((e) => e.context_model).length },
    order_flow: flow, data_sources: DATA_SOURCE_FINDINGS,
    note: 'Stages come from stored evidence: BACKTESTED means a stored research result with trades, FORWARD TESTED means real-time paper trades in the journal, PAPER ACTIVE means the live paper loop is on and the strategy is not paused. Market-context models (event calendars, regimes) are added by their own lane.',
  };
}

// ─── Comparison on the same dataset ─────────────────────────────────────────────

const pick = (s) => (s ? { trades: s.trades, expectancy_r: s.expectancy_r, win_rate: s.win_rate, pf: s.pf, max_dd_r: s.max_dd_r, ci: s.expectancy_ci || null } : null);

/** What the sample can and cannot say, after costs. */
export function verdictOf(s, min = MIN_CLOSED_TRADES) {
  if (!s || !s.trades) return 'no trades';
  if (s.trades < min) return `insufficient evidence (${s.trades} trades; ${min} needed)`;
  if (s.expectancy_ci?.low > 0) return 'positive after costs (95% interval above zero)';
  if (s.expectancy_ci?.high < 0) return 'negative after costs (95% interval below zero)';
  return 'not distinguishable from zero after costs';
}

function overfitWarning(u) {
  const tr = u.train; const oo = u.oos;
  if (!oo?.trades) return 'no out-of-sample trades: the result is in-sample only';
  if (oo.trades < 15) return `only ${oo.trades} out-of-sample trades: too few to confirm the in-sample result`;
  if (tr?.expectancy_r > 0 && oo.expectancy_r <= 0) return 'in-sample positive but out-of-sample not: likely overfit or decayed';
  if (tr?.expectancy_r > 0 && oo.expectancy_r < tr.expectancy_r / 2) return 'out-of-sample result is under half of in-sample';
  return null;
}

/** Trades of a unit by event tag of their New York trade date. `tagsByDay` maps 'YYYY-MM-DD' to tags. */
function eventBuckets(trades, tagsByDay) {
  const groups = {};
  for (const t of trades) {
    const tags = tagsByDay[etParts(t.t).day];
    for (const tag of tags?.length ? tags : ['no listed event']) (groups[tag] ||= []).push(t.r);
  }
  return Object.entries(groups).map(([key, rs]) => {
    const n = rs.length; const mean = rs.reduce((a, b) => a + b, 0) / n;
    const sd = n > 1 ? Math.sqrt(rs.reduce((a, r) => a + (r - mean) ** 2, 0) / (n - 1)) : 0;
    const half = n > 1 ? (1.96 * sd) / Math.sqrt(n) : 0;
    return { key, trades: n, expectancy_r: Math.round(mean * 1e4) / 1e4, expectancy_ci: { low: Math.round((mean - half) * 1e4) / 1e4, high: Math.round((mean + half) * 1e4) / 1e4 } };
  }).sort((a, b) => b.trades - a.trades);
}

/**
 * Same-period comparison of stored or fresh evidence units. Only units on the same dataset (sha256) are compared; the
 * rest are listed as excluded with the reason. Conditions name a best strategy only when it has enough trades in that
 * condition and its interval is above zero after costs.
 */
export function compareUnits(units, { tagsByDay = null, minBucket = MIN_CLOSED_TRADES } = {}) {
  const ok = units.filter((u) => u?.ok);
  if (!ok.length) return { ok: false, reason: 'No backtest results to compare yet.' };
  const bySha = {};
  for (const u of ok) (bySha[u.dataset?.sha256 || 'unknown'] ||= []).push(u);
  const [sha, same] = Object.entries(bySha).sort((a, b) => b[1].length - a[1].length)[0];
  const excluded = ok.filter((u) => (u.dataset?.sha256 || 'unknown') !== sha).map((u) => ({ strategy_id: u.strategy_id, timeframe: u.timeframe, reason: 'a different dataset or period' }));
  const rows = same.map((u) => ({
    strategy_id: u.strategy_id, name: definitionOf(u.strategy_id)?.name || u.strategy_id, research: Boolean(definitionOf(u.strategy_id)?.research), timeframe: u.timeframe, market: u.market,
    all: pick(u.all), in_sample: pick(u.train), out_of_sample: pick(u.oos), folds_positive: u.folds_positive, folds_total: u.folds_total,
    stress_expectancy_r: u.stress?.expectancy_r ?? null, look_ahead: u.look_ahead, verdict: verdictOf(u.all), oos_verdict: verdictOf(u.oos, 15), overfit_warning: overfitWarning(u),
    trades_kept: u.trades?.length || 0,
  })).sort((a, b) => (b.out_of_sample?.expectancy_r ?? -9) - (a.out_of_sample?.expectancy_r ?? -9));
  const dims = { sessions: 'session', regimes: 'market structure', volatility: 'volatility regime' };
  const conditions = [];
  for (const [field, label] of Object.entries(dims)) {
    const keys = new Set(same.flatMap((u) => (u[field] || []).map((b) => b.key)));
    for (const key of keys) {
      const cands = same.map((u) => ({ u, b: (u[field] || []).find((x) => x.key === key) })).filter((x) => x.b);
      const enough = cands.filter((x) => x.b.trades >= minBucket);
      const positive = enough.filter((x) => x.b.expectancy_ci?.low > 0).sort((a, b) => b.b.expectancy_r - a.b.expectancy_r);
      conditions.push({ dimension: label, condition: key, strategies_with_enough_trades: enough.length,
        best: positive[0] ? { strategy_id: positive[0].u.strategy_id, trades: positive[0].b.trades, expectancy_r: positive[0].b.expectancy_r, ci: positive[0].b.expectancy_ci } : null,
        answer: positive[0] ? `${definitionOf(positive[0].u.strategy_id)?.name || positive[0].u.strategy_id}: ${positive[0].b.trades} trades, ${positive[0].b.expectancy_r} R per trade after costs`
          : enough.length ? 'no strategy is positive after costs here' : `insufficient evidence (no strategy has ${minBucket} trades here)` });
    }
  }
  let events = { available: false, reason: 'No event calendar is connected to the comparison yet (the market-context lane adds it).' };
  if (tagsByDay) {
    events = { available: true, by_strategy: same.map((u) => ({ strategy_id: u.strategy_id, based_on: `${u.trades?.length || 0} of ${u.all.trades} trades (the newest kept)`, buckets: eventBuckets(u.trades || [], tagsByDay).map((b) => ({ ...b, verdict: verdictOf(b, minBucket) })) })) };
  }
  const d = same[0].dataset || {};
  return {
    ok: true, same_period: { sha256: sha, provider: d.provider, first: d.first, last: d.last, bars: d.bars, proxy: d.proxy || null }, rows, excluded, conditions, events,
    multiple_comparisons: `${rows.length} strategies are compared on one period: the best in-sample result is partly luck. Judge them by out-of-sample results and intervals, not the top rank.`,
    assumptions: marketSpec(), live_trading: 'disabled',
  };
}

/** Fresh comparison from bars (tests, and the local research script). Every eligible strategy runs on the same bars. */
export function compareStrategies({ market = 'MNQ', tf, bars, manifest, strategyIds = null, profile = 'NORMAL', tagsByDay = null }) {
  const defs = strategyDefinitions().filter((d) => d.timeframes.includes(tf) && (!strategyIds || strategyIds.includes(d.strategy_id)));
  const units = defs.map((d) => evaluateUnit({ strategyId: d.strategy_id, market, tf, bars, manifest, profile, keepTrades: Infinity }));
  const gaps = missingBars(bars, tf);
  const out = compareUnits(units, { tagsByDay });
  return { ...out, data_limitations: { provider: manifest?.provider || null, bars: bars.length, missing: gaps, delayed: /yahoo/i.test(String(manifest?.provider || '')) ? 'Yahoo bars are delayed and limited in depth (5-minute: about 59 days).' : null } };
}

/** API view: the stored research results for one market and timeframe, compared on their shared dataset. */
export async function comparisonView(storage, { market = 'MNQ', tf = '5m', ids = null } = {}) {
  const units = await readUnits(storage, (u) => (u.mode || 'BACKTEST') === 'BACKTEST' && u.market === market && u.timeframe === tf && (!ids || ids.includes(u.strategy_id)));
  const out = compareUnits(units);
  return { market, timeframe: tf, ...out };
}
