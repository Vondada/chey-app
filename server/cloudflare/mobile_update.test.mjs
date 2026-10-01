import test from 'node:test';
import assert from 'node:assert/strict';

import {
  handleMobileUpdateRequest,
  releaseToUpdate,
  sourceFromUpdates,
} from './mobile_update.js';

const release = {
  id: 7,
  tag_name: 'che-ios-v1.4.5-b1200001',
  target_commitish: 'abc123',
  published_at: '2026-10-01T05:00:00Z',
  body: `Face ID and mobile updates.

<!-- CHE-META
version=1.4.5
build=1200001
commit=abc123
sha256=feedface
size=3
shorebird_base=true
-->`,
  assets: [{
    name: 'CHE-unsigned.ipa',
    state: 'uploaded',
    digest: 'sha256:feedface',
    size: 3,
    browser_download_url: 'https://downloads.example/CHE-unsigned.ipa',
  }],
};

test('release metadata produces stable Worker and SideStore URLs', () => {
  const update = releaseToUpdate(release, 'https://che.example');
  assert.equal(update.version, '1.4.5');
  assert.equal(update.build_number, '1200001');
  assert.equal(update.sha256, 'feedface');
  assert.equal(update.shorebird_base, true);
  assert.equal(
    update.download_url,
    'https://che.example/api/update/download/che-ios-v1.4.5-b1200001',
  );
  assert.match(update.sidestore_install_url, /^sidestore:\/\/install\?url=/);
  assert.doesNotMatch(JSON.stringify(update), /token|secret/i);
});

test('SideStore source keeps verified build history', () => {
  const latest = releaseToUpdate(release, 'https://che.example');
  const older = { ...latest, version: '1.4.4', build_number: '1100001' };
  const source = sourceFromUpdates([latest, older], 'https://che.example');
  assert.equal(source.apps[0].bundleIdentifier, 'com.cheyapp.chey');
  assert.equal(source.apps[0].versions.length, 2);
  assert.equal(source.apps[0].versions[0].sha256, 'feedface');
  assert.equal(source.apps[0].versions[0].minOSVersion, '16.0');
});

test('latest and history advertise only successful releases with IPA assets', async () => {
  const fetcher = async (url) => {
    assert.match(String(url), /api\.github\.com/);
    return new Response(JSON.stringify([
      release,
      { ...release, id: 8, tag_name: 'draft', draft: true },
      { ...release, id: 9, tag_name: 'missing', assets: [] },
    ]), { status: 200 });
  };
  const latest = await handleMobileUpdateRequest(
    new Request('https://che.example/api/update/latest'),
    {},
    fetcher,
  );
  assert.equal(latest.status, 200);
  assert.equal((await latest.json()).build_number, '1200001');

  const history = await handleMobileUpdateRequest(
    new Request('https://che.example/api/update/history'),
    {},
    fetcher,
  );
  assert.equal((await history.json()).builds.length, 1);
});

test('download streams the exact IPA with iOS-friendly headers', async () => {
  const fetcher = async (url) => {
    if (String(url).includes('/releases?')) {
      return new Response(JSON.stringify([release]), { status: 200 });
    }
    if (String(url) === 'https://downloads.example/CHE-unsigned.ipa') {
      return new Response('IPA', {
        status: 200,
        headers: { 'Content-Length': '3', 'Accept-Ranges': 'bytes' },
      });
    }
    throw new Error('unexpected URL ' + url);
  };
  const response = await handleMobileUpdateRequest(
    new Request('https://che.example/api/update/download/latest'),
    {},
    fetcher,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'application/octet-stream');
  assert.equal(
    response.headers.get('Content-Disposition'),
    'attachment; filename="CHE-unsigned.ipa"',
  );
  assert.equal(await response.text(), 'IPA');
});

test('public update API cannot upload or replace builds', async () => {
  const response = await handleMobileUpdateRequest(
    new Request('https://che.example/api/update/latest', { method: 'POST' }),
    {},
    async () => { throw new Error('should not fetch'); },
  );
  assert.equal(response.status, 405);
});

test('failed build state never replaces the last known good release', async () => {
  const response = await handleMobileUpdateRequest(
    new Request('https://che.example/api/update/latest'),
    {},
    async () => new Response('[]', { status: 200 }),
  );
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.match(body.detail, /No successful CHE mobile release/);
});


test('latest endpoint reports a failed newest mobile attempt without hiding last good IPA', async () => {
  const fetcher = async (url) => {
    const value = String(url);
    if (value.includes('/commits/main/status')) {
      return new Response(JSON.stringify({
        sha: 'newer-bad-commit',
        statuses: [{
          context: 'CHE iPhone update',
          state: 'failure',
          description: 'CHE mobile build failed; previous verified IPA remains available.',
          updated_at: '2026-10-01T06:00:00Z',
        }],
      }), { status: 200 });
    }
    if (value.includes('/releases?')) {
      return new Response(JSON.stringify([release]), { status: 200 });
    }
    throw new Error('unexpected URL ' + value);
  };

  const response = await handleMobileUpdateRequest(
    new Request('https://che.example/api/update/latest'),
    {},
    fetcher,
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.build_number, '1200001');
  assert.equal(body.latest_attempt.state, 'failure');
  assert.equal(body.latest_attempt.commit_sha, 'newer-bad-commit');
});
