// Uploads one video file URL to YouTube. Returns the watch link only when
// YouTube returns a video id. No token, no upload, no invented link.

export async function uploadYouTube(env, body = {}, fetcher = fetch) {
  const token = String(env.CHE_YOUTUBE_TOKEN || '').trim();
  const mediaUrl = String(body.media_url || '').trim();
  const title = String(body.title || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!token) return { ok: false, error: 'YouTube is not connected. No video was uploaded.' };
  if (!mediaUrl || !title) return { ok: false, error: 'Upload needs a file URL and a title.' };
  try {
    const response = await fetcher('https://www.googleapis.com/upload/youtube/v3/videos?part=snippet,status', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        snippet: { title, description: String(body.description || title).slice(0, 500) },
        status: { privacyStatus: 'unlisted' },
        source_url: mediaUrl,
      }),
    });
    const data = await response.json().catch(() => ({}));
    const id = String(data.id || '');
    if (!response.ok || !id) return { ok: false, error: 'YouTube did not return a video id.', status: response.status };
    return { ok: true, video_id: id, link: `https://www.youtube.com/watch?v=${id}` };
  } catch (_) {
    return { ok: false, error: 'YouTube did not respond.' };
  }
}
