import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';

import { callSpecificModel, resetRouterForTests, routeText } from './ai_router.js';
import { isPrivateRequest, privateRequestBody, privateToolBlock } from './private_voice.js';
import { holdPrivateEgress, installEgressGuard, privateEgressHeld } from './security_intelligence.js';

// Every outside engine CHE could use has a key here: a private turn must still reach none of them.
const KEYED_ENV = {
  GROQ_API_KEY: 'gsk-test', GEMINI_API_KEY: 'gem-test', CEREBRAS_API_KEY: 'cb-test', MISTRAL_API_KEY: 'mi-test',
  OPENROUTER_API_KEY: 'or-test', SAMBANOVA_API_KEY: 'sn-test', HF_TOKEN: 'hf-test', GITHUB_MODELS_TOKEN: 'gh-test',
  CHE_OPENAI_API_KEY: 'sk-test', XAI_API_KEY: 'xai-test', ANTHROPIC_API_KEY: 'ant-test', CHE_ALLOW_PAID_AI: '1',
};

const okChat = () => new Response(JSON.stringify({ choices: [{ message: { content: 'outside engine answer' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });

function workersAi(reply = 'Workers AI answer.') {
  const calls = [];
  return { calls, AI: { run: async (model, input) => { calls.push({ model, input }); return typeof reply === 'function' ? reply(model, input) : { response: reply }; } } };
}

test('a private request is recognized from the phone\'s flag only', () => {
  assert.equal(isPrivateRequest({ private: true }), true);
  assert.equal(isPrivateRequest({ client: { private_voice: true } }), true);
  assert.equal(isPrivateRequest({ private: 'true' }), false);
  assert.equal(isPrivateRequest({}), false);
  assert.equal(isPrivateRequest(null), false);
});

test('private turns that need an outside service are refused, saying nothing was sent', () => {
  const cases = [
    ['search the web for the best running shoes', 'web_research'],
    ['research quantum batteries for me', 'web_research'],
    ['what is the latest news today', 'web_research'],
    ['study this page https://example.com', 'web_research'],
    ['ask ChatGPT what it thinks', 'other_ai'],
    ['get a second opinion on this plan', 'other_ai'],
    ['have the crew build it', 'agents'],
    ['make me a video about space', 'media'],
  ];
  for (const [message, kind] of cases) {
    const blocked = privateToolBlock(message, {});
    assert.ok(blocked, message);
    assert.equal(blocked.kind, kind, message);
    assert.match(blocked.text, /Private voice is on/);
    assert.match(blocked.text, /Nothing was sent/);
    assert.match(blocked.text, /turn off private voice/);
  }
  assert.equal(privateToolBlock('see this', { attachment: { name: 'a.png' } }).kind, 'attachment');
  // A capability the phone guessed is cleared, not refused: only the owner's words decide.
  assert.equal(privateToolBlock('Tell me a joke', { requested_capabilities: ['web_research'] }), null);
  for (const plain of ['Tell me a joke', 'How are you today?', 'What should I cook tonight?', 'Remind me what my dog is called']) {
    assert.equal(privateToolBlock(plain, {}), null, plain);
  }
  const cleared = privateRequestBody({ message: 'hi', private: true, requested_capabilities: ['web_research'], plugin_tools: [{ name: 'x' }] });
  assert.deepEqual(cleared.requested_capabilities, []);
  assert.deepEqual(cleared.plugin_tools, []);
  assert.equal(cleared.private, true);
});

test('routeText: a private request uses only Workers AI, never an outside engine', async () => {
  resetRouterForTests();
  const outside = [];
  const fetcher = async (url) => { outside.push(String(url)); return okChat(); };
  const cf = workersAi();
  for (const che_route of [undefined, 'quality']) {
    const answer = await routeText({ ...KEYED_ENV, AI: cf.AI }, '@cf/meta/llama-3.1-8b-instruct-fp8', {
      messages: [{ role: 'user', content: 'Tell me a joke' }], che_private: true, ...(che_route ? { che_route, che_owner_chat: true } : {}),
    }, fetcher, null);
    assert.equal(answer.engine, 'cloudflare');
    assert.equal(answer.private, true);
    assert.equal(answer.response, 'Workers AI answer.');
  }
  assert.deepEqual(outside, [], 'no outside engine or model catalogue was called');
  assert.equal(cf.calls.length, 2);
  // The owner-chat call carries the private note, so the model never claims it searched.
  assert.ok(cf.calls[1].input.messages.some((m) => m.role === 'system' && /PRIVATE VOICE IS ON/.test(m.content)));
  // No che_ routing hint reaches the model.
  assert.ok(Object.keys(cf.calls[0].input).every((k) => !k.startsWith('che_')));
});

test('routeText: a provider model name is swapped for a Workers AI model in private mode', async () => {
  resetRouterForTests();
  const cf = workersAi();
  await routeText({ ...KEYED_ENV, AI: cf.AI }, 'llama-3.3-70b-versatile', { messages: [{ role: 'user', content: 'hi' }], che_private: true }, async () => { throw new Error('no outside call'); }, null);
  assert.match(cf.calls[0].model, /^@cf\//);
});

test('routeText: when Workers AI fails a private turn, CHE says so and still calls no outside engine', async () => {
  resetRouterForTests();
  const outside = [];
  const fetcher = async (url) => { outside.push(String(url)); return okChat(); };
  const failing = { run: async () => { throw new Error('4006: daily free allocation used'); } };
  await assert.rejects(
    routeText({ ...KEYED_ENV, AI: failing }, '@cf/meta/llama-3.2-3b-instruct', { messages: [{ role: 'user', content: 'hi' }], che_private: true, che_route: 'quality' }, fetcher, null),
    (error) => error.private_only === true && /No outside AI was used/.test(error.message),
  );
  const empty = { run: async () => ({ response: '' }) };
  await assert.rejects(
    routeText({ ...KEYED_ENV, AI: empty }, '@cf/meta/llama-3.2-3b-instruct', { messages: [{ role: 'user', content: 'hi' }], che_private: true }, fetcher, null),
    (error) => error.private_only === true,
  );
  await assert.rejects(
    routeText({ ...KEYED_ENV }, '@cf/meta/llama-3.2-3b-instruct', { messages: [{ role: 'user', content: 'hi' }], che_private: true }, fetcher, null),
    (error) => error.private_only === true && /no Workers AI binding/.test(error.message),
  );
  assert.deepEqual(outside, []);
});

test('the private hold forces every model call to Workers AI and closes outbound fetches', async (t) => {
  resetRouterForTests();
  const realFetch = globalThis.fetch;
  const reached = [];
  globalThis.fetch = async (url) => { reached.push(String(url?.url || url)); return okChat(); };
  installEgressGuard();
  t.after(() => { globalThis.fetch = realFetch; while (privateEgressHeld()) holdPrivateEgress(-1); });

  holdPrivateEgress(1);
  assert.equal(privateEgressHeld(), true);
  const cf = workersAi();
  // A call that never asked for privacy (a summary started during the turn) is still kept on Workers AI.
  const answer = await routeText({ ...KEYED_ENV, AI: cf.AI }, '@cf/meta/llama-3.2-3b-instruct', { messages: [{ role: 'user', content: 'summarize' }], che_route: 'quality' }, globalThis.fetch, null);
  assert.equal(answer.engine, 'cloudflare');
  await assert.rejects(globalThis.fetch('https://api.groq.com/openai/v1/chat/completions'), /Private voice is on, so api\.groq\.com was not called/);
  await assert.rejects(globalThis.fetch('https://api.duckduckgo.com/?q=secret'), /Private voice is on/);
  await assert.rejects(callSpecificModel({ ...KEYED_ENV }, 'groq', 'llama', [{ role: 'user', content: 'hi' }]), /outside provider/);
  assert.deepEqual(reached, []);

  holdPrivateEgress(-1);
  assert.equal(privateEgressHeld(), false);
  await globalThis.fetch('https://api.groq.com/openai/v1/models');
  assert.equal(reached.length, 1, 'the guard opens again once the private turn ends');
});

// ─── The real /api/chat route ────────────────────────────────────────────────
const generated = new URL('./.private_voice.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let worker;
try { worker = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }

async function owner(aiRun) {
  const saved = new Map();
  const storage = {
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => saved.has(x)).map((x) => [x, saved.get(x)])) : saved.get(k)),
    put: async (k, v) => { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) saved.set(a, b); else saved.set(k, v); },
    delete: async (k) => saved.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...saved].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
  const background = [];
  const env = { ...KEYED_ENV, CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: aiRun } };
  const state = new worker.CheState({ storage, waitUntil: (p) => { background.push(Promise.resolve(p).catch(() => null)); } }, env);
  env.CHE_STATE = { getByName: () => state };
  const post = (path, body, token = '') => worker.default.fetch(new Request(`https://che.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }), env);
  const token = (await (await post('/api/pair', { code: '123456' })).json()).device_token;
  return {
    background,
    chat: async (body) => {
      const res = await post('/api/chat', body, token);
      const lines = (await res.text()).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
      return { status: res.status, text: lines.filter((e) => e.type === 'delta').map((e) => e.delta).join(''), done: lines.filter((e) => e.type === 'done').pop() || {} };
    },
  };
}

test('/api/chat: a private turn is answered by Workers AI and no outside host is reached', async (t) => {
  resetRouterForTests();
  const realFetch = globalThis.fetch;
  const reached = [];
  globalThis.fetch = async (url) => { reached.push(new URL(String(url?.url || url)).host); return okChat(); };
  t.after(() => { globalThis.fetch = realFetch; });
  const models = [];
  const che = await owner(async (model, input) => { models.push(model); return { response: 'Why did the robot cross the road? To get to the other byte.' }; });

  const reply = await che.chat({ message: 'Tell me a joke', private: true, agent_mode: 'full', history: [], requested_capabilities: ['web_research'] });
  assert.equal(reply.status, 200);
  assert.equal(reply.done.private, true);
  assert.equal(reply.done.private_engine, 'cloudflare-workers-ai');
  assert.ok(models.length >= 1, `Workers AI answered: ${JSON.stringify(reply)}`);
  await Promise.all(che.background);
  const outside = reached.filter((host) => host !== 'che.example');
  assert.deepEqual(outside, [], `no outside host was reached during the private turn: ${outside.join(', ')}`);
  assert.equal(privateEgressHeld(), false, 'the private hold is released after the turn and its background work');
});

test('/api/chat: a private web search is refused before any model or tool runs', async (t) => {
  resetRouterForTests();
  const realFetch = globalThis.fetch;
  const reached = [];
  globalThis.fetch = async (url) => { reached.push(new URL(String(url?.url || url)).host); return okChat(); };
  t.after(() => { globalThis.fetch = realFetch; });
  let modelCalls = 0;
  const che = await owner(async () => { modelCalls += 1; return { response: 'model' }; });

  const reply = await che.chat({ message: 'search the web for the best running shoes', private: true, agent_mode: 'full', history: [] });
  assert.equal(reply.done.source, 'che_private_voice');
  assert.equal(reply.done.private_blocked, 'web_research');
  assert.match(reply.text, /Private voice is on/);
  assert.match(reply.text, /Nothing was sent/);
  assert.equal(modelCalls, 0);
  await Promise.all(che.background);
  assert.deepEqual(reached.filter((host) => host !== 'che.example'), []);

  const ask = await che.chat({ message: 'ask Grok what it thinks about my plan', private: true, history: [] });
  assert.equal(ask.done.private_blocked, 'other_ai');
});
