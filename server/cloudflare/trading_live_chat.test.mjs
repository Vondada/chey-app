import assert from 'node:assert/strict';
import test from 'node:test';
import { feedLine } from './trading_live_chat.js';

test('feed freshness is read against the clock: a day-old LIVE record is not called current (PR #805 review)', () => {
  const now = Date.parse('2026-10-31T15:00:00Z');
  const d = { session: { state: 'open' }, feed: { status: 'LIVE', provider: 'Tradovate', provider_symbol: 'MNQ', contract: 'MNQZ6', latency_s: 4, last_bar_time: '2026-10-30T14:50:00Z' } };
  const old = feedLine(d, now);
  assert.doesNotMatch(old, /^Data: LIVE|0 minutes/);
  assert.match(old, /^Last recorded data status: LIVE MNQ \(MNQZ6\) from Tradovate, but the newest bar closed at .*, about 24 hours ago, so it is not current now\./);
  const fresh = feedLine({ ...d, feed: { ...d.feed, last_bar_time: '2026-10-31T14:50:00Z' } }, now);
  assert.match(fresh, /^Data: LIVE MNQ \(MNQZ6\) from Tradovate, last bar closed about 5 minutes ago\. Market: open\.$/);
  const unknown = feedLine({ ...d, feed: { ...d.feed, last_bar_time: null } }, now);
  assert.match(unknown, /newest bar time was not recorded, so I can't say it is current/);
});
