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

export async function uploadYouTube(env, body = {}, fetcher = fetch) {
  const token = String(env.CHE_YOUTUBE_TOKEN || '').trim();
  const mediaUrl = safeHttpUrl(body.media_url);
  const title = String(body.title || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!token) return { ok: false, error: 'YouTube is not connected. No video was uploaded.' };
  if (!mediaUrl || !title) return { ok: false, error: 'Upload needs a valid file URL and a title.' };

  try {
    const media = await fetcher(mediaUrl.toString(), {
      method: 'GET',
      signal: AbortSignal.timeout(30000),
    });
    if (!media.ok || !media.body) {
      return { ok: false, error: 'The rendered video file could not be downloaded.', status: media.status };
    }

    const contentType = media.headers?.get?.('content-type') || 'video/mp4';
    const contentLength = media.headers?.get?.('content-length') || '';
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
      body: media.body,
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
