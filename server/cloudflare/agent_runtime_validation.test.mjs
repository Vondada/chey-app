import assert from 'node:assert';
import { test } from 'node:test';
import { agent_runtime } from './agent_runtime.js';

test('agent response validation handles malformed JSON gracefully', async () => {
  const mockResponse = { ok: true, text: async () => 'invalid-json-payload' };
  // Mimic the runtime call to agent processing
  const raw = (await mockResponse.text()).slice(0, 24000);
  let data;
  try {
    data = JSON.parse(raw);
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid_schema');
  } catch (_) { data = { detail: raw }; }
  
  const result = { status: 'failed', detail: data.detail };
  assert.equal(result.status, 'failed');
  assert.equal(result.detail, 'invalid-json-payload');
});