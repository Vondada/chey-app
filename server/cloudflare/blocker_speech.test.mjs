import test from 'node:test';
import assert from 'node:assert/strict';
import { cheBlockerSpeech, newBlockerAnnouncements } from './blocker_speech.js';

test('CHE speaks a new tool blocker once', () => {
  const spoken = new Set();
  const line = cheBlockerSpeech('Knox', 'Blocked: tool not configured (Codex)', spoken);
  assert.equal(line, 'CHE here. Blocked: tool not configured. Knox cannot start until Codex is connected on the Worker.');
  assert.equal(cheBlockerSpeech('Knox', 'Blocked: tool not configured (Codex)', spoken), null);
  assert.equal(cheBlockerSpeech('Knox', 'Working: Build checkout', spoken), null);
});

test('announcements dedup across polls and re-announce a returning blocker', () => {
  const blocked = [{ name: 'Knox', state: 'blocked', status: 'Blocked: tool not configured (Codex)' },
    { name: 'Lyra', state: 'idle', status: 'Idle' }];
  const first = newBlockerAnnouncements(blocked, []);
  assert.equal(first.lines.length, 1);
  assert.match(first.lines[0], /Knox cannot start until Codex/);

  const second = newBlockerAnnouncements(blocked, first.keys);
  assert.deepEqual(second.lines, []);

  const cleared = newBlockerAnnouncements([{ name: 'Knox', state: 'working', status: 'Working: x' }], second.keys);
  assert.deepEqual(cleared.keys, []);

  const back = newBlockerAnnouncements(blocked, cleared.keys);
  assert.equal(back.lines.length, 1);
});

test('agents never speak: every line is CHE', () => {
  const { lines } = newBlockerAnnouncements([
    { name: 'Sage', state: 'blocked', status: 'Blocked: tool not configured (Stripe not connected)' },
    { name: 'Nova', state: 'blocked', status: 'Blocked: Nova cannot spend money. Only the owner does.' },
  ]);
  assert.equal(lines.length, 2);
  for (const l of lines) assert.ok(l.startsWith('CHE here.'));
});
