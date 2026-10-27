// A GitHub App installation token, minted on the Worker, for writing repository secrets (github_secrets.js).
// The owner installs the App on Vondada/chey-app once. CHE then signs a short JWT with the App's private key and
// exchanges it for an installation token that expires in about an hour and only covers the repositories named.
//   POST /app/installations/{installation_id}/access_tokens   (JWT authorization)
// https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app
//
// The private key, App ID and installation ID are Worker secrets. None of them, nor the minted token, is logged,
// returned to chat, or put in an error message.

const enc = new TextEncoder();
const DER_RSA_ALGORITHM = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function derLength(n) {
  if (n < 0x80) return [n];
  const bytes = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

function derTlv(tag, body) {
  return new Uint8Array([tag, ...derLength(body.length), ...body]);
}

// GitHub hands out PKCS#1 keys ("BEGIN RSA PRIVATE KEY"). WebCrypto imports PKCS#8, so wrap the key.
export function pkcs8FromPkcs1(pkcs1Der) {
  const version = derTlv(0x02, new Uint8Array([0x00]));
  const algorithm = derTlv(0x30, new Uint8Array(DER_RSA_ALGORITHM.slice(2)));
  return derTlv(0x30, new Uint8Array([...version, ...algorithm, ...derTlv(0x04, pkcs1Der)]));
}

export function derFromPem(pem) {
  const body = String(pem || '').replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  if (!body) throw new Error('empty key');
  const raw = atob(body);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// Signs { iss: appId, iat, exp } with RS256. Accepts PKCS#1 or PKCS#8 PEM, as GitHub and openssl produce.
export async function signAppJwt({ appId, privateKeyPem, nowSeconds = Math.floor(Date.now() / 1000) }) {
  const isPkcs1 = /BEGIN RSA PRIVATE KEY/.test(String(privateKeyPem || ''));
  let der = derFromPem(privateKeyPem);
  if (isPkcs1) der = pkcs8FromPkcs1(der);
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const header = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  // iat is back-dated 60 s for clock drift; the App JWT may live at most 10 minutes.
  const payload = b64url(enc.encode(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: String(appId) })));
  const input = `${header}.${payload}`;
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(input)));
  return `${input}.${b64url(sig)}`;
}

// Exchanges the App JWT for an installation token limited to `repositories` (repo names, not owner/name).
export async function mintInstallationToken({ appId, privateKeyPem, installationId, repositories, nowSeconds }, fetcher = fetch) {
  if (!appId || !privateKeyPem || !installationId) return { ok: false, status: 'not_configured', detail: 'The GitHub App is not set up. Its App ID, private key and installation ID are needed as Worker secrets.' };
  let jwt;
  try {
    jwt = await signAppJwt({ appId, privateKeyPem, nowSeconds });
  } catch (_) {
    return { ok: false, status: 'failed', detail: 'The GitHub App private key could not be read. Paste the full PEM file again.' };
  }
  let r;
  try {
    r = await fetcher(`https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
      method: 'POST',
      // GitHub rejects requests without a User-Agent, and a Worker fetch sends none by itself (review of #531).
      headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json', 'User-Agent': 'chey-app-worker' },
      body: JSON.stringify({ repositories: repositories || [] }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (_) {
    return { ok: false, status: 'failed', detail: 'GitHub could not be reached.' };
  }
  if (r.status === 401) return { ok: false, status: 'needs_setup', http: 401, detail: 'GitHub rejected the App signature (HTTP 401). Check the App ID and that the private key belongs to that App.' };
  if (r.status === 404) return { ok: false, status: 'needs_setup', http: 404, detail: 'GitHub cannot find that installation (HTTP 404). Install the App on the repository again and check the installation ID.' };
  if (!r.ok) return { ok: false, status: 'failed', http: r.status, detail: `GitHub did not issue an installation token (HTTP ${r.status}).` };
  const body = await r.json().catch(() => ({}));
  if (!body.token) return { ok: false, status: 'failed', detail: 'GitHub answered without a token.' };
  return { ok: true, status: 'ok', token: body.token, expires_at: body.expires_at || '' };
}
