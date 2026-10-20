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

test('actual HTTP 413 skips that provider once and preserves every instruction on fallback', async () => {
  resetRouterForTests();
  const messages = [{ role: 'system', content: 'Never spend money. Never delete data.' }, ...history(),
    { role: 'user', content: 'PR #356; job rea-0a1b3c4d; unfinished: verify Willo; correction: old summary was false.' }];
  const calls = [];
  const out = await routeText({ GROQ_API_KEY: 'g', MISTRAL_API_KEY: 'm', CHE_GROQ_INPUT_CHARS: '60000', CHE_DISABLE_KEYLESS_AI: '1' }, '@cf/x', { messages }, async (url, init) => {
    calls.push({ url: String(url), messages: JSON.parse(init.body).messages });
    if (String(url).includes('groq')) return new Response('payload too large', { status: 413 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Ready.' } }] }));
  });
  assert.ok(out.response || out.choices);
  assert.equal(calls.filter((c) => c.url.includes('groq')).length, 1);
  assert.ok(calls.length >= 2);
  for (const call of calls) assert.deepEqual(call.messages, messages);
});

test('all actual 413 failures terminate with message_too_long, never a truncated retry', async () => {
  resetRouterForTests();
  const input = { messages: [{ role: 'user', content: 'Preserve every character and PR #356.' }] };
  let calls = 0;
  await assert.rejects(routeText({ GROQ_API_KEY: 'g', CHE_DISABLE_KEYLESS_AI: '1' }, '@cf/x', input, async (_url, init) => {
    if (!init?.body) return new Response('{"data":[]}'); // catalogue GET, not a generation retry
    calls++;
    assert.deepEqual(JSON.parse(init.body).messages, input.messages);
    return new Response('too large', { status: 413 });
  }), (error) => error.category === 'message_too_long');
  assert.equal(calls, 1, 'no identical retry, no refresh-loop reattempt');
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
