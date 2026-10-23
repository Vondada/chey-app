// CHE's own file store, kept in her Durable Object storage: the stand-in for an R2 bucket when none is bound.
// Films and their pictures, voices and clips are written here in chunks, each under the storage value limit,
// and read back whole. Nothing here calls a bucket or a paid service.
//
// Layout (all under the `blob:` prefix, so it never collides with film or brain keys):
//   blob:<key>:meta     { size, contentType, chunks, chunkBytes }
//   blob:<key>:<i>      one Uint8Array of at most CHUNK_BYTES
//
// Free-tier guard: every put is checked against STORE_LIMIT_BYTES before anything is written, so a film that would
// take CHE past her own cap is refused with a plain reason instead of silently filling storage.

export const CHUNK_BYTES = 1024 * 1024;
// The most this store may hold. Set below the free storage allowance on purpose; the owner should confirm the current
// Durable Object storage allowance on the Cloudflare dashboard and lower this if it is smaller.
export const STORE_LIMIT_BYTES = 1024 * 1024 * 1024;
export const USED_KEY = 'blob:used_bytes';

const metaKey = (key) => `blob:${key}:meta`;
const chunkKey = (key, i) => `blob:${key}:${i}`;

/** Bytes this store holds now, from the running total kept beside the files. */
export async function usedBytes(storage) {
  return Number((await storage.get(USED_KEY)) || 0);
}

/**
 * Writes one file. Replaces an existing file with the same key and gives its space back first.
 * Returns { ok, size } or { ok: false, error } and writes nothing when the cap would be passed.
 */
export async function putBlob(storage, key, bytes, { contentType = 'application/octet-stream', limit = STORE_LIMIT_BYTES } = {}) {
  if (!key || !(bytes instanceof Uint8Array) || bytes.length === 0) return { ok: false, error: 'Nothing to store.' };
  const old = await headBlob(storage, key);
  const used = (await usedBytes(storage)) - (old ? old.size : 0);
  if (used + bytes.length > limit) {
    return { ok: false, error: `CHE's own storage is full: ${used + bytes.length} bytes would pass the ${limit}-byte cap.` };
  }
  if (old) await deleteBlob(storage, key);
  const chunks = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));
  for (let i = 0; i < chunks; i += 1) {
    await storage.put(chunkKey(key, i), bytes.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES));
  }
  await storage.put(metaKey(key), { size: bytes.length, contentType, chunks, chunkBytes: CHUNK_BYTES });
  await storage.put(USED_KEY, used + bytes.length);
  return { ok: true, size: bytes.length };
}

/** The file's size and type, or null. Reads only the small meta record. */
export async function headBlob(storage, key) {
  const meta = await storage.get(metaKey(key));
  return meta && Number.isFinite(meta.size) ? { size: meta.size, contentType: meta.contentType } : null;
}

/**
 * The file as bytes with its type, or null when it is missing or a chunk is gone. With `length`, only the first
 * `length` bytes are read (the film check reads a file's index this way, so a large film is never loaded whole).
 */
export async function getBlob(storage, key, { length = null } = {}) {
  const meta = await storage.get(metaKey(key));
  if (!meta) return null;
  const want = length === null ? meta.size : Math.min(meta.size, Math.max(0, length));
  const body = new Uint8Array(want);
  let at = 0;
  for (let i = 0; i < meta.chunks && at < want; i += 1) {
    const part = await storage.get(chunkKey(key, i));
    if (!(part instanceof Uint8Array)) return null;
    const take = part.subarray(0, Math.min(part.length, want - at));
    body.set(take, at);
    at += take.length;
  }
  return at === want ? { body, contentType: meta.contentType, size: meta.size } : null;
}

/** Removes a file and gives its space back. Returns true when something was removed. */
export async function deleteBlob(storage, key) {
  const meta = await storage.get(metaKey(key));
  if (!meta) return false;
  for (let i = 0; i < meta.chunks; i += 1) await storage.delete(chunkKey(key, i));
  await storage.delete(metaKey(key));
  await storage.put(USED_KEY, Math.max(0, (await usedBytes(storage)) - meta.size));
  return true;
}
