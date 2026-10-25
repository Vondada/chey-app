import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey, verify } from 'node:crypto';
import { signAppJwt, mintInstallationToken, derFromPem, pkcs8FromPkcs1 } from './github_app.js';

const { privateKey: pkcs1Pem, publicKey } = (() => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privateKey: pair.privateKey.export({ type: 'pkcs1', format: 'pem' }), publicKey: pair.publicKey };
})();
const pkcs8Pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });

function verifyJwt(jwt, key) {
  const [h, p, s] = jwt.split('.');
  const ok = verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  return { ok, header: JSON.parse(Buffer.from(h, 'base64url')), payload: JSON.parse(Buffer.from(p, 'base64url')) };
}

test('the App JWT is RS256, signed by the App key, and valid for at most ten minutes', async () => {
  const now = 1_800_000_000;
  const jwt = await signAppJwt({ appId: '123456', privateKeyPem: pkcs1Pem, nowSeconds: now });
  const { ok, header, payload } = verifyJwt(jwt, publicKey);
  assert.equal(ok, true);
  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });
  assert.equal(payload.iss, '123456');
  assert.equal(payload.iat, now - 60);
  assert.ok(payload.exp - now <= 600);
});

test('a PKCS#8 key works as well as the PKCS#1 key GitHub issues', async () => {
  const jwt = await signAppJwt({ appId: '9', privateKeyPem: pkcs8Pem, nowSeconds: 1_800_000_000 });
  assert.equal(verifyJwt(jwt, createPublicKey(pkcs8Pem)).ok, true);
});

test('a PKCS#1 key is wrapped into the PKCS#8 structure WebCrypto needs', () => {
  const der = derFromPem(pkcs1Pem);
  const wrapped = pkcs8FromPkcs1(der);
  assert.equal(wrapped[0], 0x30);
  assert.ok(wrapped.length > der.length);
});

test('minting posts the JWT to the installation and restricts the token to the named repository', async () => {
  let call;
  const fetcher = async (url, init) => {
    call = { url, init };
    return new Response(JSON.stringify({ token: 'ghs_test_token_value', expires_at: '2026-10-25T16:00:00Z' }), { status: 201 });
  };
  const r = await mintInstallationToken({ appId: '5', privateKeyPem: pkcs1Pem, installationId: '777', repositories: ['chey-app'] }, fetcher);
  assert.equal(r.ok, true);
  assert.equal(r.token, 'ghs_test_token_value');
  assert.equal(call.url, 'https://api.github.com/app/installations/777/access_tokens');
  assert.equal(call.init.method, 'POST');
  assert.match(call.init.headers.Authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  assert.ok(call.init.headers['User-Agent'], 'GitHub requires a User-Agent header');
  assert.deepEqual(JSON.parse(call.init.body), { repositories: ['chey-app'] });
});

test('a rejected signature says to check the App ID and key, and leaks neither key nor token', async () => {
  const r = await mintInstallationToken({ appId: '5', privateKeyPem: pkcs1Pem, installationId: '777' }, async () => new Response('{"message":"Bad credentials"}', { status: 401 }));
  assert.equal(r.ok, false);
  assert.equal(r.status, 'needs_setup');
  assert.match(r.detail, /App ID/);
  assert.ok(!JSON.stringify(r).includes('BEGIN'));
});

test('a missing installation tells the owner to install the App', async () => {
  const r = await mintInstallationToken({ appId: '5', privateKeyPem: pkcs1Pem, installationId: '777' }, async () => new Response('{}', { status: 404 }));
  assert.equal(r.status, 'needs_setup');
  assert.match(r.detail, /Install the App/);
});

test('missing configuration is reported as not configured, without calling GitHub', async () => {
  let called = false;
  const r = await mintInstallationToken({ appId: '', privateKeyPem: pkcs1Pem, installationId: '777' }, async () => { called = true; return new Response('{}'); });
  assert.equal(r.status, 'not_configured');
  assert.equal(called, false);
});

test('an unreadable private key fails before any request is sent', async () => {
  let called = false;
  const r = await mintInstallationToken({ appId: '5', privateKeyPem: '-----BEGIN RSA PRIVATE KEY-----\n!!!\n-----END RSA PRIVATE KEY-----', installationId: '777' }, async () => { called = true; return new Response('{}'); });
  assert.equal(r.ok, false);
  assert.equal(called, false);
});

test('a network failure is reported plainly', async () => {
  const r = await mintInstallationToken({ appId: '5', privateKeyPem: pkcs1Pem, installationId: '777' }, async () => { throw new Error('socket hang up'); });
  assert.equal(r.ok, false);
  assert.match(r.detail, /could not be reached/);
});
