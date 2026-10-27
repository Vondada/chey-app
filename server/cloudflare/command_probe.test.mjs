import test from 'node:test';
import assert from 'node:assert/strict';
import { commandCenterProbe } from './command_probe.js';
import { probeObjectName } from './probe_identity.js';

const token = 'controlled-new-token';
const commands = [{ id: 'one' }], categories = [{ id: 'one' }];
const ndjson = (reply, done, extra = []) => new Response([...extra, { type: 'delta', delta: reply }, { type: 'done', ...done }].map(JSON.stringify).join('\n'));

test('existing command checks pair on the current run identity and still verify actual route replies', async () => {
  const names = [], paths = [];
  const isolated = { fetch: async (request) => {
    const path = new URL(request.url).pathname; paths.push(path);
    assert.equal(request.headers.get('X-CHE-Memory-Probe'), token);
    if (path === '/api/pair') return Response.json({ device_token: 'fixture-device' });
    assert.equal(request.headers.get('Authorization'), 'Bearer fixture-device');
    if (path === '/api/commands') return Response.json({ commands, categories });
    if (path === '/api/security/revoke_self') return Response.json({ ok: true });
    const { message } = await request.json();
    if (message === '/lead-scot barbers') return ndjson('Nothing was run.', { source: 'che_command', ok: false, model_calls: 0 });
    if (message === '/trade-journal') return ndjson('Recorded trades only.', { source: 'che_trading', model_calls: 0 });
    if (message === '/trade-execute') return ndjson('Nothing was run.', { source: 'che_command', ok: false, model_calls: 0, command_status: 'setup_required' });
    return ndjson('Suggestions.', {}, [{ type: 'command_suggestions', suggestions: [{ id: 'website-clients' }] }]);
  } };
  const owner = { commandReadiness: async () => ({ available: 1, setup_required: [] }) };
  const env = { CHE_PAIR_CODE: '123456', CHE_STATE: { getByName(name) { names.push(name); return name === 'owner' ? owner : isolated; } } };
  const out = await commandCenterProbe(env, token, { commands, categories });
  assert.equal(names[0], await probeObjectName(token));
  assert.equal(out.ok, true); assert.equal(out.passed, 5);
  assert.ok(paths.includes('/api/security/revoke_self'));
});

test('pairing rejection remains a failure rather than a skipped or fabricated success', async () => {
  const env = { CHE_STATE: { getByName: () => ({ fetch: async () => Response.json({ detail: 'Incorrect pairing code.' }, { status: 403 }) }) } };
  const out = await commandCenterProbe(env, token, { commands, categories });
  assert.equal(out.ok, false); assert.match(out.error, /could not pair/);
});
