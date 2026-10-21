import assert from 'node:assert/strict';
import test from 'node:test';
import { kindGuidance, messageKind, progressClaimProblems, threadFor } from './flagstaff_thread.js';

// Real messages from the Flagstaff thread, classified as the owner means them.
test('a status report from Claude is a status report, not a request', () => {
  assert.equal(messageKind('Merged to main on the owner\'s request: #398 (voice teardown), #400 (owner chat retrieval). Still open: #397 (screen sharing).'), 'status');
  assert.equal(messageKind('Gmail routing: the owner\'s sentence reached the model only on a guest phone. Fixed on claude/che-gmail-guest-route at 4caf185. NOT merged. Not done: the three demonstrations.'), 'status');
  assert.equal(messageKind('Knowledge Library first slice is PR #407 (ff5e3b3). Not merged. Still needed: the category catalog titles from the owner.'), 'status');
});

test('a message that asks CHE to do work is a request', () => {
  assert.equal(messageKind('Owner\'s next Claude Code job: do all of this as ONE combined PR, merge it when tests pass, then post a summary.'), 'request');
  assert.equal(messageKind('Please review PR 412 and tell me whether it is safe to merge.'), 'request');
});

test('a question is a question', () => {
  assert.equal(messageKind('Is the Worker deployed on main?'), 'question');
  assert.equal(messageKind('What did the deploy check return'), 'question');
});

test('the status kind gets guidance that it is information, not an ask', () => {
  assert.match(kindGuidance('status'), /STATUS REPORT[\s\S]*Do not ask whether to do the work/);
});

test('threadFor returns only the sender\'s conversation, oldest first, without the current message', () => {
  const messages = [
    { id: 'a1', from: 'claude', to: 'che', at: '2026-10-21T10:00:00Z', text: 'first status' },
    { id: 'c1', from: 'che', to: 'claude', at: '2026-10-21T10:01:00Z', text: 'first reply' },
    { id: 'x1', from: 'chatgpt', to: 'che', at: '2026-10-21T10:02:00Z', text: 'another AI' },
    { id: 'a2', from: 'claude', to: 'che', at: '2026-10-21T10:03:00Z', text: 'second status' },
    { id: 'now', from: 'claude', to: 'che', at: '2026-10-21T10:04:00Z', text: 'the message being answered' },
  ];
  const thread = threadFor(messages, 'claude', 'now');
  assert.deepEqual(thread.map((m) => m.text), ['first status', 'first reply', 'second status']);
  assert.deepEqual(threadFor(messages, 'claude', 'now', { limit: 2 }).map((m) => m.id ?? m.text), ['first reply', 'second status']);
});

test('threadFor cuts long text rather than sending all of it', () => {
  const long = 'x'.repeat(2000);
  const [only] = threadFor([{ id: 'a', from: 'claude', to: 'che', at: '2026-10-21T10:00:00Z', text: long }], 'claude', 'now');
  assert.equal(only.text.length, 500);
});

test('a reply that says CHE is doing the work now is flagged', () => {
  assert.deepEqual(progressClaimProblems('Good. I am merging PRs #407 and #408 now.', { kind: 'status' }).length, 1);
});

test('a reply that says CHE already finished work is flagged, but a plain "not merged" is not', () => {
  assert.equal(progressClaimProblems('I have merged the branch.').length, 1);
  assert.deepEqual(progressClaimProblems('I have not reviewed or merged that branch myself yet.'), []);
});

test('asking whether to act on a status report is flagged; the same ask after a request is not', () => {
  const reply = 'I have not merged it. If you want me to merge it, just let me know.';
  assert.equal(progressClaimProblems(reply, { kind: 'status' }).length, 1);
  assert.deepEqual(progressClaimProblems(reply, { kind: 'request' }), []);
});

test('an ordinary acknowledgement is not flagged', () => {
  assert.deepEqual(progressClaimProblems('Thanks. The catalog titles are in the code, so I checked the seed file.', { kind: 'status' }), []);
});
