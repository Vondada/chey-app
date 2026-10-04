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

test('round table: each AI reads the others and CHE writes one conclusion', async () => {
  const { roundTable, speakRoundTable } = await import('./ai_consult.js');
  const prompts = [];
  const env = {
    AI: {
      run: async (_model, input) => {
        const user = input.messages[1].content;
        prompts.push({ system: input.messages[0].content, user, provider: input.che_provider || '' });
        if (/Write the conclusion/.test(input.messages[0].content)) return { response: 'Both agree: cache for five minutes.' };
        return { response: `${input.che_provider} builds on it.` };
      },
    },
  };
  const results = [
    { peer: 'gemini', label: 'Gemini', text: 'Cache for five minutes.' },
    { peer: 'chatgpt', label: 'ChatGPT (OpenAI gpt-oss)', text: 'Cache, but invalidate on writes.' },
  ];
  const table = await roundTable(env, results, 'how long should CHE cache provider health?', 'm');
  assert.equal(table.builds.length, 2);
  const geminiBuild = prompts.find((p) => p.provider === 'gemini');
  assert.match(geminiBuild.user, /invalidate on writes/, 'Gemini sees ChatGPT\'s answer');
  assert.doesNotMatch(geminiBuild.user.split('The other AIs answered:')[1], /Gemini:/, 'an AI is not shown its own answer as another AI');
  assert.equal(table.conclusion, 'Both agree: cache for five minutes.');
  assert.match(speakRoundTable(table), /Together, my conclusion: Both agree/);
});

test('round table needs at least two real answers', async () => {
  const { roundTable } = await import('./ai_consult.js');
  let calls = 0;
  const env = { AI: { run: async () => { calls += 1; return { response: 'x' }; } } };
  assert.equal(await roundTable(env, [{ peer: 'gemini', label: 'Gemini', text: 'only one' }, { peer: 'claude', mailbox: true }], 'q', 'm'), null);
  assert.equal(calls, 0);
});
