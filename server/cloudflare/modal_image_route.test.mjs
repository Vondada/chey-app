// The explicit Modal picture route: off by default, capped, never a fallback, and a picture is saved to the Gallery only
// after its bytes and hash check out. Modal is a fake fetcher; no GPU runs and nothing is billed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { finishModalImage, modalImageCheckTimes, pendingModalImages, reconcileModalImages, listMedia, MODAL_IMAGE_KEY, MODAL_IMAGE_REVISION, MODAL_IMAGE_TIMEOUT_MS, readBlob, startModalImage, generateImage } from './media.js';

const HOST = 'https://vondada--che-gpu.us-east.modal.run';
const ENV_ON = { CHE_MODAL_TXT2IMG: 'enabled', MODAL_TOKEN: `bearer:${'a'.repeat(40)}@${HOST}`, CHE_AI_BOUND: true };
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

// A Modal stand-in: /txt2img starts a call; /txt2img/result answers with `result`.
function fakeModal({ start = { call_id: 'fc-abcdef123456' }, startStatus = 200, result = null } = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, host: new URL(String(url)).host, body: init?.body ? JSON.parse(init.body) : null });
    if (path === '/txt2img') return new Response(JSON.stringify(start), { status: startStatus, headers: { 'content-type': 'application/json' } });
    if (path === '/txt2img/result') return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('{}', { status: 404 });
  };
  return { calls, fetcher };
}
const doneResult = (overrides = {}) => ({
  ok: true, state: 'done', model: 'stabilityai/sdxl-turbo', model_revision: MODAL_IMAGE_REVISION, width: 512, height: 512, steps: 4, seed: 7,
  png_base64: PNG.toString('base64'), png_sha256: sha(PNG), gpu: 'Tesla T4', gpu_seconds: 11.2, ...overrides,
});
let aiCalls = 0;
const ai = { run: async () => { aiCalls += 1; return { image: PNG.toString('base64') }; } };

test('off by default: an explicit Modal picture is refused, nothing is started, no other engine runs', async () => {
  aiCalls = 0;
  const { calls, fetcher } = fakeModal();
  const storage = memoryStorage();
  const out = await generateImage({ AI: ai, MODAL_TOKEN: ENV_ON.MODAL_TOKEN }, storage, { prompt: 'a red kite', provider: 'modal' }, fetcher);
  assert.equal(out.status, 503);
  assert.equal(out.provider_used, null);
  assert.equal(calls.length, 0, 'Modal is not called');
  assert.equal(aiCalls, 0, 'Workers AI is not called');
  assert.equal((await listMedia(storage)).length, 0);
});

test('on: an explicit Modal request starts one GPU call with validated arguments and returns its call id', async () => {
  const { calls, fetcher } = fakeModal();
  const storage = memoryStorage();
  const out = await startModalImage(ENV_ON, storage, { prompt: 'a red kite over a field' }, fetcher);
  assert.equal(out.status, 202);
  assert.equal(out.call_id, 'fc-abcdef123456');
  assert.equal(out.provider_used, 'modal');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/txt2img');
  assert.equal(calls[0].host, 'vondada--che-gpu.us-east.modal.run');
  assert.deepEqual({ ...calls[0].body, seed: undefined }, { prompt: 'a red kite over a field', width: 512, height: 512, steps: 4, seed: undefined });
  assert.equal(aiCalls, 0, 'no other engine ran');
});

test('a 256 px picture is sent as 256 px; an unsupported size is sent as the 512 px default', async () => {
  const { calls, fetcher } = fakeModal();
  await startModalImage(ENV_ON, memoryStorage(), { prompt: 'a kite', width: 256, height: 256 }, fetcher);
  assert.equal(calls[0].body.width, 256);
  assert.equal(calls[0].body.height, 256);
  const other = fakeModal();
  await startModalImage(ENV_ON, memoryStorage(), { prompt: 'a kite', width: 384 }, other.fetcher);
  assert.equal(other.calls[0].body.width, 512);
});

test('the cap: a second GPU call beyond the cap is refused and not sent', async () => {
  const { calls, fetcher } = fakeModal();
  const storage = memoryStorage();
  await startModalImage(ENV_ON, storage, { prompt: 'first' }, fetcher);
  const second = await startModalImage(ENV_ON, storage, { prompt: 'second' }, fetcher);
  assert.equal(second.status, 429);
  assert.match(second.detail, /cap is 1 call/);
  assert.equal(calls.length, 1, 'only one call reached Modal');
});

test('a refused start is reported with Modal\'s status, nothing is saved, and no other engine runs', async () => {
  aiCalls = 0;
  const { fetcher } = fakeModal({ startStatus: 500, start: { ok: false } });
  const storage = memoryStorage();
  const out = await generateImage({ AI: ai, MODAL_TOKEN: ENV_ON.MODAL_TOKEN, CHE_MODAL_TXT2IMG: 'enabled' }, storage, { prompt: 'a red kite', provider: 'modal' }, fetcher);
  assert.equal(out.status, 502);
  assert.match(out.detail, /Modal refused to start the picture \(500\)/);
  assert.equal(aiCalls, 0);
  assert.equal((await listMedia(storage)).length, 0);
});

test('a running call is not saved yet; its state is reported', async () => {
  const { fetcher } = fakeModal({ result: { ok: true, state: 'running' } });
  const storage = memoryStorage();
  await startModalImage(ENV_ON, storage, { prompt: 'a kite' }, fetcher);
  const out = await finishModalImage(ENV_ON, storage, 'fc-abcdef123456', fetcher);
  assert.equal(out.status, 202);
  assert.equal(out.state, 'running');
  assert.equal((await listMedia(storage)).length, 0);
});

test('a missed Modal answer is retryable (503) and does not fail the picture', async () => {
  const storage = memoryStorage();
  const down = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/txt2img') return new Response(JSON.stringify({ call_id: 'fc-abcdef123456' }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('busy', { status: 500 });
  };
  await startModalImage(ENV_ON, storage, { prompt: 'a kite' }, down);
  const out = await finishModalImage(ENV_ON, storage, 'fc-abcdef123456', down);
  assert.equal(out.status, 503);
  assert.equal((await storage.get(MODAL_IMAGE_KEY))[0].state, 'started');
});

test('a call still running after the timeout fails with a reason, and nothing is saved', async () => {
  const { fetcher } = fakeModal({ result: { ok: true, state: 'running' } });
  const storage = memoryStorage();
  await startModalImage(ENV_ON, storage, { prompt: 'a kite' }, fetcher);
  const records = await storage.get(MODAL_IMAGE_KEY);
  records[0].created_at = new Date(Date.now() - MODAL_IMAGE_TIMEOUT_MS - 60000).toISOString();
  await storage.put(MODAL_IMAGE_KEY, records);
  const out = await finishModalImage(ENV_ON, storage, 'fc-abcdef123456', fetcher);
  assert.equal(out.status, 502);
  assert.match(out.detail, /did not finish in time/);
  assert.equal((await listMedia(storage)).length, 0);
  assert.equal((await storage.get(MODAL_IMAGE_KEY))[0].state, 'failed');
});

test('a finished picture is saved to the Gallery with its receipt, and reopens with the same bytes', async () => {
  const { fetcher } = fakeModal({ result: doneResult() });
  const storage = memoryStorage();
  await startModalImage(ENV_ON, storage, { prompt: 'a red kite over a field' }, fetcher);
  const out = await finishModalImage(ENV_ON, storage, 'fc-abcdef123456', fetcher);
  assert.equal(out.status, 200);
  const items = await listMedia(storage);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, out.item.id);
  assert.equal(items[0].provider, 'modal');
  assert.equal(items[0].mime_type, 'image/png');
  assert.equal(items[0].receipt.execution_id, 'fc-abcdef123456');
  assert.equal(items[0].receipt.model_revision, MODAL_IMAGE_REVISION);
  assert.equal(items[0].receipt.png_sha256, sha(PNG));
  const reopened = await readBlob(ENV_ON, storage, items[0]);
  assert.equal(Buffer.compare(Buffer.from(reopened), PNG), 0, 'the Gallery returns the same bytes');
});

test('asking again for a saved picture returns the same item, with no second save', async () => {
  const { fetcher } = fakeModal({ result: doneResult() });
  const storage = memoryStorage();
  await startModalImage(ENV_ON, storage, { prompt: 'a kite' }, fetcher);
  const first = await finishModalImage(ENV_ON, storage, 'fc-abcdef123456', fetcher);
  const again = await finishModalImage(ENV_ON, storage, 'fc-abcdef123456', fetcher);
  assert.equal(again.item.id, first.item.id);
  assert.equal((await listMedia(storage)).length, 1);
});

test('image validation: a picture whose hash does not match is refused and nothing is saved', async () => {
  const { fetcher } = fakeModal({ result: doneResult({ png_sha256: 'f'.repeat(64) }) });
  const storage = memoryStorage();
  await startModalImage(ENV_ON, storage, { prompt: 'a kite' }, fetcher);
  const out = await finishModalImage(ENV_ON, storage, 'fc-abcdef123456', fetcher);
  assert.equal(out.status, 502);
  assert.match(out.detail, /failed its hash check/);
  assert.equal((await listMedia(storage)).length, 0);
});

test('image validation: bytes that are not a PNG are refused and nothing is saved', async () => {
  const notPng = Buffer.from('<html>not a picture</html>');
  const { fetcher } = fakeModal({ result: doneResult({ png_base64: notPng.toString('base64'), png_sha256: sha(notPng) }) });
  const storage = memoryStorage();
  await startModalImage(ENV_ON, storage, { prompt: 'a kite' }, fetcher);
  const out = await finishModalImage(ENV_ON, storage, 'fc-abcdef123456', fetcher);
  assert.equal(out.status, 502);
  assert.match(out.detail, /not a PNG/);
  assert.equal((await listMedia(storage)).length, 0);
});

test('a picture from another model revision is refused', async () => {
  const { fetcher } = fakeModal({ result: doneResult({ model_revision: 'b'.repeat(40) }) });
  const storage = memoryStorage();
  await startModalImage(ENV_ON, storage, { prompt: 'a kite' }, fetcher);
  const out = await finishModalImage(ENV_ON, storage, 'fc-abcdef123456', fetcher);
  assert.equal(out.status, 502);
  assert.match(out.detail, /model revision CHE did not ask for/);
});

test('a failed Modal call is reported with its reason, never replaced by another engine', async () => {
  aiCalls = 0;
  const { fetcher } = fakeModal({ result: { ok: true, state: 'failed', error: 'CUDA out of memory' } });
  const storage = memoryStorage();
  await startModalImage(ENV_ON, storage, { prompt: 'a kite' }, fetcher);
  const out = await finishModalImage(ENV_ON, storage, 'fc-abcdef123456', fetcher);
  assert.equal(out.status, 502);
  assert.match(out.detail, /CUDA out of memory/);
  assert.match(out.detail, /no other engine was used/);
  assert.equal(aiCalls, 0);
  assert.equal((await listMedia(storage)).length, 0);
});

test('an unknown call id is not found', async () => {
  const out = await finishModalImage(ENV_ON, memoryStorage(), 'fc-nope0000000', fakeModal().fetcher);
  assert.equal(out.status, 404);
});

test('Modal not connected: refused with nothing started', async () => {
  const { calls, fetcher } = fakeModal();
  const out = await startModalImage({ CHE_MODAL_TXT2IMG: 'enabled' }, memoryStorage(), { prompt: 'a kite' }, fetcher);
  assert.equal(out.status, 503);
  assert.equal(calls.length, 0);
});

test('the Modal call index keeps no secret: only call ids, prompts and states are stored', async () => {
  const { fetcher } = fakeModal({ result: doneResult() });
  const storage = memoryStorage();
  await startModalImage(ENV_ON, storage, { prompt: 'a kite' }, fetcher);
  const stored = JSON.stringify(await storage.get(MODAL_IMAGE_KEY));
  assert.doesNotMatch(stored, /bearer|aaaaaaaa|modal\.run/i);
});

test('after the app was closed, the pending Modal pictures are listed again; saved and failed ones are not', async () => {
  const storage = memoryStorage();
  await storage.put(MODAL_IMAGE_KEY, [
    { call_id: 'fc-running0001', title: 'a kite', state: 'started', created_at: '2026-10-28T20:00:00.000Z' },
    { call_id: 'fc-saved000001', title: 'a boat', state: 'saved', item: {} },
    { call_id: 'fc-failed000001', title: 'a car', state: 'failed', error: 'x' },
  ]);
  const jobs = await pendingModalImages(storage);
  assert.deepEqual(jobs.map((j) => j.call_id), ['fc-running0001']);
  assert.deepEqual(Object.keys(jobs[0]).sort(), ['call_id', 'created_at', 'title']);
});

test('a terminal failure from Modal (HTTP 502, state failed) is recorded with its reason, not treated as a missed answer', async () => {
  const storage = memoryStorage();
  const failing = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/txt2img') return new Response(JSON.stringify({ call_id: 'fc-abcdef123456' }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ ok: false, state: 'failed', error: 'CUDA out of memory' }), { status: 502, headers: { 'content-type': 'application/json' } });
  };
  await startModalImage(ENV_ON, storage, { prompt: 'a kite' }, failing);
  const out = await finishModalImage(ENV_ON, storage, 'fc-abcdef123456', failing);
  assert.equal(out.status, 502);
  assert.match(out.detail, /CUDA out of memory/);
  assert.equal((await storage.get(MODAL_IMAGE_KEY))[0].state, 'failed');
  assert.equal((await listMedia(storage)).length, 0);
});

test('the alarm saves a finished picture even when no app is polling for it', async () => {
  const { fetcher } = fakeModal({ result: doneResult() });
  const storage = memoryStorage();
  await startModalImage(ENV_ON, storage, { prompt: 'a kite' }, fetcher);
  await reconcileModalImages(ENV_ON, storage, fetcher);
  const items = await listMedia(storage);
  assert.equal(items.length, 1);
  assert.equal((await storage.get(MODAL_IMAGE_KEY))[0].state, 'saved');
});

test('the alarm fails a picture past its timeout even when Modal cannot be reached', async () => {
  const storage = memoryStorage();
  const down = async () => new Response('busy', { status: 500 });
  await storage.put(MODAL_IMAGE_KEY, [{ call_id: 'fc-abcdef123456', title: 'a kite', prompt: 'a kite', state: 'started', created_at: new Date(Date.now() - MODAL_IMAGE_TIMEOUT_MS - 60000).toISOString() }]);
  await reconcileModalImages(ENV_ON, storage, down);
  const job = (await storage.get(MODAL_IMAGE_KEY))[0];
  assert.equal(job.state, 'failed');
  assert.match(job.error, /did not finish in time/);
});

test('the alarm is woken only while a picture waits', async () => {
  const storage = memoryStorage();
  assert.deepEqual(await modalImageCheckTimes(storage), []);
  await storage.put(MODAL_IMAGE_KEY, [{ call_id: 'fc-abcdef123456', title: 't', state: 'started', created_at: new Date().toISOString() }]);
  assert.equal((await modalImageCheckTimes(storage)).length, 1);
});

// A Modal call that started and then ended in failure (Modal's own failed state) has a reservation in the $5 test budget.
// Its money is not released (the call ran), so the reservation must be settled, not left open for ever.
test('a picture Modal reports failed settles its budget reservation instead of leaving it open', async () => {
  const { TEST_BUDGET_KEY, budgetTotals } = await import('./gpu_test_budget.js');
  const failing = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/txt2img') return new Response(JSON.stringify({ call_id: 'fc-abcdef123456' }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ ok: false, state: 'failed', error: 'CUDA out of memory' }), { status: 502, headers: { 'content-type': 'application/json' } });
  };
  const storage = memoryStorage();
  await startModalImage(ENV_ON, storage, { prompt: 'a kite' }, failing);
  await finishModalImage(ENV_ON, storage, 'fc-abcdef123456', failing);
  const ledger = await storage.get(TEST_BUDGET_KEY);
  assert.equal(ledger.jobs.length, 1);
  assert.notEqual(ledger.jobs[0].state, 'reserved', 'the reservation for a started call is still open');
  assert.equal(budgetTotals(ledger).reserved_usd, 0);
});
