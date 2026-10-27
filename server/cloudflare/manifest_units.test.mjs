// Manifestation Engine: the unit system that proves each model equation is dimensionally consistent.
import assert from 'node:assert/strict';
import test from 'node:test';
import { add, as, convert, describeDimension, div, mul, pow, q, sameDimension, sqrt } from './manifest_units.js';
import { pcm16ToWav } from './audio_wav.js';

test('derived units reduce to SI base dimensions', () => {
  assert.equal(describeDimension('W'), 'm^2 kg^1 s^-3');
  assert.equal(describeDimension('N/m^2'), describeDimension('Pa'));
  assert.ok(sameDimension('Wh', 'J'));
  assert.ok(sameDimension('USD/month', 'USD/s'));
  assert.ok(!sameDimension('USD', 'USD/item'));
  assert.ok(!sameDimension('kg', 'nonsense-unit'));
});

test('conversions are exact', () => {
  assert.equal(convert(1, 'Wh', 'J'), 3600);
  assert.equal(convert(1, 'kWh', 'Wh'), 1000);
  assert.equal(convert(90, 'min', 'h'), 1.5);
  assert.equal(convert(1, 'week', 'day'), 7);
  assert.equal(convert(12, 'month', 'day'), 365.2425);
  assert.equal(convert(500, 'g', 'kg'), 0.5);
});

test('equations with units: momentum-theory power comes out in watts, energy over power in time', () => {
  const T = mul(q(1, 'kg'), q(9.80665, 'm/s^2'));
  const A = q(0.2, 'm^2');
  const P = div(pow(T, 1.5), sqrt(mul(q(2), mul(q(1.225, 'kg/m^3'), A))));
  assert.ok(Math.abs(as(P, 'W') - 9.80665 ** 1.5 / Math.sqrt(2 * 1.225 * 0.2)) < 1e-12);
  assert.ok(Math.abs(as(div(q(60, 'Wh'), q(120, 'W')), 'min') - 30) < 1e-12);
});

test('adding or expressing mismatched dimensions throws', () => {
  assert.throws(() => add(q(1, 'm'), q(1, 'kg')), /Dimension mismatch/);
  assert.throws(() => as(q(1, 'W'), 'J'), /Cannot express/);
  assert.throws(() => q(1, 'furlong'), /Unknown unit/);
});

test('pcm16ToWav (moved out of worker.js unchanged) writes a 44-byte RIFF header', () => {
  const pcm = new Uint8Array([1, 2, 3, 4]);
  const wav = pcm16ToWav(pcm, 16000);
  const v = new DataView(wav.buffer);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...wav.slice(8, 12)), 'WAVE');
  assert.equal(v.getUint32(4, true), 40);
  assert.equal(v.getUint32(24, true), 16000);
  assert.equal(v.getUint32(40, true), 4);
  assert.deepEqual([...wav.slice(44)], [1, 2, 3, 4]);
});
