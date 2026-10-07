// Recent videos page. A row exists only when a render returned a file URL.
// CHE does not create the YouTube channel. The owner does that in the YouTube app.

export const CHANNEL_BRIEF = {
  name: 'CHE Faceless',
  description: 'Short faceless videos on history and how things started. Sources named. No face. No invented facts.',
  handle_note: 'Pick the handle in YouTube. CHE cannot register it.',
};

export function videoPage(items = []) {
  const videos = (Array.isArray(items) ? items : []).filter((item) => item && item.media_url);
  return {
    channel: CHANNEL_BRIEF,
    channel_created: false,
    videos: videos.map((item) => ({
      title: String(item.title || item.topic || 'Untitled').slice(0, 80),
      media_url: String(item.media_url),
      thumbnail_url: item.thumbnail_url ? String(item.thumbnail_url) : '',
      link: item.link ? String(item.link) : '',
    })),
    empty: videos.length ? '' : 'No videos yet. A file URL has not come back.',
  };
}
