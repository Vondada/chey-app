// The certification runner's action outcome: read from receipts and the done frame, never from wording, and kept
// apart from pass/fail so a refusal is never counted as an executed action. Offline.
import assert from 'node:assert/strict';
import test from 'node:test';
import { actionOutcome, parseReplyBody } from '../../tools/certification/run_certification.mjs';

const ndjson = (...frames) => frames.map((f) => JSON.stringify(f)).join('\n');

test('a single execution_receipt on the done frame is read as a receipt', () => {
  const body = ndjson({ type: 'delta', delta: 'Timer set, sir.' }, { type: 'done', source: 'che_timer', execution_receipt: { tool: 'che_timer', status: 'success', timer_id: 't-1' } });
  const parsed = parseReplyBody(body);
  assert.equal(parsed.receipts.length, 1);
  assert.equal(actionOutcome({ classification: 'pass', receipts: parsed.receipts, done: parsed.done }), 'executed');
});

test('each outcome comes from receipts, the gate or the hold, not from the reply', () => {
  assert.equal(actionOutcome({ classification: 'pass', receipts: [{ status: 'error' }] }), 'failed_execution');
  assert.equal(actionOutcome({ classification: 'pass', held: parseReplyBody(JSON.stringify({ reply: 'Before I delete anything, I need your yes.', held_for_owner: true })).held }), 'awaiting_approval');
  assert.equal(actionOutcome({ classification: 'pass', done: { source: 'che_connector_gate' } }), 'missing_capability');
  assert.equal(actionOutcome({ classification: 'incorrect', reason: 'claims an action with no receipt: "i sent"' }), 'false_completion');
  assert.equal(actionOutcome({ classification: 'pass', done: { source: 'model' } }), 'no_action', 'a refusal or an answer is not an executed action');
});

test('through the probe route: a held turn and a single execution_receipt both reach the runner', async () => {
  const { parseProbeChatBody } = await import('./probe_reply.js');
  const held = parseProbeChatBody(JSON.stringify({ reply: 'Before I delete or remove anything, I need your yes.', held_for_owner: true }));
  const probeBody = JSON.stringify({ ok: true, status: 200, reply: held.reply, done: held.done, execution_receipts: held.receipts });
  assert.equal(parseReplyBody(probeBody).held, true);
  const timer = parseProbeChatBody(ndjson({ type: 'delta', delta: 'Timer set, sir.' }, { type: 'done', source: 'che_timer', execution_receipt: { tool: 'che_timer', status: 'success' } }));
  assert.equal(timer.receipts.length, 1);
  const out = parseReplyBody(JSON.stringify({ ok: true, status: 200, reply: timer.reply, done: timer.done, execution_receipts: timer.receipts }));
  assert.equal(actionOutcome({ classification: 'pass', receipts: out.receipts, done: out.done, held: out.held }), 'executed');
});
