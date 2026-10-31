// The timer connector: a set is read back before CHE says it is set, the alarm marks it fired with the time it
// really ran, and the owner hears it in his next reply. Offline: an in-memory storage, no network, no model.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PROBE_TIMERS_KEY, clockTimeMs, durationMs, fireDueTimers, nextTimerAt, takeTimerAnnouncement, timerChatTurn, timerIntent, timerLabel, TIMERS_KEY } from './owner_timers.js';

function memory() {
  const map = new Map();
  return { map, get: async (k) => structuredClone(map.get(k)), put: async (k, v) => { map.set(k, structuredClone(v)); }, delete: async (k) => map.delete(k) };
}

const T0 = Date.parse('2026-10-31T06:00:00Z');

test('durations and clock times are read from the request', () => {
  assert.equal(durationMs('Set a timer for 10 minutes.'), 600_000);
  assert.equal(durationMs('set a timer for an hour and 30 minutes'), 5_400_000);
  assert.equal(durationMs('remind me in half an hour to stretch'), 1_800_000);
  assert.equal(durationMs('start a five-minute timer'), 300_000);
  assert.equal(durationMs('set a 90 second timer'), 90_000);
  assert.equal(durationMs('set a timer'), 0);
  // 7 am in Chicago on 2026-10-31 (CDT, UTC-5) is 12:00 UTC.
  assert.equal(new Date(clockTimeMs('wake me with an alarm for 7 am', 'America/Chicago', T0)).toISOString(), '2026-10-31T12:00:00.000Z');
  assert.equal(new Date(clockTimeMs('remind me tomorrow at 5 am to stretch', 'UTC', T0)).toISOString(), '2026-11-01T05:00:00.000Z');
  // Live run 41210217956, 2026-10-31 14:28 UTC: 6:45 am Chicago has passed, and the next 6:45 is on Nov 1, after the
  // clocks go back (CST, UTC-6): 12:45 UTC, not 11:45.
  assert.equal(new Date(clockTimeMs('Set an alarm for 6:45 am.', 'America/Chicago', Date.parse('2026-10-31T14:28:00Z'))).toISOString(), '2026-11-01T12:45:00.000Z');
  assert.equal(new Date(clockTimeMs('remind me tomorrow at 6:45 am', 'America/Chicago', Date.parse('2026-10-31T10:00:00Z'))).toISOString(), '2026-11-01T12:45:00.000Z');
  // 12:30 am has passed in UTC by 06:00, so it is tomorrow.
  assert.equal(new Date(clockTimeMs('remind me at 12:30 am', 'UTC', T0)).toISOString(), '2026-11-01T00:30:00.000Z');
});

test('only a timer request reaches the connector; questions about timers do not', () => {
  assert.deepEqual(timerIntent('Set a timer for 10 minutes.'), { action: 'set' });
  assert.deepEqual(timerIntent('Remind me to call Sam in 20 minutes.'), { action: 'set' });
  assert.deepEqual(timerIntent('What timers do I have?'), { action: 'list' });
  assert.deepEqual(timerIntent('Cancel my timer.'), { action: 'cancel' });
  assert.equal(timerIntent('How does a kitchen timer work?'), null);
  assert.equal(timerIntent('Can you tell me how a timer works?'), null);
  assert.equal(timerIntent('Turn off the living room light.'), null);
  assert.equal(timerLabel('Remind me to call Sam in 20 minutes.'), 'call Sam');
  assert.equal(timerLabel('Set a timer for 10 minutes.'), '');
});

test('a set timer is saved, read back, receipted, fired by the alarm and announced once', async () => {
  const storage = memory();
  let woke = 0;
  const set = await timerChatTurn(storage, 'Set a timer for 10 minutes.', { timeZone: 'UTC', now: T0, wake: async () => { woke += 1; } });
  assert.equal(set.meta.model_calls, 0);
  assert.equal(set.meta.execution_receipt.status, 'success');
  assert.equal(set.meta.execution_receipt.verified, 'read_back');
  assert.match(set.text, /^Timer set, sir: 10 minutes, at 6:10 AM\. It is saved on CHE's server as timer t-/);
  assert.match(set.text, /I can't ring your phone/);
  assert.equal(woke, 1);
  assert.equal(await nextTimerAt(storage), T0 + 600_000);
  const receipts = storage.map.get('che_receipts') || [];
  assert.ok(receipts.some((r) => r.kind === 'timer_set' && r.timer_id === set.meta.timer.id));

  assert.deepEqual(await fireDueTimers(storage, T0 + 599_000), []);
  const fired = await fireDueTimers(storage, T0 + 601_000);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].fired_at, new Date(T0 + 601_000).toISOString());
  assert.equal(await nextTimerAt(storage), 0);
  assert.ok((storage.map.get('che_receipts') || []).some((r) => r.kind === 'timer_fired' && r.timer_id === set.meta.timer.id));

  const said = await takeTimerAnnouncement(storage, 'UTC');
  assert.match(said, /^Your 10 minutes timer went off at 6:10 AM, sir \(timer t-/);
  assert.equal(await takeTimerAnnouncement(storage, 'UTC'), '');
});

test('a reminder keeps its label; list and cancel read the stored records', async () => {
  const storage = memory();
  const set = await timerChatTurn(storage, 'Remind me to call Sam in 20 minutes.', { timeZone: 'UTC', now: T0 });
  assert.match(set.text, /^Reminder set, sir: call Sam, at 6:20 AM\./);
  const list = await timerChatTurn(storage, 'What timers do I have?', { timeZone: 'UTC', now: T0 + 60_000 });
  assert.match(list.text, /call Sam\): goes off at 6:20 AM, 19 minutes left/);
  const cancel = await timerChatTurn(storage, 'Cancel my reminder.', { timeZone: 'UTC', now: T0 + 120_000 });
  assert.match(cancel.text, /^Cancelled, sir: reminder \(call Sam\)/);
  assert.equal(await nextTimerAt(storage), 0);
  assert.deepEqual(await fireDueTimers(storage, T0 + 3_600_000), []);
  const none = await timerChatTurn(storage, 'Cancel my timer.', { timeZone: 'UTC', now: T0 });
  assert.match(none.text, /no running timer to cancel/);
});

test('no duration sets nothing and says so; an impossible one is refused', async () => {
  const storage = memory();
  const ask = await timerChatTurn(storage, 'Can you set a timer?', { now: T0 });
  assert.match(ask.text, /For how long, sir\?.*Nothing is set yet/);
  assert.equal(storage.map.get(TIMERS_KEY), undefined);
  const month = await timerChatTurn(storage, 'I paid the electric bill, can you remind me next month?', { now: T0 });
  assert.match(month.text, /^I did not set that reminder, sir: .*"next month" is not one I can place/);
  assert.equal(storage.map.get(TIMERS_KEY), undefined);
  const long = await timerChatTurn(storage, 'Set a timer for 200 hours.', { now: T0 });
  assert.match(long.text, /I did not set it, sir: that is more than seven days away/);
});

test('probe timers live under their own key: the owner\'s list and receipt log are never touched, and they still fire', async () => {
  const storage = memory();
  const set = await timerChatTurn(storage, 'Set a timer for 5 seconds.', { now: T0, key: PROBE_TIMERS_KEY });
  assert.equal(set.meta.execution_receipt.status, 'success');
  assert.equal(storage.map.get(TIMERS_KEY), undefined);
  assert.equal(storage.map.get('che_receipts'), undefined);
  assert.equal(await nextTimerAt(storage), 0);
  assert.equal(await nextTimerAt(storage, PROBE_TIMERS_KEY), T0 + 5000);
  assert.equal((await fireDueTimers(storage, T0 + 6000, PROBE_TIMERS_KEY)).length, 1);
  const fired = storage.map.get(PROBE_TIMERS_KEY)[0];
  assert.deepEqual(fired.receipts.map((r) => r.kind), ['timer_set', 'timer_fired']);
  assert.equal(await takeTimerAnnouncement(storage, 'UTC'), '', 'the owner hears nothing');
  assert.match(await takeTimerAnnouncement(storage, 'UTC', PROBE_TIMERS_KEY), /went off/);
});

// Certification run 41233462389 (mr-15): "What reminder did I ask you to set for Thursday?" listed an unrelated timer.
test('a list question that names a day answers for that day only', async () => {
  const { timerChatTurn, setTimer } = await import('./owner_timers.js');
  const saved = new Map();
  const storage = { get: async (k) => structuredClone(saved.get(k)), put: async (k, v) => { saved.set(k, structuredClone(v)); } };
  const now = Date.parse('2026-10-31T12:00:00Z'); // a Saturday
  await setTimer(storage, { ms: 20 * 60_000, label: 'tea', now });
  const thursday = await timerChatTurn(storage, 'What reminder did I ask you to set for Thursday?', { now, timeZone: 'UTC' });
  assert.match(thursday.text, /^I have no timer or reminder recorded for Thursday, sir\. One other is on record/);
  assert.doesNotMatch(thursday.text, /tea/);
  const today = await timerChatTurn(storage, 'What timers do I have today?', { now, timeZone: 'UTC' });
  assert.match(today.text, /^Running, sir: .*tea/i);
  const all = await timerChatTurn(storage, 'What timers do I have?', { now, timeZone: 'UTC' });
  assert.match(all.text, /tea/);
});

test('"yesterday" is not "today" for a day-scoped timer question', async () => {
  const { timerChatTurn, setTimer } = await import('./owner_timers.js');
  const saved = new Map();
  const storage = { get: async (k) => structuredClone(saved.get(k)), put: async (k, v) => { saved.set(k, structuredClone(v)); } };
  const now = Date.parse('2026-10-31T12:00:00Z');
  await setTimer(storage, { ms: 20 * 60_000, label: 'tea', now });
  const out = await timerChatTurn(storage, 'What reminders did I have yesterday?', { now, timeZone: 'UTC' });
  assert.match(out.text, /tea/, 'no day filter applied for "yesterday"');
});

// Codex on #820: across the New York daylight-saving change, "tomorrow" and "Monday" must still find a reminder set
// for 9 AM on 2 November.
test('a day-scoped timer question survives a daylight-saving change', async () => {
  const { timerChatTurn } = await import('./owner_timers.js');
  const saved = new Map();
  const storage = { get: async (k) => structuredClone(saved.get(k)), put: async (k, v) => { saved.set(k, structuredClone(v)); } };
  const now = Date.parse('2026-11-01T04:30:00Z'); // 00:30 on Sunday 1 November in New York
  const set = await timerChatTurn(storage, 'Remind me tomorrow at 9 am to call Sam', { now, timeZone: 'America/New_York' });
  assert.equal(set.meta.ok, true, set.text);
  for (const ask of ['What reminders do I have tomorrow?', 'What reminder did I set for Monday?']) {
    const out = await timerChatTurn(storage, ask, { now, timeZone: 'America/New_York' });
    assert.match(out.text, /call Sam/i, ask);
  }
});
