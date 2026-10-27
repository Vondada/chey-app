// Public, read-only CHE mobile update metadata and SideStore delivery.
//
// Successful full iPhone builds are published as GitHub Release assets by
// Codemagic. The Worker is the stable front door so the storage backend can be
// moved to R2 later without changing CHE or SideStore URLs.

const REPO = 'Vondada/chey-app';
const IPA_NAME = 'CHE-unsigned.ipa';
const META_NAME = 'CHE-update.json';
const TAG_RE = /^che-ios-v(.+)-b([0-9]+)$/;
// The app's real bundle identifier (ios/Runner, Info.plist CFBundleIdentifier).
export const CHE_BUNDLE_ID = 'com.cheyapp.chey';
// SideStore's sidestore://install link takes the app name from the last path
// segment of the IPA URL, minus its extension. A URL ending in the release tag
// gave "che-ios-v1.4", which SideStore then refused against the real bundle ID.
// The install URL therefore ends in the bundle ID itself.
export const INSTALL_FILE_NAME = `${CHE_BUNDLE_ID}.ipa`;
const INSTALL_SEGMENT = `/${INSTALL_FILE_NAME}`;
// Release publishing also attaches a byte-identical copy under the bundle ID
// name. SideStore downloads that asset straight from GitHub, so the IPA no
// longer has to stream through this Worker.
const RELEASE_BASE = `https://github.com/${REPO}/releases/download/`;
const ICON_URL = 'https://raw.githubusercontent.com/Vondada/chey-app/main/assets/avatars/che.png';

const privacy = {
  NSMicrophoneUsageDescription: 'CHE uses your microphone when you speak to your assistant or capture audio.',
  NSSpeechRecognitionUsageDescription: 'CHE converts your speech to text when you use voice chat.',
  NSCameraUsageDescription: 'CHE uses the camera only when you choose to capture a photo or video for CHE to analyze.',
  NSPhotoLibraryUsageDescription: 'CHE accesses selected photos or videos only when you choose them for CHE to analyze.',
  NSPhotoLibraryAddUsageDescription: 'CHE saves generated or edited media to Photos only when you choose Save.',
  NSFaceIDUsageDescription: 'CHE uses Face ID to unlock your private connected-account vault.',
  NSContactsUsageDescription: 'CHE accesses contacts only when you explicitly authorize a contact-based action.',
  NSCalendarsUsageDescription: 'CHE accesses your calendar only for owner-authorized scheduling and calendar actions.',
  NSCalendarsFullAccessUsageDescription: 'CHE accesses your calendar only for owner-authorized scheduling and calendar actions.',
  NSRemindersUsageDescription: 'CHE accesses reminders only for owner-authorized reminder actions.',
  NSRemindersFullAccessUsageDescription: 'CHE accesses reminders only for owner-authorized reminder actions.',
  NSBluetoothAlwaysUsageDescription: 'CHE uses Bluetooth only for owner-authorized accessories, audio, and supported devices.',
  NSLocalNetworkUsageDescription: 'CHE uses the local network only to connect to owner-authorized devices and services.',
  NSAppleMusicUsageDescription: 'CHE accesses your media library only for owner-authorized music actions.',
  NSLocationWhenInUseUsageDescription: 'CHE uses your location only while you are using location-aware features.',
};

function apiHeaders(env = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'CHE-Mobile-Update',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (env.CHE_GITHUB_TOKEN) headers.Authorization = `Bearer ${env.CHE_GITHUB_TOKEN}`;
  return headers;
}

async function githubJson(path, env, fetcher = fetch) {
  const response = await fetcher(`https://api.github.com/repos/${REPO}${path}`, {
    headers: apiHeaders(env),
  });
  if (!response.ok) throw new Error(`GitHub releases returned ${response.status}`);
  return response.json();
}

function bodyMeta(body) {
  const meta = {};
  const match = /<!--\s*CHE-META([\s\S]*?)-->/i.exec(String(body || ''));
  if (!match) return meta;
  for (const raw of match[1].split('\n')) {
    const line = raw.trim();
    const at = line.indexOf('=');
    if (at <= 0) continue;
    meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return meta;
}

function visibleNotes(body) {
  return String(body || '').replace(/<!--\s*CHE-META[\s\S]*?-->/gi, '').trim().slice(0, 4000);
}

function ipaAsset(release) {
  return (release?.assets || []).find((asset) =>
    asset?.name === IPA_NAME &&
    asset?.state === 'uploaded' &&
    Number(asset?.size || 0) > 0
  ) || null;
}

// The bundle-named copy counts only when it is the same file as the verified
// IPA: same digest, same size, and GitHub's own download URL for this release.
function directInstallUrl(release, ipa) {
  const install = (release?.assets || []).find((asset) => asset?.name === INSTALL_FILE_NAME);
  if (!install || install.state !== 'uploaded') return '';
  if (String(install.digest || '').toLowerCase() !== String(ipa.digest || '').toLowerCase()) return '';
  if (Number(install.size || 0) !== Number(ipa.size || 0)) return '';
  const expected = `${RELEASE_BASE}${release.tag_name}/${INSTALL_FILE_NAME}`;
  return String(install.browser_download_url || '') === expected ? expected : '';
}

export function releaseToUpdate(release, origin) {
  const asset = ipaAsset(release);
  if (!asset) return null;
  const tag = String(release?.tag_name || '');
  const parsed = TAG_RE.exec(tag);
  if (!parsed) return null;
  const meta = bodyMeta(release?.body);
  const version = String(meta.version || parsed[1] || '').trim();
  const buildNumber = String(meta.build || parsed[2] || '').trim();
  if (!version || !buildNumber) return null;
  if (meta.version && String(meta.version).trim() !== parsed[1]) return null;
  if (meta.build && String(meta.build).trim() !== parsed[2]) return null;
  // A release built for another bundle identifier is never advertised to CHE.
  if (meta.bundle_id && String(meta.bundle_id).trim() !== CHE_BUNDLE_ID) return null;
  const assetDigest = String(asset.digest || '').trim();
  if (!/^sha256:[0-9a-f]{64}$/i.test(assetDigest)) return null;
  const sha = assetDigest.replace(/^sha256:/i, '').toLowerCase();
  const metaSha = String(meta.sha256 || '').trim().toLowerCase();
  if (metaSha && metaSha !== sha) return null;
  const metaSize = Number(meta.size || 0);
  if (metaSize > 0 && metaSize !== Number(asset.size || 0)) return null;
  const commit = String(meta.commit || release?.target_commitish || '').trim();
  const shorebirdBase = String(meta.shorebird_base || '').toLowerCase() === 'true';
  const relayUrl = `${origin}/api/update/download/${encodeURIComponent(tag)}${INSTALL_SEGMENT}`;
  // SideStore should fetch the verified release IPA directly, rather than
  // re-streaming ~43 MB through a Worker. The Worker relay stays as fallback.
  const downloadUrl = directInstallUrl(release, asset) || relayUrl;
  return {
    id: tag,
    tag,
    version,
    build_number: buildNumber,
    commit_sha: commit,
    build_date: String(release?.published_at || release?.created_at || ''),
    ipa_download_url: downloadUrl,
    download_url: downloadUrl,
    asset_download_url: String(asset.browser_download_url || ''),
    sha256: sha,
    size: Number(asset.size || meta.size || 0),
    update_lane: 'full',
    shorebird_base: shorebirdBase,
    fast_update_supported: shorebirdBase,
    build_status: 'success',
    release_notes: visibleNotes(release?.body) || `CHE iPhone build ${version} (${buildNumber}).`,
    source_url: `${origin}/api/update/source`,
    sidestore_install_url: `sidestore://install?url=${encodeURIComponent(downloadUrl)}`,
    sidestore_source_url: `sidestore://source?url=${encodeURIComponent(`${origin}/api/update/source`)}`,
  };
}

export function sourceFromUpdates(updates, origin) {
  const versions = updates.slice(0, 12).map((item) => ({
    version: item.version,
    date: item.build_date,
    localizedDescription: item.release_notes,
    // SideStore expects the raw ZIP/IPA bytes. Avoid turning a transient
    // Worker-to-GitHub proxy error into a downloaded JSON/temp archive.
    downloadURL: /^https:\/\/github\.com\/Vondada\/chey-app\/releases\/download\/[^?#]+\/CHE-unsigned\.ipa$/.test(String(item.asset_download_url || ''))
      ? item.asset_download_url : item.download_url,
    size: item.size,
    minOSVersion: '16.0',
  }));
  return {
    name: 'CHE Updates',
    identifier: 'com.cheyapp.che.source',
    sourceURL: `${origin}/api/update/source`,
    apps: [{
      name: 'CHE',
      bundleIdentifier: CHE_BUNDLE_ID,
      developerName: 'Vondada',
      subtitle: 'Cognitive Horizon Engine',
      localizedDescription: 'Voice-first private AI assistant and Office.',
      iconURL: ICON_URL,
      tintColor: '#34E0B8',
      permissions: [
        { type: 'microphone', usageDescription: privacy.NSMicrophoneUsageDescription },
        { type: 'speech-recognition', usageDescription: privacy.NSSpeechRecognitionUsageDescription },
        { type: 'camera', usageDescription: privacy.NSCameraUsageDescription },
        { type: 'photos', usageDescription: privacy.NSPhotoLibraryUsageDescription },
        { type: 'faceid', usageDescription: privacy.NSFaceIDUsageDescription },
        { type: 'contacts', usageDescription: privacy.NSContactsUsageDescription },
        { type: 'calendars', usageDescription: privacy.NSCalendarsUsageDescription },
        { type: 'reminders', usageDescription: privacy.NSRemindersUsageDescription },
        { type: 'bluetooth', usageDescription: privacy.NSBluetoothAlwaysUsageDescription },
        { type: 'network', usageDescription: privacy.NSLocalNetworkUsageDescription },
        { type: 'music', usageDescription: privacy.NSAppleMusicUsageDescription },
        { type: 'location', usageDescription: privacy.NSLocationWhenInUseUsageDescription },
        { type: 'background-audio', usageDescription: 'CHE keeps owner-authorized voice audio active when iOS permits it.' },
        { type: 'background-fetch', usageDescription: 'CHE checks owner-authorized background work when iOS permits it.' },
        { type: 'siri', usageDescription: 'CHE exposes the owner-authorized Wake CHE App Intent.' },
      ],
      versions,
    }],
    news: [],
  };
}

// Releases from different iPhone builders may finish out of order. GitHub's
// published_at ordering is not SideStore's numeric marketing-version ordering.
function compareMobileReleases(a, b) {
  const av = releaseToUpdate(a, 'https://che.invalid');
  const bv = releaseToUpdate(b, 'https://che.invalid');
  const numbers = (value) => String(value).split('.').map((x) => BigInt(x));
  const aa = numbers(av.version);
  const bb = numbers(bv.version);
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const left = aa[i] ?? 0n;
    const right = bb[i] ?? 0n;
    if (left !== right) return left > right ? -1 : 1;
  }
  const buildA = BigInt(av.build_number);
  const buildB = BigInt(bv.build_number);
  return buildA === buildB ? 0 : buildA > buildB ? -1 : 1;
}

async function releases(env, fetcher = fetch) {
  const items = await githubJson('/releases?per_page=30', env, fetcher);
  return Array.isArray(items)
    ? items.filter((item) =>
        !item?.draft &&
        !item?.prerelease &&
        releaseToUpdate(item, 'https://che.invalid') != null
      ).filter((item) => /^\d+\.\d+\.\d+$/.test(releaseToUpdate(item, 'https://che.invalid').version) &&
        /^\d+$/.test(releaseToUpdate(item, 'https://che.invalid').build_number))
        .sort(compareMobileReleases)
    : [];
}

/** The newest verified IPA release as /api/update/latest describes it, or null when GitHub cannot be read (never a guess). */
export async function latestVerifiedRelease(env = {}, fetcher = fetch, origin = 'https://che.invalid') {
  try {
    const release = (await releases(env, fetcher))[0];
    return release ? releaseToUpdate(release, origin) : null;
  } catch (_) {
    return null;
  }
}

async function latestMobileBuildAttempt(env, fetcher = fetch) {
  try {
    const status = await githubJson('/commits/main/status', env, fetcher);
    const item = (status?.statuses || [])
      .filter((entry) => entry?.context === 'CHE iPhone update')
      .sort((a, b) =>
        String(b?.updated_at || b?.created_at || '').localeCompare(
          String(a?.updated_at || a?.created_at || ''),
        )
      )[0];
    if (!item) return null;
    return {
      state: String(item.state || 'unknown'),
      commit_sha: String(status.sha || ''),
      updated_at: String(item.updated_at || item.created_at || ''),
      detail: String(item.description || '').slice(0, 180),
    };
  } catch (_) {
    return null;
  }
}

async function releaseByTag(tag, env, fetcher = fetch) {
  if (!tag || tag === 'latest') return (await releases(env, fetcher))[0] || null;
  if (!/^che-ios-v[A-Za-z0-9.+_-]+-b[0-9]+$/.test(tag)) return null;
  try {
    const release = await githubJson(`/releases/tags/${encodeURIComponent(tag)}`, env, fetcher);
    return releaseToUpdate(release, 'https://che.invalid') ? release : null;
  } catch (_) {
    return null;
  }
}

function json(value, status = 200, cache = 'public, max-age=60') {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cache,
    },
  });
}

export function isMobileUpdatePath(path) {
  return path === '/api/update/latest'
    || path === '/api/update/history'
    || path === '/api/update/source'
    || /^\/api\/update\/download\/(?:latest|che-ios-v[A-Za-z0-9.+_-]+-b[0-9]+)(?:\/com\.cheyapp\.chey\.ipa)?$/.test(path);
}

// Full size of the IPA that the upstream response carries, or null when unknown.
function servedIpaBytes(upstream) {
  if (upstream.status === 206) {
    const total = /\/(\d+)$/.exec(upstream.headers.get('Content-Range') || '');
    return total ? Number(total[1]) : null;
  }
  const length = upstream.headers.get('Content-Length') || '';
  return /^\d+$/.test(length) ? Number(length) : null;
}

async function downloadRelease(request, release, fetcher = fetch, fileName = IPA_NAME) {
  const asset = ipaAsset(release);
  if (!asset?.browser_download_url) return json({ detail: 'CHE IPA is not available.' }, 404);
  const upstreamHeaders = {};
  const range = request.headers.get('Range');
  if (range) upstreamHeaders.Range = range;
  // GitHub answers HEAD on its signed download URL with 401, so HEAD is read
  // with GET and its body is dropped. Nothing is trusted from a HEAD response.
  const upstream = await fetcher(asset.browser_download_url, {
    method: 'GET',
    headers: upstreamHeaders,
    redirect: 'follow',
  });
  if (!upstream.ok && upstream.status !== 206) {
    await upstream.body?.cancel();
    return json({ detail: `CHE IPA download failed with ${upstream.status}.` }, 502, 'no-store');
  }
  // Only the exact published archive is served. An error page or a truncated
  // or different-sized body is refused, never handed to SideStore as the IPA.
  const type = upstream.headers.get('Content-Type') || '';
  if (!/^application\/(octet-stream|zip)/i.test(type) || servedIpaBytes(upstream) !== Number(asset.size)) {
    await upstream.body?.cancel();
    return json({ detail: 'CHE IPA download did not match the published release. The installed build is unchanged.' }, 502, 'no-store');
  }
  const headers = new Headers();
  headers.set('Content-Type', 'application/octet-stream');
  headers.set('Content-Disposition', `attachment; filename="${fileName}"`);
  headers.set('Cache-Control', 'public, max-age=300');
  for (const name of ['Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified']) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (request.method === 'HEAD') {
    await upstream.body?.cancel();
    return new Response(null, { status: upstream.status, headers });
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

export async function handleMobileUpdateRequest(request, env = {}, fetcher = fetch) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!['GET', 'HEAD'].includes(request.method)) {
    return json({ detail: 'Update publishing is read-only from this Worker.' }, 405, 'no-store');
  }
  try {
    if (path === '/api/update/latest') {
      const [releaseList, latestAttempt] = await Promise.all([
        releases(env, fetcher),
        latestMobileBuildAttempt(env, fetcher),
      ]);
      const release = releaseList[0];
      if (!release) {
        return json({
          ok: false,
          detail: latestAttempt?.state === 'failure'
            ? 'The newest CHE mobile build failed before a verified IPA was published. Your installed build is unchanged.'
            : 'No successful CHE mobile release is published yet. The installed build remains unchanged.',
          latest_attempt: latestAttempt,
        }, 503, 'no-store');
      }
      return json({
        ok: true,
        ...releaseToUpdate(release, url.origin),
        latest_attempt: latestAttempt,
      });
    }
    if (path === '/api/update/history') {
      const items = (await releases(env, fetcher))
        .map((item) => releaseToUpdate(item, url.origin))
        .filter(Boolean)
        .slice(0, 12);
      return json({ ok: true, builds: items });
    }
    if (path === '/api/update/source') {
      const items = (await releases(env, fetcher))
        .map((item) => releaseToUpdate(item, url.origin))
        .filter(Boolean)
        .slice(0, 12);
      return json(sourceFromUpdates(items, url.origin), 200, 'public, max-age=300');
    }
    const match = /^\/api\/update\/download\/(.+?)(\/com\.cheyapp\.chey\.ipa)?$/.exec(path);
    if (match) {
      const release = await releaseByTag(decodeURIComponent(match[1]), env, fetcher);
      if (!release) return json({ detail: 'CHE build not found.' }, 404, 'no-store');
      // The bare tag URL still works for builds that already hold it.
      return downloadRelease(request, release, fetcher, match[2] ? INSTALL_FILE_NAME : IPA_NAME);
    }
    return json({ detail: 'Not found.' }, 404, 'no-store');
  } catch (error) {
    return json({
      ok: false,
      detail: 'CHE update delivery is temporarily unavailable. The previous working build remains available.',
    }, 503, 'no-store');
  }
}
