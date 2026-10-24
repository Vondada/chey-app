// The Trading desk's capability cards (owner, 2026-10-24): "Analyze Markets, Backtesting Lab and Custom Indicators
// show CONNECT" although CHE's own engines do that work. The cards used to read only whether an external URL
// (CHE_MARKET_DATA_URL, CHE_BACKTEST_URL) was set. Each card now runs CHE's own engine on real bars and says:
//   AVAILABLE    the internal feature ran just now on current data;
//   LIMITED      it ran, but only on delayed or historical data (the reason says which);
//   UNAVAILABLE  it could not run now (no data answered); the reason says why. Not a connection problem;
//   CONNECT      only when the feature genuinely needs an external connection that is missing.
// Live CME data is reported on its own, apart from the delayed research data, and the backtest, paper and live
// statuses are kept apart. Read only: nothing here trades, and live orders stay disabled.
import { cryptoSpotCandles } from './market_universe.js';
import { readSimState } from './strategy_sim.js';
import { STRATEGIES, analyze, backtest } from './trading_lab.js';
import { LIVE_BACKTEST, LIVE_FEED, LIVE_STATE } from './trading_live.js';
import { TF_IDS, datasetManifests, loadDataset } from './trading_research.js';

export const CAPABILITIES_SOURCE = 'che_trading_capabilities';
const PROBE_KEY = 'trading_capabilities_probe';
const PROBE_TTL_MS = 5 * 60_000;
const MIN_BARS = 60;
const BACKTEST_BARS = 20_000;

/** EMA with a simple-average seed: the same rule as the chart's indicators (lib/rooms/che_chart_indicators.dart). */
export function ema(closes, period) {
  if (closes.length < period) return null;
  let v = closes.slice(0, period).reduce((s, c) => s + c, 0) / period;
  const k = 2 / (period + 1);
  for (const c of closes.slice(period)) v = c * k + v * (1 - k);
  return Number.isFinite(v) ? v : null;
}

/** Fresh public crypto bars (Coinbase, Kraken fallback), cached five minutes so opening the room never hammers them. */
async function cryptoProbe(storage, { fetcher, now }) {
  const saved = await storage.get(PROBE_KEY).catch(() => null);
  if (saved && now - saved.at < PROBE_TTL_MS) return saved;
  let got;
  try { got = await cryptoSpotCandles('BTC', '5m', { fetcher, now }); } catch (e) { got = { error: String(e?.message || e) }; }
  const probe = got.error
    ? { at: now, ok: false, error: String(got.error).slice(0, 160), bars: [] }
    : { at: now, ok: true, status: got.status, source: got.source, bars: (got.candles || []).slice(-120) };
  await storage.put(PROBE_KEY, probe).catch(() => {});
  return probe;
}

/** The longest stored research dataset (NQ, then MNQ), for the backtest check. */
async function storedHistory(storage) {
  for (const market of ['NQ', 'MNQ']) {
    const manifests = await datasetManifests(storage, market).catch(() => ({}));
    const tf = TF_IDS.find((t) => manifests[t]?.bars >= MIN_BARS);
    if (!tf) continue;
    const ds = await loadDataset(storage, market, tf).catch(() => null);
    if (ds?.bars?.length >= MIN_BARS) return { market, tf, manifests, bars: ds.bars, provider: ds.manifest?.provider || 'stored' };
  }
  return null;
}

function run(fn) {
  try { return { ok: true, out: fn() }; } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 120) }; }
}

/** All three cards from one read. `now` and `fetcher` are injectable for tests. */
export async function tradingCapabilities(storage, env = {}, { fetcher = fetch, now = Date.now() } = {}) {
  const [crypto, feed, liveState, lastRun, sim, history] = await Promise.all([
    cryptoProbe(storage, { fetcher, now }),
    storage.get(LIVE_FEED).catch(() => null),
    storage.get(LIVE_STATE).catch(() => null),
    storage.get(LIVE_BACKTEST).catch(() => null),
    readSimState(storage).catch(() => null),
    storedHistory(storage),
  ]);
  const futuresBars = Array.isArray(feed?.bars) ? feed.bars : [];
  const cryptoLive = crypto.ok && crypto.status === 'LIVE' && crypto.bars.length >= MIN_BARS;
  // The data the analysis tools can use right now, best first: live public crypto, then the delayed futures feed.
  const series = cryptoLive ? { bars: crypto.bars, label: 'BTC-USD 5m', data: crypto.source, live: true }
    : futuresBars.length >= MIN_BARS ? { bars: futuresBars, label: 'MNQ 5m', data: `${feed.provider || 'Yahoo MNQ=F'} (${feed.status || 'DELAYED'})`, live: false }
      : crypto.ok && crypto.bars.length >= MIN_BARS ? { bars: crypto.bars, label: 'BTC-USD 5m', data: `${crypto.source} (${crypto.status})`, live: false }
        : history ? { bars: history.bars.slice(-500), label: `${history.market} ${history.tf}`, data: `${history.provider} (historical)`, live: false } : null;

  const data = {
    crypto: crypto.ok ? { status: crypto.status, source: crypto.source } : { status: 'UNAVAILABLE', error: crypto.error },
    // Delayed research data (Yahoo) is never presented as live CME data.
    futures_research: feed ? { status: feed.status || 'DELAYED', source: feed.provider || 'Yahoo MNQ=F', last_bar_time: feed.last_bar_time || futuresBars.at(-1)?.t || null, delayed_by_min: feed.delayed_by_min ?? null } : { status: 'UNAVAILABLE', error: 'the forward paper feed has stored no bars yet' },
    cme_live: { status: 'NOT CONNECTED', detail: 'Real-time CME data needs Tradovate API access with the CME agreement, or your iPhone\'s Rithmic recording. Research uses delayed data meanwhile.' },
  };
  const noData = 'No market data answered just now: '
    + [crypto.ok ? null : `Coinbase and Kraken: ${crypto.error}`, futuresBars.length ? null : 'no stored futures bars', history ? null : 'no stored research dataset'].filter(Boolean).join('; ') + '.';
  const limitedWhy = series && !series.live ? `It ran on ${series.label} from ${series.data}, not on live data.` : '';

  // Analyze Markets: CHE's own analysis (swings, trend, patterns, rule-based entries) on those bars.
  const a = series ? run(() => analyze({ candles: series.bars, label: series.label, data: series.data, interval: '5m' })) : null;
  const analyzeCard = !series ? { state: 'UNAVAILABLE', reason: noData }
    : !a.ok || !Number.isFinite(a.out?.price) ? { state: 'UNAVAILABLE', reason: `The analysis engine failed on ${series.label}: ${a.error || 'no price'}.` }
      : { state: series.live ? 'AVAILABLE' : 'LIMITED', reason: series.live ? `Ran just now on live ${series.label} (${series.data}): trend ${a.out.trend}.` : limitedWhy, check: { symbol: series.label, trend: a.out.trend, as_of: a.out.as_of, bars: series.bars.length } };

  // Backtesting Lab: CHE's own backtester on stored history (years of NQ/MNQ), else on the recent bars.
  const strategy = Object.keys(STRATEGIES)[0];
  // The newest 20,000 stored bars keep the check inside the Worker's CPU time; the Lab itself runs the full history.
  const btBars = history ? history.bars.slice(-BACKTEST_BARS) : series?.bars || null;
  const bt = btBars ? run(() => backtest(btBars, strategy)) : null;
  const datasets = history ? Object.entries(history.manifests).map(([tf, m]) => ({ market: history.market, timeframe: tf, bars: m.bars, first: m.first, last: m.last, provider: m.provider })) : [];
  const backtestCard = !btBars ? { state: 'UNAVAILABLE', reason: noData }
    : !bt.ok || bt.out?.error ? { state: 'UNAVAILABLE', reason: `The backtester failed: ${bt.error || bt.out.error}.` }
      : history ? { state: 'AVAILABLE', reason: `Ran just now on ${btBars.length.toLocaleString('en-US')} of ${history.bars.length.toLocaleString('en-US')} stored ${history.market} ${history.tf} bars (${history.provider}, historical): ${bt.out.trades_count} trades for ${strategy}.`, check: { strategy, market: history.market, timeframe: history.tf, bars: btBars.length, stored_bars: history.bars.length, trades: bt.out.trades_count } }
        : { state: 'LIMITED', reason: `No stored research history yet, so it ran only on ${series.bars.length} recent ${series.label} bars.`, check: { strategy, bars: series.bars.length } };
  backtestCard.modes = {
    backtest: { state: btBars ? 'available' : 'unavailable', datasets, last_research_run: lastRun?.ok ? (lastRun.ran_at || lastRun.at || lastRun.finished_at || null) : null },
    paper: { forward_paper: liveState?.enabled ? 'on' : 'off', simulation: sim ? (sim.paused ? 'paused' : 'running') : 'unknown', simulation_trades: sim?.trades?.stored ?? null },
    live: { state: 'disabled', detail: 'Live orders are disabled in CHE.' },
  };

  // Custom Indicators: an indicator computed by CHE on the same bars the chart draws.
  const e20 = series ? ema(series.bars.map((b) => Number(b.c)), 20) : null;
  const indicatorCard = !series ? { state: 'UNAVAILABLE', reason: noData }
    : e20 == null ? { state: 'UNAVAILABLE', reason: `EMA 20 could not be computed on ${series.label}.` }
      : { state: series.live ? 'AVAILABLE' : 'LIMITED', reason: series.live ? `EMA 20 on live ${series.label} is ${Math.round(e20 * 100) / 100}. VWAP, EMA, RSI, Bollinger, session range and opening range are on the chart.` : limitedWhy, check: { symbol: series.label, ema20: Math.round(e20 * 100) / 100 } };

  const owner = (key) => (env[key] ? ` Your own engine (${key}) is also configured.` : '');
  analyzeCard.reason += owner('CHE_MARKET_DATA_URL');
  backtestCard.reason += owner('CHE_BACKTEST_URL');
  const cards = {
    analyze_markets: { title: 'Analyze Markets', ...analyzeCard, opens: { section: 'chart' } },
    backtesting_lab: { title: 'Backtesting Lab', ...backtestCard, opens: { section: 'strategies' } },
    custom_indicators: { title: 'Custom Indicators', ...indicatorCard, opens: { section: 'chart' } },
  };
  return { ok: true, source: CAPABILITIES_SOURCE, checked_at: new Date(now).toISOString(), data, cards, live_orders: 'disabled', speech: speakCapabilities(cards) };
}

const WORD = { AVAILABLE: 'available', LIMITED: 'limited', UNAVAILABLE: 'unavailable right now', CONNECT: 'waiting for a connection' };
export function speakCapabilities(cards) {
  return Object.values(cards).map((c) => `${c.title} is ${WORD[c.state] || c.state}. ${c.reason}`).join(' ');
}
