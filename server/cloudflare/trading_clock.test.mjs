// The trading clock: 12-hour time only (12 AM to 11 PM), daylight saving, weekends, and the futures break.
import test from 'node:test';
import assert from 'node:assert/strict';
import { twelveHour, sessionOpen, futuresOpen, tradingClock, speakTradingClock, SESSIONS } from './trading_clock.js';

test('the clock reads 12 to 12: midnight is 12 AM, noon is 12 PM, never 24-hour', () => {
  assert.equal(twelveHour(0, 0), '12:00 AM');
  assert.equal(twelveHour(0, 5), '12:05 AM');
  assert.equal(twelveHour(9, 30), '9:30 AM');
  assert.equal(twelveHour(12, 0), '12:00 PM');
  assert.equal(twelveHour(13, 7), '1:07 PM');
  assert.equal(twelveHour(23, 59), '11:59 PM');
});

test('a session is open only on weekdays, inside its own hours', () => {
  const london = SESSIONS.find((s) => s.id === 'london');
  assert.equal(sessionOpen(london, 'Mon', 8, 0), true, 'opens at 8:00');
  assert.equal(sessionOpen(london, 'Mon', 7, 59), false);
  assert.equal(sessionOpen(london, 'Mon', 16, 29), true);
  assert.equal(sessionOpen(london, 'Mon', 16, 30), false, 'closes at 4:30 PM');
  assert.equal(sessionOpen(london, 'Sat', 10, 0), false, 'weekends are closed');
});

test('daylight saving moves London against New York, and the clock follows it', () => {
  // 2026-10-21 14:30 UTC: New York is on EDT (10:30 AM), London on BST (3:30 PM).
  const summer = tradingClock(Date.UTC(2026, 9, 21, 14, 30));
  assert.equal(summer.sessions.find((s) => s.id === 'new_york').local, '10:30 AM New York time');
  assert.equal(summer.sessions.find((s) => s.id === 'london').local, '3:30 PM London time');
  assert.equal(summer.clock, '10:30 AM New York time');
  // 2026-12-01 14:30 UTC: London is back on GMT, New York on EST; the same instant reads 2:30 PM in London.
  const winter = tradingClock(Date.UTC(2026, 11, 1, 14, 30));
  assert.equal(winter.sessions.find((s) => s.id === 'london').local, '2:30 PM London time');
});

test('the futures break is 5:00 to 6:00 PM New York, weekends closed, reopening Sunday 6:00 PM', () => {
  assert.equal(futuresOpen('Mon', 10, 0), true);
  assert.equal(futuresOpen('Mon', 17, 0), false, 'the daily break starts at 5:00 PM');
  assert.equal(futuresOpen('Mon', 17, 59), false);
  assert.equal(futuresOpen('Mon', 18, 0), true);
  assert.equal(futuresOpen('Fri', 16, 59), true);
  assert.equal(futuresOpen('Fri', 17, 0), false, 'closed from Friday 5:00 PM');
  assert.equal(futuresOpen('Sat', 12, 0), false);
  assert.equal(futuresOpen('Sun', 17, 59), false);
  assert.equal(futuresOpen('Sun', 18, 0), true);
});

test('the spoken clock names the open sessions and speaks in 12-hour time', () => {
  const text = speakTradingClock(tradingClock(Date.UTC(2026, 9, 21, 14, 30)));
  assert.equal(text, 'It is 10:30 AM New York time. London and New York are open. Asia (Tokyo) is closed. MNQ futures are open.');
  assert.doesNotMatch(text, /\b(?:1[3-9]|2[0-3]):[0-5]\d\b/, "no 24-hour times");
});
