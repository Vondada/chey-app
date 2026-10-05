import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCatalog, chunkBySize, searchCatalog, resourceIntent, speakResults, loadCatalog, _clearCatalogCache } from './resource_catalogs.js';

const PUBLIC_APIS = `# Public APIs
### Weather
| API | Description | Auth | HTTPS |
|---|---|---|---|
| [Open-Meteo](https://open-meteo.com/) | Global weather forecast API for non-commercial use | No | Yes |
| [weatherstack](https://weatherstack.com/) | Real-Time & Historical World Weather Data API | \`apiKey\` | Yes |
### Books
| [Open Library](https://openlibrary.org/developers) | Books, book covers and related data | No | Yes |
- [Back to top](#index)
`;

test('parser reads tables and lists with their section, skipping navigation links', () => {
  const entries = parseCatalog(PUBLIC_APIS);
  assert.deepEqual(entries.map((e) => e.name), ['Open-Meteo', 'weatherstack', 'Open Library']);
  assert.equal(entries[0].category, 'Weather');
  assert.equal(entries[0].url, 'https://open-meteo.com/');
  assert.match(entries[0].description, /Global weather forecast/);
});

test('chunks stay under the Durable Object 128 KiB value limit', () => {
  const big = Array.from({ length: 5000 }, (_, i) => ({ name: `n${i}`, url: `https://x.example/${'p'.repeat(250)}`, description: 'd'.repeat(220), category: 'c'.repeat(80) }));
  const chunks = chunkBySize(big);
  assert.equal(chunks.flat().length, 5000);
  for (const chunk of chunks) assert.ok(new TextEncoder().encode(JSON.stringify(chunk)).length < 128 * 1024);
});

test('search ranks name and category matches and ignores filler words', () => {
  const entries = parseCatalog(PUBLIC_APIS);
  assert.equal(searchCatalog(entries, 'find a free API for weather')[0].category, 'Weather');
  assert.equal(searchCatalog(entries, 'find a free API for')[0], undefined, 'no real search words, no made-up results');
});

test('intents: each list is reachable; problem reports and ordinary chat are not resource searches', () => {
  const cases = {
    'find a free API for weather': 'apis',
    'is there an MCP server for Notion': 'mcp',
    'best Mac app for screen recording': 'mac',
    'free hosting for a static site': 'free',
    'a C++ library for JSON': 'cpp',
    'free book on Rust programming': 'books',
    'security learning resources for web apps': 'security',
  };
  for (const [q, id] of Object.entries(cases)) assert.equal(resourceIntent(q)?.catalog, id, q);
  for (const q of ['the app for my mac crashed', 'how are my trades', 'list my jobs', 'what is the best way to cook rice']) assert.equal(resourceIntent(q), null, q);
});

test('spoken answer is a numbered list naming its source; security answers add the defensive-use note', () => {
  const entries = parseCatalog(PUBLIC_APIS);
  const text = speakResults('apis', 'weather', searchCatalog(entries, 'weather'), { entries, at: Date.now() });
  assert.match(text, /^From public-apis, 2 free public API matches for "weather", sir: 1, /);
  assert.match(text, /Open-Meteo/);
  assert.match(text, / 2, \w/);
  assert.doesNotMatch(text, /tap/i);
  assert.match(speakResults('security', 'web', [{ name: 'OWASP', url: 'https://owasp.org', description: 'guides', category: '' }], { entries: [1], at: 0 }), /authorized testing/);
});

test('catalog cache: fetched once, served from storage, stale copy only when GitHub is down', async () => {
  _clearCatalogCache();
  const m = new Map();
  const storage = { get: async (k) => m.get(k), put: async (k, v) => m.set(k, v) };
  let calls = 0;
  const ok = async () => { calls += 1; return new Response(PUBLIC_APIS, { status: 200 }); };
  const first = await loadCatalog(storage, 'apis', { fetcher: ok, now: 1000 });
  assert.equal(first.entries.length, 3);
  _clearCatalogCache();
  await loadCatalog(storage, 'apis', { fetcher: ok, now: 2000 });
  assert.equal(calls, 1, 'the stored copy is reused');
  _clearCatalogCache();
  const down = async () => new Response('', { status: 503 });
  const stale = await loadCatalog(storage, 'apis', { fetcher: down, now: 1000 + 8 * 86400000 });
  assert.equal(stale.stale, true);
  assert.equal(stale.entries.length, 3);
  _clearCatalogCache();
  assert.ok((await loadCatalog({ get: async () => null }, 'apis', { fetcher: down })).error);
});

test('review fixes: negations and build requests are not lookups', () => {
  for (const q of ['I want to build an MCP server for GitHub', "I don't need an MCP server for GitHub", 'create an api for weather', 'I want to write a book on Rust programming', 'I need help creating an MCP server', 'I want help building an MCP server', 'I need help setting up an API for my app']) assert.equal(resourceIntent(q), null, q);
  assert.equal(resourceIntent('is there an MCP server for GitHub')?.catalog, 'mcp');
});

test('review fixes: downloads are capped and spoken choices map to saved URLs', async () => {
  const { readCapped, resourceChoice, resultLinks } = await import('./resource_catalogs.js');
  const big = new Response('x'.repeat(5000));
  assert.equal((await readCapped(big, 1000)).length, 1000);
  assert.equal(resourceChoice('open number two'), 2);
  assert.equal(resourceChoice('open link 3'), 3);
  assert.equal(resourceChoice('open the app'), null);
  assert.deepEqual(resultLinks([{ name: 'a', url: 'https://a.example' }, { name: 'b', url: 'javascript:alert(1)' }]), [{ n: 1, name: 'a', url: 'https://a.example' }]);
});
