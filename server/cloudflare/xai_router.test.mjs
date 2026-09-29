import assert from 'node:assert/strict';
import test from 'node:test';

import { resetRouterForTests, routeText } from './ai_router.js';

test('quality routing can use Grok 4.7 when xAI is connected', async () => {
  resetRouterForTests();
  const calls = [];
  const env = { XAI_API_KEY: 'xai-test' };
  const result = await routeText(
    env,
    '@cf/meta/llama-3.1-8b-instruct-fp8',
    {
      che_route: 'quality',
      messages: [{ role: 'user', content: 'Plan this difficult end-to-end task.' }],
      max_tokens: 900,
    },
    async (url, init) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Grok-assisted result.' } }],
        usage: { total_tokens: 123 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  );
  assert.equal(result.engine, 'xai');
  assert.equal(result.response, 'Grok-assisted result.');
  assert.equal(calls[0].url, 'https://api.x.ai/v1/chat/completions');
  assert.equal(calls[0].headers.Authorization, 'Bearer xai-test');
  assert.equal(calls[0].body.model, 'grok-4.7');
});
