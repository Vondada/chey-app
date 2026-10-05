import assert from 'node:assert/strict';
import test from 'node:test';
import { freeOpenRouterModel, thriftyMaxTokens } from './free_engine_policy.js';
import { paidAllowed } from './ai_router.js';

test('OpenRouter stays on the free tier even if a paid model id is configured', () => {
  assert.equal(freeOpenRouterModel('openai/gpt-4.1'), 'openai/gpt-4.1:free');
  assert.equal(freeOpenRouterModel('meta-llama/llama-3.3-70b-instruct:free'), 'meta-llama/llama-3.3-70b-instruct:free');
});

test('owner chat stays short; coding may use more, still capped', () => {
  assert.equal(thriftyMaxTokens({ max_tokens: 4000 }), 420);
  assert.equal(thriftyMaxTokens({ che_capability: 'coding', max_tokens: 4000 }), 1400);
  assert.equal(thriftyMaxTokens({}), 280);
});

test('paid engines stay off unless the owner deliberately opts in', () => {
  assert.equal(paidAllowed({ XAI_API_KEY: 'x' }), false);
  assert.equal(paidAllowed({ CHE_ALLOW_PAID_AI: '1' }), true);
});
