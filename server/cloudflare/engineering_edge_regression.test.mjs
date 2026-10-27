import test from 'node:test';
import assert from 'node:assert/strict';
import { shaftPowerTorque } from './engineering_math.js';

test('shaft power solves a null torque and verifies stationary shafts without division by zero', () => {
  const torque = shaftPowerTorque({ torque: null, omega: 100, power: 5000 });
  assert.equal(torque.ok, true);
  assert.equal(torque.solved, 'torque');
  assert.equal(torque.value.torque, 50);
  const stationary = shaftPowerTorque({ torque: 50, omega: 0 });
  assert.equal(stationary.ok, true);
  assert.equal(stationary.value.power, 0);
  assert.equal(stationary.checks.pass, true);
});


test('zero-denominator inversions and overflow are explicit failures, with nullish unknowns consistent', () => {
  for (const input of [{ torque: null, omega: 0, power: 0 }, { torque: 0, omega: null, power: 0 }, { torque: Number.MAX_VALUE, omega: 10 }]) {
    assert.equal(shaftPowerTorque(input).ok, false);
  }
  assert.equal(shaftPowerTorque({ torque: 50, omega: null, power: 5000 }).value.omega, 100);
  assert.equal(shaftPowerTorque({ torque: 50, omega: 100, power: null }).value.power, 5000);
});
