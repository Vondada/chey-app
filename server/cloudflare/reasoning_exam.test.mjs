import test from 'node:test';
import assert from 'node:assert/strict';
import { REASONING_LAYERS, reasoningLayer, gradeReasoningLayer, runReasoningLayer, hasLockOrderInversion, fiveLayerIntent, speakFiveLayerResults } from './reasoning_exam.js';
import { examIntent } from './autonomy_exam.js';

const L = (n) => reasoningLayer(n);

const GOOD = {
  1: 'Using h = 1/2 g t^2: 45 = 5 t^2, so t = 3 s. Speed v = g t = 30 m/s.\nASSERT time_s=3 speed_ms=30',
  2: `Claim (a) is a real bug: an empty batch divides by zero.
Claim (b) is false: Python floats do not overflow in sum() for realistic sensor values; this is not a real bug.
Claim (c) is real: a string raises TypeError and NaN poisons the average.
\`\`\`python
import math
from typing import Iterable, Optional

def batch_average_sensor_readings(batches: Iterable[Iterable[object]]) -> list[Optional[float]]:
    results: list[Optional[float]] = []
    for batch in batches:
        total = 0.0
        count = 0
        for reading in batch:
            if isinstance(reading, bool) or not isinstance(reading, (int, float)):
                continue
            value = float(reading)
            if not math.isfinite(value):
                continue
            total += value
            count += 1
        results.append(total / count if count else None)
    return results
\`\`\``,
  3: `r1 = 6778.137 km, r2 = 42164 km. Circular speeds from vis-viva: v = sqrt(mu/r).
v1 = 7.6686 km/s, a = 24471.07 km, vp = sqrt(mu(2/r1 - 1/a)) = 10.0660 km/s, so dv1 = 2.3975 km/s.
va = 1.6182 km/s, v2 = 3.0747 km/s, dv2 = 1.4565 km/s. TOF = pi sqrt(a^3/mu) = 5.291 h.
Rocket equation: mf = m0 exp(-dv/(Isp g0)) = 5000 exp(-3.854/4.413) = 2087.8 kg.
ASSERT dv1_kms=2.397 dv2_kms=1.457 tof_h=5.291 mf_kg=2087.8`,
  4: `This is a deadlock. Thread 1 calls fire() and holds fuel_lock, then waits for nozzle_lock. Thread 2 calls gimbal() and holds nozzle_lock, then waits for fuel_lock. Each blocks forever.
Fix: always acquire fuel_lock before nozzle_lock.
\`\`\`python
import threading

class ThrusterManager:
    def __init__(self):
        self.fuel_lock = threading.Lock()
        self.nozzle_lock = threading.Lock()
        self.fuel = 100.0
        self.angle = 0.0

    def fire(self, amount):
        with self.fuel_lock:
            with self.nozzle_lock:
                self.fuel -= amount

    def gimbal(self, angle):
        with self.fuel_lock:
            with self.nozzle_lock:
                self.angle = angle
\`\`\``,
};

test('five-layer exam: correct answers pass every deterministic check', () => {
  for (const spec of REASONING_LAYERS) {
    const grade = gradeReasoningLayer(spec, GOOD[spec.layer]);
    assert.equal(grade.passed, true, `layer ${spec.layer}: ${grade.failed_checks.join('; ')}`);
  }
});

test('five-layer exam: wrong or rule-breaking answers fail the exact check', () => {
  const g1 = gradeReasoningLayer(L(1), 'When things fall they speed up.\nASSERT time_s=3 speed_ms=30');
  assert.deepEqual(g1.failed_checks, ['never used a forbidden word']);
  assert.ok(gradeReasoningLayer(L(1), 'ASSERT time_s=4.5 speed_ms=45').failed_checks.includes('time is 3 s'));
  const accumulates = GOOD[2].replace('total += value\n            count += 1', 'values.append(value)');
  assert.ok(gradeReasoningLayer(L(2), accumulates).failed_checks.includes('streaming aggregates, no per-batch list of readings'));
  const believesOverflow = GOOD[2].replace('Claim (b) is false: Python floats do not overflow in sum() for realistic sensor values; this is not a real bug.', 'Claim (b) is real too.');
  assert.ok(gradeReasoningLayer(L(2), believesOverflow).failed_checks.includes('rejected the float-overflow premise'));
  assert.ok(gradeReasoningLayer(L(3), GOOD[3].replace('dv1_kms=2.397', 'dv1_kms=2.9')).failed_checks.includes('first burn about 2.40 km/s'));
  const stillInverted = GOOD[4].replace(/def gimbal[\s\S]*?self\.angle = angle/, 'def gimbal(self, angle):\n        with self.nozzle_lock:\n            with self.fuel_lock:\n                self.angle = angle');
  assert.ok(gradeReasoningLayer(L(4), stillInverted).failed_checks.includes('no lock-order inversion remains'));
});

test('lock-order analysis: AB-BA is an inversion, consistent order or one lock is not', () => {
  assert.equal(hasLockOrderInversion(reasoningLayer(4).prompt.split('```python').pop()), true, 'the supplied code deadlocks');
  assert.equal(hasLockOrderInversion('def a(self):\n  with self.x:\n    with self.y:\n      pass\ndef b(self):\n  with self.x:\n    with self.y:\n      pass'), false);
  assert.equal(hasLockOrderInversion('def a(self):\n  with self.lock:\n    pass\ndef b(self):\n  with self.lock:\n    pass'), false);
});

test('an engine outage or an empty/truncated answer is ungradable infrastructure, never a failed grade', async () => {
  const down = await runReasoningLayer({}, L(3), { route: async () => { throw new Error('all providers 503'); } });
  assert.equal(down.ungradable, true);
  assert.equal(down.grade, undefined);
  const empty = await runReasoningLayer({}, L(3), { route: async () => ({ response: '' }) });
  assert.equal(empty.ungradable, true);
  let seen;
  const ok = await runReasoningLayer({}, L(1), { route: async (env, model, input) => { seen = input; return { response: GOOD[1], engine: 'groq' }; } });
  assert.equal(ok.grade.passed, true);
  assert.equal(ok.grade.engine, 'groq');
  assert.equal(seen.che_strongest, true, 'the exam asks the router for its strongest healthy engine');
});

test('intents: "five layer exam" is its own exam; the existing autonomy exam still parses', () => {
  assert.deepEqual(fiveLayerIntent('run the five layer autonomy exam'), { kind: 'run', layers: [1, 2, 3, 4, 5] });
  assert.deepEqual(fiveLayerIntent('run the 5-layer exam layer 4'), { kind: 'run', layers: [4] });
  assert.deepEqual(fiveLayerIntent('five layer exam results'), { kind: 'results' });
  assert.equal(fiveLayerIntent('run the autonomy exam'), null);
  assert.deepEqual(examIntent('run the autonomy exam level 3'), { kind: 'run', levels: [3] });
});

test('layer 5 is only reported from the autonomy-exam run this five-layer run started', () => {
  const coding = { run_id: 'c1', results: { 5: { level: 5, passed: true, failed_checks: [] } } };
  assert.match(speakFiveLayerResults({ run_id: 'r1', coding_run_id: 'c1', results: {} }, coding), /Layer 5, Autonomous self-patching: passed/);
  assert.doesNotMatch(speakFiveLayerResults({ run_id: 'r1', coding_run_id: 'old', results: { 1: { level: 1, name: 'x', passed: true } } }, coding), /Layer 5/);
});
