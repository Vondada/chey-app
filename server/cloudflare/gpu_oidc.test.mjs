// GitHub Actions OIDC for the Creation Engine (gpu_oidc.js): tokens are signed here with a locally generated RSA key
// and served through a fake JWKS fetcher, so nothing reaches the network.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CREATION_WORKFLOW_REF, OIDC_JWKS_URL, resetOidcCache, verifyGithubOidc } from './gpu_oidc.js';
import { enc, oidcSigner } from './oidc_test_signer.mjs';

function fakeFetcher(jwks) {
  const calls = [];
  const fetcher = async (url) => { calls.push(String(url)); return new Response(JSON.stringify({ keys: jwks() }), { status: 200 }); };
  return { fetcher, calls };
}

test('a token from the creation workflow on main verifies; claims carry the run id; keys are cached', async () => {
  resetOidcCache();
  const s = await oidcSigner();
  const { fetcher, calls } = fakeFetcher(() => [s.jwk]);
  const now = Date.now();
  const v = await verifyGithubOidc(await s.sign(), {}, { fetcher, now });
  assert.equal(v.ok, true, v.reason); assert.equal(v.claims.run_id, '987654321');
  assert.equal((await verifyGithubOidc(await s.sign(), {}, { fetcher, now: now + 1000 })).ok, true);
  assert.deepEqual(calls, [OIDC_JWKS_URL], 'one key fetch, then the 1-hour cache');
  await verifyGithubOidc(await s.sign({}, Math.floor(now / 1000) + 3700), {}, { fetcher, now: now + 3700_000 });
  assert.equal(calls.length, 2, 'refetched after an hour');
});

test('wrong audience, repository, workflow, branch, expiry, signature and unknown keys are refused with a reason', async () => {
  resetOidcCache();
  const s = await oidcSigner(); const other = await oidcSigner('k1');
  const { fetcher } = fakeFetcher(() => [s.jwk]);
  const now = Date.now(); const t = Math.floor(now / 1000);
  const cases = [
    [{ aud: 'sts.amazonaws.com' }, /wrong audience/],
    [{ repository: 'someone/chey-app' }, /wrong repository/],
    [{ workflow_ref: 'Vondada/chey-app/.github/workflows/che-video-render.yml@refs/heads/main' }, /creation workflow on main/],
    [{ workflow_ref: 'Vondada/chey-app/.github/workflows/che-creation-worker.yml@refs/heads/feature' }, /creation workflow on main/],
    [{ workflow_ref: `${CREATION_WORKFLOW_REF}-evil` }, /creation workflow on main/],
    [{ ref: 'refs/heads/feature' }, /main branch/],
    [{ exp: t - 61 }, /expired/],
    [{ nbf: t + 120 }, /not valid yet/],
    [{ iss: 'https://evil.example' }, /wrong issuer/],
    [{ run_id: 'x' }, /no workflow run/],
  ];
  for (const [over, re] of cases) {
    const v = await verifyGithubOidc(await s.sign(over, t), {}, { fetcher, now });
    assert.equal(v.ok, false, JSON.stringify(over)); assert.match(v.reason, re, JSON.stringify(over));
  }
  assert.equal((await verifyGithubOidc(await s.sign({ exp: t - 30 }, t), {}, { fetcher, now })).ok, true, '60 s clock skew allowed');
  const forged = await other.sign({}, t);
  assert.match((await verifyGithubOidc(forged, {}, { fetcher, now })).reason, /signature does not verify/);
  const tampered = (await s.sign({}, t)).split('.'); tampered[1] = enc({ ...JSON.parse(Buffer.from(tampered[1], 'base64url')), run_id: '1' });
  assert.match((await verifyGithubOidc(tampered.join('.'), {}, { fetcher, now })).reason, /signature/);
  assert.match((await verifyGithubOidc(await s.sign({}, t, { kid: 'nope' }), {}, { fetcher, now })).reason, /key GitHub does not publish/);
  assert.match((await verifyGithubOidc(await s.sign({}, t, { alg: 'HS256' }), {}, { fetcher, now })).reason, /RS256/);
  assert.match((await verifyGithubOidc('not-a-token', {}, { fetcher, now })).reason, /not a JWT/);
});

test('an unknown kid refetches the keys once (GitHub rotated them)', async () => {
  resetOidcCache();
  const a = await oidcSigner('old'); const b = await oidcSigner('new');
  let keys = [a.jwk];
  const { fetcher, calls } = fakeFetcher(() => keys);
  const now = Date.now();
  assert.equal((await verifyGithubOidc(await a.sign(), {}, { fetcher, now })).ok, true);
  keys = [a.jwk, b.jwk];
  assert.equal((await verifyGithubOidc(await b.sign(), {}, { fetcher, now: now + 5000 })).ok, false, 'no refetch within a minute');
  assert.equal(calls.length, 1);
  assert.equal((await verifyGithubOidc(await b.sign(), {}, { fetcher, now: now + 61_000 })).ok, true);
  assert.equal(calls.length, 2);
  const down = async () => { throw new Error('offline'); };
  resetOidcCache();
  assert.match((await verifyGithubOidc(await a.sign(), {}, { fetcher: down, now })).reason, /could not be fetched/);
});
