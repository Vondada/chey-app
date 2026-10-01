// Public, read-only CHE mobile update metadata and SideStore delivery.
//
// Successful full iPhone builds are published as GitHub Release assets by
// Codemagic. The Worker is the stable front door so the storage backend can be
// moved to R2 later without changing CHE or SideStore URLs.

const REPO = 'Vondada/chey-app';
const IPA_NAME = 'CHE-unsigned.ipa';
const META_NAME = 'CHE-update.json';
const TAG_RE = /^che-ios-v(.+)-b([0-9]+)$/;
const ICON_URL = 'https://raw.githubusercontent.com/Vondada/chey-app/main/assets/icon/icon.png';

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
  return (release?.assets || []).find((asset) => asset?.name === IPA_NAME && asset?.state !== 'deleted') || null;
}

export function releaseToUpdate(release, origin) {
  const asset = ipaAsset(release);
  if (!asset) return null;
  const tag = String(release?.tag_name || '');
  const parsed = TAG_RE.exec(tag);
  const meta = bodyMeta(release?.body);
  const version = String(meta.version || parsed?.[1] || '').trim();
  const buildNumber = String(meta.build || parsed?.[2] || '').trim();
  if (!version || !buildNumber) return null;
  const sha = String(asset.digest || meta.sha256 || '').replace(/^sha256:/i, '');
  const commit = String(meta.commit || release?.target_commitish || '').trim();
  const shorebirdBase = String(meta.shorebird_base || '').toLowerCase() === 'true';
  const downloadUrl = `${origin}/api/update/download/${encodeURIComponent(tag)}`;
  return {
    id: tag,
    tag,
    version,
    build_number: buildNumber,
    commit_sha: commit,
    build_date: String(release?.published_at || release?.created_at || ''),
    ipa_download_url: downloadUrl,
    download_url: downloadUrl,
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
    buildVersion: item.build_number,
    date: item.build_date,
    localizedDescription: item.release_notes,
    downloadURL: item.download_url,
    size: item.size,
    ...(item.sha256 ? { sha256: item.sha256 } : {}),
    minOSVersion: '16.0',
  }));
  return {
    name: 'CHE',
    subtitle: 'Cognitive Horizon Engine',
    description: 'Owner builds of CHE for SideStore.',
    website: 'https://github.com/Vondada/chey-app',
    iconURL: ICON_URL,
    tintColor: '#34E0B8',
    apps: [{
      name: 'CHE',
      bundleIdentifier: 'com.cheyapp.chey',
      developerName: 'Vondada',
      subtitle: 'Cognitive Horizon Engine',
      localizedDescription: 'Voice-first private AI assistant and Office.',
      iconURL: ICON_URL,
      tintColor: '#34E0B8',
      category: 'utilities',
      versions,
      appPermissions: { entitlements: [], privacy },
    }],
    news: [],
    sourceURL: `${origin}/api/update/source`,
  };
}

async function releases(env, fetcher = fetch) {
  const items = await githubJson('/releases?per_page=30', env, fetcher);
  return Array.isArray(items)
    ? items.filter((item) => !item?.draft && !item?.prerelease && ipaAsset(item))
    : [];
}

async function latestMobileBuildAttempt(env, fetcher = fetch) {
  try {
    const status = await githubJson('/commits/main/status', env, fetcher);
    const item = (status?.statuses || []).find(
      (entry) => entry?.context === 'CHE iPhone update',
    );
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
    return ipaAsset(release) ? release : null;
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
    || /^\/api\/update\/download\/(?:latest|che-ios-v[A-Za-z0-9.+_-]+-b[0-9]+)$/.test(path);
}

async function downloadRelease(request, release, fetcher = fetch) {
  const asset = ipaAsset(release);
  if (!asset?.browser_download_url) return json({ detail: 'CHE IPA is not available.' }, 404);
  const upstreamHeaders = {};
  const range = request.headers.get('Range');
  if (range) upstreamHeaders.Range = range;
  const upstream = await fetcher(asset.browser_download_url, {
    method: request.method === 'HEAD' ? 'HEAD' : 'GET',
    headers: upstreamHeaders,
    redirect: 'follow',
  });
  if (!upstream.ok && upstream.status !== 206) {
    return json({ detail: `CHE IPA download failed with ${upstream.status}.` }, 502, 'no-store');
  }
  const headers = new Headers();
  headers.set('Content-Type', 'application/octet-stream');
  headers.set('Content-Disposition', `attachment; filename="${IPA_NAME}"`);
  headers.set('Cache-Control', 'public, max-age=300');
  for (const name of ['Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified']) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(request.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    headers,
  });
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
    const match = /^\/api\/update\/download\/(.+)$/.exec(path);
    if (match) {
      const release = await releaseByTag(decodeURIComponent(match[1]), env, fetcher);
      if (!release) return json({ detail: 'CHE build not found.' }, 404, 'no-store');
      return downloadRelease(request, release, fetcher);
    }
    return json({ detail: 'Not found.' }, 404, 'no-store');
  } catch (error) {
    return json({
      ok: false,
      detail: 'CHE update delivery is temporarily unavailable. The previous working build remains available.',
    }, 503, 'no-store');
  }
}
