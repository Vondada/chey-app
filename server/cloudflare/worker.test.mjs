import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Import the Worker as an ES module without needing an npm install.
const code = readFileSync(new URL('./worker.js', import.meta.url), 'utf8')
  .replace("import { DurableObject } from 'cloudflare:workers';",
    'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }')
  .replace("from './agent_runtime.js'", `from '${new URL('./agent_runtime.js', import.meta.url).href}'`)
  .replace("from './plugin_runtime.js'", `from '${new URL('./plugin_runtime.js', import.meta.url).href}'`)
  .replace("from './self_update.js'", `from '${new URL('./self_update.js', import.meta.url).href}'`)
  .replace("from './markets.js'", `from '${new URL('./markets.js', import.meta.url).href}'`);
const { default: worker, CheState } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
);

test('pairing, owner gate, memories, and revocation', async () => {
  const saved = new Map();
  const env = { CHE_PAIR_CODE: '123456', AI: { run: async () => ({ response: 'Hello, sir.' }) } };
  const state = new CheState({ storage: {
    get: (key) => saved.get(key),
    put: (key, value) => saved.set(key, value),
    setAlarm: async () => {},
  } }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, method = 'GET', body = {}, token = '') => worker.fetch(
    new Request(`https://che.example${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    }), env,
  );

  assert.equal((await send('/api/chat', 'POST', { message: 'hi' })).status, 401);
  assert.equal((await send('/api/pair', 'POST', { code: '000000' })).status, 403);
  const token = (await (await send('/api/pair', 'POST', { code: '123456' })).json()).device_token;
  assert.equal(token.length, 96);
  assert.equal((await send('/api/memory/add', 'POST', { memory: 'Likes Sprite' }, token)).status, 200);
  assert.deepEqual((await (await send('/api/state', 'GET', {}, token)).json()).memories, ['Likes Sprite']);
  assert.match(await (await send('/api/chat', 'POST', { message: 'hi' }, token)).text(), /Hello, sir/);
  assert.match(await (await send('/api/chat', 'POST', { message: 'Remember that my favorite pizza is pepperoni' }, token)).text(), /remember/);
  assert.deepEqual((await (await send('/api/state', 'GET', {}, token)).json()).memories,
    ['Likes Sprite', 'my favorite pizza is pepperoni']);
  assert.equal((await send('/api/change/request', 'POST', { request: 'Add a feature to my app' }, token)).status, 503);

  const stateBeforeJobs = await (await send('/api/state', 'GET', {}, token)).json();
  assert.equal(stateBeforeJobs.integrations.background_jobs, true);
  assert.equal(stateBeforeJobs.integrations.natural_voice, true);
  assert.equal(stateBeforeJobs.integrations.quantum_compute, false);

  assert.equal((await send('/api/voice/synthesize', 'POST', { text: 'Hello there' }, token)).status, 503);

  const partnerResponse = await send(
    '/api/team/create',
    'POST',
    { role: 'Research Partner', specialty: 'verification', mission: 'Check facts.' },
    token,
  );
  assert.equal(partnerResponse.status, 200);
  const partner = (await partnerResponse.json()).partner;
  assert.equal(partner.role, 'Research Partner');

  const jobResponse = await send(
    '/api/job/create',
    'POST',
    { title: 'Background test', prompt: 'Work on this in the background.' },
    token,
  );
  assert.equal(jobResponse.status, 200);
  const job = (await jobResponse.json()).job;
  assert.equal(job.status, 'queued');

  await state.alarm();
  const stateAfterJob = await (await send('/api/state', 'GET', {}, token)).json();
  const completedJob = stateAfterJob.jobs.find((item) => item.id === job.id);
  assert.equal(completedJob.status, 'complete');
  assert.match(completedJob.result, /Hello, sir/);

  assert.equal((await send('/api/security/revoke_self', 'POST', {}, token)).status, 200);
  assert.equal((await send('/api/chat', 'POST', { message: 'hi' }, token)).status, 401);
});

test('plugin catalog is paired, opt-in, read-only and never exposes tokens', async () => {
  const saved = new Map();
  let modelPrompt = '';
  const env = {
    CHE_PAIR_CODE: '123456',
    CHE_PLUGIN_WEATHER_TOKEN: 'secret-value',
    CHE_PLUGIN_CATALOG: JSON.stringify([
      { id: 'weather', name: 'Weather', description: 'Current forecast',
        endpoint: 'https://weather.example/query', token_secret: 'CHE_PLUGIN_WEATHER_TOKEN',
        triggers: ['weather', 'forecast'] },
      { id: 'unsafe', name: 'Unsafe', description: 'Bad endpoint',
        endpoint: 'http://localhost/action', triggers: ['unsafe'] },
    ]),
    AI: { run: async (_model, input) => {
      modelPrompt = input.messages[0].content;
      return { response: 'Forecast received.' };
    } },
  };
  const state = new CheState({ storage: {
    get: (key) => saved.get(key),
    put: (key, value) => saved.set(key, value),
    setAlarm: async () => {},
  } }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, method = 'GET', body = {}, token = '') => worker.fetch(
    new Request(`https://che.example${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    }), env,
  );
  assert.equal((await send('/api/plugins')).status, 401);
  const token = (await (await send('/api/pair', 'POST', { code: '123456' })).json()).device_token;
  const list = await (await send('/api/plugins', 'GET', {}, token)).json();
  assert.deepEqual(list.plugins.map((item) => item.id), ['weather']);
  assert.equal(list.plugins[0].enabled, false);
  assert.doesNotMatch(JSON.stringify(list), /secret-value|weather\.example/);
  assert.equal((await send('/api/plugins/toggle', 'POST', { id: 'unsafe', enabled: true }, token)).status, 404);
  assert.equal((await send('/api/plugins/toggle', 'POST', { id: 'weather', enabled: 'yes' }, token)).status, 400);

  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, 'https://weather.example/query');
    assert.equal(options.headers.Authorization, 'Bearer secret-value');
    assert.equal(JSON.parse(options.body).mode, 'read_only');
    return new Response(JSON.stringify({ forecast: 'sunny' }));
  };
  try {
    await send('/api/chat', 'POST', { message: 'weather now' }, token);
    assert.equal(calls, 0);
    assert.equal((await send('/api/plugins/toggle', 'POST',
      { id: 'weather', enabled: true }, token)).status, 200);
    await send('/api/chat', 'POST', { message: 'weather now' }, token);
    assert.equal(calls, 1);
    assert.match(modelPrompt, /sunny/);
    assert.doesNotMatch(modelPrompt, /secret-value/);
    await send('/api/plugins/toggle', 'POST', { id: 'weather', enabled: false }, token);
    await send('/api/chat', 'POST', { message: 'weather now' }, token);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test('ordinary voice turns use the fast model and concise budget', async () => {
  const saved = new Map();
  const runs = [];
  const env = {
    CHE_PAIR_CODE: '123456',
    CHE_FAST_MODEL: 'fast-test',
    CHE_STRONG_MODEL: 'strong-test',
    AI: { run: async (model, input) => {
      runs.push({ model, tokens: input.max_tokens });
      return { response: 'Okay, sir.' };
    } },
  };
  const state = new CheState({ storage: {
    get: (key) => saved.get(key),
    put: (key, value) => saved.set(key, value),
    setAlarm: async () => {},
  } }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  await send('/api/chat', { message: 'Explain this simply' }, token);
  assert.deepEqual(runs.at(-1), { model: 'fast-test', tokens: 360 });
  await send('/api/chat', { message: 'Debug this code' }, token);
  assert.deepEqual(runs.at(-1), { model: 'strong-test', tokens: 1000 });
});

test('agent runtime: roster, delegated tasks, CHE review, War Room and lifecycle', async () => {
  const saved = new Map();
  const calls = [];
  const env = {
    CHE_PAIR_CODE: '123456',
    AI: {
      run: async (model, input) => {
        const system = input.messages[0].content;
        calls.push(system.split('\n')[0]);
        if (system.startsWith('You are CHE reviewing')) return { response: 'APPROVED\nSolid.' };
        if (system.startsWith('You are CHE, chairing')) {
          return { response: '{"decisions":["Ship v1"],"conflicts":["Scope"],"recommendations":["Test"],"final_plan":"1. Nova researches"}' };
        }
        return { response: 'Concrete findings.' };
      },
    },
  };
  // Stored as JSON so every load is a fresh copy, like real Durable Object storage.
  const state = new CheState({ storage: {
    get: async (key) => (saved.has(key) ? JSON.parse(saved.get(key)) : undefined),
    put: async (key, value) => saved.set(key, JSON.stringify(value)),
    setAlarm: async () => {},
  } }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, method = 'GET', body = {}, token = '') => worker.fetch(
    new Request(`https://che.example${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(['POST', 'PATCH'].includes(method) ? { body: JSON.stringify(body) } : {}),
    }), env,
  );
  const token = (await (await send('/api/pair', 'POST', { code: '123456' })).json()).device_token;

  assert.equal((await send('/api/agents')).status, 401);
  const empty = await (await send('/api/agents', 'GET', {}, token)).json();
  assert.deepEqual(empty.agents, []);
  assert.equal(empty.che.status, 'idle');

  const created = await (await send('/api/agents', 'POST', {
    role: 'Research Partner', specialty: 'sources', task: 'Find three competitors',
  }, token)).json();
  const nova = created.agent;
  assert.equal(nova.name, 'Nova');
  assert.equal(nova.status, 'waiting');
  assert.match(nova.color, /^[0-9A-F]{6}$/);
  assert.ok(nova.personality.length > 10);
  assert.equal(created.task.status, 'queued');

  let roster = await (await send('/api/agents', 'GET', {}, token)).json();
  assert.equal(roster.che.status, 'waiting');
  assert.equal(roster.working, 1);

  await state.alarm();
  const detail = await (await send(`/api/agents/${nova.id}`, 'GET', {}, token)).json();
  assert.equal(detail.agent.status, 'done');
  assert.equal(detail.history[0].status, 'complete');
  assert.equal(detail.history[0].verified_by_che, true);
  assert.equal(detail.history[0].result, 'Concrete findings.');
  assert.ok(calls.some((line) => line.startsWith('You are Nova')));

  const upgraded = await (await send(`/api/agents/${nova.id}`, 'PATCH', { action: 'upgrade' }, token)).json();
  assert.equal(upgraded.agent.model_tier, 'strong');
  const reassigned = await (await send(`/api/agents/${nova.id}`, 'PATCH', {
    action: 'reassign', responsibilities: ['Own market research'],
  }, token)).json();
  assert.deepEqual(reassigned.agent.responsibilities, ['Own market research']);
  assert.equal((await send(`/api/agents/${nova.id}`, 'PATCH', { action: 'explode' }, token)).status, 400);
  assert.equal((await send(`/api/agents/${nova.id}/task`, 'POST', {}, token)).status, 400);

  const convened = await (await send('/api/meetings', 'POST', {
    objective: 'Plan the launch of a new pricing tier for my business',
  }, token)).json();
  assert.equal(convened.meeting.status, 'drafting');
  assert.ok(convened.meeting.participants.length >= 2);
  roster = await (await send('/api/agents', 'GET', {}, token)).json();
  assert.equal(roster.che.status, 'meeting');
  assert.ok(roster.agents.every((item) => item.status === 'meeting'));

  await state.alarm();
  const meeting = (await (await send(`/api/meetings/${convened.meeting.id}`, 'GET', {}, token)).json()).meeting;
  assert.equal(meeting.status, 'complete');
  assert.equal(meeting.progress, 1);
  assert.deepEqual(meeting.decisions, ['Ship v1']);
  assert.equal(meeting.final_plan, '1. Nova researches');
  assert.ok(meeting.board.some((item) => item.kind === 'critique' && item.to));
  assert.equal(meeting.board.filter((item) => item.kind === 'draft').length, meeting.participants.length);

  const temp = await (await send('/api/agents', 'POST', {
    role: 'One-off Summarizer', temporary: true, task: 'Summarize the plan',
  }, token)).json();
  await state.alarm();
  roster = await (await send('/api/agents', 'GET', {}, token)).json();
  assert.ok(!roster.agents.some((item) => item.id === temp.agent.id), 'temporary agent retires after its task');

  assert.equal((await (await send(`/api/agents/${nova.id}`, 'PATCH', { action: 'retire' }, token)).json()).retired, nova.id);
  roster = await (await send('/api/agents', 'GET', {}, token)).json();
  assert.ok(!roster.agents.some((item) => item.id === nova.id));
  assert.equal((await send(`/api/agents/${nova.id}`, 'GET', {}, token)).status, 404);
});

test('logs, brain reflect, plugins, markets and self-update routes', async () => {
  const saved = new Map();
  const prompts = [];
  const env = {
    CHE_PAIR_CODE: '123456',
    AI: {
      run: async (model, input) => {
        const system = input.messages[0].content;
        prompts.push(system);
        if (system.startsWith("Decide if ONE of these tools")) {
          return { response: /Tool results so far/.test(system) ? 'NONE' : '{"plugin":"wikipedia","tool":"summary","params":{"title":"Chicago"}}' };
        }
        return { response: 'Chicago is a city in Illinois.' };
      },
    },
  };
  const state = new CheState({ storage: {
    get: async (key) => (saved.has(key) ? JSON.parse(saved.get(key)) : undefined),
    put: async (key, value) => saved.set(key, JSON.stringify(value)),
    delete: async (key) => saved.delete(key),
    setAlarm: async () => {},
  } }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, method = 'GET', body = {}, token = '') => worker.fetch(
    new Request(`https://che.example${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(['POST', 'PATCH'].includes(method) ? { body: JSON.stringify(body) } : {}),
    }), env,
  );
  const token = (await (await send('/api/pair', 'POST', { code: '123456' })).json()).device_token;

  // Cloud conversation logs live under their own keys, not in 'che'.
  for (const text of ['hello', 'second']) {
    assert.equal((await send('/api/logs', 'POST', {
      conversationId: 'c1', title: 'Hi', source: 'voice',
      user: { text, at: '2026-09-28T10:00:00Z' }, che: { text: `re ${text}` },
    }, token)).status, 200);
  }
  const logs = (await (await send('/api/logs', 'GET', {}, token)).json()).logs;
  assert.equal(logs.length, 1);
  assert.equal(logs[0].turns, 2);
  const log = await (await send('/api/logs/c1', 'GET', {}, token)).json();
  assert.equal(log.turns[1].user, 'second');
  assert.equal(log.turns[0].source, 'voice');
  assert.ok(!String(saved.get('che')).includes('re hello'));
  assert.equal((await send('/api/logs', 'POST', {}, token)).status, 400);

  const reflection = await (await send('/api/brain/reflect', 'POST', { prompt: 'Reflect', soul: 'You are CHE.' }, token)).json();
  assert.equal(reflection.text, 'Chicago is a city in Illinois.');

  const manifests = (await (await send('/api/plugins/manifests', 'GET', {}, token)).json()).plugins;
  assert.ok(manifests.some((item) => item.id === 'weather'));

  assert.equal((await send('/api/self-update', 'POST', { summary: 'x', files: [] }, token)).status, 503);
  assert.equal((await send('/api/self-update/rollback', 'POST', {}, token)).status, 503);

  // Chat: brain context and a plugin tool call, with a step line.
  const realFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    if (String(url).startsWith('https://en.wikipedia.org/')) {
      return new Response('{"extract":"Chicago is the third-largest US city."}', { status: 200 });
    }
    if (String(url).includes('stooq') || String(url).includes('coingecko')) return new Response('nope', { status: 503 });
    return new Response('{}', { status: 404 });
  };
  try {
    const wiki = manifests.find((item) => item.id === 'wikipedia');
    const reply = await (await send('/api/chat', 'POST', {
      message: 'Tell me about Chicago',
      brain_context: ['[CHE SOUL] warm and sharp', '[Projects] Launch the pricing tier'],
      plugin_instructions: ['[Plugin: Wikipedia] cite Wikipedia'],
      plugin_tools: wiki.tools.map((t) => ({ ...t, plugin: 'wikipedia', plugin_name: 'Wikipedia', permissions: wiki.permissions })),
    }, token)).text();
    assert.match(reply, /"type":"step","text":"✓ Used Wikipedia · summary"/);
    assert.match(reply, /Chicago is a city/);
    assert.ok(fetched.includes('https://en.wikipedia.org/api/rest_v1/page/summary/Chicago'));
    const chatPrompt = prompts.find((item) => item.startsWith('You are CHE, Cognitive Horizon Engine'));
    assert.match(chatPrompt, /Launch the pricing tier/);
    assert.match(chatPrompt, /third-largest US city/);
    assert.match(chatPrompt, /cite Wikipedia/);
    assert.match(chatPrompt, /che-remember/);

    const markets = await (await send('/api/markets/snapshot', 'GET', {}, token)).json();
    assert.ok(markets.quotes.length >= 3);
    assert.ok(markets.quotes.every((q) => q.status === 'unavailable'));
  } finally {
    globalThis.fetch = realFetch;
  }
});
