// Tenant object storage for CHE's creative assets (owner, 2026-10-24): videos, thumbnails, 3D models, music, images,
// temporary render files and Brain exports, laid out per tenant, uploaded directly and resumably, retained by class,
// and deleted completely with the account.
//
// - Keys: t/<tenant>/<class>/<yyyy-mm>/<asset id>/<file>. Every read, write and signed URL is checked against the
//   caller's tenant prefix (assertTenantKey), so one tenant can never name another tenant's object.
// - Direct uploads: R2's S3-compatible multipart API. The Worker only starts the upload, hands out short-lived signed
//   part URLs (AWS Signature V4, query auth) and completes it from the part ETags; the bytes go straight from the
//   phone or the render worker to R2, never through the Worker or any AI context. An interrupted upload resumes:
//   listParts shows which parts landed, and only the missing ones are signed again.
// - Encryption: R2 encrypts every object at rest. On top of that, each tenant has its own data key (AES-256-GCM),
//   stored only wrapped by the platform key (CHE_TENANT_KEK). Deleting an account destroys its wrapped key first, so
//   anything left in a backup is unreadable (crypto-shredding), then removes its objects and its Durable Object.
// - Availability: R2 is not enabled on CHE's Cloudflare account yet (the API answers "Please enable R2 through the
//   Cloudflare Dashboard") and no R2 API token exists. Enabling R2 and creating its token are the owner's decisions;
//   until then r2Status() says so and CHE keeps using its own store (che_media_store.js), whose uploads do pass
//   through the Worker and are capped at 40 MB per file.

export const CLASSES = Object.freeze({
  video: { retention_days: null, max_mb: 8192, types: ['video/mp4', 'video/quicktime', 'video/webm'] },
  thumbnail: { retention_days: null, max_mb: 10, types: ['image/jpeg', 'image/png', 'image/webp'] },
  model: { retention_days: null, max_mb: 512, types: ['model/gltf-binary', 'application/octet-stream'] },
  music: { retention_days: null, max_mb: 512, types: ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/flac', 'audio/aac'] },
  image: { retention_days: null, max_mb: 100, types: ['image/jpeg', 'image/png', 'image/webp'] },
  tmp: { retention_days: 7, max_mb: 16384, types: null },          // render segments, frames, stems: kept 7 days
  brain_export: { retention_days: 30, max_mb: 1024, types: ['application/json', 'application/zip'] },
});

export const PART_MB = 64;           // part size for multipart uploads (R2 allows 5 MiB-5 GiB per part, 10,000 parts)
export const URL_TTL_S = 3600;       // signed part URLs live one hour; a resumed upload gets fresh ones
const TENANT = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/** The object key for one file of one asset. Throws on anything that could escape the tenant's prefix. */
export function objectKey({ tenant, cls, id, name, at = new Date() }) {
  if (!TENANT.test(String(tenant || ''))) throw new Error('bad tenant id');
  if (!CLASSES[cls]) throw new Error(`unknown class ${cls}`);
  if (!ID.test(String(id || ''))) throw new Error('bad asset id');
  const file = String(name || 'file').normalize('NFKC').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file';
  const month = new Date(at).toISOString().slice(0, 7);
  return `t/${tenant}/${cls}/${month}/${id}/${file}`;
}

export const tenantPrefix = (tenant) => {
  if (!TENANT.test(String(tenant || ''))) throw new Error('bad tenant id');
  return `t/${tenant}/`;
};

/** A key may be used only by its own tenant, and never with a path trick. */
export function assertTenantKey(tenant, key) {
  const k = String(key || '');
  if (!k.startsWith(tenantPrefix(tenant)) || k.includes('..') || k.includes('//') || /[\u0000-\u001f\\]/.test(k)) {
    throw new Error('that object belongs to another account or is not a CHE key');
  }
  return k;
}

/** Plan a multipart upload: part count and size, or a plain refusal (class limit, type, R2's 10,000 parts). */
export function planUpload({ cls, bytes, type }) {
  const c = CLASSES[cls];
  if (!c) return { ok: false, reason: `Unknown kind of file: ${cls}.` };
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: 'The file size is missing.' };
  if (n > c.max_mb * 1024 * 1024) return { ok: false, reason: `A ${cls} file can be at most ${c.max_mb} MB; this one is ${Math.ceil(n / 1048576)} MB.` };
  if (c.types && type && !c.types.includes(type)) return { ok: false, reason: `A ${cls} file must be ${c.types.join(', ')}, not ${type}.` };
  const partBytes = PART_MB * 1024 * 1024;
  const parts = Math.max(1, Math.ceil(n / partBytes));
  if (parts > 10_000) return { ok: false, reason: 'That file needs more than 10,000 parts.' };
  return { ok: true, parts, part_bytes: partBytes, last_part_bytes: n - (parts - 1) * partBytes };
}

/** Keys whose class retention has passed (temporary render files after 7 days, Brain exports after 30). */
export function expiredKeys(objects = [], now = Date.now()) {
  const out = [];
  for (const o of objects) {
    const cls = String(o.key || '').split('/')[2];
    const days = CLASSES[cls]?.retention_days;
    if (days && now - Date.parse(o.uploaded) > days * 86_400_000) out.push(o.key);
  }
  return out;
}

/** Everything that holds a tenant's data, in the order account deletion removes it (crypto-shred first). */
export function deletionPlan(tenant) {
  const prefix = tenantPrefix(tenant);
  return [
    { step: 'destroy_data_key', what: `the wrapped data key of ${tenant} (makes any copy left in a backup unreadable)` },
    { step: 'cancel_jobs', what: 'queued, paused and running creation jobs of this tenant (workers are told to stop)' },
    { step: 'abort_uploads', what: `unfinished multipart uploads under ${prefix}` },
    { step: 'delete_objects', what: `every object under ${prefix} (videos, thumbnails, models, music, images, temporary files, exports)` },
    { step: 'delete_search_index', what: `the search index namespace tenant:${tenant}` },
    { step: 'delete_durable_object', what: `the Durable Object tenant:${tenant} (Brain, memories, preferences, projects)` },
    { step: 'receipt', what: 'a deletion receipt with counts and times, kept without any content' },
  ];
}

// ── Per-tenant data keys (envelope encryption, crypto-shredding) ────────────────────────────────────────────────

const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function kek(secret) {
  if (!secret || String(secret).length < 32) throw new Error('CHE_TENANT_KEK is not set (32+ characters)');
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(String(secret)));
  return crypto.subtle.importKey('raw', raw, 'AES-KW', false, ['wrapKey', 'unwrapKey']);
}

/** A new tenant data key, returned only wrapped (base64). Store it in the tenant's record; never store it unwrapped. */
export async function newTenantKey(secret) {
  const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  return b64(await crypto.subtle.wrapKey('raw', dek, await kek(secret), 'AES-KW'));
}

async function dekOf(secret, wrapped) {
  return crypto.subtle.unwrapKey('raw', unb64(wrapped), await kek(secret), 'AES-KW', { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Encrypt a record for one tenant; `aad` binds it to the tenant and purpose, so it cannot be replayed elsewhere. */
export async function sealForTenant(secret, wrapped, tenant, plaintext, purpose = 'brain') {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`${tenant}|${purpose}`) }, await dekOf(secret, wrapped), enc.encode(plaintext));
  return `v1.${b64(iv)}.${b64(ct)}`;
}

export async function openForTenant(secret, wrapped, tenant, sealed, purpose = 'brain') {
  const [v, iv, ct] = String(sealed).split('.');
  if (v !== 'v1') throw new Error('unknown envelope');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: enc.encode(`${tenant}|${purpose}`) }, await dekOf(secret, wrapped), unb64(ct));
  return new TextDecoder().decode(pt);
}

// ── AWS Signature V4 for R2's S3 API (no SDK) ──────────────────────────────────────────────────────────────────

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', typeof s === 'string' ? enc.encode(s) : s));
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(msg));
}
// RFC 3986 encoding as SigV4 requires (encodeURIComponent leaves !'()* alone).
const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encodePath = (p) => p.split('/').map(rfc3986).join('/');
const amzDate = (d) => d.toISOString().replace(/[:-]|\.\d{3}/g, '');

/**
 * A presigned URL (query-string auth). `host` e.g. "<account>.r2.cloudflarestorage.com", `path` "/<bucket>/<key>",
 * `region` "auto" for R2. Matches the AWS documentation example (object_storage.test.mjs pins it).
 */
export async function presignUrl({ method = 'GET', host, path, query = {}, accessKeyId, secretAccessKey, region = 'auto', service = 's3', expires = URL_TTL_S, now = new Date() }) {
  const date = amzDate(now); const day = date.slice(0, 8);
  const scope = `${day}/${region}/${service}/aws4_request`;
  const q = { ...query, 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${accessKeyId}/${scope}`, 'X-Amz-Date': date, 'X-Amz-Expires': String(expires), 'X-Amz-SignedHeaders': 'host' };
  const canonQuery = Object.keys(q).sort().map((k) => `${rfc3986(k)}=${rfc3986(String(q[k]))}`).join('&');
  const canonical = [method, encodePath(path), canonQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', date, scope, await sha256(canonical)].join('\n');
  let k = await hmac(`AWS4${secretAccessKey}`, day);
  for (const part of [region, service, 'aws4_request']) k = await hmac(k, part);
  const sig = hex(await hmac(k, toSign));
  return `https://${host}${encodePath(path)}?${canonQuery}&X-Amz-Signature=${sig}`;
}

/** Whether direct uploads to R2 are configured, and if not, exactly what is missing (no secret is ever returned). */
export function r2Status(env = {}) {
  const missing = ['CHE_R2_ACCOUNT_ID', 'CHE_R2_BUCKET', 'CHE_R2_ACCESS_KEY_ID', 'CHE_R2_SECRET_ACCESS_KEY'].filter((k) => !env[k]);
  if (!missing.length) return { ok: true, provider: 'r2', direct_uploads: true };
  return {
    ok: false, provider: 'che_store', direct_uploads: false, missing,
    reason: 'Direct uploads need Cloudflare R2, which is not enabled on CHE\'s account, and an R2 API token. Both are your decisions: R2\'s free tier is 10 GB-month with no egress fee, but enabling it asks for a billing profile. Until then files go through CHE\'s own store, up to 40 MB each.',
  };
}

/**
 * R2 multipart uploads, resumable. Every call names the tenant and is checked against its prefix. `fetcher` is
 * injectable for tests; the Worker sends only small control requests (start, list, complete, abort) itself.
 */
export class R2Multipart {
  constructor(env, { fetcher = fetch, now = () => new Date() } = {}) {
    const st = r2Status(env);
    if (!st.ok) throw new Error(st.reason);
    this.host = `${env.CHE_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    this.bucket = env.CHE_R2_BUCKET;
    this.creds = { accessKeyId: env.CHE_R2_ACCESS_KEY_ID, secretAccessKey: env.CHE_R2_SECRET_ACCESS_KEY };
    this.fetcher = fetcher; this.now = now;
  }

  url(method, key, query = {}, expires = URL_TTL_S) {
    return presignUrl({ method, host: this.host, path: `/${this.bucket}/${key}`, query, ...this.creds, expires, now: this.now() });
  }

  async control(method, key, query, body) {
    const r = await this.fetcher(await this.url(method, key, query, 300), { method, body, headers: body ? { 'Content-Type': 'application/xml' } : {} });
    const text = await r.text();
    if (!r.ok) throw new Error(`R2 answered ${r.status}: ${text.slice(0, 160)}`);
    return text;
  }

  /** Start: returns { upload_id, key, parts: [{ n, url }] } for a planned upload. */
  async start(tenant, key, plan, type = 'application/octet-stream') {
    assertTenantKey(tenant, key);
    const xml = await this.control('POST', key, { uploads: '' });
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(xml)?.[1];
    if (!uploadId) throw new Error('R2 did not return an upload id');
    return { upload_id: uploadId, key, type, parts: await this.partUrls(tenant, key, uploadId, range(1, plan.parts)) };
  }

  async partUrls(tenant, key, uploadId, numbers) {
    assertTenantKey(tenant, key);
    return Promise.all(numbers.map(async (n) => ({ n, url: await this.url('PUT', key, { partNumber: String(n), uploadId }) })));
  }

  /** Resume: which parts R2 already has, and fresh URLs for the rest. */
  async resume(tenant, key, uploadId, totalParts) {
    assertTenantKey(tenant, key);
    const xml = await this.control('GET', key, { uploadId });
    const have = new Map([...xml.matchAll(/<Part>[\s\S]*?<PartNumber>(\d+)<\/PartNumber>[\s\S]*?<ETag>([^<]+)<\/ETag>[\s\S]*?<\/Part>/g)].map((m) => [Number(m[1]), m[2]]));
    const missing = range(1, totalParts).filter((n) => !have.has(n));
    return { done: [...have.entries()].map(([n, etag]) => ({ n, etag })), parts: await this.partUrls(tenant, key, uploadId, missing) };
  }

  async complete(tenant, key, uploadId, parts) {
    assertTenantKey(tenant, key);
    const body = `<CompleteMultipartUpload>${[...parts].sort((a, b) => a.n - b.n).map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>${String(p.etag).replace(/[<&>]/g, '')}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
    await this.control('POST', key, { uploadId }, body);
    return { ok: true, key, parts: parts.length };
  }

  async abort(tenant, key, uploadId) {
    assertTenantKey(tenant, key);
    await this.control('DELETE', key, { uploadId });
    return { ok: true };
  }

  /** A short-lived download link for the tenant's own object (served by R2, not the Worker). */
  async downloadUrl(tenant, key, expires = 900) {
    assertTenantKey(tenant, key);
    return this.url('GET', key, {}, expires);
  }
}

const range = (a, b) => Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i);

// ── Per-tenant Durable Object (the Brain shard) ────────────────────────────────────────────────────────────────

/**
 * The Durable Object name that holds one tenant's Brain, memories, preferences and projects. The owner keeps the
 * existing 'owner' object; every other tenant gets its own object, so isolation is also the unit of scale (each
 * object has its own storage and its own ~1,000 requests/s). Routing live tenant traffic here is the next stage.
 */
export function tenantObjectName(tenant) {
  if (!tenant || tenant === 'owner' || tenant === 'owner-369') return 'owner';   // che_platform.js OWNER_TENANT_ID
  if (!TENANT.test(String(tenant))) throw new Error('bad tenant id');
  return `tenant:${tenant}`;
}
