import test from 'node:test';
import assert from 'node:assert/strict';
import { chicagoDayKey } from './chicago_time.js';

test('Office day follows Chicago midnight, not UTC midnight', () => {
  // 7:30pm CDT on Sep 29 is already Sep 30 in UTC.
  assert.equal(chicagoDayKey(new Date('2026-09-30T00:30:00Z')), '2026-09-29');
  // 12:30am CDT Sep 30.
  assert.equal(chicagoDayKey(new Date('2026-09-30T05:30:00Z')), '2026-09-30');
  // Winter (CST, UTC-6): 11pm Jan 14 local is Jan 15 in UTC.
  assert.equal(chicagoDayKey(new Date('2027-01-15T05:00:00Z')), '2027-01-14');
  assert.equal(chicagoDayKey(new Date('2027-01-15T06:00:00Z')), '2027-01-15');
});

test('accepts timestamps and rejects invalid dates', () => {
  assert.equal(chicagoDayKey('2026-09-29T17:00:00Z'), '2026-09-29');
  assert.equal(chicagoDayKey('not a date'), '');
});
