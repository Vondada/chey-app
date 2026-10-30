// The certification probe reads one owner chat turn (probe_reply.js). A queued or refused turn is one JSON body, not an
// NDJSON stream, so its detail is the reply the owner sees. Offline, no network.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProbeChatBody } from './probe_reply.js';

test('an NDJSON stream gives its delta text, done frame and receipts', () => {
  const raw = [
    JSON.stringify({ type: 'delta', delta: 'Done, sir. ' }),
    JSON.stringify({ type: 'delta', delta: 'Nothing was bought.' }),
    JSON.stringify({ type: 'done', source: 'che_chat', route: 'model', execution_receipts: [{ tool: 'x' }] }),
  ].join('\n');
  const parsed = parseProbeChatBody(raw);
  assert.equal(parsed.reply, 'Done, sir. Nothing was bought.');
  assert.equal(parsed.done.source, 'che_chat');
  assert.equal(parsed.receipts.length, 1);
  assert.equal(parsed.error, null);
});

test('a single JSON body (a queued turn) gives its detail as the reply, not an empty one', () => {
  const raw = JSON.stringify({
    detail: 'I saved that, sir, but autonomy is paused, so I will finish it when you say "resume".',
    category: 'temporary_cloud_unavailable',
    retryable: true,
    background_job_id: 'job-1',
    background_job_status: 'queued',
  });
  const parsed = parseProbeChatBody(raw);
  assert.match(parsed.reply, /I saved that, sir/);
  assert.equal(parsed.error.category, 'temporary_cloud_unavailable');
  assert.deepEqual(parsed.done, {});
});

test('a single JSON body with a reply field is read as that reply', () => {
  const parsed = parseProbeChatBody(JSON.stringify({ reply: 'I could not record that safely, so I did not act.' }));
  assert.equal(parsed.reply, 'I could not record that safely, so I did not act.');
  assert.equal(parsed.error, null);
});

test('an error frame names its category and rules and leaves the reply empty', () => {
  const raw = [
    JSON.stringify({ type: 'error', category: 'empty_after_checks', rules: ['claim-no-receipt'] }),
    JSON.stringify({ type: 'done' }),
  ].join('\n');
  const parsed = parseProbeChatBody(raw);
  assert.equal(parsed.reply, '');
  assert.deepEqual(parsed.error, { category: 'empty_after_checks', rules: ['claim-no-receipt'] });
});

test('a body with no frames at all is an empty reply with no error', () => {
  const parsed = parseProbeChatBody('');
  assert.equal(parsed.reply, '');
  assert.equal(parsed.error, null);
});
