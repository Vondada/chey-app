// End to end, OFFLINE (reliability lane R2, 2026-10-25): a real media artifact is created, stored, reopened after a
// restart and DECODED, never just counted. Not production verification: no Worker, R2, GPU or phone is involved, and
// CHE's own store runs on an in-memory map. Each test writes real bytes, reads them back through the same functions
// the routes use, and decodes them:
//   - a PNG the owner saves (media.js saveOwnerFile → readBlob), decoded pixel by pixel (zlib inflate, PNG filters, CRCs);
//   - CHE's real bundled character GLB (assets/characters/crew/che.glb) uploaded by a Creation Engine worker
//     (gpu_queue model route) and reopened by the owner route, parsed as glTF 2.0 with its vertex data checked against
//     the accessor bounds;
//   - a real H.264/AAC MP4 (fixtures/media/tiny.mp4) in CHE's own store, reopened and its boxes walked.
// Related, already covered elsewhere: media_retrieval.test.mjs (chat open-by-ID, byte identity), film_studio.test.mjs
// (a finished film without R2 reopens), creation_studio.test.mjs (GLB route checks).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync, crc32 } from 'node:zlib';
import test from 'node:test';
import { listMedia, readBlob, saveOwnerFile, verifyMediaFile } from './media.js';
import { mediaStore } from './che_media_store.js';
import { mediaLibraryReport } from './media_library.js';
import { gpuOwnerRoute, gpuWorkerRoute } from './gpu_queue.js';
import { creationRoute } from './creation_studio.js';
import { mp4Facts } from './github_video_renderer.js';

/** Storage over one Map; a "restart" is a new wrapper over the same Map (what a Durable Object keeps). */
function durable(m = new Map()) {
  return {
    m,
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => m.has(x)).map((x) => [x, m.get(x)])) : m.get(k)),
    put: async (k, v) => { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) m.set(a, b); else m.set(k, v); },
    delete: async (k) => m.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...m].filter(([k]) => k.startsWith(prefix))),
  };
}

// ─── PNG: encode a real image, decode it back ─────────────────────────────

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])) >>> 0, 8 + data.length);
  return out;
}
/** An 8-bit RGB PNG of [w]x[h] whose pixel (x, y) is (x*40, y*60, 200), each row with a Sub filter. */
function makePng(w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3);
    raw[row] = 1; // Sub
    for (let x = 0; x < w; x++) {
      const px = [x * 40, y * 60, 200];
      for (let c = 0; c < 3; c++) raw[row + 1 + x * 3 + c] = (px[c] - (x ? [(x - 1) * 40, y * 60, 200][c] : 0)) & 255;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/** Decodes an 8-bit RGB, non-interlaced PNG: checks the signature and every CRC, inflates and unfilters. */
function decodePng(bytes) {
  const b = Buffer.from(bytes);
  assert.deepEqual([...b.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'PNG signature');
  let at = 8; let w = 0; let h = 0; const idat = [];
  for (;;) {
    const len = b.readUInt32BE(at); const type = b.toString('latin1', at + 4, at + 8);
    const data = b.subarray(at + 8, at + 8 + len);
    assert.equal(b.readUInt32BE(at + 8 + len), crc32(b.subarray(at + 4, at + 8 + len)) >>> 0, `${type} CRC`);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); assert.deepEqual([data[8], data[9], data[12]], [8, 2, 0], '8-bit RGB, no interlace'); }
    if (type === 'IDAT') idat.push(data);
    at += 12 + len;
    if (type === 'IEND') break;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * 3; const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const v = raw[y * (stride + 1) + 1 + i];
      const a = i >= 3 ? px[y * stride + i - 3] : 0; const up = y ? px[(y - 1) * stride + i] : 0; const ul = y && i >= 3 ? px[(y - 1) * stride + i - 3] : 0;
      const p = a + up - ul; const pa = Math.abs(p - a); const pb = Math.abs(p - up); const pc = Math.abs(p - ul);
      px[y * stride + i] = (v + [0, a, up, (a + up) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? up : ul][f]) & 255;
    }
  }
  return { w, h, pixel: (x, y) => [...px.subarray(y * stride + x * 3, y * stride + x * 3 + 3)] };
}

test('e2e (offline): a PNG the owner saves is stored, survives a restart, reopens by its ID and decodes to the same pixels', async () => {
  const png = makePng(6, 4);
  const m = new Map();
  const saved = await saveOwnerFile({}, durable(m), { name: 'Gradient', media_type: 'image', base64: png.toString('base64') });
  assert.equal(saved.ok, true, saved.reason);
  const after = durable(m); // restart: a new storage object over the same kept data
  const item = (await listMedia(after)).find((x) => x.id === saved.item.id);
  assert.equal(item.mime_type, 'image/png');
  assert.equal((await verifyMediaFile({}, after, item)).status, 'verified');
  const back = await readBlob({}, after, item);
  assert.equal(createHash('sha256').update(back).digest('hex'), createHash('sha256').update(png).digest('hex'), 'the exact bytes');
  const img = decodePng(back);
  assert.deepEqual([img.w, img.h], [6, 4]);
  for (const [x, y] of [[0, 0], [5, 0], [2, 3], [5, 3]]) assert.deepEqual(img.pixel(x, y), [x * 40, y * 60, 200], `pixel ${x},${y}`);
});

// ─── GLB: CHE's real character through the Creation Engine queue ─────────

/** Parses a glTF 2.0 binary: header, JSON chunk, BIN chunk; returns the JSON and the BIN bytes. */
function parseGlb(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(dv.getUint32(0, true), 0x46546c67, 'magic glTF');
  assert.equal(dv.getUint32(4, true), 2, 'version 2');
  assert.equal(dv.getUint32(8, true), bytes.length, 'header length = file length');
  const jsonLen = dv.getUint32(12, true);
  assert.equal(dv.getUint32(16, true), 0x4e4f534a, 'first chunk is JSON');
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen)));
  const binAt = 20 + jsonLen;
  assert.equal(dv.getUint32(binAt + 4, true), 0x004e4942, 'second chunk is BIN');
  return { json, bin: bytes.subarray(binAt + 8, binAt + 8 + dv.getUint32(binAt, true)) };
}

test('e2e (offline): CHE\'s real character GLB uploaded by a worker reopens after a restart with the same SHA-256 and decodes as glTF 2.0', async () => {
  const glb = new Uint8Array(readFileSync(new URL('../../assets/characters/crew/che.glb', import.meta.url)));
  const m = new Map();
  let t = Date.parse('2026-10-25T06:00:00Z');
  const ctxOf = (storage) => ({ storage, env: {}, now: () => t });
  let ctx = ctxOf(durable(m));
  const call = async (path, method = 'GET', body) => {
    const res = await creationRoute(ctx, path, new Request(`https://che.example${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), body || {});
    return res.json();
  };
  const owner = (path, method = 'GET', body) => gpuOwnerRoute(ctx, path, new Request(`https://che.example${path}`, { method, body: body ? JSON.stringify(body) : undefined }), body || {});
  const p = (await call('/api/creations', 'POST', { base: 'che' })).project;
  const job = (await call(`/api/creations/${p.id}/generate`, 'POST', {})).job;
  const { token } = await (await owner('/api/gpu/worker-token', 'POST', {})).json();
  for (const j of (await (await owner('/api/gpu')).json()).jobs.filter((x) => x.id !== job.id)) await owner('/api/gpu/jobs/cancel', 'POST', { id: j.id });
  const worker = async (route, body, query = '', bytes = null) => (await gpuWorkerRoute(ctx, `/api/gpu/worker/${route}`, new Request(`https://che.example/api/gpu/worker/${route}${query}`, {
    method: bytes ? 'PUT' : 'POST', headers: { 'X-CHE-GPU-Token': token, 'Content-Type': bytes ? 'application/octet-stream' : 'application/json' }, body: bytes || JSON.stringify(body),
  }))).json();
  t += 1000;
  assert.equal((await worker('claim', { worker_id: 'cpu-1', gpu: 'Tesla T4, 550.54.15, 15360 MiB' })).job.id, job.id);
  const up = await worker('model', null, `?worker=cpu-1&job=${job.id}`, glb);
  assert.equal(up.ok, true, up.detail);
  const sha = createHash('sha256').update(glb).digest('hex');
  assert.equal(up.sha256, sha, 'the receipt hash is the file\'s own hash');

  ctx = ctxOf(durable(m)); // restart
  const project = (await call(`/api/creations/${p.id}`)).project;
  const served = await owner(project.model_url);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('Content-Type'), 'model/gltf-binary');
  const back = new Uint8Array(await served.arrayBuffer());
  assert.equal(createHash('sha256').update(back).digest('hex'), sha, 'reopened bytes match the receipt');
  const { json, bin } = parseGlb(back);
  assert.equal(json.asset.version, '2.0');
  assert.ok(json.meshes.length >= 1 && json.skins?.length >= 1, 'meshes and a skin (rig)');
  // Every POSITION accessor's float data lies inside the min/max the file declares: the binary is the real geometry.
  let vertices = 0;
  for (const mesh of json.meshes) for (const prim of mesh.primitives) {
    const acc = json.accessors[prim.attributes.POSITION];
    const view = json.bufferViews[acc.bufferView];
    const stride = view.byteStride || 12;
    const dv = new DataView(bin.buffer, bin.byteOffset + (view.byteOffset || 0) + (acc.byteOffset || 0));
    for (let i = 0; i < acc.count; i += Math.max(1, Math.floor(acc.count / 50))) {
      for (let c = 0; c < 3; c++) {
        const v = dv.getFloat32(i * stride + c * 4, true);
        assert.ok(Number.isFinite(v) && v >= acc.min[c] - 1e-4 && v <= acc.max[c] + 1e-4, `vertex ${i} axis ${c} inside the declared bounds`);
      }
    }
    vertices += acc.count;
  }
  assert.ok(vertices > 1000, `a real model, ${vertices} vertices`);
});

// ─── MP4: a real video in CHE's own store ────────────────────────────────

test('e2e (offline): a real MP4 in CHE\'s own store (no R2) reopens after a restart, is called playable, and its boxes decode', async () => {
  const mp4 = new Uint8Array(readFileSync(new URL('./fixtures/media/tiny.mp4', import.meta.url)));
  const m = new Map();
  assert.equal((await mediaStore({}, durable(m)).put('media/vid-e2e.mp4', mp4, { contentType: 'video/mp4' })).ok, true);
  const item = { id: 'vid-e2e', kind: 'video', mode: 'video', mime_type: 'video/mp4', title: 'E2E clip', created_at: '2026-10-25T06:00:00Z', blob: 'che_store', blob_key: 'media/vid-e2e.mp4' };
  const after = durable(m);
  const back = await readBlob({}, after, item);
  assert.deepEqual(new Uint8Array(back), mp4);
  assert.equal((await mediaLibraryReport({}, after, [item])).playable, 1);
  const facts = mp4Facts(new Uint8Array(back));
  assert.equal(facts.ok, true, JSON.stringify(facts));
  assert.deepEqual([facts.width, facts.height], [32, 32]);
});
