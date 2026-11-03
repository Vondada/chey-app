// Run 26 (certification 41703244090): Gemini, which now writes most quality-route answers, spelled numbers out in 73 of
// its 178 replies ("You have twenty-six apples", "Three fourths equals zero point seven five"). Nothing in CHE's prompt
// asked for that; the owner reads as well as listens, so the owner-chat policy now asks for digits. Offline.
import assert from 'node:assert/strict';
import test from 'node:test';
import { resetRouterForTests, routeText } from './ai_router.js';

test('the owner-chat policy sent to the quality engine asks for numbers as digits', async () => {
  resetRouterForTests();
  const seen = [];
  const fetcher = async (url, init) => {
    if (String(url).includes('generativelanguage')) {
      seen.push(JSON.parse(init.body).messages);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'You have 26 apples.' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 503 });
  };
  const env = { GEMINI_API_KEY: 'test-key', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'unused' }) } };
  const out = await routeText(env, '@cf/meta/llama-3.1-8b-instruct-fp8', { che_route: 'quality', messages: [{ role: 'user', content: 'I had 3 apples, ate 1 and bought 24. How many now?' }] }, fetcher);
  assert.match(out.engine, /^gemini/);
  const system = seen[0].filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  assert.match(system, /NUMBERS: write numbers[^.]*as digits/);
  assert.match(system, /never spelled out as words/);
});
