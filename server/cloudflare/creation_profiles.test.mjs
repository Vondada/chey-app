// The Creation Engine's automatic tool choice (creation_profiles.js) and what it changes downstream: the job settings
// Generate queues (creation_studio.js), quick looks kept apart from finished views and the Roblox FBX store
// (gpu_queue.js). Render speed and quality are measured by tools/creation_benchmark.py, not asserted here.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CREATION_KINDS, CREATION_PROFILES, creationProfile, kindFromText, profileSettings } from './creation_profiles.js';
import { DEFAULT_RENDER, parseEdit, renderOf, renderSettings } from './creation_studio.js';
import { EXPORT_FORMATS, GpuQueue, gpuOwnerRoute, isFbx, publicJob } from './gpu_queue.js';
import { listMedia } from './media.js';

function memStorage() {
  const m = new Map();
  return { m, get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v); }, delete: async (k) => m.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...m].filter(([k]) => k.startsWith(prefix))) };
}
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const FBX = new Uint8Array([...new TextEncoder().encode('Kaydara FBX Binary  \0'), 0x1a, 0, 0xe8, 0x1c, 0, 0, 1, 2, 3, 4]);

test('every kind has one profile; the person pipeline renders a quick look first and the final profile after', () => {
  assert.deepEqual(CREATION_KINDS, Object.keys(CREATION_PROFILES));
  for (const k of CREATION_KINDS) {
    const p = creationProfile(k);
    assert.equal(p.settings.RENDER_PROFILE, 'final', k);
    if (k !== 'invention') assert.equal(p.settings.PREVIEW, '1', k);   // inventions already show the instant placeholder first
    assert.ok(p.tools.length && p.exports.length, k);
  }
  assert.deepEqual(profileSettings('person'), { RENDER_PROFILE: 'final', PREVIEW: '1', PREVIEW_ENGINE: 'auto' });
  assert.equal(profileSettings('roblox').EXPORT_ROBLOX, '1');
  assert.deepEqual(creationProfile('roblox').exports, ['glb', 'fbx_r15', 'fbx_r15_walk']);
  assert.match(creationProfile('roblox').note, /Not Marketplace-ready/);
  assert.throws(() => creationProfile('spaceship'), /No Creation Engine profile/);
});

test('the kind comes from the owner\'s words', () => {
  const cases = { 'CHE, create a Roblox character': 'roblox', 'make a short film about rain': 'movie', 'create a person with long hair': 'person',
    'build me an office room': 'room', 'design a red chair': 'object', 'what time is it': null };
  for (const [t, k] of Object.entries(cases)) assert.equal(kindFromText(t), k, t);
});

test('Generate queues the profile\'s tools; "make it Roblox ready" adds the Roblox export and says what it is not', () => {
  const s = renderSettings(renderOf({}));
  assert.equal(s.RENDER_PROFILE, 'final'); assert.equal(s.PREVIEW, '1'); assert.equal(s.EXPORT_ROBLOX, undefined);
  assert.equal(s.MODEL_MODE, 'full_body', 'the existing render settings are unchanged');
  const out = parseEdit('make it Roblox ready', {}, 'photoreal', DEFAULT_RENDER);
  assert.equal(out.render.target, 'roblox');
  assert.equal(renderSettings(renderOf({ render: out.render })).EXPORT_ROBLOX, '1');
  assert.ok(out.applied.some((a) => /Roblox export on/.test(a) && /Not Marketplace-ready/.test(a)), out.applied.join(' | '));
  const off = parseEdit('no Roblox', {}, 'photoreal', out.render);
  assert.equal(off.render.target, undefined); assert.ok(off.applied.includes('Roblox export off.'));
  assert.equal(renderOf({ render: { target: 'minecraft' } }).target, undefined, 'only known targets are kept');
});

async function heldJob() {
  let t = Date.parse('2026-10-24T20:00:00Z');
  const storage = memStorage(); const q = new GpuQueue(storage, () => t);
  await q.jobs();
  const { job: queued } = await q.enqueue({ kind: 'person_model', title: 'Roblox hero v1: 3D model and previews', views: [0, 45, 90],
    settings: profileSettings('roblox'), requires: { gpu: 'none' }, priority: 'high' });
  const { job } = await q.claim('gha-77-1', { gpu: 'CPU (4 cores)', class: 'github_cpu', device: 'cpu' }, { class: 'github_cpu' });
  assert.equal(job.id, queued.id);
  return { q, storage, job, advance: (ms) => { t += ms; } };
}

test('a quick look is shown at once but never counts as the finished view', async () => {
  const { q, storage, job } = await heldJob();
  const r = await q.preview({}, 'gha-77-1', job.id, 45, PNG, { quick: true });
  assert.equal(r.ok, true); assert.equal(r.quick, true);
  const j = (await q.jobs()).find((x) => x.id === job.id);
  assert.deepEqual(Object.keys(j.quick_previews), ['45']); assert.deepEqual(j.previews, {}, 'no finished view yet');
  const view = publicJob(j);
  assert.deepEqual(Object.keys(view.quick_previews), ['45']);
  const media = await listMedia(storage);
  assert.ok(media.some((m) => /quick look \(GitHub cloud CPU\)/.test(m.title) && m.mode === 'quick_preview'), 'labelled a quick look, by the compute that made it');
  assert.equal((await q.preview({}, 'gha-77-1', job.id, 30, PNG, { quick: true })).ok, false, 'only the job\'s own views');
});

test('the Roblox FBX is stored beside the GLB and served to the owner; anything else is refused', async () => {
  const { q, storage, job } = await heldJob();
  assert.equal(isFbx(FBX), true); assert.equal(isFbx(PNG), false);
  assert.equal((await q.exportFile({}, 'gha-77-1', job.id, 'fbx_r15', PNG)).ok, false, 'not an FBX');
  assert.match((await q.exportFile({}, 'gha-77-1', job.id, 'obj', FBX)).detail, /Unknown export format/);
  assert.equal((await q.exportFile({}, 'someone-else', job.id, 'fbx_r15', FBX)).ok, false, 'only the worker holding the job');
  const ok = await q.exportFile({}, 'gha-77-1', job.id, 'fbx_r15', FBX);
  assert.equal(ok.ok, true); assert.equal(ok.bytes, FBX.length); assert.match(ok.sha256, /^[a-f0-9]{64}$/);
  const view = publicJob((await q.jobs()).find((x) => x.id === job.id));
  assert.equal(view.exports.fbx_r15.label, EXPORT_FORMATS.fbx_r15);
  assert.equal(view.exports.fbx_r15.url, `/api/gpu/jobs/${job.id}/fbx_r15.fbx`);
  const res = await gpuOwnerRoute({ storage, env: {}, now: () => Date.now() }, `/api/gpu/jobs/${job.id}/fbx_r15.fbx`, new Request(`https://che.example/api/gpu/jobs/${job.id}/fbx_r15.fbx`));
  assert.equal(res.status, 200); assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [...FBX]);
  const missing = await gpuOwnerRoute({ storage, env: {}, now: () => Date.now() }, `/api/gpu/jobs/${job.id}/fbx_r15_walk.fbx`, new Request('https://che.example/x'));
  assert.equal(missing.status, 404);
});

test('the receipt keeps the Roblox verdict and quick-look timings, trimmed', async () => {
  const { q, job } = await heldJob();
  for (const v of [0, 45, 90]) await q.preview({}, 'gha-77-1', job.id, v, PNG);
  const views = Object.fromEntries([0, 45, 90].map((v) => [v, { status: 'ok', device: "DEVICE CPU ['CPU'] 320x480", render_seconds: 3, sha256: 'b'.repeat(64) }]));
  await q.complete('gha-77-1', { job_id: job.id, status: 'complete', receipt: { status: 'complete', render_profile: 'final', stage_seconds: { render: 10.8 }, views,
    quick_previews: { 0: { engine: 'cycles', seconds: 0.4, sha256: 'c'.repeat(64) } },
    roblox: { ok: true, studio_import_ready: true, marketplace_ready: false, triangles_total: 9934, failures: [], marketplace_missing: ['no _OuterCage meshes'], measured: { huge: 'x'.repeat(5000) } } } });
  const r = (await q.jobs()).find((x) => x.id === job.id).receipt;
  assert.equal(r.render_profile, 'final'); assert.deepEqual(r.stage_seconds, { render: 10.8 });
  assert.deepEqual(r.quick_previews, { 0: { engine: 'cycles', seconds: 0.4 } });
  assert.equal(r.roblox.triangles_total, 9934); assert.equal(r.roblox.marketplace_ready, false); assert.equal(r.roblox.measured, undefined);
});
