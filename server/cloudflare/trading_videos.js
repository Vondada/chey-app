// Trading Videos: a short explainer for each strategy the Trading Lab uses or studies.
//
// The video is one Creator Studio storyboard (version 1), so it renders through the same
// GitHub renderer (tools/che_video_render.py) as every other CHE video. Nothing here is a
// performance claim: the rules are read from strategy_sim.js (SIM_STRATEGIES), the stop and
// target wording matches what trading_lab.js computes, and the background is general
// trading history. Results from the lab's backtests or paper journal are never put in a video.
//
// The renderer accepts vertical frames only (1080x1920 or 720x1280) and episodes of 30 to 45
// seconds with 3 to 10 scenes. A standard 16:9 video is refused here until the renderer supports it.
import { SIM_STRATEGIES } from './strategy_sim.js';
import { LAYOUT } from './creator_studio.js';

export const TRADING_VIDEO_CATEGORY = 'Trading Videos';
export const TRADING_VIDEO_VERSION = 1;
const MIN_SECONDS = 30;
const MAX_SECONDS = 45;
const DEFAULT_SECONDS = 40;
const SOURCE_RULE = { id: 'S1', label: 'CHE trading lab rule' };
const SOURCE_HISTORY = { id: 'S2', label: 'General trading history (education)' };

// Per signal (the part before the first "|"): what the rule says, when it fits, what goes wrong, and history.
// Stop wording follows trading_lab.js exactly; the target is always entry + R x (entry - stop).
export const STRATEGY_LESSONS = Object.freeze({
  'channel-20': {
    title: 'Breakout over the 20-day high',
    setup: 'Price has built a range under its 20-day high, and the rule waits for the first close above it.',
    entry: 'Enter at the close of the day price first closes above the 20-day high.',
    stop: 'Stop under the lowest low of the last 10 days.',
    ideal: 'A tight base near the high, a close well above it, and volume that rises on the breakout.',
    mistakes: 'Chasing a close far above the level, moving the stop lower, or sizing up after a winning streak.',
    history: 'Trend-following breakout rules like this one were taught and traded in the 1980s by the Turtle traders, who used 20-day and 55-day channels.',
  },
  'channel-55': {
    title: 'Breakout over the 55-day high',
    setup: 'A slower version of the 20-day breakout: price has to clear a longer range before the rule enters.',
    entry: 'Enter at the close of the day price first closes above the 55-day high.',
    stop: 'Stop under the lowest low of the last 20 days.',
    ideal: 'A long, orderly base and a strong trend above the 50-day average, with fewer false breaks.',
    mistakes: 'Waiting for confirmation that never comes, widening the stop after entry, or trading it in a choppy market.',
    history: 'The 55-day channel was the second entry the Turtle traders used for longer trends, in the 1980s.',
  },
  'swing-breakout': {
    title: 'Breakout over the last swing high',
    setup: 'A swing high is a peak with lower prices on both sides. The rule waits for price to close above the last one.',
    entry: 'Enter at the close when price first closes above the last swing high.',
    stop: 'Stop under the last swing low.',
    ideal: 'Higher lows building up under the swing high, and price holding above its 50-day average.',
    mistakes: 'Using a swing that is too close to the price, or ignoring a stop that is far below the entry.',
    history: 'Reading swing highs and lows is one of the oldest habits in price-chart analysis, long before computers.',
  },
  'inside-bar-break': {
    title: 'Breakout of an inside bar',
    setup: 'An inside bar is a day whose high and low both sit inside the day before, a pause in the move.',
    entry: 'Enter at the close when price closes above the inside bar high.',
    stop: 'Stop at the low of the inside bar.',
    ideal: 'A clean inside bar after a strong move, with a close that clearly leaves the bar.',
    mistakes: 'Trading every inside bar in a sideways market, or entering after price has already run far from the bar.',
    history: 'Inside bars are a standard price-action pattern; traders read them from paper charts long before computers.',
  },
  'rsi2-dip': {
    title: 'Oversold dip with a 2-day RSI',
    setup: 'The 2-day Relative Strength Index measures how far price has fallen over two days. Under 10 means a sharp, short dip.',
    entry: 'Enter at the close when the 2-day RSI is under 10.',
    stop: 'Stop 2 average true ranges below the entry.',
    ideal: 'A dip inside a longer uptrend, not a fall into a broken chart.',
    mistakes: 'Buying every dip in a falling market, or using a stop so tight that normal noise hits it.',
    history: 'J. Welles Wilder introduced the RSI in 1978, and short-period RSI rules were popularised by Larry Connors.',
  },
  'pullback-reversal': {
    title: 'Bullish reversal at the swing low',
    setup: 'In an uptrend, price pulls back to a swing low and forms a reversal candle there.',
    entry: 'Enter at the close of a bullish engulfing or hammer candle near the last swing low.',
    stop: 'Stop under the lower of the candle low and the low before it.',
    ideal: 'A reversal candle that closes in the upper part of its range, right at a level that held before.',
    mistakes: 'Calling any candle a reversal, or buying a pullback that breaks the swing low.',
    history: 'Candlestick reversal patterns come from Japanese rice traders of the 1700s and were made popular in the West by Steve Nison in the 1990s.',
  },
  'trend-cross': {
    title: 'Moving-average trend cross',
    setup: 'The 20-day average crosses above the 50-day average, a sign that the short-term trend is turning up.',
    entry: 'Enter at the close when the 20-day average crosses above the 50-day average.',
    stop: 'Stop under the last swing low, or 5 percent below the entry if no swing low is close enough.',
    ideal: 'A slow, steady cross after a long decline, with price already above both averages.',
    mistakes: 'Trading every cross in a sideways market, where the averages keep crossing back and forth.',
    history: 'Moving-average crosses are among the oldest trend rules in technical analysis.',
  },
  'vwap-reclaim': {
    title: 'Reclaiming the session VWAP',
    setup: 'VWAP is the volume-weighted average price for the session. Price below it and then back above it can signal buyers taking control.',
    entry: 'Enter at the close of the minute bar that closes back above session VWAP.',
    stop: 'Stop under the lower of the last two lows.',
    ideal: 'A reclaim that comes with volume, early in the session, while the broader trend is up.',
    mistakes: 'Trading reclaims late in the day, or on thin volume where VWAP means little.',
    history: 'VWAP became a standard intraday benchmark because institutions judge their trade fills against it.',
  },
  'opening-range': {
    title: 'Opening range breakout',
    setup: 'The first 15 minutes of the session set a high and a low. The rule waits for the first close above the high.',
    entry: 'Enter at the close of the first minute bar that closes above the opening range high.',
    stop: 'Stop at the low of the opening range.',
    ideal: 'A narrow opening range followed by a close above its high with volume, in a market already trending up.',
    mistakes: 'Trading a wide opening range, where the stop is far away, or trading the breakout in a flat, low-volume session.',
    history: 'Toby Crabel\'s 1990 research on the opening range breakout made it a common day-trading setup.',
  },
});

// 16:9 needs a renderer change, so it is refused rather than rendered as vertical by mistake.
export const SUPPORTED_FORMATS = Object.freeze({ vertical: { width: 1080, height: 1920, label: 'Shorts, Reels and TikTok (9:16)' } });

const SIGNAL_ID = (id) => String(id || '').split('|')[0];
const FILTER_WORDS = Object.freeze({
  any: '',
  above50: 'It only counts when price is above its 50-day average.',
  rising20: 'It only counts while the 20-day average is rising.',
});
const TARGET_R = (id) => Number(String(id || '').split('|')[2]);

/** The ten lab strategies with the wording a video needs, or null for an unknown id. */
export function strategyVideoFacts(id) {
  const strategy = SIM_STRATEGIES.find((s) => s.id === id);
  const lesson = strategy && STRATEGY_LESSONS[SIGNAL_ID(id)];
  if (!strategy || !lesson) return null;
  const index = SIM_STRATEGIES.indexOf(strategy) + 1;
  return { strategy, lesson, index, targetR: TARGET_R(id), filter: String(id).split('|')[1] };
}

function clip(text, limit) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= limit) return value;
  throw new Error(`video text is longer than ${limit} characters: ${value.slice(0, 40)}...`);
}

function splitSeconds(total, count) {
  const base = Math.floor(total / count);
  const extra = total - base * count;
  return Array.from({ length: count }, (_, i) => base + (i < extra ? 1 : 0));
}

/**
 * The storyboard (version 1) for one strategy, or { ok: false, error } when it cannot be made.
 * format: 'vertical' only. seconds: 30 to 45, the renderer's episode range.
 */
export function strategyVideoStoryboard(id, { format = 'vertical', seconds = DEFAULT_SECONDS } = {}) {
  if (!SUPPORTED_FORMATS[format]) {
    return { ok: false, code: 'unsupported_format', error: `The renderer makes vertical videos only (${Object.keys(SUPPORTED_FORMATS).join(', ')}). A standard 16:9 YouTube video needs a renderer change first.` };
  }
  if (!Number.isInteger(seconds) || seconds < MIN_SECONDS || seconds > MAX_SECONDS) {
    return { ok: false, code: 'invalid_length', error: `A strategy video lasts ${MIN_SECONDS} to ${MAX_SECONDS} seconds.` };
  }
  const facts = strategyVideoFacts(id);
  if (!facts) return { ok: false, code: 'unknown_strategy', error: `No Trading Lab strategy called "${id}".` };
  const { strategy, lesson, index, targetR } = facts;
  const { width, height } = SUPPORTED_FORMATS[format];
  const presenter = { id: 'coach', name: 'CHE', color: '#38D5F0', accent: '#8B5CF6', skin: '#E0B48A', prop: 'chalk' };
  const size = (box) => [...box];
  const risk = `the risk is the distance from entry to stop, and the target sits ${targetR} times that distance above entry`;
  const filter = FILTER_WORDS[facts.filter] || '';
  const beats = [
    { kind: 'story', location: 'chalkboard', caption: lesson.title, narration: `${lesson.setup} ${filter} This is ${strategy.name.toLowerCase()}.` },
    { kind: 'fact', location: 'chalkboard', caption: 'Entry', narration: lesson.entry, sources: ['S1'] },
    { kind: 'fact', location: 'chalkboard', caption: 'Stop loss', narration: `${lesson.stop} Accept the loss at that price.`, sources: ['S1'] },
    { kind: 'fact', location: 'chalkboard', caption: 'Take profit', narration: `Take profit at ${targetR}R: ${risk}.`, sources: ['S1'] },
    { kind: 'fact', location: 'chalkboard', caption: 'Exit', narration: 'Exit at the stop or at the target. If one bar touches both, the lab counts the stop first, and the same rule is used in every test.', sources: ['S1'] },
    { kind: 'analogy', location: 'counter', caption: 'Ideal conditions', narration: lesson.ideal },
    { kind: 'story', location: 'counter', caption: 'Common mistakes', narration: lesson.mistakes },
    { kind: 'fact', location: 'stoop', caption: 'Background', narration: lesson.history, sources: ['S2'] },
  ];
  const durations = splitSeconds(seconds, beats.length);
  const scenes = beats.map((beat, i) => ({
    seconds: durations[i],
    kind: beat.kind,
    shot: 'medium',
    location: beat.location,
    cast: ['coach'],
    speaker: 'coach',
    caption: clip(beat.caption, 90),
    narration: clip(beat.narration, 400),
    sources: beat.sources || [],
    diagram: null,
  }));
  const storyboard = {
    v: TRADING_VIDEO_VERSION,
    width,
    height,
    seconds,
    series: 'CHE Trading Videos',
    episode: `S1E${index}`,
    title: clip(`${lesson.title}: ${strategy.name}`, 100),
    description: clip(`${lesson.setup} Education only: rules from CHE's Trading Lab, no performance claim. Not financial advice.`, 700),
    sources: [{ id: SOURCE_RULE.id, label: SOURCE_RULE.label }, { id: SOURCE_HISTORY.id, label: SOURCE_HISTORY.label }],
    cast: [presenter],
    layout: { badge: size(LAYOUT.badge), headline: size(LAYOUT.headline), diagram: size(LAYOUT.diagram), caption: size(LAYOUT.caption) },
    scenes,
  };
  const json = JSON.stringify(storyboard);
  if (json.length > 16000) return { ok: false, code: 'too_large', error: 'The storyboard is larger than the renderer accepts.' };
  return { ok: true, strategy_id: id, category: TRADING_VIDEO_CATEGORY, version: TRADING_VIDEO_VERSION, format, seconds, storyboard, spec: json };
}

/** The fields a saved video's media record carries, so the library can search by strategy and compare versions. */
export function tradingVideoRecord(id, { version = 1, format = 'vertical', seconds = DEFAULT_SECONDS } = {}) {
  const made = strategyVideoStoryboard(id, { format, seconds });
  if (!made.ok) return made;
  return {
    ok: true,
    kind: 'video',
    category: TRADING_VIDEO_CATEGORY,
    strategy_id: id,
    strategy_name: made.storyboard.title,
    version,
    format,
    seconds,
    tags: ['trading-video', `strategy:${id}`, `version:${version}`],
  };
}
