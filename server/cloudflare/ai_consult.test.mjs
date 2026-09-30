import test from 'node:test';
import assert from 'node:assert/strict';
import { consultEngine, consultIntent, shareIntent, speakConsult } from './ai_consult.js';

test('owner phrases for talking to other AIs', () => {
  assert.deepEqual(consultIntent('CHE, ask Gemini and ChatGPT what the best voice setup is'), { peers: ['gemini', 'chatgpt'], question: 'what the best voice setup is' });
  assert.deepEqual(consultIntent('talk to Mistral about my launch plan').peers, ['mistral']);
  assert.deepEqual(consultIntent('ask Claude, Gemini and Grok: is this safe?').peers, ['claude', 'gemini', 'grok']);
  assert.equal(consultIntent('ask me later'), null);
  assert.deepEqual(shareIntent('share the Flagstaff link with ChatGPT and Grok').peers, ['chatgpt', 'grok']);
  assert.equal(shareIntent('share this photo with mom'), null);
});

test('consult pins the named free engine and reports honestly', async () => {
  const calls = [];
  const env = { AI: { run: async (_m, input) => {
    calls.push(input.che_provider);
    if (input.che_provider === 'gemini') return { response: 'Use caching.', engine: 'gemini' };
    return { response: 'fallback answer', engine: 'cloudflare' };
  } } };
  const g = await consultEngine(env, 'gemini', 'q', 'm');
  assert.equal(g.text, 'Use caching.');
  const m = await consultEngine(env, 'mistral', 'q', 'm');
  assert.match(m.error, /resting or not connected/);
  const c = await consultEngine(env, 'claude', 'q', 'm');
  assert.equal(c.mailbox, true);
  assert.deepEqual(calls, ['gemini', 'mistral']);
  assert.match(speakConsult([g, m, c]), /Gemini says: Use caching\.[\s\S]*mailbox/);
});
