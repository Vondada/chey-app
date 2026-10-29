// Periodic production: exact times for pauses, batch sizes, off-by-one counts, unit conversions and stated ambiguity.
// Expected values are worked out by hand below, not copied from the code under test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closedFormBatched, continuousSeconds, parseProduction, simulateBatched, solveProduction } from './periodic_production.js';

const PROBLEM = 'A machine produces 3 parts every 4 seconds. After every 12 parts, it stops for 5 seconds. Starting with no parts and no initial delay, what is the minimum time to produce exactly 100 parts?';

test('the owner\'s problem: batched 176 s, continuous 520/3 s (173.33 s)', () => {
  const r = solveProduction(PROBLEM);
  assert.equal(r.status, 'verified');
  assert.equal(r.batched.seconds, '176');
  assert.equal(r.batched.batches, 34); // 100 parts need 34 batches of 3 (the 34th completes 102 parts)
  assert.equal(r.batched.pauses, 8); // after parts 12, 24, ..., 96; no pause after 100 because nothing follows it
  assert.equal(r.batched.methods_agree, true);
  assert.deepEqual([r.continuous.numerator, r.continuous.denominator], ['520', '3']);
  assert.equal(r.continuous.seconds, '173.33');
  assert.match(r.ambiguity, /batches of 3/);
  assert.match(r.ambiguity, /steady rate/);
});

test('the parser reads every parameter, and nothing is inferred when one is missing', () => {
  assert.deepEqual(parseProduction(PROBLEM), {
    batchSize: 3, batchMs: 4000, pauseEvery: 12, pauseMs: 5000, target: 100, startingParts: 0, initialDelayMs: 0,
  });
  assert.equal(parseProduction('A machine produces 3 parts every 4 seconds. Produce exactly 100 parts.'), null, 'no pause rule');
  assert.equal(parseProduction('After every 12 parts it stops for 5 seconds. Produce 100 parts.'), null, 'no batch rule');
  assert.equal(parseProduction('A machine produces 3 parts every 4 seconds. After every 12 parts it stops for 5 seconds.'), null, 'no target');
  assert.equal(solveProduction('What is 2 + 2?'), null);
});

test('off-by-one: a pause follows a multiple of K only while more parts are needed', () => {
  const base = { batchSize: 1, batchMs: 1000, pauseEvery: 12, pauseMs: 5000 };
  // 12 parts at one part per second: 12 s. The pause after part 12 is not taken, because no part follows it.
  assert.equal(solveProduction('Produce 12 parts. A machine makes 1 parts every 1 seconds. After every 12 parts it stops for 5 seconds.')?.batched.seconds, '12');
  // 13 parts: one pause (after part 12), so 13 + 5 = 18 s.
  assert.equal(closedFormBatched({ ...base, target: 13 }).ms, 18000);
  assert.equal(simulateBatched({ ...base, target: 13 }).ms, 18000);
  // 24 parts: pause after 12 only (after 24 nothing follows), so 24 + 5 = 29 s.
  assert.equal(simulateBatched({ ...base, target: 24 }).ms, 29000);
  // 25 parts: pauses after 12 and 24, so 25 + 10 = 35 s.
  assert.equal(simulateBatched({ ...base, target: 25 }).ms, 35000);
});

test('batch sizes that do not divide the pause interval still match the closed form', () => {
  // batch of 5 parts every 2 s, pause after every 12 parts for 3 s, target 100:
  // batches 20 -> 40 s; pauses floor(99/12)=8 -> 24 s; total 64 s.
  const r = solveProduction('A machine produces 5 parts every 2 seconds. After every 12 parts, it stops for 3 seconds. Produce exactly 100 parts.');
  assert.equal(r.status, 'verified');
  assert.equal(r.batched.seconds, '64');
  assert.equal(r.batched.pauses, 8);
});

test('simulation and closed form agree across many parameters (the two methods check each other)', () => {
  for (let b = 1; b <= 7; b += 1) {
    for (let k = 1; k <= 15; k += 1) {
      for (let t = 1; t <= 60; t += 1) {
        const p = { batchSize: b, batchMs: 1000, pauseEvery: k, pauseMs: 2000, target: t };
        const sim = simulateBatched(p);
        const closed = closedFormBatched(p);
        assert.deepEqual([sim.ms, sim.batches, sim.pauses], [closed.ms, closed.batches, closed.pauses], `b=${b} k=${k} target=${t}`);
      }
    }
  }
});

test('unit conversions: minutes and hours become milliseconds before the arithmetic', () => {
  // 2 parts every 1 minute, pause after every 4 parts for 30 seconds, target 10 parts:
  // 5 batches -> 300 s; pauses floor(9/4)=2 -> 60 s; total 360 s.
  const r = solveProduction('A machine produces 2 parts every 1 minute. After every 4 parts, it stops for 30 seconds. Produce exactly 10 parts.');
  assert.equal(r.status, 'verified');
  assert.equal(r.batched.seconds, '360');
  // Hours: 1 part every 0.5 hours, pause after every 2 parts for 10 minutes, target 3 parts:
  // 3 batches -> 5400 s; pauses floor(2/2)=1 -> 600 s; total 6000 s.
  const h = solveProduction('A machine produces 1 part every 0.5 hours. After every 2 parts, it stops for 10 minutes. Produce exactly 3 parts.');
  assert.equal(h.batched.seconds, '6000');
});

test('continuous reading is exact as a fraction', () => {
  // 1 part every 3 s (batch 1), no pause reached (target 4, pause every 12): 4*3 = 12 s exactly.
  const c = continuousSeconds({ batchSize: 1, batchMs: 3000, pauseEvery: 12, pauseMs: 5000, target: 4 });
  assert.deepEqual([c.numerator.toString(), c.denominator.toString()], ['12', '1']);
});

test('ambiguity is always stated: batched and continuous readings differ for batch sizes above one', () => {
  const r = solveProduction(PROBLEM);
  assert.notEqual(r.batched.seconds, r.continuous.seconds);
  assert.match(r.ambiguity, /batched: 176 seconds/);
  assert.match(r.ambiguity, /continuous: 173\.33 seconds/);
  assert.match(r.ambiguity, /no initial delay/);
});

test('values that are not whole counts or whole milliseconds are rejected, not rounded', () => {
  assert.equal(solveProduction('A machine produces 3 parts every 4.0005 seconds. After every 12 parts, it stops for 5 seconds. Produce exactly 100 parts.'), null);
  assert.equal(solveProduction('A machine produces 3 parts every 4 seconds. After every 0 parts, it stops for 5 seconds. Produce exactly 100 parts.'), null);
  assert.equal(solveProduction('A machine produces 3 parts every 4 seconds. After every 12 parts, it stops for 5 seconds. Produce exactly 500000 parts.'), null);
});
