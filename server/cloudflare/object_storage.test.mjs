// Tenant object storage: key isolation, upload plans, retention, account deletion order, envelope encryption with
// crypto-shredding, AWS Signature V4 against AWS's published example, and resumable R2 multipart uploads whose bytes
// never pass through the Worker (a fake R2 checks every signed control request).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLASSES, R2Multipart, assertTenantKey, deletionPlan, expiredKeys, newTenantKey, objectKey, openForTenant, planUpload,
  presignUrl, r2Status, sealForTenant, tenantObjectName,
} from './object_storage.js';

test('keys live under the tenant prefix; another tenant or a path trick is refused', () => {
  const k = objectKey({ tenant: 'ana', cls: 'video', id: 'vid_1', name: 'My film (final).mp4', at: '2026-10-24T12:00:00Z' });
  assert.equal(k, 't/ana/video/2026-10/vid_1/My_film_final_.mp4');
  assert.equal(assertTenantKey('ana', k), k);
  assert.throws(() => assertTenantKey('bob', k), /another account/);
  assert.throws(() => assertTenantKey('ana', 't/ana/../bob/video/x'), /another account/);
  assert.throws(() => objectKey({ tenant: '../bob', cls: 'video', id: 'x' }), /bad tenant/);
  assert.throws(() => objectKey({ tenant: 'ana', cls: 'video', id: '../x' }), /bad asset/);
  assert.equal(tenantObjectName('owner-369'), 'owner');
  assert.equal(tenantObjectName('ana'), 'tenant:ana');
});

test('upload plans: a 30-minute 1080p film is 29 parts of 64 MB; limits and types are plain refusals', () => {
  const p = planUpload({ cls: 'video', bytes: 1800 * 1024 * 1024, type: 'video/mp4' });
  assert.deepEqual([p.ok, p.parts], [true, 29]);
  assert.match(planUpload({ cls: 'thumbnail', bytes: 50 * 1024 * 1024, type: 'image/png' }).reason, /at most 10 MB/);
  assert.match(planUpload({ cls: 'music', bytes: 1000, type: 'video/mp4' }).reason, /must be audio/);
  assert.equal(CLASSES.tmp.retention_days, 7);
});

test('retention removes temporary files after 7 days and keeps finished work', () => {
  const now = Date.parse('2026-10-24T00:00:00Z');
  const keys = expiredKeys([
    { key: 't/ana/tmp/2026-10/j1/seg_001.mp4', uploaded: '2026-10-10T00:00:00Z' },
    { key: 't/ana/tmp/2026-10/j2/seg_001.mp4', uploaded: '2026-10-22T00:00:00Z' },
    { key: 't/ana/video/2026-01/v1/final.mp4', uploaded: '2026-01-01T00:00:00Z' },
  ], now);
  assert.deepEqual(keys, ['t/ana/tmp/2026-10/j1/seg_001.mp4']);
});

test('account deletion destroys the data key first, then jobs, uploads, objects, index and the Brain object', () => {
  const steps = deletionPlan('ana').map((s) => s.step);
  assert.deepEqual(steps, ['destroy_data_key', 'cancel_jobs', 'abort_uploads', 'delete_objects', 'delete_search_index', 'delete_durable_object', 'receipt']);
});

test('each tenant has its own data key; a record cannot be opened as another tenant; without the key it is gone', async () => {
  const kek = 'k'.repeat(40);
  const ana = await newTenantKey(kek); const bob = await newTenantKey(kek);
  const sealed = await sealForTenant(kek, ana, 'ana', 'Ana likes teal and jazz');
  assert.equal(await openForTenant(kek, ana, 'ana', sealed), 'Ana likes teal and jazz');
  await assert.rejects(openForTenant(kek, ana, 'bob', sealed));          // bound to the tenant
  await assert.rejects(openForTenant(kek, bob, 'ana', sealed));          // another tenant's key
  await assert.rejects(openForTenant('x'.repeat(40), ana, 'ana', sealed)); // wrong platform key
  await assert.rejects(newTenantKey('short'), /CHE_TENANT_KEK/);
});

test('Signature V4 matches the AWS documentation example for a presigned GET', async () => {
  const url = await presignUrl({
    method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', region: 'us-east-1', expires: 86400,
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', now: new Date('2013-05-24T00:00:00Z'),
  });
  assert.match(url, /X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/);
});

test('without R2 CHE says exactly what is missing and never returns a secret', () => {
  const s = r2Status({ CHE_R2_ACCOUNT_ID: 'acc' });
  assert.equal(s.ok, false); assert.equal(s.provider, 'che_store');
  assert.deepEqual(s.missing, ['CHE_R2_BUCKET', 'CHE_R2_ACCESS_KEY_ID', 'CHE_R2_SECRET_ACCESS_KEY']);
  assert.match(s.reason, /not enabled/);
  assert.throws(() => new R2Multipart({}), /Direct uploads need Cloudflare R2/);
});

test('multipart: start, an interrupted upload resumes with only the missing parts, complete; bytes never reach CHE', async () => {
  const env = { CHE_R2_ACCOUNT_ID: 'acc123', CHE_R2_BUCKET: 'che-media', CHE_R2_ACCESS_KEY_ID: 'AKID', CHE_R2_SECRET_ACCESS_KEY: 'SECRET' };
  const calls = [];
  const fake = async (url, init = {}) => {
    const u = new URL(url); calls.push({ method: init.method, path: u.pathname, q: Object.fromEntries(u.searchParams), body: init.body });
    assert.equal(u.host, 'acc123.r2.cloudflarestorage.com');
    assert.ok(u.searchParams.get('X-Amz-Signature'), 'every control request is signed');
    if (init.method === 'POST' && u.searchParams.has('uploads')) return new Response('<InitiateMultipartUploadResult><UploadId>up-1</UploadId></InitiateMultipartUploadResult>');
    if (init.method === 'GET') return new Response('<ListPartsResult><Part><PartNumber>1</PartNumber><ETag>"e1"</ETag></Part><Part><PartNumber>3</PartNumber><ETag>"e3"</ETag></Part></ListPartsResult>');
    return new Response('<ok/>');
  };
  const r2 = new R2Multipart(env, { fetcher: fake, now: () => new Date('2026-10-24T12:00:00Z') });
  const key = objectKey({ tenant: 'ana', cls: 'video', id: 'vid_9', name: 'film.mp4', at: '2026-10-24T12:00:00Z' });
  const started = await r2.start('ana', key, { parts: 4 }, 'video/mp4');
  assert.equal(started.upload_id, 'up-1');
  assert.deepEqual(started.parts.map((p) => p.n), [1, 2, 3, 4]);
  for (const p of started.parts) {
    const u = new URL(p.url);
    assert.equal(u.pathname, `/che-media/${key}`); assert.equal(u.searchParams.get('partNumber'), String(p.n));
    assert.equal(u.searchParams.get('uploadId'), 'up-1'); assert.equal(u.searchParams.get('X-Amz-Expires'), '3600');
  }
  const resumed = await r2.resume('ana', key, 'up-1', 4);
  assert.deepEqual(resumed.done.map((d) => d.n), [1, 3]);
  assert.deepEqual(resumed.parts.map((p) => p.n), [2, 4], 'only the missing parts are signed again');
  await r2.complete('ana', key, 'up-1', [{ n: 2, etag: '"e2"' }, { n: 1, etag: '"e1"' }, { n: 4, etag: '"e4"' }, { n: 3, etag: '"e3"' }]);
  const done = calls.at(-1);
  assert.match(done.body, /<PartNumber>1<\/PartNumber>.*<PartNumber>2<\/PartNumber>.*<PartNumber>3<\/PartNumber>.*<PartNumber>4<\/PartNumber>/);
  assert.ok(calls.every((c) => !c.body || c.body.length < 2000), 'the Worker only sends small control requests, never file bytes');
  await assert.rejects(r2.start('bob', key, { parts: 1 }), /another account/);
  await assert.rejects(r2.downloadUrl('bob', key), /another account/);
  assert.match(await r2.downloadUrl('ana', key), /X-Amz-Expires=900/);
});
