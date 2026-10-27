// The media store: CHE's own store by default, R2 only when bound, the quota from config, and multipart assembly
// that refuses a bad part instead of writing a broken film.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CHUNK_BYTES } from './che_blob_store.js';
import { MAX_ASSEMBLE_BYTES, MEDIA_QUOTA_DEFAULT, MEDIA_QUOTA_MAX, assembleUpload, mediaProvider, mediaQuota, mediaStore, partKey, sha256Hex } from './che_media_store.js';

function fakeStorage() {
  const m = new Map();
  return {
    m,
    get: async (k) => (m.has(k) ? structuredClone(m.get(k)) : undefined),
    put: async (k, v) => { m.set(k, v instanceof Uint8Array ? new Uint8Array(v) : structuredClone(v)); },
    delete: async (k) => m.delete(k),
  };
}

// An R2-shaped bucket for the optional path.
function fakeBucket() {
  const m = new Map();
  return {
    m,
    put: async (k, v, o) => { m.set(k, { bytes: new Uint8Array(v), type: o?.httpMetadata?.contentType }); },
    get: async (k, o) => {
      const f = m.get(k); if (!f) return null;
      const bytes = o?.range ? f.bytes.subarray(0, o.range.length) : f.bytes;
      return { size: f.bytes.length, httpMetadata: { contentType: f.type }, arrayBuffer: async () => bytes.slice().buffer };
    },
    head: async (k) => (m.has(k) ? { size: m.get(k).bytes.length, httpMetadata: { contentType: m.get(k).type } } : null),
    delete: async (k) => { m.delete(k); },
  };
}

test('CHE\'s own store is the default; R2 is used only when a bucket is bound', () => {
  assert.equal(mediaProvider({}), 'che_store');
  assert.equal(mediaProvider({ CHE_DATA_BUCKET: fakeBucket() }), 'r2');
});

test('the quota is 512 MB by default, set by config, and never above 1 GB', () => {
  assert.equal(MEDIA_QUOTA_DEFAULT, 512 * 1024 * 1024);
  assert.equal(mediaQuota({}), MEDIA_QUOTA_DEFAULT);
  assert.equal(mediaQuota({ CHE_MEDIA_QUOTA_BYTES: '104857600' }), 104857600);
  assert.equal(mediaQuota({ CHE_MEDIA_QUOTA_BYTES: String(10 * 1024 ** 3) }), MEDIA_QUOTA_MAX);
  assert.equal(mediaQuota({ CHE_MEDIA_QUOTA_BYTES: 'nonsense' }), MEDIA_QUOTA_DEFAULT);
  assert.equal(mediaQuota({ CHE_MEDIA_QUOTA_BYTES: '-5' }), MEDIA_QUOTA_DEFAULT);
});

test('a write past the quota is refused before anything is stored', async () => {
  const s = fakeStorage();
  const media = mediaStore({ CHE_MEDIA_QUOTA_BYTES: '100' }, s);
  assert.equal((await media.put('film/1/stills/1.jpg', new Uint8Array(60))).ok, true);
  const before = new Map(s.m);
  const res = await media.put('film/1/stills/2.jpg', new Uint8Array(60));
  assert.equal(res.ok, false);
  assert.match(res.error, /full/);
  assert.deepEqual(s.m, before);
});

test('a picture, a voice clip and a film round-trip through CHE\'s store, with read-back', async () => {
  const media = mediaStore({}, fakeStorage());
  const picture = Uint8Array.from([0xff, 0xd8, 0xff, 1, 2, 3]);
  assert.equal((await media.put('film/9/stills/1.jpg', picture, { contentType: 'image/jpeg' })).ok, true);
  assert.deepEqual((await media.get('film/9/stills/1.jpg')).body, picture);
  assert.equal((await media.get('film/9/stills/1.jpg')).contentType, 'image/jpeg');
  const film = Uint8Array.from({ length: CHUNK_BYTES + 77 }, (_, i) => (i * 13) % 256);
  await media.put('film/9/film.mp4', film, { contentType: 'video/mp4' });
  assert.equal((await media.head('film/9/film.mp4')).size, film.length);
  assert.deepEqual((await media.get('film/9/film.mp4')).body, film);
  // A read of only the first bytes (the MP4 index check) returns just those bytes.
  assert.deepEqual((await media.get('film/9/film.mp4', { length: 100 })).body, film.subarray(0, 100));
  assert.equal(await media.delete('film/9/stills/1.jpg'), true);
  assert.equal(await media.get('film/9/stills/1.jpg'), null);
});

test('the R2 path behaves the same way for the same calls', async () => {
  const bucket = fakeBucket();
  const media = mediaStore({ CHE_DATA_BUCKET: bucket }, fakeStorage());
  assert.equal(media.provider, 'r2');
  await media.put('film/2/film.mp4', new Uint8Array([1, 2, 3, 4]), { contentType: 'video/mp4' });
  assert.deepEqual([...(await media.get('film/2/film.mp4', { length: 2 })).body], [1, 2]);
  assert.equal((await media.head('film/2/film.mp4')).contentType, 'video/mp4');
});

test('parts assemble into the exact file, and a checksum mismatch writes nothing', async () => {
  const storage = fakeStorage();
  const media = mediaStore({}, storage);
  const parts = [Uint8Array.from([1, 2, 3]), Uint8Array.from([4, 5]), Uint8Array.from([6])];
  const upload = { parts: {} };
  for (let i = 0; i < parts.length; i += 1) {
    await media.put(partKey('7', 'u1', i + 1), parts[i]);
    upload.parts[i + 1] = { etag: await sha256Hex(parts[i]), size: parts[i].length };
  }
  const claimed = upload.parts && [1, 2, 3].map((n) => ({ n, etag: upload.parts[n].etag }));
  const ok = await assembleUpload(media, { filmId: '7', uploadId: 'u1', upload, claimed, finalKey: 'film/7/film.mp4' });
  assert.equal(ok.ok, true);
  assert.equal(ok.size, 6);
  assert.deepEqual([...(await media.get('film/7/film.mp4')).body], [1, 2, 3, 4, 5, 6]);
  assert.equal(await media.get(partKey('7', 'u1', 1)), null, 'parts are removed after assembly');

  const bad = await assembleUpload(media, { filmId: '7', uploadId: 'u2', upload: { parts: { 1: { etag: 'x', size: 3 } } }, claimed: [{ n: 1, etag: 'x' }], finalKey: 'film/7/other.mp4' });
  assert.equal(bad.ok, false);
  assert.equal(await media.get('film/7/other.mp4'), null);
});

test('a gap, a wrong etag, or an oversize film is refused with a reason', async () => {
  const media = mediaStore({}, fakeStorage());
  const part = Uint8Array.from([9, 9]);
  await media.put(partKey('8', 'u', 1), part);
  await media.put(partKey('8', 'u', 3), part);
  const etag = await sha256Hex(part);
  const upload = { parts: { 1: { etag, size: 2 }, 3: { etag, size: 2 } } };
  const gap = await assembleUpload(media, { filmId: '8', uploadId: 'u', upload, claimed: [{ n: 1, etag }, { n: 3, etag }], finalKey: 'film/8/film.mp4' });
  assert.equal(gap.ok, false);
  assert.match(gap.error, /missing or out of order/);
  const wrong = await assembleUpload(media, { filmId: '8', uploadId: 'u', upload, claimed: [{ n: 1, etag: 'nope' }], finalKey: 'film/8/film.mp4' });
  assert.match(wrong.error, /does not match/);
  const big = { parts: { 1: { etag, size: MAX_ASSEMBLE_BYTES + 1 } } };
  const tooBig = await assembleUpload(media, { filmId: '8', uploadId: 'u', upload: big, claimed: [{ n: 1, etag }], finalKey: 'film/8/film.mp4' });
  assert.match(tooBig.error, /more than/);
});
