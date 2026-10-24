// The capacity model's arithmetic, pinned: work per profile, Erlang C, estimates, scenarios and the 1M-video batch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ASSUMPTIONS, batch, erlangC, estimateVideo, meanWait, renderWork, scenarios, simulate } from './capacity_model.js';

test('every assumption names its source', () => {
  for (const [k, a] of Object.entries(ASSUMPTIONS)) {
    assert.ok(Number.isFinite(a.value), k); assert.ok(a.unit, k); assert.ok(a.source && a.source.length > 5, k);
  }
});

test('render work: one minute of hybrid video is 6.08 H100-seconds per output second plus composited CPU', () => {
  const w = renderWork(60, 'hybrid');
  assert.equal(Math.round(w.gpu_s * 100) / 100, 364.8);
  assert.equal(w.cpu_s, 42);
  assert.equal(renderWork(60, 'composited').gpu_s, 0);
  assert.throws(() => renderWork(1, 'magic'), /unknown profile/);
});

test('Erlang C behaves: no wait with spare servers, saturation is unbounded', () => {
  assert.equal(erlangC(10, 0), 0);
  assert.equal(erlangC(2, 2), 1);
  assert.ok(Math.abs(erlangC(1, 0.5) - 0.5) < 1e-9);       // M/M/1: P(wait) = rho
  assert.equal(meanWait(1, 2, 1), Infinity);
  assert.ok(Math.abs(meanWait(1, 0.5, 1) - 1) < 1e-9);     // M/M/1: Wq = rho/(mu - lambda) = 1
  assert.ok(erlangC(200_000, 140_000) < 1e-6, 'large pools stay numerically stable');
});

test('a 30-minute hybrid video: 180 segments, ~3 H100-hours, 1.8 GB final; free path $0, paid estimate shown', () => {
  const e = estimateVideo({ minutes: 30, gpus: 20 });
  assert.equal(e.segments, 180); assert.equal(e.h100_hours, 3.04);
  assert.equal(e.storage_mb.final, 1800); assert.equal(e.cost_usd.free_path, 0);
  assert.ok(e.cost_usd.paid > 5 && e.cost_usd.paid < 15, String(e.cost_usd.paid));
  assert.ok(e.wall_minutes < 15, 'segments render in parallel');
  assert.ok(estimateVideo({ minutes: 30, gpu: 't4', gpus: 1 }).wall_minutes > 1000, 'one free T4 is far slower');
});

test('scenarios scale linearly in work and keep each Durable Object far below its limit', () => {
  const s = scenarios();
  assert.equal(s.users_1k.chat.durable_objects, 1000);
  assert.ok(s.users_1m.chat.hottest_object_rps < s.users_1m.chat.do_limit_rps / 100);
  assert.equal(s.users_100k.video.gpus_needed * 10 - s.users_1m.video.gpus_needed <= 10, true);
  assert.ok(s.users_1m.monthly_cost_usd.total > s.users_100k.monthly_cost_usd.total * 9);
  for (const k of ['users_1k', 'users_100k', 'users_1m']) assert.equal(typeof s[k].video.completion_min['30_min'], 'number', k);
  assert.match(simulate({ users: 1000, gpus: 10 }).video.completion_min['30_min'], /never/);
});

test('1,000,000 thirty-minute videos: 500,000 output hours; the profile decides feasibility', () => {
  const b = scenarios().videos_1m_30min;
  assert.equal(b.hybrid.output_hours, 500000);
  assert.equal(b.hybrid.gpu_hours, 3040000);
  assert.ok(b.gen_quality.gpu_hours > 9 * b.hybrid.gpu_hours);
  assert.ok(b.composited.compute_usd < b.hybrid.compute_usd / 50);
  assert.equal(b.hybrid.storage_tb, 1716.6);
  assert.equal(batch({ count: 10, minutes: 1, profile: 'composited', gpus: 0, cpuRunners: 0 }).days_to_finish, Infinity);
});
