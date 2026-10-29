// The one authorised blue cube render: it starts only with the exact confirm phrase, against an empty reserve, with no earlier
// cube job, and with the budget covering one render. A refused start sends nothing to Modal.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { cubeRefusal, CUBE_CONFIRM, modalCubeProbe, modalCubeResult } from './modal_cube_probe.js';
import { testBudgetReport, TXT2IMG_WORST_CASE_USD } from './gpu_test_budget.js';

const HOST = 'https://vondada--che-gpu.us-east.modal.run';
const ENV_ON = { CHE_MODAL_TXT2IMG: 'enabled', CHE_MODAL_TXT2IMG_MAX: '1000', MODAL_TOKEN: `bearer:${'a'.repeat(40)}@${HOST}`, CHE_AI_BOUND: true };
const OK = { confirm: CUBE_CONFIRM };

function memoryStorage() {
  const map = new Map();
  return {
    get: async (k) => (map.has(k) ? structuredClone(map.get(k)) : undefined),
    put: async (k, v) => { map.set(k, structuredClone(v)); },
    delete: async (k) => { map.delete(k); },
    list: async ({ prefix = '' } = {}) => new Map([...map.entries()].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {}, deleteAlarm: async () => {},
  };
}

function modalRecording(status, body) {
  const sent = [];
  const fetcher = async (url, init) => {
    sent.push({ path: new URL(String(url)).pathname, body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { sent, fetcher };
}

test('no render without the exact confirm phrase, and nothing is sent to Modal', async () => {
  const storage = memoryStorage();
  const { sent, fetcher } = modalRecording(200, { ok: true, call_id: 'fc-should-not-happen' });
  const out = await modalCubeProbe(ENV_ON, storage, { confirm: 'yes' }, fetcher);
  assert.equal(out.sent, false);
  assert.match(out.refusal, /Send confirm "one-blue-cube-256"/);
  assert.equal(sent.length, 0);
});

test('an open reservation refuses the render', async () => {
  const storage = memoryStorage();
  const { reserveTestBudget } = await import('./gpu_test_budget.js');
  await reserveTestBudget(storage, { label: 'earlier job', max_usd: 0.01 });
  const { sent, fetcher } = modalRecording(200, { ok: true, call_id: 'fc-x' });
  const out = await modalCubeProbe(ENV_ON, storage, OK, fetcher);
  assert.equal(out.sent, false);
  assert.match(out.refusal, /still holds/);
  assert.equal(sent.length, 0);
});

test('an earlier blue cube job is refused as a duplicate', () => {
  const report = { reserved_usd: 0, remaining_usd: 4.9, jobs: [{ label: 'picture: a glowing blue cube', state: 'settled' }] };
  assert.match(cubeRefusal(report, OK), /duplicate/);
});

test('a budget below one render is refused', () => {
  const report = { reserved_usd: 0, remaining_usd: TXT2IMG_WORST_CASE_USD / 2, jobs: [] };
  assert.match(cubeRefusal(report, OK), /less than the/);
});

test('with the phrase, an empty reserve and room in the budget, exactly one 256 px render is sent and reserved', async () => {
  const storage = memoryStorage();
  const { sent, fetcher } = modalRecording(200, { ok: true, call_id: 'fc-cube-0001' });
  const out = await modalCubeProbe(ENV_ON, storage, OK, fetcher);
  assert.equal(out.sent, true);
  assert.equal(out.ok, true);
  assert.equal(out.call_id, 'fc-cube-0001');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].path, '/txt2img');
  assert.equal(sent[0].body.prompt, 'a glowing blue cube');
  assert.equal(sent[0].body.width, 256);
  assert.equal(out.budget.reserved_usd, TXT2IMG_WORST_CASE_USD);
});

test('a Modal 422 comes back with its reason, nothing charged, and the cube is not a duplicate on retry', async () => {
  const storage = memoryStorage();
  const refused = await modalCubeProbe(ENV_ON, storage, OK, modalRecording(422, { ok: false, error: 'width and height must be one of [256, 512]' }).fetcher);
  assert.equal(refused.ok, false);
  assert.equal(refused.modal_http_status, 422);
  assert.match(refused.modal_reason, /width and height must be one of \[256, 512\]/);
  assert.equal(refused.budget.reserved_usd, 0);
  assert.equal(refused.budget.spent_usd, 0);
});

test('the result check refuses a call id that is not a blue cube render, and a malformed id', async () => {
  const storage = memoryStorage();
  const bad = await modalCubeResult(ENV_ON, storage, { call_id: '../x' });
  assert.equal(bad.status, 400);
  const unknown = await modalCubeResult(ENV_ON, storage, { call_id: 'fc-unknown-1234' });
  assert.equal(unknown.status, 404);
});

test('the Worker exposes the ledger and the cube render only behind the probe token', () => {
  const source = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
  assert.match(source, /path === '\/api\/probe\/modal\/budget' && request\.method === 'GET'\) return voiceProbeAuthorized\(request, env\)/);
  assert.match(source, /path === '\/api\/probe\/modal\/cube' && request\.method === 'POST'/);
  assert.match(source, /path === '\/api\/probe\/modal\/cube\/result' && request\.method === 'POST'/);
  const guest = source.slice(source.indexOf('export function guestRouteAllowed'), source.indexOf('// The second half of a combined'));
  assert.doesNotMatch(guest, /api\/probe/, 'no probe route is open to a guest profile');
});

test('the ledger report exposes only job facts, never a credential', async () => {
  const report = await testBudgetReport(memoryStorage());
  assert.equal(JSON.stringify(report).includes('bearer'), false);
});
