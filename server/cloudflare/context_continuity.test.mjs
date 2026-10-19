import test from 'node:test';
import assert from 'node:assert/strict';
import { routeText, resetRouterForTests, fitToBudget } from './ai_router.js';
import { condenseHistory } from './workflow_governor.js';

const history = () => [
  { role: 'user', content: 'The customer is Willo. Delivery is Friday at 16:45. Use https://example.com/a?b=2.' },
  { role: 'assistant', content: 'The job is queued; it has not executed.' },
  ...Array.from({ length: 26 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Detail ${i}: ${'reference material '.repeat(20)}Tail ${i}.` })),
  { role: 'user', content: 'Continue with those details.' },
];

test('history preparation keeps every turn and its attribution without a second summary', () => {
  const h = history();
  const prepared = condenseHistory(h, { keep: 12, maxCondensedChars: 100 });
  assert.deepEqual(prepared.turns, h);
  assert.equal(prepared.condensed, '');
  assert.equal(prepared.dropped, 0);
});

test('capacity refusal preserves old requirements and system rules, including multimodal input', () => {
  const input = { messages: [
    { role: 'system', content: 'identity '.repeat(2000) + ' Approval is required before spending.' },
    ...history(),
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/image.png' } }] },
  ] };
  const original = structuredClone(input);
  const result = fitToBudget(input, 8000);
  assert.equal(result.oversize, true);
  assert.deepEqual(result.messages, original.messages);
  assert.deepEqual(input, original);
});

test('provider failure hands the complete conversation to the replacement, without recursive summaries', async () => {
  resetRouterForTests();
  const received = [];
  const input = { messages: [{ role: 'system', content: 'Keep all names and numbers.' }, ...history()] };
  const before = structuredClone(input);
  await routeText({ GROQ_API_KEY: 'g', MISTRAL_API_KEY: 'm', CHE_GROQ_INPUT_CHARS: '60000', CHE_DISABLE_KEYLESS_AI: '1' }, '@cf/x', input, async (url, init) => {
    const body = JSON.parse(init.body);
    received.push(body.messages);
    if (String(url).includes('groq')) return new Response('unavailable', { status: 503 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Ready.' } }] }));
  });
  assert.ok(received.length >= 2, 'a real provider failure followed by replacement');
  for (const messages of received) assert.deepEqual(messages, input.messages);
  assert.deepEqual(input, before);
});

import { createObjective, recordNodeOutcome, nodeContext, condenseObjective } from './objective_graph.js';

test('job receipts, dependency context and completed state preserve the full result and mission tail', () => {
  const result = 'x'.repeat(18000) + '\nExact path: lib/voice/mic.dart; verify mic_test before deployment.';
  const objective = createObjective({ objective: 'Fix the microphone', constraints: ['Owner approval before deploy'], owner_authorized: true, nodes: [
    { id: 'inspect', prompt: 'Inspect' }, { id: 'fix', prompt: 'Fix', depends_on: ['inspect'] },
  ] });
  recordNodeOutcome(objective, 'inspect', { id: 'receipt-1', status: 'complete', result });
  assert.equal(objective.nodes[0].output, result);
  const context = nodeContext(objective, objective.nodes[1]);
  assert.ok(context.includes(result));
  assert.ok(context.includes('Owner approval before deploy'));
  objective.nodes[1].status = 'complete';
  condenseObjective(objective, { budgetTokens: 100 });
  assert.equal(objective.nodes[0].output, result, 'later verification/replanning still has the receipt');
});
