// One storage interface for films and their pictures, voices, clips and MP4s.
//
// CHE's own store (che_blob_store.js, in her Durable Object storage) is the default. It has a quota, set by
// CHE_MEDIA_QUOTA_BYTES and held at 512 MB unless the owner raises it up to 1 GB, and every write is checked against
// it before anything is written. R2 is used only when a bucket is bound as CHE_DATA_BUCKET; it is optional, and its
// capacity is the bucket's own, not this quota.
//
// Uploads arrive in parts. Each part is stored and checksummed (SHA-256) as it comes in, and the file is assembled
// only when every claimed part matches its checksum. Assembly is capped (MAX_ASSEMBLE_BYTES) so the whole film fits in
// Worker memory; a longer film is refused with a plain reason instead of failing partway.
import { deleteBlob, getBlob, headBlob, putBlob } from './che_blob_store.js';

export const MEDIA_QUOTA_DEFAULT = 512 * 1024 * 1024;
export const MEDIA_QUOTA_MAX = 1024 * 1024 * 1024;
export const MAX_ASSEMBLE_BYTES = 40 * 1024 * 1024;

/** The quota this Worker holds CHE's own store to: the configured value, kept between 1 byte and MEDIA_QUOTA_MAX. */
export function mediaQuota(env = {}) {
  const n = Number(env.CHE_MEDIA_QUOTA_BYTES);
  if (!Number.isFinite(n) || n <= 0) return MEDIA_QUOTA_DEFAULT;
  return Math.min(Math.floor(n), MEDIA_QUOTA_MAX);
}

/** Which backend is in use, and the quota for CHE's own store. */
export function mediaProvider(env = {}) {
  return env.CHE_DATA_BUCKET ? 'r2' : 'che_store';
}

/**
 * The store for one Worker request. Every caller uses this interface; none checks for R2 itself.
 *   put(key, bytes, { contentType }) -> { ok, size } | { ok: false, error }
 *   get(key, { length }) -> { body, contentType, size } | null
 *   head(key) -> { size, contentType } | null
 *   delete(key) -> boolean
 */
export function mediaStore(env = {}, storage) {
  const quota = mediaQuota(env);
  if (env.CHE_DATA_BUCKET) {
    const bucket = env.CHE_DATA_BUCKET;
    return {
      provider: 'r2',
      quota: null,
      async put(key, bytes, { contentType = 'application/octet-stream' } = {}) {
        try { await bucket.put(key, bytes, { httpMetadata: { contentType } }); return { ok: true, size: bytes.length }; }
        catch (error) { return { ok: false, error: `R2 refused the file: ${String(error?.message || error).slice(0, 120)}` }; }
      },
      async get(key, { length = null } = {}) {
        const obj = await bucket.get(key, length === null ? undefined : { range: { offset: 0, length } }).catch(() => null);
        if (!obj) return null;
        return { body: new Uint8Array(await obj.arrayBuffer()), contentType: obj.httpMetadata?.contentType || 'application/octet-stream', size: obj.size };
      },
      async head(key) {
        const h = await bucket.head(key).catch(() => null);
        return h ? { size: h.size, contentType: h.httpMetadata?.contentType || 'application/octet-stream' } : null;
      },
      async delete(key) { await bucket.delete(key).catch(() => null); return true; },
    };
  }
  return {
    provider: 'che_store',
    quota,
    put: (key, bytes, { contentType = 'application/octet-stream' } = {}) => putBlob(storage, key, bytes, { contentType, limit: quota }),
    get: (key, { length = null } = {}) => getBlob(storage, key, { length }),
    head: (key) => headBlob(storage, key),
    delete: (key) => deleteBlob(storage, key),
  };
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Where one uploaded part is kept until the file is assembled. */
export const partKey = (filmId, uploadId, n) => `film/${filmId}/upload/${uploadId}/${n}`;

/**
 * Builds the finished file from its stored parts. `upload.parts` is { [n]: { etag, size } } as the part route
 * recorded it; `claimed` is what the client says it sent, as [{ n, etag }]. Refuses unless the claimed parts are
 * 1..N with no gaps, every etag matches the stored one, and the total fits MAX_ASSEMBLE_BYTES. On success the file is
 * stored at finalKey, the parts are removed, and { ok, size, sha256 } comes back.
 */
export async function assembleUpload(media, { filmId, uploadId, upload, claimed, finalKey, contentType = 'video/mp4' }) {
  const list = (Array.isArray(claimed) ? claimed : []).map((p) => ({ n: Number(p.n), etag: String(p.etag || '') }));
  if (!list.length) return { ok: false, error: 'No parts were sent.' };
  list.sort((a, b) => a.n - b.n);
  for (let i = 0; i < list.length; i += 1) {
    if (list[i].n !== i + 1) return { ok: false, error: `Part ${i + 1} is missing or out of order.` };
    const stored = upload.parts?.[list[i].n];
    if (!stored || stored.etag !== list[i].etag) return { ok: false, error: `Part ${list[i].n} does not match what was uploaded.` };
  }
  const total = list.reduce((sum, p) => sum + upload.parts[p.n].size, 0);
  if (total > MAX_ASSEMBLE_BYTES) {
    return { ok: false, error: `The film is ${total} bytes, more than the ${MAX_ASSEMBLE_BYTES} that can be assembled in one step. Make it shorter or raise the limit.` };
  }
  const file = new Uint8Array(total);
  let at = 0;
  for (const p of list) {
    const part = await media.get(partKey(filmId, uploadId, p.n));
    if (!part || part.body.length !== upload.parts[p.n].size) return { ok: false, error: `Part ${p.n} could not be read back.` };
    if ((await sha256Hex(part.body)) !== p.etag) return { ok: false, error: `Part ${p.n} failed its checksum.` };
    file.set(part.body, at);
    at += part.body.length;
  }
  const saved = await media.put(finalKey, file, { contentType });
  if (!saved.ok) return { ok: false, error: saved.error };
  for (const p of list) await media.delete(partKey(filmId, uploadId, p.n));
  return { ok: true, size: total, sha256: await sha256Hex(file) };
}
