// Modal GPU provider (modal_gpu.js + compute_pool.js + service_onboarding.js), owner spec
// docs/CHE_MODAL_FREE_FIRST_USAGE_PRIVACY.md acceptance tests 1-5, against a fake Modal app (no network, no money):
// 1. no credentials: NOT CONNECTED, zero calls to Modal, zero cost;
// 2. a Proxy Auth Token is "Connected" only after an authenticated /health with the expected version; 401 = rejected;
//    no app = run the deploy workflow; a format-only key is never Connected;
// 3. credit unknown or CHE's estimate at the stop line: the GPU job waits for approval and nothing is dispatched;
// 4. a simulated cube render on Modal: receipt, artifact SHA-256 re-checked from the media store, state survives a
//    Durable Object restart, and the per-job ledger entry the Usage Center reads;
// 5. failover never bills twice for one idempotency key; the worker error is visible.
import assert from 'node:assert/strict';
import test from 'node:test';
import { GpuQueue, gpuWorkerRoute } from './gpu_queue.js';
import { ensureCapacity } from './creation_orchestrator.js';
import { budgetCommand, loadPool, modalCommand, poolView, savePool, selectProvider, POOL_PROVIDERS } from './compute_pool.js';
import { storeSecret, verifyOnboarding } from './service_onboarding.js';
import { cloudIntent } from './cloud_computer.js';
import {
  MODAL_APP_VERSION, MODAL_RESERVE_MS, MODAL_USD_HR, callCostUsd, computeUsageLedger, creditStopUsd, modalIntent, modalStateOf, parseModalCredential,
} from './modal_gpu.js';

const offline = async (input) => { throw new TypeError(`fetch failed (offline test: ${new URL(String(input?.url || input)).host})`); };
globalThis.fetch = offline;

const T0 = Date.parse('2026-10-25T12:00:00Z');
const HOST = 'ownerws--che-gpu.modal.run';
const KEY_ID = 'wk-TestTokenId123456';
const SECRET = 'ws-TestTokenSecret987654321';
const CRED = `${KEY_ID}:${SECRET}@https://${HOST}`;
const GPU = 'Tesla T4, 550.54.15, 15360 MiB';
const GPU_DEV = "DEVICE OPTIX ['Tesla T4'] 384x480";
const RUNPOD_KEY = 'rpa_TESTSECRETKEY0123456789abcdef';

function memStorage() {
  const m = new Map();
  return { m, get: async (k) => structuredClone(m.get(k)), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async (k) => m.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...m].filter(([k]) => k.startsWith(prefix))) };
}
function bucket() {
  const files = new Map();
  return { files, put: async (k, bytes, o) => { files.set(k, { bytes: new Uint8Array(bytes), o }); }, get: async (k) => { const f = files.get(k); return f ? { arrayBuffer: async () => f.bytes.buffer.slice(0), httpMetadata: f.o?.httpMetadata, size: f.bytes.length } : null; },
    head: async (k) => (files.has(k) ? { size: files.get(k).bytes.length } : null), delete: async (k) => files.delete(k) };
}
function setup() {
  let t = T0;
  const storage = memStorage(); const now = () => t;
  storage.m.set('gpu:seeded', 'test'); storage.m.set('gpu:jobs', []);
  const env = { CHE_DATA_BUCKET: bucket() };
  return { storage, now, env, q: new GpuQueue(storage, now), advance: (ms) => { t += ms; }, t: () => t };
}
const cube = (over = {}) => ({ kind: 'object_model', title: 'Cube', views: [0], settings: { OBJECT: 'cube' }, priority: 'high', requires: { gpu: 'required' }, ...over });
function glb() {
  const jsonText = JSON.stringify({ asset: { version: '2.0' }, meshes: [{ name: 'Cube' }] }); const padded = jsonText + ' '.repeat((4 - (jsonText.length % 4)) % 4);
  const total = 20 + padded.length; const b = new Uint8Array(total); const dv = new DataView(b.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true); dv.setUint32(12, padded.length, true); dv.setUint32(16, 0x4e4f534a, true);
  b.set(new TextEncoder().encode(padded), 20); return b;
}
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/**
 * A fake of CHE's Modal app (tools/modal/che_modal_app.py): proxy auth, /health, /blender_preview with per-key
 * de-duplication, /status, /cancel. `log` records every request (no secret values are asserted out of it).
 */
function fakeModal({ deployed = true, version = MODAL_APP_VERSION, id = KEY_ID, secret = SECRET } = {}) {
  const calls = new Map(); const log = []; let spawns = 0;
  const ctl = { dropNextPostReply: false, statusDown: false, cancelDown: false };
  const fetcher = async (url, init = {}) => {
    const u = new URL(String(url)); const method = init.method || 'GET'; const body = init.body ? JSON.parse(init.body) : null;
    log.push({ host: u.host, path: u.pathname, method, body });
    if (!u.host.endsWith('.modal.run')) return new Response('{}', { status: 404 });
    if (init.headers?.['Modal-Key'] !== id || init.headers?.['Modal-Secret'] !== secret) return new Response('missing credentials for proxy authorization', { status: 401 });
    if (!deployed) return new Response('modal-http: app not found', { status: 404 });
    if (method === 'GET' && u.pathname === '/health') return new Response(JSON.stringify({ ok: true, app: 'che-gpu', version, functions: ['health', 'blender_preview'], gpu: 'T4' }), { status: 200 });
    if (method === 'POST' && u.pathname === '/blender_preview') {
      const k = body.idempotency_key;
      if (calls.has(k)) return new Response(JSON.stringify({ ok: true, ...calls.get(k), idempotency_key: k, dispatch: 'existing' }), { status: 200 });
      spawns += 1;
      calls.set(k, { state: 'started', call_id: `fc-${spawns}`, job_ids: body.job_ids, gpu_seconds: null, token: body.worker_token });
      if (ctl.dropNextPostReply) { ctl.dropNextPostReply = false; throw new TypeError('network connection lost'); }
      return new Response(JSON.stringify({ ok: true, state: 'started', call_id: `fc-${spawns}`, idempotency_key: k, dispatch: 'new' }), { status: 200 });
    }
    if (method === 'POST' && u.pathname === '/status') {
      if (ctl.statusDown) throw new TypeError('network down');
      const c = calls.get(body.idempotency_key);
      return new Response(JSON.stringify(c ? { ok: true, idempotency_key: body.idempotency_key, state: c.state, call_id: c.call_id, gpu_seconds: c.gpu_seconds, gpu: 'Tesla T4', error: c.error || '' } : { ok: true, state: 'not_found' }), { status: 200 });
    }
    if (method === 'POST' && u.pathname === '/cancel') {
      if (ctl.cancelDown) throw new TypeError('network down');
      const c = calls.get(body.idempotency_key);
      if (!c) return new Response(JSON.stringify({ ok: true, state: 'not_found' }), { status: 200 });
      if (['started', 'running'].includes(c.state)) c.state = 'cancelled';
      return new Response(JSON.stringify({ ok: true, state: c.state, gpu_seconds: c.gpu_seconds }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  return { fetcher, calls, log, ctl, spawns: () => spawns, modalHits: () => log.filter((l) => l.host.endsWith('.modal.run')) };
}
const onbCtx = (s, fetcher) => ({ storage: s.storage, env: {}, fetcher, now: s.now, keyEnv: () => ({ ...(s.storage.m.get('provider_keys') || {}) }), refresh: async () => {} });
async function connect(s, fm) { return storeSecret(onbCtx(s, fm.fetcher), 'modal', { token: CRED }); }
const say = (s, fetcher, words) => modalCommand({}, { storage: s.storage, now: s.now, fetcher }, words);
async function allowCredit(s, fetcher, credit = true) {
  await say(s, fetcher, "use Modal's free credit");
  await say(s, fetcher, "I set Modal's spend limit to zero");
  if (credit) await say(s, fetcher, 'my Modal credit is 30 dollars');
}
const callWorker = (s, fetcher, token) => async (route, body, { query = '', bytes = null } = {}) => {
  const req = new Request(`https://che.example/api/gpu/worker/${route}${query}`, { method: bytes ? 'PUT' : 'POST', headers: { 'X-CHE-GPU-Token': token, 'Content-Type': 'application/json' }, body: bytes || JSON.stringify(body) });
  return (await gpuWorkerRoute({ storage: s.storage, env: s.env, now: s.now, fetcher }, `/api/gpu/worker/${route}`, req)).json();
};
const everything = (s) => JSON.stringify([...s.storage.m.entries()]);

// ─── Credential parsing ───────────────────────────────────────────────────
test('the credential is a Proxy Auth Token plus a che-gpu *.modal.run endpoint; nothing else is accepted', () => {
  assert.deepEqual(parseModalCredential(CRED), { id: KEY_ID, secret: SECRET, base: `https://${HOST}`, host: HOST });
  assert.equal(parseModalCredential(`${KEY_ID}:${SECRET}@ownerws`).base, `https://${HOST}`, 'a workspace name expands to the che-gpu endpoint');
  for (const bad of ['ak-AbCdEf123456:as-ZyXwVu987654', `${KEY_ID}:${SECRET}`, `${KEY_ID}:${SECRET}@https://evil.example`, `${KEY_ID}:${SECRET}@http://${HOST}`,
    `${KEY_ID}:${SECRET}@https://${HOST}/steal`, `${KEY_ID}:${SECRET}@https://ownerws--other-app.modal.run`, `${KEY_ID}:${SECRET}@https://${HOST}:8443`]) {
    assert.equal(parseModalCredential(bad), null, bad);
  }
});

// ─── Acceptance 1 ─────────────────────────────────────────────────────────
test('acceptance 1: without credentials Modal is NOT CONNECTED, no request reaches Modal, and nothing costs money', async () => {
  const s = setup(); const fm = fakeModal();
  await allowCredit(s, fm.fetcher);                         // even with the owner's opt-in, no key means nothing runs
  const { job } = await s.q.enqueue(cube());
  const cap = await ensureCapacity({}, { storage: s.storage, now: s.now, fetcher: fm.fetcher });
  assert.equal(cap.pool_started, null);
  const view = await poolView({}, { storage: s.storage, now: s.now, fetcher: fm.fetcher });
  const m = view.providers.find((p) => p.id === 'modal');
  assert.equal(m.status, 'no_credential'); assert.match(m.reason, /Modal is not connected/);
  assert.equal(m.credential.exists, false); assert.equal(m.quota.connected, false);
  assert.equal(fm.modalHits().length, 0, 'zero fetches to Modal');
  const status = await say(s, fm.fetcher, 'how much Modal credit have I used');
  assert.match(status.spoken, /^Modal is not connected\./);
  const ledger = await computeUsageLedger(s.storage, { now: s.t() });
  assert.equal(ledger.totals.estimated_cost_usd, 0); assert.equal(ledger.receipts.length, 0);
  assert.equal(ledger.modal_credit.remaining_credit_provenance, 'UNAVAILABLE');
  assert.equal((await s.q.jobs()).find((j) => j.id === job.id).state, 'queued');
});

// ─── Acceptance 2 ─────────────────────────────────────────────────────────
test('acceptance 2: Connected only after an authenticated /health with the expected version; 401 is rejected; no app means deploy first; never format-only', async () => {
  const s = setup(); const fm = fakeModal();
  const ok = await connect(s, fm);
  assert.equal(ok.state, 'verified', JSON.stringify(ok));
  assert.equal(ok.outcomes.connection_verified, true);
  assert.match(ok.speech, /^Connected: Modal accepted the Proxy Auth Token and CHE's app answered at ownerws--che-gpu\.modal\.run \(che-gpu che-modal-1/);
  const health = fm.log.find((l) => l.path === '/health');
  assert.ok(health, 'the probe really ran');
  assert.ok(!JSON.stringify(ok).includes(SECRET), 'the secret is never in a reply');
  assert.ok(!JSON.stringify([...s.storage.m.entries()].filter(([k]) => k !== 'provider_keys')).includes(SECRET), 'only the key store holds it');
  // A wrong token: 401 from Modal's proxy, nothing stored, honest wording.
  const s2 = setup(); const bad = fakeModal({ secret: 'ws-SomethingElseEntirely' });
  const r401 = await connect(s2, bad);
  assert.equal(r401.state, 'failed'); assert.equal(r401.outcomes.connection_verified, false);
  assert.match(r401.lines[2], /token rejected/); assert.doesNotMatch(r401.speech, /^Connected/);
  assert.equal(s2.storage.m.get('provider_keys'), undefined, 'a rejected token is not stored');
  // No app deployed yet: the deploy workflow must run first.
  const s3 = setup(); const none = fakeModal({ deployed: false });
  const r404 = await connect(s3, none);
  assert.equal(r404.state, 'failed'); assert.match(r404.lines[2], /Run the "CHE Modal deploy" GitHub workflow first/);
  // An old app version is not Connected either.
  const s4 = setup(); const old = fakeModal({ version: 'che-modal-0' });
  const rOld = await connect(s4, old);
  assert.equal(rOld.state, 'failed'); assert.match(rOld.lines[2], /not che-gpu che-modal-1/);
  // A format-only key (the old ak-/as- API token, or a token without an endpoint) is refused before anything is sent.
  const s5 = setup(); const fm5 = fakeModal();
  const deploy = await storeSecret(onbCtx(s5, fm5.fetcher), 'modal', { token: 'ak-AbCdEf123456:as-ZyXwVu987654' });
  assert.equal(deploy.status, 422); assert.match(deploy.detail, /Modal API token, the deploy key/); assert.match(deploy.detail, /MODAL_TOKEN_ID/);
  const evil = await storeSecret(onbCtx(s5, fm5.fetcher), 'modal', { token: `${KEY_ID}:${SECRET}@https://evil.example` });
  assert.equal(evil.status, 422);
  assert.equal(fm5.log.length, 0, 'no request was made for a malformed key');
  // A saved key whose app later stops answering is re-verified and loses "Connected".
  const gone = fakeModal({ deployed: false });
  const again = await verifyOnboarding(onbCtx(s, gone.fetcher), 'modal', '');
  assert.equal(again.state, 'failed');
  const view = await poolView({}, { storage: s.storage, now: s.now, fetcher: gone.fetcher });
  assert.equal(view.providers.find((p) => p.id === 'modal').status, 'offline');
});

// ─── Acceptance 3 ─────────────────────────────────────────────────────────
test('acceptance 3: with the credit unknown or CHE\'s estimate at the stop line, the GPU job waits for approval and nothing is dispatched', async () => {
  const s = setup(); const fm = fakeModal();
  await connect(s, fm);
  // Opted in and spend limit confirmed, but the credit amount is unknown.
  await allowCredit(s, fm.fetcher, false);
  const { job } = await s.q.enqueue(cube());
  let cap = await ensureCapacity({}, { storage: s.storage, now: s.now, fetcher: fm.fetcher });
  assert.equal(cap.pool_started, null);
  assert.equal(fm.log.filter((l) => l.path === '/blender_preview').length, 0, 'no dispatch');
  let j = (await s.q.jobs()).find((x) => x.id === job.id);
  assert.equal(j.cloud.state, 'waiting_approval'); assert.match(j.cloud.reason, /^Waiting for approval: Modal does not let CHE read your remaining credit/);
  // Credit stated, but CHE's own estimate already sits at the stop line ($25 of $30).
  await say(s, fm.fetcher, 'my Modal credit is 30 dollars');
  const pool = await loadPool(s.storage);
  const m = modalStateOf(pool);
  const secs = Math.ceil(((creditStopUsd(30) - 0.1) * 3600) / MODAL_USD_HR);
  m.calls['job:gpu_000000000000:modal:1'] = { key: 'job:gpu_000000000000:modal:1', provider: 'modal', job_ids: ['gpu_000000000000'], state: 'done', dispatched_ms: T0 - 3600_000, dispatched_at: new Date(T0 - 3600_000).toISOString(), ended_ms: T0 - 60_000, gpu_seconds: secs, gpu_seconds_provenance: 'OBSERVED', usd_hr: MODAL_USD_HR, gpu: 'T4' };
  await savePool(s.storage, pool);
  cap = await ensureCapacity({}, { storage: s.storage, now: s.now, fetcher: fm.fetcher });
  assert.equal(cap.pool_started, null);
  assert.equal(fm.log.filter((l) => l.path === '/blender_preview').length, 0, 'still no dispatch at the stop line');
  j = (await s.q.jobs()).find((x) => x.id === job.id);
  assert.match(j.cloud.reason, /Waiting for approval: my estimate of Modal use this month is \$24\.\d\d of your stated \$30\.00 credit/);
  const status = await say(s, fm.fetcher, 'how much Modal credit have I used?');
  assert.match(status.spoken, /Modal is connected and verified/); assert.match(status.spoken, /not available to CHE/);
  // The owner approves one job: exactly one dispatch, then CHE asks again.
  const ap = await say(s, fm.fetcher, 'approve the next Modal job');
  assert.equal(ap.ok, true);
  cap = await ensureCapacity({}, { storage: s.storage, now: s.now, fetcher: fm.fetcher });
  assert.equal(cap.pool_started?.provider, 'modal', JSON.stringify(cap));
  const after = await loadPool(s.storage);
  assert.equal(modalStateOf(after).approve_next, null, 'the one-shot approval is used up');
  assert.equal(modalStateOf(after).calls[`job:${job.id}:modal:1`].approval.words, 'approve the next Modal job');
  // Turning the credit off stops dispatch and cancels the running call.
  const off = await say(s, fm.fetcher, "stop using Modal's credit");
  assert.match(off.spoken, /I cancelled 1 running Modal call/);
  assert.equal(fm.calls.get(`job:${job.id}:modal:1`).state, 'cancelled');
});

// ─── Acceptance 4 ─────────────────────────────────────────────────────────
test('acceptance 4: a simulated cube render on Modal: scoped dispatch, verified GLB (SHA-256 re-read from the media store), receipt, survives a restart, in the ledger', async () => {
  const s = setup(); const fm = fakeModal();
  await connect(s, fm);
  await allowCredit(s, fm.fetcher);
  const { job } = await s.q.enqueue(cube());
  const cap = await ensureCapacity({}, { storage: s.storage, now: s.now, fetcher: fm.fetcher });
  assert.equal(cap.pool_started.provider, 'modal', JSON.stringify(cap));
  const post = fm.log.find((l) => l.path === '/blender_preview').body;
  assert.equal(post.idempotency_key, `job:${job.id}:modal:1`);
  assert.deepEqual(post.job_ids, [job.id]); assert.match(post.worker_token, /^[a-f0-9]{64}$/); assert.equal(post.deadline_s, 45 * 60);
  assert.deepEqual(Object.keys(post).sort(), ['che_base', 'deadline_s', 'idempotency_key', 'job_ids', 'worker_token'], 'only the allowlisted fields');
  assert.ok(!everything(s).includes(post.worker_token), 'the worker token is stored only as a hash');
  // The Modal container runs CHE's worker against the queue with that token.
  const call = callWorker(s, fm.fetcher, post.worker_token);
  s.advance(3 * 60_000);
  const c = await call('claim', { worker_id: 'modal-fc-1', gpu: GPU, blender: 'Blender 5.0.1' });
  assert.equal(c.job.id, job.id, JSON.stringify(c));
  const up = await call('model', null, { query: `?worker=modal-fc-1&job=${job.id}`, bytes: glb() });
  await call('preview', null, { query: `?worker=modal-fc-1&job=${job.id}&view=0`, bytes: PNG });
  s.advance(60_000);
  const receipt = { status: 'complete', blender_version: 'Blender 5.0.1', nvidia_smi: GPU, views: { 0: { status: 'ok', name: 'front', device: GPU_DEV, render_seconds: 4, sha256: 'b'.repeat(64) } },
    model: { status: 'ok', sha256: up.sha256, bytes: glb().length, verify: { ok: true, sha256: up.sha256, meshes: 1, triangles: 12, materials: 1, bbox_m: [1, 1, 1] } } };
  const done = await call('complete', { worker_id: 'modal-fc-1', job_id: job.id, status: 'complete', receipt });
  assert.equal(done.job?.state, 'completed', JSON.stringify(done));
  assert.equal(done.job.receipt.provider, 'modal');
  // The Modal app reports the call finished with its measured GPU seconds.
  Object.assign(fm.calls.get(`job:${job.id}:modal:1`), { state: 'done', gpu_seconds: 95 });
  // Durable Object restart: brand-new objects over the same storage.
  s.advance(60_000);
  await ensureCapacity({}, { storage: s.storage, now: s.now, fetcher: fm.fetcher, queue: new GpuQueue(s.storage, s.now) });
  const j = (await new GpuQueue(s.storage, s.now).jobs()).find((x) => x.id === job.id);
  assert.equal(j.state, 'completed');
  assert.equal(j.receipt.compute.provider, 'modal'); assert.equal(j.receipt.compute.idempotency_key, `job:${job.id}:modal:1`);
  assert.equal(j.receipt.compute.gpu_seconds, 95); assert.equal(j.receipt.compute.gpu_seconds_provenance, 'OBSERVED');
  assert.equal(j.receipt.compute.estimated_cost_usd, Math.round(((95 + 120) * MODAL_USD_HR / 3600) * 10000) / 10000);
  assert.equal(j.receipt.compute.cost_provenance, 'ESTIMATED'); assert.equal(j.receipt.compute.billed_provenance, 'UNAVAILABLE');
  const view = await poolView({}, { storage: s.storage, now: s.now, fetcher: fm.fetcher, refreshQuota: false });
  const m = view.providers.find((p) => p.id === 'modal');
  assert.equal(m.status, 'ready', 'proven by a real GLB receipt'); assert.equal(m.verified.sha256, up.sha256);
  const ledger = await computeUsageLedger(s.storage, { now: s.t() });
  assert.equal(ledger.month, '2026-10');
  assert.equal(ledger.providers.modal.jobs, 1);
  const r = ledger.receipts.find((x) => x.provider === 'modal');
  assert.equal(r.job_id, job.id); assert.equal(r.artifact_sha256, up.sha256); assert.equal(r.attempts, 1);
  assert.deepEqual(r.data_provenance, { gpu_seconds: 'OBSERVED', cost: 'ESTIMATED', billed: 'UNAVAILABLE' });
  assert.equal(ledger.modal_credit.stated_credit_usd, 30); assert.equal(ledger.modal_credit.stated_credit_provenance, 'USER-ENTERED');
  assert.equal(ledger.modal_credit.used_estimate_provenance, 'ESTIMATED'); assert.equal(ledger.modal_credit.remaining_credit_usd, null);
  assert.ok(!JSON.stringify(ledger).includes(SECRET) && !JSON.stringify(view).includes(SECRET));
});

test('acceptance 4b: a Modal job whose stored GLB no longer matches its SHA-256 is not accepted as complete', async () => {
  const s = setup(); const fm = fakeModal();
  await connect(s, fm); await allowCredit(s, fm.fetcher);
  const { job } = await s.q.enqueue(cube());
  await ensureCapacity({}, { storage: s.storage, now: s.now, fetcher: fm.fetcher });
  const token = fm.log.find((l) => l.path === '/blender_preview').body.worker_token;
  const call = callWorker(s, fm.fetcher, token);
  await call('claim', { worker_id: 'modal-fc-1', gpu: GPU });
  const up = await call('model', null, { query: `?worker=modal-fc-1&job=${job.id}`, bytes: glb() });
  await call('preview', null, { query: `?worker=modal-fc-1&job=${job.id}&view=0`, bytes: PNG });
  for (const f of s.env.CHE_DATA_BUCKET.files.values()) if (f.o?.httpMetadata?.contentType === 'model/gltf-binary') f.bytes[f.bytes.length - 1] ^= 0xff;   // corrupted at rest
  const done = await call('complete', { worker_id: 'modal-fc-1', job_id: job.id, status: 'complete',
    receipt: { status: 'complete', nvidia_smi: GPU, views: { 0: { status: 'ok', device: GPU_DEV } }, model: { status: 'ok', sha256: up.sha256, verify: { ok: true, sha256: up.sha256 } } } });
  assert.notEqual(done.job.state, 'completed');
  assert.match(done.job.history.at(-1).note, /does not match the receipt/);
});

// ─── Acceptance 5 ─────────────────────────────────────────────────────────
test('acceptance 5: a lost dispatch reply is settled by key (one container), a worker error is visible, and failover cancels Modal before a paid GPU', async () => {
  const s = setup(); const fm = fakeModal();
  await connect(s, fm); await allowCredit(s, fm.fetcher);
  const { job } = await s.q.enqueue(cube());
  fm.ctl.dropNextPostReply = true;                          // Modal started the call, but its answer never arrived
  let cap = await ensureCapacity({}, { storage: s.storage, now: s.now, fetcher: fm.fetcher });
  assert.equal(cap.pool_started, null);
  let pool = await loadPool(s.storage);
  const key = `job:${job.id}:modal:1`;
  assert.equal(modalStateOf(pool).calls[key].state, 'unknown');
  s.advance(60_000);
  cap = await ensureCapacity({}, { storage: s.storage, now: s.now, fetcher: fm.fetcher });
  pool = await loadPool(s.storage);
  assert.equal(modalStateOf(pool).calls[key].state, 'started', 'found by its key');
  assert.equal(fm.spawns(), 1, 'one container for the key');
  assert.equal(fm.log.filter((l) => l.path === '/blender_preview').length, 1, 'never re-posted while it may be running');
  // The GPU call fails inside Modal: the error reaches the job's history and the pool, and the job is handed on.
  Object.assign(fm.calls.get(key), { state: 'failed', error: 'CHE\'s worker exited with code 1 (CUDA error: out of memory)', gpu_seconds: 40 });
  s.advance(60_000);
  await ensureCapacity({}, { storage: s.storage, now: s.now, fetcher: fm.fetcher });
  let j = (await s.q.jobs()).find((x) => x.id === job.id);
  assert.match(j.history.map((h) => h.note).join('\n'), /Modal GPU call job:gpu_[a-f0-9]{12}:modal:1 failed: CHE's worker exited with code 1 \(CUDA error: out of memory\)/);
  pool = await loadPool(s.storage);
  assert.equal(pool.cooldowns.modal.kind, 'provider_error');
  assert.equal(pool.handoffs.at(-1).from, 'modal');
  const view = await poolView({}, { storage: s.storage, now: s.now, fetcher: fm.fetcher, refreshQuota: false });
  assert.match(view.providers.find((p) => p.id === 'modal').reason, /Cooling down/);
  // Billed once for the key: one receipt, measured seconds.
  let ledger = await computeUsageLedger(s.storage, { now: s.t() });
  assert.equal(ledger.receipts.filter((r) => r.idempotency_key === key).length, 1);
  assert.equal(ledger.receipts.find((r) => r.idempotency_key === key).error, 'CHE\'s worker exited with code 1 (CUDA error: out of memory)');

  // Failover to a paid GPU: an open Modal call is cancelled by its key BEFORE RunPod starts anything.
  const s2 = setup(); const fm2 = fakeModal(); const order = [];
  const rp = async (url, init = {}) => {
    const u = new URL(String(url)); order.push(`${u.host}${u.pathname}`);
    if (u.host.endsWith('.modal.run')) return fm2.fetcher(url, init);
    if (u.host === 'api.runpod.io') return new Response(JSON.stringify({ data: { myself: { id: 'u', clientBalance: 12.5, currentSpendPerHr: 0 } } }), { status: 200 });
    if (u.host === 'rest.runpod.io' && init.method === 'POST') return new Response(JSON.stringify({ id: 'pod1', costPerHr: 0.17, desiredStatus: 'RUNNING' }), { status: 201 });
    return new Response('{}', { status: 404 });
  };
  await connect(s2, fm2); await allowCredit(s2, rp);
  const { job: j2 } = await s2.q.enqueue(cube());
  await ensureCapacity({}, { storage: s2.storage, now: s2.now, fetcher: rp });
  const key2 = `job:${j2.id}:modal:1`;
  assert.equal(fm2.calls.get(key2).state, 'started');
  // The owner sets a GPU budget and stops Modal's credit use; the container never claimed, its window passes.
  s2.storage.m.set('provider_keys', { ...s2.storage.m.get('provider_keys'), RUNPOD_API_KEY: RUNPOD_KEY });
  await budgetCommand({}, { storage: s2.storage, now: s2.now, fetcher: rp }, { action: 'allow', total_usd: 20 }, 'allow up to $20 for GPUs');
  pool = await loadPool(s2.storage); modalStateOf(pool).opt_in = null; await savePool(s2.storage, pool);
  fm2.ctl.cancelDown = true;                                  // first: Modal cannot be reached to cancel
  s2.advance(MODAL_RESERVE_MS + 1000);
  await ensureCapacity({}, { storage: s2.storage, now: s2.now, fetcher: rp });
  assert.ok(!order.some((o) => o === 'rest.runpod.io/v1/pods'), 'no paid GPU while the Modal call may still bill');
  fm2.ctl.cancelDown = false;
  s2.advance(60_000);
  order.length = 0;
  const cap2 = await ensureCapacity({}, { storage: s2.storage, now: s2.now, fetcher: rp });
  assert.equal(fm2.calls.get(key2).state, 'cancelled');
  const cancelAt = order.indexOf(`${HOST}/cancel`); const podAt = order.indexOf('rest.runpod.io/v1/pods');
  assert.ok(cancelAt >= 0 && podAt > cancelAt, `cancel before the paid start: ${order.join(', ')}`);
  assert.equal(cap2.pool_started?.provider, 'runpod');
  assert.equal(fm2.spawns(), 1, 'Modal never started a second container for the job');
  ledger = await computeUsageLedger(s2.storage, { now: s2.t() });
  assert.equal(ledger.receipts.filter((r) => r.provider === 'modal').length, 1);
  assert.equal(ledger.receipts.find((r) => r.provider === 'modal').state, 'cancelled');
  j = (await s2.q.jobs()).find((x) => x.id === j2.id);
  assert.equal(j.compute.at(-1).idempotency_key, key2);
});

// ─── Selection and words ──────────────────────────────────────────────────
test('free first: Modal\'s credit only after Colab and Kaggle, before paid GPUs, and never for CPU-capable work', () => {
  const st = (over) => POOL_PROVIDERS.map((p) => ({ id: p.id, label: p.label, gpu: p.gpu, compatible: p.compatible, paid: Boolean(p.paid), metered: Boolean(p.metered), reason: p.id,
    status: { github_actions_cpu: 'ready', colab_gpu: 'offline', kaggle: 'no_credential', runpod: 'no_credential', vast: 'no_credential', modal: 'offline', ...over }[p.id] || 'no_credential', quota: p.id === 'runpod' ? { from_usd_hr: 0.17 } : null }));
  const req = { kind: 'object_model', requires: { gpu: 'required' } };
  assert.equal(selectProvider(st({ modal: 'unverified', colab_gpu: 'ready' }), req).provider, 'colab_gpu');
  assert.equal(selectProvider(st({ modal: 'unverified', kaggle: 'unverified' }), req).provider, 'kaggle');
  assert.equal(selectProvider(st({ modal: 'unverified', runpod: 'ready' }), req).provider, 'modal');
  assert.equal(selectProvider(st({ modal: 'offline', runpod: 'ready' }), req).provider, 'runpod');
  for (const gpu of ['none', 'preferred']) assert.notEqual(selectProvider(st({ modal: 'ready' }), { kind: 'object_model', requires: { gpu } }, { paidForSpeed: true }).provider, 'modal');
  assert.equal(selectProvider(st({ modal: 'ready', github_actions_cpu: 'offline' }), { kind: 'object_model', requires: { gpu: 'none' } }).provider, null);
});

test('voice: the owner\'s Modal phrases route to /cloud-gpu and are recorded USER-ENTERED with time and exact words', async () => {
  for (const [words, action] of [["CHE, use Modal's free credit", 'enable'], ["use modal's free credit, I set the spend limit to zero", 'enable'], ["I set Modal's spend limit to zero", 'spend_limit_zero'],
    ['my Modal credit is 30 dollars', 'credit'], ['my modal credit is thirty dollars a month', 'credit'], ['approve the next Modal job', 'approve_next'], ["stop using Modal's credit", 'disable'],
    ['how much Modal credit have I used?', 'status']]) {
    assert.equal(modalIntent(words.replace(/\?$/, ''))?.action, action, words);
    assert.equal(cloudIntent(words)?.command, 'cloud-gpu', words);
    assert.match(cloudIntent(words).input, /^budget modal /);
  }
  assert.equal(modalIntent('connect modal'), null, '"connect Modal" stays with onboarding');
  assert.equal(modalIntent('tell me about modal logic'), null);
  const s = setup();
  const out = await say(s, offline, "use Modal's free credit, I set my Modal spend limit to zero");
  assert.equal(out.ok, true);
  const m = modalStateOf(await loadPool(s.storage));
  assert.equal(m.opt_in.provenance, 'USER-ENTERED'); assert.equal(m.opt_in.at, new Date(T0).toISOString());
  assert.equal(m.opt_in.words, "use Modal's free credit, I set my Modal spend limit to zero");
  assert.equal(m.spend_limit_zero.words, m.opt_in.words);
  assert.match(out.spoken, /Recorded at 12:00 UTC/); assert.match(out.spoken, /not told me your monthly credit/);
  assert.equal(callCostUsd({ state: 'not_started' }), 0, 'a call Modal never started costs nothing');
});
