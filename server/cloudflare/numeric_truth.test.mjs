// Numeric truth: CHE's arithmetic and reference checks must catch wrong figures (including the observable-universe
// star count error), accept correct ones, label estimates, and stay quiet on ordinary numbers.
import assert from 'node:assert/strict';
import test from 'node:test';
import { C_M_PER_S, LIGHT_YEAR_M, canonUnit, checkNumericClaims, formatNumber, numericNotes, quantitiesIn } from './numeric_truth.js';
import { TRUTH_STAGES } from './truth_pipeline.js';

const statusOf = (text) => checkNumericClaims(text).claims.map((c) => c.status);

test('the light-year and the speed of light are the exact definitions', () => {
  assert.equal(C_M_PER_S, 299792458);
  assert.ok(Math.abs(LIGHT_YEAR_M - 9.4607304725808e15) < 1e6);
});

test('incorrect astronomical quantities: a star count far below the estimate range is contradicted', () => {
  const { claims } = checkNumericClaims('The observable universe has about 100 billion stars.');
  assert.equal(claims.length, 1);
  assert.equal(claims[0].kind, 'reference');
  assert.equal(claims[0].status, 'contradicted');
  assert.match(claims[0].note, /10\^22 to 10\^24/);
  assert.match(claims[0].note, /not a measured count/);
});

test('incorrect astronomical quantities: an exaggerated count is contradicted, a count in range is an estimate', () => {
  assert.deepEqual(statusOf('The observable universe contains 10^30 stars.'), ['contradicted']);
  assert.deepEqual(statusOf('The observable universe contains about 2 × 10^23 stars.'), ['estimate']);
  assert.deepEqual(statusOf('The observable universe contains about 10^21 stars.'), ['doubtful']);
});

test('light-year conversion: a correct figure verifies and a wrong one is corrected by arithmetic', () => {
  const good = checkNumericClaims('1 light-year is 9.46 trillion km.').claims;
  assert.equal(good[0].kind, 'conversion');
  assert.equal(good[0].status, 'verified');
  const bad = checkNumericClaims('1 light-year is 9.46 billion km.').claims[0];
  assert.equal(bad.status, 'contradicted');
  assert.match(bad.note, /9\.46 × 10\^12 km, not 9\.46 billion km/);
});

test('light-year travel time: light takes one year per light-year, and a wrong travel time is caught', () => {
  assert.deepEqual(statusOf('Proxima Centauri is 4.24 light-years away, and light takes 4.24 years to reach us.'), ['verified']);
  const wrong = checkNumericClaims('Proxima Centauri is 4.24 light-years away, and light takes 42 years to reach us.').claims.find((c) => c.kind === 'travel_time');
  assert.equal(wrong.status, 'contradicted');
  assert.match(wrong.note, /takes about 4\.24 yr, not 42 years/);
});

test('travel time at a given speed: 10 billion km at 17 km/s takes about 18.6 years, not 50', () => {
  const claim = checkNumericClaims('A probe 10 billion km away moving at 17 km/s takes 50 years to get there.').claims[0];
  assert.equal(claim.kind, 'travel_time');
  assert.equal(claim.status, 'contradicted');
  assert.ok(Math.abs(claim.expected - 18.6) < 0.1, `expected ~18.6 years, got ${claim.expected}`);
  assert.deepEqual(statusOf('At 17 km/s a probe needs about 18.6 years to cover 10 billion km.'), ['verified']);
});

test('unit consistency: a length cannot equal a time, and a constant is checked against its definition', () => {
  const mismatch = checkNumericClaims('1 light-year is 9.46 trillion seconds.').claims[0];
  assert.equal(mismatch.kind, 'unit_mismatch');
  assert.equal(mismatch.status, 'contradicted');
  assert.deepEqual(statusOf('The speed of light is 3 million km per second.'), ['contradicted']);
  assert.deepEqual(statusOf('The speed of light is about 300,000 km per second.'), ['verified']);
});

test('unit conversions: an hour and a minute agree, a ratio with a wrong figure does not', () => {
  assert.deepEqual(statusOf('1 hour is 60 minutes.'), ['verified']);
  assert.deepEqual(statusOf('2 hours is 30 minutes.'), ['contradicted']);
});

test('contradictions inside one reply are flagged on the later figure', () => {
  const claims = checkNumericClaims('The observable universe has 10^22 stars. Later I said the observable universe has 10^12 stars.').claims;
  assert.equal(claims[1].status, 'contradicted');
  assert.match(claims[1].note, /disagrees with the 1\.00 × 10\^22 stars this reply gives earlier/);
});

test('no false positives on ordinary numbers and unrelated sentences', () => {
  assert.equal(numericNotes('I have 3 cats and the meeting is at 2 pm.'), '');
  assert.equal(numericNotes('Blue Oven rye is served at noon, and the library fee is $2.40.'), '');
  assert.equal(numericNotes('The trip is 10 km and 3 hours long.'), '');
});

test('an unverifiable reply stays honest: an unknown subject gets no invented verdict', () => {
  assert.equal(checkNumericClaims('The Moon is 384,400 km away.').claims.length, 0);
});

test('numericNotes labels estimates, unverified figures and corrections, and never gives more than three notes', () => {
  assert.match(numericNotes('The observable universe has 2 × 10^23 stars.'), /^Estimate: /);
  assert.match(numericNotes('The observable universe has 10^21 stars.'), /^Unverified: /);
  const notes = numericNotes('The observable universe has 100 billion stars. 1 light-year is 9.46 billion km. The speed of light is 3 million km per second. 2 hours is 30 minutes.');
  assert.match(notes, /^Correction \(arithmetic, not memory\)/);
  assert.equal(notes.split('Correction (arithmetic, not memory)').length - 1, 3);
});

test('quantities parse magnitude words, powers of ten and units', () => {
  const [q] = quantitiesIn('about 9.46 trillion km');
  assert.equal(q.value, 9.46e12);
  assert.equal(q.unit, 'km');
  assert.equal(canonUnit('light-years'), 'ly');
  assert.equal(canonUnit('km per second'), 'km/s');
  assert.equal(formatNumber(9.4607e12), '9.46 × 10^12');
});

test('the numeric_check stage appends corrections and leaves a correct reply unchanged', async () => {
  const stage = TRUTH_STAGES.find((s) => s.name === 'numeric_check');
  assert.ok(stage, 'numeric_check stage is registered');
  const wrong = await stage.run('The observable universe has 100 billion stars.', {});
  assert.match(wrong.text, /^The observable universe has 100 billion stars\. Correction/);
  assert.deepEqual(wrong.removed, []);
  const right = await stage.run('1 light-year is 9.46 trillion km.', {});
  assert.equal(right.text, '1 light-year is 9.46 trillion km.');
});
