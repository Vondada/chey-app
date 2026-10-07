// Office scout. Finds topic titles from a real feed. Never invents demand.
// CHE_TREND_URLS is a comma-separated list of HTTPS feeds. With no URL, the
// scout says it has no source instead of making topics up.

const clip = (text, max) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);

function titlesFromFeed(xml) {
  const out = [];
  const re = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/gi;
  let match;
  while ((match = re.exec(String(xml || '')))) {
    const title = clip(match[1].replace(/<[^>]+>/g, ''), 140);
    if (!title || /^(rss|feed|atom)$/i.test(title)) continue;
    out.push(title);
  }
  return out;
}

export function rankTopics(items, limit = 12) {
  const seen = new Set();
  const topics = [];
  for (const item of items) {
    const title = clip(item.title, 140);
    const key = title.toLowerCase();
    if (!title || seen.has(key)) continue;
    seen.add(key);
    topics.push({
      title,
      source: String(item.source || ''),
      why: item.why ? clip(item.why, 180) : 'Listed by the source feed.',
    });
    if (topics.length >= limit) break;
  }
  return topics;
}

export async function scoutTopics(env = {}, fetcher = fetch) {
  const urls = String(env.CHE_TREND_URLS || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!urls.length) {
    return { ok: false, error: 'No trend source is connected. Set CHE_TREND_URLS. No topics were invented.', topics: [] };
  }
  const found = [];
  const errors = [];
  for (const url of urls.slice(0, 5)) {
    try {
      const response = await fetcher(url, { headers: { Accept: 'application/rss+xml, application/xml, text/xml' } });
      if (!response.ok) {
        errors.push(`${url} returned ${response.status}`);
        continue;
      }
      const xml = await response.text();
      for (const title of titlesFromFeed(xml).slice(0, 20)) {
        found.push({ title, source: url, why: 'Title from the connected feed.' });
      }
    } catch (_) {
      errors.push(`${url} did not respond`);
    }
  }
  const topics = rankTopics(found);
  if (!topics.length) {
    return { ok: false, error: errors[0] || 'The feed had no titles.', topics: [] };
  }
  return { ok: true, topics, errors };
}
