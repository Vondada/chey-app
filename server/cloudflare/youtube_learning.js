// Free YouTube learning helpers.
//
// This intentionally does not use the paid YouTube Data API. It reads caption
// tracks that YouTube's own public player response exposes for a video. The
// fallback client shape follows the public InnerTube technique used by projects
// such as rapha30/yt-youtube-transcript, but this implementation is CHE's own.
// Live Theater captions remain the fallback when YouTube changes player details.

const WATCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18 Mobile/15E148 Safari/604.1',
  'Accept-Language': 'en-US,en;q=0.8',
};

export function youtubeVideoId(input) {
  const raw = String(input || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;
  let url;
  try { url = new URL(raw); } catch (_) { return ''; }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'youtu.be') return /^[A-Za-z0-9_-]{11}$/.test(url.pathname.split('/').filter(Boolean)[0] || '') ? url.pathname.split('/').filter(Boolean)[0] : '';
  if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
    const v = url.searchParams.get('v');
    if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
    const parts = url.pathname.split('/').filter(Boolean);
    const candidate = ['shorts', 'embed', 'live'].includes(parts[0]) ? parts[1] : '';
    return /^[A-Za-z0-9_-]{11}$/.test(candidate || '') ? candidate : '';
  }
  return '';
}

function jsonAfter(text, marker) {
  const at = text.indexOf(marker);
  if (at < 0) return null;
  const start = text.indexOf('{', at + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let string = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (string) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') string = false;
      continue;
    }
    if (ch === '"') { string = true; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch (_) { return null; }
      }
    }
  }
  return null;
}

export function playerResponseFromHtml(html) {
  const text = String(html || '');
  return jsonAfter(text, 'ytInitialPlayerResponse =')
    || jsonAfter(text, '"PLAYER_RESPONSE":')
    || null;
}

function tracks(player) {
  return player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
}

function preferredTrack(list, language = 'en') {
  if (!Array.isArray(list) || !list.length) return null;
  const lang = String(language || 'en').toLowerCase();
  return list.find((t) => String(t.languageCode || '').toLowerCase() === lang && t.kind !== 'asr')
    || list.find((t) => String(t.languageCode || '').toLowerCase().startsWith(lang.split('-')[0]) && t.kind !== 'asr')
    || list.find((t) => t.kind !== 'asr')
    || list[0];
}

export function normalizeCaptionLines(lines) {
  if (!Array.isArray(lines)) return [];
  const out = [];
  for (const line of lines) {
    const text = String(line?.text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000);
    if (!text) continue;
    const t = Math.max(0, Math.round(Number(line?.t ?? line?.start ?? 0) || 0));
    if (out.at(-1)?.text === text && Math.abs(out.at(-1).t - t) < 3) continue;
    out.push({ t, text });
  }
  return out.slice(0, 12000);
}

export function mergeCaptionLines(primary, fallback) {
  const rows = [...normalizeCaptionLines(primary), ...normalizeCaptionLines(fallback)]
    .sort((a, b) => a.t - b.t);
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const key = `${row.t}:${row.text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (out.at(-1)?.text === row.text && Math.abs(out.at(-1).t - row.t) < 3) continue;
    out.push(row);
  }
  return out.slice(0, 12000);
}

export function captionsFromJson3(data) {
  const lines = [];
  for (const event of Array.isArray(data?.events) ? data.events : []) {
    const text = (event?.segs || []).map((seg) => seg?.utf8 || '').join('').replace(/\n/g, ' ').trim();
    if (!text) continue;
    lines.push({ t: Number(event.tStartMs || 0) / 1000, text });
  }
  return normalizeCaptionLines(lines);
}

async function captionTrack(track, fetcher) {
  if (!track?.baseUrl) return [];
  const url = new URL(track.baseUrl);
  url.searchParams.set('fmt', 'json3');
  const response = await fetcher(url.toString(), { headers: WATCH_HEADERS });
  if (!response.ok) return [];
  const json = await response.json().catch(() => null);
  return captionsFromJson3(json);
}

function publicInnerTubeKey(html) {
  return /"INNERTUBE_API_KEY":"([^"]+)"/.exec(String(html || ''))?.[1] || '';
}

async function innerTubePlayer(videoId, html, fetcher) {
  const key = publicInnerTubeKey(html);
  if (!key) return null;
  const clients = [
    { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 35, hl: 'en', gl: 'US' },
    { clientName: 'IOS', clientVersion: '20.10.4', deviceMake: 'Apple', deviceModel: 'iPhone17,2', osName: 'iPhone', osVersion: '18.3', hl: 'en', gl: 'US' },
  ];
  for (const client of clients) {
    try {
      const response = await fetcher(`https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(key)}&prettyPrint=false`, {
        method: 'POST',
        headers: { ...WATCH_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId, context: { client } }),
      });
      if (!response.ok) continue;
      const player = await response.json().catch(() => null);
      if (player?.videoDetails || tracks(player).length) return player;
    } catch (_) {}
  }
  return null;
}

export async function fetchYouTubeKnowledge(input, fetcher = fetch, language = 'en') {
  const id = youtubeVideoId(input);
  if (!id) return { error: 'Not a YouTube video URL.', captions: [], transcript_source: 'unavailable' };
  const url = `https://www.youtube.com/watch?v=${id}&hl=en`;
  const response = await fetcher(url, { headers: WATCH_HEADERS });
  if (!response.ok) return { id, url, error: `YouTube watch page returned ${response.status}.`, captions: [], transcript_source: 'unavailable' };
  const html = await response.text();
  let player = playerResponseFromHtml(html);
  let source = 'watch-player-caption-track';
  if (!tracks(player).length) {
    const inner = await innerTubePlayer(id, html, fetcher);
    if (inner) { player = inner; source = 'public-innertube-caption-track'; }
  }
  const track = preferredTrack(tracks(player), language);
  const captions = track ? await captionTrack(track, fetcher).catch(() => []) : [];
  const details = player?.videoDetails || {};
  return {
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title: String(details.title || '').slice(0, 300),
    author: String(details.author || '').slice(0, 200),
    duration_seconds: Math.max(0, Number(details.lengthSeconds) || 0),
    captions,
    language: track?.languageCode || '',
    auto_generated: track?.kind === 'asr',
    transcript_source: captions.length ? source : 'unavailable',
    error: captions.length ? '' : 'No public caption track was readable; Theater live captions can still be used.',
  };
}
