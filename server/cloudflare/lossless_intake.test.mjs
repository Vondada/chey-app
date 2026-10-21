// Issue #345, first step: the owner's whole sentence reaches CHE. A late "don't", a date or a
// correction at the end of a long message is never silently cut on the way in or on the way to
// a model; a message too long to take is refused whole, saying so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fitToBudget, resetRouterForTests, routeText } from './ai_router.js';
import { interpretWithModel } from './speech_intent.js';

const LATE_NO = ' Actually, do not buy anything yet; only make the list.';

test('no turn or system rule is cut to fit a smaller engine', () => {
  const newest = 'Plan my Walmart trip tomorrow: ' + 'apples, '.repeat(700) + LATE_NO;
  const input = { messages: [
    { role: 'system', content: 'IDENTITY: You are CHE. ' + 'rule '.repeat(4000) },
    ...Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ` + 'x'.repeat(3000) })),
    { role: 'user', content: newest },
  ] };
  const out = fitToBudget(input, 16000);
  assert.equal(out.oversize, true);
  assert.equal(out.messages.at(-1).content, newest, 'the whole newest turn, with its last words');
  assert.deepEqual(out.messages, input.messages);
  const tooBig = fitToBudget({ messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: newest }] }, 4000);
  assert.equal(tooBig.oversize, true, 'too long for this engine: marked, not cut');
  assert.equal(tooBig.messages.at(-1).content, newest);
});

test('an engine too small for the newest turn is skipped; a larger one gets every word', async () => {
  resetRouterForTests();
  const sent = [];
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ url: String(url), last: String(body.messages.at(-1).content) });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Understood, sir: a list only, nothing bought.' } }] }), { status: 200 });
  };
  const newest = 'Here is my grocery plan. ' + 'I need apples and pears. '.repeat(400) + LATE_NO;
  assert.ok(newest.length > 8000 && newest.length < 59000);
  const out = await routeText({ GROQ_API_KEY: 'g', MISTRAL_API_KEY: 'm', CHE_DISABLE_KEYLESS_AI: '1' }, '@cf/x', {
    che_provider: 'groq',
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: newest }],
  }, fetcher);
  assert.notEqual(out.engine, 'groq');
  assert.ok(sent.length >= 1 && sent.every((s) => !s.url.includes('groq')), 'the 8,000-character engine was never sent a cut message');
  assert.ok(sent[0].last.endsWith(LATE_NO), 'the late "do not buy" arrived');
});

test('the reading model is not asked to read a long turn it would only see the start of', async () => {
  let asked = 0;
  const long = 'Book the dentist for Tuesday and call Mike about the contract. '.repeat(10) + 'But not today.';
  assert.ok(long.length > 600);
  assert.equal(await interpretWithModel({ runText: async () => { asked += 1; return '{}'; }, text: long }), null);
  assert.equal(asked, 0);
});
