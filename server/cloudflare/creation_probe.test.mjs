// The Creation Engine's deploy end-to-end check (creation_probe.js): the same Generate as the app's button, CHE's own
// dispatch of the free cloud worker, the worker's real routes, and the stored GLB. GitHub is a fake fetcher here; the
// deploy runs the same routes against production with a real runner.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { PROBE_TITLE, creationProbeRoute } from './creation_probe.js';
import { creationRoute } from './creation_studio.js';
import { gpuWorkerRoute } from './gpu_queue.js';
import { cloudJobs } from './cloud_computer.js';
import { resetOidcCache } from './gpu_oidc.js';
import { oidcSigner } from './oidc_test_signer.mjs';

function memStorage() {
  const m = new Map();
  return { m, get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v); }, delete: async (k) => m.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...m].filter(([k]) => k.startsWith(prefix))) };
}
function glb() {
  const text = JSON.stringify({ asset: { version: '2.0' } }); const padded = text + ' '.repeat((4 - (text.length % 4)) % 4);
  const b = new Uint8Array(20 + padded.length); const dv = new DataView(b.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, b.length, true);
  dv.setUint32(12, padded.length, true); dv.setUint32(16, 0x4e4f534a, true); b.set(new TextEncoder().encode(padded), 20);
  return b;
}
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

test('deploy check: Generate on the test project dispatches the free worker, which builds, stores and serves the GLB', async () => {
  resetOidcCache();
  let t = Date.parse('2026-10-24T20:00:00Z');
  const storage = memStorage(); const now = () => t; const signer = await oidcSigner();
  const github = [];
  const fetcher = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://token.actions.githubusercontent.com/')) return new Response(JSON.stringify({ keys: [signer.jwk] }));
    github.push({ u, method: init.method || 'GET' });
    if (u === 'https://api.github.com/repos/Vondada/chey-app') return new Response(JSON.stringify({ private: false }));
    if (u.endsWith('/actions/workflows/che-creation-worker.yml/dispatches')) return new Response(null, { status: 204 });
    return new Response('{}', { status: 404 });
  };
  const ctx = { storage, env: { CHE_GITHUB_TOKEN: 'ghp_fixture', CHE_GITHUB_REPO: 'Vondada/chey-app' }, now, fetcher };
  const probe = async (path, method = 'GET') => creationProbeRoute(ctx, path.split('?')[0], new Request(`https://che.example${path}`, { method }));
  const worker = async (route, body, { query = '', bytes = null } = {}) => gpuWorkerRoute(ctx, `/api/gpu/worker/${route}`, new Request(`https://che.example/api/gpu/worker/${route}${query}`, {
    method: bytes ? 'PUT' : 'POST', headers: { Authorization: `Bearer ${await signer.sign({ run_id: '555' }, Math.floor(t / 1000))}` }, body: bytes || JSON.stringify(body) }));

  const start = await (await probe('/api/creations/probe/start', 'POST')).json();
  assert.equal(start.ok, true, JSON.stringify(start));
  assert.equal(start.engine.automatic, true);
  assert.equal(github.filter((g) => g.method === 'POST').length, 1, 'CHE dispatched the worker herself');
  // It is the owner's real Creation Studio: the test project is listed, labelled, built from CHE's own preset.
  const list = await (await creationRoute(ctx, '/api/creations', new Request('https://che.example/api/creations'), {})).json();
  assert.deepEqual(list.projects.map((p) => p.title), [PROBE_TITLE]);

  const wid = 'gha-555-1'; const id = start.job_id;
  const claim = await (await worker('claim', { worker_id: wid, gpu: 'CPU (4 cores)', blender: 'Blender 5.0.1', class: 'github_cpu', device: 'cpu', cores: 4, ram_gb: 16 })).json();
  assert.equal(claim.job.id, id);
  const model = glb();
  assert.equal((await worker('model', null, { query: `?worker=${wid}&job=${id}`, bytes: model })).status, 200);
  for (const v of [0, 45, 90]) await worker('preview', null, { query: `?worker=${wid}&job=${id}&view=${v}`, bytes: PNG });
  const status1 = await (await probe(`/api/creations/probe/status?job=${id}`)).json();
  const sha = status1.job.model.sha256;
  const rig = JSON.parse(readFileSync(new URL('./fixtures/full_body_rig_receipt.json', import.meta.url), 'utf8'));
  const views = Object.fromEntries([0, 45, 90].map((v) => [v, { status: 'ok', device: "DEVICE CPU ['AMD EPYC 7763'] 384x480", render_seconds: 30, sha256: 'b'.repeat(64) }]));
  t += 60_000;
  await worker('complete', { worker_id: wid, job_id: id, status: 'complete', receipt: { status: 'complete', device: 'CPU', cores: 4, blender_version: 'Blender 5.0.1', views, model: { status: 'ok', sha256: sha, bytes: model.length, mode: 'full_body', rig } } });

  const done = await (await probe(`/api/creations/probe/status?job=${id}`)).json();
  assert.equal(done.job.state, 'completed', JSON.stringify(done.job.history.at(-1)));
  assert.equal(done.job.rig.ok, true); assert.equal(done.job.rig.bones, 53);
  // Regression (live creation_check notice named the worker "?"): a completed job has no lease, and the status still
  // names the runner that built it, in the history and in worker_name, which the deploy notice prints.
  assert.equal(done.job.worker_id, 'gha-555-1'); assert.equal(done.job.worker_class, 'github_cpu');
  assert.equal(done.job.worker_name, 'free GitHub cloud CPU runner gha-555-1 (GitHub Actions run 555)');
  assert.match(done.job.status_line, /on the free GitHub cloud CPU runner gha-555-1/);
  assert.match(done.job.history.at(-1).note, /worker: free GitHub cloud CPU runner gha-555-1/);
  const deployYml = readFileSync(new URL('../../.github/workflows/che-worker-deploy.yml', import.meta.url), 'utf8');
  const noticeLine = deployYml.split('\n').find((l) => /const worker = /.test(l) && /creation|worker_name|worker_class/.test(l)) || '';
  assert.match(noticeLine, /job\.worker_name \|\| 'unknown worker'/, 'the deploy notice prints the Worker\'s worker name');
  assert.doesNotMatch(noticeLine, /'\?'/, 'never a question mark for the worker');
  assert.deepEqual(done.job.previews.sort(), ['0', '45', '90']);
  assert.equal(done.dispatches.at(-1).ok, true);
  const bytes = new Uint8Array(await (await probe(`/api/creations/probe/model.glb?job=${id}`)).arrayBuffer());
  assert.deepEqual([...bytes], [...model], 'the stored GLB is what the worker uploaded');
  // The Cloud Computer's job list names the worker that really built it, also after completion (review of #522).
  const row = (await cloudJobs(storage)).find((r) => r.id === id);
  assert.equal(row.kind, 'blender_model'); assert.equal(row.status, 'complete'); assert.equal(row.provider, 'github_creation');
  assert.match(row.evidence, /^GLB stored, SHA-256/);

  // A second run reuses the same test project (one project, never a growing list) and only reads its own jobs.
  const again = await (await probe('/api/creations/probe/start', 'POST')).json();
  assert.equal(again.project_id, start.project_id); assert.notEqual(again.job_id, id);
  assert.equal((await probe('/api/creations/probe/status?job=gpu_000000000000')).status, 404);
});

test('deploy check routes: only this deploy\'s probe token opens them; a paired-phone or no token sees nothing', async () => {
  const generated = new URL('./.creation_probe.test.generated.mjs', import.meta.url);
  writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
    "import { DurableObject } from 'cloudflare:workers';", 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'), 'utf8');
  let mod;
  try { mod = await import(`${generated.href}?t=${Date.now()}`); } finally { try { unlinkSync(generated); } catch (_) {} }
  const { default: worker, CheState } = mod;
  const saved = new Map();
  const storage = { get: async (k) => (saved.has(k) ? structuredClone(saved.get(k)) : undefined), put: async (k, v) => saved.set(k, structuredClone(v)),
    delete: async (k) => saved.delete(k), list: async ({ prefix = '' } = {}) => new Map([...saved].filter(([k]) => k.startsWith(prefix))), setAlarm: async () => {}, deleteAlarm: async () => {} };
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', CHE_VOICE_PROBE_TOKEN: 'c'.repeat(64) };
  const state = new CheState({ id: { name: 'owner' }, storage }, env);
  env.CHE_STATE = { getByName: () => state };
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('offline'); };
  try {
    const send = (headers = {}) => worker.fetch(new Request('https://che.example/api/creations/probe/start', { method: 'POST', headers }), env);
    assert.equal((await send()).status, 404);
    assert.equal((await send({ 'X-CHE-Memory-Probe': 'd'.repeat(64) })).status, 404, 'a wrong token sees nothing');
    const res = await send({ 'X-CHE-Memory-Probe': 'c'.repeat(64) });
    const out = await res.json();
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.match(out.job_id, /^gpu_[a-f0-9]{12}$/);
    assert.equal(out.engine.automatic, false, 'no GitHub token on this Worker: nothing was dispatched, and it says so');
  } finally { globalThis.fetch = original; }
});
