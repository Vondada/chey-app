// Uploads a rendered video to YouTube using the resumable media protocol.
// A remote media URL is fetched first; YouTube receives the actual video stream.

function safeHttpUrl(raw) {
  try {
    const url = new URL(String(raw || '').trim());
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function safeUploadSession(raw) {
  try {
    const url = new URL(String(raw || ''));
    return url.protocol === 'https:' &&
      (url.hostname === 'www.googleapis.com' || url.hostname.endsWith('.googleapis.com'))
      ? url.toString()
      : '';
  } catch {
    return '';
  }
}

// `accessToken` comes from the owner's YouTube connection (youtube_connection.js),
// never from a static key. Uploads are unlisted unless the owner approves more.
// A video CHE already holds (an R2 object or a verified GitHub artifact) is
// sent as `media_bytes`: its media URL needs the owner's sign-in, so it cannot
// be fetched like a public link.
export async function uploadYouTube(body = {}, accessToken = '', fetcher = fetch) {
  const token = String(accessToken || '').trim();
  const bytes = body.media_bytes instanceof Uint8Array && body.media_bytes.length ? body.media_bytes : null;
  const mediaUrl = bytes ? null : safeHttpUrl(body.media_url);
  const title = String(body.title || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!token) return { ok: false, error: 'YouTube is not connected. No video was uploaded.' };
  if ((!bytes && !mediaUrl) || !title) return { ok: false, error: 'Upload needs a valid file URL and a title.' };

  try {
    const media = bytes ? null : await fetcher(mediaUrl.toString(), {
      method: 'GET',
      signal: AbortSignal.timeout(30000),
    });
    if (media && (!media.ok || !media.body)) {
      return { ok: false, error: 'The rendered video file could not be downloaded.', status: media.status };
    }

    const contentType = bytes ? String(body.content_type || 'video/mp4') : media.headers?.get?.('content-type') || 'video/mp4';
    const contentLength = bytes ? String(bytes.length) : media.headers?.get?.('content-length') || '';
    const initiate = await fetcher(
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=utf-8',
          'x-upload-content-type': contentType,
          ...(contentLength ? { 'x-upload-content-length': contentLength } : {}),
        },
        body: JSON.stringify({
          snippet: {
            title,
            description: String(body.description || title).slice(0, 500),
          },
          status: { privacyStatus: 'unlisted' },
        }),
        signal: AbortSignal.timeout(12000),
      },
    );
    const session = safeUploadSession(initiate.headers?.get?.('location'));
    if (!initiate.ok || !session) {
      return { ok: false, error: 'YouTube did not open an upload session.', status: initiate.status };
    }

    const uploaded = await fetcher(session, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': contentType,
        ...(contentLength ? { 'content-length': contentLength } : {}),
      },
      body: bytes || media.body,
      signal: AbortSignal.timeout(120000),
    });
    const data = await uploaded.json().catch(() => ({}));
    const id = String(data.id || '');
    if (!uploaded.ok || !id) {
      return { ok: false, error: 'YouTube did not return a video id.', status: uploaded.status };
    }
    return { ok: true, video_id: id, link: `https://www.youtube.com/watch?v=${id}` };
  } catch {
    return { ok: false, error: 'YouTube did not respond.' };
  }
}

/**
 * A video's public counters exactly as YouTube returns them (views, likes,
 * comments), read with the owner's YouTube sign-in. A counter YouTube hides
 * stays null; nothing is estimated.
 */
export async function youtubeVideoStatistics(accessToken = '', ids = [], fetcher = fetch) {
  const token = String(accessToken || '').trim();
  const wanted = ids.map(String).filter((id) => /^[A-Za-z0-9_-]{6,20}$/.test(id)).slice(0, 50);
  if (!token) return { ok: false, error: 'YouTube is not connected.' };
  if (!wanted.length) return { ok: false, error: 'No YouTube video to read.' };
  try {
    const reply = await fetcher(`https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${wanted.join(',')}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(12000),
    });
    const data = await reply.json().catch(() => ({}));
    if (!reply.ok) return { ok: false, error: `YouTube did not return statistics (HTTP ${reply.status}).` };
    const count = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
    return {
      ok: true,
      read_at: new Date().toISOString(),
      videos: (Array.isArray(data.items) ? data.items : []).map((item) => ({
        id: String(item.id || ''),
        statistics: { views: count(item.statistics?.viewCount), likes: count(item.statistics?.likeCount), comments: count(item.statistics?.commentCount) },
      })),
    };
  } catch {
    return { ok: false, error: 'YouTube did not respond.' };
  }
}
