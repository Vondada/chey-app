// The $5 GPU test budget on the real picture path: a job is reserved before it is sent, refused past the cap with nothing
// sent, released when Modal refuses it, and settled when its picture is saved. Modal is a fake fetcher; nothing is billed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { finishModalImage, startModalImage, MODAL_IMAGE_REVISION } from './media.js';
import { TEST_BUDGET_KEY, TXT2IMG_WORST_CASE_USD, testBudgetReport } from './gpu_test_budget.js';

const HOST = 'https://vondada--che-gpu.us-east.modal.run';
const ENV_ON = { CHE_MODAL_TXT2IMG: 'enabled', CHE_MODAL_TXT2IMG_MAX: '1000', MODAL_TOKEN: `bearer:${'a'.repeat(40)}@${HOST}`, CHE_AI_BOUND: true };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('IHDR-test-bytes-for-a-picture')]);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

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

function fakeModal({ startStatus = 200, gpuSeconds = 11.2 } = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path });
    if (path === '/txt2img') return new Response(JSON.stringify({ call_id: 'fc-budget000001' }), { status: startStatus, headers: { 'content-type': 'application/json' } });
    if (path === '/txt2img/result') {
      return new Response(JSON.stringify({ ok: true, state: 'done', model: 'stabilityai/sdxl-turbo', model_revision: MODAL_IMAGE_REVISION, width: 256, height: 256, steps: 4, seed: 7, png_base64: PNG.toString('base64'), png_sha256: sha(PNG), gpu: 'Tesla T4', gpu_seconds: gpuSeconds }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  };
  return { calls, fetcher };
}

test('a picture reserves its worst case before it is sent, and the reservation shows in the report', async () => {
  const storage = memoryStorage();
  const { calls, fetcher } = fakeModal();
  const out = await startModalImage(ENV_ON, storage, { prompt: 'a glowing blue cube', width: 256 }, fetcher);
  assert.equal(out.status, 202);
  assert.equal(calls.filter((c) => c.path === '/txt2img').length, 1);
  const report = await testBudgetReport(storage);
  assert.equal(report.reserved_usd, TXT2IMG_WORST_CASE_USD);
  assert.equal(report.jobs[0].state, 'reserved');
});

test('past the $5 cap, a picture is refused with a reason, and Modal is not called', async () => {
  const storage = memoryStorage();
  // Fill the ledger to within less than one worst-case job of the $5 cap.
  const fillers = Array.from({ length: 46 }, (_, i) => ({ id: `f${i}`, label: 'filler', state: 'reserved', max_usd: TXT2IMG_WORST_CASE_USD, actual_usd: null, actual_provenance: null, reserved_at: 0 }));
  await storage.put(TEST_BUDGET_KEY, { cap_usd: 5, jobs: fillers });
  const { calls, fetcher } = fakeModal();
  const out = await startModalImage(ENV_ON, storage, { prompt: 'a glowing blue cube' }, fetcher);
  assert.equal(out.status, 402);
  assert.match(out.detail, /nothing was sent/);
  assert.equal(calls.length, 0, 'Modal was not called');
});

test('Modal refusing the call (4xx) releases the reservation: no cost is kept', async () => {
  const storage = memoryStorage();
  const { fetcher } = fakeModal({ startStatus: 422 });
  const out = await startModalImage(ENV_ON, storage, { prompt: 'a glowing blue cube' }, fetcher);
  assert.equal(out.status, 502);
  const report = await testBudgetReport(storage);
  assert.equal(report.reserved_usd, 0);
  assert.equal(report.spent_usd, 0);
  assert.equal(report.jobs[0].state, 'released');
});

test('a saved picture settles its reservation to the measured seconds plus cold start and idle time', async () => {
  const storage = memoryStorage();
  const { fetcher } = fakeModal({ gpuSeconds: 11.2 });
  const started = await startModalImage(ENV_ON, storage, { prompt: 'a glowing blue cube', width: 256 }, fetcher);
  const saved = await finishModalImage(ENV_ON, storage, started.call_id, fetcher);
  assert.equal(saved.status, 200);
  const report = await testBudgetReport(storage);
  assert.equal(report.reserved_usd, 0);
  assert.equal(report.jobs[0].state, 'settled');
  assert.equal(report.jobs[0].actual_provenance, 'MEASURED_SECONDS_PLUS_OVERHEAD');
  assert.equal(report.jobs[0].actual_usd, 0.011997, '(11.2 s + 60 s cold start + 2 s idle) x $0.59/hr');
  assert.ok(report.spent_usd < TXT2IMG_WORST_CASE_USD, 'the measured job costs less than its worst case');
});

test('a saved picture with no measured seconds keeps the reserved maximum, labelled as such', async () => {
  const storage = memoryStorage();
  const { fetcher } = fakeModal({ gpuSeconds: null });
  const started = await startModalImage(ENV_ON, storage, { prompt: 'a glowing blue cube', width: 256 }, fetcher);
  await finishModalImage(ENV_ON, storage, started.call_id, fetcher);
  const report = await testBudgetReport(storage);
  assert.equal(report.jobs[0].actual_provenance, 'RESERVED_MAXIMUM');
  assert.equal(report.spent_usd, TXT2IMG_WORST_CASE_USD);
});
