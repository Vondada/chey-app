// Test helper (not deployed): signs GitHub-style OIDC ID tokens with a locally generated RSA key, for gpu_oidc,
// gpu_queue and creation_orchestrator tests. The JWK it returns is what a fake JWKS fetcher serves.
import { CREATION_WORKFLOW_REF, OIDC_AUDIENCE, OIDC_ISSUER } from './gpu_oidc.js';

export const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

export async function oidcSigner(kid = 'k1') {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const jwk = { kty: 'RSA', n: pub.n, e: pub.e, kid, alg: 'RS256', use: 'sig' };
  const sign = async (over = {}, nowS = Math.floor(Date.now() / 1000), headerOver = {}) => {
    const claims = { iss: OIDC_ISSUER, aud: OIDC_AUDIENCE, repository: 'Vondada/chey-app', workflow_ref: CREATION_WORKFLOW_REF, ref: 'refs/heads/main',
      run_id: '987654321', run_attempt: '1', sha: 'a'.repeat(40), iat: nowS, nbf: nowS - 5, exp: nowS + 300, ...over };
    const head = enc({ alg: 'RS256', typ: 'JWT', kid, ...headerOver }); const body = enc(claims);
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${Buffer.from(sig).toString('base64url')}`;
  };
  return { jwk, sign };
}
