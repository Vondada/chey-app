// CHE's own file store: files round-trip in chunks, the cap is enforced before any write, and space comes back on delete.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CHUNK_BYTES, STORE_LIMIT_BYTES, deleteBlob, getBlob, headBlob, putBlob, usedBytes } from './che_blob_store.js';

// A storage with the same get/put/delete surface as Durable Object storage, kept in a Map.
function fakeStorage() {
  const m = new Map();
  return {
    m,
    get: async (k) => (m.has(k) ? structuredClone(m.get(k)) : undefined),
    put: async (k, v) => { m.set(k, v instanceof Uint8Array ? new Uint8Array(v) : structuredClone(v)); },
    delete: async (k) => m.delete(k),
  };
}

test('a file larger than one chunk comes back byte for byte', async () => {
  const s = fakeStorage();
  const bytes = Uint8Array.from({ length: CHUNK_BYTES * 2 + 123 }, (_, i) => (i * 31) % 251);
  assert.deepEqual(await putBlob(s, 'film/1/film.mp4', bytes, { contentType: 'video/mp4' }), { ok: true, size: bytes.length });
  const back = await getBlob(s, 'film/1/film.mp4');
  assert.equal(back.contentType, 'video/mp4');
  assert.equal(back.size, bytes.length);
  assert.deepEqual(back.body, bytes);
  assert.equal(await usedBytes(s), bytes.length);
});

test('a small picture stores as one chunk and its meta is readable without the body', async () => {
  const s = fakeStorage();
  await putBlob(s, 'film/1/stills/1.jpg', new Uint8Array([1, 2, 3]), { contentType: 'image/jpeg' });
  assert.deepEqual(await headBlob(s, 'film/1/stills/1.jpg'), { size: 3, contentType: 'image/jpeg' });
  assert.deepEqual([...(await getBlob(s, 'film/1/stills/1.jpg')).body], [1, 2, 3]);
});

test('a missing file reads as null, and a file with a lost chunk does not read back short', async () => {
  const s = fakeStorage();
  assert.equal(await getBlob(s, 'nope'), null);
  await putBlob(s, 'film/2/voice.mp3', new Uint8Array(CHUNK_BYTES + 5));
  s.m.delete('blob:film/2/voice.mp3:1');
  assert.equal(await getBlob(s, 'film/2/voice.mp3'), null);
});

test('replacing a file gives back the old space, so a retry does not count twice', async () => {
  const s = fakeStorage();
  await putBlob(s, 'film/3/clip.mp4', new Uint8Array(1000));
  await putBlob(s, 'film/3/clip.mp4', new Uint8Array(400));
  assert.equal(await usedBytes(s), 400);
  assert.equal((await getBlob(s, 'film/3/clip.mp4')).size, 400);
});

test('delete removes every chunk and returns the space', async () => {
  const s = fakeStorage();
  await putBlob(s, 'film/4/film.mp4', new Uint8Array(CHUNK_BYTES + 1));
  assert.equal(await deleteBlob(s, 'film/4/film.mp4'), true);
  assert.equal(await headBlob(s, 'film/4/film.mp4'), null);
  assert.equal(await usedBytes(s), 0);
  assert.equal([...s.m.keys()].some((k) => k.startsWith('blob:film/4/')), false);
  assert.equal(await deleteBlob(s, 'film/4/film.mp4'), false);
});

test('the cap is checked before anything is written: a refused file leaves storage untouched', async () => {
  const s = fakeStorage();
  await s.put('blob:used_bytes', STORE_LIMIT_BYTES - 10);
  const before = new Map(s.m);
  const res = await putBlob(s, 'film/5/film.mp4', new Uint8Array(11));
  assert.equal(res.ok, false);
  assert.match(res.error, /full/);
  assert.deepEqual(s.m, before);
});

test('empty and unnamed files are refused', async () => {
  const s = fakeStorage();
  assert.equal((await putBlob(s, 'x', new Uint8Array(0))).ok, false);
  assert.equal((await putBlob(s, '', new Uint8Array(3))).ok, false);
});
