import test from 'node:test';
import assert from 'node:assert/strict';

const DIGEST = 'a'.repeat(64);

import {
  CHE_BUNDLE_ID,
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
sha256=${DIGEST}
size=3
shorebird_base=true
-->`,
  assets: [{
    name: 'CHE-unsigned.ipa',
    state: 'uploaded',
    digest: `sha256:${DIGEST}`,
    size: 3,
    browser_download_url: 'https://downloads.example/CHE-unsigned.ipa',
  }],
};

test('release metadata produces stable Worker and SideStore URLs', () => {
  const update = releaseToUpdate(release, 'https://che.example');
  assert.equal(update.version, '1.4.5');
  assert.equal(update.build_number, '1200001');
  assert.equal(update.sha256, DIGEST);
  assert.equal(update.shorebird_base, true);
  assert.equal(
    update.download_url,
    'https://che.example/api/update/download/che-ios-v1.4.5-b1200001/com.cheyapp.chey.ipa',
  );
  assert.match(update.sidestore_install_url, /^sidestore:\/\/install\?url=/);
  assert.doesNotMatch(JSON.stringify(update), /token|secret/i);
});

test('SideStore source keeps verified build history with only current schema fields', () => {
  const latest = releaseToUpdate(release, 'https://che.example');
  const older = { ...latest, version: '1.4.4', build_number: '1100001' };
  const source = sourceFromUpdates([latest, older], 'https://che.example');
  assert.deepEqual(Object.keys(source).sort(), ['apps', 'identifier', 'name', 'news', 'sourceURL'].sort());
  assert.equal(source.apps[0].bundleIdentifier, 'com.cheyapp.chey');
  assert.equal(source.apps[0].versions.length, 2);
  assert.deepEqual(
    Object.keys(source.apps[0].versions[0]).sort(),
    ['date', 'downloadURL', 'localizedDescription', 'minOSVersion', 'size', 'version'].sort(),
  );
  assert.equal(source.apps[0].versions[0].minOSVersion, '16.0');
  assert.equal('buildVersion' in source.apps[0].versions[0], false);
  assert.equal('sha256' in source.apps[0].versions[0], false);
  assert.ok(Array.isArray(source.apps[0].permissions));
});

test('SideStore gets the verified direct release IPA, not the streaming Worker relay', () => {
  const update = releaseToUpdate(release, 'https://che.example');
  assert.equal(update.download_url, 'https://che.example/api/update/download/che-ios-v1.4.5-b1200001/com.cheyapp.chey.ipa');
  assert.equal(update.asset_download_url, 'https://downloads.example/CHE-unsigned.ipa');
  // Only trusted public GitHub release assets may bypass the relay.
  const official = {
    ...update,
    asset_download_url: 'https://github.com/Vondada/chey-app/releases/download/che-ios-v1.4.5-b1200001/CHE-unsigned.ipa',
  };
  const source = sourceFromUpdates([official], 'https://che.example');
  assert.equal(source.apps[0].versions[0].downloadURL, official.asset_download_url);
  assert.equal(source.apps[0].bundleIdentifier, 'com.cheyapp.chey');
  const untrusted = sourceFromUpdates([update], 'https://che.example');
  assert.equal(untrusted.apps[0].versions[0].downloadURL, update.download_url);
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


test('release metadata rejects missing or mismatched GitHub SHA-256 digests', () => {
  const missing = {
    ...release,
    assets: [{ ...release.assets[0], digest: '' }],
  };
  assert.equal(releaseToUpdate(missing, 'https://che.example'), null);

  const mismatch = {
    ...release,
    body: release.body.replace(DIGEST, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
  };
  assert.equal(releaseToUpdate(mismatch, 'https://che.example'), null);
});


test('direct downloads reject a release whose verified metadata does not match the asset digest', async () => {
  const bad = {
    ...release,
    body: release.body.replace(DIGEST, 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'),
  };
  const response = await handleMobileUpdateRequest(
    new Request('https://che.example/api/update/download/che-ios-v1.4.5-b1200001'),
    {},
    async (url) => {
      if (String(url).includes('/releases/tags/')) {
        return new Response(JSON.stringify(bad), { status: 200 });
      }
      throw new Error('unverified IPA body should never be fetched');
    },
  );
  assert.equal(response.status, 404);
});

test('latest IPA is the highest numeric version even if another builder publishes later', async () => {
  const high = {
    ...release,
    tag_name: 'che-ios-v1.4.1024200000-b3769039753601',
    body: release.body.replaceAll('1.4.5', '1.4.1024200000').replaceAll('1200001', '3769039753601'),
    published_at: '2026-10-07T20:00:00Z',
  };
  const low = {
    ...release,
    tag_name: 'che-ios-v1.4.1000371-b19000371',
    body: release.body.replaceAll('1.4.5', '1.4.1000371').replaceAll('1200001', '19000371'),
    published_at: '2026-10-07T21:00:00Z',
  };
  const fetcher = async (url) => new Response(
    JSON.stringify(String(url).includes('/releases?') ? [low, high] : {}),
    { status: 200 },
  );
  const latest = await handleMobileUpdateRequest(new Request('https://che.example/api/update/latest'), {}, fetcher);
  assert.equal((await latest.json()).version, '1.4.1024200000');
  const history = await handleMobileUpdateRequest(new Request('https://che.example/api/update/history'), {}, fetcher);
  assert.deepEqual((await history.json()).builds.map((item) => item.version), [
    '1.4.1024200000', '1.4.1000371',
  ]);
});

test('the SideStore install link names the app by its bundle ID, never by the release tag', () => {
  const update = releaseToUpdate(release, 'https://che.example');
  const install = new URL(update.sidestore_install_url);
  assert.equal(install.protocol, 'sidestore:');
  assert.equal(install.hostname, 'install');
  const ipa = new URL(install.searchParams.get('url'));
  // SideStore drops the extension from the last path segment; what remains must be the bundle ID.
  const lastSegment = ipa.pathname.split('/').pop();
  assert.equal(lastSegment.replace(/\.ipa$/, ''), CHE_BUNDLE_ID);
  assert.equal(update.download_url, ipa.href);
  assert.equal(update.ipa_download_url, ipa.href);
});

test('the install link and the bare tag both download the IPA; only the install link is named for the bundle', async () => {
  const fetcher = async (url) => {
    if (String(url).includes('/releases?')) return new Response(JSON.stringify([release]), { status: 200 });
    if (String(url).includes('/releases/tags/')) return new Response(JSON.stringify(release), { status: 200 });
    if (String(url) === 'https://downloads.example/CHE-unsigned.ipa') return new Response('IPA', { status: 200 });
    throw new Error('unexpected URL ' + url);
  };
  const install = await handleMobileUpdateRequest(
    new Request(`https://che.example/api/update/download/che-ios-v1.4.5-b1200001/${CHE_BUNDLE_ID}.ipa`),
    {},
    fetcher,
  );
  assert.equal(install.status, 200);
  assert.equal(install.headers.get('Content-Disposition'), `attachment; filename="${CHE_BUNDLE_ID}.ipa"`);
  assert.equal(await install.text(), 'IPA');
  const bare = await handleMobileUpdateRequest(
    new Request('https://che.example/api/update/download/che-ios-v1.4.5-b1200001'),
    {},
    fetcher,
  );
  assert.equal(bare.status, 200);
  assert.equal(bare.headers.get('Content-Disposition'), 'attachment; filename="CHE-unsigned.ipa"');
  const wrongName = await handleMobileUpdateRequest(
    new Request('https://che.example/api/update/download/che-ios-v1.4.5-b1200001/evil.ipa'),
    {},
    fetcher,
  );
  assert.equal(wrongName.status, 404);
});

test('a release built for another bundle identifier is never advertised to CHE', () => {
  const other = { ...release, body: release.body.replace('-->', 'bundle_id=com.example.other\n-->') };
  assert.equal(releaseToUpdate(other, 'https://che.example'), null);
  const same = { ...release, body: release.body.replace('-->', `bundle_id=${CHE_BUNDLE_ID}\n-->`) };
  assert.equal(releaseToUpdate(same, 'https://che.example').sha256, DIGEST);
});

test('the Worker and the iOS release tool agree on the bundle identifier', async () => {
  const { readFile } = await import('node:fs/promises');
  const tool = await readFile(new URL('../../tool/ipa_metadata.py', import.meta.url), 'utf8');
  assert.ok(tool.includes(`BUNDLE_ID = '${CHE_BUNDLE_ID}'`), 'tool/ipa_metadata.py must name the same bundle ID');
});
