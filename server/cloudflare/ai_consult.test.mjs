import test from 'node:test';
import assert from 'node:assert/strict';
import { consultEngine, consultIntent, shareIntent, speakConsult } from './ai_consult.js';

test('owner phrases for talking to other AIs', () => {
  assert.deepEqual(consultIntent('CHE, ask Gemini and ChatGPT what the best voice setup is'), { peers: ['gemini', 'chatgpt'], question: 'what the best voice setup is' });
  assert.deepEqual(consultIntent('talk to Mistral about my launch plan').peers, ['mistral']);
  assert.deepEqual(consultIntent('ask Claude, Gemini and Grok: is this safe?').peers, ['claude', 'gemini', 'grok']);
  assert.equal(consultIntent('ask me later'), null);
  assert.deepEqual(consultIntent('Ask chagpt and Claude and grok how to stop you from lagging').peers, ['chatgpt', 'claude', 'grok']);
  assert.deepEqual(consultIntent('ask chat gpt about voices').peers, ['chatgpt']);
  assert.deepEqual(consultIntent('Ask ChatGPT rock and Claude how to code yourself into fix').peers, ['chatgpt', 'grok', 'claude']);
  assert.equal(consultIntent('ask Gemini how rock music started').question, 'how rock music started');
  assert.deepEqual(shareIntent('share the Flagstaff link with ChatGPT and Grok').peers, ['chatgpt', 'grok']);
  assert.equal(shareIntent('share this photo with mom'), null);
});

test('consult pins the named engine, falls back honestly, and never comes back empty', async () => {
  const calls = [];
  const env = { AI: { run: async (_m, input) => {
    calls.push(input.che_provider || (input.che_emergency ? 'any' : ''));
    if (input.che_provider === 'gemini') return { response: 'Use caching.', engine: 'gemini' };
    if (input.che_provider === 'groq') return { response: 'Trim prompts.', engine: 'groq' };
    if (input.che_emergency) return { response: 'fallback answer', engine: 'groq' };
    throw new Error('down');
  } } };
  const g = await consultEngine(env, 'gemini', 'q', 'm');
  assert.equal(g.text, 'Use caching.');
  const gpt = await consultEngine(env, 'chatgpt', 'q', 'm');
  assert.equal(gpt.engine, 'groq');
  const m = await consultEngine(env, 'mistral', 'q', 'm');
  assert.equal(m.substitute, true);
  const c = await consultEngine(env, 'claude', 'q', 'm');
  assert.equal(c.mailbox, true);
  assert.match(speakConsult([g, m, c]), /Gemini says: Use caching\.[\s\S]*unreachable right now, so groq answered[\s\S]*mailbox/);
});
