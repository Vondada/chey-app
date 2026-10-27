// GitHub Actions OIDC for the Creation Engine's cloud workers (owner, 2026-10-24: "she carries out the entire job").
// The che-creation-worker.yml run proves who it is with the short-lived ID token GitHub mints for that job
// (permissions: id-token: write), so no new secret exists anywhere: the Worker checks the RS256 signature against
// GitHub's published keys and then the claims that pin it to this repository's one workflow on main.
// Nothing here logs or stores the token; only the verified claims the queue needs (run id) leave this module.

export const OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
export const OIDC_JWKS_URL = `${OIDC_ISSUER}/.well-known/jwks`;
export const OIDC_AUDIENCE = 'che-creation-engine';
export const CREATION_REPO = 'Vondada/chey-app';
export const CREATION_WORKFLOW = 'che-creation-worker.yml';
export const CREATION_WORKFLOW_REF = `${CREATION_REPO}/.github/workflows/${CREATION_WORKFLOW}@refs/heads/main`;
export const JWKS_TTL_MS = 60 * 60_000;
export const SKEW_S = 60;

let jwksCache = null; // { keys, fetched_ms }

/** Tests only: forget the cached key set. */
export function resetOidcCache() { jwksCache = null; }

function b64urlBytes(s) {
  const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(s).length / 4) * 4, '='));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

async function fetchKeys(fetcher, now) {
  let res;
  try { res = await fetcher(OIDC_JWKS_URL, { headers: { Accept: 'application/json' } }); } catch (_) { return null; }
  if (!res?.ok) return null;
  const data = await res.json().catch(() => null);
  if (!Array.isArray(data?.keys)) return null;
  jwksCache = { keys: data.keys, fetched_ms: now };
  return jwksCache.keys;
}

/**
 * The JWK for `kid`: from the 1-hour cache, refetched once when the kid is unknown (GitHub rotated its keys), at most
 * once a minute so tokens with made-up key ids cannot make the Worker hammer GitHub.
 */
async function keyFor(kid, fetcher, now) {
  let keys = jwksCache && now - jwksCache.fetched_ms < JWKS_TTL_MS ? jwksCache.keys : await fetchKeys(fetcher, now);
  let jwk = keys?.find((k) => k.kid === kid);
  if (!jwk && keys && now - (jwksCache?.fetched_ms || 0) >= 60_000) { keys = await fetchKeys(fetcher, now); jwk = keys?.find((k) => k.kid === kid); }
  if (!keys) return { reason: 'GitHub\'s OIDC keys could not be fetched' };
  return jwk ? { jwk } : { reason: 'the token was signed with a key GitHub does not publish' };
}

/**
 * Verify a GitHub Actions OIDC ID token for the Creation Engine.
 * Returns { ok: true, claims } or { ok: false, reason } (a plain reason, never the token).
 */
export async function verifyGithubOidc(token, env = {}, { fetcher = fetch, now = Date.now() } = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[\w-]*$/.test(p))) return { ok: false, reason: 'not a JWT' };
  let header; let claims;
  try { header = b64urlJson(parts[0]); claims = b64urlJson(parts[1]); } catch (_) { return { ok: false, reason: 'not a JWT' }; }
  if (header?.alg !== 'RS256' || !header.kid) return { ok: false, reason: 'the token is not RS256 with a key id' };
  const found = await keyFor(header.kid, fetcher, now);
  if (!found.jwk) return { ok: false, reason: found.reason };
  let valid = false;
  try {
    const { kty, n, e } = found.jwk;
    const key = await crypto.subtle.importKey('jwk', { kty, n, e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch (_) { valid = false; }
  if (!valid) return { ok: false, reason: 'the signature does not verify' };
  const t = Math.floor(now / 1000);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== OIDC_ISSUER) return { ok: false, reason: 'wrong issuer' };
  if (!aud.includes(OIDC_AUDIENCE)) return { ok: false, reason: 'wrong audience' };
  if (!(Number(claims.exp) > t - SKEW_S)) return { ok: false, reason: 'the token expired' };
  if (claims.nbf !== undefined && Number(claims.nbf) > t + SKEW_S) return { ok: false, reason: 'the token is not valid yet' };
  if (claims.iat !== undefined && Number(claims.iat) > t + SKEW_S) return { ok: false, reason: 'the token was issued in the future' };
  if (String(claims.repository || '').toLowerCase() !== CREATION_REPO.toLowerCase()) return { ok: false, reason: 'wrong repository' };
  // Exactly the creation workflow on main: a branch, a tag or another workflow in the same repository is refused.
  if (claims.workflow_ref !== CREATION_WORKFLOW_REF) return { ok: false, reason: 'not the creation workflow on main' };
  if (claims.ref !== undefined && claims.ref !== 'refs/heads/main') return { ok: false, reason: 'not the main branch' };
  if (!/^\d{1,20}$/.test(String(claims.run_id || ''))) return { ok: false, reason: 'the token names no workflow run' };
  return { ok: true, claims: { repository: claims.repository, workflow_ref: claims.workflow_ref, run_id: String(claims.run_id), run_attempt: String(claims.run_attempt || '1'), sha: String(claims.sha || '').slice(0, 40) } };
}
