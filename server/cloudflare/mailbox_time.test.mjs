import test from 'node:test';
import assert from 'node:assert/strict';
import { byMailTime, normalizeThreadTimes, parseMailTime } from './mailbox_time.js';
import { readAllMail } from './mailbox.js';
import { readWebMail } from './web_mailbox.js';

const env = { CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r' };
const chicago = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(iso));

// A read-only GitHub with fixed thread files (name -> lines).
function github(files) {
  const ok = (data, status = 200) => ({ ok: status < 300, status, json: async () => data });
  return async (url) => {
    const u = String(url);
    if (/\/contents\/mailbox\?ref=/.test(u)) return ok(Object.keys(files).map((name) => ({ name })));
    const m = /\/contents\/mailbox\/([a-z0-9-]+\.jsonl)/.exec(u);
    if (m && files[m[1]]) return ok({ content: btoa(files[m[1]].map((l) => JSON.stringify(l)).join('\n') + '\n'), sha: 's' });
    return ok({}, 404);
  };
}
function store() {
  const m = new Map();
  return { get: async (k) => m.get(k), put: async (k, v) => m.set(k, v), delete: async (k) => m.delete(k) };
}

// The owner's screenshot, 2026-10-24: iPhone at 12:16 PM CDT (17:16Z); Claude's line was typed as 19:30Z (2:30 PM)
// but committed at 16:39:50Z, and CHE's Worker-clock reply follows it in the file at 16:50:28.700Z.
const claudeLine = { id: 'claude-20261024-1930', at: '2026-10-24T19:30:00Z', from: 'claude', to: 'che', text: 'PR #520 Live 3D Studio' };
const cheReply = { id: 'a7252a2e', at: '2026-10-24T16:50:28.700Z', from: 'che', to: 'claude', text: 'Saved.', reply_to: 'claude-20261024-1930' };

test('owner case: a Claude message created at 17:16Z reads 12:16 PM CDT and stays UTC Z on the wire', async () => {
  const fetcher = github({ 'claude.jsonl': [{ id: 'c1', at: '2026-10-24T17:16:00Z', from: 'claude', to: 'che', text: 'hi' }] });
  const { messages } = await readAllMail(env, fetcher, { now: Date.parse('2026-10-24T17:16:30Z') });
  assert.equal(messages[0].at, '2026-10-24T17:16:00.000Z');
  assert.equal(chicago(messages[0].at), '12:16 PM CDT');
});

test('owner case: a hand-typed time later than the line could exist is not shown as 2:30 PM', async () => {
  const fetcher = github({ 'claude.jsonl': [claudeLine, cheReply] });
  const { messages } = await readAllMail(env, fetcher, { now: Date.parse('2026-10-24T17:16:00Z') });
  const claude = messages.find((m) => m.id === claudeLine.id);
  assert.equal(claude.claimed_at, '2026-10-24T19:30:00Z', 'the sender value is kept, not erased');
  assert.equal(claude.at, '2026-10-24T16:50:28.700Z', 'no later than the Worker-clock reply written after it');
  assert.equal(chicago(claude.at), '11:50 AM CDT');
  assert.deepEqual(messages.map((m) => m.id), [claudeLine.id, cheReply.id], 'the message sorts before its reply');
});

test('a future time with nothing after it is held to when the Worker first saw it, stably', async () => {
  const s = store();
  const fetcher = github({ 'claude.jsonl': [claudeLine] });
  const realNow = Date.now;
  try {
    Date.now = () => Date.parse('2026-10-24T17:16:00Z');
    const first = await readWebMail(s, 50, env, fetcher);
    assert.equal(first[0].at, '2026-10-24T17:16:00.000Z');
    assert.equal(first[0].received_at, '2026-10-24T17:16:00.000Z');
    Date.now = () => Date.parse('2026-10-24T17:40:00Z');   // cache expired: a fresh GitHub read
    const again = await readWebMail(s, 50, env, fetcher);
    assert.equal(again[0].at, '2026-10-24T17:16:00.000Z', 'does not drift to each read time');
    assert.equal(again[0].received_at, '2026-10-24T17:16:00.000Z');
  } finally { Date.now = realNow; }
});

test('delayed delivery: created 12:16 PM CDT, first seen 2:30 PM CDT, still shows and sorts by 12:16', async () => {
  const s = store();
  const fetcher = github({
    'claude.jsonl': [{ id: 'late', at: '2026-10-24T17:16:00Z', from: 'claude', to: 'che', text: 'written offline' }],
    'chatgpt.jsonl': [{ id: 'mid', at: '2026-10-24T18:00:00.000Z', from: 'chatgpt', to: 'che', text: 'later' }],
  });
  const realNow = Date.now;
  try {
    Date.now = () => Date.parse('2026-10-24T19:30:00Z');
    const board = await readWebMail(s, 50, env, fetcher);
    assert.deepEqual(board.map((m) => m.id), ['late', 'mid']);
    assert.equal(board[0].at, '2026-10-24T17:16:00.000Z');
    assert.equal(board[0].received_at, '2026-10-24T19:30:00.000Z');
    assert.equal(chicago(board[0].at), '12:16 PM CDT');
  } finally { Date.now = realNow; }
});

test('ordering is by instant across zone formats, with a stable tie-break', async () => {
  const fetcher = github({
    'claude.jsonl': [
      { id: 'a', at: '2026-10-24T12:16:00-05:00', from: 'claude', to: 'che', text: '1' },
      { id: 'b', at: '2026-10-24T17:16:00.000000+00:00', from: 'claude', to: 'che', text: '2' },
    ],
    'codex.jsonl': [{ id: 'c', at: '2026-10-24T17:15:59Z', from: 'codex', to: 'che', text: '0' }],
  });
  const { messages } = await readAllMail(env, fetcher, { now: Date.parse('2026-10-25T00:00:00Z') });
  assert.deepEqual(messages.map((m) => m.id), ['c', 'a', 'b'], 'a and b are the same instant and keep file order');
  assert.ok(messages.every((m) => m.at.endsWith('Z')));
  // String order would have put "-05:00" 12:16 before 17:15:59Z only by luck; this pair proves the instant is used.
  const mixed = [{ at: '2026-10-24T18:00:00+02:00' }, { at: '2026-10-24T17:00:00Z' }].sort(byMailTime);
  assert.equal(mixed[0].at, '2026-10-24T18:00:00+02:00');
});

test('DST: 2026-11-01 fall-back and 2026-03-08 spring-forward in America/Chicago', () => {
  const at = (v) => normalizeThreadTimes([{ id: 'x', at: v, from: 'claude' }], { now: Date.parse('2027-01-01T00:00:00Z') })[0].at;
  assert.equal(chicago(at('2026-11-01T06:30:00Z')), '1:30 AM CDT');   // first 1:30
  assert.equal(chicago(at('2026-11-01T07:30:00Z')), '1:30 AM CST');   // second 1:30, an hour later
  assert.equal(chicago(at('2026-11-01T18:00:00Z')), '12:00 PM CST');
  assert.equal(chicago(at('2026-03-08T07:59:00Z')), '1:59 AM CST');
  assert.equal(chicago(at('2026-03-08T08:00:00Z')), '3:00 AM CDT');   // 2:00-2:59 never happens
  assert.equal(chicago(at('2026-03-08T17:16:00Z')), '12:16 PM CDT');
  const across = [{ id: 'late', at: '2026-11-01T07:10:00Z' }, { id: 'early', at: '2026-11-01T06:50:00Z' }].sort(byMailTime);
  assert.deepEqual(across.map((m) => m.id), ['early', 'late'], 'CST 1:10 AM is after CDT 1:50 AM');
});

test('zone-less legacy values: a date stays that date, a clock time is read as UTC and marked', () => {
  const [day, bare] = normalizeThreadTimes([
    { id: 'd', at: '2026-10-18', from: 'chatgpt' },
    { id: 't', at: '2026-10-24T17:16:00', from: 'claude' },
  ], { now: Date.parse('2026-10-25T00:00:00Z') });
  assert.equal(day.at, '2026-10-18T00:00:00.000Z');
  assert.equal(day.at_precision, 'day');
  assert.equal(bare.at, '2026-10-24T17:16:00.000Z');
  assert.equal(bare.at_zone, 'assumed-utc');
  assert.equal(parseMailTime('not a time'), null);
  assert.equal(parseMailTime('2026-13-01T00:00:00Z'), null);
});

test('valid times are never replaced by the read time, and the stored lines are untouched', () => {
  const lines = [claudeLine, cheReply];
  const copy = JSON.parse(JSON.stringify(lines));
  const out = normalizeThreadTimes([{ id: 'old', at: '2026-01-02T03:04:05Z', from: 'claude' }, ...lines], { now: Date.parse('2026-10-24T17:16:00Z') });
  assert.equal(out[0].at, '2026-01-02T03:04:05.000Z');
  assert.equal(out[0].claimed_at, undefined);
  assert.deepEqual(lines, copy);
});
