// CHE's own code search. One download of the repository per commit (GitHub's
// tarball: a single request, ~4 MB), unpacked on the Worker and searched
// locally. No GitHub code-search rate limit (10/minute), no stale or partial
// search index: the text is exactly what is at that commit.

const CACHE = new Map(); // sha -> index (lives while the Durable Object is warm)
const META_KEY = 'codeidx_meta';
const CHUNK_PREFIX = 'codeidx:';
const CHUNK_CHARS = 900_000; // well under the Durable Object value limit
const MAX_FILE_BYTES = 1_000_000;
const TEXT_FILE = /\.(?:dart|m?js|cjs|ts|tsx|jsx|html|css|json|jsonc|ya?ml|md|swift|kt|kts|gradle|java|m|mm|h|plist|xml|txt|sql|sh|toml|arb|pbxproj)$/i;

function repoOf(env) {
  const repo = String(env?.CHE_GITHUB_REPO || '').trim();
  return env?.CHE_GITHUB_TOKEN && /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : '';
}

// Minimal ustar/pax reader: regular files only, top folder ("owner-repo-sha/") removed.
export function parseTar(bytes) {
  const files = [];
  const dec = new TextDecoder();
  let off = 0;
  let paxPath = null;
  while (off + 512 <= bytes.length) {
    const header = bytes.subarray(off, off + 512);
    if (header[0] === 0) break;
    const field = (a, b) => dec.decode(header.subarray(a, b)).replace(/\0[\s\S]*$/, '');
    const name = field(0, 100);
    const size = parseInt(field(124, 136).trim() || '0', 8) || 0;
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const prefix = field(345, 500);
    const start = off + 512;
    const data = bytes.subarray(start, start + size);
    if (type === 'x') {
      const m = /\d+ path=([^\n]+)\n/.exec(dec.decode(data));
      paxPath = m ? m[1] : null;
    } else if (type === '0') {
      const full = paxPath || (prefix ? `${prefix}/${name}` : name);
      const path = full.split('/').slice(1).join('/');
      if (path) files.push({ path, data });
      paxPath = null;
    } else if (type !== 'g') {
      paxPath = null;
    }
    off = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

async function gunzip(buffer) {
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function isText(path, data) {
  if (!TEXT_FILE.test(path) || data.length > MAX_FILE_BYTES || /\.min\.js$/.test(path)) return false;
  for (let i = 0; i < Math.min(data.length, 2048); i += 1) if (data[i] === 0) return false;
  return true;
}

// Git's blob id for a file's content, so stale-source checks keep working
// when files are read from the index instead of the contents API.
export async function gitBlobSha(text) {
  return gitBlobShaBytes(new TextEncoder().encode(String(text)));
}

export async function gitBlobShaBytes(body) {
  const head = new TextEncoder().encode(`blob ${body.length}\0`);
  const all = new Uint8Array(head.length + body.length);
  all.set(head);
  all.set(body, head.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', all));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// entries: [path, text, blobSha?]
export function makeIndex(sha, entries) {
  const files = new Map(entries.map(([path, text]) => [path, text]));
  const blobs = new Map(entries.filter((entry) => entry[2]).map(([path, , blob]) => [path, blob]));
  const lower = new Map([...files].map(([path, text]) => [path, text.toLowerCase()]));
  return {
    sha,
    size: files.size,
    has: (path) => files.has(path),
    text: (path) => files.get(path) ?? null,
    blobSha: (path) => blobs.get(path) || null,
    paths: () => [...files.keys()],
    // Exact, case-insensitive substring search (what GitHub code search was
    // used for), every file at this commit, no limit.
    search(needle, { limit = 50, filter = null } = {}) {
      const q = String(needle || '').toLowerCase();
      if (q.length < 2) return [];
      const out = [];
      for (const [path, text] of lower) {
        if (filter && !filter(path)) continue;
        if (text.includes(q)) out.push(path);
        if (out.length >= limit) break;
      }
      return out;
    },
  };
}

export async function buildCodeIndex(env, sha, fetcher = fetch) {
  const repo = repoOf(env);
  if (!repo || !sha) return null;
  const response = await fetcher(`https://api.github.com/repos/${repo}/tarball/${encodeURIComponent(sha)}`, {
    headers: { Authorization: `Bearer ${env.CHE_GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'CHE-Agent' },
    redirect: 'follow',
  });
  if (!response.ok) return null;
  const tar = await gunzip(await response.arrayBuffer());
  // Keep a BOM if a file has one, and take git's blob id from the raw bytes,
  // so contents and ids match GitHub exactly.
  const dec = new TextDecoder('utf-8', { ignoreBOM: true });
  const entries = [];
  for (const file of parseTar(tar)) {
    if (!isText(file.path, file.data)) continue;
    entries.push([file.path, dec.decode(file.data), await gitBlobShaBytes(file.data)]);
  }
  return entries.length ? makeIndex(sha, entries) : null;
}

/**
 * The index for `sha`: memory first, then Durable Object storage, else one
 * tarball download (then saved, replacing the previous commit's index).
 * Returns null when it cannot be built; callers fall back to GitHub search.
 */
export async function loadCodeIndex(storage, env, sha, fetcher = fetch) {
  if (!sha) return null;
  if (CACHE.has(sha)) return CACHE.get(sha);
  const meta = storage?.get ? await Promise.resolve().then(() => storage.get(META_KEY)).catch(() => null) : null;
  if (meta?.sha === sha && Number(meta.chunks) > 0) {
    const parts = [];
    for (let i = 0; i < meta.chunks; i += 1) parts.push(await storage.get(`${CHUNK_PREFIX}${i}`));
    if (parts.every(Array.isArray)) {
      const index = makeIndex(sha, parts.flat());
      CACHE.clear();
      CACHE.set(sha, index);
      return index;
    }
  }
  const built = await buildCodeIndex(env, sha, fetcher).catch(() => null);
  if (!built) return null;
  CACHE.clear();
  CACHE.set(sha, built);
  if (storage?.put) {
    const chunks = [];
    let current = [];
    let size = 0;
    for (const path of built.paths()) {
      const text = built.text(path);
      if (size + text.length > CHUNK_CHARS && current.length) { chunks.push(current); current = []; size = 0; }
      current.push([path, text, built.blobSha(path)]);
      size += text.length;
    }
    if (current.length) chunks.push(current);
    const writes = Object.fromEntries(chunks.map((chunk, i) => [`${CHUNK_PREFIX}${i}`, chunk]));
    await Promise.resolve().then(() => storage.put(writes)).catch(() => null);
    const stale = Number(meta?.chunks || 0);
    for (let i = chunks.length; i < stale; i += 1) await Promise.resolve().then(() => storage.delete?.(`${CHUNK_PREFIX}${i}`)).catch(() => null);
    await Promise.resolve().then(() => storage.put(META_KEY, { sha, chunks: chunks.length, files: built.size, built_at: new Date().toISOString() })).catch(() => null);
  }
  return built;
}

/** The index for exactly this commit if it is loaded, else null. */
export function cachedCodeIndex(sha) { return (sha && CACHE.get(sha)) || null; }

export function _clearCodeIndexCache() { CACHE.clear(); }
