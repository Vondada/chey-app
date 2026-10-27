import test from 'node:test';
import assert from 'node:assert/strict';
import { READING_QUESTIONS, gradeReading } from './reading_probe.js';

const q = (id) => READING_QUESTIONS.find((x) => x.id === id);

test('every reading question has a paragraph-based ask and at least one required fact', () => {
  assert.equal(READING_QUESTIONS.length, 10);
  for (const item of READING_QUESTIONS) {
    assert.ok(item.ask && item.must.length, item.id);
  }
});

test('a correct, grounded answer passes; a missing fact fails', () => {
  assert.equal(gradeReading(q('facts'), 'Four ovens. It closes at 3 p.m. on Sundays. Rye sells out by noon on weekdays.').pass, true);
  assert.equal(gradeReading(q('facts'), 'It has four ovens and closes at 3 p.m. on Sundays.').pass, false);
});

test('an invented revenue figure fails the not-stated question; an honest refusal passes', () => {
  assert.equal(gradeReading(q('not-stated'), 'The paragraph does not say what its revenue is.').pass, true);
  assert.equal(gradeReading(q('not-stated'), 'Blue Oven makes about $400,000 a year.').pass, false);
});

test('a contradiction is flagged, not silently resolved to one date', () => {
  assert.equal(gradeReading(q('contradiction'), 'The text gives two dates, the 13th and the 14th, and they conflict.').pass, true);
  assert.equal(gradeReading(q('contradiction'), 'The meeting is on Thursday the 14th.').pass, false);
});

test('the rule is applied: 12 days at 20 cents is $2.40, 40 days is a flat $5', () => {
  assert.equal(gradeReading(q('rule'), 'The 12-day book costs $2.40 and the 40-day book is a flat $5.').pass, true);
  assert.equal(gradeReading(q('rule'), 'Both cost $5.').pass, false);
});

test('a causal claim the text does not make fails the fact-opinion question', () => {
  assert.equal(gradeReading(q('fact-opinion'), 'The 40 lanes and the 18 percent rise are facts; "waste of money" is an opinion. The lanes caused the 18 percent rise.').pass, false);
});

test('an empty reply fails every question', () => {
  for (const item of READING_QUESTIONS) assert.equal(gradeReading(item, '').pass, false, item.id);
});

test('an honest "I don\'t have enough information" passes the not-stated question', () => {
  assert.equal(gradeReading(q('not-stated'), "Sir, I don't have enough information to calculate Blue Oven's yearly revenue.").pass, true);
});

test('an internal mood label in the reply fails any question, even a correct answer', () => {
  assert.equal(gradeReading(q('pronoun'), 'Warmth 7/10: Dev handed over the keys to Sam, and she was the one who left.').pass, false);
});
