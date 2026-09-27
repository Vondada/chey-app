import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Import the Worker as an ES module without needing an npm install.
const code = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
const { default: worker, CheState } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
);

test('pairing, owner gate, memories, and revocation', async () => {
  const saved = new Map();
  const env = { CHE_PAIR_CODE: '123456', AI: { run: async () => ({ response: 'Hello, sir.' }) } };
  const state = new CheState({ storage: {
    get: (key) => saved.get(key), put: (key, value) => saved.set(key, value),
  } }, env);
  env.CHE_STATE = { idFromName: () => 'owner', get: () => state };
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
  assert.equal((await send('/api/change/request', 'POST', { request: 'Add a feature to my app' }, token)).status, 503);
  assert.equal((await send('/api/security/revoke_self', 'POST', {}, token)).status, 200);
  assert.equal((await send('/api/chat', 'POST', { message: 'hi' }, token)).status, 401);
});
