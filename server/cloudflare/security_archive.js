// Security evidence is never erased automatically (owner, 2026-10-25). The live security lists stay small enough for one
// Durable Object value, so older events, audit rows and finished incidents move here, in order, in chunks of their own
// storage keys. Nothing in CHE deletes from the archive: there is no delete function. Retention can only change by an
// explicit owner action, confirmed first (AGENTS.md delete rule), which does not exist yet.
export const ARCHIVE_PREFIX = 'che:security_archive_v1:';
const META_KEY = `${ARCHIVE_PREFIX}meta`;
const CHUNK_BYTES = 90_000;

async function read(storage, key, fallback) {
  try { return (await storage.get(key)) ?? fallback; } catch (_) { return fallback; }
}

/** Appends records (each tagged with `kind`) to the archive. Returns how many were kept. */
export async function appendArchive(storage, kind, items = []) {
  const list = (Array.isArray(items) ? items : []).filter(Boolean);
  if (!list.length || !storage?.put) return 0;
  const meta = { chunks: 1, count: 0, first_at: null, last_at: null, ...(await read(storage, META_KEY, {})) };
  let index = meta.chunks - 1;
  let chunk = await read(storage, `${ARCHIVE_PREFIX}${index}`, []);
  const now = new Date().toISOString();
  for (const item of list) {
    const record = { kind, archived_at: now, ...item };
    if (chunk.length && JSON.stringify(chunk).length + JSON.stringify(record).length > CHUNK_BYTES) {
      await storage.put(`${ARCHIVE_PREFIX}${index}`, chunk);
      index += 1;
      chunk = [];
    }
    chunk.push(record);
    meta.count += 1;
    meta.first_at ||= now;
    meta.last_at = now;
  }
  await storage.put(`${ARCHIVE_PREFIX}${index}`, chunk);
  meta.chunks = index + 1;
  await storage.put(META_KEY, meta);
  return list.length;
}

/** How much is archived: counts and times only. */
export async function archiveSummary(storage) {
  const meta = await read(storage, META_KEY, null);
  return { count: meta?.count || 0, chunks: meta?.count ? meta.chunks : 0, first_at: meta?.first_at || null, last_at: meta?.last_at || null };
}

/** One page of the archive, newest page first (page 0 is the newest chunk). */
export async function readArchive(storage, page = 0) {
  const meta = await read(storage, META_KEY, null);
  if (!meta?.count) return { page: 0, pages: 0, records: [] };
  const p = Math.min(Math.max(0, Number(page) || 0), meta.chunks - 1);
  const records = await read(storage, `${ARCHIVE_PREFIX}${meta.chunks - 1 - p}`, []);
  return { page: p, pages: meta.chunks, records: [...records].reverse() };
}
