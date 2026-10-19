// Knowledge Atlas trading cards (owner issue #346, phase 2, trading lane): futures, stocks,
// options, market mechanics, ICT/SMC concepts and the statistics of judging a strategy. The cards
// use the phase-1 card shape (knowledge_atlas.js) plus `limitations`; every formula is computed
// by atlas_math.js, and every worked example is an educational example with made-up numbers.
//
// The chat answers here are calculations and readings of CHE's own records, with no model call.
// Each number from a record carries its provenance: educational example, historical backtest,
// delayed forward-paper data, broker SIM or live orders. Records are only read. Nothing here
// places, prepares or changes an order, the desk or paper trading, and nothing reaches a broker.
import {
  FUTURES_SPECS, SPEC_SOURCE, VERDICT_RULES, bookFill, candleAnatomy, costInR, expectancyStats, fairValueGaps, futuresRisk,
  liquiditySweeps, losingStreaks, maxDrawdown, monteCarlo, multipleComparisons, num, openingRange, optionAtExpiry, orderBlock, paperFill,
  pct, performanceBreakdown, positionSize, premiumDiscount, relativeVolume, rewardRisk, riskOfRuin, sampleSizeForMargin, sessionLevels, specOf,
  stockShares, strategyVerdict, structureBreaks, usd, volumeProfile, vwapBands, winRateInterval,
} from './atlas_math.js';
import { CANDIDATES, INTRADAY_CANDIDATES, MIN_TRADES, readTrades, summarize, tradeDayOf } from './trading_evidence.js';
import { readDesk } from './trading_desk.js';
import { LIVE_BACKTEST, LIVE_FEED, LIVE_STATE } from './trading_live.js';
import { ORDER_ASK } from './trading_live_chat.js';
import { withoutProhibitions } from './owner_action_gate.js';

// ─── Provenance: one label for every number from a record ────────────────

export const PROVENANCE = Object.freeze({
  example: 'educational example',
  backtest: 'historical backtest',
  paper: 'delayed forward-paper data',
  sim: 'broker SIM',
  live: 'live orders',
});
const EXAMPLE_LABEL = 'Educational example, made-up numbers, not market data';

// ─── Formulas, as the phase-1 atlas registers them: inputs in, the headline number out ─

const headline = (calc) => (inputs) => {
  const out = calc(inputs);
  if (!out.ok) throw new Error(`${out.name}: ${out.error}`);
  return out.value;
};
const CALCS = {
  tFuturesRisk: futuresRisk, tPositionSize: positionSize, tRewardRisk: rewardRisk, tStockShares: stockShares, tOption: optionAtExpiry,
  tBookFill: bookFill, tCostInR: costInR, tVwapBands: vwapBands, tOpeningRange: openingRange, tSessionLevels: sessionLevels,
  tCandle: candleAnatomy, tFvg: fairValueGaps, tStructure: structureBreaks, tSweeps: liquiditySweeps, tOrderBlock: orderBlock,
  tRelVolume: relativeVolume, tVolumeProfile: volumeProfile, tLosingStreaks: losingStreaks, tMultipleComparisons: multipleComparisons,
  tPaperFill: paperFill, tPerformance: performanceBreakdown,
  tPremiumDiscount: premiumDiscount, tWinRate: winRateInterval, tExpectancy: expectancyStats, tMaxDrawdown: maxDrawdown,
  tSampleSize: sampleSizeForMargin, tMonteCarlo: monteCarlo, tRiskOfRuin: riskOfRuin,
};
export const TRADING_FORMULAS = Object.freeze(Object.fromEntries(Object.entries(CALCS).map(([k, f]) => [k, headline(f)])));

// ─── The cards ────────────────────────────────────────────────────────────

const ref = (title, author, url = '') => Object.freeze({ title, author, url, license: 'reference link only; card text is original', text_scope: 'own-words summary' });
const CHE_CODE = (file) => ref(`CHE source: server/cloudflare/${file}`, 'CHE repository', '');
const CME = (s) => ref(`CME Group: ${s.name} contract specs`, 'CME Group', s.url);
const SMC = ref('ICT and smart money concepts: practitioner teaching, not peer-reviewed research', 'Inner Circle Trader (Michael J. Huddleston) and others');
const LO_MAMAYSKY_WANG = ref('Foundations of Technical Analysis (Journal of Finance, 2000)', 'Andrew W. Lo, Harry Mamaysky and Jiang Wang', 'https://doi.org/10.1111/0022-1082.00265');
const PARDO = ref('The Evaluation and Optimization of Trading Strategies', 'Robert Pardo');
const BAILEY = ref('The Probability of Backtest Overfitting', 'David H. Bailey, Jonathan M. Borwein, Marcos López de Prado and Qiji Jim Zhu');
const VINCE = ref('The Mathematics of Money Management', 'Ralph Vince');
const ICT_LIMIT = 'A discretionary concept with mixed or limited evidence: definitions differ between teachers, the same chart can be labelled more than one way, and no peer-reviewed study shows it is an edge by itself. CHE treats it as a hypothesis to test on recorded trades, never as a reason to trade.';

// Steps come from the calculator itself, so the words always match the arithmetic; `result` is
// written out by hand and the tests check the calculator against it.
const numeric = (compute, inputs, result, unit) => {
  const out = CALCS[compute](inputs);
  if (!out.ok) throw new Error(`${compute} example: ${out.error}`);
  return { kind: 'numeric', provenance: PROVENANCE.example, inputs, compute, result, unit, steps: [EXAMPLE_LABEL, ...out.steps] };
};
const formula = (name, expression, spoken, variables, assumptions, compute, inputs, result) => ({
  name, expression, spoken, variables: variables.map(([symbol, meaning, unit]) => ({ symbol, meaning, unit })), assumptions, compute, example: { inputs, result },
});
const card = (c) => Object.freeze({ revision: 1, source_kind: 'curated', formula: null, che_note: '', measured: null, misconceptions: [], ...c });
// A card's formula and its worked example share their inputs and result.
const calcCard = ({ compute, inputs, result, unit, f, ...c }) => card({ ...c, formula: formula(...f, compute, inputs, result), example: numeric(compute, inputs, result, unit) });

const S = FUTURES_SPECS;
const bar = (t, o, h, l, c, v) => ({ t, o, h, l, c, v });
const ohlc = (o, h, l, c) => ({ o, h, l, c });

const CARDS = [
  calcCard({
    id: 't-futures', domain: 'trading', title: 'Index futures: NQ, MNQ, ES and MES', level: 'beginner',
    summary: 'Contracts on the Nasdaq-100 and S&P 500 indexes: the specs, the trading hours, margin and the quarterly roll.',
    aliases: ['nq and mnq', 'nq mnq', 'es and mes', 'nq contract', 'mnq contract', 'es contract', 'mes contract', 'equity index futures', 'e mini futures', 'micro e mini', 'margin call', 'initial margin', 'maintenance margin', 'contract rollover', 'quarterly roll', 'cme trading hours'],
    tags: ['futures', 'fundamentals', 'contract specs'], prerequisites: ['tick-value'], related: ['risk-management', 't-order-types', 't-session-levels'],
    levels: {
      beginner: 'A futures contract is an agreement to buy or sell an index at a set price on a future date, traded on an exchange. NQ and its micro MNQ follow the Nasdaq-100; ES and its micro MES follow the S&P 500. Each micro is one tenth of the full contract, so it is the same market with a tenth of the dollars per point.',
      intermediate: `Per CME: NQ is $${S.NQ.pointValue} a point and MNQ $${S.MNQ.pointValue}; ES is $${S.ES.pointValue} a point and MES $${S.MES.pointValue}. All four move in 0.25-point ticks, so a tick is $${S.NQ.tickValue.toFixed(2)}, $${S.MNQ.tickValue.toFixed(2)}, $${S.ES.tickValue.toFixed(2)} and $${S.MES.tickValue.toFixed(2)}. They trade Sunday to Friday from 6 p.m. to 5 p.m. New York time, with a one-hour break each afternoon. Margin is a good-faith deposit, not the price: the exchange sets a minimum and the broker can ask for more.`,
      expert: 'Contracts expire quarterly, in March, June, September and December, and settle in cash; most volume moves to the next contract about a week before expiry, so a chart that splices contracts has a jump at each roll unless it is back-adjusted. Initial margin opens a position and maintenance margin keeps it open; a fall below maintenance brings a margin call or a forced exit. Notional value, index level × point value, is the real exposure, so a small margin controls a large position. Specs, hours and margins change: check the exchange before trading.',
    },
    analogy: 'A micro and a full contract are like a cup and a jug filled from the same barrel: the water is the same, only how much you carry changes.',
    che_note: `CHE's paper engine trades MNQ only, on delayed data, with the specs in trading_evidence.js; the table here also holds NQ, ES and MES. ${SPEC_SOURCE.caveat}`,
    compute: 'tFuturesRisk', inputs: { symbol: 'MNQ', contracts: 2, stopPoints: 12 }, result: 48, unit: '$',
    f: ['Dollar risk of a futures position', 'risk = stop points × point value × contracts', 'the risk equals the stop distance in points, times the dollars per point, times the number of contracts',
      [['stop points', 'distance from entry to stop', 'index points'], ['point value', 'NQ $20, MNQ $2, ES $50, MES $5 per point per contract (CME)', '$ per point'], ['contracts', 'how many contracts', 'a count']],
      'The stop fills at its price; gaps and slippage make the real loss bigger. Commissions and fees come on top and are added only when you give them.'],
    quiz: [
      { q: 'What does a 10-point stop risk on 1 NQ?', a: '$200: 10 points × $20.', check: { compute: 'tFuturesRisk', inputs: { symbol: 'NQ', contracts: 1, stopPoints: 10 }, result: 200, shown: ['$200'] } },
      { q: 'What does an 8-point stop risk on 3 MES?', a: '$120: 8 × $5 × 3.', check: { compute: 'tFuturesRisk', inputs: { symbol: 'MES', contracts: 3, stopPoints: 8 }, result: 120, shown: ['$120'] } },
      { q: 'Is futures margin the cost of the trade?', a: 'No. It is a good-faith deposit; the profit or loss is points × point value × contracts, and can be far bigger than the margin.' },
    ],
    misconceptions: ['A low margin is not a low risk: one NQ at 21,000 controls about $420,000 of the index, whatever the margin.'],
    limitations: ['Specs, trading hours and margins are set by CME and the broker and can change: verify against the exchange before trading.', 'The calculation assumes the stop fills at its price; fast markets and gaps fill worse.'],
    sources: [CME(S.NQ), CME(S.MNQ), CME(S.ES), CME(S.MES), ref('Futures contract', 'Wikipedia', 'https://en.wikipedia.org/wiki/Futures_contract'), CHE_CODE('atlas_math.js')],
  }),
  calcCard({
    id: 't-order-types', domain: 'trading', title: 'Order types and bracket orders', level: 'beginner',
    summary: 'Market, limit, stop and stop-limit orders, and brackets that attach a stop and a target.',
    aliases: ['order types', 'order type', 'types of orders', 'market order', 'market orders', 'limit order', 'limit orders', 'stop order', 'stop orders', 'stop limit', 'stop limit order', 'bracket order', 'bracket orders', 'oco', 'oco order', 'one cancels the other'],
    tags: ['execution', 'fundamentals'], prerequisites: ['bid-ask-spread', 'r-multiple'], related: ['t-order-book', 'risk-management', 't-futures'],
    levels: {
      beginner: 'A market order fills now at the best price available. A limit order fills only at your price or better, so it may not fill. A stop order waits until price reaches a level, then becomes a market order; it is how a stop-loss gets you out. A bracket sends an entry with a stop and a target attached.',
      intermediate: 'A stop-limit becomes a limit order when its stop price trades, so it controls the fill price but can be skipped entirely in a fast move, which is dangerous for a protective stop. In a bracket the stop and the target are one-cancels-other (OCO): when one fills, the other is cancelled. The plan\'s reward-to-risk is the target distance divided by the stop distance.',
      expert: 'Market and stop orders pay the spread and slippage; limit orders earn the spread but face adverse selection, filling most often when price is about to go through them. Exchanges protect market orders with price bands, and brokers may simulate stop or OCO orders on their own servers, so the order type you choose and where it lives change what happens in a gap or an outage. Test the fill model you assume.',
    },
    analogy: 'A limit order is like a standing offer on a house at your price: you may get it, or the house sells to someone else. A market order is like paying the asking price today.',
    che_note: 'Lessons never place or prepare orders. CHE\'s paper engine enters at the next bar open with a market fill plus assumed slippage (trading_evidence.js).',
    compute: 'tRewardRisk', inputs: { symbol: 'MNQ', side: 'long', entry: 18000, stop: 17990, target: 18030 }, result: 3, unit: 'ratio',
    f: ['Reward-to-risk of a bracket', 'reward ÷ risk = |target − entry| ÷ |entry − stop|;  break-even win rate = risk ÷ (risk + reward)', 'reward to risk equals the target distance divided by the stop distance, and the break-even win rate equals the risk divided by risk plus reward',
      [['entry', 'the entry price', 'price'], ['stop', 'the protective stop', 'price'], ['target', 'the profit target', 'price']],
      'Fills exactly at entry, stop and target; the trade ends at one of them. Costs and slippage raise the break-even win rate.'],
    quiz: [
      { q: 'A short enters at 100 with a stop at 102 and a target at 94. What is the reward to risk?', a: '3 to 1: 6 points of reward on 2 points of risk.', check: { compute: 'tRewardRisk', inputs: { side: 'short', entry: 100, stop: 102, target: 94 }, result: 3, shown: ['3 to 1'] } },
      { q: 'Which order can be skipped entirely in a fast market, a stop or a stop-limit?', a: 'A stop-limit: once triggered it is a limit order and may not fill.' },
      { q: 'In a bracket, what happens to the target when the stop fills?', a: 'It is cancelled: the stop and target are one-cancels-other.' },
    ],
    misconceptions: ['A stop order does not guarantee its price: once triggered it fills at the market, which can be worse.'],
    limitations: ['Order behaviour differs by exchange and broker, especially for simulated stops and OCO links; read the broker\'s rules.', 'A 3-to-1 plan says nothing about how often the target is reached.'],
    sources: [ref('Order (exchange)', 'Wikipedia', 'https://en.wikipedia.org/wiki/Order_(exchange)'), CME(S.MNQ), CHE_CODE('atlas_math.js')],
  }),
  calcCard({
    id: 't-order-book', domain: 'trading', title: 'Order book, liquidity and slippage', level: 'intermediate',
    summary: 'The book lists resting orders at each price; a large market order eats through it and pays slippage.',
    aliases: ['order book', 'order books', 'depth of market', 'market depth', 'level 2', 'liquidity and slippage', 'market liquidity', 'market mechanics', 'price impact'],
    tags: ['market structure', 'execution', 'costs'], prerequisites: ['bid-ask-spread'], related: ['t-order-types', 'bid-ask-spread', 't-backtesting-pitfalls'],
    levels: {
      beginner: 'The order book is the list of limit orders waiting to buy and sell at each price. Liquidity is how much is waiting near the current price. When you buy with a market order you take the cheapest offers first; if your order is bigger than the first level, the rest fills at worse prices. The difference is slippage.',
      intermediate: 'A market buy fills level by level: the average fill is the total paid divided by the quantity. Slippage is the average fill minus the best ask, times the point value and the quantity. A thin book, an economic release or the overnight session make each level smaller, so the same order slips more. Limit orders add liquidity; market orders remove it.',
      expert: 'Visible depth is not the whole book: iceberg orders hide size, and quotes are pulled in milliseconds when price moves, so depth often vanishes exactly when it is needed. Price impact grows with order size relative to the volume traded, roughly with its square root in many studies. A backtest that fills every order at the last price ignores all of this, which flatters fast, small-target strategies the most.',
    },
    analogy: 'Buying through the book is like buying apples from a row of stalls: the first stall is cheapest, but if you want more than it has you walk to the next, dearer one.',
    che_note: 'CHE has no live order book feed; its paper engine assumes one tick of slippage per side on market orders instead (trading_evidence.js). The book on this card is an educational example.',
    compute: 'tBookFill', inputs: { side: 'buy', qty: 10, symbol: 'MNQ', levels: [{ price: 21000.25, size: 4 }, { price: 21000.5, size: 3 }, { price: 21000.75, size: 5 }] }, result: { avgPrice: 21000.475, slippagePoints: 0.225, slippageDollars: 4.5 }, unit: 'price and $',
    f: ['Market order through the book', 'average fill = Σ(price × size taken) ÷ quantity;  slippage = (average fill − best price) × point value × quantity', 'the average fill is the total paid divided by the quantity, and slippage is the average fill minus the best price, times the point value and the quantity',
      [['price, size', 'each level of the book on the side being hit', 'price and contracts'], ['quantity', 'contracts in the order', 'a count'], ['point value', 'dollars per point per contract', '$ per point']],
      'The book stays still while the order fills; in practice it moves and hidden orders change the result.'],
    quiz: [
      { q: 'You buy 10 MNQ: 4 fill at 21,000.25, 3 at 21,000.50, 3 at 21,000.75. What is the average fill?', a: '21,000.475: 210,004.75 ÷ 10.' },
      { q: 'Why does slippage grow around economic releases?', a: 'Resting orders are pulled, so each price level holds less and an order reaches deeper prices.' },
      { q: 'Does a limit order pay the spread?', a: 'No, it waits to be filled at its price, but it may not fill.' },
    ],
    misconceptions: ['The best bid and ask are not the price for any size: only for the size shown at that level.'],
    limitations: ['Real books change while an order fills, and hidden orders are not shown; the result is a model.', 'CHE has no order-book data, so it cannot measure real slippage for the owner\'s orders.'],
    sources: [ref('Order book', 'Wikipedia', 'https://en.wikipedia.org/wiki/Order_book'), ref('Slippage (finance)', 'Wikipedia', 'https://en.wikipedia.org/wiki/Slippage_(finance)'), CHE_CODE('trading_evidence.js')],
  }),
  calcCard({
    id: 't-stocks', domain: 'trading', title: 'Share sizing for stocks', level: 'beginner',
    summary: 'A share is a small piece of a company; size a stock trade by the dollars between entry and stop.',
    aliases: ['stocks', 'stock', 'shares and stocks', 'stock trading', 'equity shares', 'share sizing', 'how many shares', 'shares from risk', 'stock position size'],
    tags: ['stocks', 'risk', 'fundamentals'], prerequisites: ['risk-management'], related: ['t-options', 'r-multiple', 'risk-management'],
    levels: {
      beginner: 'A share is a small piece of ownership in a company, and its price moves with what buyers and sellers will pay. A stock trade is sized the same way as a futures trade: decide the most you will lose, place the stop where the idea is wrong, and buy only as many shares as that loss allows.',
      intermediate: 'Shares = risk budget ÷ (entry − stop), rounded down. Risking $100 with an entry at $50 and a stop at $48 risks $2 a share, so the size is 50 shares, which costs $2,500 to buy: the capital is not the risk. The R-multiple of the result is the gain per share divided by the $2 risked.',
      expert: 'Stocks gap: news outside trading hours can open the price far beyond the stop, so the planned loss is a minimum, not a maximum. Liquidity varies hugely between large and small companies, and short selling adds borrow costs and the risk of a squeeze. Splits and dividends change historical prices, so a backtest needs adjusted data and must include the companies that were delisted, or it suffers survivorship bias.',
    },
    analogy: 'Sizing a stock trade is like deciding how many tiles to buy from the size of the room, not from how much money is in your pocket.',
    compute: 'tStockShares', inputs: { entry: 50, stop: 48, riskDollars: 100 }, result: 50, unit: 'shares',
    f: ['Shares from risk', 'shares = floor(risk budget ÷ |entry − stop|)', 'shares equal the risk budget divided by the distance from entry to stop, rounded down',
      [['risk budget', 'the most you accept losing', '$'], ['entry, stop', 'the planned entry and stop prices', '$ per share']],
      'The stop fills at its price; an overnight gap can open far beyond it. Commissions are not included.'],
    quiz: [
      { q: 'You risk $75 with an entry at $20.00 and a stop at $19.50. How many shares?', a: '150 shares: $75 ÷ $0.50.', check: { compute: 'tStockShares', inputs: { entry: 20, stop: 19.5, riskDollars: 75 }, result: 150, shown: ['150'] } },
      { q: 'Is the money needed to buy the shares the same as the risk?', a: 'No: the risk is shares × the stop distance; the capital is shares × the price.' },
      { q: 'Why is a stock\'s planned loss a minimum, not a maximum?', a: 'Because the price can gap past the stop overnight or on news.' },
    ],
    misconceptions: ['Buying fewer, more expensive shares is not safer by itself: the risk depends on the stop distance times the shares.'],
    limitations: ['Gaps, halts and thin trading can make the real loss far bigger than the plan.', 'Commissions, borrow fees for shorts and taxes are not included.'],
    sources: [ref('Stock', 'Wikipedia', 'https://en.wikipedia.org/wiki/Stock'), ref('Survivorship bias', 'Wikipedia', 'https://en.wikipedia.org/wiki/Survivorship_bias'), CHE_CODE('atlas_math.js')],
  }),
  calcCard({
    id: 't-options', domain: 'trading', title: 'Options basics at expiry', level: 'intermediate',
    summary: 'Calls and puts: the right to buy or sell at a strike, with a breakeven and a known worst case for the buyer.',
    aliases: ['options basics', 'option basics', 'options', 'calls and puts', 'call options', 'call option', 'put options', 'put option', 'option payoff', 'options payoff', 'option breakeven', 'intrinsic value'],
    tags: ['options', 'derivatives'], prerequisites: ['t-stocks'], related: ['t-stocks', 'risk-management', 'expectancy'],
    levels: {
      beginner: 'An option is a contract that gives its buyer the right, not the duty, to buy (a call) or sell (a put) a stock at a set price, the strike, until a date. The buyer pays a premium for that right, and that premium is the most the buyer can lose. A standard stock option covers 100 shares.',
      intermediate: 'At expiry a call is worth max(0, stock − strike) and a put max(0, strike − stock): that is intrinsic value. The buyer of a call breaks even at strike + premium; the buyer of a put at strike − premium. A long call with a $100 strike bought for $3 risks $300 and is worth $1,000 at a stock price of $110, a $700 profit.',
      expert: 'Before expiry an option also carries time value, which depends on volatility, time left and interest rates, and needs a pricing model such as Black-Scholes and live quotes, which CHE does not have. Sellers collect the premium but take the other side: a short call has unlimited risk, and a short put can lose almost the whole strike. American options can be exercised early, and assignment can arrive without warning.',
    },
    analogy: 'A call option is like a deposit on a house at a fixed price: if prices rise you buy cheap, and if they fall you walk away and lose only the deposit.',
    che_note: 'CHE has no options pricing feed and does not trade options; this card covers payoffs at expiry only.',
    compute: 'tOption', inputs: { type: 'call', position: 'long', strike: 100, premium: 3, underlying: 110, contracts: 1 }, result: { breakeven: 103, maxLoss: 300, intrinsic: 10, pnl: 700, premiumTotal: 300 }, unit: '$ and price',
    f: ['Option payoff at expiry', 'call: intrinsic = max(0, S − K), breakeven = K + premium;  put: intrinsic = max(0, K − S), breakeven = K − premium;  P&L = (intrinsic − premium) × 100 × contracts', 'a call is worth the stock minus the strike, or zero, and breaks even at the strike plus the premium; a put is worth the strike minus the stock, or zero, and breaks even at the strike minus the premium',
      [['S', 'the stock price at expiry', '$'], ['K', 'the strike', '$'], ['premium', 'the price paid per share', '$'], ['100', 'shares per standard contract', 'shares']],
      'At expiry only, held to expiry, no early exercise, before commissions.'],
    quiz: [
      { q: 'A put with a $50 strike costs $2. Where does the buyer break even at expiry?', a: '$48: the strike minus the premium.', check: { compute: 'tOption', inputs: { type: 'put', position: 'long', strike: 50, premium: 2 }, result: { breakeven: 48, maxLoss: 200 }, shown: ['$48'] } },
      { q: 'What is the most the buyer of a $3 call can lose on one contract?', a: '$300: the premium times 100 shares.' },
      { q: 'What is the risk of selling a call without owning the stock?', a: 'Unlimited, because the stock can keep rising.' },
    ],
    misconceptions: ['An option that expires below its breakeven is not always a total loss: between the strike and the breakeven some premium is recovered.'],
    limitations: ['Payoffs at expiry only; before expiry the price depends on volatility and time, which needs a model and live quotes CHE does not have.', 'Educational only: CHE does not price, recommend or trade options.'],
    sources: [ref('Option (finance)', 'Wikipedia', 'https://en.wikipedia.org/wiki/Option_(finance)'), ref('Characteristics and Risks of Standardized Options', 'The Options Clearing Corporation'), CHE_CODE('atlas_math.js')],
  }),
  calcCard({
    id: 't-price-action', domain: 'trading', title: 'Price action, candles and volume', level: 'beginner',
    summary: 'Reading bars directly: the body, the wicks, the range, and volume compared with recent bars.',
    aliases: ['price action', 'candles and volume', 'candle anatomy', 'candlestick anatomy', 'reading candles', 'candle wicks'],
    tags: ['price action', 'volume', 'fundamentals'], prerequisites: ['tick-value'], related: ['t-market-structure', 't-fair-value-gaps', 'vwap'],
    levels: {
      beginner: 'Price action means reading what price did, bar by bar, instead of an indicator. Each candle has an open, a high, a low and a close. The body runs from open to close; the thin wicks show where price went and was pushed back. Volume is how much traded in the bar.',
      intermediate: 'Body = |close − open|; upper wick = high − the higher of open and close; lower wick = the lower of open and close − low. A body that fills most of the range shows one side in control; long wicks show rejection. Relative volume, this bar\'s volume divided by the average of recent bars, says whether the move had unusual participation.',
      expert: 'Candle patterns have weak and unstable evidence once costs are counted: studies such as Lo, Mamaysky and Wang find some patterns carry a little information, but far less than chart books suggest, and results depend on the bar size. Futures volume from a delayed public feed may be partial. Treat price action as a description that a rule must turn into a tested hypothesis.',
    },
    analogy: 'A candle is like a day\'s weather summary: where the temperature started, how hot and cold it got, and where it ended up.',
    compute: 'tCandle', inputs: { o: 100, h: 106, l: 98, c: 104, v: 3000, priorVolumes: [1000, 1500, 2000, 1500] }, result: { range: 8, body: 4, upperWick: 2, lowerWick: 2, bodyShare: 0.5, relativeVolume: 2 }, unit: 'price and ratio',
    f: ['Candle anatomy and relative volume', 'body = |C − O|;  upper wick = H − max(O, C);  lower wick = min(O, C) − L;  relative volume = V ÷ average prior V', 'the body is the close minus the open, the wicks are what lies beyond the body, and relative volume is the volume divided by the average of the bars before',
      [['O, H, L, C', 'the bar\'s open, high, low and close', 'price'], ['V', 'the bar\'s volume', 'contracts or shares']],
      'One bar of one time frame; a different bar size shows the same move differently.'],
    quiz: [
      { q: 'A bar opens at 50, trades from 49 to 55 and closes at 54. How long is its upper wick?', a: '1 point: 55 − 54.', check: { compute: 'tCandle', inputs: { o: 50, h: 55, l: 49, c: 54 }, result: { upperWick: 1, lowerWick: 1, body: 4 }, shown: ['1 point'] } },
      { q: 'A bar trades 6,000 contracts when the last bars averaged 2,000. What is its relative volume?', a: '3: 6,000 ÷ 2,000.' },
      { q: 'Is a hammer candle a buy signal on its own?', a: 'No. Without a tested rule and costs it is only a description.' },
    ],
    misconceptions: ['High volume does not tell you who won: every contract bought was also sold.'],
    limitations: [ICT_LIMIT, 'Delayed public futures volume may not match the exchange total.'],
    sources: [ref('Candlestick chart', 'Wikipedia', 'https://en.wikipedia.org/wiki/Candlestick_chart'), LO_MAMAYSKY_WANG, ref('Trading Price Action Trends', 'Al Brooks')],
  }),
  calcCard({
    id: 't-volume', domain: 'trading', title: 'Volume, relative volume and the volume profile', level: 'intermediate',
    summary: 'How much traded: per bar, against the same time on earlier days, and at each price.',
    aliases: ['relative volume', 'rvol', 'volume analysis', 'volume profile', 'volume profiles', 'volume at price', 'point of control', 'value area', 'value area high', 'value area low', 'cumulative volume', 'volume by time of day'],
    tags: ['volume', 'intraday', 'statistics'], prerequisites: ['t-price-action'], related: ['vwap', 't-vwap-bands', 't-opening-range'],
    levels: {
      beginner: 'Volume is how many contracts traded in a bar. A big move on heavy volume had many participants; the same move on light volume had few. Because every session is busiest at the open and close, today\'s volume is best compared with earlier days at the same time of day, not with the whole of yesterday.',
      intermediate: 'Relative volume = today\'s volume up to now ÷ the average volume up to the same clock time over the last N sessions. 900 contracts by 9:40 against an average of 750 by 9:40 is 1.2, busier than usual. A volume profile adds up volume at each price: the level with the most is the point of control (POC), and the value area is the band around it holding about 70% of the volume.',
      expert: 'A real profile needs every trade\'s price; from bars CHE can only place each bar\'s volume at its close, an approximation that blurs fast bars. The value area grows from the POC by adding the busier neighbouring level each time, one common convention among several. Futures volume from a delayed public feed may be partial or revised, and the session start (6 p.m. or 9:30) changes every number. High volume shows participation, not direction: every contract bought was also sold.',
    },
    analogy: 'Relative volume is like comparing today\'s lunchtime crowd at a restaurant with its usual lunchtime crowd, not with a whole day\'s customers.',
    che_note: 'CHE\'s paper feed keeps Yahoo\'s delayed MNQ volume on each 1-minute bar and sums it into 5-minute bars (market_feed.js parseYahooChart, aggregate); her VWAP weights by it, and the engine\'s own VWAP counts a bar with no volume as 1 (trading_evidence.js intradayContext). No strategy in CHE\'s engine uses relative volume or a volume profile yet.',
    compute: 'tRelVolume', inputs: { sessions: 2, bars: [bar('2026-10-14T13:30:00Z', 1, 1, 1, 1, 200), bar('2026-10-14T13:35:00Z', 1, 1, 1, 1, 150), bar('2026-10-14T13:40:00Z', 1, 1, 1, 1, 150), bar('2026-10-14T13:45:00Z', 1, 1, 1, 1, 999), bar('2026-10-15T13:30:00Z', 1, 1, 1, 1, 300), bar('2026-10-15T13:35:00Z', 1, 1, 1, 1, 250), bar('2026-10-15T13:40:00Z', 1, 1, 1, 1, 450), bar('2026-10-15T13:45:00Z', 1, 1, 1, 1, 999), bar('2026-10-16T13:30:00Z', 1, 1, 1, 1, 400), bar('2026-10-16T13:35:00Z', 1, 1, 1, 1, 300), bar('2026-10-16T13:40:00Z', 1, 1, 1, 1, 200)] }, result: 1.2, unit: 'ratio',
    f: ['Relative volume at the time of day', 'RVOL = V(today, up to t) ÷ average of V(day d, up to t) over the N sessions before', 'relative volume equals today\'s volume up to now, divided by the average volume up to the same time over the sessions before',
      [['V(today, up to t)', 'volume since the session opened, up to the latest bar', 'contracts'], ['t', 'the clock time of the latest bar, New York', 'time'], ['N', 'how many earlier sessions', 'a count']],
      'Sessions are CME days from 6 p.m. New York; delayed public volume may be partial.'],
    quiz: [
      { q: 'Today traded 1,200 contracts by 10:00; the last five days averaged 800 by 10:00. What is the relative volume?', a: '1.5: 1,200 ÷ 800.' },
      { q: 'Closes and volumes: 100 for 150, 101 for 400, 102 for 600, 103 for 250, 104 for 100. Where are the POC and the 70% value area?', a: 'POC 102; value area 101 to 103, holding 1,250 of 1,500, or 83.3%.', check: { compute: 'tVolumeProfile', inputs: { step: 1, bars: [{ c: 100, v: 150 }, { c: 101, v: 400 }, { c: 102, v: 600 }, { c: 103, v: 250 }, { c: 104, v: 100 }] }, result: { poc: 102, val: 101, vah: 103 }, shown: ['POC 102', '101 to 103'] } },
      { q: 'Why compare with the same time on earlier days?', a: 'Volume follows a daily shape, busiest near the open and close, so a whole-day average would mislead early in the session.' },
    ],
    misconceptions: ['High volume is not buying pressure: each contract traded has a buyer and a seller.'],
    limitations: ['Delayed public futures volume may be partial or revised, so relative volume from it is approximate.', 'A profile built from bar closes approximates volume at price; the real one needs trade-by-trade data.'],
    sources: [ref('Volume (finance)', 'Wikipedia', 'https://en.wikipedia.org/wiki/Volume_(finance)'), ref('Markets in Profile', 'James F. Dalton, Robert B. Dalton and Eric T. Jones'), CHE_CODE('market_feed.js (aggregate)'), CHE_CODE('atlas_math.js (relativeVolume, volumeProfile)')],
  }),
  calcCard({
    id: 't-market-structure', domain: 'trading', title: 'Market structure: BOS and CHOCH', level: 'intermediate',
    summary: 'Swing highs and lows define a trend; a break of structure continues it, a change of character flips it.',
    aliases: ['market structure', 'bos', 'choch', 'bos and choch', 'bos vs choch', 'bos versus choch', 'break of structure', 'breaks of structure', 'change of character', 'market structure shift', 'mss', 'swing highs and lows', 'higher highs and higher lows', 'structure breaks'],
    tags: ['ict', 'smc', 'price action'], prerequisites: ['t-price-action'], related: ['t-liquidity', 't-order-blocks', 't-premium-discount'],
    levels: {
      beginner: 'Market structure is the pattern of swing highs and swing lows. Higher highs and higher lows make an uptrend; lower highs and lower lows a downtrend. A break of structure (BOS) is price closing past the last swing in the trend\'s direction. A change of character (CHOCH) is the first close past a swing against the trend.',
      intermediate: 'The difference is direction against the trend: in an uptrend, a close above the last swing high is a BOS, the trend going on; the first close below the last swing low is a CHOCH, the first sign it may be turning. A swing is only known after the bars beside it close, so every label must wait for that confirmation.',
      expert: 'Labels depend on choices: how many bars make a swing, whether a wick or only a close counts, and which time frame rules. With a swing size of 1 or 2, noise produces many breaks; with larger sizes, the label arrives late. Defined this way it is a mechanical rule that can be backtested causally, which is the only way to learn whether it adds anything after costs; CHE\'s sweep-then-structure-shift strategy is one such test.',
    },
    analogy: 'Structure is like a staircase: a BOS is the next step in the same direction, and a CHOCH is the first step that goes the other way.',
    che_note: 'CHE\'s paper engine tests a liquidity sweep then structure shift strategy (sweep-mss-5m) on delayed MNQ 5-minute bars; ask "what is my expectancy" for what the records show.',
    compute: 'tStructure', inputs: { n: 1, bars: [ohlc(100, 101, 99, 100), ohlc(100, 103, 100, 102.5), ohlc(102.5, 102, 100.5, 101), ohlc(101, 101.5, 99.5, 100), ohlc(100, 102.5, 100, 102), ohlc(102, 104, 101.5, 103.8), ohlc(103.8, 104.5, 102, 102.5), ohlc(102.5, 103, 98, 98.5), ohlc(98.5, 100, 97, 99.5), ohlc(99.5, 99.8, 97.5, 98), ohlc(98, 98.5, 95.5, 96)] }, result: { bos: 2, choch: 1 }, unit: 'events',
    f: ['Breaks of structure', 'BOS = a close beyond the last confirmed swing in the trend\'s direction;  CHOCH = the first such close against the trend', 'a break of structure is a close past the last confirmed swing in the trend\'s direction, and a change of character is the first such close against the trend',
      [['swing high', 'a high above the n bars on each side, known n bars later', 'price'], ['swing low', 'a low below the n bars on each side, known n bars later', 'price'], ['close', 'the bar\'s close, which must pass the swing', 'price']],
      'A close, not a wick, counts as a break; the first break, with no trend yet, counts as a BOS that sets the trend.'],
    quiz: [
      { q: 'Price is in an uptrend and closes below the last swing low for the first time. BOS or CHOCH?', a: 'CHOCH: the first break against the trend.' },
      { q: 'Why can a swing high not be labelled on the bar that makes it?', a: 'It needs the next bars to close lower first; labelling earlier uses the future.' },
      { q: 'In a downtrend, a close below the last swing low is what?', a: 'A BOS: structure breaking in the trend\'s direction.' },
    ],
    misconceptions: ['A CHOCH is not a reversal: it is the first break against the trend, and many fail.'],
    limitations: [ICT_LIMIT, 'The swing size and the time frame change every label, so two traders can mark the same chart differently.'],
    sources: [SMC, ref('Trading Price Action Trends', 'Al Brooks'), CHE_CODE('trading_lab.js (swings)')],
  }),
  calcCard({
    id: 't-liquidity', domain: 'trading', title: 'Liquidity pools and sweeps', level: 'intermediate',
    summary: 'Stops cluster above highs (buy-side) and below lows (sell-side); a sweep runs them and closes back.',
    aliases: ['liquidity', 'liquidity pools', 'liquidity pool', 'buy side liquidity', 'sell side liquidity', 'buy-side liquidity', 'sell-side liquidity', 'liquidity sweep', 'liquidity sweeps', 'stop hunt', 'stop hunts', 'stop run', 'liquidity grab'],
    tags: ['ict', 'smc', 'liquidity'], prerequisites: ['t-market-structure'], related: ['t-session-levels', 't-market-structure', 't-order-book'],
    levels: {
      beginner: 'In ICT language, liquidity means resting orders, especially stops. Buy-side liquidity sits above swing highs, where shorts have their stops and breakout buyers their entries; sell-side liquidity sits below swing lows. A sweep is price poking past such a level and closing back inside, as if it went to fill those orders.',
      intermediate: 'Defined on bars: a buy-side sweep of a level is a bar whose high is above it and whose close is below it; a sell-side sweep has a low below it and a close above it. Obvious levels such as the previous day\'s high and low, equal highs or the Asia range are the ones watched. A close beyond the level instead is a break, not a sweep.',
      expert: 'Bar data cannot show resting stops: whether orders really sat there is an inference, and a sweep is visible only after the close. Testable rules, such as "a sweep of the previous day low, then a close back above it", can be backtested with costs; CHE runs exactly that test (pdhl-sweep-5m) and journals the result. Selection bias is the trap: remembering the sweeps that reversed and forgetting the ones that kept going.',
    },
    analogy: 'A sweep is like a wave that runs up the beach past the line of shells and slides back: it reached for them, then retreated.',
    che_note: 'CHE\'s paper engine tests three sweep strategies on delayed MNQ 5-minute bars (sweep-mss-5m, sweep-reclaim-5m, pdhl-sweep-5m); their results are in the paper journal, not on this card.',
    compute: 'tSweeps', inputs: { level: 100, side: 'buy', bars: [ohlc(99, 99.5, 98, 99), ohlc(99, 100.75, 99, 99.5), ohlc(99.5, 99.8, 97.5, 98)] }, result: { sweeps: 1, firstBar: 2 }, unit: 'bars',
    f: ['Sweep of a level', 'buy-side sweep: high > level and close < level;  sell-side sweep: low < level and close > level', 'a buy-side sweep is a bar that trades above the level and closes back below it, and a sell-side sweep trades below it and closes back above it',
      [['level', 'a swing high or low, or a session high or low', 'price'], ['high, low, close', 'the bar\'s prices', 'price']],
      'Closed bars only; a close beyond the level is a break, not a sweep.'],
    quiz: [
      { q: 'Where does buy-side liquidity rest?', a: 'Above swing highs, where short sellers keep their stops.' },
      { q: 'A bar trades to 101 above a 100 high and closes at 99.5. Sweep or break?', a: 'A buy-side sweep: it traded above 100 and closed back below it.', check: { compute: 'tSweeps', inputs: { level: 100, side: 'buy', bars: [ohlc(99.8, 101, 99, 99.5)] }, result: { sweeps: 1 }, shown: ['sweep'] } },
      { q: 'Can bar data prove that stops were resting at a level?', a: 'No. It shows what price did, not where orders were.' },
    ],
    misconceptions: ['A sweep is not proof of "smart money": the same bar is also explained by ordinary buyers and sellers.'],
    limitations: [ICT_LIMIT, 'Resting orders are not visible in bar data, so "liquidity" here is a hypothesis about them.'],
    sources: [SMC, CHE_CODE('trading_evidence.js (sweep strategies)')],
  }),
  calcCard({
    id: 't-fair-value-gaps', domain: 'trading', title: 'Fair value gaps', level: 'intermediate',
    summary: 'A three-candle gap where bar 1 and bar 3 do not overlap, left by a fast move.',
    aliases: ['fair value gap', 'fair value gaps', 'fvg', 'fvgs', 'price imbalance', 'three candle gap'],
    tags: ['ict', 'smc', 'price action'], prerequisites: ['t-price-action'], related: ['t-order-blocks', 't-market-structure', 't-premium-discount'],
    levels: {
      beginner: 'A fair value gap is a gap inside three candles: in a fast move up, the first candle\'s high stays below the third candle\'s low, so the middle candle left a space where price traded only one way. ICT teaching says price often comes back to that space before going on.',
      intermediate: 'Bullish FVG: high of bar 1 < low of bar 3, and the gap runs from that high to that low. Bearish FVG: low of bar 1 > high of bar 3. A later bar that trades into the gap has touched it; one that trades through its far side has filled it. The midpoint is often called consequent encroachment.',
      expert: 'Gaps are common on small bar sizes, so most are noise; a minimum size, a time window or a structure filter is needed to make a testable rule. Whether a retest leads to continuation is an empirical question that must be answered after costs on untouched data. CHE\'s fair value gap retest strategy (fvg-retest-5m) is that test on delayed MNQ bars, with every trade journalled.',
    },
    analogy: 'A fair value gap is like a stretch of road a car crossed so fast that it left no tyre marks: traders expect it may come back to drive it properly.',
    che_note: 'CHE\'s paper engine tests a fair value gap retest (fvg-retest-5m) and the Silver Bullet window (silver-bullet-5m) on delayed MNQ 5-minute bars; ask "what is my expectancy" for the records.',
    compute: 'tFvg', inputs: { bars: [ohlc(100, 101, 99, 100.8), ohlc(100.8, 105, 100.5, 104.5), ohlc(104.5, 106, 102, 105.5), ohlc(105.5, 107, 103.5, 106)] }, result: { count: 1, bottom: 101, top: 102 }, unit: 'price',
    f: ['Three-bar fair value gap', 'bullish: H₁ < L₃, gap = (H₁, L₃);  bearish: L₁ > H₃, gap = (H₃, L₁)', 'a bullish gap is where the high of bar 1 is below the low of bar 3, and a bearish gap where the low of bar 1 is above the high of bar 3',
      [['H₁, L₁', 'high and low of the first bar', 'price'], ['H₃, L₃', 'high and low of the third bar', 'price']],
      'Bars in time order on one time frame; touched means a later bar traded into the gap, filled that it traded through the far side.'],
    quiz: [
      { q: 'Bar 1 has a high of 50 and bar 3 a low of 51.5. Is there a bullish gap, and how big?', a: 'Yes, 1.5 points, from 50 to 51.5.', check: { compute: 'tFvg', inputs: { bars: [ohlc(49.5, 50, 49, 49.8), ohlc(49.8, 52, 49.7, 51.8), ohlc(51.8, 53, 51.5, 52.5)] }, result: { count: 1, bottom: 50, top: 51.5 }, shown: ['1.5 points'] } },
      { q: 'What is the difference between a touched and a filled gap?', a: 'Touched: a later bar traded into it. Filled: a later bar traded through its far side.' },
      { q: 'Does a fair value gap have to be retested?', a: 'No. Many are never revisited; only a tested rule says how often.' },
    ],
    misconceptions: ['"Price must fill the gap" is a belief, not a law: many gaps stay open.'],
    limitations: [ICT_LIMIT, 'On small bar sizes gaps are frequent, so most carry no information without a filter.'],
    sources: [SMC, CHE_CODE('trading_evidence.js (fvg-retest-5m)')],
  }),
  calcCard({
    id: 't-order-blocks', domain: 'trading', title: 'Order blocks', level: 'expert',
    summary: 'The last opposite candle before a strong move, treated as a zone where large orders may have sat.',
    aliases: ['order block', 'order blocks', 'bullish order block', 'bearish order block', 'order block mean threshold', 'breaker block', 'breaker blocks'],
    tags: ['ict', 'smc', 'price action'], prerequisites: ['t-market-structure', 't-fair-value-gaps'], related: ['t-fair-value-gaps', 't-liquidity', 't-premium-discount'],
    levels: {
      beginner: 'An order block, in ICT teaching, is the last down candle before a strong move up (bullish), or the last up candle before a strong move down (bearish). The idea is that big buyers or sellers left orders there, so price may react when it comes back to that candle\'s range.',
      intermediate: 'To make it a rule: find a displacement candle whose body is at least a chosen size, then the last opposite-coloured candle before it. Its high and low are the block, and the midpoint is the mean threshold. A block counts more, in the teaching, when the displacement also breaks structure or leaves a fair value gap.',
      expert: 'There is no single definition: body size, wick or body boundaries, and whether a break of structure is required all change which candle is chosen. A breaker block is a failed block that price closed through. Bar data cannot show the orders the name implies, so "order block" is a label on a candle, and only a backtest with fixed rules, causal data and costs can show whether reactions there beat chance. CHE tests one version (order-block-5m).',
    },
    analogy: 'An order block is like footprints in front of a shop that suddenly got busy: you guess the crowd started there, but the prints do not prove who came.',
    che_note: 'CHE\'s paper engine tests an order block retest (order-block-5m: displacement body at least 1.5 ATR) on delayed MNQ 5-minute bars; the card\'s example uses a fixed body size instead.',
    compute: 'tOrderBlock', inputs: { minBody: 3, bars: [ohlc(100, 101, 99, 100.5), ohlc(100.5, 100.8, 98.5, 99), ohlc(99, 104, 98.8, 103.5)] }, result: { high: 100.8, low: 98.5, mid: 99.65 }, unit: 'price',
    f: ['Order block zone', 'block = range of the last opposite candle before a displacement;  mean threshold = (H + L) ÷ 2', 'the order block is the range of the last opposite candle before a displacement candle, and the mean threshold is its high plus its low, divided by 2',
      [['displacement', 'a candle whose body is at least the chosen size', 'points'], ['H, L', 'high and low of the block candle', 'price']],
      'One of several definitions in use; the displacement size is a choice.'],
    quiz: [
      { q: 'A bullish order block runs from 98.5 to 100.8. What is its mean threshold?', a: '99.65: (100.8 + 98.5) ÷ 2.', check: { compute: 'tOrderBlock', inputs: { minBody: 3, bars: [ohlc(100.5, 100.8, 98.5, 99), ohlc(99, 104, 98.8, 103.5)] }, result: { mid: 99.65 }, shown: ['99.65'] } },
      { q: 'Which candle is a bullish order block?', a: 'The last down candle before a strong move up.' },
      { q: 'What is a breaker block?', a: 'A block that failed: price closed through it, and traders then watch it from the other side.' },
    ],
    misconceptions: ['An order block is not a record of institutional orders: bar data cannot show who traded.'],
    limitations: [ICT_LIMIT, 'Definitions disagree on the body size, the boundaries and the filters, so results do not transfer between versions.'],
    sources: [SMC, CHE_CODE('trading_evidence.js (order-block-5m)')],
  }),
  calcCard({
    id: 't-premium-discount', domain: 'trading', title: 'Premium, discount and OTE', level: 'intermediate',
    summary: 'The halves of a swing leg, and the 62% to 79% retracement zone ICT calls the optimal trade entry.',
    aliases: ['premium and discount', 'premium discount', 'premium vs discount', 'discount zone', 'premium zone', 'ote', 'optimal trade entry', 'ote zone', 'fibonacci retracement', 'fib retracement', 'retracement levels'],
    tags: ['ict', 'smc', 'levels'], prerequisites: ['t-market-structure'], related: ['t-fair-value-gaps', 't-order-blocks', 't-market-structure'],
    levels: {
      beginner: 'Take a swing from a low to a high. The middle is equilibrium. Above it is the premium half, where ICT teaching prefers to sell; below it the discount half, where it prefers to buy. The optimal trade entry (OTE) is a deeper zone: a 62% to 79% pullback of the leg.',
      intermediate: 'Equilibrium = (low + high) ÷ 2. For a leg up, a retracement of r is high − r × (high − low): on a leg from 100 to 200, 62% is 138, 70.5% is 129.5 and 79% is 121, all in discount. For a leg down the levels are measured up from the low instead.',
      expert: 'The levels depend completely on which swing high and low you pick, and with hindsight a good-looking pair is easy to find, which is look-ahead bias. Fibonacci ratios have no known physical reason to hold in markets, and studies of retracement levels find little beyond chance once costs are counted. As a testable rule it needs a mechanical swing definition, made only from bars already closed.',
    },
    analogy: 'Premium and discount are like the two halves of a price tag\'s range in a market stall: you like to buy in the cheap half and sell in the dear half.',
    compute: 'tPremiumDiscount', inputs: { low: 100, high: 200, price: 130, direction: 'up' }, result: { equilibrium: 150, ote62: 138, ote705: 129.5, ote79: 121, position: 0.3 }, unit: 'price',
    f: ['Premium, discount and OTE levels', 'equilibrium = (L + H) ÷ 2;  leg up: level(r) = H − r × (H − L);  leg down: level(r) = L + r × (H − L);  OTE: r = 0.62 to 0.79', 'equilibrium is the low plus the high, divided by 2; on a leg up each retracement level is the high minus the ratio times the leg, and the OTE zone runs from 62 to 79 percent',
      [['L, H', 'the swing low and swing high of the leg', 'price'], ['r', 'the retracement ratio', 'a fraction']],
      'The swing pair is a judgement, and the ratios are conventions, not measured edges.'],
    quiz: [
      { q: 'A leg runs from 2,000 up to 2,100. Where is equilibrium?', a: '2,050: (2,000 + 2,100) ÷ 2.', check: { compute: 'tPremiumDiscount', inputs: { low: 2000, high: 2100 }, result: { equilibrium: 2050, ote62: 2038 }, shown: ['2,050'] } },
      { q: 'On that leg, where is the 62% retracement?', a: '2,038: 2,100 − 0.62 × 100.' },
      { q: 'Price is at 130 on a leg from 100 to 200. Premium or discount?', a: 'Discount: it is below the 150 equilibrium.' },
    ],
    misconceptions: ['A retracement level is not support by itself: it is arithmetic on two chosen points.'],
    limitations: [ICT_LIMIT, 'The swing high and low are chosen by judgement; another pair moves every level.'],
    sources: [SMC, ref('Fibonacci retracement', 'Wikipedia', 'https://en.wikipedia.org/wiki/Fibonacci_retracement'), CHE_CODE('atlas_math.js')],
  }),
  calcCard({
    id: 't-session-levels', domain: 'trading', title: 'Session levels: Asia, London, New York', level: 'intermediate',
    summary: 'Highs and lows of each session and of the previous day, which many traders watch.',
    aliases: ['session levels', 'session highs and lows', 'session high and low', 'asia session', 'asian session', 'asia range', 'asian range', 'london session', 'new york session', 'previous day high', 'previous day low', 'previous day high and low', 'pdh', 'pdl', 'pdh and pdl', 'killzones', 'kill zones'],
    tags: ['ict', 'sessions', 'levels'], prerequisites: ['t-futures'], related: ['t-liquidity', 't-opening-range', 'vwap'],
    levels: {
      beginner: 'Index futures trade almost around the clock, so traders split the day into sessions: Asia in the evening, London overnight and New York in the day. The high and low of each session, and the previous day\'s high and low, are levels many people watch, so price often reacts or runs stops there.',
      intermediate: 'CHE uses New York time: Asia 8 p.m. to midnight, London 2 to 5 a.m., and New York regular hours 9:30 a.m. to 4 p.m. The CME day runs from 6 p.m. to 5 p.m. the next afternoon, so the previous day high and low come from that whole day. Each level is just the highest high and lowest low of the bars inside the window.',
      expert: 'These windows are conventions; ICT killzones, exchange sessions and other teachers use different hours, and daylight saving shifts London and New York against each other for a few weeks each year. A level is common knowledge, so any edge from it is quickly competed away; test reactions at it with fixed windows, closed bars and costs before trusting it.',
    },
    analogy: 'Session levels are like the high-water marks on a pier from each tide: the next tide often reaches for them.',
    che_note: 'CHE\'s paper engine uses the previous CME day high and low in its pdhl-sweep-5m strategy, computed from past bars only (trading_evidence.js).',
    compute: 'tSessionLevels', inputs: { bars: [bar('2026-10-15T14:00:00Z', 105, 110, 100, 108, 100), bar('2026-10-15T18:00:00Z', 108, 112, 105, 106, 100), bar('2026-10-16T00:30:00Z', 106, 108, 104, 107, 50), bar('2026-10-16T02:00:00Z', 107, 109, 103, 105, 50), bar('2026-10-16T07:00:00Z', 105, 111, 106, 110, 80), bar('2026-10-16T14:00:00Z', 110, 115, 107, 114, 200), bar('2026-10-16T19:00:00Z', 114, 114, 108, 109, 150)] },
    result: { pdh: 112, pdl: 100, asiaHigh: 109, asiaLow: 103, londonHigh: 111, londonLow: 106, nyHigh: 115, nyLow: 107 }, unit: 'price',
    f: ['Session high and low', 'session high = max(H) and session low = min(L) of the bars inside the window, New York time', 'a session\'s high is the highest high and its low the lowest low of the bars inside its window, in New York time',
      [['window', 'Asia 20:00–24:00, London 02:00–05:00, New York 09:30–16:00, New York time', 'time'], ['H, L', 'each bar\'s high and low', 'price']],
      'Common conventions, not exchange definitions. The previous day is the CME day from 6 p.m. to 5 p.m. New York time.'],
    quiz: [
      { q: 'In New York time, when does CHE count the London session?', a: 'From 2 a.m. to 5 a.m.' },
      { q: 'When does the CME trading day for Friday start?', a: 'At 6 p.m. New York time on Thursday.' },
      { q: 'Why do session levels matter to many traders?', a: 'Because so many watch them, orders and stops gather there.' },
    ],
    misconceptions: ['Session windows are not official: different traders and tools draw them at different hours.'],
    limitations: [ICT_LIMIT, 'The windows are conventions; a different window gives different levels.'],
    sources: [SMC, CME(S.MNQ), CHE_CODE('trading_evidence.js (tradeDayOf, pdhl-sweep-5m)')],
  }),
  calcCard({
    id: 't-opening-range', domain: 'trading', title: 'Opening range', level: 'intermediate',
    summary: 'The high and low of the first minutes after the 9:30 New York open.',
    aliases: ['opening range', 'opening ranges', 'opening range breakout', 'initial balance', 'first 15 minutes', 'first 30 minutes'],
    tags: ['intraday', 'levels', 'sessions'], prerequisites: ['t-session-levels'], related: ['vwap', 't-vwap-bands', 't-session-levels'],
    levels: {
      beginner: 'The opening range is the high and low price of the first few minutes after the New York stock market opens at 9:30 a.m. New York time, often the first 15 or 30 minutes. Traders watch whether price breaks out of that range or falls back inside it.',
      intermediate: 'It is the highest high and lowest low of the bars that start from 9:30 to 9:30 plus N minutes. With 5-minute bars, a 15-minute range uses the 9:30, 9:35 and 9:40 bars, and it is known only once the 9:40 bar has closed at 9:45. Using it earlier would use data that did not exist yet.',
      expert: 'The anchor is 9:30 New York time, which is 13:30 UTC in daylight time and 14:30 UTC in standard time, so code must use the time zone, not a fixed UTC hour. Opening range breakout studies date back decades (Crabel, 1990); later work finds the effect varies by market and period and shrinks after costs. Test the window length, the instrument and the exit rules on data the rule never saw.',
    },
    analogy: 'The opening range is like the first few minutes of a football match: it shows which team is pressing, but it does not decide the score.',
    che_note: 'CHE\'s paper engine computes a 9:30 to 9:45 opening range from past bars only (trading_evidence.js), and says "calculate the opening range from the latest bars" reads it from stored bars.',
    compute: 'tOpeningRange', inputs: { minutes: 15, bars: [bar('2026-10-16T13:30:00Z', 100, 101, 99, 100.5, 500), bar('2026-10-16T13:35:00Z', 100.5, 102, 100, 101.5, 400), bar('2026-10-16T13:40:00Z', 101.5, 101.5, 98.5, 99, 450), bar('2026-10-16T13:45:00Z', 99, 104, 99, 103.5, 600)] }, result: { high: 102, low: 98.5, range: 3.5 }, unit: 'price',
    f: ['Opening range', 'OR high = max(H), OR low = min(L) of bars starting from 9:30 to 9:30 + N minutes, New York time', 'the opening range high is the highest high and its low the lowest low of the bars that start in the first N minutes after 9:30 New York time',
      [['N', 'minutes in the range', 'minutes'], ['H, L', 'each bar\'s high and low', 'price']],
      'Bars are labelled by their start time; the range is final only once its window has closed.'],
    quiz: [
      { q: 'With 5-minute bars, which bars make a 15-minute opening range?', a: 'The 9:30, 9:35 and 9:40 bars.' },
      { q: 'In UTC, when is the 9:30 New York open in winter?', a: '14:30 UTC; in summer it is 13:30 UTC.' },
      { q: 'When is a 15-minute opening range known?', a: 'At 9:45, when the last bar of the window has closed.' },
    ],
    misconceptions: ['A break of the opening range is not a signal by itself: many breaks fail and return inside.'],
    limitations: ['Evidence for opening range breakouts is mixed and varies by market and period; costs remove much of it.', 'A fixed UTC hour is wrong for half the year: the anchor must follow New York daylight saving.'],
    sources: [ref('Day Trading with Short Term Price Patterns and Opening Range Breakout', 'Toby Crabel'), CHE_CODE('trading_evidence.js (intradayContext)')],
  }),
  calcCard({
    id: 't-vwap-bands', domain: 'trading', title: 'VWAP deviation bands and anchoring', level: 'expert',
    summary: 'Bands at 1, 2 and 3 standard deviations around VWAP, anchored at the 9:30 New York open.',
    aliases: ['vwap bands', 'vwap deviation bands', 'vwap standard deviation', 'vwap standard deviation bands', 'vwap sigma bands', 'vwap anchoring', 'session vwap', 'rth vwap'],
    tags: ['indicators', 'intraday', 'statistics'], prerequisites: ['vwap'], related: ['vwap', 't-opening-range', 't-session-levels'],
    levels: {
      beginner: 'VWAP is the volume-weighted average price of the session. Deviation bands are lines drawn above and below it at one, two and three standard deviations, where the standard deviation measures how spread out the session\'s trading has been around VWAP.',
      intermediate: 'σ² = Σ volume × (typical price − VWAP)² ÷ Σ volume, so heavy-volume bars count more, like in VWAP itself. Bands are VWAP ± 1σ, 2σ and 3σ. Anchoring decides where the sums start: CHE\'s session VWAP starts at 9:30 New York time, the regular-hours open, found through the New York time zone so it stays right across daylight saving.',
      expert: 'Price does not follow a normal distribution, so "2σ holds 95% of trading" is only a rough guide, and early in a session σ rests on a few bars. Bar typical prices approximate the trade-by-trade values. A futures VWAP from the 6 p.m. CME open, from 9:30, or from an anchored event are different numbers. Bands describe the session so far; fading or buying them is a hypothesis to test.',
    },
    analogy: 'VWAP bands are like the lanes on a running track drawn around the average runner: most stay near the middle, but a lane line never stops anyone from crossing it.',
    che_note: 'CHE computes VWAP and its bands only from bars it has stored (the delayed paper feed), with their source and time; with no stored bars it says so and invents no prices.',
    compute: 'tVwapBands', inputs: { anchor: 'all', bars: [{ h: 101, l: 99, c: 100, v: 100 }, { h: 104, l: 100, c: 102, v: 200 }, { h: 103, l: 98, c: 99, v: 100 }] }, result: { vwap: 101, sd: 1, upper1: 102, lower1: 100, upper2: 103, lower2: 99, upper3: 104, lower3: 98 }, unit: 'price',
    f: ['VWAP bands', 'VWAP = Σ(TP × V) ÷ ΣV;  σ² = Σ V × (TP − VWAP)² ÷ ΣV;  bands = VWAP ± kσ, k = 1, 2, 3', 'the variance is the volume-weighted average of the squared distance of each typical price from VWAP, and the bands are VWAP plus or minus one, two and three standard deviations',
      [['TP', 'typical price, (H + L + C) ÷ 3', 'price'], ['V', 'bar volume', 'contracts'], ['k', 'number of standard deviations', '1, 2 or 3']],
      'Summed from the anchor; bar typical prices approximate trade prices.'],
    quiz: [
      { q: 'VWAP is 101 and σ is 1. Where is the upper 2σ band?', a: '103: 101 + 2 × 1.' },
      { q: 'In daylight time, what UTC time is the 9:30 New York anchor?', a: '13:30 UTC; in standard time it is 14:30 UTC.' },
      { q: 'Does a touch of the 2σ band mean price will reverse?', a: 'No. The bands describe how spread out trading was; they do not predict.' },
    ],
    misconceptions: ['The bands are not a 95% guarantee: market prices have fat tails.'],
    limitations: ['Bands early in the session rest on very few bars.', 'Delayed public bars may have partial volume, which changes the weighting.'],
    sources: [ref('Volume-weighted average price', 'Wikipedia', 'https://en.wikipedia.org/wiki/Volume-weighted_average_price'), ref('Weighted arithmetic mean: weighted variance', 'Wikipedia', 'https://en.wikipedia.org/wiki/Weighted_arithmetic_mean'), CHE_CODE('atlas_math.js')],
  }),
  calcCard({
    id: 't-journaling', domain: 'trading', title: 'Trade journaling and performance review', level: 'beginner',
    summary: 'Write every trade down, losers included, and review the equity curve and its drawdowns.',
    aliases: ['journaling', 'trade journal', 'trade journaling', 'performance review', 'reviewing trades', 'equity curve', 'drawdown percent'],
    tags: ['process', 'performance', 'statistics'], prerequisites: ['r-multiple', 'drawdown'], related: ['t-strategy-evaluation', 'drawdown', 'expectancy'],
    levels: {
      beginner: 'A trade journal records every trade: the setup, entry, stop, target, exit, size, result and why you took it. Losing trades matter as much as winners. Without a journal, memory keeps the good trades and forgets the bad ones, and nothing can be measured.',
      intermediate: 'Record the result in dollars and in R, and the costs. Add the results in order to get the equity curve; the largest fall from a peak is the maximum drawdown, in dollars, and divided by that peak, in percent. Starting from $10,000, results of +200, −150, −250, +300 and −100 fall from a $10,200 peak to $9,800: $400, or 3.92%.',
      expert: 'A journal is a dataset, so its rules matter: the setup is labelled before the trade, never after; every trade is kept; and the strategy version is recorded, so a rule change starts a new sample. The deepest dollar fall and the deepest percent fall can happen at different points. Review by setup, session and time of day, but beware slicing too finely: with enough slices one will look great by chance.',
    },
    analogy: 'A journal is like a pilot\'s logbook: it is filled in after every flight, the bumpy ones too, so problems show up in the record instead of in memory.',
    che_note: 'CHE\'s paper journal is append-only: losing trades and failed experiments are kept, and a trade the journal refused is stored with its reason (trading_evidence.js, trading_live.js).',
    measured: { metric: 'max_drawdown', label: 'maximum drawdown' },
    compute: 'tMaxDrawdown', inputs: { pnl: [200, -150, -250, 300, -100], start: 10000 }, result: { dollars: 400, percent: 0.039216 }, unit: '$ and %',
    f: ['Maximum drawdown in dollars and percent', 'MDD = max over t of (peak up to t − equity at t);  MDD% = max over t of (peak − equity) ÷ peak', 'the maximum drawdown is the largest fall from the highest equity so far, and in percent that fall divided by the peak',
      [['equity at t', 'starting balance plus the results so far', '$'], ['peak', 'the highest equity up to t', '$']],
      'Closed trades in time order; open-trade swings can go deeper.'],
    quiz: [
      { q: 'From $5,000, results are +500, −1,100 and +200. What is the maximum drawdown?', a: '$1,100: from the $5,500 peak to $4,400, which is 20%.', check: { compute: 'tMaxDrawdown', inputs: { pnl: [500, -1100, 200], start: 5000 }, result: { dollars: 1100, percent: 0.2 }, shown: ['$1,100', '20%'] } },
      { q: 'Why must losing trades be journalled too?', a: 'Without them every statistic is biased upward.' },
      { q: 'When should a trade\'s setup be labelled?', a: 'Before the trade, so the result cannot change the label.' },
    ],
    misconceptions: ['A journal of only the trades you remember is not a record: it is a highlight reel.'],
    limitations: ['A journal measures the past under one set of conditions; the next period can differ.', 'Slicing results into many groups finds patterns that are only chance.'],
    sources: [ref('Drawdown (economics)', 'Wikipedia', 'https://en.wikipedia.org/wiki/Drawdown_(economics)'), PARDO, CHE_CODE('trading_evidence.js (appendTrades)')],
  }),
  calcCard({
    id: 't-performance-analysis', domain: 'trading', title: 'Performance analysis', level: 'expert',
    summary: 'Reviewing results: expectancy in R per portfolio, the spread of R, MFE and MAE, streaks and time of day.',
    aliases: ['performance analysis', 'trade performance analysis', 'r distribution', 'distribution of r', 'mae', 'mfe', 'maximum adverse excursion', 'maximum favorable excursion', 'maximum favourable excursion', 'excursion analysis', 'time of day analysis', 'time of day breakdown', 'multiple comparisons', 'multiple comparison problem', 'multiple testing', 'bonferroni correction'],
    tags: ['performance', 'statistics', 'research'], prerequisites: ['t-journaling', 'expectancy'], related: ['t-journaling', 't-strategy-evaluation', 't-backtesting-pitfalls'],
    levels: {
      beginner: 'Performance analysis is reading a record of trades to learn what really happened: what an average trade made in R, how spread out the results were, how long the winning and losing streaks ran, and whether some times of day did better. Each strategy is reviewed on its own record.',
      intermediate: 'Start with the mean and the median R: a positive mean with a negative median means a few big winners carry many small losers. MFE, the maximum favourable excursion, is how far a trade went your way before it closed; MAE, the maximum adverse excursion, how far it went against you. Trades that reached +1R MFE and still lost suggest the exit, not the entry, needs testing.',
      expert: 'Slicing by hour, weekday or setup multiplies the comparisons: tested at 5% each, 20 groups give a 1 − 0.95^20 = 64% chance that at least one looks significant by luck alone, which is why a Bonferroni level of 0.05 ÷ 20 = 0.0025 is stricter. Each slice is also a smaller sample. Treat a good-looking slice as a new hypothesis to test forward on fresh trades, never as a finding.',
    },
    analogy: 'Reviewing trades by time of day is like a coach studying game film by quarter: useful, but with enough ways to slice the film one quarter will always look special by chance.',
    che_note: 'CHE\'s journal records each trade\'s MFE and MAE in points and in R, from the highs and lows of the bars while it was open, and the New York session it entered in (trading_evidence.js closeAt, sessionOf). The Trading Room breaks results down by strategy, session and day (trading_live.js liveDashboard). Ask "what is my expectancy" or "evaluate my strategy" for the records, one portfolio at a time.',
    measured: { metric: 'expectancy', label: 'expectancy' },
    compute: 'tPerformance', inputs: { resolution: '5m', trades: [{ time: '2026-10-15T13:35:00Z', r: 2, mfeR: 2.5, maeR: 0.6 }, { time: '2026-10-15T14:10:00Z', r: -1, mfeR: 0.5, maeR: 0.6 }, { time: '2026-10-15T14:40:00Z', r: -1, mfeR: 0.5, maeR: 0.6 }, { time: '2026-10-15T15:05:00Z', r: -1, mfeR: 0.5, maeR: 0.6 }, { time: '2026-10-15T17:20:00Z', r: 2.5, mfeR: 3, maeR: 0.6 }, { time: '2026-10-15T18:00:00Z', r: -0.5, mfeR: 0.5, maeR: 0.6 }, { time: '2026-10-16T13:45:00Z', r: 1, mfeR: 1.5, maeR: 0.6 }, { time: '2026-10-16T19:10:00Z', r: -1, mfeR: 0.5, maeR: 0.6 }] },
    result: { meanR: 0.125, medianR: -0.75, longestWinStreak: 1, longestLossStreak: 3 }, unit: 'R',
    f: ['R distribution and streaks', 'mean R = Σ R ÷ n;  median R = the middle value;  streak = the longest run of wins or of losses in order;  by session = the same for each New York session', 'the mean R is the sum of the R-multiples divided by the trades, the median is the middle one, and a streak is the longest run of wins or of losses in order',
      [['R', 'each trade\'s result in R after costs', 'R'], ['n', 'closed trades', 'a count'], ['session', 'the New York session the trade entered in', 'a label']],
      'Trades in time order; each session group is a smaller sample than the whole.'],
    quiz: [
      { q: 'You compare 20 hours of the day, each tested at 5%. What is the chance at least one looks significant by luck?', a: 'About 64.2%: 1 − 0.95^20.', check: { compute: 'tMultipleComparisons', inputs: { alpha: 0.05, groups: 20 }, result: { familywise: 0.641514, bonferroni: 0.0025 }, shown: ['64.2%'] } },
      { q: 'Results of +3R, −1R, −1R, −1R: what are the mean and the median?', a: 'Mean 0R and median −1R: one winner pays for three losers.', check: { compute: 'tPerformance', inputs: { trades: [{ r: 3 }, { r: -1 }, { r: -1 }, { r: -1 }] }, result: { meanR: 0, medianR: -1, longestLossStreak: 3 }, shown: ['Mean 0R', 'median −1R'] } },
      { q: 'A losing trade had an MFE of +1.5R. What does that suggest?', a: 'It was well in profit first: test the exit rule, such as a closer target or a break-even stop, on new trades.' },
    ],
    misconceptions: ['The best hour in a breakdown is not an edge: with many slices, one will look best by chance.'],
    limitations: ['Every slice is a smaller sample, and comparing many slices finds differences by luck.', 'MFE and MAE come from bar highs and lows, so moves inside a bar are not seen in order.'],
    sources: [ref('Multiple comparisons problem', 'Wikipedia', 'https://en.wikipedia.org/wiki/Multiple_comparisons_problem'), ref('Maximum Adverse Excursion', 'John Sweeney'), CHE_CODE('trading_evidence.js (closeAt)'), CHE_CODE('trading_live.js (liveDashboard)')],
  }),
  calcCard({
    id: 't-strategy-evaluation', domain: 'trading', title: 'Strategy evaluation and verdicts', level: 'expert',
    summary: 'Judge a strategy by expectancy with its interval, profit factor and sample size: good, bad or unsupported.',
    aliases: ['strategy evaluation', 'evaluating a strategy', 'evaluate a strategy', 'strategy evaluation criteria', 'judging a strategy', 'expectancy interval', 'expectancy confidence interval', 't interval', 't-interval', 'student t interval', 'two forms of expectancy'],
    tags: ['statistics', 'performance', 'research'], prerequisites: ['expectancy', 'sample-size'], related: ['t-journaling', 't-monte-carlo', 't-backtesting-pitfalls'],
    levels: {
      beginner: 'To judge a strategy, CHE looks at three things together: how much it makes on an average trade (expectancy), how sure that number is (its range), and how many trades it rests on. With too few trades, or a range that still includes zero, the honest verdict is "unsupported", not good or bad.',
      intermediate: `Expectancy has two equal forms: win rate × average win − loss rate × average loss, and the mean R of all trades. Its 95% range is the mean ± t × s ÷ √n, using Student's t because s is estimated from the same trades. ${VERDICT_RULES.text}`,
      expert: 'The t-interval assumes independent trades from one unchanging strategy; real trades cluster, regimes change, and R-multiples are skewed, so the range is approximate and too narrow if the rules were tuned on the same data. Forward paper trades are out of sample by construction; backtest trades are not, unless the rules were frozen first. Judge each strategy version on its own: pooling different rules mixes their results.',
    },
    analogy: 'Judging a strategy is like a doctor reading a test with its margin of error: a single number is not a diagnosis until the margin is narrow enough.',
    che_note: 'Ask "what is my expectancy" or "evaluate my strategy": CHE reads the paper journal and the stored backtest and applies these criteria, with every number labelled by its source.',
    measured: { metric: 'expectancy', label: 'expectancy' },
    compute: 'tExpectancy', inputs: { rs: [2, -1, -1, 2, -1, 1.5, -1, 2] }, result: { expectancy: 0.4375, low: -0.854534, high: 1.729534 }, unit: 'R',
    f: ['Expectancy and its t-interval', 'E = W × avg win − L × avg loss = mean R;  95% range = mean ± t(0.975, n − 1) × s ÷ √n', 'expectancy equals the win rate times the average win, minus the loss rate times the average loss, which is the mean R; its range is the mean plus or minus t times the standard deviation, divided by the square root of n',
      [['W, L', 'win rate and loss rate', 'fractions'], ['s', 'sample standard deviation of R', 'R'], ['t', 'Student\'s t for n − 1 degrees of freedom', 'standard errors'], ['n', 'trades', 'a count']],
      'Independent trades from one unchanging strategy; with few or skewed trades the range is approximate.'],
    quiz: [
      { q: 'A strategy wins 40% at +2R and loses 60% at −1R. What is its expectancy, both ways?', a: '+0.2R: 0.4 × 2 − 0.6 × 1, and the mean of the R-multiples is the same.', check: { compute: 'tExpectancy', inputs: { rs: [2, -1, -1, 2, -1] }, result: { expectancy: 0.2 }, shown: ['+0.2R'] } },
      { q: 'Forty trades, a 95% range of −0.1R to +0.5R, profit factor 1.4. Good, bad or unsupported?', a: 'Unsupported: the range still includes zero.' },
      { q: 'Why use Student\'s t instead of 1.96 for a small sample?', a: 'The standard deviation is estimated from the same few trades, so the range must be wider.' },
    ],
    misconceptions: ['A positive average is not a good strategy until its whole range is above zero on enough trades.'],
    limitations: ['The interval assumes independent trades and one fixed strategy; clustering and regime change make it too narrow.', 'A verdict on backtest trades is weaker than on forward trades, because the rules may fit the history.'],
    sources: [ref('Student\'s t-distribution', 'Wikipedia', 'https://en.wikipedia.org/wiki/Student%27s_t-distribution'), PARDO, CHE_CODE('atlas_math.js (strategyVerdict)'), CHE_CODE('trading_evidence.js (promotionVerdict)')],
  }),
  calcCard({
    id: 't-trades-needed', domain: 'trading', title: 'Trades needed for a win-rate margin', level: 'intermediate',
    summary: 'The sample size that pins a win rate to within a chosen margin, such as plus or minus 5 points.',
    aliases: ['trades needed', 'how many trades', 'sample size for win rate', 'win rate margin of error', 'margin of error', 'sample size calculation', 'required sample size'],
    tags: ['statistics', 'research'], prerequisites: ['win-rate-ci'], related: ['sample-size', 'win-rate-ci', 't-strategy-evaluation'],
    levels: {
      beginner: 'The more trades you record, the more exactly you know a strategy\'s win rate. To know it within plus or minus 5 percentage points, about 95% of the time, you need roughly 385 trades; within plus or minus 10 points, about 97. Thirty trades is a minimum, not precision.',
      intermediate: 'n = z² × p(1 − p) ÷ margin², rounded up, with z = 1.96 for 95%. When the win rate is unknown, p = 0.5 gives the largest n, the safe choice: 1.96² × 0.25 ÷ 0.05² = 384.16, so 385 trades. Halving the margin needs four times the trades.',
      expert: 'This is the normal approximation for one proportion; near 0% or 100%, or for small n, the Wilson interval is more honest, and the real need is higher when trades are not independent. Precision on the win rate is not precision on expectancy: payoffs vary too, so a strategy can need many more trades to show its mean R is above zero.',
    },
    analogy: 'It is like a poll before an election: asking 100 people gives a rough idea, and asking 1,000 narrows the margin, but each halving of the margin needs four times the people.',
    compute: 'tSampleSize', inputs: { margin: 0.05, p: 0.5 }, result: 385, unit: 'trades',
    f: ['Trades for a win-rate margin', 'n = z² × p(1 − p) ÷ margin², rounded up', 'n equals z squared, times p times one minus p, divided by the margin squared, rounded up',
      [['z', '1.96 for 95%', 'standard errors'], ['p', 'the expected win rate, 0.5 if unknown', 'a fraction'], ['margin', 'the half-width you want', 'a fraction, 0.05 for ±5 points']],
      'Normal approximation, independent trades.'],
    quiz: [
      { q: 'How many trades pin a win rate to ±10 points at 95%, when it is unknown?', a: '97: 1.96² × 0.25 ÷ 0.1² = 96.04, rounded up.', check: { compute: 'tSampleSize', inputs: { margin: 0.1, p: 0.5 }, result: 97, shown: ['97'] } },
      { q: 'How many more trades halve the margin?', a: 'Four times as many in total.' },
      { q: 'Does a precise win rate prove a positive expectancy?', a: 'No. The payoffs vary too, so expectancy needs its own interval.' },
    ],
    misconceptions: ['Thirty trades is not "statistically significant" by itself: it is a floor below which nothing is evidence.'],
    limitations: ['The normal approximation is rough near 0% or 100% win rates and for small samples.', 'Correlated trades carry less information, so the real need is higher.'],
    sources: [ref('Sample size determination', 'Wikipedia', 'https://en.wikipedia.org/wiki/Sample_size_determination'), CHE_CODE('atlas_math.js')],
  }),
  calcCard({
    id: 't-probability', domain: 'trading', title: 'Losing streaks and probability', level: 'intermediate',
    summary: 'Independent trades, the complement, the chance of losses in a row, and how long the worst streak usually runs.',
    aliases: ['losing streaks', 'losing streak', 'losing streak probability', 'consecutive losses', 'losses in a row', 'longest losing streak', 'independent events', 'conditional probability', 'gamblers fallacy', 'gambler\'s fallacy', 'complement rule'],
    tags: ['statistics', 'risk', 'fundamentals'], prerequisites: ['win-rate-ci'], related: ['t-risk-of-ruin', 't-monte-carlo', 'risk-management'],
    levels: {
      beginner: 'If each trade wins with probability p, it loses with probability 1 − p: that is the complement. When trades are independent, chances multiply, so the chance of the next N trades all losing is (1 − p)^N. With a 40% win rate, four losses in a row happen 0.6⁴ = 13% of the time, so they are normal, not a sign the strategy broke.',
      intermediate: 'The chance of a streak somewhere in a long run is far higher than the chance of one starting now. With a 40% win rate, 8 losses in a row start at any given trade only 1.7% of the time, but at least one such run appears in 100 trades about 49% of the time. The longest losing streak in n trades is usually about log base 1/(1 − p) of n·p.',
      expert: `CHE computes the chance of a run of k losses in n trades exactly with the run recurrence A(n) = A(n − 1) − p(1 − p)^k A(n − k − 1), and the expected longest streak as the sum over k of the chance of a run of at least k; Schilling's approximation log_{1/q}(n·p) + γ ÷ ln(1/q) − ½, with q = 1 − p and γ = 0.5772, is within a few hundredths of it for long runs. The conditional-probability trap: after five losses the next trade is still a loss with probability 1 − p if trades are independent (the gambler's fallacy); and P(win | setup) is not P(setup | win).`,
    },
    analogy: 'Losing streaks are like runs of red at a roulette table: rare to start on any given spin, but over a long evening almost certain to show up somewhere.',
    che_note: 'CHE\'s Monte Carlo of a record also reports each simulated path\'s longest losing streak, and her risk-of-ruin calculator uses the same independence assumption (atlas_math.js monteCarlo, riskOfRuin).',
    compute: 'tLosingStreaks', inputs: { winRate: 0.4, trades: 10, streak: 4 }, result: { inARow: 0.1296, atLeastOnce: 0.4245157 }, unit: 'probability',
    f: ['Losing streaks', 'P(next k all lose) = (1 − p)^k;  P(a run of k within n) = 1 − A(n), A(n) = A(n − 1) − p(1 − p)^k A(n − k − 1);  E[longest] ≈ log_{1/q}(n·p) + γ ÷ ln(1/q) − ½', 'the chance of the next k trades all losing is one minus p, to the power k; the chance of such a run somewhere in n trades comes from the run recurrence, and the longest streak is about log base one over q of n times p',
      [['p', 'win rate per trade', 'a fraction'], ['q = 1 − p', 'loss rate per trade', 'a fraction'], ['k', 'losses in a row', 'a count'], ['n', 'trades in the run', 'a count']],
      'Independent trades with one fixed win rate; real trades cluster, so streaks can run longer.'],
    quiz: [
      { q: 'With a 50% win rate, what is the chance of 5 losses in a row starting now?', a: 'About 3.1%: 0.5⁵ = 1/32.', check: { compute: 'tLosingStreaks', inputs: { winRate: 0.5, trades: 20, streak: 5 }, result: { inARow: 0.03125, atLeastOnce: 0.2498703 }, shown: ['3.1%'] } },
      { q: 'And the chance of at least one run of 5 losses somewhere in 20 trades?', a: 'About 25%, eight times the chance of one starting now.' },
      { q: 'After five losses in a row, is the next trade more likely to win?', a: 'No. If trades are independent, the chance is the same as always; thinking otherwise is the gambler\'s fallacy.' },
    ],
    misconceptions: ['A long losing streak is not proof a strategy stopped working: in a long run of trades it is expected.'],
    limitations: ['Assumes independent trades with one fixed win rate; regime changes cluster losses, so real streaks can be longer.', 'The win rate itself is an estimate, so every streak probability inherits its uncertainty.'],
    sources: [ref('The Longest Run of Heads (College Mathematics Journal, 1990)', 'Mark F. Schilling'), ref('Gambler\'s fallacy', 'Wikipedia', 'https://en.wikipedia.org/wiki/Gambler%27s_fallacy'), ref('Conditional probability', 'Wikipedia', 'https://en.wikipedia.org/wiki/Conditional_probability'), CHE_CODE('atlas_math.js (losingStreaks)')],
  }),
  calcCard({
    id: 't-backtesting-pitfalls', domain: 'trading', title: 'Backtesting pitfalls', level: 'expert',
    summary: 'Look-ahead, survivorship, overfitting and missing costs: the ways a backtest lies.',
    aliases: ['backtesting pitfalls', 'backtest pitfalls', 'backtesting mistakes', 'backtest mistakes', 'look ahead bias', 'look-ahead bias', 'lookahead bias', 'survivorship', 'data snooping', 'cost drag', 'repainting'],
    tags: ['research', 'statistics', 'advanced'], prerequisites: ['sample-size'], related: ['t-strategy-evaluation', 't-monte-carlo', 't-order-book'],
    levels: {
      beginner: 'A backtest replays rules on old prices. It can look great and still be wrong: if it used information that was not known at the time, tested only markets that survived, was tuned until the past looked good, or left out costs. Each of these makes the past look better than the future will be.',
      intermediate: 'Costs are the easiest to measure: net expectancy = gross expectancy − round-trip cost ÷ dollars risked. CHE\'s assumed MNQ round trip is about $5.50 (spread, slippage, commissions and fees); on a $40 risk that is 0.1375R a trade, enough to turn a +0.15R gross edge into +0.0125R.',
      expert: 'Look-ahead hides in details: a signal on a bar\'s close filled at that same close, an indicator that repaints, a session high used before the session ended. Survivorship removes delisted stocks and expired contracts. Overfitting grows with every variant tried, so the best backtest of many is mostly selection; Bailey and colleagues estimate this as the probability of backtest overfitting. Freeze the rules, then test once on untouched data.',
    },
    analogy: 'An overfitted backtest is like a key filed to fit one lock perfectly: it opens that lock and no other.',
    che_note: 'CHE\'s evidence engine computes indicators from past bars only, fills at the next bar open, charges assumed costs on every trade and keeps failed experiments (trading_evidence.js).',
    compute: 'tCostInR', inputs: { grossR: 0.15, roundTripCost: 5.5, riskDollars: 40 }, result: { costR: 0.1375, netR: 0.0125 }, unit: 'R',
    f: ['Cost drag in R', 'net expectancy = gross expectancy − round-trip cost ÷ dollars risked', 'net expectancy equals gross expectancy minus the round-trip cost divided by the dollars risked per trade',
      [['gross expectancy', 'average R before costs', 'R'], ['round-trip cost', 'spread, slippage, commissions and fees in and out', '$'], ['dollars risked', 'the 1R of each trade', '$']],
      'The same cost on every trade; real slippage varies and is worst in fast markets.'],
    quiz: [
      { q: 'A strategy makes +0.10R gross, risks $20 a trade and pays $5 a round trip. What is the net?', a: '−0.15R: 0.10 − 5 ÷ 20.', check: { compute: 'tCostInR', inputs: { grossR: 0.1, roundTripCost: 5, riskDollars: 20 }, result: { costR: 0.25, netR: -0.15 }, shown: ['−0.15R'] } },
      { q: 'A signal uses a bar\'s close and fills at that same close. What is wrong?', a: 'Look-ahead: the close is known only when the bar ends, so the fill must come after it.' },
      { q: 'You tried 200 variants and kept the best. What should you expect going forward?', a: 'Worse results: the best of many is partly the luckiest.' },
    ],
    misconceptions: ['A backtest with a high win rate is not evidence until costs, causal data and untouched test data are all in place.'],
    limitations: ['Even a careful backtest is history: it cannot show a regime that has not happened yet.', 'Assumed costs are planning numbers, not a broker\'s schedule.'],
    sources: [BAILEY, ref('Look-ahead bias', 'Wikipedia', 'https://en.wikipedia.org/wiki/Look-ahead_bias'), ref('Overfitting', 'Wikipedia', 'https://en.wikipedia.org/wiki/Overfitting'), PARDO, CHE_CODE('trading_evidence.js (COSTS)')],
  }),
  calcCard({
    id: 't-paper-trading', domain: 'trading', title: 'Paper trading and CHE\'s paper engine', level: 'intermediate',
    summary: 'Simulated trades on real prices with assumed costs: how CHE\'s paper engine fills, and why paper is not live.',
    aliases: ['paper trading', 'paper trade', 'paper simulation', 'trade simulation', 'paper engine', 'paper fills', 'paper fill', 'forward paper trading', 'paper versus live', 'paper vs live'],
    tags: ['paper', 'execution', 'research'], prerequisites: ['t-order-types', 't-futures'], related: ['t-backtesting-pitfalls', 't-journaling', 't-order-book'],
    levels: {
      beginner: 'Paper trading means following a strategy\'s rules on real market prices and recording what would have happened, with no money and no broker order. It tests the rules forward, on prices the rules never saw. A paper result is not a live result: nobody filled the order, and nothing was risked.',
      intermediate: 'In CHE\'s engine a signal is read from a closed 5-minute bar, and the entry is a market order at the next bar\'s open plus half a 1-tick spread and 1 tick of slippage. A stop fills as a market order at the stop, or at the open if price gapped through it; a target is a resting limit that pays only half the spread. If one bar touches both, the stop is assumed first. Commission $1.50 and fees $0.50 a contract a side come off every trade.',
      expert: 'The bars are Yahoo\'s delayed 1-minute MNQ bars summed to 5 minutes, so paper results are delayed forward-paper data, research only. A plan whose next open is already past its stop or target is skipped, never filled at an invented price; no plan fills across the CME daily break, and positions go flat by 16:55 New York. Each strategy runs in its own isolated portfolio, every closed trade is validated and journalled append-only, and stopping paper trading voids an open position instead of closing it at a later price. Real fills can be worse: queue position, partial fills and fast markets are not modelled.',
    },
    analogy: 'Paper trading is like a flight simulator: it uses real instruments and real weather, but no one is in the air, and a perfect landing in it is not a pilot\'s licence.',
    che_note: 'From the code: trading_evidence.js fillEntry, exitOn, fillExit, settleTrade and stepPortfolio fill and settle each trade with COSTS; trading_live.js liveTick runs every minute while CME is open on market_feed.js loadIntraday bars, journals closed trades with appendTrades, and imports no broker module; newPortfolio refuses any source other than paper or backtest. A paper result is never permission for a real order: a live order still needs the owner\'s explicit yes on the trading desk.',
    compute: 'tPaperFill', inputs: { symbol: 'MNQ', side: 'long', open: 21000, stop: 20990, exitReason: 'target', exitPrice: 21020, qty: 1 }, result: { entryFill: 21000.375, exitFill: 21019.875, gross: 40, net: 35, rNet: 1.75 }, unit: '$ and price',
    f: ['A paper fill in CHE\'s engine', 'entry = next open ± (½ spread + slippage);  stop or time exit = price ∓ (½ spread + slippage);  target exit = target ∓ ½ spread;  net = gross − spread − slippage − commissions − fees', 'the entry is the next bar\'s open plus half the spread and the slippage; a stop exit pays both again, a target only half the spread; the net is the gross minus every cost',
      [['next open', 'the open of the bar after the signal bar', 'price'], ['spread, slippage', '1 tick of spread, half on each side, and 1 tick of slippage on market orders', 'index points'], ['commissions, fees', '$1.50 and $0.50 per contract per side', '$']],
      'CHE\'s planning costs (trading_evidence.js COSTS), not a broker\'s fills; delayed bars.'],
    quiz: [
      { q: 'A long MNQ paper trade enters at a 21,000 open with a 20,990 stop and is stopped out at 20,990. What is the net after CHE\'s costs?', a: '−$25.50: −$20 gross, then $0.50 spread, $1.00 slippage, $3.00 commissions and $1.00 fees.', check: { compute: 'tPaperFill', inputs: { symbol: 'MNQ', side: 'long', open: 21000, stop: 20990, exitReason: 'stop', exitPrice: 20990, qty: 1 }, result: { entryFill: 21000.375, exitFill: 20989.625, gross: -20, net: -25.5, rNet: -1.275 }, shown: ['−$25.50'] } },
      { q: 'Why does a target exit pay less than a stop exit?', a: 'A target is a resting limit, which cannot fill worse than its price, so only half the spread is charged; a stop is a market order and also pays slippage.' },
      { q: 'Does a profitable paper record allow CHE to place a real order?', a: 'No. Paper is research on delayed data; a live order still needs the owner\'s explicit yes.' },
    ],
    misconceptions: ['A paper profit is not money that a live account would have made: real fills, queue position and delays differ.'],
    limitations: ['Paper results are delayed forward-paper data with assumed costs, not broker fills; fast markets, partial fills and queue position are not modelled.', 'A paper record is never permission for a live order.'],
    sources: [ref('Paper trading', 'Wikipedia', 'https://en.wikipedia.org/wiki/Paper_trading'), CHE_CODE('trading_evidence.js (fillEntry, exitOn, settleTrade, stepPortfolio)'), CHE_CODE('trading_live.js (liveTick, setLivePaper)'), CHE_CODE('market_feed.js (loadIntraday, aggregate)')],
  }),
  calcCard({
    id: 't-monte-carlo', domain: 'trading', title: 'Monte Carlo of trade sequences', level: 'expert',
    summary: 'Reshuffle or resample recorded trades thousands of times to see the range of equity paths and drawdowns.',
    aliases: ['monte carlo', 'monte carlo simulation', 'monte carlo analysis', 'trade sequence simulation', 'bootstrapping trades', 'bootstrap resampling', 'resampling trades', 'equity path simulation', 'drawdown distribution'],
    tags: ['statistics', 'risk', 'research'], prerequisites: ['drawdown', 'expectancy'], related: ['t-risk-of-ruin', 'drawdown', 't-strategy-evaluation'],
    levels: {
      beginner: 'One backtest shows one order of trades, but the same trades could have come in another order. A Monte Carlo simulation shuffles or redraws the trades thousands of times and shows the spread of results: the typical path, a bad path, and how deep the drawdowns could be.',
      intermediate: 'Two ways: a reshuffle uses every trade once in a new order, so the final result never changes but the drawdown does; a bootstrap draws trades with replacement, so the final result varies too. Report percentiles, such as the median and the 95th percentile drawdown. A fixed seed makes the run repeatable.',
      expert: 'The simulation can only recombine what the record holds: it assumes trades are independent and drawn from an unchanging distribution, so it misses streaks caused by regimes and any loss larger than the worst recorded. With few trades it repeats their luck. Use it to size risk against a drawdown you can bear, not to prove an edge; the mean of a bootstrap is the record\'s own mean.',
    },
    analogy: 'A Monte Carlo is like shuffling a deck you already hold and dealing it many times: you learn how the hands can fall, but no new cards appear.',
    che_note: 'Say "run a Monte Carlo on my trades": CHE simulates only the closed trades in the paper journal, with a fixed seed, and says when there are too few.',
    compute: 'tMonteCarlo', inputs: { results: [2, -1, -1, 2, -1], paths: 200, seed: 7, replace: false }, result: { finalP5: 1, finalP50: 1, finalP95: 1 }, unit: 'R',
    f: ['Monte Carlo of trade order', 'for each path: draw the trades (reshuffle or with replacement), add them in order, keep the final result and the largest peak-to-trough fall; report percentiles', 'each path draws the recorded trades in a new order, adds them up and keeps its final result and its largest fall, and the report gives percentiles across all paths',
      [['results', 'the recorded trade results', 'R or $'], ['paths', 'how many simulated sequences', 'a count'], ['seed', 'the generator\'s starting number', 'a whole number']],
      'Seeded mulberry32 generator; trades independent and drawn from the record itself.'],
    quiz: [
      { q: 'In a reshuffle of the same five trades, does the final result change between paths?', a: 'No: the same trades add to the same total; only the order, and so the drawdown, changes.' },
      { q: 'What does a fixed seed give you?', a: 'The same simulation every time, so the result can be checked.' },
      { q: 'Can a Monte Carlo show a loss bigger than any recorded trade?', a: 'Not by resampling: it only recombines the trades that were recorded.' },
    ],
    misconceptions: ['A Monte Carlo is not new evidence: it reuses the same trades, so it cannot prove an edge.'],
    limitations: ['Assumes independent trades from an unchanging distribution; regimes and streaks are missed.', 'With a small record it repeats that record\'s luck.'],
    sources: [ref('Monte Carlo method', 'Wikipedia', 'https://en.wikipedia.org/wiki/Monte_Carlo_method'), ref('Bootstrapping (statistics)', 'Wikipedia', 'https://en.wikipedia.org/wiki/Bootstrapping_(statistics)'), VINCE, CHE_CODE('atlas_math.js (mulberry32)')],
  }),
  calcCard({
    id: 't-risk-of-ruin', domain: 'trading', title: 'Risk of ruin', level: 'expert',
    summary: 'The chance that a run of losses takes the account down to a level you cannot trade from.',
    aliases: ['risk of ruin', 'ruin probability', 'probability of ruin', 'gamblers ruin', 'gambler\'s ruin', 'blowing up an account', 'chance of ruin'],
    tags: ['risk', 'statistics', 'advanced'], prerequisites: ['t-monte-carlo', 'risk-management'], related: ['t-monte-carlo', 'risk-management', 'expectancy'],
    levels: {
      beginner: 'Risk of ruin is the chance of losing so much that you cannot keep trading. It grows when each trade risks a bigger slice of the account and shrinks when the strategy has a real edge. Even a winning strategy can be ruined by risking too much on each trade.',
      intermediate: 'For equal wins and losses of one unit, with win rate p above one half and q = 1 − p, the classic gambler\'s-ruin answer over an endless run is (q ÷ p) raised to the number of units of room. Winning 55% with 10 losses of room gives (0.45 ÷ 0.55)^10, about 13.4%. For other payoffs CHE runs a seeded Monte Carlo.',
      expert: 'The simulation assumes a fixed dollar risk, independent trades and a known, fixed win rate and payoff, none of which hold exactly: estimation error in the win rate alone can multiply the true risk. Fixed-fraction sizing never reaches zero in theory but suffers the same drawdowns in percent. Set "ruin" as the loss limit you would really stop at, not zero, and read the result as a lower bound.',
    },
    analogy: 'Risk of ruin is like a boat crossing rough water with low sides: even with a good engine, enough big waves in a row will sink it, so you raise the sides by risking less each trade.',
    compute: 'tRiskOfRuin', inputs: { winRate: 0.55, avgWinR: 1, avgLossR: 1, riskPerTrade: 100, account: 1000, ruinAt: 0, trades: 200, paths: 400, seed: 7 }, result: { classic: 0.134431 }, unit: 'probability',
    f: ['Risk of ruin', 'Monte Carlo: ruined paths ÷ all paths;  equal wins and losses: (q ÷ p)^units', 'the risk of ruin is the share of simulated paths that hit the ruin level, and with equal wins and losses the classic answer is q over p, raised to the units of room',
      [['p, q', 'win rate and loss rate', 'fractions'], ['units', '(account − ruin level) ÷ risk per trade', 'losing trades of room'], ['paths, seed', 'simulated sequences and the generator\'s seed', 'counts']],
      'Fixed dollar risk, independent trades, fixed win rate and payoff, no costs; a lower bound on the real risk.'],
    quiz: [
      { q: 'Win rate 60%, equal wins and losses, 5 units of room: what is the classic risk of ruin?', a: 'About 13.2%: (0.4 ÷ 0.6)^5.', check: { compute: 'tRiskOfRuin', inputs: { winRate: 0.6, riskPerTrade: 100, account: 500, trades: 50, paths: 200, seed: 1 }, result: { classic: 0.131687 }, shown: ['13.2%'] } },
      { q: 'What happens to the risk of ruin when you double the risk per trade?', a: 'It rises sharply: the room halves, and the classic formula has the room in the exponent.' },
      { q: 'With a 50% win rate and equal wins and losses, what is the classic risk of ruin over an endless run?', a: '100%: without an edge, ruin comes eventually.' },
    ],
    misconceptions: ['A positive expectancy does not make ruin impossible: oversized risk can still end the account.'],
    limitations: ['Assumes a known, fixed win rate and payoff; estimation error alone can make the real risk far higher.', 'Costs, slippage and correlated losses are not in the model.'],
    sources: [ref('Gambler\'s ruin', 'Wikipedia', 'https://en.wikipedia.org/wiki/Gambler%27s_ruin'), ref('Risk of ruin', 'Wikipedia', 'https://en.wikipedia.org/wiki/Risk_of_ruin'), VINCE, CHE_CODE('atlas_math.js (riskOfRuin)')],
  }),
];

/** The trading lane's cards, in curriculum order after the phase-1 trading cards. */
export const ATLAS_TRADING_CARDS = Object.freeze(CARDS);

// Limitations for the phase-1 trading cards, which predate the field (knowledge_atlas.js keeps their text).
const PHASE1_LIMITATIONS = Object.freeze({
  'tick-value': ['Specs are CME\'s and can change: verify against the exchange.', 'Profit and loss here is before commissions, fees, spread and slippage.'],
  'bid-ask-spread': ['CHE has no live quote feed; its spread and slippage are planning assumptions, not measured fills.'],
  'r-multiple': ['R hides position size: two trades of +1R can be very different amounts of money.', 'Slippage through a stop can make a loss worse than −1R.'],
  'risk-management': ['The stop is assumed to fill at its price; gaps and fast markets fill worse.', 'Position size from one trade\'s stop ignores correlated positions held at the same time.'],
  expectancy: ['An estimate from past trades: its range must be read with it, and the future can differ.', 'Measured after assumed costs; real fills can be worse.'],
  'win-rate-ci': ['Assumes independent trades with one fixed win probability, which regime changes break.', 'A win rate means nothing without the payoff.'],
  'profit-factor': ['Ignores the order of trades, so it says nothing about drawdowns.', 'A few large trades can move it a lot.'],
  drawdown: ['One path only: other orders of the same trades can go deeper.', 'Closed-trade equity misses the swings while trades are open.'],
  vwap: ['Bar typical prices approximate trade prices; delayed public bars may have partial volume.', 'VWAP describes the session; it does not predict.'],
  'sample-size': ['The normal approximation is rough below about 30 trades.', 'Correlated trades carry less information than their count suggests.'],
});
/** A phase-1 trading card with its limitations, in the same frozen shape. */
export const withLimitations = (c) => (c.limitations ? c : Object.freeze({ ...c, limitations: PHASE1_LIMITATIONS[c.id] || [] }));

const BY_ID = new Map(CARDS.map((c) => [c.id, c]));

// ─── Records: read only, each labelled by where it came from ─────────────

/** CHE's trading records, read only: the paper journal, the stored backtest, the stored bars, paper trading state and the desk. */
export async function loadTradingRecords(storage) {
  const empty = { paper: [], backtest: null, feed: null, state: null, desk: null };
  if (!storage) return empty;
  try {
    const [paper, backtest, feed, state] = await Promise.all([
      readTrades(storage, (t) => t?.environment === 'paper'), storage.get(LIVE_BACKTEST), storage.get(LIVE_FEED), storage.get(LIVE_STATE),
    ]);
    const desk = await readDesk(storage);
    const records = { paper: Array.isArray(paper) ? paper : [], backtest: backtest || null, feed: feed || null, state: state || null, desk };
    books(records); // a journal record the statistics cannot read makes the journal unreadable, never a crash
    return records;
  } catch (_) {
    return { ...empty, unreadable: true };
  }
}

const NY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const nyTime = (iso) => (iso && Number.isFinite(Date.parse(iso)) ? `${NY.format(new Date(iso))} New York time` : 'an unknown time');
const label = (key) => PROVENANCE[key].charAt(0).toUpperCase() + PROVENANCE[key].slice(1);
const signedR = (x) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(2)}R`;

/** The broker SIM and live-order lines: order records on the desk, or "no records". Never a number without one. */
function brokerLines(records) {
  const alerts = Array.isArray(records.desk?.alerts) ? records.desk.alerts : [];
  const placed = (mode) => alerts.filter((a) => a.mode === mode && a.status === 'placed').length;
  const line = (key, n) => (n
    ? `${label(key)}: ${n} order record${n === 1 ? '' : 's'} on the desk, with no recorded fills or results, so no statistics.`
    : `${label(key)}: no records.`);
  return [line('sim', placed('sim')), line('live', placed('live'))];
}

function backtestRows(records) {
  const bt = records.backtest;
  return bt?.ok && Array.isArray(bt.rows) ? bt.rows.filter((r) => Number(r?.stats?.trades) > 0) : [];
}
const backtestHead = (records) => `${label('backtest')}, stored ${String(records.backtest?.at || '').slice(0, 10)}, ${records.backtest?.data || 'unnamed data'}`;
const span = (values, show) => {
  const v = values.filter(Number.isFinite);
  if (!v.length) return 'not measured';
  const lo = Math.min(...v); const hi = Math.max(...v);
  return lo === hi ? show(lo) : `${show(lo)} to ${show(hi)}`;
};

const strategyName = (id) => INTRADAY_CANDIDATES[id]?.name || CANDIDATES[id]?.name || String(id || 'unnamed strategy');
/** The paper journal as separate portfolios, largest first: each is its own strategy and its own record. */
export function books(records) {
  const groups = new Map();
  for (const t of records.paper || []) {
    const key = String(t?.portfolio || '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  return [...groups.values()].map((trades) => {
    const t = trades[0];
    const bars = t?.data?.resolution === '5m' ? 'five-minute bars' : t?.data?.resolution ? `${t.data.resolution} bars` : 'daily bars';
    const name = `${strategyName(t?.strategy).replace(/^./, (x) => x.toUpperCase())} on ${t?.contract || t?.symbol || 'MNQ'}, ${bars}${t?.filter && t.filter !== 'any' ? `, ${t.filter} filter` : ''}${Number.isFinite(t?.params?.target_r) ? `, ${t.params.target_r}R target` : ''}`;
    return { name, trades, s: summarize(trades) };
  }).sort((a, b) => b.s.trades - a.s.trades || a.name.localeCompare(b.name));
}

const where = (list, total) => (list.length > 1
  ? `${total} closed paper trades in ${list.length} separate paper portfolios, each its own strategy, so nothing is pooled`
  : `${total} closed paper trade${total === 1 ? '' : 's'} in 1 paper portfolio, one strategy`);

/** One line per provenance label for a metric, so every number says where it came from; paper portfolios are never pooled. */
export function provenanceText(records, metric = 'expectancy') {
  const lines = [];
  const list = books(records);
  if (records.unreadable) lines.push(`${label('paper')}: I could not read CHE's paper journal just now, so I give no numbers from it.`);
  else if (!list.length) lines.push(`${label('paper')}: no recorded trades yet in CHE's paper journal.`);
  else {
    const show = {
      expectancy: [(s) => `expectancy ${signedR(s.expectancy_r)} per trade after assumed costs`, (s) => s.expectancy_r, signedR, 'expectancy'],
      win_rate: [(s) => `win rate ${s.win_rate}%, ${s.wins} wins and ${s.losses} losses`, (s) => s.win_rate, (x) => `${x}%`, 'win rate'],
      profit_factor: [(s) => `profit factor ${s.profit_factor ?? 'not defined, because no trade lost'}`, (s) => s.profit_factor, (x) => `${x}`, 'profit factor'],
    }[metric] || [(s) => `net ${usd(s.net_pnl)} after assumed costs`, (s) => s.net_pnl, usd, 'net results'];
    const [line, value, fmt, what] = show;
    const total = list.reduce((n, b) => n + b.s.trades, 0);
    const top = list[0];
    lines.push(`${label('paper')}, CHE's paper journal: ${where(list, total)}. ${list.length > 1 ? 'The largest is' : 'It is'} ${top.name}: ${top.s.trades} trade${top.s.trades === 1 ? '' : 's'}, ${line(top.s)}.${list.length > 1 ? ` Across the ${list.length} portfolios, ${what} ranged ${span(list.map((b) => value(b.s)), fmt)}.` : ''}`);
  }
  const rows = backtestRows(records);
  if (rows.length) {
    const total = rows.reduce((n, r) => n + r.stats.trades, 0);
    const across = {
      expectancy: `expectancy ranged ${span(rows.map((r) => r.stats.expectancy_r), signedR)}`,
      win_rate: `win rate ranged ${span(rows.map((r) => r.stats.win_rate), (x) => `${x}%`)}`,
      profit_factor: `profit factor ranged ${span(rows.map((r) => r.stats.profit_factor), (x) => `${x}`)}`,
    }[metric] || `net results ranged ${span(rows.map((r) => r.stats.net_pnl), usd)}`;
    lines.push(`${backtestHead(records)}: ${rows.length} strategy portfolio${rows.length === 1 ? '' : 's'} with ${total} trades; ${across} across them. History, not a forward result.`);
  } else {
    lines.push(`${label('backtest')}: no stored backtest with trades yet.`);
  }
  lines.push(...brokerLines(records));
  return lines.join(' ');
}

// ─── Understanding the owner's words ──────────────────────────────────────

const UNITS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
/** Spoken numbers to digits: "two hundred" → 200, "twelve point five" → 12.5. Only for reading a calculation. */
export function digits(text) {
  const tokens = String(text).split(/(\s+)/);
  const out = [];
  let run = null;
  let space = '';
  const flush = () => { if (run) { out.push(String(run.total + run.part + run.dec)); run = null; } out.push(space); space = ''; };
  for (let i = 0; i < tokens.length; i += 1) {
    const w = tokens[i];
    // A space inside a spoken number ("two hundred") is held until the number ends.
    if (/^\s+$/.test(w)) { if (run) space = w; else out.push(w); continue; }
    const k = w.replace(/[-,]$/, '');
    const n = UNITS[k] ?? TENS[k];
    if (n != null && !(run?.decimal)) { run ||= { total: 0, part: 0, dec: 0 }; run.part += n; space = ''; continue; }
    if (n != null && run?.decimal) { run.dec = Number(`0.${n}`); run.decimal = false; space = ''; continue; }
    if (run && k === 'hundred') { run.part = (run.part || 1) * 100; space = ''; continue; }
    if (run && k === 'thousand') { run.total += (run.part || 1) * 1000; run.part = 0; space = ''; continue; }
    if (run && k === 'point' && UNITS[tokens[i + 2]] != null && tokens[i + 2] !== 'zero') { run.decimal = true; space = ''; continue; }
    flush();
    out.push(w);
  }
  flush();
  return out.join('').replace(/\s+/g, ' ');
}

const SYMBOL = /\b(mnq|nq|mes|es|micro (?:e ?mini )?nasdaq(?: 100)?|e ?mini nasdaq(?: 100)?|micro (?:e ?mini )?s ?& ?p(?: 500)?|e ?mini s ?& ?p(?: 500)?)\b/;
const symbolOf = (word = '') => {
  const w = word.replace(/-/g, ' ');
  if (/^(?:mnq|nq|mes|es)$/.test(w)) return w.toUpperCase();
  if (/nasdaq/.test(w)) return /micro/.test(w) ? 'MNQ' : 'NQ';
  if (/s ?& ?p/.test(w)) return /micro/.test(w) ? 'MES' : 'ES';
  return '';
};
const N = '(\\d[\\d,]*(?:\\.\\d+)?)';
const toNum = (s) => (s == null ? NaN : Number(String(s).replace(/,/g, '')));
const findNum = (text, re) => { const m = re.exec(text); return m ? toNum(m[1]) : NaN; };

// A contract count is a whole positive number. "1.5 MNQ", "2.5 MNQ" and "-2 MNQ" are reported as a
// problem and never changed into 1 or 2 (issue #346 audit): the sizing answers refuse them.
const COUNT = `(?:^|[^\\w.])(-|−)?${N}`;
function countOf(sign, text) {
  const n = toNum(text);
  if (sign) return { contracts: -n, problem: 'negative' };
  if (!Number.isInteger(n)) return { contracts: n, problem: 'fraction' };
  if (n < 1) return { contracts: n, problem: 'zero' };
  return { contracts: n, problem: '' };
}
function contractsOf(s) {
  const sym = SYMBOL.source.slice(3, -3);
  const a = new RegExp(`${COUNT} (?:${sym})(?: futures?)?(?: contracts?)?\\b`).exec(s);
  if (a) return { ...countOf(a[1], a[2]), symbol: symbolOf(SYMBOL.exec(a[0])?.[1]) };
  const b = new RegExp(`${COUNT} contracts? (?:of )?(?:the )?(${sym})\\b`).exec(s);
  if (b) return { ...countOf(b[1], b[2]), symbol: symbolOf(b[3]) };
  const c = new RegExp(`${COUNT} contracts?\\b`).exec(s);
  if (c) return { ...countOf(c[1], c[2]), symbol: symbolOf(SYMBOL.exec(s)?.[1]) };
  return { contracts: NaN, problem: '', symbol: symbolOf(SYMBOL.exec(s)?.[1]) };
}
/** The refusal intent for a count that is not a whole positive number, or null when the count is fine. */
const countRefusal = (c, card) => (c.problem ? { kind: 't_count', card, problem: c.problem, count: c.contracts, symbol: c.symbol || '' } : null);
function stopOf(s) {
  const unit = (u) => (/^tick/.test(u) ? 'stopTicks' : 'stopPoints');
  const a = new RegExp(`\\b${N}[ -]?(points?|pts?|ticks?)(?: wide)? (?:stop|stop loss|stop-loss)\\b`).exec(s);
  if (a) return { [unit(a[2])]: toNum(a[1]) };
  const b = new RegExp(`\\bstop(?: loss)?(?: of| is| at|:)? ${N}[ -]?(points?|pts?|ticks?)(?: away)?\\b`).exec(s);
  if (b) return { [unit(b[2])]: toNum(b[1]) };
  return {};
}
function budgetOf(s) {
  const pctOf = new RegExp(`\\b${N} ?(?:%|percent) (?:of|on) (?:a |an |my |the )?\\$?${N}(k)?(?: dollars?)?(?: account)?`).exec(s);
  if (pctOf) return { riskPercent: toNum(pctOf[1]), account: toNum(pctOf[2]) * (pctOf[3] ? 1000 : 1) };
  const d = new RegExp(`\\brisk(?:ing)?(?: of| only| just| up to)? \\$${N}|\\brisk(?:ing)?(?: of| only| just| up to)? ${N} dollars\\b|\\$${N} (?:of )?risk\\b|\\b${N} dollars (?:of )?risk\\b`).exec(s);
  if (d) return { riskDollars: toNum(d[1] ?? d[2] ?? d[3] ?? d[4]) };
  return {};
}
function feesOf(s) {
  const m = new RegExp(`\\b(?:with|plus|including|and) \\$?${N}(?: dollars?)? (?:in |of )?(round[ -]?trip |per side |a side )?(?:commissions?|fees?|costs?)(?: (?:and fees )?(per|a) (contract|side|round trip))?`).exec(s);
  if (!m) return {};
  const perSide = /side/.test(`${m[2] || ''} ${m[4] || ''}`);
  return { roundTripFees: toNum(m[1]) * (perSide ? 2 : 1), feesSaid: `${usd(toNum(m[1]))} ${perSide ? 'per side, so twice that for a round trip' : 'a round trip'}` };
}
const priceAfter = (s, words) => findNum(s, new RegExp(`\\b(?:${words})(?: price)?(?: at| of| is|:| =)? \\$?${N}`));
// The entry: named as one, or the first "at" price that is not a stop's or a target's.
const entryOf = (s) => {
  const named = priceAfter(s, 'entry|enter(?:ing)?(?: at)?|entered(?: at)?|in at|bought at|filled at');
  return Number.isFinite(named) ? named : findNum(s, new RegExp(`(?<!\\b(?:stop|loss|target|tp|profit|exit) )\\bat \\$?${N}`));
};

/** The prices inside a stated trade plan: ", stop 17990", ", target 18030". */
export const PLAN_PRICES = /(?:[,;]|\band\b)\s+(?:stop|target|take profit|entry|exit)(?: loss)?(?: at| of| is|:)?\s+\$?\d[\d,.]*/g;
// An order asked for in the turn keeps its own route: "buy 2 MNQ", "place a trade", "and if it's good, buy it".
const ORDER_VERB = /(?:^|[,.;:!?]\s*|\b(?:and|then|also|now|so)\s+(?:(?:if so|if it is|if it'?s good|if yes|if good)\s*,?\s+)?)(?:please\s+)?(?:place|submit|enter|buy|sell|short|go long|go short|take (?:the|a|this|that|it)\b|open a (?:position|trade)|order(?! (?:blocks?|books?|types?|flow)\b)|prepare|set up|reverse|flatten|close|execute|send)\b/;

const ASK = '(?:what(?:\'s| is| would be| will be| are)?|whats|how much|how many|calculate|compute|work out|figure out|tell me|give me|show me)';
const KINDS = new Set(['t_risk', 't_size', 't_count', 't_shares', 't_option', 't_evaluate', 't_vwap', 't_or', 't_winrate', 't_expectancy', 't_strategy', 't_montecarlo', 't_samplesize', 't_compare']);
export const isTradingAtlasKind = (kind) => KINDS.has(kind);

/**
 * A calculation or a reading of CHE's records for the Knowledge Atlas, or null. `t` is the turn as
 * knowledge_atlas.js normalised it (lower case, CHE's name and end punctuation gone). Order requests
 * and the Trading Room's analysis turns return null, so they keep their own routes.
 */
export function tradingAtlasIntent(t, { findCard = () => null, cardById = () => null } = {}) {
  const raw = String(t || '');
  if (!raw || /\banaly[sz]/.test(raw)) return null;
  const s = digits(raw.replace(/[’']/g, "'").replace(/\bm n q\b/g, 'mnq').replace(/\bn q\b/g, 'nq').replace(/\bm e s\b/g, 'mes'));
  // A trade being judged starts with its side ("is this a good trade: short 2 NQ at …"); that word describes the plan.
  const asked = withoutProhibitions(s).replace(/^((?:is|would|evaluate|rate|grade|check|what do you think)\b[^:]*?\btrade\b(?: idea| plan)?[\s:,-]*)(?:long|short)\b/, '$1');
  if (ORDER_VERB.test(asked) || (ORDER_ASK.test(asked) && !new RegExp(`^${ASK}\\b|^(?:is|would|should|evaluate|rate|grade|explain)\\b`).test(asked))) return null;

  // "What's the difference between BOS and CHOCH?"
  const diff = /^(?:what(?:'s| is| are)|whats|explain|tell me) the differences? between (?:a |an |the )?(.+?) and (?:a |an |the )?(.+)$/.exec(s);
  if (diff) {
    const a = findCard(diff[1]); const b = findCard(diff[2]);
    if (a && b) return { kind: 't_compare', card: a, other: b };
    return null;
  }

  // "Is this a good trade: long MNQ at 18000, stop 17990, target 18030?"
  const evaluate = /^(?:is (?:this|that|it) a good trade|would (?:this|that) be a good trade|is (?:this|that) trade (?:any )?good|evaluate (?:this|that|the|my) trade(?: idea| plan)?|rate (?:this|that|my) trade|grade (?:this|that) trade|what do you think (?:of|about) (?:this|that) trade|check (?:this|that|my) trade(?: plan)?)\b[\s:,-]*(.*)$/.exec(s);
  // Only a plan with prices: a bare "is this a good trade?" about a chart on screen keeps its usual route.
  if (evaluate && /\d/.test(evaluate[1] || '')) {
    const plan = evaluate[1] || '';
    const side = /\bshort\b/.test(plan) ? 'short' : 'long';
    const { contracts, symbol, problem } = contractsOf(plan);
    const refused = countRefusal({ contracts, problem, symbol }, BY_ID.get('t-futures'));
    if (refused) return refused;
    const entry = entryOf(plan);
    const stop = priceAfter(plan, 'stop(?: loss)?|sl');
    const target = priceAfter(plan, 'target|take profit|tp|profit target|exit');
    return { kind: 't_evaluate', card: BY_ID.get('t-order-types'), plan: { side, symbol: symbol || '', contracts: Number.isInteger(contracts) && contracts > 0 ? contracts : 1, contractsSaid: Number.isInteger(contracts) && contracts > 0, entry, stop, target, ...feesOf(plan) } };
  }

  // "How many MNQ contracts can I trade risking $200 with a 10 point stop?" and "how many MNQ can I risk $200
  // with a 10 point stop": the largest whole number of contracts in the budget. A sizing question names a
  // budget or a stop, or asks what the owner can trade: "how many contracts are open" is not one.
  const sizing = (x) => Object.keys(stopOf(x)).length || Object.keys(budgetOf(x)).length || /\b(?:can|could|should|may) i (?:trade|buy|sell|use|afford|risk|take|run|hold)\b/.test(x);
  // A contract symbol counts as a sizing question only with a budget or a stop: "how many MNQ trades can I take" is not one.
  const sized = /\bcontracts?\b|\bmicros?\b/.test(s) || (SYMBOL.test(s) && (Object.keys(stopOf(s)).length || Object.keys(budgetOf(s)).length));
  if (new RegExp(`^${ASK}\\b`).test(s) && /\bhow many\b/.test(s) && sized && sizing(s)) {
    const counted = contractsOf(s);
    const refused = countRefusal(counted, BY_ID.get('t-futures'));
    if (refused) return refused;
    return { kind: 't_size', card: BY_ID.get('t-futures'), inputs: { symbol: counted.symbol, ...stopOf(s), ...budgetOf(s), ...feesOf(s) } };
  }
  // "How many shares can I buy risking $100 with an entry at 50 and a stop at 48?"
  if (/\bhow many shares\b/.test(s) && (Object.keys(budgetOf(s)).length || /\bstop\b/.test(s))) {
    const entry = entryOf(s);
    const stop = priceAfter(s, 'stop(?: loss)?');
    const dist = findNum(s, new RegExp(`\\b(?:a |with a )?\\$${N}(?: per share)? stop\\b`));
    return { kind: 't_shares', card: BY_ID.get('t-stocks'), inputs: { ...budgetOf(s), entry, stop: Number.isFinite(stop) ? stop : undefined, stopDistance: Number.isFinite(dist) ? dist : undefined } };
  }
  // "What is my risk on 2 MNQ contracts with a 12 point stop?"
  if (new RegExp(`^${ASK}\\b`).test(s) && /\b(?:risk|risking|at risk|lose|loss|on the line)\b/.test(s) && SYMBOL.test(s)) {
    const counted = contractsOf(s);
    const stops = stopOf(s);
    const entry = entryOf(s);
    const stop = priceAfter(s, 'stop(?: loss)?');
    const prices = !stops.stopPoints && !stops.stopTicks && Number.isFinite(entry) && Number.isFinite(stop) ? { entry, stop } : {};
    // "What's my risk on MNQ right now?" asks about open positions, not a calculation: it needs a stop.
    if (!Object.keys(stops).length && !Object.keys(prices).length) return null;
    const refused = countRefusal(counted, BY_ID.get('t-futures'));
    if (refused) return refused;
    const contractsSaid = Number.isInteger(counted.contracts);
    return { kind: 't_risk', card: BY_ID.get('t-futures'), inputs: { symbol: counted.symbol, contracts: contractsSaid ? counted.contracts : 1, contractsSaid, ...stops, ...prices, ...feesOf(s) } };
  }
  // "What's the breakeven on a long call with a 100 strike and a $3 premium?"
  if (/\b(?:breakeven|break even|max(?:imum)? (?:loss|gain|profit)|most i can (?:lose|make)|intrinsic value|payoff)\b/.test(s) && /\b(?:calls?|puts?)\b/.test(s)) {
    const type = /\bputs?\b/.test(s) ? 'put' : 'call';
    const position = /\b(?:short|sold|sell|sells|selling|write|wrote|writing)\b/.test(s) ? 'short' : 'long';
    const strike = findNum(s, new RegExp(`\\b\\$?${N}(?: dollar)? strike\\b`)) || findNum(s, new RegExp(`\\bstrike(?: price)?(?: of| at| is)? \\$?${N}`));
    const premium = findNum(s, new RegExp(`\\b\\$?${N}(?: dollars?)? premium\\b`)) || findNum(s, new RegExp(`\\bpremium(?: of| is| at)? \\$?${N}|\\b(?:paid|for|costs?|costing) \\$?${N}`));
    const underlying = findNum(s, new RegExp(`\\b(?:stock|underlying|shares?|price) (?:is |goes to |at |ends at |closes at )\\$?${N}|\\bexpires? (?:with the stock )?at \\$?${N}`));
    const contracts = findNum(s, new RegExp(`\\b${N} (?:option )?contracts?\\b`));
    return { kind: 't_option', card: BY_ID.get('t-options'), inputs: { type, position, strike, premium, underlying: Number.isFinite(underlying) ? underlying : undefined, contracts: Number.isInteger(contracts) && contracts > 0 ? contracts : 1 } };
  }
  // "Explain VWAP and calculate it from the latest bars."
  const fromBars = /\b(?:latest|stored|recent|current|real|today'?s|last|live) (?:\w+ )?(?:bars?|data|prices?|candles?|feed|market data)\b|\bfrom (?:the |your |my )?(?:bars|data|feed|candles)\b|\bright now\b|\btoday\b/;
  const computeWord = /\b(?:calculate|compute|work out|figure out|give me|show me|what(?:'s| is)|whats|read me)\b/;
  if (/\bvwap\b/.test(s) && computeWord.test(s) && fromBars.test(s)) return { kind: 't_vwap', card: BY_ID.get('t-vwap-bands'), explain: /^(?:explain|teach me|tell me about|what is vwap)\b/.test(s) ? cardById('vwap')?.levels?.beginner || '' : '' };
  if (/\bopening range\b/.test(s) && computeWord.test(s) && fromBars.test(s)) return { kind: 't_or', card: BY_ID.get('t-opening-range'), minutes: findNum(s, /\b(\d+)[ -]?minute/) || 15 };

  // Readings of the owner's own records, asked for by name. "My trading performance", "my positions" and "my win rate"
  // stay with the Trading Room and the evidence report, which hold those records.
  if (/\b(?:confidence interval|confidence range|95% range|wilson(?: interval| range)?|margin of error|error bars?|range)\b[\s\S]{0,30}\b(?:my|our|your) (?:paper )?(?:trading )?win rate\b|\b(?:my|our|your) (?:paper )?win rate'?s? (?:confidence interval|wilson interval|95% range|margin of error)\b/.test(s)) {
    const conf = findNum(s, /\b(80|90|95|98|99) ?(?:%|percent)/);
    return { kind: 't_winrate', card: cardById('win-rate-ci') || BY_ID.get('t-trades-needed'), confidence: Number.isFinite(conf) ? conf / 100 : 0.95 };
  }
  if (/^(?:what(?:'s| is)|whats|tell me|show me|calculate|compute|give me|read me|work out) (?:my|our|your) (?:paper )?(?:trading )?expectancy(?: so far| now| right now| per trade| in r)?$/.test(s)) return { kind: 't_expectancy', card: BY_ID.get('t-strategy-evaluation') };
  if (/^(?:evaluate|assess|review|grade|rate|judge|score|audit|check) (?:my|our|your) (?:(?:trading|paper|current) )?strateg(?:y|ies)$|^how good (?:is|are) (?:my|our|your) (?:trading|paper) strateg(?:y|ies)$/.test(s)) return { kind: 't_strategy', card: BY_ID.get('t-strategy-evaluation') };
  if (/\bmonte carlo\b/.test(s) && /\b(?:my|our|your) (?:paper )?(?:closed )?trades\b/.test(s) && /^(?:run|do|give me|show me|simulate|calculate|compute|what does a)\b/.test(s)) {
    return { kind: 't_montecarlo', card: BY_ID.get('t-monte-carlo'), seed: findNum(s, /\bseed (\d+)\b/) || 1 };
  }
  const sample = new RegExp(`\\bhow many trades\\b[\\s\\S]{0,60}?(?:plus or minus |±|within )?${N} ?(?:%|percent|percentage points?)`).exec(s);
  if (sample) return { kind: 't_samplesize', card: BY_ID.get('t-trades-needed'), margin: toNum(sample[1]) / 100 };
  return null;
}

// ─── What CHE says ───────────────────────────────────────────────────────

const sourceOf = (c, calc) => `Source: Knowledge Atlas card "${c.title}" (trading), ${calc ? `calculator ${calc} in atlas_math.js, ` : ''}curated teaching content checked by CHE's tests, revision ${c.revision}.`;
const stepsText = (out) => out.steps.join('; ');
const specLine = (s) => `Contract spec: ${s.symbol} ${s.name}, ${usd(s.pointValue)} a point, ${s.tick}-point tick of ${usd(s.tickValue)}, from CME Group; ${SPEC_SOURCE.caveat.toLowerCase()}`;
const NO_ORDER = 'I placed and prepared no order; this is a calculation.';

function verdictLine(v) {
  return `Verdict: ${v.verdict}, because ${v.reasons.join(', and ')}. Criteria: ${VERDICT_RULES.text}`;
}

// Every paper portfolio is its own strategy and its own record (as knowledge_atlas.js measuredText
// reads them), so statistics and verdicts are given one portfolio at a time and never pooled.
function bookStats(b) {
  const rs = b.trades.map((t) => t.r_net).filter(Number.isFinite);
  // Identical results have no spread, so a t-interval of them would be a zero-width range that means nothing.
  const identical = rs.length >= 2 && rs.every((x) => x === rs[0]);
  const e = rs.length >= 2 && !identical ? expectancyStats({ rs }) : null;
  const v = strategyVerdict({ trades: b.s.trades, low: e?.value.low ?? null, high: e?.value.high ?? null, mean: e?.value.expectancy ?? b.s.expectancy_r, profitFactor: b.s.profit_factor });
  return { ...b, rs, e, identical, v };
}
const noRange = (b) => (b.s.trades < 2 ? `too few trades for a range (n = ${b.s.trades})` : `no range: all ${b.s.trades} results are identical, so they show no spread to estimate from`);

function backtestLine(records) {
  const rows = backtestRows(records);
  if (!rows.length) return `${label('backtest')}: no stored backtest with trades yet.`;
  const total = rows.reduce((n, r) => n + r.stats.trades, 0);
  const best = [...rows].sort((a, b) => b.stats.expectancy_r - a.stats.expectancy_r)[0];
  const ci = best.stats.expectancy_r_95ci;
  const range = ci && Number.isFinite(ci.low) && Number.isFinite(ci.high) && best.stats.trades >= 2 ? `a stored 95% range of ${signedR(ci.low)} to ${signedR(ci.high)}` : 'no stored range';
  return `${backtestHead(records)}: ${rows.length} portfolio${rows.length === 1 ? '' : 's'} with ${total} trades; expectancy ranged ${span(rows.map((r) => r.stats.expectancy_r), signedR)}. The highest, ${best.name || best.strategy}, has ${best.stats.trades} trades and ${range}. A backtest is history, not a forward result, and the best of many portfolios is partly luck.`;
}

function expectancyAnswer(records, { strategy = false } = {}) {
  const lines = [];
  if (records.unreadable) {
    lines.push(`I could not read CHE's paper journal just now, sir, so I give no expectancy and no verdict.`);
    return lines;
  }
  const list = books(records).map(bookStats);
  if (!list.length) {
    lines.push(`${strategy ? 'Your strategy' : 'Your expectancy'}, sir: no recorded trades yet. CHE's paper journal (${PROVENANCE.paper}) has no closed paper trades, so there is no measured expectancy.`);
    lines.push(`Verdict: unsupported, because no closed trades. Criteria: ${VERDICT_RULES.text}`);
  } else {
    const total = list.reduce((n, b) => n + b.s.trades, 0);
    const top = list[0];
    lines.push(`${strategy ? 'Your strategies, judged' : 'Your expectancy, measured'} one paper portfolio at a time, sir, from ${PROVENANCE.paper} in CHE's paper journal, after assumed costs: ${where(list, total)}.`);
    lines.push(`${list.length > 1 ? 'The largest is' : 'It is'} ${top.name}, n = ${top.s.trades}. ${top.e ? `Math: ${stepsText(top.e)}.` : `Expectancy ${signedR(top.s.expectancy_r)} per trade; ${noRange(top)}.`}`);
    if (strategy) {
      const w = top.s.trades >= 2 ? winRateInterval({ wins: top.s.wins, n: top.s.trades }) : null;
      lines.push(`Win rate ${top.s.win_rate}%${w ? `, Wilson 95% range ${pct(w.value.low)} to ${pct(w.value.high)}` : ''}; profit factor ${top.s.profit_factor ?? 'not defined, because no trade lost'}; maximum drawdown ${usd(top.s.max_drawdown)}, or ${Math.abs(top.s.max_drawdown_r).toFixed(2)}R, within that portfolio's own record.`);
    }
    lines.push(`Verdict for ${top.name}: ${top.v.verdict}, because ${top.v.reasons.join(', and ')}.`);
    if (list.length > 1) {
      lines.push(`The other portfolios, each judged on its own: ${list.slice(1, 5).map((b, i) => `${i + 2}. ${b.name}: ${b.s.trades} trade${b.s.trades === 1 ? '' : 's'}, ${signedR(b.s.expectancy_r)} a trade, ${b.v.verdict}`).join('; ')}${list.length > 5 ? `; and ${list.length - 5} more` : ''}.`);
    }
    lines.push(`Criteria: ${VERDICT_RULES.text}`);
  }
  lines.push(backtestLine(records));
  lines.push(...brokerLines(records));
  return lines;
}

function evaluateAnswer(intent, records) {
  const p = intent.plan;
  const lines = [];
  const out = rewardRisk({ symbol: p.symbol, side: p.side, entry: p.entry, stop: p.stop, target: p.target, contracts: p.contracts, roundTripFees: p.roundTripFees });
  if (![p.entry, p.stop, p.target].every(Number.isFinite)) {
    return { ok: false, lines: ['To judge a trade I need its entry, stop and target, sir. Say it like "is this a good trade: long MNQ at 18000, stop 17990, target 18030".'] };
  }
  const head = `${p.side === 'short' ? 'Short' : 'Long'} ${p.symbol ? `${p.contractsSaid ? `${p.contracts} ` : ''}${p.symbol} ` : ''}at ${num(p.entry)}, stop ${num(p.stop)}, target ${num(p.target)}, sir. ${NO_ORDER}`;
  if (!out.ok) {
    lines.push(head, `Verdict: bad, because ${out.error}: the plan cannot work as written.`);
    return { ok: true, lines };
  }
  lines.push(head);
  lines.push(`Plan math: ${stepsText(out)}.`);
  if (p.feesSaid) lines.push(`Costs: you said ${p.feesSaid}.`);
  else lines.push('Costs: none given, so none are included; real commissions, fees and slippage raise the break-even win rate.');
  const need = out.values.breakevenWinRateAfterCosts ?? out.values.breakevenWinRate;
  // Comparable records: the same contract and side, planned near the same reward-to-risk, in each portfolio on its own.
  const ratioOf = (t) => {
    const e = t.entry?.raw ?? t.entry?.fill;
    const r = t.side === 'short' ? (e - t.target) / (t.stop - e) : (t.target - e) / (e - t.stop);
    return Number.isFinite(t.params?.target_r) ? t.params.target_r : r;
  };
  const like = (t) => (!p.symbol || String(t.contract || t.symbol || '').toUpperCase().startsWith(p.symbol)) && t.side === p.side && Math.abs(ratioOf(t) - out.value) <= 0.25;
  const matched = books(records).map((b) => {
    const same = b.trades.filter(like);
    const wins = same.filter((t) => t.net_pnl > 0).length;
    return { name: b.name, n: same.length, wins, w: same.length >= 2 ? winRateInterval({ wins, n: same.length }).value : null };
  }).filter((b) => b.n).sort((a, b) => b.n - a.n);
  const setup = `${p.symbol || ''} ${p.side} trades planned near ${num(out.value)} to 1`.trim();
  let verdict = 'unsupported';
  let why = '';
  if (records.unreadable) {
    why = 'I could not read CHE\'s paper journal just now';
    lines.push(`Data: ${why}.`);
  } else if (!matched.length) {
    why = 'no recorded trade matches this setup';
    lines.push(`What the data supports: ${PROVENANCE.paper}: CHE's paper journal has no closed ${setup}, so no record shows how often a trade like this reaches its target.`);
  } else {
    lines.push(`What the data supports, ${PROVENANCE.paper}, one paper portfolio at a time: ${matched.slice(0, 5).map((b, i) => `${i + 1}. ${b.name}: ${b.n} closed ${setup} won ${b.wins}, ${b.w ? `a Wilson 95% range of ${pct(b.w.low)} to ${pct(b.w.high)}` : 'too few for a range'} against the ${pct(need)} needed`).join('; ')}.`);
    const eligible = matched.filter((b) => b.n >= MIN_TRADES);
    if (!eligible.length) why = `no portfolio has ${MIN_TRADES} comparable trades; the most is ${matched[0].n}`;
    else if (eligible.every((b) => b.w.low > need)) { verdict = 'good'; why = `every portfolio with ${MIN_TRADES} or more comparable trades has its whole win-rate range above the ${pct(need)} break-even`; }
    else if (eligible.every((b) => b.w.high < need)) { verdict = 'bad'; why = `every portfolio with ${MIN_TRADES} or more comparable trades has its whole win-rate range below the ${pct(need)} break-even`; }
    else why = `the win-rate ranges include the ${pct(need)} break-even, or the portfolios disagree`;
  }
  const near = backtestRows(records).filter((r) => Math.abs(Number(r.target_r) - out.value) <= 0.25);
  if (near.length) lines.push(`${backtestHead(records)}: ${near.length} portfolio${near.length === 1 ? '' : 's'} targeting ${num(out.value)}R won ${span(near.map((r) => r.stats.win_rate), (x) => `${x}%`)} of their trades (${near.map((r) => r.stats.trades).join(', ')}), long and short together; history, not this setup.`);
  lines.push(...brokerLines(records));
  lines.push(`Verdict: ${verdict}, because ${why}. Criteria: good needs every paper portfolio with at least ${MIN_TRADES} comparable recorded trades to have its Wilson 95% win-rate range wholly above the break-even win rate; bad needs every such portfolio wholly below it, or a stop or target on the wrong side of the entry; anything else is unsupported. Portfolios are never pooled, and the plan's arithmetic is not a forecast. A verdict is not a recommendation to place the trade.`);
  return { ok: true, lines };
}

function barsAnswer(intent, records) {
  const feed = records.feed;
  const bars = Array.isArray(feed?.bars) ? feed.bars : [];
  const lines = [];
  if (intent.explain) lines.push(`VWAP, sir: ${intent.explain}`);
  if (records.unreadable) { lines.push('I could not read CHE\'s stored bars just now, so I calculated nothing and I won\'t invent prices.'); return lines; }
  if (!bars.length) {
    lines.push(`No price bar is stored yet, sir, so I can't calculate ${intent.kind === 't_vwap' ? 'VWAP' : 'the opening range'} and I won't invent prices. Bars are stored while paper trading runs.`);
    return lines;
  }
  if (feed.status !== 'DELAYED') {
    lines.push(`The stored bars are marked ${feed.status || 'with no status'}, not as delayed paper data, so I won't label or use them, sir.`);
    return lines;
  }
  const first = bars[0]?.t; const last = bars[bars.length - 1]?.t;
  lines.push(`From stored bars only: ${PROVENANCE.paper}, ${feed.status} ${feed.provider_symbol || ''}${feed.contract ? ` (${feed.contract})` : ''} from ${feed.provider || 'an unnamed provider'}, ${bars.length} bars from ${nyTime(first)} to ${nyTime(last)}${feed.checked_at ? `, read at ${nyTime(feed.checked_at)}` : ''}.`.replace(/\s+/g, ' '));
  if (intent.kind === 't_or') {
    const or = openingRange({ bars, minutes: intent.minutes });
    lines.push(or.ok ? `Opening range, first ${intent.minutes} minutes after 9:30 New York time: ${stepsText(or)}.` : `No opening range: ${or.error}.`);
    return lines;
  }
  const rth = vwapBands({ bars, anchor: 'rth' });
  if (rth.ok) {
    lines.push(`Session VWAP with bands: ${stepsText(rth)}.`);
  } else {
    lines.push(`No regular-hours VWAP: ${rth.error}.`);
    // The CME day the newest bar belongs to, from its first stored bar: labelled as such, never as the 9:30 VWAP.
    const day = tradeDayOf(last);
    const today = bars.filter((b) => tradeDayOf(b.t) === day);
    const alt = vwapBands({ bars: today, anchor: 'all' });
    if (alt.ok) lines.push(`Instead, VWAP of the CME day ${day} from its first stored bar at ${nyTime(today[0].t)}, not the 9:30 open: ${num(alt.value.vwap, 2)}, σ ${num(alt.value.sd, 2)}, 1σ band ${num(alt.value.lower1, 2)} to ${num(alt.value.upper1, 2)}, from ${today.length} bars.`);
  }
  lines.push('Delayed bars are research only, not execution prices.');
  return lines;
}

/**
 * CHE's paper-journal win rate, for the evidence route when the evidence pass has recorded no trades: the same
 * records and portfolios the Knowledge Atlas reads (one portfolio at a time, never pooled). Trades: 0 and
 * text: null when the journal has no closed trade, so the caller can say so. Records are read, never written.
 */
export async function paperJournalWinRate(storage) {
  const records = await loadTradingRecords(storage);
  if (records.unreadable) return { trades: 0, text: 'I could not read CHE\'s paper journal just now, sir, so I give no win rate.' };
  const list = books(records);
  if (!list.length) return { trades: 0, text: null };
  const total = list.reduce((n, b) => n + b.s.trades, 0);
  const top = list[0];
  const range = top.s.trades >= 2 ? winRateInterval({ wins: top.s.wins, n: top.s.trades, confidence: 0.95 }).value : null;
  const lines = [`Win rate, sir, from CHE's paper journal (${PROVENANCE.paper}), since the evidence pass has recorded no trades: ${where(list, total)}.`];
  lines.push(`${list.length > 1 ? 'The largest is' : 'It is'} ${top.name}: ${top.s.wins} win${top.s.wins === 1 ? '' : 's'} in ${top.s.trades}, a win rate of ${top.s.win_rate}%${range ? `, 95% range ${pct(range.low)} to ${pct(range.high)}` : ''}.`);
  if (list.length > 1) {
    const rates = list.map((b) => b.s.win_rate);
    lines.push(`Across the ${list.length} portfolios, the win rate ranged ${Math.min(...rates)}% to ${Math.max(...rates)}%.`);
  }
  lines.push(top.s.trades < MIN_TRADES ? `That is fewer than the ${MIN_TRADES} trades needed, so it is anecdote, not evidence.` : 'A win rate means little without the payoff: ask "what is my expectancy" for both together.');
  return { trades: total, text: lines.join(' ') };
}

/** The reply to a tradingAtlasIntent result, in knowledge_atlas.js's reply shape. Records are read, never written. */
export async function answerTradingAtlas(intent, { storage = null } = {}) {
  const c = intent?.card || null;
  const finish = (lines, ok = true, calc = '') => ({ ok, text: [...lines, c ? sourceOf(c, calc) : ''].filter(Boolean).join('\n').replace(/−/g, '-'), card_id: c?.id || '', kind: intent?.kind || '' });
  const reads = ['t_evaluate', 't_vwap', 't_or', 't_winrate', 't_expectancy', 't_strategy', 't_montecarlo'].includes(intent?.kind);
  const records = reads ? await loadTradingRecords(storage) : { paper: [] };
  switch (intent?.kind) {
    case 't_risk': {
      const i = intent.inputs;
      if (!i.symbol) return finish(['Which contract, sir: MNQ, NQ, ES or MES? Say it like "what is my risk on 2 MNQ with a 12 point stop".'], false);
      const out = futuresRisk(i);
      if (!out.ok) return finish([`I can't work that out yet, sir: ${out.error}. Say it like "what is my risk on 2 MNQ with a 12 point stop".`], false);
      const extra = out.values.totalWithCosts == null ? '' : `, or ${usd(out.values.totalWithCosts)} with the costs you gave`;
      // A count the owner did not say is one contract, and the reply says so rather than passing it off as his.
      const unsaid = i.contractsSaid ? '' : ' You named no number of contracts, so this is for one.';
      return finish([
        `Your risk on ${out.inputs.contracts} ${out.spec.symbol} contract${out.inputs.contracts === 1 ? '' : 's'} with a ${num(out.values.points)}-point stop is ${usd(out.value)}${extra}, sir.${unsaid} ${NO_ORDER}`,
        `Math: ${stepsText(out)}.`, specLine(out.spec), `Assumptions: ${out.assumptions}`,
      ], true, 'futuresRisk');
    }
    case 't_size': {
      const i = intent.inputs;
      if (!i.symbol) return finish(['Which contract, sir: MNQ, NQ, ES or MES? Say it like "how many MNQ contracts can I trade risking $200 with a 10 point stop".'], false);
      const out = positionSize(i);
      if (!out.ok) return finish([`I can't size that yet, sir: ${out.error}. Say it like "how many MNQ contracts can I trade risking $200 with a 10 point stop".`], false);
      const stopSaid = num(out.inputs.stopPoints ?? (out.inputs.stopTicks * out.spec.tick));
      // Never a contract that is over the budget: when one contract does not fit, the reason is its own risk.
      const head = out.value
        ? `${out.value} ${out.spec.symbol} contract${out.value === 1 ? '' : 's'}, sir, risking ${usd(out.values.budget)} with a ${stopSaid}-point stop.`
        : `No ${out.spec.symbol} contract fits, sir: one contract risks ${usd(out.values.perContract)} with a ${stopSaid}-point stop, more than the ${usd(out.values.budget)} budget.`;
      return finish([
        `${head} ${NO_ORDER}`,
        `Math: ${stepsText(out)}.`, specLine(out.spec), `Assumptions: ${out.assumptions}`,
      ], true, 'positionSize');
    }
    case 't_count': {
      // A contract count that is not a whole positive number: nothing is calculated, and the reply says why.
      const shown = `${intent.count}${intent.symbol ? ` ${intent.symbol}` : ''}`;
      const why = intent.problem === 'fraction'
        ? `Contracts are whole numbers, sir, and nothing was calculated for a fraction of a contract (${shown}).`
        : `Contracts are whole positive numbers, sir, and nothing was calculated for ${shown}.`;
      return finish([`${why} Say a whole number of contracts, like 1 or 2. I placed and prepared no order.`], false);
    }
    case 't_shares': {
      const out = stockShares(intent.inputs);
      if (!out.ok) return finish([`I can't size that yet, sir: ${out.error}. Say it like "how many shares can I buy risking $100 with an entry at 50 and a stop at 48".`], false);
      return finish([`${num(out.value)} shares, sir, risking ${usd(out.values.budget)}. ${NO_ORDER}`, `Math: ${stepsText(out)}.`, `Assumptions: ${out.assumptions}`], true, 'stockShares');
    }
    case 't_option': {
      const out = optionAtExpiry(intent.inputs);
      if (!out.ok) return finish([`I can't work that out yet, sir: ${out.error}. Say it like "what's the breakeven on a long call with a 100 strike and a 3 dollar premium".`], false);
      const i = out.inputs;
      return finish([`${i.position === 'long' ? 'Long' : 'Short'} ${i.type}, strike ${num(i.strike)}, premium ${num(i.premium)}, at expiry, sir: breakeven ${num(out.value.breakeven)}. ${NO_ORDER}`, `Math: ${stepsText(out)}.`, `Assumptions: ${out.assumptions}`], true, 'optionAtExpiry');
    }
    case 't_evaluate': {
      const r = evaluateAnswer(intent, records);
      return finish(r.lines, r.ok, 'rewardRisk');
    }
    case 't_vwap':
    case 't_or':
      return finish(barsAnswer(intent, records), Boolean(records.feed?.bars?.length), intent.kind === 't_vwap' ? 'vwapBands' : 'openingRange');
    case 't_winrate': {
      const list = books(records);
      const lines = [];
      if (records.unreadable) lines.push('I could not read CHE\'s paper journal just now, sir, so I give no win rate.');
      else if (!list.length) lines.push(`No recorded trades yet, sir: CHE's paper journal (${PROVENANCE.paper}) has no closed paper trades, so there is no win rate and no interval.`);
      else {
        const pctLabel = `${Math.round(intent.confidence * 100)}%`;
        const total = list.reduce((n, b) => n + b.s.trades, 0);
        const ranged = list.map((b) => ({ ...b, w: b.s.trades >= 2 ? winRateInterval({ wins: b.s.wins, n: b.s.trades, confidence: intent.confidence }) : null }));
        const top = ranged[0];
        lines.push(`Your win rate's ${pctLabel} Wilson interval, sir, one paper portfolio at a time, from ${PROVENANCE.paper} in CHE's paper journal: ${where(list, total)}.`);
        lines.push(ranged.slice(0, 5).map((b, i) => `${i + 1}. ${b.name}: ${b.s.wins} win${b.s.wins === 1 ? '' : 's'} in ${b.s.trades}, ${b.w ? `${pct(b.w.value.low)} to ${pct(b.w.value.high)}` : `too few trades for a range (n = ${b.s.trades})`}`).join('; ') + (ranged.length > 5 ? `; and ${ranged.length - 5} more.` : '.'));
        if (top.w) lines.push(`Math for ${top.name}: ${stepsText(top.w)}.`);
        lines.push(top.s.trades < MIN_TRADES ? `The largest has fewer than the ${MIN_TRADES} trades needed, so it is anecdote, not evidence.` : top.s.trades < 100 ? 'The largest is a low sample, still uncertain.' : 'The largest is an adequate sample.');
        lines.push('A win rate means little without the payoff: ask "what is my expectancy" for both together.');
      }
      const rows = backtestRows(records);
      lines.push(rows.length ? `${backtestHead(records)}: win rates ranged ${span(rows.map((r) => r.stats.win_rate), (x) => `${x}%`)} across ${rows.length} portfolios; history, not a forward result.` : `${label('backtest')}: no stored backtest with trades yet.`);
      lines.push(...brokerLines(records));
      return finish(lines, true, 'winRateInterval');
    }
    case 't_expectancy':
      return finish(expectancyAnswer(records), true, 'expectancyStats');
    case 't_strategy':
      return finish(expectancyAnswer(records, { strategy: true }), true, 'strategyVerdict');
    case 't_montecarlo': {
      // One portfolio, the largest: a simulation of several strategies' trades mixed together would pool them.
      const list = books(records);
      const top = list[0];
      const rs = (top?.trades || []).map((t) => t.r_net).filter(Number.isFinite);
      if (rs.length < 2) return finish([`There are ${rs.length ? 'too few' : 'no'} closed paper trades to simulate, sir: ${top ? `your largest paper portfolio, ${top.name}, has ${rs.length}` : `CHE's paper journal (${PROVENANCE.paper}) has none`}. A Monte Carlo only recombines recorded trades, so I won't run it on nothing.`], false, 'monteCarlo');
      const out = monteCarlo({ results: rs, paths: 2000, seed: intent.seed });
      return finish([
        `Monte Carlo of ${top.name}, your largest paper portfolio, ${rs.length} closed trades, sir, from ${PROVENANCE.paper}, in R after assumed costs.${list.length > 1 ? ` The other ${list.length - 1} portfolio${list.length === 2 ? ' is' : 's are'} not pooled into it.` : ''}`,
        `Math: ${stepsText(out)}.`,
        `Assumptions: ${out.assumptions}${rs.length < MIN_TRADES ? ` With fewer than ${MIN_TRADES} trades it repeats their luck.` : ''}`,
      ], true, 'monteCarlo');
    }
    case 't_samplesize': {
      const out = sampleSizeForMargin({ margin: intent.margin });
      if (!out.ok) return finish([`I can't work that out, sir: ${out.error}.`], false);
      return finish([`About ${num(out.value)} trades, sir, for a win rate known to within plus or minus ${num(intent.margin * 100)} points at 95%, when the win rate is unknown.`, `Math: ${stepsText(out)}.`, `Assumptions: ${out.assumptions}`], true, 'sampleSizeForMargin');
    }
    case 't_compare': {
      const a = intent.card; const b = intent.other;
      if (a.id === b.id) return finish([`Both are on one card, sir: ${a.title}. ${a.levels.intermediate}`, `Worked example: ${a.example.steps.join('; ')}.`]);
      return finish([`${a.title} and ${b.title}, sir.`, `${a.title}: ${a.summary}`, `${b.title}: ${b.summary}`, `Say "teach me" and either name for the full lesson.`]);
    }
    default:
      return finish(['I could not tell which calculation you meant, sir.'], false);
  }
}
