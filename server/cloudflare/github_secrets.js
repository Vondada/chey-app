// GitHub Actions repository secrets, written the way GitHub documents it:
//   GET  /repos/{owner}/{repo}/actions/secrets/public-key   (Secrets: read)
//   PUT  /repos/{owner}/{repo}/actions/secrets/{name}       (Secrets: write)
// The value is encrypted on the Worker with a libsodium sealed box
// (crypto_box_seal: X25519 + XSalsa20-Poly1305, nonce = BLAKE2b-192(epk || pk))
// before it leaves, so GitHub only ever receives ciphertext.
// https://docs.github.com/en/rest/actions/secrets#create-or-update-a-repository-secret
//
// The secret value is never logged, returned or put in an error message.

import nacl from './vendor_tweetnacl.js';

// ─── BLAKE2b (RFC 7693), unkeyed, any digest length 1..64 ─────────────────
const MASK = (1n << 64n) - 1n;
const IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4], [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13], [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11], [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5], [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];
const rotr = (x, n) => ((x >> n) | (x << (64n - n))) & MASK;

function compress(h, block, t, last) {
  const m = [];
  for (let i = 0; i < 16; i++) {
    let w = 0n;
    for (let b = 7; b >= 0; b--) w = (w << 8n) | BigInt(block[i * 8 + b]);
    m.push(w);
  }
  const v = [...h, ...IV];
  v[12] ^= t & MASK;
  v[13] ^= t >> 64n;
  if (last) v[14] ^= MASK;
  const g = (a, b, c, d, x, y) => {
    v[a] = (v[a] + v[b] + x) & MASK; v[d] = rotr(v[d] ^ v[a], 32n);
    v[c] = (v[c] + v[d]) & MASK; v[b] = rotr(v[b] ^ v[c], 24n);
    v[a] = (v[a] + v[b] + y) & MASK; v[d] = rotr(v[d] ^ v[a], 16n);
    v[c] = (v[c] + v[d]) & MASK; v[b] = rotr(v[b] ^ v[c], 63n);
  };
  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r % 10];
    g(0, 4, 8, 12, m[s[0]], m[s[1]]); g(1, 5, 9, 13, m[s[2]], m[s[3]]);
    g(2, 6, 10, 14, m[s[4]], m[s[5]]); g(3, 7, 11, 15, m[s[6]], m[s[7]]);
    g(0, 5, 10, 15, m[s[8]], m[s[9]]); g(1, 6, 11, 12, m[s[10]], m[s[11]]);
    g(2, 7, 8, 13, m[s[12]], m[s[13]]); g(3, 4, 9, 14, m[s[14]], m[s[15]]);
  }
  for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
}

export function blake2b(input, outlen = 64) {
  if (!(outlen >= 1 && outlen <= 64)) throw new RangeError('blake2b digest length must be 1..64');
  const data = input instanceof Uint8Array ? input : new TextEncoder().encode(String(input));
  const h = [...IV];
  h[0] ^= 0x01010000n ^ BigInt(outlen);
  let t = 0n;
  let offset = 0;
  // Every full block except the last is compressed as "not last".
  while (data.length - offset > 128) {
    t += 128n;
    compress(h, data.subarray(offset, offset + 128), t, false);
    offset += 128;
  }
  const last = new Uint8Array(128);
  last.set(data.subarray(offset));
  t += BigInt(data.length - offset);
  compress(h, last, t, true);
  const out = new Uint8Array(outlen);
  for (let i = 0; i < outlen; i++) out[i] = Number((h[i >> 3] >> BigInt(8 * (i & 7))) & 0xffn);
  return out;
}

// ─── Sealed box (libsodium crypto_box_seal / crypto_box_seal_open) ───────
function sealNonce(epk, pk) {
  const both = new Uint8Array(64);
  both.set(epk, 0);
  both.set(pk, 32);
  return blake2b(both, 24);
}

export function sealedBox(message, recipientPublicKey) {
  const pk = recipientPublicKey;
  if (!(pk instanceof Uint8Array) || pk.length !== 32) throw new TypeError('A 32-byte X25519 public key is required.');
  const msg = message instanceof Uint8Array ? message : new TextEncoder().encode(String(message));
  const eph = nacl.box.keyPair();
  const boxed = nacl.box(msg, sealNonce(eph.publicKey, pk), pk, eph.secretKey);
  eph.secretKey.fill(0);
  const out = new Uint8Array(32 + boxed.length);
  out.set(eph.publicKey, 0);
  out.set(boxed, 32);
  return out;
}

export function sealedBoxOpen(sealed, publicKey, secretKey) {
  if (!(sealed instanceof Uint8Array) || sealed.length < 48) return null;
  const epk = sealed.subarray(0, 32);
  return nacl.box.open(sealed.subarray(32), sealNonce(epk, publicKey), epk, secretKey);
}

const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (text) => Uint8Array.from(atob(String(text || '')), (c) => c.charCodeAt(0));

// ─── GitHub REST ─────────────────────────────────────────────────────────
function headers(token) {
  return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'CHE-Service-Onboarding', 'Content-Type': 'application/json' };
}

const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,99}$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;

// Writes one repository secret. Returns an outcome that never contains the value:
//   { ok: true, status: 'configured', created }                 GitHub stored it
//   { ok: false, status: 'needs_permission', accepted, http }    the token lacks Secrets read/write
//   { ok: false, status: 'not_configured' | 'failed', detail }
export async function putRepositorySecret({ token, repo, name, value }, fetcher = fetch) {
  if (!token) return { ok: false, status: 'not_configured', detail: 'CHE has no GitHub token (CHE_GITHUB_TOKEN) to write repository secrets with.' };
  if (!REPO.test(String(repo || ''))) return { ok: false, status: 'not_configured', detail: 'CHE_GITHUB_REPO is not set to owner/name.' };
  if (!SECRET_NAME.test(String(name || ''))) return { ok: false, status: 'failed', detail: 'That is not a valid GitHub secret name.' };
  if (!value) return { ok: false, status: 'failed', detail: 'There is no value to store.' };
  const base = `https://api.github.com/repos/${repo}/actions/secrets`;
  const denied = (r) => ({ ok: false, status: 'needs_permission', http: r.status, accepted: r.headers?.get?.('x-accepted-github-permissions') || '',
    detail: `GitHub refused (HTTP ${r.status}). CHE_GITHUB_TOKEN needs the repository permission "Secrets: Read and write" on ${repo}; only you can grant that.` });
  let key;
  try {
    const r = await fetcher(`${base}/public-key`, { headers: headers(token), signal: AbortSignal.timeout(10000) });
    if (r.status === 401 || r.status === 403 || r.status === 404) return denied(r);
    if (!r.ok) return { ok: false, status: 'failed', http: r.status, detail: `GitHub did not give the repository's secret key (HTTP ${r.status}).` };
    key = await r.json();
  } catch (_) {
    return { ok: false, status: 'failed', detail: 'GitHub could not be reached.' };
  }
  const pk = unb64(key?.key);
  if (pk.length !== 32 || !key?.key_id) return { ok: false, status: 'failed', detail: 'GitHub returned an unexpected secret key.' };
  const encrypted = b64(sealedBox(String(value), pk));
  try {
    const r = await fetcher(`${base}/${name}`, { method: 'PUT', headers: headers(token), body: JSON.stringify({ encrypted_value: encrypted, key_id: String(key.key_id) }), signal: AbortSignal.timeout(10000) });
    if (r.status === 201 || r.status === 204) return { ok: true, status: 'configured', created: r.status === 201 };
    if (r.status === 401 || r.status === 403 || r.status === 404) return denied(r);
    return { ok: false, status: 'failed', http: r.status, detail: `GitHub did not store the secret (HTTP ${r.status}).` };
  } catch (_) {
    return { ok: false, status: 'failed', detail: 'GitHub could not be reached while storing the secret.' };
  }
}
