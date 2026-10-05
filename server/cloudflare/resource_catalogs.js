// CHE's resource finder: the big curated GitHub lists the owner pointed her
// to (public-apis, free-for-dev, awesome-mcp-servers, awesome-mac,
// awesome-cpp, Awesome-Hacking, free-programming-books), read straight from
// the lists themselves, parsed into entries and searched without AI tokens.
// Every answer names the list it came from; nothing is invented.

export const CATALOGS = {
  apis: { repo: 'public-apis/public-apis', files: ['README.md'], label: 'public-apis', what: 'free public API' },
  free: { repo: 'ripienaar/free-for-dev', files: ['README.md'], label: 'free-for-dev', what: 'free tier for developers' },
  mcp: { repo: 'punkpeye/awesome-mcp-servers', files: ['README.md'], label: 'awesome-mcp-servers', what: 'MCP server' },
  mac: { repo: 'jaywcjlove/awesome-mac', files: ['README.md'], label: 'awesome-mac', what: 'Mac app' },
  cpp: { repo: 'fffaraz/awesome-cpp', files: ['README.md'], label: 'awesome-cpp', what: 'C++ library' },
  security: { repo: 'Hack-with-Github/Awesome-Hacking', files: ['README.md'], label: 'Awesome-Hacking', what: 'security learning resource' },
  books: { repo: 'EbookFoundation/free-programming-books', files: ['books/free-programming-books-subjects.md', 'books/free-programming-books-langs.md'], label: 'free-programming-books', what: 'free programming book' },
};

const TTL_MS = 7 * 86400000;
// Durable Object values are limited to 128 KiB: chunk by serialized size.
const CHUNK_BYTES = 100_000;
const MEMORY = new Map(); // id -> { at, entries } while the Durable Object is warm

const LINK = /\[([^\]]{1,120})\]\((https?:\/\/[^)\s]+)\)/;

function clean(text) {
  return String(text || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images and badges
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, ' ') // linked badges
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links -> their text
    .replace(/\[[^\]]*\]\[[^\]]*\]/g, ' ') // reference-style icons
    .replace(/<[^>]+>/g, ' ')
    .replace(/[`*_]/g, '')
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Markdown list or table -> [{ name, url, description, category }]. */
export function parseCatalog(markdown) {
  const entries = [];
  let category = '';
  for (const raw of String(markdown || '').split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^#{1,4}\s+(.+)$/.exec(line);
    if (heading) { category = clean(heading[1]); continue; }
    if (!/^(?:[*-]\s+|\|\s*|\[)/.test(line)) continue;
    const link = LINK.exec(line);
    if (!link || link.index > 8) continue; // the entry's own link starts the item
    const name = clean(link[1]);
    if (!name || /^(?:back to top|contents|index)$/i.test(name)) continue;
    const rest = line.slice(link.index + link[0].length);
    const description = clean(rest.replace(/^\s*(?:\||-|–|—|:)\s*/, '').split(/\s\|\s/)[0]).slice(0, 220);
    entries.push({ name: name.slice(0, 100), url: link[2].slice(0, 300), description, category: category.slice(0, 80) });
  }
  return entries;
}

export function chunkBySize(entries, maxBytes = CHUNK_BYTES) {
  const chunks = [];
  let current = [];
  let size = 2;
  for (const entry of entries) {
    const bytes = new TextEncoder().encode(JSON.stringify(entry)).length + 1;
    if (current.length && size + bytes > maxBytes) { chunks.push(current); current = []; size = 2; }
    current.push(entry);
    size += bytes;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

// Third-party lists are untrusted: never buffer more than this.
const MAX_BYTES = 2_000_000;
const MAX_ENTRIES = 6000;

export async function readCapped(response, maxBytes = MAX_BYTES) {
  if (!response.body?.getReader) return (await response.text()).slice(0, maxBytes);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = maxBytes - size;
    chunks.push(value.length > room ? value.subarray(0, room) : value);
    size += Math.min(value.length, room);
    if (size >= maxBytes) { await reader.cancel().catch(() => {}); break; }
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.length; }
  return new TextDecoder().decode(all);
}

async function fetchCatalog(id, fetcher) {
  const spec = CATALOGS[id];
  const entries = [];
  for (const file of spec.files) {
    const response = await fetcher(`https://raw.githubusercontent.com/${spec.repo}/HEAD/${file}`, { headers: { 'User-Agent': 'CHE-resource-finder' }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`${spec.label} answered ${response.status}`);
    entries.push(...parseCatalog(await readCapped(response, MAX_BYTES)));
    if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  }
  if (!entries.length) throw new Error(`${spec.label} had no entries I could read`);
  return entries;
}

/** Entries for a list: memory, then storage (7 days), else a fresh read. */
export async function loadCatalog(storage, id, { fetcher = fetch, now = Date.now() } = {}) {
  const hit = MEMORY.get(id);
  if (hit && now - hit.at < TTL_MS) return hit;
  const meta = storage?.get ? await storage.get(`catalog_meta:${id}`) : null;
  if (meta && now - meta.at < TTL_MS && meta.chunks > 0) {
    const parts = [];
    for (let i = 0; i < meta.chunks; i += 1) parts.push(await storage.get(`catalog:${id}:${i}`));
    if (parts.every(Array.isArray)) {
      const loaded = { at: meta.at, entries: parts.flat() };
      MEMORY.set(id, loaded);
      return loaded;
    }
  }
  try {
    const entries = await fetchCatalog(id, fetcher);
    const loaded = { at: now, entries };
    MEMORY.set(id, loaded);
    if (storage?.put) {
      const chunks = chunkBySize(entries);
      for (let i = 0; i < chunks.length; i += 1) await storage.put(`catalog:${id}:${i}`, chunks[i]);
      await storage.put(`catalog_meta:${id}`, { at: now, chunks: chunks.length, count: entries.length });
    }
    return loaded;
  } catch (error) {
    // A stale copy beats nothing when GitHub is unreachable; say how old it is.
    if (meta?.chunks) {
      const parts = [];
      for (let i = 0; i < meta.chunks; i += 1) parts.push(await storage.get(`catalog:${id}:${i}`));
      if (parts.every(Array.isArray)) return { at: meta.at, entries: parts.flat(), stale: true };
    }
    return { error: String(error?.message || error) };
  }
}

const STOP = new Set('a an the for of to and or in on with me my i you your is are any some find look search up show give tell what which whats good best great free public api apis tier tiers hosting service services plan mcp server servers mac macos app apps software tool tools c cpp library libraries book books programming learn learning resource resources security there that can do does please che sir about something like need want list lists one ones'.split(' '));

export function queryTerms(text) {
  return [...new Set(String(text || '').toLowerCase().replace(/c\+\+/g, ' ').split(/[^a-z0-9.#+-]+/).filter((w) => w.length > 1 && !STOP.has(w)))].slice(0, 8);
}

/** Best matches: name hits weigh most, then category, then description. */
export function searchCatalog(entries, query, limit = 5) {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const scored = [];
  for (const entry of entries) {
    // Every spoken option must be openable, so plain-http entries never rank.
    if (!/^https:\/\//.test(entry.url || '')) continue;
    const name = entry.name.toLowerCase();
    const category = entry.category.toLowerCase();
    const description = entry.description.toLowerCase();
    let score = 0;
    let matched = 0;
    for (const term of terms) {
      const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
      const inName = re.test(name);
      const inCategory = re.test(category);
      const inDescription = re.test(description);
      if (inName || inCategory || inDescription) matched += 1;
      score += (inName ? 3 : 0) + (inCategory ? 2 : 0) + (inDescription ? 1 : 0);
    }
    if (matched) scored.push({ entry, score: score + matched * 4, matched });
  }
  const need = Math.min(terms.length, 2);
  const strong = scored.filter((s) => s.matched >= need);
  return (strong.length ? strong : scored)
    .sort((a, b) => b.score - a.score || a.entry.name.length - b.entry.name.length)
    .slice(0, limit)
    .map((s) => s.entry);
}

// "find a free API for weather", "is there an MCP server for Notion",
// "best Mac app for screen recording", "free hosting for a static site",
// "a C++ library for JSON", "free book on Rust", "security learning resources".
export function resourceIntent(message) {
  const text = String(message || '').toLowerCase();
  const asks = /\b(?:find|look\s*up|search|is there|are there|recommend|suggest|any|what(?:'s| is| are)?\s+(?:a |the )?(?:good|best)|give me|show me|list|need|want)\b/.test(text)
    // A bare request such as "security learning resources for web apps".
    || /\b(?:best|top)\b/.test(text) || /\b(?:resources?|librar(?:y|ies)|apis?|books?|apps?|servers?)\s+(?:for|on|about)\b/.test(text) || /^(?:free|public)\s/.test(text.trim());
  if (!asks) return null;
  // Negations and build/create requests are not lookups ("I don't need an MCP
  // server", "I want to build an MCP server for GitHub").
  if (/\b(?:don'?t|do\s+not|doesn'?t|never|no\s+longer)\s+(?:need|want|use|like)\b/.test(text)) return null;
  if (/\b(?:build(?:ing)?|creat(?:e|ing)|mak(?:e|ing)|writ(?:e|ing)|develop(?:ing)?|cod(?:e|ing)|set(?:ting)?\s+up|deploy(?:ing)?|install(?:ing)?|configur(?:e|ing)|implement(?:ing)?)\s+(?:me\s+)?(?:an?|the|my|our)?\s*(?:own\s+|new\s+|custom\s+)?(?:mcp|api|app|server|library|tool|book|site|website)\b/.test(text)) return null;
  // A problem report ("the app for my Mac crashed") is not a shopping request.
  if (/\b(?:crash(?:ed|es|ing)?|broke(?:n)?|not working|doesn'?t work|won'?t|error|bug|fix|stuck|frozen)\b/.test(text)) return null;
  const pick = (id) => ({ catalog: id, query: text });
  if (/\bmcp\b/.test(text)) return pick('mcp');
  if (/\b(?:mac|macos|osx)\s+(?:apps?|software|tools?|utilit(?:y|ies))\b|\bapps?\s+for\s+(?:my\s+)?mac\b/.test(text)) return pick('mac');
  if (/c\+\+|\bcpp\b/.test(text) && /\b(?:librar(?:y|ies)|framework|tool)/.test(text)) return pick('cpp');
  if (/\bfree\b[\s\S]{0,25}\bbooks?\b|\bbooks?\s+(?:on|about|to learn)\b/.test(text) && /\b(?:programming|code|coding|python|javascript|rust|swift|dart|java|go|c\b|sql|algorithm|machine learning|data|web)/.test(text)) return pick('books');
  if (/\b(?:security|cyber\s?security|pentest(?:ing)?|hacking|ctf)\b[\s\S]{0,30}\b(?:resources?|learn(?:ing)?|courses?|training|lists?)\b/.test(text)) return pick('security');
  if (/\b(?:free|public)\s+apis?\b|\bapis?\s+for\b/.test(text)) return pick('apis');
  if (/\bfree\s+(?:tier|plan|hosting|service|database|tool|alternative|cloud|domain|email|storage)s?\b/.test(text)) return pick('free');
  return null;
}

function host(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
}

export function speakResults(id, query, results, loaded) {
  const spec = CATALOGS[id];
  const terms = queryTerms(query).join(' ');
  if (loaded?.error) return `I could not read the ${spec.label} list right now, sir (${loaded.error}). Nothing was made up.`;
  if (!results.length) return `I searched ${loaded.entries.length} entries in ${spec.label} and found no ${spec.what} for "${terms}", sir. Try other words.`;
  const lines = results.map((r, i) => `${i + 1}, ${r.name}: ${r.description || r.category}${host(r.url) ? ` (${host(r.url)})` : ''}.`);
  const age = loaded.stale ? ` This copy of the list is from ${new Date(loaded.at).toISOString().slice(0, 10)}, because GitHub did not answer.` : '';
  const careful = id === 'security' ? ' These are for learning to defend your own systems; I only help with legal, authorized testing.' : '';
  return `From ${spec.label}, ${results.length} ${spec.what} match${results.length === 1 ? '' : 'es'} for "${terms}", sir: ${lines.join(' ')}${careful}${age}`;
}

// "open number two", "open link 2", "open result three": the numbered list
// CHE just spoke is saved, so a spoken choice maps to the real URL.
export const LAST_RESULTS_KEY = 'che_last_resource_results';
const ORDINAL = { one: 1, first: 1, two: 2, second: 2, three: 3, third: 3, four: 4, fourth: 4, five: 5, fifth: 5 };
export function resourceChoice(message) {
  const m = /\b(?:open|show|go\s+to|pick|choose|select)\s+(?:the\s+)?(?:number|link|result|option|item)?\s*(\d|one|two|three|four|five|first|second|third|fourth|fifth)\b/i.exec(String(message || ''));
  if (!m) return null;
  const n = ORDINAL[m[1].toLowerCase()] || Number(m[1]);
  return n >= 1 && n <= 5 ? n : null;
}
export function resultLinks(results) {
  return results.map((r, i) => ({ n: i + 1, name: r.name, url: /^https:\/\//.test(r.url) ? r.url : '' })).filter((r) => r.url);
}

export function _clearCatalogCache() { MEMORY.clear(); }
