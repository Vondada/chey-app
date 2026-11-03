// Model selection for owner chat (reasoning_route.js): reasoning a 3B model gets wrong goes to the quality route, everyday
// chat stays fast. Run 24 (41491194768): 48 of 61 wrong answers came from the 3B model on these kinds of question.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { needsReasoning } from './reasoning_route.js';
import { needsStrongEngine } from './personal_recall.js';

const REASONING = [
  // Phrasings not taken from the certification set, one per kind.
  'If every square is a rectangle and this shape is a square, is it a rectangle?',
  'I had 12 dollars, spent 5 and then earned 3 times that. How much do I have now?',
  'A car drives 180 km at 60 km/h. How long does the trip take?',
  'What is 17 * 23?',
  'Write a function that reverses a linked list.',
  'Can you review this SQL query for a bug?',
  'Why is my recursion blowing the stack?',
  'What does HTTP 503 mean?',
  'How do you size a position with a 1% risk per trade?',
  'What is the Sharpe ratio telling me here?',
  'How would you roll back a bad deploy without losing data?',
  'Why do retries need backoff?',
  'Compare a queue and a topic for job delivery.',
  'Is a press release a reliable primary source?',
  'My server crashed halfway. How do you tell which writes landed?',
  // Clock arithmetic (unseen run 41656059143 sent the train question to the 3B model).
  'My flight departs at 9:50 am and takes 3 hours 25 minutes. When do I land?',
  'What time will it be 45 minutes after 11:30?',
  'The meeting runs from 1:15 pm to 3:05 pm. How long is that?',
  'I put the bread in at 4:20 and it needs 1h 50m. When is it done?',
];
const EVERYDAY = [
  'Hi CHE, how are you?', 'Good morning!', 'Can you hear me?', 'Make it shorter.', 'Turn that off.',
  'Set a timer for 10 minutes.', 'Remind me at 5 to call mom.', 'Play my morning playlist.',
  'What is the weather in Austin?', 'Write a poem about rain', 'Tell me a joke about 3 cats.',
  'Tell me a story about a dragon', 'Send an email to Sam saying I will be late.', 'Ok. How are you?',
  'Wake me up at 6:30 am.', 'Set an alarm for 7:15 in 2 hours.', 'What time is it?', 'Remind me at 3pm to stretch for 10 minutes.',
];

test('reasoning questions take the quality route; everyday chat and creative asks stay fast', () => {
  for (const q of REASONING) assert.equal(needsReasoning(q), true, q);
  for (const q of EVERYDAY) assert.equal(needsReasoning(q), false, q);
  // worker.js needsStrongModel reads needsStrongEngine: personal facts still count, creative writing still does not.
  assert.equal(needsStrongEngine('What is my favorite food?'), true);
  assert.equal(needsStrongEngine('How many apples do I have if I buy 2 dozen and eat 1?'), true);
  assert.equal(needsStrongEngine('Write a poem about rain'), false);
});

// Through the real /api/chat with a fake model: the reply model call carries che_route "quality" for a maths question and
// not for a greeting, and the done frame names the route.
const generated = new URL('./.reasoning_route.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;
globalThis.fetch = async () => new Response('{"error":"offline test"}', { status: 503, headers: { 'Content-Type': 'application/json' } });

function storageMap() {
  const saved = new Map();
  return {
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => saved.has(x)).map((x) => [x, structuredClone(saved.get(x))])) : (saved.has(k) ? structuredClone(saved.get(k)) : undefined)),
    put: async (k, v) => { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) saved.set(a, structuredClone(b)); else saved.set(k, structuredClone(v)); },
    delete: async (k) => saved.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...saved].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {}, deleteAlarm: async () => {},
  };
}

test('/api/chat answers a maths question on the quality route and code on the quality route, and a greeting on the fast route', async () => {
  // The router strips CHE's che_* routing fields before the engine call, so the model used and the done frame show the route.
  const calls = [];
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async (model) => { calls.push(model); return { response: 'Sure thing.' }; } } };
  const state = new CheState({ storage: storageMap(), waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const post = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), env);
  const token = (await (await post('/api/pair', { code: '123456' })).json()).device_token;
  const ask = async (message) => {
    const raw = await (await post('/api/chat', { message, history: [] }, token)).text();
    return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((f) => f.type === 'done') || {};
  };
  const maths = await ask('I have 3 apples, eat one, then buy two dozen more. How many do I have?');
  assert.equal(maths.route, 'quality');
  assert.equal(maths.model, '@cf/meta/llama-3.1-8b-instruct-fp8');
  const code = await ask('Write a function that returns the length of the longest increasing subsequence in O(n log n).');
  assert.equal(code.route, 'quality');
  const hello = await ask('Hi CHE, how are you?');
  assert.equal(hello.route, 'fast');
  assert.equal(hello.model, '@cf/meta/llama-3.2-3b-instruct');
});
