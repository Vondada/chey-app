// The owner's chat is sampled at a low, configurable temperature so the same question gets the same answer from run to
// run (five fresh certification runs scored 409-435 on one commit; the changing questions were model replies).
import test from 'node:test';
import assert from 'node:assert/strict';
import { routeText, resetRouterForTests } from './ai_router.js';

const env = (extra = {}) => ({ GROQ_API_KEY: 'g', CHE_DISABLE_KEYLESS_AI: '1', ...extra });
const answer = { choices: [{ message: { content: 'Paris, sir.' } }] };
async function bodySent(e, input) {
  resetRouterForTests?.();
  let sent = null;
  await routeText(e, '@cf/x', input, async (_url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, status: 200, headers: new Headers(), json: async () => answer };
  });
  return sent;
}
const messages = [{ role: 'user', content: 'What is the capital of France?' }];

test('an owner chat turn is sent with temperature 0.3 by default', async () => {
  assert.equal((await bodySent(env(), { messages, che_owner_chat: true })).temperature, 0.3);
  assert.equal((await bodySent(env(), { messages, che_route: 'quality' })).temperature, 0.3);
});

test("CHE_CHAT_TEMPERATURE sets it; a caller's own temperature and other pipelines are left alone", async () => {
  assert.equal((await bodySent(env({ CHE_CHAT_TEMPERATURE: '0' }), { messages, che_owner_chat: true })).temperature, 0);
  assert.equal((await bodySent(env(), { messages, che_owner_chat: true, temperature: 0.9 })).temperature, 0.9);
  assert.equal('temperature' in (await bodySent(env(), { messages })), false, 'an internal pipeline keeps the engine default');
  assert.equal('temperature' in (await bodySent(env({ CHE_CHAT_TEMPERATURE: 'warm' }), { messages, che_owner_chat: true })), false, 'an invalid setting is ignored');
});
