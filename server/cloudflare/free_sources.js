// Free sources CHE can search and read without a key or an account: Wikipedia, OpenAlex (scholarly papers),
// arXiv (physics, maths, computing papers) and GDELT (news). Each is a search provider for the browsing loop.
// Reading a page checks its robots.txt first, the same way REA reads a site. These are public services with
// polite rate limits: effectively unlimited for one person's use, not infinite. A limit or an outage is reported
// as a failed search, never as an empty answer.
import { robotsAllows } from './rea_targets.js';

const UA = 'CHE-agent/1.0 (personal assistant; contact: owner)';
const TIMEOUT_MS = 8000;

async function getJson(url, fetcher) {
  const response = await fetcher(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
async function getText(url, fetcher) {
  const response = await fetcher(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}
const strip = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** Each provider: search(query, fetcher) -> [{ title, url, snippet }]. */
export const FREE_PROVIDERS = Object.freeze({
  wikipedia: {
    id: 'wikipedia', name: 'Wikipedia',
    async search(query, fetcher = fetch) {
      const data = await getJson(`https://en.wikipedia.org/w/api.php?action=query&list=search&srlimit=5&format=json&srsearch=${encodeURIComponent(query)}`, fetcher);
      return (data?.query?.search || []).map((r) => ({
        title: r.title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(r.title).replace(/ /g, '_'))}`, snippet: strip(r.snippet),
      }));
    },
  },
  openalex: {
    id: 'openalex', name: 'OpenAlex (scholarly papers)',
    async search(query, fetcher = fetch) {
      const data = await getJson(`https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=5`, fetcher);
      return (data?.results || []).map((w) => ({
        title: String(w.display_name || ''), url: String(w.doi || w.id || ''), snippet: `${w.publication_year || ''} ${(w.authorships || []).slice(0, 3).map((a) => a.author?.display_name).filter(Boolean).join(', ')}`.trim(),
      })).filter((r) => r.url);
    },
  },
  arxiv: {
    id: 'arxiv', name: 'arXiv (papers)',
    async search(query, fetcher = fetch) {
      const xml = await getText(`https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=5`, fetcher);
      return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, entry]) => ({
        title: strip(entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]),
        url: strip(entry.match(/<id>([\s\S]*?)<\/id>/)?.[1]),
        snippet: strip(entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]).slice(0, 300),
      })).filter((r) => r.url);
    },
  },
  gdelt: {
    id: 'gdelt', name: 'GDELT (news)',
    async search(query, fetcher = fetch) {
      const data = await getJson(`https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=artlist&format=json&maxrecords=5`, fetcher);
      return (data?.articles || []).map((a) => ({ title: String(a.title || ''), url: String(a.url || ''), snippet: `${a.domain || ''} ${a.seendate || ''}`.trim() })).filter((r) => r.url);
    },
  },
});

/** Adds every free provider to a search registry (see agent_browse_loop.js createSearchRegistry). */
export function registerFreeSources(registry, providers = FREE_PROVIDERS) {
  for (const provider of Object.values(providers)) registry.register(provider);
  return Object.keys(providers);
}

/** Plain text of an HTML page, without scripts or styles. */
export function pageText(html, max = 2000) {
  return String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * The Worker-side executor for the loop's open and read steps: it reads a public page as text, after its
 * robots.txt allows it. Click, type and the other app steps belong to the phone, and say so.
 */
export function serverExecutor({ fetcher = fetch } = {}) {
  return async (action) => {
    if (action.type !== 'open' && action.type !== 'read') {
      return { ok: false, error: `The ${action.type} step needs the iPhone; it cannot run on the server.` };
    }
    const url = String(action.url || '');
    if (!/^https?:\/\//.test(url)) return { ok: false, error: 'That address is not a web page.' };
    const verdict = await robotsAllows(url, fetcher);
    if (!verdict.allowed) return { ok: false, url, error: verdict.reason || 'The site asks automated readers not to read this page.' };
    try {
      const html = await getText(url, fetcher);
      return { ok: true, url, text: pageText(html) };
    } catch (error) {
      return { ok: false, url, error: `The page could not be read: ${error.message}` };
    }
  };
}
