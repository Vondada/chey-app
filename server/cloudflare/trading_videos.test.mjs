// Trading Videos: one storyboard per Trading Lab strategy. These tests check our content rules.
// The renderer's own validator (tools/che_video_render.py validate_spec) was run by hand on all ten
// storyboards and accepted them; it is not yet a CI check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SIM_STRATEGIES } from './strategy_sim.js';
import { STRATEGY_LESSONS, TRADING_VIDEO_CATEGORY, strategyVideoStoryboard, tradingVideoRecord } from './trading_videos.js';

test('every Trading Lab strategy has a vertical storyboard with the full lesson', () => {
  for (const strategy of SIM_STRATEGIES) {
    const made = strategyVideoStoryboard(strategy.id, { seconds: 40 });
    assert.equal(made.ok, true, strategy.id);
    const { storyboard: sb } = made;
    assert.deepEqual([sb.width, sb.height], [1080, 1920], strategy.id);
    assert.equal(sb.seconds, 40);
    assert.equal(sb.scenes.reduce((n, s) => n + s.seconds, 0), 40, 'scenes add up to the length');
    const captions = sb.scenes.map((s) => s.caption);
    for (const part of ['Entry', 'Stop loss', 'Take profit', 'Exit', 'Ideal conditions', 'Common mistakes', 'Background']) {
      assert.ok(captions.includes(part), `${strategy.id} has a ${part} scene`);
    }
    for (const scene of sb.scenes) {
      assert.ok(scene.narration.length <= 400 && scene.caption.length <= 90, strategy.id);
      if (scene.kind === 'fact') assert.ok(scene.sources.length > 0, `${strategy.id} fact cites a source`);
    }
  }
});

test('the take-profit scene states the target as R, from the strategy id', () => {
  const made = strategyVideoStoryboard('channel-55|above50|2', { seconds: 40 });
  const takeProfit = made.storyboard.scenes.find((s) => s.caption === 'Take profit');
  assert.match(takeProfit.narration, /at 2R/);
});

test('a filter in the id is said in the video, so a variant is not described as its base rule', () => {
  const made = strategyVideoStoryboard('channel-20|rising20|1.5', { seconds: 40 });
  assert.match(made.storyboard.scenes[0].narration, /while the 20-day average is rising/);
  const plain = strategyVideoStoryboard('channel-20|any|2', { seconds: 40 });
  assert.doesNotMatch(plain.storyboard.scenes[0].narration, /rising/);
});

test('the stop wording is the one trading_lab.js computes', () => {
  assert.match(STRATEGY_LESSONS['channel-20'].stop, /lowest low of the last 10 days/);
  assert.match(STRATEGY_LESSONS['channel-55'].stop, /lowest low of the last 20 days/);
  assert.match(STRATEGY_LESSONS['rsi2-dip'].stop, /2 average true ranges/);
  assert.match(STRATEGY_LESSONS['trend-cross'].stop, /5 percent/);
});

test('no performance claim, win rate or profit promise appears in any video', () => {
  const banned = /win rate|expectancy|profitable|guaranteed|will make|returns? of|% win/i;
  for (const strategy of SIM_STRATEGIES) {
    const { storyboard: sb } = strategyVideoStoryboard(strategy.id, { seconds: 40 });
    const text = [sb.title, sb.description, ...sb.scenes.map((s) => `${s.caption} ${s.narration}`)].join(' ');
    assert.doesNotMatch(text, banned, strategy.id);
    assert.match(sb.description, /Education only/);
  }
});

test('standard 16:9 is refused honestly; the renderer makes vertical only', () => {
  const refused = strategyVideoStoryboard('channel-20|any|2', { format: 'standard' });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'unsupported_format');
});

test('length is limited to the renderer episode range, and unknown strategies are refused', () => {
  assert.equal(strategyVideoStoryboard('channel-20|any|2', { seconds: 15 }).code, 'invalid_length');
  assert.equal(strategyVideoStoryboard('channel-20|any|2', { seconds: 46 }).code, 'invalid_length');
  assert.equal(strategyVideoStoryboard('made-up|any|2', { seconds: 40 }).code, 'unknown_strategy');
});

test('a saved video is filed under Trading Videos and found by its strategy and version', () => {
  assert.equal(TRADING_VIDEO_CATEGORY, 'Trading Videos');
  const record = tradingVideoRecord('vwap-reclaim|any|2', { version: 2 });
  assert.equal(record.ok, true);
  assert.equal(record.category, 'Trading Videos');
  assert.ok(record.tags.includes('strategy:vwap-reclaim|any|2'));
  assert.ok(record.tags.includes('version:2'));
});
