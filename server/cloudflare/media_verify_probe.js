// Read-only check of one Gallery piece, for the owner probe route (POST /api/probe/media/verify). It reports whether the
// piece is listed in the Gallery index, the SHA-256 and byte count of the bytes the Gallery would serve, and whether the
// record's own sha256 matches. It writes nothing, sends no prompt and spends nothing.
import { listMedia, readBlob } from './media.js';

const ID = /^[A-Za-z0-9-]{8,64}$/;

export async function mediaVerifyProbe(env, storage, body = {}) {
  const id = String(body?.id || '');
  if (!ID.test(id)) return { ok: false, status: 400, detail: 'A media id is required.' };
  const items = await listMedia(storage);
  const item = items.find((entry) => entry.id === id);
  if (!item) return { ok: false, status: 404, listed: false, gallery_items: items.length, detail: 'That piece is not in the Gallery index.' };
  const bytes = await readBlob(env, storage, item);
  if (!bytes) return { ok: false, status: 404, listed: true, detail: 'The piece is listed, but its bytes are missing.' };
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return {
    ok: true, status: 200, listed: true, gallery_items: items.length,
    id: item.id, title: item.title || null, mime_type: item.mime_type || null,
    bytes: bytes.length, sha256,
    record_sha256: item.sha256 || null,
    record_sha256_matches: item.sha256 ? item.sha256 === sha256 : null,
    png_signature: bytes.length > 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71,
  };
}
