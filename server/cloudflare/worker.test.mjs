import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Import the Worker as an ES module without needing an npm install.
const code = readFileSync(new URL('./worker.js', import.meta.url), 'utf8')
  .replace("import { DurableObject } from 'cloudflare:workers';",
    'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }');
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
  assert.equal(stateBeforeJobs.integrations.natural_voice, false);
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
